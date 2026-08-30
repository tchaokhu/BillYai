/**
 * ตัด mention ออกจากข้อความ — งานของชั้น adapter เท่านั้น
 *
 * `index`/`length` เป็นแนวคิดของ LINE ล้วนๆ และนับเป็น **UTF-16 code unit**
 * `lib/parser/` จึงต้องไม่รู้จักคำว่า mentionee เลย (`docs/DESIGN.md` §3)
 *
 * **ตัดเฉพาะ mention ที่เรียกบอท ไม่แตะของคนอื่นเลย** — `isSelf` เป็นตัวตัดสิน ซึ่ง
 * เอกสาร LINE นิยามว่าเป็น mention ถึงบอทตัวที่รับ webhook นั้น ไม่ใช่การเทียบชื่อ
 * ในข้อความ
 *
 * เคยเขียนให้ตัดทุกอันโดยให้เหตุผลว่า mention เป็นเครื่องหมายว่าพูดกับใคร ไม่ใช่
 * เนื้อความ — **ผิด และอันตราย**: `@กอล์ฟ เลิก` จะเหลือคำว่า `เลิก` ซึ่งตรงกับคำสั่ง
 * พอดี แล้วบอทจะโพล่งเข้าไปในบทสนทนาที่ไม่ได้พูดกับมัน ซึ่งเป็นสิ่งเดียวที่กฎเงียบ
 * มีไว้กัน (DESIGN §3 — "โดนเตะออกจากกลุ่ม = จบเกม") · `@All` ก็อยู่ในข้อความต่อไป
 * แล้วกลายเป็น token ที่ทำให้ข้อความไม่ตรงคำสั่ง ซึ่งตรงกับที่ตัดสินไว้ว่า `@All`
 * ไม่เข้า Trigger
 */

import type { Mentionee } from './events'

export interface StrippedMessage {
  /** ข้อความที่ไม่มี mention แล้ว ตัดช่องว่างหัวท้ายให้ */
  text: string
  /** มี mention ถึงบอทตัวนี้อย่างน้อยหนึ่งอัน = เข้า Trigger */
  mentionsBot: boolean
}

export function stripMentions(text: string, mentionees: readonly Mentionee[]): StrippedMessage {
  // ตำแหน่งที่ไม่ตรงกับข้อความจริง = เชื่อไม่ได้ทั้งอัน · ตัดมั่วแย่กว่าไม่ตัด
  // และ **ต้องกรองก่อนถามว่าเรียกบอทไหม** — mentionee ที่เชื่อตำแหน่งไม่ได้แต่ยัง
  // เชื่อ `isSelf` จะพาข้อความที่ยังมี `@บิลใหญ่` ค้างอยู่เข้าทางของ parser
  const valid = mentionees.filter((m) => m.isSelf && m.index + m.length <= text.length)
  const mentionsBot = valid.length > 0

  const ranges = valid
    .map((m) => ({ start: m.index, end: m.index + m.length }))
    // เรียงเอง ไม่เชื่อลำดับที่ LINE ส่งมา
    .sort((a, b) => a.start - b.start)

  // รวมช่วงที่ทับกันให้เป็นช่วงเดียวก่อนตัด — ตัดทีละอันจะได้ผลขึ้นกับว่าอันไหน
  // มาก่อน และช่วงในที่ตัดก่อนจะทำให้ช่วงนอกถูกทิ้งทั้งที่มันคือช่วงที่ถูกต้อง
  const merged: Array<{ start: number; end: number }> = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last !== undefined && range.start < last.end) {
      if (range.end > last.end) last.end = range.end
      continue
    }
    merged.push({ ...range })
  }

  // ตัดจากท้ายไปหัว เพื่อให้ตำแหน่งของช่วงที่ยังไม่ตัดไม่ขยับตาม
  let stripped = text
  for (let i = merged.length - 1; i >= 0; i--) {
    const range = merged[i]
    if (range === undefined) continue
    stripped = stripped.slice(0, range.start) + stripped.slice(range.end)
  }

  // ตัดหัวท้ายอย่างเดียว — ช่องว่างซ้อนกลางข้อความไม่ต้องยุ่ง เพราะ parser
  // แยก token ด้วย `\s+` อยู่แล้ว และคำสั่งคำเดียวเทียบหลัง trim
  return { text: stripped.trim(), mentionsBot }
}
