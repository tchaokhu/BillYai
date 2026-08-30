/**
 * จัดผลของ `computeDebts` ให้เป็นเนื้อหาการ์ด `ยอด` — **ฟังก์ชันบริสุทธิ์**
 *
 * ไม่มีสูตรหนี้อยู่ในไฟล์นี้และห้ามมี (D25) — `lib/debt.ts` คิดมาให้แล้ว ที่นี่แค่
 * เรียงกับจัดกลุ่ม
 *
 * **จัดกลุ่มตามเจ้าหนี้** (D31) เพราะคนที่พิมพ์ `ยอด` คือคนที่ควักเงินไปก่อนแล้ว
 * อยากรู้ว่าใครยังไม่จ่าย — เขาหาชื่อตัวเองในหัวบล็อกแล้วอ่านจบในที่เดียว ส่วนการ
 * จัดกลุ่มตามลูกหนี้บังคับให้ไล่อ่านทุกบล็อกเพื่อเก็บชื่อตัวเอง
 */

import type { MemberId, PairDebt } from '../types'

export interface BalanceRow {
  debtorName: string
  amountSatang: number
}

export interface BalanceBlock {
  creditorName: string
  /** ยอดรวมที่เจ้าหนี้คนนี้ได้คืน — ตัวเลขที่คนควักเงินอยากรู้ก่อนตัวเลขรายคน */
  totalSatang: number
  rows: BalanceRow[]
}

export type BalanceView =
  | { kind: 'debts'; blocks: BalanceBlock[] }
  /** มีบิลแล้วแต่ไม่มีใครติดใคร — คนละเรื่องกับวงที่ยังไม่เคยจดบิล */
  | { kind: 'settled' }

/** เรียงชื่อด้วย code unit ไม่ใช่ `localeCompare` — ต้องการผลที่เหมือนกันทุกเครื่อง */
function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function buildBalance(
  debts: readonly PairDebt[],
  names: ReadonlyMap<MemberId, string>,
): BalanceView {
  const blocks = new Map<string, BalanceRow[]>()

  for (const debt of debts) {
    if (debt.amountSatang <= 0) continue
    const creditorName = names.get(debt.creditorId)
    const debtorName = names.get(debt.debtorId)
    // ชื่อที่หาไม่เจอแปลว่าข้อมูลไม่ครบ — โชว์ id ดิบคือขยะที่คนอ่านไม่รู้เรื่อง
    // และเป็นข้อมูลภายในที่ไม่ควรหลุดออกไปในแชท
    if (creditorName === undefined || debtorName === undefined) continue

    const rows = blocks.get(creditorName)
    if (rows === undefined) blocks.set(creditorName, [{ debtorName, amountSatang: debt.amountSatang }])
    else rows.push({ debtorName, amountSatang: debt.amountSatang })
  }

  if (blocks.size === 0) return { kind: 'settled' }

  const ordered: BalanceBlock[] = [...blocks].map(([creditorName, rows]) => ({
    creditorName,
    totalSatang: rows.reduce((sum, row) => sum + row.amountSatang, 0),
    // ยอดเท่ากันตัดสินด้วยชื่อ — ผลต้องไม่ขึ้นกับลำดับที่บิลเข้ามา
    rows: [...rows].sort(
      (a, b) => b.amountSatang - a.amountSatang || byName(a.debtorName, b.debtorName),
    ),
  }))

  ordered.sort((a, b) => b.totalSatang - a.totalSatang || byName(a.creditorName, b.creditorName))
  return { kind: 'debts', blocks: ordered }
}
