/**
 * สถานะของบิลบนหน้าจอ กับเลขทั้งหมดที่หน้าจอต้องโชว์ — **แยกจาก React โดยตั้งใจ**
 *
 * ทุกอย่างในไฟล์นี้เป็นฟังก์ชันบริสุทธิ์ จึงเทสต์ได้โดยไม่ต้อง render อะไรเลย และ
 * กฎที่เดาผิดได้ (VAT ทบบน service charge · เกณฑ์ว่าบิลใบนี้เซฟได้หรือยัง) ถูกคุม
 * ด้วยเทสต์แทนที่จะฝังอยู่ใน JSX
 *
 * **ยอดรายคนใช้ `splitExpense` ตัวเดียวกับฝั่ง server** — ไม่ได้เขียนเลขซ้ำสองที่
 * `lib/split.ts` เป็น TypeScript บริสุทธิ์ ไม่แตะ node จึงรันบนเบราว์เซอร์ได้ตรงๆ ·
 * ตัวเลขที่นี่เป็นแค่ภาพตัวอย่าง ของจริงคือสิ่งที่ `POST /api/liff/draft` คำนวณ
 * แล้วส่งกลับมา
 */

import { PAYER_KEY } from '@/lib/flow/draft'
import { splitExpense } from '@/lib/split'
import type { DraftItem, DraftLine, Share } from '@/lib/types'

/**
 * คนจ่ายของ draft ใบนี้ — **อ่านจากแถว ไม่ใช่เดาจากลำดับ**
 *
 * `null` = คนพิมพ์จ่ายแทนล้วน ไม่ได้อยู่ในบิล (`+ ข้าว 1200 กอล์ฟ ตูน` ที่ไม่มี
 * `รวมฉัน`) ซึ่งเป็น draft ที่ถูกต้องและไม่มีแถวไหน `isPayer` เลย · ตกไปที่คนแรก
 * ในลิสต์แปลว่าติดป้ายผิดคน แล้ว `commitExpense` จะยัด `payerMemberId` ให้แถวนั้น
 * จนคนนั้นหายจากบิลทั้งคน
 */
export function payerOf(lines: readonly DraftLine[]): string | null {
  return lines.find((line) => line.isPayer)?.name ?? null
}

/**
 * ชื่อนี้วงยังไม่รู้จัก — ป้าย `(ใหม่)` (D28) · **กติกาเดียวกับ `saveLiffDraft`**
 *
 * **คนจ่ายไม่ติดป้ายเลย** — ป้ายนี้ถามว่า "พิมพ์ชื่อผิดหรือเปล่า" ซึ่งไม่มีความหมาย
 * กับคนที่ยังไม่ถูกระบุตัวตน และแถวของเขาชื่อ `คุณ` (ADR 0002) ซึ่งไม่มีวันอยู่ใน
 * Roster · หน้าจอกับ server ต้องตอบเหมือนกัน ไม่งั้นป้ายจะหายตอนกดเซฟ
 */
export function isNewName(
  name: string,
  payerName: string | null,
  roster: readonly string[],
): boolean {
  return name !== payerName && !roster.some((known) => known.trim() === name.trim())
}

/** เปอร์เซ็นต์เก็บเป็นทศนิยมสองตำแหน่ง — `10.5%` = `1050` ไม่มี float ที่ไหน */
export const PCT_SCALE = 100

/**
 * ส่วนปรับมาจากไหน (D54) — **ยอดที่จ่ายจริงเป็นตัวตั้งทุกโหมด**
 *
 * `auto` ส่วนต่าง `ยอดที่จ่ายจริง − รวมรายชิ้น` · `rates` ติ๊ก % แล้วคิดให้ ขยับ
 * ตามเมื่อรายการเปลี่ยน · `amount` เลขที่พิมพ์ ตายตัว
 *
 * สองโหมดหลังทำให้ยอดหัวกลายเป็น**ตัวทาน**: ลืมจดรายการแล้วผลบวกไม่ถึงยอดหัว
 * จึงยังจับได้ · ติ๊กออกหมด = กลับโหมด `auto` ไม่มีสถานะที่สี่
 */
