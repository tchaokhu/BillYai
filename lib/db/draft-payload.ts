/**
 * ตรวจ payload ของ `expense_draft` ตอนอ่านกลับ — **ไม่ใช่ `as ExpenseDraft`**
 *
 * ADR 0001 เลือกเก็บ draft เป็น `jsonb` ก้อนเดียวเพราะไม่มีใคร query ตามเนื้อใน
 * ราคาที่ต้องจ่ายคือแถวนี้: payload ที่เขียนด้วยโค้ดเวอร์ชันก่อนหน้ายังนอนอยู่ใน
 * ตารางได้ถึง 24 ชั่วโมงหลัง deploy ซึ่งเป็นหน้าต่างที่ยาวพอจะเจอจริง
 *
 * **คืน `null` ไม่ throw** — payload ที่อ่านไม่ออกต้องถูกปฏิบัติเหมือน draft ที่
 * หมดอายุ (ตอบว่าการ์ดเก่าแล้ว ให้พิมพ์ใหม่) การ throw จะพาขึ้นไปถึง webhook แล้ว
 * ทำให้ event ทั้งชุดพัง เพราะการ์ดใบเดียวที่เก่าเกินไป
 */

import { isSupportedWeight } from '@/lib/money'
import type { DraftItem, DraftLine, DraftParticipant, ExpenseDraft, SplitMode } from '@/lib/types'

const SPLIT_MODES: ReadonlySet<SplitMode> = new Set<SplitMode>([
  'equal',
  'exact',
  'share',
  'itemized',
])

