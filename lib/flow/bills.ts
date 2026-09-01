/**
 * จัดผลจาก repo ให้เป็นเนื้อการ์ด `บิล` — **ฟังก์ชันบริสุทธิ์** (D45)
 *
 * ไฟล์นี้ไม่รู้จัก LINE และไม่แตะ DB · หน้าที่มีสองอย่าง: แปลงวันที่ให้อ่านออก
 * และนับว่ามีบิลที่ไม่ได้แสดงกี่ใบ
 *
 * **ไม่มีสูตรหนี้ที่นี่และห้ามมี (D25)** — การ์ดนี้เล่าว่า *เกิดอะไรขึ้น* ไม่ใช่
 * *ใครยังค้างเท่าไหร่* ซึ่งเป็นงานของ `ยอด` · และมันพูดเรื่องนั้นไม่ได้ด้วย
 * เพราะ `settlement` ไม่ได้ชี้ว่าจ่ายบิลใบไหน คำว่า "บิลใบนี้ยังไม่ถูกจ่าย"
 * จึงไม่มีอยู่ในระบบเลย (D33)
 */

import { thaiShortDate } from '../time'

/** บิลหนึ่งใบเท่าที่รายการต้องรู้ — **ไม่มีรายชื่อคน** เพื่อให้แถวหนักคงที่ */
export interface BillSummary {
  id: string
  description: string
  /** `spent_at` รูป `'YYYY-MM-DD'` ตามที่เก็บใน DB */
  spentAt: string
  totalSatang: number
}

export interface BillListInput {
  /** เรียงใหม่→เก่ามาแล้วจาก SQL และตัดตาม limit มาแล้ว */
  bills: readonly BillSummary[]
  /** จำนวนบิลทั้งหมดในวง ไม่ใช่จำนวนที่ส่งมา */
  totalCount: number
}

export interface BillRow {
  /** `expense.id` — เป็นของที่ postback พาไป ไม่ใช่ชื่อ (ADR 0002) */
  id: string
  description: string
  /** วันที่พร้อมแสดง เช่น `1 ก.ย. 69` */
  date: string
  totalSatang: number
}

export type BillListView =
  /** ยังไม่เคยจดบิลสักใบ — คนละเรื่องกับวงที่มีบิลแล้ว */
  | { kind: 'no-bills' }
  | { kind: 'bills'; rows: BillRow[]; omitted: number }

export function buildBillList(input: BillListInput): BillListView {
  if (input.bills.length === 0) return { kind: 'no-bills' }

  const rows: BillRow[] = input.bills.map((bill) => ({
    id: bill.id,
    description: bill.description,
    date: thaiShortDate(bill.spentAt),
    totalSatang: bill.totalSatang,
  }))

  /**
   * **ไม่เรียงใหม่ที่นี่** — ลำดับผูกไว้ที่ SQL แล้วพร้อม tie-break (`spent_at`,
   * `created_at`, `id`) · เรียงซ้ำคือมีสองแหล่งความจริงเรื่องลำดับ ซึ่งจะเพี้ยน
   * กันวันใดวันหนึ่งโดยไม่มีใครสังเกต
   *
   * จำนวนที่ตัดต้องบอก ห้ามเงียบ (D31/D44) · `Math.max` กันค่าติดลบซึ่งเกิดได้จริง
   * เมื่อมีคนจดบิลใหม่คั่นระหว่างสอง query
   */
  return { kind: 'bills', rows, omitted: Math.max(0, input.totalCount - rows.length) }
}

export interface BillDetailLine {
  name: string
  amountSatang: number
  isPayer: boolean
}

export interface BillDetailInput {
  description: string
  spentAt: string
  totalSatang: number
  lines: readonly BillDetailLine[]
}

export interface BillDetailView {
  description: string
  date: string
  totalSatang: number
  lines: BillDetailLine[]
}

/**
 * บิลใบเดียวพร้อมรายคน — **คัดลอกตัวเลขมาตรงๆ ไม่คิดใหม่**
 *
 * ยอดที่โชว์ต้องเป็นตัวเดียวกับที่ลง `expense_share` ไว้ · การ์ดที่คำนวณเองจะเริ่ม
 * เพี้ยนจาก ledger ในวันที่สูตรสองฝั่งไม่ตรงกัน แล้วไม่มีใครรู้ว่าฝั่งไหนผิด
 */
export function buildBillDetail(input: BillDetailInput): BillDetailView {
  return {
    description: input.description,
    date: thaiShortDate(input.spentAt),
    totalSatang: input.totalSatang,
    lines: input.lines.map((line) => ({ ...line })),
  }
}
