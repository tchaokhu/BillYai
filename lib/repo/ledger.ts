/**
 * ledger — โหลดวงทั้งวงมาให้ `lib/debt.ts` ตัดสิน
 *
 * **ไม่มีสูตรเงินในไฟล์นี้และห้ามมี** (D25) ทั้ง `sum`, `case when status`,
 * และการกรอง `voided`/`confirmed` เป็นของ `lib/debt.ts` ที่เดียว หน้าที่ของชั้นนี้
 * คือแปลงแถวเป็น `ExpenseForDebt[]` / `SettlementForDebt[]` ให้ครบเท่านั้น
 *
 * ทำไมไม่กรองที่ SQL ทั้งที่กรองได้: กติกาว่าอะไรนับหรือไม่นับ (`voided` ไม่นับ,
 * `claimed` ยังไม่นับ — D8) จะย้ายไปอยู่สองที่ทันที แล้ววันที่กติกาเปลี่ยน
 * จะมีที่หนึ่งที่ลืมแก้โดยไม่มีเทสต์ไหนเตือน เพราะทั้งสองที่ต่างก็ "ถูก" ในสายตา
 * ตัวเอง. ราคาที่จ่ายคือโหลดแถวที่ไม่นับมาด้วย ซึ่งเล็กเมื่อวงจริงมีบิลหลักสิบ
 * ถึงหลักร้อยใบ (D25 ยอมรับราคานี้ไว้แล้ว)
 */

import type { PoolClient } from 'pg'
import { withTransaction } from '@/lib/db/client'
import { assertSatang } from '@/lib/db/rows'
import { computeDebts, floatOf } from '@/lib/debt'
import type {
  ExpenseForDebt,
  MemberId,
  SettlementForDebt,
  Share,
} from '@/lib/types'

/** ทุกอย่างของวงหนึ่งวงที่ `computeDebts` ต้องใช้ — ป้อนได้ตรงๆ ไม่ต้องแปลงอีก */
export interface Ledger {
  expenses: ExpenseForDebt[]
  settlements: SettlementForDebt[]
}

/** ledger ของวงหนึ่ง พร้อมบอกว่า App User คนที่ถามเป็น member ตัวไหนในวงนั้น */
export interface MemberLedger extends Ledger {
  groupId: string
  memberId: MemberId
}

export interface FloatBreakdown {
  totalSatang: number
  byGroup: Array<{ groupId: string; memberId: MemberId; floatSatang: number }>
}

type ExpenseShareRow = {
  expense_id: string
  payer_member_id: string
  status: string
  member_id: string | null
  amount_satang: number | null
}

type SettlementRow = {
  from_member_id: string
  to_member_id: string
  amount_satang: number
  status: SettlementForDebt['status']
}

type MembershipRow = {
  group_id: string
  member_id: string
}

/**
 * `left join` ไม่ใช่ `join` — บิลที่ไม่มี share สักแถวต้องโผล่มาเป็นบิลที่มี
 * `shares: []` ไม่ใช่หายไปเงียบๆ. `commitExpense` กันไม่ให้เกิดอยู่แล้ว แต่ถ้า
 * วันหนึ่งมันเกิดขึ้นจริง เราอยากเห็นบิลที่ยอดไม่ครบ มากกว่าจะไม่เห็นบิลนั้นเลย
 *
 * เรียงด้วย `expense.id` แล้ว `member_id` เพื่อให้ผลลัพธ์เหมือนเดิมทุกครั้ง —
 * `computeDebts` ให้คำตอบเดียวกันไม่ว่าลำดับไหน แต่การ diff ผลสองครั้งของสิ่งที่
 * ควรเท่ากันเป็นเครื่องมือหาบั๊กที่ใช้ได้จริงเมื่อลำดับคงที่
 */
const EXPENSE_SQL = `
  select e.id as expense_id,
         e.payer_member_id,
         e.status,
         s.member_id,
         s.amount_satang
    from expense e
    left join expense_share s on s.expense_id = e.id
   where e.group_id = $1
   order by e.id, s.member_id
`

const SETTLEMENT_SQL = `
  select from_member_id, to_member_id, amount_satang, status
    from settlement
   where group_id = $1
   order by id
`

