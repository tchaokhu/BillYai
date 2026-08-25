/**
 * repository ของบิล — เขียนบิลหนึ่งใบลง ledger, อ่านกลับ, ยกเลิก
 *
 * นี่คือโมดูลเดียวใน M2 ที่เขียนเงินลง ledger จริง กติกาสองข้อจึงเข้มกว่าที่อื่น:
 *
 * 1. **ทั้งใบเขียนใน transaction เดียว** — บิลที่มี share ไม่ครบคือหนี้ที่ผิด
 *    โดยที่ไม่มีใครรู้ตัว ยอมให้ไม่มีบิลเลยดีกว่ามีบิลที่แตกไม่ครบ
 * 2. **invariant `Σ share = total + surcharge` ตรวจซ้ำที่นี่** แม้ `splitExpense`
 *    ตรวจไปแล้ว เพราะ shares เข้ามาทาง LLM/LIFF/เว็บได้โดยไม่ผ่าน `splitExpense`
 *    และใช้ `addSurcharge` ตัวเดียวกับที่ `split.ts` ใช้ — เขียนสูตรใหม่ที่นี่
 *    เมื่อไหร่ ก็จะมีสองสูตรที่ต้องปัดเศษให้ตรงกันตลอดไป
 *
 * ไม่มีการคิดเลขเงินใน SQL ที่ไหนในไฟล์นี้ (D25)
 */

import type { PoolClient } from 'pg'
import { getPool, withTransaction, type Queryable } from '@/lib/db/client'
import {
  toExpense,
  toExpenseItem,
  toExpenseItemShare,
  toExpenseShare,
  type Expense,
  type ExpenseItem,
  type ExpenseItemRow,
  type ExpenseItemShare,
  type ExpenseItemShareRow,
  type ExpenseRow,
  type ExpenseShare,
  type ExpenseShareRow,
  type ExpenseSource,
} from '@/lib/db/rows'
import { addSurcharge, splitExpense } from '@/lib/split'
import type { MemberId, SplitMode } from '@/lib/types'

// ─── สัญญาที่โมดูลอื่นเรียก ───────────────────────────────────────────

export interface CommitExpenseInput {
  groupId: string
  description: string
  /** ยอดก่อนบวก surcharge */
  totalSatang: number
  surchargePct: number
  payerMemberId: MemberId
  splitMode: SplitMode
  /** `'YYYY-MM-DD'` ตามวันที่คนจดกรอก ไม่ใช่ timestamp */
  spentAt: string
  createdBy: MemberId
  source: ExpenseSource
  eventTag?: string | null
  /** ยอดรายคน **รวม surcharge แล้ว** — ผลรวมต้องเท่ากับยอดหลังบวก surcharge เป๊ะ */
  shares: ReadonlyArray<{ memberId: MemberId; amountSatang: number; weight?: number | null }>
  /**
   * โหมด `itemized` เท่านั้น
   *
   * ไม่มี `weight` รายชิ้น — ของหนึ่งชิ้นหารเท่ากันในกลุ่มคนที่กิน (`Item` ใน
   * `lib/types.ts` มีแค่ `memberIds` และ `itemizedSubtotals` หารเท่ากันเสมอ)
   * ถ้ารับ weight เข้ามาโดยไม่มีใครกระทบยอดกับ `shares[].amountSatang` ซึ่งเป็น
   * ตัวจริง จะเก็บน้ำหนักที่ขัดกับยอดที่มันควรอธิบายได้โดยผ่านด่านตรวจทุกด่าน
   */
  items?: ReadonlyArray<{
    name: string
    amountSatang: number
    shares: ReadonlyArray<{ memberId: MemberId }>
  }>
}

export interface ExpenseDetail {
  expense: Expense
  shares: ExpenseShare[]
  items: Array<{ item: ExpenseItem; shares: ExpenseItemShare[] }>
}

