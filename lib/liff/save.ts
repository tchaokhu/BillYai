/**
 * หน้าจอ LIFF เซฟรายการรายชิ้นกลับลง draft ใบเดิม (D57)
 *
 * **ยอดรายคนคำนวณที่นี่ ไม่ใช่รับมาจากหน้าจอ** — หน้าจอส่งมาแค่ราคาแต่ละชิ้นกับ
 * ใครกินอะไร ที่เหลือเดินผ่าน `splitExpense` ตัวเดียวกับที่แชทใช้ · รับยอดรายคน
 * จาก client แปลว่าใครก็เขียนหนี้ให้ใครเท่าไหร่ก็ได้ และตัวเลขบนการ์ดในกลุ่มจะ
 * ไม่ได้มาจากกฎการหารของระบบอีกต่อไป
 *
 * **ไม่แตะ ledger** — D30 ให้เขียนตอนกดยืนยันในแชทเท่านั้น ที่นี่เขียนแค่ `payload`
 * ของ draft แล้วปล่อยให้ postback เดิมทำงานต่อไม่เปลี่ยน
 */

import { authorizeDraft } from './authorize'
import type { AuthorizeDraftDeps, AuthorizeDraftRequest, LiffFailure } from './authorize'
import type { LiffSession } from './session'
import { splitExpense } from '@/lib/split'
import type { DraftRecord, UpdateDraftInput } from '@/lib/repo/drafts'
import type { DraftItem, DraftLine, ExpenseDraft, Item, Participant, Share } from '@/lib/types'

/** บิลที่หน้าจอส่งกลับมา — **ไม่มียอดรายคนอยู่ในนี้เลยโดยตั้งใจ** */
export interface SaveLiffDraftBill {
  /** ยอดบนใบเสร็จ รวมค่าบริการและ VAT แล้ว — ตัวตั้งเสมอ (D54) */
  paidSatang: number
  /** คนในบิลนี้ เรียงตามที่หน้าจอโชว์ */
  people: string[]
  /** ต้องเป็นหนึ่งใน `people` */
  payerName: string
  items: DraftItem[]
}

export interface SaveLiffDraftRequest extends AuthorizeDraftRequest {
  /** มาจาก JSON body — `unknown` เพราะยังไม่มีอะไรรับประกันรูป */
  bill: unknown
}

export interface SaveLiffDraftDeps extends AuthorizeDraftDeps {
  loadRoster: (draft: DraftRecord) => Promise<readonly string[]>
  updateDraft: (input: UpdateDraftInput) => Promise<DraftRecord | null>
}

export type SaveLiffDraftResult =
  | { ok: true; session: LiffSession }
  | { ok: false; reason: LiffFailure }

function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * อ่านบิลที่ส่งมาให้เป็นรูปที่เชื่อได้ — คืน `null` แทนการโยน
 *
 * ตรวจที่นี่ทั้งหมด **ก่อน** `splitExpense` เพราะ `splitExpense` โยน `Error` เมื่อ
 * อินพุตผิด ซึ่งเป็นสัญญาที่ถูกสำหรับโค้ดภายใน แต่กลายเป็น 500 เมื่อค่ามาจาก
 * เบราว์เซอร์ที่ใครก็แก้ได้
 */
