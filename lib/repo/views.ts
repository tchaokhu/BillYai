/**
 * มุมมองที่ webhook ต้องใช้ — ประกอบจาก repo หลายตัวให้จบใน call เดียว
 *
 * อยู่ที่นี่ไม่ใช่ใน route เพราะ route เป็น**สายไฟอย่างเดียว** และของที่อยู่ในนั้น
 * เทสต์ไม่ได้โดยไม่ยก Next.js ขึ้นมาทั้งตัว
 *
 * **ไม่มีสูตรหนี้ในไฟล์นี้และห้ามมี** (D25) — `computeDebts` คิดให้แล้ว ที่นี่แค่
 * โหลดแถวกับแปลง id เป็นชื่อ
 */

import { computeDebts } from '@/lib/debt'
import { buildBalance, type BalanceView } from '@/lib/flow/balance'
import type { BillDetailInput, BillListInput } from '@/lib/flow/bills'
import type { GroupView } from '@/lib/line/webhook'
import { findActiveGroupByLineGroupId, findPersonalGroupByOwner } from './groups'
import { countExpenses, findExpenseById, listExpenses } from './expenses'
import { loadLedger } from './ledger'
import { findMemberByLineUserId, listMembers } from './members'
import { findAppUserByLineUserId } from './users'
import type { LedgerGroup } from '@/lib/db/rows'

/**
 * วงที่ข้อความนี้อยู่ — `null` เมื่อยังไม่มี
 *
 * แชท 1:1 มีวงของมันเหมือนกัน: วงส่วนตัวของคนที่คุยอยู่ (D21) · ลืมข้อนี้แปลว่า
 * คนที่จดบิลใน 1:1 มาสิบใบแล้วยังถูกถามตัวตนใหม่ทุกครั้ง
 *
 * ไม่มีวง = ยังไม่มีใครกดยืนยันบิลสักใบ (D30) ซึ่งเป็นกรณีที่พบบ่อยที่สุด
 */
async function resolveGroup(
  lineGroupId: string | null,
  lineUserId: string,
): Promise<LedgerGroup | null> {
  if (lineGroupId !== null) return findActiveGroupByLineGroupId(lineGroupId)
  const owner = await findAppUserByLineUserId(lineUserId)
  return owner === null ? null : findPersonalGroupByOwner(owner.id)
}

/** ทุกอย่างที่ต้องรู้เพื่อวาดการ์ด Draft หนึ่งใบ — **อ่านอย่างเดียว** (D28) */
export async function loadGroupView(
  lineGroupId: string | null,
  lineUserId: string,
): Promise<GroupView> {
  const empty: GroupView = { roster: [], payerName: null, unclaimed: [] }
  const group = await resolveGroup(lineGroupId, lineUserId)
  if (group === null) return empty

  const members = await listMembers(group.id)
  const payer = await findMemberByLineUserId(group.id, lineUserId)
  return {
    roster: members.map((member) => member.displayName),
    payerName: payer?.displayName ?? null,
    /**
     * คนที่ถูก claim ไปแล้วไม่ใช่ตัวเลือก — เขามีเจ้าของอยู่แล้ว
     *
     * เรียง**ใหม่ก่อน** เพราะ quick reply ใส่ได้ 12 ชื่อ · คนที่กำลังจะเลือกชื่อ
     * ตัวเองมักเป็นคนที่เพิ่งถูกพิมพ์ชื่อเข้ามาในบิลไม่กี่ใบก่อนหน้า ไม่ใช่คนที่อยู่
     * ในวงมาตั้งแต่แรก · **ยังไม่แก้กรณีวงที่มีคนยังไม่ claim เกิน 12 คนได้ทั้งหมด**
     * — ดูของค้างท้าย `docs/PLAN-M6.md`
     */
    unclaimed: members
      .filter((member) => member.appUserId === null)
      .reverse()
      .map((member) => ({ id: member.id, name: member.displayName })),
  }
}