export interface ListExpensesOptions {
  /** default `false` — บิลที่ยกเลิกแล้วไม่ควรโผล่ในหน้าจอปกติ */
  includeVoided?: boolean
  eventTag?: string
  limit?: number
}

// ─── การตรวจอินพุต ────────────────────────────────────────────────────

const SPENT_AT_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * เพดานของ `weight numeric(8,3)` — 5 หลักหน้าจุด 3 หลังจุด
 *
 * ไม่มีด่านนี้ ค่าอย่าง 1000000 จะผ่าน `assertInput`, เปิด transaction,
 * `insertExpense` สำเร็จ แล้วค่อยไปตายที่ `insertShares` ด้วย `numeric field
 * overflow` ซึ่งขัดกับหน้าที่ของ `assertInput` ที่ต้องตรวจทุกอย่างที่ตรวจได้
 * ให้จบก่อนแตะ DB
 */
const MAX_WEIGHT = 99999.999

/**
 * จำนวนทศนิยมที่ค่านั้น "แทน" จริงๆ — อ่านจากสตริงด้วยเหตุผลเดียวกับ
 * `weightDecimals` ใน money.ts
 */
function decimalPlaces(value: number, label: string): number {
  const text = String(value)
  if (text.includes('e') || text.includes('E')) {
    throw new Error(`${label} อยู่นอกช่วงที่รองรับ: ${value}`)
  }
  return (text.split('.')[1] ?? '').length
}

/** ตรวจทุกอย่างที่ตรวจได้โดยไม่ต้องแตะ DB — ต้องผ่านก่อนเปิด transaction */
function assertInput(input: CommitExpenseInput): void {
  if (!Number.isSafeInteger(input.totalSatang) || input.totalSatang <= 0) {
    throw new Error(`ยอดบิลต้องเป็นสตางค์ integer ที่มากกว่า 0 — ได้ ${input.totalSatang}`)
  }
  if (!Number.isFinite(input.surchargePct) || input.surchargePct < 0 || input.surchargePct > 100) {
    throw new Error(`surchargePct ต้องอยู่ระหว่าง 0–100 — ได้ ${input.surchargePct}`)
  }
  // `surcharge_pct` เป็น numeric(5,2): 17.005 จะถูกปัดเป็น 17.01 เงียบๆ ตอน insert
  // แล้วยอดที่คำนวณจากแถวที่อ่านกลับมาจะไม่ตรงกับ Σ shares ที่เพิ่งเขียนลงไป
  if (decimalPlaces(input.surchargePct, 'surchargePct') > 2) {
    throw new Error(`surchargePct มีทศนิยมได้ไม่เกิน 2 ตำแหน่ง — ได้ ${input.surchargePct}`)
  }
  if (input.description.trim() === '') {
    throw new Error('รายละเอียดบิลว่างไม่ได้')
  }
  if (!SPENT_AT_PATTERN.test(input.spentAt)) {
    throw new Error(`spentAt ต้องเป็น 'YYYY-MM-DD' — ได้ ${JSON.stringify(input.spentAt)}`)
  }
  if (input.shares.length === 0) {
    throw new Error('บิลต้องมีผู้ร่วมหารอย่างน้อยหนึ่งคน')
  }

  const seen = new Set<MemberId>()
  for (const share of input.shares) {
    if (seen.has(share.memberId)) {
      throw new Error(`ผู้ร่วมหารซ้ำในบิลเดียวกัน: ${share.memberId}`)
    }
    seen.add(share.memberId)

    if (!Number.isSafeInteger(share.amountSatang)) {
      throw new Error(`ยอดของ ${share.memberId} ต้องเป็นสตางค์ integer — ได้ ${share.amountSatang}`)
    }
    // 0 ถูกต้องในโหมด exact (มาแต่ไม่ได้กิน) แต่ติดลบไม่มีความหมาย
    if (share.amountSatang < 0) {
      throw new Error(`ยอดของ ${share.memberId} ติดลบไม่ได้: ${share.amountSatang}`)
    }
    if (share.weight !== undefined && share.weight !== null) {
      if (!Number.isFinite(share.weight) || share.weight <= 0) {
        throw new Error(`น้ำหนักของ ${share.memberId} ต้องมากกว่า 0 — ได้ ${share.weight}`)
      }
      if (share.weight > MAX_WEIGHT) {
        throw new Error(`น้ำหนักของ ${share.memberId} เกิน ${MAX_WEIGHT} ไม่ได้ — ได้ ${share.weight}`)
      }
      if (decimalPlaces(share.weight, 'น้ำหนัก') > 3) {
        throw new Error(`น้ำหนักมีทศนิยมได้ไม่เกิน 3 ตำแหน่ง — ได้ ${share.weight}`)
      }
    }
  }

  // invariant กลางของทั้งระบบ — ใช้ `addSurcharge` ตัวเดียวกับ split.ts
  const grandTotal = addSurcharge(input.totalSatang, input.surchargePct)
  const sum = input.shares.reduce((acc, share) => acc + share.amountSatang, 0)
  if (sum !== grandTotal) {
    throw new Error(
      `ผลรวมยอดรายคน (${sum}) ไม่เท่ากับยอดบิลหลังบวก surcharge (${grandTotal})`,
    )
  }

  assertItems(input, seen)
}

