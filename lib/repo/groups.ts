/**
 * Repository ของวง (Group) — วงกลุ่ม `line_group` และวงส่วนตัว `personal`
 *
 * ที่นี่ไม่คิดเลขเงินเลย มีแต่การมีอยู่ของวงกับสถานะของมัน
 *
 * ทุกฟังก์ชันรับ `db` เป็นพารามิเตอร์ตัวสุดท้าย เพื่อให้ผู้เรียกที่เปิด
 * transaction ไว้แล้วส่ง client ตัวเดียวกันเข้ามาได้ (ดู `withTransaction`)
 * ถ้าไปหยิบจาก pool เองจะกลายเป็นคนละ transaction กับที่ผู้เรียกเปิดไว้
 */

import type { PoolClient } from 'pg'
import { getPool, withTransaction, type Queryable } from '@/lib/db/client'
import { toLedgerGroup, type LedgerGroup, type LedgerGroupRow } from '@/lib/db/rows'

function db(explicit?: Queryable): Queryable {
  return explicit ?? getPool()
}

async function queryGroup(
  q: Queryable,
  sql: string,
  values: readonly unknown[],
): Promise<LedgerGroup | null> {
  const { rows } = await q.query<LedgerGroupRow>(sql, values)
  const row = rows[0]
  return row ? toLedgerGroup(row) : null
}

/**
 * ฟังก์ชันที่แก้ข้อมูลแล้วไม่โดนแถวไหน = ผู้เรียกกำลังทำงานกับวงที่ไม่มีอยู่
 * ซึ่งเป็นบั๊กของผู้เรียก ไม่ใช่ผลลัพธ์ที่ถูกต้อง — ต้องดังตรงนี้ ไม่ใช่คืน null
 * ให้ไปพังลึกกว่านี้อีกสามชั้น
 */
function requireGroup(group: LedgerGroup | null, groupId: string): LedgerGroup {
  if (!group) throw new Error(`ไม่พบวง ${groupId}`)
  return group
}

/** ชน unique ของ `line_group_id` — คือกรณีที่มีวงอื่นถือกลุ่มนั้นอยู่แล้ว */
function isLineGroupIdConflict(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'constraint' in err &&
    err.constraint === 'ledger_group_line_group_id_key'
  )
}

// ─── หาวง ─────────────────────────────────────────────────────────────

/**
 * **ตัวหาวงทุกตัวในไฟล์นี้คืนวงที่ถูก soft-delete ด้วย** ยกเว้นตัวที่ขึ้นต้น
 * ด้วย `findActive`
 *
 * เหตุผล: soft-delete คือ *สถานะ* ของวงเดิม ไม่ใช่การไม่มีอยู่ (D18) — ถ้า
 * ตัวหาซ่อนมันไว้ ทางกู้คืนจะหาวงเดิมไม่เจอแล้วสร้างวงใหม่ทับ ซึ่งเท่ากับ
 * ลูกหนี้เตะ bot ทิ้งแล้วหนี้หายจริง. record ที่คืนมามี `status`/`deletedAt`
 * ครบ จึงไม่มีอะไรถูกปิดบังจากผู้เรียก
 *
 * ทางแยกสำหรับผู้เรียกที่ต้องการเฉพาะวงที่ยังใช้งานอยู่ คือ**ฟังก์ชันคนละชื่อ**
 * ไม่ใช่ flag (`{ includeDeleted: true }`) เพราะที่จุดเรียก flag อ่านไม่ออกว่า
 * ค่า default คืออะไร ส่วนชื่อฟังก์ชันอ่านผิดไม่ได้
 */
export async function findGroupById(
  id: string,
  dbOrTx?: Queryable,
): Promise<LedgerGroup | null> {
  return queryGroup(db(dbOrTx), `select * from ledger_group where id = $1`, [id])
}

export async function findGroupByLineGroupId(
  lineGroupId: string,
  dbOrTx?: Queryable,
): Promise<LedgerGroup | null> {
  return queryGroup(db(dbOrTx), `select * from ledger_group where line_group_id = $1`, [
    lineGroupId,
  ])
}

