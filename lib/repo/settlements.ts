/**
 * repository ของ Settlement — การเคลียร์หนี้ที่เดินสองขั้นเสมอ (D8)
 *
 * **ทำไมไม่มี `createConfirmedSettlement`**: ระบบไม่แตะเงินจริงและไม่มีทางรู้ว่า
 * เงินเข้าบัญชีไหม เจ้าหนี้เป็นคนเดียวที่รู้. ถ้ามี API สร้างตรงเป็น `confirmed`
 * ได้ ลูกหนี้ (หรือโค้ดฝั่งบนที่มักง่าย) จะลบหนี้ตัวเองได้โดยเจ้าหนี้ไม่รู้ตัว
 * — หนี้จะหายจาก ledger ทั้งที่เงินไม่เคยขยับ. ทางเข้าจึงมีทางเดียวคือ
 * `claimSettlement` ซึ่งสร้างได้แต่ `claimed` และสถานะ `claimed` ที่ค้างคือ
 * แรงกดดันให้เจ้าหนี้รีบเช็ค ไม่ใช่ข้อบกพร่อง
 *
 * ที่นี่ไม่คิดเลขหนี้เลย — สูตร Debt อยู่ที่ `lib/debt.ts` ที่เดียว (D25)
 */

import { getPool, type Queryable } from '@/lib/db/client'
import {
  assertSatang,
  toSettlement,
  type Settlement,
  type SettlementRow,
  type SettlementStatus,
  type SettlementVia,
} from '@/lib/db/rows'
import type { MemberId } from '@/lib/types'

export interface ClaimSettlementInput {
  groupId: string
  /** ลูกหนี้ คนแจ้งว่าจ่ายแล้ว */
  fromMemberId: MemberId
  /** เจ้าหนี้ */
  toMemberId: MemberId
  amountSatang: number
  claimedBy?: MemberId
  claimedVia: SettlementVia
  note?: string
}

/** คำตัดสินของเจ้าหนี้ — ใช้ทั้งตอนยืนยันและตอนปฏิเสธ */
export interface SettlementRuling {
  confirmedBy: MemberId
  confirmedVia: SettlementVia
}

/** ทุกคอลัมน์เสมอ — mapper กลางต้องการครบทุกช่อง */
const COLUMNS = `id, group_id, from_member_id, to_member_id, amount_satang, status,
                 claimed_at, claimed_by, claimed_via,
                 confirmed_at, confirmed_by, confirmed_via, note`

/**
 * DB มี check constraint คุมอยู่แล้ว แต่ error ของ Postgres อ่านไม่รู้เรื่อง
 * สำหรับคนที่กดปุ่มผิด — กันที่นี่อีกชั้นเพื่อให้ได้ข้อความที่เอาไปโชว์ได้
 */
const ALLOWED_VIA: readonly SettlementVia[] = ['liff', 'link', 'web']

export async function claimSettlement(
  input: ClaimSettlementInput,
  db: Queryable = getPool(),
): Promise<Settlement> {
  assertPositiveSatang(input.amountSatang)
  assertVia(input.claimedVia, 'claimedVia')

  if (input.fromMemberId === input.toMemberId) {
    throw new Error('claimSettlement: จ่ายเงินให้ตัวเองไม่ได้ ลูกหนี้กับเจ้าหนี้ต้องคนละคน')
  }
  await assertMembersInGroup(input.groupId, [input.fromMemberId, input.toMemberId], db)

  const { rows } = await db.query<SettlementRow>(
    `insert into settlement (
       group_id, from_member_id, to_member_id, amount_satang,
       status, claimed_by, claimed_via, note
     ) values ($1, $2, $3, $4, 'claimed', $5::uuid, $6, $7)
     returning ${COLUMNS}`,
    [
      input.groupId,
      input.fromMemberId,
      input.toMemberId,
      input.amountSatang,
      // ไม่รู้ว่าใครกดก็บอกว่าไม่รู้ — เดาว่าเป็นลูกหนี้จะทำให้ audit trail โกหก
      input.claimedBy ?? null,
      input.claimedVia,
      input.note ?? null,
    ],
  )
  const row = rows[0]
  if (!row) throw new Error('claimSettlement: insert ไม่คืนแถว')
  return toSettlement(row)
}