/** `items` ผูกกับโหมด itemized เท่านั้น — ผิดโหมดแปลว่าคนเรียกเข้าใจผิด */
function assertItems(input: CommitExpenseInput, participants: ReadonlySet<MemberId>): void {
  if (input.splitMode !== 'itemized') {
    if (input.items !== undefined) {
      throw new Error(`โหมด ${input.splitMode} ต้องไม่ส่ง items มา`)
    }
    return
  }
  if (input.items === undefined || input.items.length === 0) {
    throw new Error('โหมด itemized ต้องมี items อย่างน้อยหนึ่งรายการ')
  }

  let stated = 0
  for (const item of input.items) {
    if (item.name.trim() === '') throw new Error('ชื่อรายการว่างไม่ได้')
    if (!Number.isSafeInteger(item.amountSatang) || item.amountSatang <= 0) {
      throw new Error(`ราคาของ "${item.name}" ต้องเป็นสตางค์ integer ที่มากกว่า 0 — ได้ ${item.amountSatang}`)
    }
    if (item.shares.length === 0) {
      throw new Error(`รายการ "${item.name}" ไม่มีคนกิน`)
    }
    stated += item.amountSatang

    const seen = new Set<MemberId>()
    for (const share of item.shares) {
      if (seen.has(share.memberId)) {
        throw new Error(`รายการ "${item.name}" มีชื่อซ้ำ: ${share.memberId}`)
      }
      seen.add(share.memberId)
      if (!participants.has(share.memberId)) {
        throw new Error(`รายการ "${item.name}" อ้างถึงคนที่ไม่ได้ร่วมหาร: ${share.memberId}`)
      }
    }
  }

  if (stated !== input.totalSatang) {
    throw new Error(`ผลรวมราคารายการ (${stated}) ไม่เท่ากับยอดบิล (${input.totalSatang})`)
  }

  assertItemsMatchShares(input, input.items)
}

