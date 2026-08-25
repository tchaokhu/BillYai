/**
 * repository ของ `audit_log` — ร่องรอยว่าใครทำอะไรกับอะไร
 *
 * D11 ตัดสินใจไม่มีระบบ permission ว่าใครแก้บิลได้บ้าง แต่ให้ทุกการกระทำ
 * **ตามรอยได้และประกาศกลับเข้ากลุ่ม** — สังคมในวงคุมกันเองแทน. ตารางนี้คือครึ่ง
 * "ตามรอยได้" ของข้อนั้น ซึ่งแปลว่า audit ที่ชี้ผิดคนแย่กว่าไม่มี audit เลย
 * เพราะมันให้ความมั่นใจผิดๆ กับคนที่เปิดดู
 *
 * ไม่มีการคิดเลขเงินที่นี่ — `before`/`after` เป็นก้อน jsonb ที่ผู้เรียกประกอบมา
 */

import { getPool, type Queryable } from '@/lib/db/client'
import { toAuditLog, type ActorVia, type AuditLog, type AuditLogRow } from '@/lib/db/rows'
import type { MemberId } from '@/lib/types'

export interface WriteAuditInput {
  /** `null` = เหตุการณ์ระดับระบบที่ไม่ผูกกับวงไหน (เช่น ชน Ceiling) */
  groupId?: string | null
  /** `null` = ระบบทำเอง หรือคนที่ยังไม่มี member ในวง */
  actor?: MemberId | null
  actorVia: ActorVia
  /** ชื่อเหตุการณ์แบบ `<โดเมน>.<กริยา>` เช่น `expense.void` */
  action: string
  targetType: string
  targetId?: string | null
  before?: unknown
  after?: unknown
}

export interface ListAuditOptions {
  limit?: number
}

/**
 * DB มี check constraint คุมอยู่แล้ว แต่ error ของ Postgres อ่านไม่รู้เรื่อง —
 * กันที่นี่อีกชั้นเพื่อให้ได้ข้อความที่บอกได้ว่าผิดตรงไหน (แบบเดียวกับ
 * `assertVia` ใน `lib/repo/settlements.ts`)
 */
const ALLOWED_VIA: readonly ActorVia[] = ['line', 'liff', 'link', 'web']

const COLUMNS = `id, group_id, actor, actor_via, action, target_type, target_id,
                 before, after, created_at`

export async function writeAudit(
  input: WriteAuditInput,
  db: Queryable = getPool(),
): Promise<AuditLog> {
  if (!ALLOWED_VIA.includes(input.actorVia)) {
    throw new Error(
      `actorVia ต้องเป็นหนึ่งใน ${ALLOWED_VIA.join('|')} — ได้ ${JSON.stringify(input.actorVia)}`,
    )
  }
  if (input.action.trim() === '') throw new Error('action ว่างไม่ได้')
  if (input.targetType.trim() === '') throw new Error('targetType ว่างไม่ได้')

  const groupId = input.groupId ?? null
  const actor = input.actor ?? null
  if (groupId !== null && actor !== null) {
    await assertActorInGroup(db, groupId, actor)
  }

  const { rows } = await db.query<AuditLogRow>(
    `insert into audit_log (
       group_id, actor, actor_via, action, target_type, target_id, before, after
     ) values ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::jsonb, $8::jsonb)
     returning ${COLUMNS}`,
    [
      groupId,
      actor,
      input.actorVia,
      input.action,
      input.targetType,
      input.targetId ?? null,
      toJsonb(input.before),
      toJsonb(input.after),
    ],
  )
  const row = rows[0]
  if (!row) throw new Error('writeAudit: insert ไม่คืนแถว')
  return toAuditLog(row)
}

/**
 * เหตุการณ์ของวงหนึ่ง เรียงใหม่สุดก่อน
 *
 * tie-break ด้วย `id desc` เพราะแถวที่เขียนใน transaction เดียวกันได้ `now()`
 * ค่าเดียวกันเป๊ะ — ไม่มี tie-break แล้ว Postgres คืนลำดับตามใจ หน้าจอประวัติ
 * จะสลับที่เองระหว่าง refresh ทั้งที่ไม่มีอะไรเปลี่ยน
 */
export async function listAudit(
  groupId: string,
  options: ListAuditOptions = {},
  db: Queryable = getPool(),
): Promise<AuditLog[]> {
  const values: unknown[] = [groupId]
  let sql = `select ${COLUMNS} from audit_log
              where group_id = $1
              order by created_at desc, id desc`

  if (options.limit !== undefined) {
    if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
      throw new Error(`limit ต้องเป็น integer ที่มากกว่า 0 — ได้ ${options.limit}`)
    }
    values.push(options.limit)
    sql += ` limit $${values.length}`
  }

  const { rows } = await db.query<AuditLogRow>(sql, values)
  return rows.map(toAuditLog)
}

// ─── ภายใน ────────────────────────────────────────────────────────────

/**
 * `undefined` กับ `null` ลงเป็น SQL null เหมือนกัน ส่วนค่าอื่นส่งเป็นสตริง JSON
 *
 * ปล่อยให้ `pg` แปลง object เองได้ แต่มันแปลง `null` เป็นสตริง `"null"` ซึ่ง
 * เป็น jsonb null (คนละอย่างกับ SQL null) แล้ว `before is null` จะเป็นเท็จ
 * ทั้งที่ไม่มีข้อมูลก่อนหน้าจริงๆ
 */
function toJsonb(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return JSON.stringify(value)
}

/**
 * actor ต้องอยู่ในวงเดียวกับเหตุการณ์
 *
 * FK ของ `audit_log.actor` ชี้ `member(id)` ซึ่งการันตีแค่ว่ามีตัวตน ไม่ได้
 * การันตีว่าอยู่วงนี้ — เหตุผลเดียวกับที่ `expense.voided_by` ถูกตัดทิ้งและที่
 * `claimedBy`/`confirmedBy` ของ settlement ต้องผ่านด่านนี้
 */
async function assertActorInGroup(
  db: Queryable,
  groupId: string,
  actor: MemberId,
): Promise<void> {
  const { rows } = await db.query<{ group_id: string }>(
    `select group_id from member where id = $1`,
    [actor],
  )
  const found = rows[0]
  if (!found) throw new Error(`writeAudit: ไม่พบสมาชิก ${actor}`)
  if (found.group_id !== groupId) {
    throw new Error(`writeAudit: สมาชิก ${actor} อยู่คนละวงกับเหตุการณ์ที่กำลังบันทึก`)
  }
}
