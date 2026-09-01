/**
 * ตัดสินว่าบอทจะตอบอะไร — **เจตนา ไม่ใช่ข้อความของ LINE**
 *
 * ไฟล์นี้ไม่รู้จัก LINE เลยตาม `docs/DESIGN.md` §6 · การแปลง `ReplyPlan` เป็น
 * message object เป็นงานของ `lib/line/messages.ts`
 *
 * **รายชื่อของที่เปิดใช้แล้วอยู่ในไฟล์นี้ที่เดียวทั้งระบบ** — ตัดสินไว้แล้วว่า
 * ห้ามกระจายเป็น `if` หลายที่ที่ต้องไล่จำ · เขียนเป็น "อะไรเปิดแล้ว" ไม่ใช่
 * "อะไรยังไม่เปิด" เพราะคำสั่งที่เพิ่มเข้ามาใหม่ควรเป็นของที่ยังไม่เปิดโดยปริยาย
 */

import type { BotCommand, ExpenseDraft, ParseResult } from '../types'

/** ที่ที่ข้อความเข้ามา — วงส่วนตัวใช้ `direct` ตาม D21 */
export type Surface = 'group' | 'direct'

export interface ReplyContext {
  surface: Surface
  /** ข้อความนี้ @mention บอทหรือไม่ — `isSelf` เท่านั้น ไม่นับ `@All` */
  addressed: boolean
}

export type ReplyPlan =
  | { kind: 'silent' }
  | { kind: 'guide' }
  | { kind: 'not-available'; what: 'command' }
  /** ต้องอ่าน Roster ก่อนถึงจะสร้างการ์ดได้ — ผู้เรียกเป็นคนไป I/O ต่อ */
  | { kind: 'draft'; draft: ExpenseDraft }
  /**
   * ไม่ระบุชื่อใครในวงที่ Roster ยังว่าง — ตัดสินหลังอ่าน Roster แล้ว จึงมาจาก
   * ผู้เรียก ไม่ใช่จาก `decideReply`
   */
  | { kind: 'need-names' }
  /**
   * LINE ไม่ส่ง `userId` มาให้ — เกิดเมื่อคนพิมพ์ยังไม่ยอมรับข้อตกลงการใช้งาน
   * บัญชีทางการ · D26 ให้เฉพาะคนพิมพ์กดยืนยันได้ ซึ่งเช็คไม่ได้ถ้าไม่รู้ว่าใครพิมพ์
   */
  | { kind: 'unknown-sender' }
  /** บิลลง ledger แล้ว — ประกาศกลับเข้ากลุ่ม */
  | { kind: 'committed'; description: string; totalSatang: number }
  /** การ์ดหมดอายุ ถูกกดไปแล้ว หรือหาไม่เจอ — จบเหมือนกันหมด */
  | { kind: 'draft-gone' }
  /** ชื่อที่เลือกมีเจ้าของไปแล้ว */
  | { kind: 'name-taken'; name: string }
  /** ดึงชื่อจาก LINE ไม่ได้ — ไม่มีชื่อให้ตั้ง Member และห้ามเดาแทน */
  | { kind: 'no-display-name' }
  /** กดยืนยันมาโดยยังไม่ได้เลือกว่าเป็นใคร — ปกติไม่เกิด เพราะการ์ดไม่มีปุ่มให้กด */
  | { kind: 'needs-identity' }
  /** ต้องอ่าน ledger ก่อนถึงจะตอบได้ — ผู้เรียกเป็นคนไป I/O ต่อ */
  | { kind: 'balance' }
  /** มีบิลแล้วแต่ไม่มีใครติดใคร — คนละเรื่องกับวงที่ยังไม่เคยจดบิล */
  | { kind: 'settled' }
  /** ต้องอ่านรายการบิลก่อนถึงจะตอบได้ — ผู้เรียกเป็นคนไป I/O ต่อ (D45) */
  | { kind: 'bills' }
  /**
   * กดแถวของบิลที่ไม่มีในวงนี้ — **ไม่บอกว่ามันมีอยู่จริงที่อื่น**
   *
   * การ์ด `บิล` ลอยอยู่ในแชทได้ตลอดกาล และ id ที่ส่งกลับมาไม่มีอะไรรับประกันว่า
   * เป็นของวงนี้ · ตอบเหมือนกันทั้งกรณีไม่มีจริงและกรณีอยู่คนละวง
   */
  | { kind: 'bill-not-found' }
  /** บิลถูกยกเลิกไปแล้ว — ต่างจากหาไม่เจอ และต่างจากการโชว์ยอดเก่าซึ่งผิด */
  | { kind: 'bill-voided' }