/**
 * รายการต้องอธิบายยอดรายคนที่กำลังจะเขียนได้จริง
 *
 * `Σ item = total` กับ `Σ share = grandTotal` ผ่านพร้อมกันได้โดยที่ทั้งสองพูดคนละ
 * เรื่อง: สเต๊กชิ้นเดียวระบุว่า ก กินคนเดียว แต่ยอดไปลงที่ ข ทั้งก้อน — ต่างคน
 * ต่างบวกได้ครบ ไม่มีด่านไหนเห็น. บิลนั้นจะถูกเก็บพร้อมรายการที่ขัดกับยอดที่มัน
 * ควรอธิบาย และหน้าจอแก้บิลจะคำนวณได้อีกคำตอบหนึ่ง
 *
 * ตรวจด้วย `splitExpense` ตัวเดียวกับที่แตกบิล ไม่ได้เขียนสูตรใหม่ที่นี่ —
 * ด้วยเหตุผลเดียวกับที่ `addSurcharge` ถูก export ออกมาใช้ร่วม
 *
 * **เผื่อไว้ `items.length + 1` สตางค์ต่อคน**: เศษของแต่ละชิ้นตกกับใครขึ้นกับ
 * ลำดับผู้ร่วมหาร ซึ่งผู้เรียกจาก LIFF ไม่มีเหตุผลต้องรักษาให้ตรงกับตอนคำนวณ
 * แต่ละชิ้นจึงคลาดได้ 1 สตางค์ต่อคน บวกอีก 1 จากการกระจาย surcharge.
 * ช่วงนี้แคบเกินกว่าที่บิลซึ่งขัดกันจริงจะรอด และกว้างพอไม่ให้ปฏิเสธบิลที่ถูก
 */
function assertItemsMatchShares(
  input: CommitExpenseInput,
  items: NonNullable<CommitExpenseInput['items']>,
): void {
  const recomputed = splitExpense({
    totalSatang: input.totalSatang,
    surchargePct: input.surchargePct,
    payerId: input.payerMemberId,
    mode: 'itemized',
    participants: input.shares.map(share => ({ memberId: share.memberId })),
    items: items.map(item => ({
      name: item.name,
      amountSatang: item.amountSatang,
      memberIds: item.shares.map(share => share.memberId),
    })),
  })

  const expected = new Map(recomputed.map(share => [share.memberId, share.amountSatang]))
  const tolerance = items.length + 1

  for (const share of input.shares) {
    const want = expected.get(share.memberId) ?? 0
    if (Math.abs(share.amountSatang - want) > tolerance) {
      throw new Error(
        `ยอดของ ${share.memberId} (${share.amountSatang}) ไม่ตรงกับรายการที่เขากิน ` +
          `(คำนวณได้ ${want})`,
      )
    }
  }
}

/**
 * บิลใหม่เข้าวงที่ถูกลบไม่ได้
 *
 * วงที่ soft-delete แล้วถูกกรองออกจากเงินจมข้ามวง (`lib/repo/ledger.ts`) บิลที่
 * หลุดเข้าไปจึงเป็นหนี้ที่มีอยู่จริงในตารางแต่ไม่โผล่ในยอดที่เจ้าหนี้ใช้ทวง —
 * และมันนั่งอยู่ในวงที่รอลบถาวรตามกำหนด 30 วันของ D18. request ที่ค้างอยู่ตอน
 * บอทถูกเตะออกจากกลุ่มคือทางที่เกิดขึ้นจริง ไม่ใช่กรณีสมมุติ
 */
async function assertGroupActive(db: Queryable, groupId: string): Promise<void> {
  const { rows } = await db.query<{ status: string }>(
    `select status from ledger_group where id = $1`,
    [groupId],
  )
  const status = rows[0]?.status
  if (status === undefined) throw new Error(`ไม่พบวง ${groupId}`)
  if (status !== 'active') {
    throw new Error(`วง ${groupId} ถูกลบไปแล้ว เขียนบิลใหม่เข้าไปไม่ได้`)
  }
}

/**
 * กันไม่ให้บิลอ้างถึงสมาชิกของวงอื่น
 *
 * FK ของ `expense_share.member_id` การันตีแค่ว่า member มีจริง ไม่ได้การันตีว่า
 * อยู่วงเดียวกับบิล — share ที่ชี้ข้ามวงจะทำให้ Debt ของสองวงปนกันโดยเงียบ
 *
 * ตรวจเฉพาะ id ที่ **มีอยู่จริงแต่ผิดวง** ส่วน id ที่ไม่มีตัวตนปล่อยให้ FK เป็น
 * คนปฏิเสธ เพราะ DB คือเจ้าของความจริงเรื่อง "มีอยู่จริงไหม" ณ วินาทีที่เขียน
 */