/**
 * ทุกวงที่ยังไม่ถูกลบซึ่ง App User คนนี้เป็นสมาชิกอยู่
 *
 * `status = 'active'` คือด่านเดียวที่กันวงที่ soft-delete ไปแล้ว — วงพวกนั้น
 * ยังมีแถวอยู่ครบตาม D18 และหนี้ในนั้นก็ยังคำนวณได้ถ้าเปิดดูตรงๆ แต่ต้องไม่ไป
 * โผล่ในยอดเงินจมรวมของคน ซึ่งเป็นตัวเลขที่เขาเอาไปไล่เก็บกับคนอื่นจริงๆ
 */
const MEMBERSHIP_SQL = `
  select m.group_id, m.id as member_id
    from member m
    join ledger_group g on g.id = m.group_id
   where m.app_user_id = $1
     and g.status = 'active'
   order by m.group_id
`

/**
 * โหลด ledger ของวงหนึ่ง
 *
 * ผู้เรียกที่ไม่ส่ง `db` มาจะได้ transaction แบบ `repeatable read` ครอบให้เอง:
 * บิลกับ settlement อ่านคนละคำสั่ง และภายใต้ `read committed` แต่ละคำสั่งเห็น
 * snapshot ของตัวเอง — settlement ที่ถูกยืนยันคาบเกี่ยวระหว่างสองคำสั่งจะทำให้
 * ยอดที่คืนออกไปเป็นยอดที่ไม่เคยมีอยู่จริง ณ เวลาใดเลย. เป็นยอดเงินที่คนเอาไป
 * ทวงกัน จึงยอมจ่ายค่า transaction เพื่อให้ทั้งสองคำสั่งเห็นภาพเดียวกัน
 */
export async function loadLedger(groupId: string, tx?: PoolClient): Promise<Ledger> {
  if (isOwnTransaction(tx)) return readLedger(tx, groupId)
  return withTransaction(async (own: PoolClient) => {
    await own.query('set transaction isolation level repeatable read')
    return readLedger(own, groupId)
  })
}

/**
 * ledger ของทุกวงที่ App User คนนี้อยู่ — วัตถุดิบของเงินจมข้ามวง
 *
 * ยิงทีละวงแทนที่จะรวบเป็น query เดียว เพราะสิ่งที่ `computeDebts` รับคือวงเดียว
 * ต่อครั้ง (หนี้ข้ามวงหักกลบกันไม่ได้ — คนละวงคือคนละบัญชี) การรวบมาแล้วมาแยก
 * ทีหลังจึงไม่ประหยัดอะไรนอกจากทำให้พลาดง่ายขึ้น. คนหนึ่งอยู่ไม่กี่วง
 */
export async function loadLedgersForAppUser(
  appUserId: string,
  tx?: PoolClient,
): Promise<MemberLedger[]> {
  if (isOwnTransaction(tx)) return readLedgersForAppUser(tx, appUserId)
  return withTransaction(async (own: PoolClient) => {
    await own.query('set transaction isolation level repeatable read')
    return readLedgersForAppUser(own, appUserId)
  })
}

/**
 * ผู้เรียกส่ง client ที่อยู่ใน transaction มาจริงหรือเปล่า
 *
 * รับ `PoolClient` ไม่ใช่ `Queryable` เพราะ `Pool` ก็มีเมธอด `query` เหมือนกัน —
 * ส่ง pool มาแล้วสองคำสั่งจะวิ่งคนละ connection คนละ snapshot ซึ่งลบล้าง
 * transaction ที่ฟังก์ชันข้างบนตั้งใจเปิดให้ทั้งดุ้น. type กันได้เฉพาะผู้เรียกที่
 * ผ่าน tsc จึงมีด่านตอนรันด้วย — `null` นับเป็น "ไม่ได้ส่งมา" ไม่ใช่ TypeError
 * เพราะเป็นค่าที่ route/webhook ที่ไม่ได้ผ่าน tsc ส่งมาได้ง่ายที่สุด
 */
