/**
 * แปลงผลของ parser + Roster เป็นเนื้อหาของการ์ด Draft — **ฟังก์ชันบริสุทธิ์**
 *
 * ไม่รู้จัก LINE ไม่รู้จัก DB (§6) · การอ่าน Roster เป็นงานของผู้เรียก
 *
 * **อ่านตอน draft เขียนตอนยืนยัน** (D28) — ไฟล์นี้อยู่ฝั่ง "อ่าน" ทั้งหมด: มันดู
 * ว่าชื่อไหนวงรู้จักแล้วเพื่อติดป้าย `(ใหม่)` แต่ไม่สร้าง Member ให้ใครทั้งนั้น
 *
 * ยอดคิดด้วย `splitExpense` ตัวเดียวกับที่ `commitExpense` ใช้ — **ยอดบนการ์ดกับ
 * ยอดที่ลง ledger ต้องเป็นเลขชุดเดียวกัน** เพราะคนกดยืนยันจากตัวเลขที่เห็น
 */

import { splitExpense } from '../split'
import type { ExpenseDraft, Participant } from '../types'

/**
 * ชื่อที่ใช้แทนคนพิมพ์บนการ์ด — ตอน draft เรายังไม่รู้ว่าเขาคือ Member ตัวไหน
 * และ ADR 0002 ตัดสินว่าจะถามบนการ์ดใบแรกของเขา ไม่ใช่เดาจากชื่อ LINE
 */
export const PAYER_LABEL = 'คุณ'

/**
 * คีย์ภายในของคนพิมพ์ — ไม่ใช่ `PAYER_LABEL` เพราะในวงอาจมีคนชื่อ "คุณ" จริง
 * แล้วสองแถวจะยุบรวมกันเงียบๆ
 *
 * ขึ้นต้นด้วยช่องว่างโดยตั้งใจ: ชื่อทุกชื่อถูก trim ก่อนเทียบ ค่านี้จึงไม่มีทาง
 * เท่ากับชื่อของใครได้เลย
 */
const PAYER_KEY = ' payer'

export interface DraftLine {
  name: string
  amountSatang: number
  /** ชื่อนี้วงยังไม่รู้จัก — ป้าย `(ใหม่)` บนการ์ด (D28) */
  isNew: boolean
}

export interface DraftCard {
  description: string
  eventTag?: string
  /** ยอดรวมหลังบวก surcharge — ต้องเท่ากับผลรวมของทุกแถวเป๊ะ */
  totalSatang: number
  lines: DraftLine[]
}

export type DraftOutcome =
  | { kind: 'card'; card: DraftCard }
  /**
   * ไม่ระบุชื่อใครเลยในวงที่ Roster ยังว่าง
   *
   * ไวยากรณ์แปลว่า "หารทุกคนใน Roster" — Roster ว่างจึงไม่มีใครให้หาร · การ์ดที่มี
   * แต่คนจ่ายคนเดียวคือบิลที่ไม่มีหนี้อยู่ในนั้น กดยืนยันแล้วไม่ได้อะไร
   */
  | { kind: 'need-names' }

/**
 * @param payerName ชื่อ Member ของคนพิมพ์ในวงนี้ · `null` = เขายังไม่เคยยืนยันตัวตน
 *   จึงยังไม่มีชื่ออยู่ใน Roster และการ์ดต้องเรียกเขาว่า `คุณ` ไปก่อน (ADR 0002)
 */
export function buildDraft(
  draft: ExpenseDraft,
  roster: readonly string[],
  payerName: string | null,
): DraftOutcome {
  const known = new Set(roster.map((name) => name.trim()))

  // ชื่อที่พิมพ์มาอาจมีช่องว่างติดมา — เทียบกับ Roster หลัง trim ทั้งสองฝั่ง
  const named = draft.participants.map((p) => ({ ...p, name: p.name.trim() }))

  const participants: Participant[] = []
  const lines: Array<Omit<DraftLine, 'amountSatang'> & { key: string }> = []

  if (named.length === 0) {
    /**
     * "หารเท่าทุกคน" — **คนจ่ายนับเป็นหนึ่งในนั้นเสมอ**
     *
     * คนที่ยืนยันตัวตนแล้วมีชื่ออยู่ใน Roster ไปเรียบร้อย จึงไม่ต้องเพิ่มแถวซ้ำ
     * ส่วนคนที่ยังไม่ยืนยันได้แถวของตัวเองในนาม `คุณ` — เขาก็กินด้วย การตัดเขา
     * ออกเพราะยังไม่ได้ claim คือให้คำตอบที่ผิดด้วยเหตุผลทางเทคนิคล้วนๆ
     *
     * นี่ยังเป็นตัวที่ทำให้ `รวมฉัน` ไม่กลายเป็นคำที่ไม่มีผล: parser ยุบ
     * `+ ข้าว 1200` กับ `+ ข้าว 1200 รวมฉัน` เป็น draft เดียวกัน ทั้งคู่จึงต้อง
     * ให้ผลเดียวกันที่ "รวมคนจ่าย" ไม่ใช่ "ไม่รวม"
     */
    if (known.size === 0) return { kind: 'need-names' }
    for (const name of known) {
      participants.push({ memberId: name, weight: 1 })
      lines.push({ key: name, name, isNew: false })
    }
    if (payerName === null) {
      participants.push({ memberId: PAYER_KEY, weight: 1 })
      lines.push({ key: PAYER_KEY, name: PAYER_LABEL, isNew: false })
    }
  } else {
    for (const participant of named) {
      participants.push({ memberId: participant.name, weight: participant.weight })
      lines.push({
        key: participant.name,
        name: participant.name,
        isNew: !known.has(participant.name),
      })
    }
    if (draft.includesPayer) {
      participants.push({ memberId: PAYER_KEY, weight: 1 })
      // ไม่ติดป้าย `(ใหม่)` ให้คนพิมพ์ — ป้ายนั้นมีไว้เตือนว่า "พิมพ์ชื่อผิดหรือเปล่า"
      // ซึ่งไม่ใช่คำถามที่ตอบได้ตอนยังไม่รู้ว่าเขาคือใครในวง
      lines.push({ key: PAYER_KEY, name: payerName ?? PAYER_LABEL, isNew: false })
    }
  }

  const shares = splitExpense({
    totalSatang: draft.totalSatang,
    surchargePct: draft.surchargePct,
    payerId: PAYER_KEY,
    mode: draft.mode,
    participants,
  })

  const amountOf = new Map(shares.map((share) => [share.memberId, share.amountSatang]))
  const cardLines: DraftLine[] = lines.map((line) => ({
    name: line.name,
    amountSatang: amountOf.get(line.key) ?? 0,
    isNew: line.isNew,
  }))

  const card: DraftCard = {
    description: draft.description,
    totalSatang: cardLines.reduce((total, line) => total + line.amountSatang, 0),
    lines: cardLines,
  }

  // `exactOptionalPropertyTypes` เปิดอยู่ — คีย์ที่ไม่มีต้องไม่โผล่มาเป็น undefined
  return draft.eventTag === undefined
    ? { kind: 'card', card }
    : { kind: 'card', card: { ...card, eventTag: draft.eventTag } }
}