/**
 * ยอดค้างทั้งวง — `'no-bills'` เมื่อวงยังไม่มีบิลสักใบ
 *
 * แยก `'no-bills'` ออกจาก "ไม่มีใครติดใคร" เพราะสองอย่างนี้ตอบคนละแบบ: วงที่ยังไม่
 * เคยจดบิลตอบไกด์ (`DESIGN.md` §3) ส่วนวงที่เคลียร์กันหมดแล้วต้องบอกตรงๆ
 */
export async function loadBalance(
  lineGroupId: string | null,
  lineUserId: string,
): Promise<BalanceView | 'no-bills'> {
  const group = await resolveGroup(lineGroupId, lineUserId)
  if (group === null) return 'no-bills'

  const ledger = await loadLedger(group.id)
  if (ledger.expenses.length === 0) return 'no-bills'

  /**
   * **`includeLeft: true`** — คนที่ออกจากกลุ่มไปแล้วต้องยังมีชื่ออยู่ในยอด
   *
   * `member` ไม่เคยถูกลบ (D18) และ `computeDebts` ก็ยังคืนหนี้ของเขามาด้วย · ถ้า
   * name map ไม่มีชื่อเขา `buildBalance` จะข้ามแถวนั้นทิ้ง แล้วยอดจะขาดหายไปเงียบๆ
   * — ถ้าเป็นหนี้ก้อนสุดท้ายบอทจะตอบว่า "ไม่มีใครติดใครแล้ว" ทั้งที่เงินยังค้างอยู่
   */
  const members = await listMembers(group.id, { includeLeft: true })
  const names = new Map(members.map((member) => [member.id, member.displayName]))
  return buildBalance(computeDebts(ledger.expenses, ledger.settlements), names)
}

/**
 * รายการ `บิล` ตัดที่กี่ใบ (D45)
 *
 * แถวหนึ่งหนักราว 250 ไบต์และหนักคงที่เพราะไม่มีรายชื่อคน · 20 แถวราว 5 KB เหลือ
 * ที่ให้หัวและท้ายการ์ดใต้เพดาน bubble 10 KB
 */
const BILL_LIST_LIMIT = 20

/**
 * บิลล่าสุดของวงพร้อมจำนวนทั้งหมด — `'no-bills'` เมื่อยังไม่เคยจดสักใบ
 *
 * แยก `'no-bills'` ออกมาด้วยเกณฑ์เดียวกับ `loadBalance`: วงที่ยังไม่เคยใช้ต้องการ
 * วิธีใช้ ไม่ใช่รายการว่าง
 *
 * **นับทั้งหมดด้วย `countExpenses` ไม่ใช่ดึงมานับเอง** — จำนวนที่ตัดต้องบอกได้
 * (D31/D44) แต่ราคาของมันต้องไม่ใช่การขนบิลทั้งวงข้ามเน็ตทุกครั้ง
 */
export async function loadBillList(
  lineGroupId: string | null,
  lineUserId: string,
): Promise<BillListInput | 'no-bills'> {
  const group = await resolveGroup(lineGroupId, lineUserId)
  if (group === null) return 'no-bills'

  const expenses = await listExpenses(group.id, { limit: BILL_LIST_LIMIT })
  if (expenses.length === 0) return 'no-bills'

  return {
    // ลำดับมาจาก SQL แล้วพร้อม tie-break — ที่นี่แค่คัดคอลัมน์ที่การ์ดใช้
    bills: expenses.map((expense) => ({
      id: expense.id,
      description: expense.description,
      spentAt: expense.spentAt,
      totalSatang: expense.totalSatang,
    })),
    totalCount: await countExpenses(group.id),
  }
}

