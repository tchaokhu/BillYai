/**
 * แปลง `ReplyPlan` เป็น message object ของ LINE — **ข้อความไทยทั้งระบบอยู่ไฟล์นี้**
 *
 * **ไกด์ต้องไม่โฆษณาคำสั่งที่ยังไม่มี** — กติกานี้บังคับด้วยเทสต์ใน
 * `messages.test.ts` ที่ผูกข้อความไกด์เข้ากับ `IMPLEMENTED_COMMANDS` โดยตรง
 * เพิ่มคำสั่งเข้ารายการนั้นเมื่อไหร่ เทสต์จะแดงจนกว่าไกด์จะพูดถึงมัน
 */

import { IMPLEMENTED_COMMANDS, type ReplyPlan } from '../flow/dispatch'
import { formatSatang } from '../money'
import type { BotCommand } from '../types'
import type { LineFlexMessage } from './flex'

/** text message ของ LINE — ยาวได้ 5000 ตัวอักษร */
export interface LineTextMessage {
  type: 'text'
  text: string
}

export type LineMessage = LineTextMessage | LineFlexMessage

function text(value: string): LineTextMessage[] {
  return [{ type: 'text', text: value }]
}

/**
 * ไวยากรณ์ของคำสั่งที่เปิดใช้แล้ว
 *
 * `IMPLEMENTED_COMMANDS` เป็นแหล่งเดียวว่าอะไรเปิดแล้ว บรรทัดที่นี่เป็นแค่
 * "ถ้าเปิดแล้วจะอธิบายว่ายังไง" · เทสต์บังคับให้สองอย่างนี้ตรงกันเสมอ
 */
const COMMAND_HELP: ReadonlyArray<{ command: BotCommand; line: string }> = [
  { command: 'balance', line: 'ยอด — สรุปว่าใครติดใครเท่าไหร่' },
  { command: 'nudge', line: 'ทวง — การ์ดทวงพร้อม QR ยอดเป๊ะ' },
  { command: 'edit', line: 'แก้ — เปิดหน้าจัดการบิล' },
  { command: 'undo', line: 'เลิก — ยกเลิกคำสั่งล่าสุดของตัวเอง' },
]

/**
 * ไกด์ — สอนเฉพาะของที่ใช้ได้จริงในเฟสนี้
 *
 * สอนไวยากรณ์ที่ยังใช้ไม่ได้คือการหลอกให้คนพิมพ์แล้วโดนปฏิเสธ ซึ่งแย่กว่าบอกตรงๆ
 * ว่ายังไม่พร้อม · ท่อนคำสั่งโตเองตาม `IMPLEMENTED_COMMANDS`
 */
const GUIDE = [
  'บิลใหญ่ช่วยจดว่าใครจ่ายอะไรไปเท่าไหร่ แล้วคำนวณให้ว่าใครติดใครเท่าไหร่',
  '',
  'จดบิลด้วยการพิมพ์:',
  '  + ข้าว 1200 กอล์ฟ ตูน',
  '  + คอนโด 8000 กอล์ฟx2 เบียร์ ตูน',
  '  + เหล้า 900 กอล์ฟ ตูน รวมฉัน',
  '  + ข้าว 1200 #เชียงใหม่',
  '',
  'ยอดที่พิมพ์คือยอดสุดท้ายที่จ่ายจริง รวมค่าบริการและ VAT แล้ว',
  ...COMMAND_HELP.filter((help) => IMPLEMENTED_COMMANDS.has(help.command)).map(
    (help) => `  ${help.line}`,
  ),
].join('\n')

/**
 * `draft` ไม่มีที่นี่โดยตั้งใจ — การ์ดต้องอ่าน Roster แล้วเขียนแถว draft ก่อน
 * ซึ่งเป็น I/O ทั้งคู่ · ผู้เรียกทำสองอย่างนั้นแล้วค่อยเรียก `draftCardMessage`
 */
export function renderReply(plan: Exclude<ReplyPlan, { kind: 'draft' }>): LineTextMessage[] {
  switch (plan.kind) {
    case 'silent':
      // ไม่ส่งอะไรเลย — ต่างจากส่งข้อความว่าง ซึ่ง LINE จะปฏิเสธ
      return []
    case 'guide':
      return text(GUIDE)
    case 'need-names':
      // ไวยากรณ์แปลว่า "หารเท่าทุกคนใน Roster" — วงนี้ยังไม่รู้จักใครเลยสักคน
      return text(
        'ยังไม่รู้จักใครในวงนี้เลย พิมพ์ชื่อคนที่หารด้วยมาด้วย เช่น\n  + ข้าว 1200 กอล์ฟ ตูน',
      )
    case 'unknown-sender':
      // ลองใหม่ไม่ช่วย — ต้องไปกดยอมรับข้อตกลงใน LINE ก่อน จึงต้องบอกให้ตรง
      return text(
        'จดให้ไม่ได้เพราะ LINE ไม่ได้บอกว่าใครเป็นคนพิมพ์ — ต้องยอมรับข้อตกลงการใช้งานบัญชีทางการก่อน แล้วพิมพ์ใหม่อีกครั้ง',
      )
    case 'committed':
      // ประกาศกลับเข้ากลุ่มเสมอ — ความโปร่งใสคือกลไกรักษาความปลอดภัยของระบบนี้ (D10)
      return text(`จดแล้ว: ${plan.description} ฿${formatSatang(plan.totalSatang)}`)
    case 'draft-gone':
      return text('การ์ดใบนี้ใช้ไม่ได้แล้ว พิมพ์บิลใหม่อีกครั้งได้เลย')
    case 'name-taken':
      return text(`ชื่อ "${plan.name}" มีเจ้าของแล้วในวงนี้ ลองเลือกชื่ออื่นหรือกด "ฉันเป็นคนใหม่"`)
    case 'needs-identity':
      return text('เลือกชื่อของคุณจากปุ่มด้านล่างก่อน แล้วบิลจะถูกจดให้ทันที')
    case 'no-display-name':
      // ลองใหม่ไม่ช่วย — LINE ไม่ให้ชื่อมาจนกว่าเขาจะให้สิทธิ์
      return text('ยังดึงชื่อของคุณจาก LINE ไม่ได้ ลองเลือกชื่อที่มีอยู่แล้วในวงแทน')
    case 'not-available':
      return text('คำสั่งนี้ยังไม่เปิดใช้')
  }
}
