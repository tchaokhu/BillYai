import type {
  ExpenseForDebt,
  MemberId,
  PairDebt,
  SettlementForDebt,
} from './types'

/**
 * ยอดสุทธิของคู่หนึ่งคู่ เก็บในทิศทางเดียวเสมอ: บวก = `loId` ติด `hiId`
 * (lo/hi ตัดสินด้วยการเรียงสตริง) — ทำให้บิลสองทางของคู่เดียวกันหักกลบกันเอง
 */
type PairNet = Map<MemberId, Map<MemberId, number>>

export function computeDebts(
  expenses: ExpenseForDebt[],
  settlements: SettlementForDebt[],
): PairDebt[] {
  const net: PairNet = new Map()

  for (const expense of expenses) {
    if (expense.voided === true) continue
    for (const share of expense.shares) {
      // share ของคนจ่ายเองไม่ใช่หนี้ — เขาไม่ได้ติดตัวเอง
      if (share.memberId === expense.payerId) continue
      addToPair(net, share.memberId, expense.payerId, share.amountSatang)
    }
  }

  for (const settlement of settlements) {
    // `claimed` คือลูกหนี้แจ้งเฉยๆ เจ้าหนี้ยังไม่ยืนยันว่าเงินเข้า จึงยังไม่หักยอด
    if (settlement.status !== 'confirmed') continue
    if (settlement.fromId === settlement.toId) continue
    addToPair(net, settlement.toId, settlement.fromId, settlement.amountSatang)
  }

  const debts: PairDebt[] = []
  for (const [loId, row] of net) {
    for (const [hiId, amount] of row) {
      // ยอดศูนย์ = เคลียร์กันพอดี ไม่ต้องคืนคู่นั้นออกไป
      if (amount === 0) continue
      debts.push(
        amount > 0
          ? { debtorId: loId, creditorId: hiId, amountSatang: amount }
          : { debtorId: hiId, creditorId: loId, amountSatang: -amount },
      )
    }
  }

  // เรียงแบบ deterministic — ผลลัพธ์ต้องไม่ขึ้นกับลำดับที่บิลเข้ามา
  debts.sort(
    (x, y) =>
      compare(x.debtorId, y.debtorId) || compare(x.creditorId, y.creditorId),
  )
  return debts
}

function compare(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** บวกยอด "debtor ติด creditor" เข้าคู่ โดย normalize ทิศทางให้เป็น lo→hi */
function addToPair(
  net: PairNet,
  debtorId: MemberId,
  creditorId: MemberId,
  amountSatang: number,
): void {
  const flipped = debtorId > creditorId
  const loId = flipped ? creditorId : debtorId
  const hiId = flipped ? debtorId : creditorId

  let row = net.get(loId)
  if (row === undefined) {
    row = new Map()
    net.set(loId, row)
  }
  row.set(hiId, (row.get(hiId) ?? 0) + (flipped ? -amountSatang : amountSatang))
}

/**
 * เงินจมของคนหนึ่งคน — ยอดรวมที่เขาควักไปก่อนแล้วยังไม่ได้คืน
 * ไม่หักยอดที่เขาติดคนอื่น เพราะเป็นคนละเรื่องกัน (ดู CONTEXT.md หัวข้อ Float)
 */
export function floatOf(debts: PairDebt[], memberId: MemberId): number {
  let total = 0
  for (const debt of debts) {
    if (debt.creditorId === memberId) total += debt.amountSatang
  }
  return total
}
