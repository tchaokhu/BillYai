/**
 * repository ของ `expense_draft` — สถานะระหว่างการ์ดกับปุ่มยืนยัน (ADR 0001)
 *
 * ตารางนี้เก็บ**ตัวตนฝั่ง LINE อย่างเดียว** ไม่มี `group_id` และไม่มี FK ไปวง
 * เพราะวงเกิดตอนกดยืนยันเสมอ ทั้งวงกลุ่มและวงส่วนตัว (D30) · ผลคือโมดูลนี้ไม่ต้อง
 * รู้จัก `ledger_group` เลย
 *
 * **draft คือขยะที่ลบทิ้งได้เสมอ** ไม่มีใครอ้างถึง — ทั้ง `delete` ธรรมดาและการ
 * กวาดของหมดอายุจึงไม่ต้องกลัวไปโดนของจริง
 */

import { getPool, type Queryable } from '@/lib/db/client'
import { parseDraftPayload } from '@/lib/db/draft-payload'
import type { ExpenseDraft } from '@/lib/types'

/**
 * อายุของ draft — 24 ชั่วโมงนับจากตอนสร้าง
 *
 * สั้นกว่านี้ไม่พอกับสถานการณ์จริง (จ่ายเงิน เดินออกจากร้าน พิมพ์บิล มีคนเรียกไป
 * ทำอย่างอื่น กลับมากดตอนถึงบ้าน) และยาวกว่านี้ไม่มีประโยชน์
 *
 * **นับจากเวลาสร้าง ไม่ผูกกับขอบวัน `Asia/Bangkok`** ที่ใช้ในที่อื่นของระบบ ไม่งั้น
 * บิลมื้อดึกจะเหลืออายุ 40 นาทีโดยไม่มีเหตุผล
 */
const TTL = "interval '24 hours'"

const SPENT_AT_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export interface CreateDraftInput {
  /** `null` = มาจากแชท 1:1 */
  lineGroupId: string | null
  /** คนพิมพ์ — D26 ให้เฉพาะคนนี้กดยืนยันได้ */
  lineUserId: string
  draft: ExpenseDraft
  /** `'YYYY-MM-DD'` แช่ไว้ตั้งแต่ตอนสร้าง (D35) */
  spentAt: string
}

export interface DraftRecord {
  id: string
  lineGroupId: string | null
  lineUserId: string
  draft: ExpenseDraft
  spentAt: string
  createdAt: Date
}

type DraftRow = {
  id: string
  line_group_id: string | null
  line_user_id: string
  payload: unknown
  spent_at: string
  created_at: Date
}

function db(dbOrTx?: Queryable): Queryable {
  return dbOrTx ?? getPool()
}

/**
 * วันที่ต้องตรงรูปแบบ **และมีอยู่จริงในปฏิทิน** — เกณฑ์เดียวกับ `commitExpense`
 *
 * `2026-02-30` ผ่าน regex สบายๆ แล้วไปตายที่ Postgres หลัง statement เริ่มไปแล้ว
 */
function assertSpentAt(spentAt: string): void {
  if (!SPENT_AT_PATTERN.test(spentAt)) {
    throw new Error(`spentAt ต้องเป็น 'YYYY-MM-DD' — ได้ ${JSON.stringify(spentAt)}`)
  }
  const [year = 0, month = 0, day = 0] = spentAt.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`spentAt ไม่มีอยู่จริงในปฏิทิน: ${spentAt}`)
  }
}

function toDraftRecord(row: DraftRow): DraftRecord | null {
  const draft = parseDraftPayload(row.payload)
  // payload ที่อ่านไม่ออก = ปฏิบัติเหมือนการ์ดหมดอายุ ไม่ใช่ throw ขึ้นไปถึง webhook
  if (draft === null) return null
  return {
    id: row.id,
    lineGroupId: row.line_group_id,
    lineUserId: row.line_user_id,
    draft,
    spentAt: row.spent_at,
    createdAt: row.created_at,
  }
}