async function assertSameGroup(
  db: Queryable,
  groupId: string,
  memberIds: readonly MemberId[],
): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    `select id from member where id = any($1::uuid[]) and group_id <> $2`,
    [memberIds, groupId],
  )
  const stray = rows[0]
  if (stray) {
    throw new Error(`สมาชิก ${stray.id} อยู่คนละวงกับบิลนี้`)
  }
}

// ─── เขียน ────────────────────────────────────────────────────────────

async function insertExpense(db: Queryable, input: CommitExpenseInput): Promise<Expense> {
  const { rows } = await db.query<ExpenseRow>(
    `insert into expense (
       group_id, event_tag, description, total_satang, surcharge_pct,
       payer_member_id, split_mode, spent_at, created_by, source
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning *`,
    [
      input.groupId,
      input.eventTag ?? null,
      input.description,
      input.totalSatang,
      input.surchargePct,
      input.payerMemberId,
      input.splitMode,
      input.spentAt,
      input.createdBy,
      input.source,
    ],
  )
  const row = rows[0]
  if (!row) throw new Error('insert expense ไม่คืนแถว')
  return toExpense(row)
}

async function insertShares(
  db: Queryable,
  expenseId: string,
  input: CommitExpenseInput,
): Promise<void> {
  for (const share of input.shares) {
    await db.query(
      `insert into expense_share (expense_id, member_id, weight, amount_satang)
       values ($1, $2, $3, $4)`,
      [expenseId, share.memberId, share.weight ?? null, share.amountSatang],
    )
  }
}

async function insertItems(
  db: Queryable,
  expenseId: string,
  items: NonNullable<CommitExpenseInput['items']>,
): Promise<void> {
  for (const item of items) {
    const { rows } = await db.query<{ id: string }>(
      `insert into expense_item (expense_id, name, amount_satang)
       values ($1, $2, $3)
       returning id`,
      [expenseId, item.name, item.amountSatang],
    )
    const itemId = rows[0]?.id
    if (!itemId) throw new Error('insert expense_item ไม่คืนแถว')

    for (const share of item.shares) {
      // ไม่ส่ง weight — ปล่อยให้ `default 1` ของคอลัมน์ทำงาน หารเท่ากันในชิ้น
      await db.query(
        `insert into expense_item_share (item_id, member_id)
         values ($1, $2)`,
        [itemId, share.memberId],
      )
    }
  }
}

async function writeExpense(db: Queryable, input: CommitExpenseInput): Promise<Expense> {
  const memberIds = new Set<MemberId>([input.payerMemberId, input.createdBy])
  for (const share of input.shares) memberIds.add(share.memberId)
  await assertGroupActive(db, input.groupId)
  await assertSameGroup(db, input.groupId, [...memberIds])

  const expense = await insertExpense(db, input)
  await insertShares(db, expense.id, input)
  if (input.items !== undefined) {
    await insertItems(db, expense.id, input.items)
  }
  return expense
}

/**
 * เขียนบิลหนึ่งใบพร้อม share (และ item ในโหมด itemized) ใน transaction เดียว
 *
 * ทางแยกของ `tx`:
 * - **ผู้เรียกส่ง client มา** → ใช้ตัวนั้นตรงๆ ไม่เปิด transaction ซ้อน เพราะ
 *   ผู้เรียกกำลังประกอบงานที่ใหญ่กว่าบิลใบเดียว (เช่น commit บิล + เขียน audit
 *   log ให้ล้มพร้อมกัน). ถ้าเราไปหยิบ client จาก pool เองที่นี่ จะกลายเป็นคนละ
 *   transaction กับของผู้เรียก แล้ว rollback ของเขาจะลบบิลนี้ไม่ได้
 * - **ไม่ส่งมา** → เปิด `withTransaction` เอง เพราะบิลที่มี share ไม่ครบ
 *   ผิดยิ่งกว่าไม่มีบิล
 *
 * รับ `PoolClient` ไม่ใช่ `Queryable` ต่างจากฟังก์ชันอ่านในไฟล์นี้ — เพราะ `Pool`
 * ก็เข้า `Queryable` ได้ ผู้เรียกที่ส่ง `Queryable` ต่อๆ กันมา (ซึ่งเป็น pool
 * โดยไม่รู้ตัว) จะข้าม `withTransaction` ไปเงียบๆ แล้ว insert สามชุดจะกลายเป็น
 * autocommit คนละ connection — พังกลางทางเมื่อไหร่ก็เหลือบิลที่ share ไม่ครบ
 * ค้างไว้จริง ซึ่งคือสิ่งเดียวที่ฟังก์ชันนี้มีหน้าที่กัน
 */