/**
 * คำสั่งที่ลงของจริงแล้ว — M4 มีแค่ไกด์
 *
 * Phase 2 เติม `nudge` · Phase 3 เติม `edit` กับ `undo`
 * พอเติมแล้วข้อความ "ยังไม่เปิดใช้" หายไปเองโดยไม่ต้องแก้ที่อื่น
 */
export const IMPLEMENTED_COMMANDS: ReadonlySet<BotCommand> = new Set<BotCommand>([
  'guide',
  'balance',
  'bills',
])

export function decideReply(context: ReplyContext, parsed: ParseResult | null): ReplyPlan {
  if (parsed === null || parsed.kind === 'unparsed') {
    // กฎเงียบเป็นของกลุ่มเท่านั้น เหตุผลของมันคือ "อย่าพูดแทรกบทสนทนาของคนอื่น"
    // ในแชท 1:1 ไม่มีบทสนทนาของคนอื่นให้แทรก เหตุผลหายไป กฎจึงไม่ตามไปด้วย
    //
    // เกณฑ์เดียวกันนี้ใช้กับคนที่ @mention บอทในกลุ่ม: เขากำลังพูดกับบอทตรงๆ
    // ไม่ได้คุยกับใครอยู่ · เงียบใส่คนที่เพิ่งเรียกชื่อเรา อ่านออกมาได้อย่างเดียว
    // ว่าบอทเสีย
    const silent = context.surface === 'group' && !context.addressed
    return silent ? { kind: 'silent' } : { kind: 'guide' }
  }

  // การ์ดเกิดที่นี่ แต่ยอดกับป้าย `(ใหม่)` ต้องรอ Roster ซึ่งเป็น I/O
  if (parsed.kind === 'expense') return { kind: 'draft', draft: parsed.draft }

  /**
   * D47 — คำสั่งคีย์เวิร์ดในกลุ่มต้องเรียกบอทตรงๆ
   *
   * `ยอด` เป็นชื่อคนได้ และ `บิลเท่าไหร่` คือประโยคที่คนในกลุ่มพูดกันเอง การชน
   * จึงไม่ใช่ edge case แต่เป็นกรณีปกติ · ด่านนี้ทำให้ไม่ต้องมีกฎกันชนรายคำสั่ง
   * อีกต่อไป ซึ่งเป็นสิ่งที่ D34 เคยต้องเขียนไว้เฉพาะ `ยอด` ตัวเดียว
   *
   * อยู่ **หลัง** `expense` เพราะ `+` ไม่ถูกแตะ — จดบิลคือการกระทำที่ถี่ที่สุด
   * ในระบบ บังคับ mention ตรงนั้นชนกับ D19 โดยตรง (`DESIGN.md` §3)
   *
   * และอยู่ **ก่อน** ด่าน args กับ `IMPLEMENTED_COMMANDS` เพราะความเงียบมาก่อน
   * "ยังไม่เปิดใช้" — คนที่ไม่ได้เรียกบอทไม่ควรได้ยินอะไรเลย ต่อให้เขาบังเอิญ
   * พิมพ์คำที่ตรงกับคำสั่ง การตอบกลับตรงนั้นคือเสียงรบกวนชนิดเดียวกับที่ D47 มาแก้
   *
   * 1:1 ไม่บังคับ: LINE ไม่มี mention ที่นั่น บังคับแล้วคำสั่งจะเข้าไม่ถึงเลย ·
   * เกณฑ์เดียวกับกฎเงียบข้างบนซึ่งเป็นของกลุ่มอย่างเดียวอยู่แล้ว
   */
  if (context.surface === 'group' && !context.addressed) return { kind: 'silent' }

  // ยังไม่มีคำสั่งไหนรับส่วนต่อท้ายได้ (D34) — `ยอด #tag` รอ Phase 3
  if (parsed.args !== undefined) return { kind: 'not-available', what: 'command' }

  if (!IMPLEMENTED_COMMANDS.has(parsed.command)) {
    return { kind: 'not-available', what: 'command' }
  }

  // `ยอด` ต้องอ่าน ledger ซึ่งเป็น I/O — ไฟล์นี้ตัดสินอย่างเดียว ไม่ไปหยิบข้อมูลเอง
  if (parsed.command === 'balance') return { kind: 'balance' }

  // `บิล` เหมือนกัน — รายการบิลอยู่ใน DB ไม่ใช่ในเจตนา
  if (parsed.command === 'bills') return { kind: 'bills' }

  return { kind: 'guide' }
}
