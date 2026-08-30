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

import type { BotCommand, ParseResult } from '../types'

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
  | { kind: 'not-available'; what: 'command' | 'expense' }

/**
 * คำสั่งที่ลงของจริงแล้ว — M4 มีแค่ไกด์
 *
 * M7 เติม `balance` · Phase 2 เติม `nudge` · Phase 3 เติม `edit` กับ `undo`
 * พอเติมแล้วข้อความ "ยังไม่เปิดใช้" หายไปเองโดยไม่ต้องแก้ที่อื่น
 */
export const IMPLEMENTED_COMMANDS: ReadonlySet<BotCommand> = new Set<BotCommand>(['guide'])

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

  // การจดบิลลง ledger เปิดตอน M6 — ก่อนหน้านั้น draft ยังไม่มีที่เก็บ
  if (parsed.kind === 'expense') return { kind: 'not-available', what: 'expense' }

  // ยังไม่มีคำสั่งไหนรับส่วนต่อท้ายได้ (D34) — `ยอด #tag` รอ Phase 3
  if (parsed.args !== undefined) return { kind: 'not-available', what: 'command' }

  if (!IMPLEMENTED_COMMANDS.has(parsed.command)) {
    return { kind: 'not-available', what: 'command' }
  }

  return { kind: 'guide' }
}