function isSplitMode(value: unknown): value is SplitMode {
  return SPLIT_MODES.has(value as SplitMode)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** ชื่อที่เหลือแต่ช่องว่างใช้ไม่ได้ — `member_display_name_check` ปฏิเสธอยู่แล้ว */
function nonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function participantsOf(value: unknown): DraftParticipant[] | null {
  if (!Array.isArray(value)) return null

  const participants: DraftParticipant[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    if (record === null) return null
    const name = nonBlankString(record.name)
    if (name === null) return null
    const { weight } = record
    // ต้องเป็นช่วงเดียวกับที่ `distribute` รองรับจริง ไม่ใช่แค่ "มากกว่าศูนย์" —
    // ไม่งั้น payload ที่เขียนลงตารางได้วันนี้จะคำนวณไม่ได้ตอน commit ใน M6
    if (typeof weight !== 'number' || !isSupportedWeight(weight)) return null
    participants.push({ name, weight })
  }
  return participants
}

/**
 * รายการรายชิ้นที่หน้าจอ LIFF เซฟกลับมา (D48)
 *
 * **ราคาติดลบไม่ได้** ต่างจากส่วนปรับซึ่งติดลบได้เมื่อมีคนตั้งใจใส่ (D54) — ส่วนลด
 * เป็นของทั้งบิล ไม่ใช่ของชิ้นใดชิ้นหนึ่ง และ `itemizedSubtotals` โยนทิ้งอยู่แล้ว
 *
 * **`eaterNames` ว่างได้** = ของกลาง (D53) · ชื่อซ้ำในรายการเดียวไม่ได้ เพราะ
 * `itemizedSubtotals` นับว่าเป็นความผิดพลาดของผู้เรียก ไม่ใช่การกินสองที่
 */
function itemsOf(value: unknown): DraftItem[] | null {
  if (!Array.isArray(value) || value.length === 0) return null

  const items: DraftItem[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    if (record === null) return null
    const name = nonBlankString(record.name)
    if (name === null) return null
    const { amountSatang, eaterNames } = record
    /**
     * **ต้อง `> 0`** — ตรงกับ `assertItems` ใน `expenses.ts` · ยอมรับศูนย์ที่นี่
     * แปลว่า payload ที่เขียนลงตารางได้วันนี้ commit ไม่ได้ตอนกดยืนยัน แล้วเส้น
     * webhook ตอบ 500 ซึ่ง LINE ยิง postback เดิมกลับมาไม่รู้จบโดยคนกดไม่ได้
     * คำตอบสักครั้ง · "น้ำเปล่า ฟรี" ต้องเป็นบรรทัดที่ไม่มี ไม่ใช่บรรทัดราคา 0
     */
    if (typeof amountSatang !== 'number' || !Number.isSafeInteger(amountSatang)) return null
    if (amountSatang <= 0) return null
    if (!Array.isArray(eaterNames)) return null

    const eaters: string[] = []
    const seen = new Set<string>()
    for (const eater of eaterNames) {
      const eaterName = nonBlankString(eater)
      if (eaterName === null || seen.has(eaterName)) return null
      seen.add(eaterName)
      eaters.push(eaterName)
    }
    items.push({ name, amountSatang, eaterNames: eaters })
  }
  return items
}

/**
 * สิ่งที่เก็บจริงในคอลัมน์ `payload`
 *
 * มีสองส่วนเพราะแยกคนละหน้าที่: `draft` คือสิ่งที่ parser อ่านได้จากข้อความ ส่วน
 * `lines` คือ**ผลหารที่คำนวณเสร็จแล้ว** ซึ่งเป็นตัวเลขชุดเดียวกับที่คนเห็นบนการ์ด
 *
 * เก็บ `lines` ไว้ด้วยเพราะ Roster โตได้ระหว่างที่การ์ดค้างอยู่ในแชทได้ถึง 24 ชั่วโมง
 * ถ้าตอนกดยืนยันคำนวณใหม่จาก Roster ณ ตอนนั้น คนจะกดจากตัวเลขหนึ่งแล้วได้อีกตัวเลข
 * ลง ledger — ซึ่งเป็นความผิดพลาดประเภทที่ ledger รับไม่ได้
 */
export interface StoredDraft {
  draft: ExpenseDraft
  lines: DraftLine[]
}

function linesOf(value: unknown): DraftLine[] | null {
  if (!Array.isArray(value) || value.length === 0) return null

  const lines: DraftLine[] = []
  let payers = 0
  for (const entry of value) {
    const record = asRecord(entry)
    if (record === null) return null
    const name = nonBlankString(record.name)
    if (name === null) return null
    const { amountSatang, isNew, isPayer } = record
    if (typeof amountSatang !== 'number' || !Number.isSafeInteger(amountSatang)) return null
    if (amountSatang < 0) return null
    if (typeof isNew !== 'boolean' || typeof isPayer !== 'boolean') return null
    if (isPayer) payers++
    lines.push({ name, amountSatang, isNew, isPayer })
  }
  // บิลหนึ่งใบมีคนจ่ายคนเดียว (`CONTEXT.md` หัวข้อ Payer) — สองแถวแปลว่า payload เพี้ยน
  if (payers > 1) return null
  return lines
}

export function parseStoredDraft(value: unknown): StoredDraft | null {
  const payload = asRecord(value)
  if (payload === null) return null
  const draft = parseDraftPayload(payload.draft)
  if (draft === null) return null
  const lines = linesOf(payload.lines)
  if (lines === null) return null

  /**
   * **ชื่อคนกินต้องอยู่ในแถวของการ์ด** — invariant ข้ามสองส่วนของ payload ซึ่งมี
   * ที่ตรวจได้ที่เดียวคือตรงนี้ (`parseDraftPayload` เห็นแค่ครึ่งเดียว)
   *
   * ปล่อยผ่านแล้วมันไปโผล่ใน `confirmDraft` **หลัง** `deleteDraft` ไปแล้ว และการ
   * `return` ตรงนั้นจะ commit การลบ = การ์ดหายทั้งที่บิลไม่ได้ลง ซึ่งเป็นกับดักที่
   * หัวไฟล์ `lib/repo/confirm.ts` เตือนไว้เอง · จับที่นี่แปลว่า draft แบบนี้เขียน
   * ลงตารางไม่ได้ตั้งแต่แรก
   *
   * ของกลาง (`eaterNames` ว่าง) ไม่ได้อ้างใคร จึงไม่มีอะไรให้ผิด (D53)
   */
  const onCard = new Set(lines.map((line) => line.name.trim()))
  for (const item of draft.items ?? []) {
    for (const eaterName of item.eaterNames) {
      if (!onCard.has(eaterName.trim())) return null
    }
  }

  return { draft, lines }
}

export function parseDraftPayload(value: unknown): ExpenseDraft | null {
  const payload = asRecord(value)
  if (payload === null) return null

  const description = nonBlankString(payload.description)
  if (description === null) return null

  const { totalSatang, mode, includesPayer, adjustmentSatang } = payload
  if (typeof totalSatang !== 'number' || !Number.isSafeInteger(totalSatang) || totalSatang <= 0) {
    return null
  }
  if (!isSplitMode(mode)) return null
  if (typeof includesPayer !== 'boolean') return null
  // ติดลบได้ (ส่วนลด · D54) แต่ต้องเป็นสตางค์เต็มจำนวน และลดจนบิลไม่เหลือค่าไม่ได้
  if (
    typeof adjustmentSatang !== 'number' ||
    !Number.isSafeInteger(adjustmentSatang) ||
    // ผลบวกต้องอยู่ในช่วงด้วย ไม่ใช่แค่สองตัวตั้ง — ไม่งั้น `addAdjustment` จะ throw
    // ขึ้นไปถึง webhook ซึ่งเป็นสิ่งเดียวที่ไฟล์นี้มีไว้กัน
    !Number.isSafeInteger(totalSatang + adjustmentSatang) ||
    totalSatang + adjustmentSatang <= 0
  ) {
    return null
  }

  const participants = participantsOf(payload.participants)
  if (participants === null) return null

  /**
   * **`items` ผูกกับโหมด `itemized` สองทาง** — `assertItems` ใน `expenses.ts`
   * โยนทั้งสองทิศ ปล่อยผ่านที่นี่แปลว่าไปพังตอน commit ซึ่งคือ 500 กลางการกดปุ่ม
   */
  const hasItems = 'items' in payload && payload.items !== undefined
  if ((mode === 'itemized') !== hasItems) return null

  let items: DraftItem[] | null = null
  if (hasItems) {
    items = itemsOf(payload.items)
    if (items === null) return null
    /**
     * ผลรวมต้องเท่ายอดบิลเป๊ะ — ด่านเดียวกับที่ `itemizedSubtotals` โยนทิ้ง ·
     * จับที่นี่ได้คำตอบว่า "การ์ดใช้ไม่ได้ พิมพ์ใหม่" ซึ่งทำอะไรต่อได้ ส่วนการ
     * ปล่อยไปโยนตอน commit ได้ 500 แล้ว LINE ยิง postback เดิมกลับมาซ้ำไม่รู้จบ
     */
    if (items.reduce((sum, item) => sum + item.amountSatang, 0) !== totalSatang) return null
  }

  const base: ExpenseDraft = {
    description,
    totalSatang,
    mode,
    participants,
    includesPayer,
    adjustmentSatang,
  }
  // `exactOptionalPropertyTypes` เปิดอยู่ — คีย์ที่ไม่มีต้องไม่โผล่มาเป็น undefined
  const draft: ExpenseDraft = items === null ? base : { ...base, items }

  // `exactOptionalPropertyTypes` เปิดอยู่ — คีย์ที่ไม่มีต้องไม่โผล่มาเป็น undefined
  if ('eventTag' in payload && payload.eventTag !== undefined) {
    const eventTag = nonBlankString(payload.eventTag)
    if (eventTag === null) return null
    return { ...draft, eventTag }
  }

  return draft
}