/**
 * เจ้าหนี้ยืนยันว่าเงินเข้าจริง — ขั้นที่สองของ D8
 *
 * ไม่บังคับว่า `confirmedBy` ต้องเป็น `to_member_id` เพราะเจ้าของวงส่วนตัวยืนยัน
 * แทนได้ผ่าน Owner Link (DESIGN §5). ใครมีสิทธิ์กดเป็นเรื่องของชั้น authz
 * ที่ server ซึ่งอยู่ที่เดียวตาม D15 — ไม่ใช่ของ repository
 */
export async function confirmSettlement(
  id: string,
  by: SettlementRuling,
  db: Queryable = getPool(),
): Promise<Settlement> {
  return ruleOnClaim(id, 'confirmed', by, db)
}

/** เจ้าหนี้บอกว่าเงินไม่เข้า — บันทึกไว้ในช่องเดียวกับตอนยืนยัน เพราะเป็นคำตัดสินเดียวกัน */
export async function rejectSettlement(
  id: string,
  by: SettlementRuling,
  db: Queryable = getPool(),
): Promise<Settlement> {
  return ruleOnClaim(id, 'rejected', by, db)
}

/**
 * ลูกหนี้ถอนคำแจ้งของตัวเอง — ทำได้เฉพาะตอนที่เจ้าหนี้ยังไม่ตัดสิน
 *
 * ช่อง `confirmed_*` ยังว่างต่อไป: เจ้าหนี้ไม่เคยตัดสินอะไร
 */
export async function cancelSettlement(
  id: string,
  db: Queryable = getPool(),
): Promise<Settlement> {
  const { rows } = await db.query<SettlementRow>(
    `update settlement set status = 'cancelled'
     where id = $1 and status = 'claimed'
     returning ${COLUMNS}`,
    [id],
  )
  const row = rows[0]
  if (!row) return explainMiss(id, 'cancelSettlement', db)
  return toSettlement(row)
}

export async function findSettlementById(
  id: string,
  db: Queryable = getPool(),
): Promise<Settlement | null> {
  const { rows } = await db.query<SettlementRow>(
    `select ${COLUMNS} from settlement where id = $1`,
    [id],
  )
  const row = rows[0]
  return row ? toSettlement(row) : null
}

/**
 * เรียง `claimed_at desc` แล้ว tie-break ด้วย `id desc`
 *
 * ต้องมี tie-break เพราะแถวที่เขียนใน transaction เดียวกันได้ `now()` ค่าเดียวกัน
 * เป๊ะ — ถ้าไม่ระบุ Postgres จะคืนลำดับตามใจ แล้วหน้าจอจะสลับที่เองระหว่าง refresh
 */
export async function listSettlements(
  groupId: string,
  options: { status?: SettlementStatus } = {},
  db: Queryable = getPool(),
): Promise<Settlement[]> {
  const status = options.status ?? null
  const { rows } = await db.query<SettlementRow>(
    `select ${COLUMNS} from settlement
     where group_id = $1 and ($2::text is null or status = $2)
     order by claimed_at desc, id desc`,
    [groupId, status],
  )
  return rows.map(toSettlement)
}

// ─── ภายใน ────────────────────────────────────────────────────────────

/**
 * เขียนสถานะแบบ compare-and-set ในคำสั่งเดียว
 *
 * `where status = 'claimed'` คือตัวกัน double-confirm: ถ้าเจ้าหนี้กดรัวสองครั้ง
 * ครั้งที่สองจะรอ lock ของครั้งแรก แล้วประเมิน `where` ใหม่กับแถวที่เปลี่ยนไปแล้ว
 * จึงไม่แมตช์และได้ 0 แถว. **ห้ามเปลี่ยนเป็น select แล้วค่อย update** — ช่องว่าง
 * ระหว่างสองคำสั่งคือที่ที่ทั้งคู่จะเห็น `claimed` แล้วผ่านทั้งคู่ ซึ่งแปลว่า
 * หนี้ก้อนเดียวถูกหักออกจากยอดสองรอบ
 */