/**
 * บิลใบเดียวจากการกดแถวในรายการ
 *
 * **`'not-found'` ครอบทั้งบิลที่ไม่มีจริงและบิลของวงอื่น** — การแยกสองอย่างนี้ใน
 * คำตอบคือการยืนยันว่าบิลใบนั้นมีอยู่ ให้กับคนที่ไม่ได้อยู่ในวงที่มันอยู่
 *
 * ด่านเทียบวงอยู่ที่นี่ ไม่ใช่ที่ webhook · การ์ด `บิล` ลอยอยู่ในแชทได้ตลอดกาล
 * (D30 ไม่มี hard delete) และ postback data ไม่มีอะไรรับประกันว่า id ที่กลับมา
 * เป็นของวงนี้ — id เดี่ยวๆ ไม่ใช่สิทธิ์ดู
 */
export async function loadBillDetail(input: {
  expenseId: string
  lineGroupId: string | null
  lineUserId: string
}): Promise<BillDetailInput | 'not-found' | 'voided'> {
  const group = await resolveGroup(input.lineGroupId, input.lineUserId)
  if (group === null) return 'not-found'

  const detail = await findExpenseById(input.expenseId)
  if (detail === null || detail.expense.groupId !== group.id) return 'not-found'
  // เงียบไม่ได้ (อ่านออกว่าบอทพัง) และโชว์ยอดเก่าไม่ได้ (ตัวเลขผิดใน ledger)
  if (detail.expense.status === 'voided') return 'voided'

  /**
   * **`includeLeft: true`** — เหตุผลเดียวกับ `loadBalance` แต่เจ็บกว่า: แถวของคน
   * ที่ออกจากกลุ่มไปแล้วจะหายจากการ์ดเงียบๆ แล้วผลรวมรายคนที่เห็นจะไม่เท่ากับ
   * ยอดรวมที่เขียนอยู่บนใบเดียวกัน
   */
  const members = await listMembers(group.id, { includeLeft: true })
  const names = new Map(members.map((member) => [member.id, member.displayName]))

  const lines = detail.shares.map((share) => ({
    name: names.get(share.memberId) ?? '(ไม่ทราบชื่อ)',
    amountSatang: share.amountSatang,
    isPayer: share.memberId === detail.expense.payerMemberId,
  }))

  /**
   * เรียง **คนจ่ายขึ้นก่อน** แล้วยอดมากไปน้อย เท่ากันตัดสินด้วยชื่อ
   *
   * `expense_share` คืนมาเรียงตาม `member_id` ซึ่งเป็น uuid — คนอ่านไม่มีทางเดา
   * ลำดับนั้นได้ · ผลต้องไม่ขึ้นกับลำดับที่แถวถูกเขียน เกณฑ์เดียวกับการ์ด `ยอด`
   */
  lines.sort((a, b) => {
    if (a.isPayer !== b.isPayer) return a.isPayer ? -1 : 1
    if (a.amountSatang !== b.amountSatang) return b.amountSatang - a.amountSatang
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })

  return {
    description: detail.expense.description,
    spentAt: detail.expense.spentAt,
    /**
     * **ยอดที่โชว์คือผลรวมรายคน ไม่ใช่คอลัมน์ยอดบิล**
     *
     * คอลัมน์นั้นเก็บยอด**ก่อน**บวก surcharge · invariant ที่ `0001_init.sql`
     * เขียนกำกับตาราง `expense_share` ไว้บังคับให้ผลรวมรายคนเท่ากับเงินที่จ่ายจริง
     * หลังบวก surcharge แล้ว — จึงเป็นตัวเดียวที่คนอ่านการ์ดบวกเองแล้วได้ตรง
     *
     * บวกที่นี่ไม่ใช่ใน SQL ตาม D25 · การคิดเลขเงินฝั่ง SQL คือสูตรที่สองที่จะแตก
     * วันที่มีคนแก้ข้างเดียว และ `contract.db.test.ts` เฝ้าไว้อยู่
     */
    totalSatang: lines.reduce((sum, line) => sum + line.amountSatang, 0),
    lines,
  }
}