/** เส้นทางปกติของ webhook/หน้าจอ — วงที่ถูกลบต้องไม่โผล่ */
export async function findActiveGroupByLineGroupId(
  lineGroupId: string,
  dbOrTx?: Queryable,
): Promise<LedgerGroup | null> {
  return queryGroup(
    db(dbOrTx),
    `select * from ledger_group where line_group_id = $1 and status = 'active'`,
    [lineGroupId],
  )
}

/**
 * หาวงจาก Owner Link token (D22) — รับ **sha256 hash** ไม่ใช่ token ตัวจริง
 * ผู้เรียกเป็นคนแฮชก่อนส่งเข้ามา token ตัวจริงจึงไม่เคยเข้าใกล้ DB เลย
 */
export async function findGroupByOwnerTokenHash(
  hash: Buffer,
  dbOrTx?: Queryable,
): Promise<LedgerGroup | null> {
  return queryGroup(db(dbOrTx), `select * from ledger_group where owner_token_hash = $1`, [
    hash,
  ])
}

// ─── วงกลุ่ม ──────────────────────────────────────────────────────────

/**
 * หาวงของกลุ่ม LINE นี้ ไม่มีก็สร้างให้ — ทางเข้าเดียวของ webhook
 *
 * เขียนเป็น statement เดียวด้วย `on conflict` แทนการอ่านก่อนเขียน เพราะ
 * webhook ของ LINE ยิงซ้ำและยิงพร้อมกันได้ ถ้าอ่านก่อนเขียนจะมีช่องให้สอง
 * request เห็น "ยังไม่มีวง" พร้อมกันแล้วแย่งกัน insert
 *
 * **วงที่ถูก soft-delete จะถูก restore ไม่ใช่สร้างใหม่** — `line_group_id`
 * คงที่ตลอดอายุกลุ่ม LINE เชิญ bot กลับกลุ่มเดิมจึงต้องได้ ledger เดิมคืนครบ
 * (D18). นี่คือกลไกที่กันลูกหนี้เตะ bot ทิ้งเพื่อล้างหนี้ตัวเอง: การเตะทำได้
 * แค่ซ่อนยอด ไม่ได้ลบ และใครก็ตามที่เชิญกลับก็เห็นยอดเดิมทันที
 */
export async function ensureLineGroup(
  lineGroupId: string,
  dbOrTx?: Queryable,
): Promise<LedgerGroup> {
  const group = await queryGroup(
    db(dbOrTx),
    `insert into ledger_group (kind, line_group_id)
     values ('line_group', $1)
     on conflict (line_group_id) do update
       set status = 'active', deleted_at = null
     returning *`,
    [lineGroupId],
  )
  if (!group) throw new Error(`ensureLineGroup: insert ไม่คืนแถวสำหรับ ${lineGroupId}`)
  return group
}

// ─── วงส่วนตัว ────────────────────────────────────────────────────────

/**
 * วงส่วนตัวของเจ้าของคนนี้ — `null` เมื่อยังไม่มี
 *
 * มีอยู่เพื่อให้แชท 1:1 หนึ่งคนแมปกับวงเดียวตลอด ไม่ใช่วงใหม่ทุกบิล · วงส่วนตัว
 * เกิดตอนกดยืนยันบิลใบแรก (D30) ใบต่อๆ ไปจึงต้องหาของเดิมให้เจอ
 *
 * `line_group_id is null` อยู่ในเงื่อนไขด้วยเพราะวงส่วนตัวผูกเข้ากลุ่ม LINE ทีหลังได้
 * (ทางเดียว) — พอผูกแล้วมันไม่ใช่ปลายทางของแชท 1:1 อีกต่อไป
 */
export async function findPersonalGroupByOwner(
  ownerId: string,
  dbOrTx?: Queryable,
): Promise<LedgerGroup | null> {
  return queryGroup(
    db(dbOrTx),
    `select * from ledger_group
      where owner_id = $1 and kind = 'personal' and line_group_id is null
        and status = 'active'
      order by created_at
      limit 1`,
    [ownerId],
  )
}