async function ruleOnClaim(
  id: string,
  next: Extract<SettlementStatus, 'confirmed' | 'rejected'>,
  by: SettlementRuling,
  db: Queryable,
): Promise<Settlement> {
  assertVia(by.confirmedVia, 'confirmedVia')

  const { rows } = await db.query<SettlementRow>(
    `update settlement
        set status = $2, confirmed_at = now(), confirmed_by = $3, confirmed_via = $4
      where id = $1 and status = 'claimed'
      returning ${COLUMNS}`,
    [id, next, by.confirmedBy, by.confirmedVia],
  )
  const row = rows[0]
  if (!row) {
    return explainMiss(id, next === 'confirmed' ? 'confirmSettlement' : 'rejectSettlement', db)
  }
  return toSettlement(row)
}

/**
 * ไม่โดนแถวแปลว่าอย่างใดอย่างหนึ่ง: ไม่มี id นั้น หรือมีแต่ไม่ใช่ `claimed` แล้ว
 * อ่านซ้ำเพื่อบอกให้ตรงกรณี — ตอนนี้การแข่งจบไปแล้ว การอ่านตรงนี้จึงไม่ใช่ race
 *
 * ทั้งสองกรณี throw ไม่คืน null: ผู้เรียกสั่งให้ "เปลี่ยนสถานะ" ถ้าไม่ได้เปลี่ยน
 * แล้วเงียบ ฝั่งบนจะบอกผู้ใช้ว่าสำเร็จทั้งที่ ledger ไม่ขยับ
 */
async function explainMiss(id: string, action: string, db: Queryable): Promise<never> {
  const current = await findSettlementById(id, db)
  if (!current) {
    throw new Error(`${action}: ไม่พบ settlement ${id}`)
  }
  throw new Error(
    `${action}: settlement ${id} อยู่สถานะ ${current.status} แล้ว ` +
      `เปลี่ยนได้เฉพาะตัวที่ยัง claimed เท่านั้น`,
  )
}

function assertPositiveSatang(amountSatang: number): void {
  assertSatang(amountSatang, 'settlement.amountSatang')
  if (amountSatang <= 0) {
    throw new Error(
      `settlement.amountSatang ต้องมากกว่า 0 สตางค์ — ได้ ${amountSatang} ` +
        '(การเคลียร์หนี้ยอด 0 ไม่มีความหมาย ยอดติดลบคือหนี้กลับทาง ให้แจ้งอีกทางแทน)',
    )
  }
}

function assertVia(via: SettlementVia, label: string): void {
  if (!ALLOWED_VIA.includes(via)) {
    throw new Error(
      `${label} ต้องเป็น liff|link|web — ได้ "${via}". ` +
        "'line' ไม่ใช่ช่องทางของ settlement เพราะยืนยันการจ่ายในแชทกลุ่มไม่ได้",
    )
  }
}

/**
 * ยอดหนี้ไม่ข้ามวง (CONTEXT §Group) แต่ FK ของ `settlement` ชี้ไป `member` เฉยๆ
 * ไม่ได้บังคับว่าสมาชิกต้องอยู่วงเดียวกับ `group_id` — ถ้าไม่ตรวจตรงนี้
 * settlement ที่อ้างสมาชิกวงอื่นจะลอยอยู่ในวงโดยไม่มีใครเห็น แล้วยอดของสองวงเพี้ยน
 */
async function assertMembersInGroup(
  groupId: string,
  memberIds: readonly MemberId[],
  db: Queryable,
): Promise<void> {
  const { rows } = await db.query<{ id: string; group_id: string }>(
    `select id, group_id from member where id = any($1::uuid[])`,
    [memberIds],
  )
  for (const memberId of memberIds) {
    const found = rows.find((r) => r.id === memberId)
    if (!found) {
      throw new Error(`claimSettlement: ไม่พบสมาชิก ${memberId}`)
    }
    if (found.group_id !== groupId) {
      throw new Error(
        `claimSettlement: สมาชิก ${memberId} อยู่คนละวงกับ settlement — หนี้ไม่ข้ามวง`,
      )
    }
  }
}
