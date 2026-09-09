/**
 * ข้อความที่หน้าจอ LIFF ยิงกลับเข้าแชทหลังเซฟ และตัวอ่านฝั่งบอท (D58)
 *
 * **ทำไมต้องมีข้อความนี้** — `liff.sendMessages()` ส่ง Flex ได้ก็จริง แต่เอกสาร
 * LINE ระบุสองข้อที่ฆ่าแผนเดิมทิ้ง: template/Flex ที่ส่งด้วยวิธีนี้ตั้งได้เฉพาะ
 * URI action (ปุ่มยืนยันเป็น postback จึงใส่ไม่ได้) และ **ไม่เกิด webhook เลย**
 * หน้าจอจึงยิงการ์ดใบใหม่เองไม่ได้ · ส่ง **text** แทน ซึ่งเกิด webhook ตามปกติ
 * แล้วบอทตอบการ์ดใบใหม่ด้วย reply token ซึ่งไม่กินโควตา push 300/เดือน (C2)
 *
 * **ลิงก์คือที่อยู่ ไม่ใช่ของประดับ** — D47 บังคับว่าคำสั่งคีย์เวิร์ดในกลุ่มต้อง
 * @mention บอท แต่ข้อความที่ส่งผ่าน API สร้าง mention ไม่ได้ · ข้อยกเว้นนี้จึงไม่ได้
 * เปิดคลาสของการชนคำที่ D47 ปิดไป: ลิงก์ที่ชี้ไป LIFF app **ของบอทเราเอง** พร้อม
 * id ของ draft ที่มีอยู่จริง คือการเรียกบอทตรงๆ ไม่ใช่คำที่คนในกลุ่มพูดกันเองได้
 *
 * โมดูลนี้ใช้ทั้งสองฝั่ง — เบราว์เซอร์เขียน บอทอ่าน — จึงห้ามพึ่งอะไรของ node
 */

import { isUuid } from '@/lib/db/uuid'

/** ความยาวของบรรทัดสรุป — ข้อความนี้โผล่ในกลุ่มให้ทุกคนเห็น ไม่ใช่ของเราคนเดียว */
const SUMMARY_MAX = 60

const PREFIX = 'จดรายชิ้นแล้ว'

/**
 * `NEXT_PUBLIC_LIFF_ID` → `https://liff.line.me/<liffId>` · `null` = ค่าใช้ไม่ได้
 *
 * **ไม่มีลิงก์ดีกว่าลิงก์เสีย** — ค่าที่ผิดรูปกลายเป็นปุ่มบนการ์ดในกลุ่มที่กดแล้ว
 * ไปหน้า 404 · อาการที่เจอจริงคือวาง Channel ID (ตัวเลขล้วน) ผิดช่อง
 *
 * อยู่ที่นี่เพราะทั้งบอท (ปุ่มบนการ์ด) และหน้าจอ (ลิงก์ใน Trigger) ต้องตัดสินด้วย
 * กฎเดียวกัน · แยกกันเมื่อไหร่จะได้บิลที่มีปุ่มแต่เซฟแล้วการ์ดไม่มา
 */
export function liffUrlOf(raw: string | undefined | null): string | null {
  const liffId = (raw ?? '').trim()
  // รูปของ LIFF ID คือ `<channelId ตัวเลข>-<suffix>`
  return /^[0-9]+-[A-Za-z0-9]+$/.test(liffId) ? `https://liff.line.me/${liffId}` : null
}

export interface DraftEchoInput {
  /** ชื่อบิลตามที่คนพิมพ์ไว้ — ว่างได้ */
  description: string
  /** `https://liff.line.me/<liffId>` ตัวเดียวกับที่ปุ่มบนการ์ดใช้ */
  liffUrl: string
  draftId: string
}

export function draftEchoText(input: DraftEchoInput): string {
  /**
   * ยุบช่องว่างทุกชนิดให้เหลือเว้นวรรคเดียว — ชื่อบิลที่มีขึ้นบรรทัดใหม่จะดัน
   * ลิงก์ลงไปบรรทัดที่สาม แล้วตัวอ่านที่นับบรรทัดจะหาไม่เจอ
   */
  const description = input.description.replace(/\s+/g, ' ').trim()
  const room = SUMMARY_MAX - PREFIX.length - ' — '.length
  const short =
    description.length > room ? `${description.slice(0, room - 1)}…` : description
  const summary = short === '' ? PREFIX : `${PREFIX} — ${short}`

  return `${summary}\n${input.liffUrl}?draftId=${input.draftId}`
}

/** อักขระพิเศษของ regex ใน `liffUrl` ต้องเป็นตัวอักษรธรรมดา ไม่ใช่กฎการแมตช์ */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * อ่าน `draftId` ออกจากข้อความ · `null` = ข้อความนี้ไม่ใช่ Trigger
 *
 * @param liffUrl `https://liff.line.me/<liffId>` ของบอทเราเอง · `null` หรือว่าง =
 *   ยังไม่ได้ตั้ง `NEXT_PUBLIC_LIFF_ID` แล้ว **ไม่มีอะไรเป็น Trigger ได้เลย** —
 *   เทียบกับสตริงว่างแปลว่าลิงก์ของ LIFF app ใครก็ได้กลายเป็นคำสั่งของเรา
 */
export function readDraftEcho(text: string, liffUrl: string | null | undefined): string | null {
  if (liffUrl === null || liffUrl === undefined || liffUrl === '') return null

  /**
   * `(?![0-9a-fA-F-])` กัน id ที่มีตัวอักษรต่อท้ายติดกัน — ตัดเอา 36 ตัวแรกมาใช้
   * แปลว่าลิงก์ที่พิมพ์ผิดจะกลายเป็นลิงก์ของ draft ใบอื่นที่มีอยู่จริงได้
   */
  const pattern = new RegExp(`${escapeRegExp(liffUrl)}\\?draftId=([0-9a-fA-F-]{36})(?![0-9a-fA-F-])`)
  const found = pattern.exec(text)
  if (found === null) return null

  const draftId = found[1] ?? ''
  // ด่านเดียวกับทุกที่ที่ id เดินไปหาคอลัมน์ uuid — รูปที่ไม่ใช่ uuid คือ "ไม่เจอ"
  return isUuid(draftId) ? draftId : null
}