export type AdjustmentMode = 'auto' | 'rates' | 'amount'

export interface BillState {
  /** ยอดบนใบเสร็จ รวมค่าบริการและ VAT แล้ว */
  paidSatang: number
  people: string[]
  /** `null` = คนจ่ายไม่ได้อยู่ในบิล — ดู `payerOf` */
  payerName: string | null
  items: DraftItem[]
  mode: AdjustmentMode
  svcOn: boolean
  vatOn: boolean
  svcPct: number
  vatPct: number
  typedAdjustmentSatang: number
}

export interface BillTotals {
  sumItemsSatang: number
  serviceSatang: number
  vatSatang: number
  adjustmentSatang: number
  /**
   * `ยอดที่จ่ายจริง − ส่วนปรับ − รวมรายชิ้น` — ต้องเป็น 0 ในโหมด `rates`/`amount`
   * ไม่เป็นศูนย์แปลว่ามีรายการที่ยังไม่ได้จด หรือยอดหัวพิมพ์ผิด
   */
  driftSatang: number
  /** เซฟไม่ได้จนกว่าจะแก้ — หน้าจอต้องบอกด้วยว่าเพราะอะไร */
  blocked: boolean
  shares: Share[]
}

/**
 * ปัดครึ่งขึ้นบนขนาด integer — เปอร์เซ็นต์เป็นเครื่องคิดเลขบนจอ ไม่ได้เก็บลง DB
 * (D54) · ทำบน integer ตลอดทางเพื่อไม่ให้เศษหล่นระหว่างปัดสองครั้ง
 */
export function scaleRound(numerator: number, denominator: number): number {
  const sign = numerator < 0 ? -1 : 1
  return sign * Math.floor((2 * Math.abs(numerator) + denominator) / (2 * denominator))
}

/** `eaterNames` ว่าง = ของกลาง หารกับทุกคนในบิล (D53) */
export function eatersOf(item: DraftItem, people: readonly string[]): string[] {
  return item.eaterNames.length > 0 ? item.eaterNames : [...people]
}