export async function commitExpense(
  input: CommitExpenseInput,
  tx?: PoolClient,
): Promise<Expense> {
  assertInput(input)
  // `null` นับเป็น "ไม่ได้ส่งมา" — เป็นค่าที่ route/webhook ที่ไม่ได้ผ่าน tsc
  // ส่งมาได้ง่ายที่สุด และการโยน TypeError ใส่มันไม่ได้ปลอดภัยขึ้นเลย
  if (tx === undefined || tx === null) {
    return withTransaction(client => writeExpense(client, input))
  }

  // ด่านตอนรันจริง เพราะ type ช่วยได้เฉพาะผู้เรียกที่คอมไพล์ผ่าน tsc — ทาง LIFF
  // route หรือ webhook ที่ cast มาจะหลุดด่านนั้นไปทั้งดุ้น
  if (typeof (tx as Partial<PoolClient>).release !== 'function') {
    throw new Error(
      'commitExpense ต้องได้ client ที่อยู่ใน transaction (PoolClient) — ได้ pool มาแทน',
    )
  }
  return writeExpense(tx, input)
}

// ─── อ่าน ─────────────────────────────────────────────────────────────

/**
 * บิลหนึ่งใบพร้อมของที่ห้อยอยู่ทั้งหมด — `null` เมื่อไม่เจอ
 *
 * ทุกลำดับที่คืนออกไป deterministic: `expense_item` ไม่มีคอลัมน์ลำดับ จึงเรียง
 * จากชิ้นแพงสุดลงมาแล้ว tie-break ด้วย `id` (ลำดับที่ผู้ใช้พิมพ์เข้ามาตอนแรก
 * กู้กลับไม่ได้ — ดูหมายเหตุท้ายไฟล์)
 */
export async function findExpenseById(
  id: string,
  db: Queryable = getPool(),
): Promise<ExpenseDetail | null> {
  const expenseResult = await db.query<ExpenseRow>(`select * from expense where id = $1`, [id])
  const expenseRow = expenseResult.rows[0]
  if (!expenseRow) return null

  const shareResult = await db.query<ExpenseShareRow>(
    `select * from expense_share where expense_id = $1 order by member_id`,
    [id],
  )
  const itemResult = await db.query<ExpenseItemRow>(
    `select * from expense_item
      where expense_id = $1
      order by amount_satang desc, id`,
    [id],
  )
  const itemShareResult = await db.query<ExpenseItemShareRow>(
    `select s.item_id, s.member_id, s.weight
       from expense_item_share s
       join expense_item i on i.id = s.item_id
      where i.expense_id = $1
      order by s.item_id, s.member_id`,
    [id],
  )

  const sharesByItem = new Map<string, ExpenseItemShare[]>()
  for (const row of itemShareResult.rows) {
    const list = sharesByItem.get(row.item_id) ?? []
    list.push(toExpenseItemShare(row))
    sharesByItem.set(row.item_id, list)
  }

  return {
    expense: toExpense(expenseRow),
    shares: shareResult.rows.map(toExpenseShare),
    items: itemResult.rows.map(row => {
      const item = toExpenseItem(row)
      return { item, shares: sharesByItem.get(item.id) ?? [] }
    }),
  }
}