function isOwnTransaction(tx: PoolClient | null | undefined): tx is PoolClient {
  if (tx === undefined || tx === null) return false
  if (typeof (tx as Partial<PoolClient>).release !== 'function') {
    throw new Error(
      'loadLedger ต้องได้ client ที่อยู่ใน transaction (PoolClient) — ได้ pool มาแทน',
    )
  }
  return true
}

/**
 * เงินจมรวมข้ามวง — ผลรวมของ `floatOf` รายวง
 *
 * บวกกันตรงๆ ได้เพราะ `floatOf` คืนสตางค์ integer และไม่มีการปัดเศษเกิดขึ้นที่นี่
 * สูตรยังอยู่ใน `lib/debt.ts` ทั้งหมด ฟังก์ชันนี้แค่เดินลูป
 */
export function floatAcrossGroups(ledgers: readonly MemberLedger[]): FloatBreakdown {
  const byGroup = ledgers.map(ledger => ({
    groupId: ledger.groupId,
    memberId: ledger.memberId,
    floatSatang: floatOf(
      computeDebts(ledger.expenses, ledger.settlements),
      ledger.memberId,
    ),
  }))
  return {
    totalSatang: byGroup.reduce((sum, group) => sum + group.floatSatang, 0),
    byGroup,
  }
}

// ─── ภายใน ────────────────────────────────────────────────────────────

async function readLedger(db: PoolClient, groupId: string): Promise<Ledger> {
  const expenseResult = await db.query<ExpenseShareRow>(EXPENSE_SQL, [groupId])
  const settlementResult = await db.query<SettlementRow>(SETTLEMENT_SQL, [groupId])

  return {
    expenses: toExpensesForDebt(expenseResult.rows),
    settlements: settlementResult.rows.map(row => ({
      fromId: row.from_member_id,
      toId: row.to_member_id,
      amountSatang: assertSatang(row.amount_satang, 'settlement.amount_satang'),
      status: row.status,
    })),
  }
}

async function readLedgersForAppUser(
  db: PoolClient,
  appUserId: string,
): Promise<MemberLedger[]> {
  const { rows } = await db.query<MembershipRow>(MEMBERSHIP_SQL, [appUserId])

  const ledgers: MemberLedger[] = []
  for (const row of rows) {
    const ledger = await readLedger(db, row.group_id)
    ledgers.push({ groupId: row.group_id, memberId: row.member_id, ...ledger })
  }
  return ledgers
}

/**
 * ยุบแถวที่ join มาแล้วให้กลับเป็นบิลละหนึ่งก้อน
 *
 * แถวเรียงตาม `expense.id` มาแล้ว แต่ไม่พึ่งลำดับนั้นในการจับกลุ่ม — ใช้ Map
 * เพราะ `order by` ที่หายไปวันหนึ่งจะกลายเป็นบิลที่แตกเป็นสองก้อน ซึ่งยอดจะ
 * ยังบวกได้ครบและไม่มีใครเห็นว่าผิด
 */
function toExpensesForDebt(rows: readonly ExpenseShareRow[]): ExpenseForDebt[] {
  const byExpense = new Map<string, ExpenseForDebt>()

  for (const row of rows) {
    let expense = byExpense.get(row.expense_id)
    if (expense === undefined) {
      expense = {
        payerId: row.payer_member_id,
        shares: [],
        // ระบุ `false` ตรงๆ ไม่ปล่อยเป็น undefined — ผู้เรียกที่เขียนเงื่อนไข
        // `expense.voided === false` ต้องได้คำตอบเดียวกับ `!expense.voided`
        voided: row.status === 'voided',
      }
      byExpense.set(row.expense_id, expense)
    }

    // `member_id` เป็น null ได้เฉพาะจาก left join ที่ไม่เจอ share สักแถว
    if (row.member_id === null) continue
    if (row.amount_satang === null) {
      // แถวเดียวกันมี member แต่ไม่มียอด = คอลัมน์ `not null` ถูกถอดออกไปแล้ว
      throw new Error(`expense_share ของบิล ${row.expense_id} ไม่มี amount_satang`)
    }
    const share: Share = {
      memberId: row.member_id,
      amountSatang: assertSatang(row.amount_satang, 'expense_share.amount_satang'),
    }
    expense.shares.push(share)
  }

  return [...byExpense.values()]
}
