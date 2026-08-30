/**
 * แปลง `ReplyPlan` เป็น message object ของ LINE — **ข้อความไทยทั้งระบบอยู่ไฟล์นี้**
 *
 * รอบ M4 เป็น text message ล้วน ยังไม่มี Flex · Flex ใบแรกคือ Draft card ของ M5
 *
 * **ไกด์ต้องไม่โฆษณาคำสั่งที่ยังไม่มี** — กติกานี้บังคับด้วยเทสต์ใน
 * `messages.test.ts` ที่ผูกข้อความไกด์เข้ากับ `IMPLEMENTED_COMMANDS` โดยตรง
 * เพิ่มคำสั่งเข้ารายการนั้นเมื่อไหร่ เทสต์จะแดงจนกว่าไกด์จะพูดถึงมัน
 */

import type { ReplyPlan } from '../flow/dispatch'

/** text message ของ LINE — ยาวได้ 5000 ตัวอักษร */
export interface LineTextMessage {
  type: 'text'
  text: string
}

function text(value: string): LineTextMessage[] {
  return [{ type: 'text', text: value }]
}

/**
 * ไกด์ของ M4 — บอทยังทำอะไรไม่ได้เลยนอกจากแนะนำตัว
 *
 * เขียนแบบนี้โดยตั้งใจ: สอนไวยากรณ์ที่ยังใช้ไม่ได้คือการหลอกให้คนพิมพ์แล้วโดน
 * ปฏิเสธ ซึ่งแย่กว่าบอกตรงๆ ว่ายังไม่พร้อม · พอ M6 กับ M7 ลงของจริง ไกด์นี้จะโต
 * ขึ้นพร้อมกับ `IMPLEMENTED_COMMANDS`
 */
const GUIDE = [
  'บิลใหญ่ช่วยจดว่าใครจ่ายอะไรไปเท่าไหร่ แล้วคำนวณให้ว่าใครติดใครเท่าไหร่',
  '',
  'ตอนนี้ยังสร้างไม่เสร็จ ยังจดบิลไม่ได้ — เรียกมาก็ได้แค่ทักทายกลับเท่านั้น',
].join('\n')

export function renderReply(plan: ReplyPlan): LineTextMessage[] {
  switch (plan.kind) {
    case 'silent':
      // ไม่ส่งอะไรเลย — ต่างจากส่งข้อความว่าง ซึ่ง LINE จะปฏิเสธ
      return []
    case 'guide':
      return text(GUIDE)
    case 'not-available':
      return plan.what === 'expense'
        ? text('ยังจดบิลไม่ได้ กำลังสร้างอยู่ อีกไม่นานจะพิมพ์ในกลุ่มได้เลย')
        : text('คำสั่งนี้ยังไม่เปิดใช้')
  }
}