function readBill(value: unknown): SaveLiffDraftBill | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>

  const { paidSatang } = record
  if (typeof paidSatang !== 'number' || !Number.isSafeInteger(paidSatang) || paidSatang <= 0) {
    return null
  }

  if (!Array.isArray(record.people)) return null
  const people: string[] = []
  for (const entry of record.people) {
    const name = nonBlank(entry)
    // ชื่อซ้ำแปลว่าสองแถวของคนเดียวกัน ซึ่ง `unique (expense_id, member_id)` ไม่ยอม
    if (name === null || people.includes(name)) return null
    people.push(name)
  }
  if (people.length === 0) return null

  const payerName = nonBlank(record.payerName)
  // คนจ่ายที่ไม่ได้อยู่ในบิลแปลว่าไม่มีใครรับเศษ และแถว `isPayer` จะหายไปจากการ์ด
  if (payerName === null || !people.includes(payerName)) return null

  if (!Array.isArray(record.items) || record.items.length === 0) return null
  const items: DraftItem[] = []
  for (const entry of record.items) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null
    const item = entry as Record<string, unknown>
    const name = nonBlank(item.name)
    if (name === null) return null
    const { amountSatang } = item
    if (typeof amountSatang !== 'number' || !Number.isSafeInteger(amountSatang)) return null
    /**
     * ราคาติดลบเป็นของส่วนปรับ ไม่ใช่ของชิ้นใดชิ้นหนึ่ง (D54) · **ศูนย์ก็ไม่ได้**
     * เพราะ `assertItems` ต้องการ `> 0` และการปล่อยผ่านแปลว่าเซฟสำเร็จแต่กด
     * ยืนยันไม่ได้ตลอด 24 ชั่วโมงที่การ์ดยังอยู่
     *
     * **ล็อกซ้ำโดยรู้ตัว** — `itemizedSubtotals` กับ `parseDraftPayload` ปฏิเสธ
     * ค่าเดียวกันอยู่แล้ว mutation test จึงลบด่านนี้ได้โดยไม่มีเทสต์แดง · เก็บไว้
     * เพราะที่นี่คือขอบเขตที่ทุกอย่างจาก client ถูกตรวจ การให้ค่าที่รับไม่ได้เดิน
     * ต่อไปพึ่ง `throw` ของโมดูลอื่นคือการวางกฎไว้ไกลจากที่มันควรอยู่
     */
    if (amountSatang <= 0) return null
    if (!Array.isArray(item.eaterNames)) return null

    const eaterNames: string[] = []
    for (const eater of item.eaterNames) {
      const eaterName = nonBlank(eater)
      // ล็อกซ้ำกับ `itemizedSubtotals` ด้วยเหตุผลเดียวกับราคาติดลบข้างบน
      if (eaterName === null || !people.includes(eaterName)) return null
      if (eaterNames.includes(eaterName)) return null
      eaterNames.push(eaterName)
    }
    items.push({ name, amountSatang, eaterNames })
  }

  return { paidSatang, people, payerName, items }
}