/**
 * เขียน draft ใหม่ **พร้อมกวาดของหมดอายุใน statement เดียวกัน**
 *
 * เก็บกวาดตอนเขียน ไม่ใช่ด้วย cron — D7 ตั้งใจไว้ว่า v1 ไม่มี cron เลย และขยะ
 * ไม่กี่แถวในวงที่เลิกใช้ไม่คุ้มกับการผิดคำนั้น
 *
 * กวาด**ทุกแถวที่หมดอายุ ไม่เฉพาะของวงตัวเอง** (ADR 0001 เขียนไว้ว่าเฉพาะวงนั้น)
 * เพราะแถวที่หมดอายุแล้วเป็นขยะไม่ว่าจะของใคร การจำกัดขอบเขตจึงได้แค่ทิ้งงานไว้ให้
 * วงอื่นทำ · และขอบเขต "วงเดียวกัน" ของแชท 1:1 ต้องเขียนเป็นเงื่อนไขบน
 * `line_user_id` แทน ซึ่งทำให้ predicate มีสองรูปแบบโดยไม่ได้อะไรกลับมา
 */
export async function createDraft(
  input: CreateDraftInput,
  dbOrTx?: Queryable,
): Promise<DraftRecord> {
  assertSpentAt(input.spentAt)
  if (input.lineUserId.trim() === '') {
    throw new Error('lineUserId ว่างไม่ได้ — D26 ต้องรู้ว่าใครพิมพ์')
  }
  if (parseDraftPayload(input.draft) === null) {
    // ตรวจก่อนเขียน ไม่ใช่ตอนอ่าน — payload ที่ผิดสัญญาไม่ควรมีทางลงตารางได้เลย
    throw new Error('draft ไม่ผ่านสัญญาของ ExpenseDraft')
  }

  const result = await db(dbOrTx).query<DraftRow>(
    `with swept as (
       delete from expense_draft where created_at <= now() - ${TTL}
     )
     insert into expense_draft (line_group_id, line_user_id, payload, spent_at)
     values ($1, $2, $3::jsonb, $4)
     returning *`,
    [input.lineGroupId, input.lineUserId, JSON.stringify(input.draft), input.spentAt],
  )

  const row = result.rows[0]
  if (row === undefined) throw new Error('createDraft: insert ไม่คืนแถว')
  const record = toDraftRecord(row)
  if (record === null) throw new Error('createDraft: payload ที่เพิ่งเขียนอ่านกลับไม่ได้')
  return record
}

/**
 * อ่าน draft ที่ยังไม่หมดอายุ — คืน `null` ทั้งกรณีไม่เจอ หมดอายุ และอ่าน payload
 * ไม่ออก เพราะทั้งสามกรณีจบเหมือนกันคือ "การ์ดใบนี้ใช้ไม่ได้แล้ว ให้พิมพ์ใหม่"
 */
export async function findDraft(id: string, dbOrTx?: Queryable): Promise<DraftRecord | null> {
  const result = await db(dbOrTx).query<DraftRow>(
    `select * from expense_draft
     where id = $1 and created_at > now() - ${TTL}`,
    [id],
  )
  const row = result.rows[0]
  return row === undefined ? null : toDraftRecord(row)
}

/**
 * ลบ draft — คืน `true` เมื่อลบไปจริงหนึ่งแถว
 *
 * **นี่คือกลไกกันบิลลงซ้ำ** commit คือ `deleteDraft` + `insert expense` ใน
 * transaction เดียว กดยืนยันซ้ำจึงลบไม่โดนแล้วไม่ทำอะไรต่อ ทั้งกรณี LINE ยิง
 * postback ซ้ำและกรณีคนกดปุ่มรัวเพราะเน็ตช้า
 *
 * ลบของหมดอายุได้ด้วยโดยตั้งใจ — คนที่กดการ์ดเก่าต้องไม่ทิ้งแถวค้างไว้
 */
export async function deleteDraft(id: string, dbOrTx?: Queryable): Promise<boolean> {
  const result = await db(dbOrTx).query(`delete from expense_draft where id = $1`, [id])
  return (result.rowCount ?? 0) > 0
}

/** กวาดของหมดอายุตรงๆ — มีไว้ให้เทสต์และงานซ่อมบำรุงเรียก ไม่ใช่เส้นทางปกติ */
export async function sweepExpiredDrafts(dbOrTx?: Queryable): Promise<number> {
  const result = await db(dbOrTx).query(
    `delete from expense_draft where created_at <= now() - ${TTL}`,
  )
  return result.rowCount ?? 0
}