export function totalsOf(bill: BillState): BillTotals {
  const sumItemsSatang = bill.items.reduce((sum, item) => sum + item.amountSatang, 0)

  /**
   * **ทบกัน ไม่ใช่บวกกัน** — ร้านคิด service charge บนราคาอาหารก่อน แล้ว VAT คิดบน
   * `ราคาอาหาร + service charge` · 10% แล้ว 7% จึงเป็น **17.7% ไม่ใช่ 17%** ·
   * กฎนี้คือกฎเดียวในหน้าจอที่คนอ่านโค้ดเดาผิดได้ จึงต้องมีเทสต์คุม (D54)
   */
  const serviceSatang =
    bill.mode === 'rates' && bill.svcOn
      ? scaleRound(sumItemsSatang * bill.svcPct, 100 * PCT_SCALE)
      : 0
  const vatSatang =
    bill.mode === 'rates' && bill.vatOn
      ? scaleRound((sumItemsSatang + serviceSatang) * bill.vatPct, 100 * PCT_SCALE)
      : 0

  const adjustmentSatang =
    bill.mode === 'auto'
      ? bill.paidSatang - sumItemsSatang
      : bill.mode === 'rates'
        ? serviceSatang + vatSatang
        : bill.typedAdjustmentSatang

  const driftSatang =
    bill.mode === 'auto' ? 0 : bill.paidSatang - adjustmentSatang - sumItemsSatang

  /**
   * **ค่าติดลบที่ระบบคำนวณเองคือการจดตก ไม่ใช่ส่วนลด** (D54) — เกณฑ์คือมีคนตั้งใจ
   * พิมพ์หรือไม่ ไม่ใช่เครื่องหมายของตัวเลข · โหมด `rates`/`amount` มีคนตั้งใจแล้ว
   * จึงติดลบได้ ส่วน `auto` ติดลบแปลว่ายอดหัวน้อยกว่าที่จดไว้ ซึ่งต้องแก้ก่อน
   */
  const blocked =
    bill.items.length === 0 ||
    bill.people.length === 0 ||
    sumItemsSatang <= 0 ||
    // `assertItems` ต้องการราคา `> 0` ทุกชิ้น — "น้ำเปล่า ฟรี" ต้องลบบรรทัดทิ้ง
    // ไม่ใช่จดเป็น 0 · ปล่อยผ่านแปลว่าปุ่มยืนยันในแชท 500 วนซ้ำไม่รู้จบ
    bill.items.some((item) => item.amountSatang <= 0) ||
    bill.paidSatang <= 0 ||
    driftSatang !== 0 ||
    (bill.mode === 'auto' && adjustmentSatang < 0)

  let shares: Share[] = []
  if (!blocked) {
    try {
      shares = splitExpense({
        totalSatang: sumItemsSatang,
        adjustmentSatang,
        // ไม่มีคนจ่ายในบิล = ไม่มีตัวตัดสินเศษ ซึ่ง `splitExpense` รับได้
        payerId: bill.payerName ?? PAYER_KEY,
        mode: 'itemized',
        participants: bill.people.map((name) => ({ memberId: name, weight: 1 })),
        items: bill.items.map((item) => ({
          name: item.name,
          amountSatang: item.amountSatang,
          memberIds: eatersOf(item, bill.people),
        })),
      })
    } catch {
      // ตัวอย่างบนจอวาดไม่ได้ก็แค่ไม่โชว์ — ของจริงคือคำตอบจาก server
      shares = []
    }
  }

  return { sumItemsSatang, serviceSatang, vatSatang, adjustmentSatang, driftSatang, blocked, shares }
}

/**
 * อ่านตัวเลขที่คนพิมพ์เป็นสตางค์ — `null` เมื่ออ่านไม่ออก
 *
 * รับคอมมาหลักพันเพราะคนก๊อปตัวเลขจากที่อื่นมาวาง · ทศนิยมได้ไม่เกินสองตำแหน่ง
 * เพราะสตางค์ไม่มีย่อยกว่านั้น
 */
export function parseSatang(text: string, allowNegative = false): number | null {
  const match = text.trim().replace(/,/g, '').match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/)
  if (match === null) return null
  const sign = match[1] === '-' ? -1 : 1
  if (sign < 0 && !allowNegative) return null
  const baht = Number(match[2])
  const frac = Number((match[3] ?? '0').padEnd(2, '0'))
  return sign * (baht * 100 + frac)
}

/**
 * ชื่อใหม่ที่คล้ายของเดิม — **เตือน ไม่ห้าม** (D55)
 *
 * `unique (group_id, display_name)` บวก D18 (ห้ามลบ Member) แปลว่าชื่อที่พิมพ์ผิด
 * จองสลอตไว้ถาวร · แต่ห้ามสร้างไม่ได้เพราะ `โจ้` กับ `โจ` เป็นคนละคนได้จริง
 *
 * คืนชื่อที่ใกล้ที่สุดที่เจอ หรือ `null` เมื่อไม่คล้ายใครเลย
 */
export function similarName(candidate: string, known: readonly string[]): string | null {
  const name = candidate.trim()
  if (name === '') return null
  for (const other of known) {
    const existing = other.trim()
    if (existing === name) continue
    if (existing.toLowerCase() === name.toLowerCase()) return other
    if (editDistanceAtMostOne(name, existing)) return other
  }
  return null
}

/** ต่างกันไม่เกินหนึ่งตัวอักษร — พอสำหรับวรรณยุกต์หายกับตัวสะกดเกิน */
function editDistanceAtMostOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
      continue
    }
    if (++edits > 1) return false
    if (a.length > b.length) i++
    else if (a.length < b.length) j++
    else {
      i++
      j++
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1
}
