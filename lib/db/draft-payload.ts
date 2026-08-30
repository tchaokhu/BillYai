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
import type { DraftLine, DraftParticipant, ExpenseDraft, SplitMode } from '@/lib/types'

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
  return { draft, lines }
}

export function parseDraftPayload(value: unknown): ExpenseDraft | null {
  const payload = asRecord(value)
  if (payload === null) return null

  const description = nonBlankString(payload.description)
  if (description === null) return null

  const { totalSatang, mode, includesPayer, surchargePct } = payload
  if (typeof totalSatang !== 'number' || !Number.isSafeInteger(totalSatang) || totalSatang <= 0) {
    return null
  }
  if (!isSplitMode(mode)) return null
  if (typeof includesPayer !== 'boolean') return null
  if (
    typeof surchargePct !== 'number' ||
    !Number.isFinite(surchargePct) ||
    surchargePct < 0 ||
    surchargePct > 100
  ) {
    return null
  }

  const participants = participantsOf(payload.participants)
  if (participants === null) return null

  const draft: ExpenseDraft = {
    description,
    totalSatang,
    mode,
    participants,
    includesPayer,
    surchargePct,
  }

  // `exactOptionalPropertyTypes` เปิดอยู่ — คีย์ที่ไม่มีต้องไม่โผล่มาเป็น undefined
  if ('eventTag' in payload && payload.eventTag !== undefined) {
    const eventTag = nonBlankString(payload.eventTag)
    if (eventTag === null) return null
    return { ...draft, eventTag }
  }

  return draft
}
