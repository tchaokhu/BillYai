/**
 * แปลง `ReplyPlan` เป็น message object ของ LINE — **ข้อความไทยทั้งระบบอยู่ไฟล์นี้**
 *
 * **ไกด์ต้องไม่โฆษณาคำสั่งที่ยังไม่มี** — กติกานี้บังคับด้วยเทสต์ใน
 * `messages.test.ts` ที่ผูกข้อความไกด์เข้ากับ `IMPLEMENTED_COMMANDS` โดยตรง
 * เพิ่มคำสั่งเข้ารายการนั้นเมื่อไหร่ เทสต์จะแดงจนกว่าไกด์จะพูดถึงมัน
 */

import { IMPLEMENTED_COMMANDS, type ReplyPlan, type Surface } from '../flow/dispatch'
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
  { command: 'bills', line: 'บิล — รายการบิลที่จดไว้ กดดูรายละเอียดได้' },
  { command: 'nudge', line: 'ทวง — การ์ดทวงพร้อม QR ยอดเป๊ะ' },
  { command: 'edit', line: 'แก้ — เปิดหน้าจัดการบิล' },
  { command: 'undo', line: 'เลิก — ยกเลิกคำสั่งล่าสุดของตัวเอง' },
]

/** ชื่อที่คนพิมพ์เวลาเรียกบอทในกลุ่ม — ใช้ในไกด์เท่านั้น ไม่ใช่ตัวตัดสินว่าถูกเรียก */
const MENTION = '@บิลใหญ่'

/**
 * ไกด์ — สอนเฉพาะของที่ใช้ได้จริงในเฟสนี้ **และในที่ที่คนอ่านอยู่**
 *
 * สอนไวยากรณ์ที่ยังใช้ไม่ได้คือการหลอกให้คนพิมพ์แล้วโดนปฏิเสธ ซึ่งแย่กว่าบอกตรงๆ
 * ว่ายังไม่พร้อม · ท่อนคำสั่งโตเองตาม `IMPLEMENTED_COMMANDS`
 *
 * **ท่อนคำสั่งต่างกันตาม surface ตั้งแต่ D47** — ในกลุ่มคีย์เวิร์ดเปล่าๆ ตกเป็น
 * ความเงียบ ไกด์ที่สอนรูปเปล่าจึงหลอกให้คนคิดว่าบอทพัง · ส่วนใน 1:1 จะใส่
 * `@บิลใหญ่` ให้ไม่ได้เลย เพราะ LINE ไม่มี mention ที่นั่น ข้อความจะไม่ถูกตัด
 * แล้วตกเป็น `unparsed` ซึ่งใน 1:1 ตอบไกด์ = วนกลับมาที่เดิมไม่รู้จบ
 *
 * **ท่อนจดบิลเหมือนกันทั้งสองที่** — `+` ไม่ถูก D47 แตะ (D19)
 */
function buildGuide(surface: Surface): string {
  const prefix = surface === 'group' ? `${MENTION} ` : ''
  return [
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
      (help) => `  ${prefix}${help.line}`,
    ),
  ].join('\n')
}

/** คิดครั้งเดียวตอนโหลด — เนื้อไกด์เป็นค่าคงที่ของแต่ละ surface */
const GUIDE: Readonly<Record<Surface, string>> = {
  group: buildGuide('group'),
  direct: buildGuide('direct'),
}

/**
 * `draft` กับ `balance` ไม่มีที่นี่โดยตั้งใจ — ทั้งคู่ต้องอ่าน DB ก่อนถึงจะรู้ว่า
 * การ์ดหน้าตายังไง · ผู้เรียกไป I/O เองแล้วค่อยเรียกตัวสร้างการ์ดของมัน
 */
export function renderReply(
  plan: Exclude<ReplyPlan, { kind: 'draft' } | { kind: 'balance' }>,
  /**
   * **บังคับส่ง ไม่มีค่าเริ่มต้น** — ไกด์เป็นข้อความเดียวที่ต่างกันตามที่ที่คนอ่าน
   * และค่าเริ่มต้นจะทำให้จุดเรียกที่ลืมส่งกลายเป็นไกด์ที่ผิดที่แบบเงียบๆ
   * ให้ตัว compiler ทวงดีกว่ารอไปเจอในแชทจริง
   */
  surface: Surface,
): LineTextMessage[] {
  switch (plan.kind) {
    case 'silent':
      // ไม่ส่งอะไรเลย — ต่างจากส่งข้อความว่าง ซึ่ง LINE จะปฏิเสธ
      return []
    case 'guide':
      return text(GUIDE[surface])
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
    case 'settled':
      // ต่างจากวงที่ยังไม่เคยจดบิลซึ่งตอบไกด์ — คนนี้ใช้เป็นแล้ว ตอบไกด์ซ้ำคือ
      // ไม่ตอบคำถามที่เขาถาม
      return text('ตอนนี้ไม่มีใครติดใครแล้ว')
    case 'not-available':
      return text('คำสั่งนี้ยังไม่เปิดใช้')
  }
}