/**
 * สร้างวงส่วนตัว (D21) — วงที่ไม่มีกลุ่ม LINE รองรับ
 *
 * ต้องมีทางเข้าถึงอย่างน้อยหนึ่งทาง: `ownerId` (เจ้าของที่มี App User แล้ว)
 * หรือ `ownerTokenHash` (Owner Link ล้วนๆ ตาม D22 สำหรับคนที่ยังไม่มีตัวตน)
 * ไม่งั้นวงจะกลายเป็นวงที่ไม่มีใครเข้าถึงได้อีกเลยตั้งแต่วินาทีที่สร้าง
 */
export async function createPersonalGroup(
  input: { ownerId?: string; ownerTokenHash?: Buffer },
  dbOrTx?: Queryable,
): Promise<LedgerGroup> {
  const ownerId = input.ownerId ?? null
  const ownerTokenHash = input.ownerTokenHash ?? null
  if (ownerId === null && ownerTokenHash === null) {
    throw new Error(
      'วงส่วนตัวต้องมี ownerId หรือ ownerTokenHash อย่างน้อยหนึ่งอย่าง ไม่งั้นจะไม่มีใครเข้าถึงวงได้',
    )
  }

  const group = await queryGroup(
    db(dbOrTx),
    `insert into ledger_group (kind, owner_id, owner_token_hash, owner_token_at)
     values ('personal', $1::uuid, $2::bytea,
             case when $2::bytea is null then null else now() end)
     returning *`,
    [ownerId, ownerTokenHash],
  )
  if (!group) throw new Error('createPersonalGroup: insert ไม่คืนแถว')
  return group
}

/**
 * ออก Owner Link token ใหม่ให้วง — การเพิกถอนคือการหมุน ไม่มีตาราง blacklist
 * แยก (D20/D22) ดังนั้นทันทีที่ hash ใหม่ทับลงไป ลิงก์เก่าก็หาวงไม่เจออีกเลย
 */
export async function rotateOwnerToken(
  groupId: string,
  newHash: Buffer,
  dbOrTx?: Queryable,
): Promise<LedgerGroup> {
  const group = await queryGroup(
    db(dbOrTx),
    `update ledger_group
       set owner_token_hash = $2, owner_token_at = now()
     where id = $1
     returning *`,
    [groupId, newHash],
  )
  return requireGroup(group, groupId)
}

// ─── ลบ / กู้คืน ──────────────────────────────────────────────────────

/**
 * มาร์กว่าลบ ไม่ลบแถว (D18) — เก็บไว้ 30 วันก่อนลบจริง
 *
 * `deleted_at` ใช้ `coalesce` เพื่อ**ไม่รีเซ็ตนาฬิกา 30 วัน**เมื่อโดนเรียกซ้ำ
 * (เตะ bot → เชิญกลับ → เตะอีก) ไม่งั้นวงที่ถูกเตะเป็นระยะจะไม่ถึงกำหนดลบสักที
 */
export async function softDeleteGroup(
  groupId: string,
  dbOrTx?: Queryable,
): Promise<LedgerGroup> {
  const group = await queryGroup(
    db(dbOrTx),
    `update ledger_group
       set status = 'soft_deleted', deleted_at = coalesce(deleted_at, now())
     where id = $1
     returning *`,
    [groupId],
  )
  return requireGroup(group, groupId)
}

/**
 * ลบวงถาวรพร้อมทุกอย่างที่ห้อยอยู่ — ปลายทางของกำหนด 30 วันใน D18
 *
 * ทำไมไม่ `delete from ledger_group` เฉยๆ ทั้งที่มี `on delete cascade`:
 * cascade ของ `ledger_group` ไปถึง `member` และ `expense` ก็จริง แต่
 * `expense_share.member_id`, `expense_item_share.member_id`,
 * `settlement.from_member_id/to_member_id` และ `audit_log.actor` ชี้ `member(id)`
 * **โดยไม่มี on-delete action** ซึ่งตั้งใจให้เป็นแบบนั้น: คนที่ยังมีบิลค้างต้อง
 * ลบทิ้งเฉยๆ ไม่ได้ (D18 มาร์ก ไม่ลบ). ผลคือคำสั่ง delete เดียวจะชน FK ทันที
 * ที่วงมีบิล — การลบทั้งวงจึงต้องไล่จากใบไปหาราก
 *
 * ทั้งหมดอยู่ใน transaction เดียว: วงที่ลบไปครึ่งทางคือวงที่ไม่มีสมาชิกแล้วแต่
 * ยังมีบิล ซึ่งอ่านกลับมาไม่ได้และซ่อมด้วยมือไม่ได้ด้วย
 */