export async function saveLiffDraft(
  request: SaveLiffDraftRequest,
  deps: SaveLiffDraftDeps,
): Promise<SaveLiffDraftResult> {
  const authorized = await authorizeDraft(request, deps)
  if (!authorized.ok) return authorized

  const bill = readBill(request.bill)
  if (bill === null) return { ok: false, reason: 'bad-request' }

  const totalSatang = bill.items.reduce((sum, item) => sum + item.amountSatang, 0)
  // `splitExpense` ต้องการยอดก่อนส่วนปรับมากกว่า 0 — ทุกชิ้นราคาศูนย์ไม่มีอะไรให้หาร
  if (totalSatang <= 0) return { ok: false, reason: 'bad-request' }

  /**
   * **ยอดที่จ่ายจริงเป็นตัวตั้ง ส่วนปรับเป็นตัวตาม** (D54) — ห้ามกลับด้าน · ให้
   * ส่วนปรับเป็นตัวตั้งแล้วคำนวณยอดหัวย้อนกลับแปลว่าลืมจดรายการหนึ่งบรรทัดแล้ว
   * บิลลง ledger น้อยกว่าใบเสร็จโดยไม่มีอะไรส่งเสียง
   *
   * ติดลบได้ (ส่วนลด/คูปอง) · **เกณฑ์ "มีคนตั้งใจหรือไม่" ตัดสินบนหน้าจอ ไม่ใช่
   * ที่นี่** — ฝั่งนี้เห็นแต่ตัวเลขสุดท้าย แยกส่วนลดจากการจดตกไม่ได้ และการห้าม
   * ค่าติดลบทั้งหมดจะฆ่าเคสคูปองที่เป็นของจริง
   */
  const adjustmentSatang = bill.paidSatang - totalSatang

  const participants: Participant[] = bill.people.map((name) => ({ memberId: name, weight: 1 }))
  /** `eaterNames` ว่าง = ของกลาง กางเป็นทุกคนในบิล (D53) */
  const items: Item[] = bill.items.map((item) => ({
    name: item.name,
    amountSatang: item.amountSatang,
    memberIds: item.eaterNames.length > 0 ? item.eaterNames : bill.people,
  }))

  let shares: Share[]
  try {
    shares = splitExpense({
      totalSatang,
      adjustmentSatang,
      payerId: bill.payerName,
      mode: 'itemized',
      participants,
      items,
    })
  } catch {
    // `readBill` กันไว้หมดแล้ว — ด่านนี้กันกฎที่ `split.ts` เพิ่มทีหลังโดยเราไม่รู้
    return { ok: false, reason: 'bad-request' }
  }

  let roster: readonly string[]
  try {
    roster = await deps.loadRoster(authorized.record)
  } catch {
    return { ok: false, reason: 'upstream' }
  }
  /**
   * ป้าย `(ใหม่)` มาจาก Roster ของวง **ไม่ใช่จากที่ client บอก** (D28) — มันคือ
   * คำเตือนว่ากดยืนยันแล้วจะมีคนใหม่เกิดในวงถาวร (D18 ห้ามลบ Member)
   */
  const known = new Set(roster.map((name) => name.trim()))
  const amountOf = new Map(shares.map((share) => [share.memberId, share.amountSatang]))
  const lines: DraftLine[] = bill.people.map((name) => ({
    name,
    amountSatang: amountOf.get(name) ?? 0,
    /**
     * **คนจ่ายไม่ติดป้ายเลย** — กติกาเดียวกับ `buildDraft` · ป้ายนี้ถามว่า "พิมพ์
     * ชื่อผิดหรือเปล่า" ซึ่งไม่มีความหมายกับคนที่ยังไม่ถูกระบุตัวตน และแถวของเขา
     * ชื่อ `คุณ` (ADR 0002) ซึ่งไม่มีวันอยู่ใน Roster การเทียบตรงๆ จึงติดป้ายให้
     * ทุกครั้งที่เซฟ
     */
    isNew: name !== bill.payerName && !known.has(name),
    isPayer: name === bill.payerName,
  }))

  const previous = authorized.record.draft
  const base: ExpenseDraft = {
    // หน้าจอนี้แก้รายการ ไม่ได้แก้ชื่อบิลหรือป้าย event — ของเดิมต้องรอดมาครบ
    description: previous.description,
    totalSatang,
    mode: 'itemized',
    participants: bill.people.map((name) => ({ name, weight: 1 })),
    includesPayer: true,
    adjustmentSatang,
    items: bill.items,
  }
  // `exactOptionalPropertyTypes` เปิดอยู่ — คีย์ที่ไม่มีต้องไม่โผล่มาเป็น undefined
  const draft: ExpenseDraft =
    previous.eventTag === undefined ? base : { ...base, eventTag: previous.eventTag }

  let updated: DraftRecord | null
  try {
    updated = await deps.updateDraft({ id: authorized.record.id, draft, lines })
  } catch {
    return { ok: false, reason: 'upstream' }
  }
  /**
   * `null` = การ์ดถูกกดยืนยันหรือหมดอายุระหว่างที่หน้าจอเปิดค้างอยู่ · บอกว่าเซฟ
   * สำเร็จตรงนี้แปลว่าคนปิดหน้าจอไปโดยเชื่อว่าของถูกเก็บแล้ว ทั้งที่ไม่มีอะไรเหลือ
   */
  if (updated === null) return { ok: false, reason: 'draft-gone' }

  return {
    ok: true,
    session: {
      id: updated.id,
      draft: updated.draft,
      lines: updated.lines,
      spentAt: updated.spentAt,
      roster,
    },
  }
}