/**
 * บิลของวงหนึ่ง เรียงจากวันที่ใหม่สุดลงมา
 *
 * tie-break ด้วย `created_at` แล้ว `id` เพราะบิลหลายใบในวันเดียวกันเป็นเรื่องปกติ
 * — ถ้าไม่ผูกลำดับไว้ Postgres จะคืนมาสลับที่ได้ตามใจ plan แล้วหน้าจอจะขยับเอง
 * ระหว่าง refresh โดยไม่มีอะไรเปลี่ยน
 */
export async function listExpenses(
  groupId: string,
  options: ListExpensesOptions = {},
  db: Queryable = getPool(),
): Promise<Expense[]> {
  const values: unknown[] = [groupId]
  const conditions = ['group_id = $1']

  if (options.includeVoided !== true) {
    conditions.push(`status = 'active'`)
  }
  if (options.eventTag !== undefined) {
    values.push(options.eventTag)
    conditions.push(`event_tag = $${values.length}`)
  }

  let sql = `select * from expense
              where ${conditions.join(' and ')}
              order by spent_at desc, created_at desc, id desc`

  if (options.limit !== undefined) {
    if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
      throw new Error(`limit ต้องเป็น integer ที่มากกว่า 0 — ได้ ${options.limit}`)
    }
    values.push(options.limit)
    sql += ` limit $${values.length}`
  }

  const { rows } = await db.query<ExpenseRow>(sql, values)
  return rows.map(toExpense)
}

// ─── ยกเลิก ───────────────────────────────────────────────────────────

/**
 * มาร์กบิลว่ายกเลิก — **ไม่ลบแถว** เพราะ `lib/debt.ts` ต้องเห็นว่าเคยมีบิลใบนี้
 *
 * ไม่บันทึกว่าใครเป็นคนยกเลิก: `voided_by` เดิมชี้ `member(id)` ซึ่ง FK การันตี
 * แค่ว่าสมาชิกมีตัวตน ไม่ได้การันตีว่าอยู่วงเดียวกับบิล — และฟังก์ชันนี้ไม่รับ
 * `groupId` ผู้เรียกจึงสโคปให้เองไม่ได้ด้วย. audit ตาม D11 คือข้อความที่บอท
 * ประกาศกลับเข้ากลุ่มตอนยกเลิก ซึ่งอยู่ในสายตาทุกคนในวงอยู่แล้ว
 *
 * `where status = 'active'` ทำให้การ void ซ้ำแพ้การแข่งกันที่ DB ไม่ใช่ที่โค้ด
 * — สองคนกดยกเลิกพร้อมกันจะมีคนเดียวที่สำเร็จ
 */
export async function voidExpense(
  expenseId: string,
  db: Queryable = getPool(),
): Promise<Expense> {
  const { rows } = await db.query<ExpenseRow>(
    `update expense
        set status = 'voided', voided_at = now()
      where id = $1 and status = 'active'
      returning *`,
    [expenseId],
  )
  const row = rows[0]
  if (row) return toExpense(row)

  const existing = await db.query<{ status: string }>(
    `select status from expense where id = $1`,
    [expenseId],
  )
  if (!existing.rows[0]) {
    throw new Error(`ไม่พบบิล ${expenseId}`)
  }
  throw new Error(`บิล ${expenseId} ถูกยกเลิกไปแล้ว`)
}

/**
 * หมายเหตุถึง orchestrator: `expense_item` ไม่มีคอลัมน์ลำดับ (`position`)
 * ลำดับรายการตามที่ผู้ใช้พิมพ์จึงกู้กลับไม่ได้หลังบันทึก — ไฟล์นี้เรียงจากราคา
 * มากไปน้อยเพื่อให้ deterministic ซึ่งพอสำหรับ M2 แต่จะเป็นปัญหาตอนหน้าแก้บิล
 * แสดงรายการให้ผู้ใช้ตรวจ
 */