export async function hardDeleteGroup(groupId: string, tx?: PoolClient): Promise<void> {
  if (tx !== undefined && tx !== null) return purgeGroup(tx, groupId)
  return withTransaction(client => purgeGroup(client, groupId))
}

async function purgeGroup(q: Queryable, groupId: string): Promise<void> {
  const { rows } = await q.query<{ id: string }>(
    `select id from ledger_group where id = $1 for update`,
    [groupId],
  )
  if (!rows[0]) throw new Error(`ไม่พบวง ${groupId}`)

  await q.query(
    `delete from expense_item_share x
      using expense_item i, expense e
      where x.item_id = i.id and i.expense_id = e.id and e.group_id = $1`,
    [groupId],
  )
  await q.query(
    `delete from expense_item i using expense e
      where i.expense_id = e.id and e.group_id = $1`,
    [groupId],
  )
  await q.query(
    `delete from expense_share s using expense e
      where s.expense_id = e.id and e.group_id = $1`,
    [groupId],
  )
  await q.query(`delete from settlement where group_id = $1`, [groupId])
  await q.query(`delete from audit_log where group_id = $1`, [groupId])
  await q.query(`delete from expense where group_id = $1`, [groupId])
  await q.query(`delete from member where group_id = $1`, [groupId])
  await q.query(`delete from ledger_group where id = $1`, [groupId])
}

export async function restoreGroup(
  groupId: string,
  dbOrTx?: Queryable,
): Promise<LedgerGroup> {
  const group = await queryGroup(
    db(dbOrTx),
    `update ledger_group
       set status = 'active', deleted_at = null
     where id = $1
     returning *`,
    [groupId],
  )
  return requireGroup(group, groupId)
}

// ─── ผูกวงส่วนตัวเข้ากลุ่ม ────────────────────────────────────────────

/**
 * ผูกวงส่วนตัวเข้ากับกลุ่ม LINE — **ทางเดียว ไม่มีทางกลับ** และไม่ใช่การรวมวง
 *
 * เงื่อนไข `kind = 'personal' and line_group_id is null` อยู่ใน `where` ของ
 * update เอง ไม่ได้อ่านมาเช็คก่อน เพราะสองคำสั่งที่ยิงพร้อมกันจากคนละหน้าจอ
 * จะผ่าน "เช็คแล้วค่อยเขียน" ได้ทั้งคู่. เมื่อไม่โดนแถวไหนถึงค่อยอ่านมาดูว่า
 * เพราะอะไร — การอ่านตรงนั้นมีไว้ทำข้อความ error ไม่ได้ใช้ตัดสินใจ
 */
export async function linkPersonalGroupToLine(
  groupId: string,
  lineGroupId: string,
  dbOrTx?: Queryable,
): Promise<LedgerGroup> {
  const q = db(dbOrTx)
  let updated: LedgerGroup | null
  try {
    updated = await queryGroup(
      q,
      `update ledger_group
         set line_group_id = $2, kind = 'line_group'
       where id = $1 and kind = 'personal' and line_group_id is null
       returning *`,
      [groupId, lineGroupId],
    )
  } catch (err) {
    if (isLineGroupIdConflict(err)) {
      throw new Error(`กลุ่ม LINE ${lineGroupId} มีวงอื่นผูกอยู่แล้ว`, { cause: err })
    }
    throw err
  }
  if (updated) return updated

  const existing = requireGroup(await findGroupById(groupId, q), groupId)
  throw new Error(
    `วง ${groupId} เป็นวงกลุ่มอยู่แล้ว (ผูกกับ ${existing.lineGroupId}) ผูกซ้ำไม่ได้ และย้อนกลับเป็นวงส่วนตัวไม่ได้`,
  )
}
