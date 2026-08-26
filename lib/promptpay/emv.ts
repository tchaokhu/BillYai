import { normalizeThaiMobile } from '@/lib/crypto/promptpay'

/**
 * สร้าง payload มาตรฐาน EMVCo Merchant-Presented QR สำหรับพร้อมเพย์ (D2)
 *
 * ทั้งไฟล์คือการแปลงสตริงล้วน ไม่แตะเครือข่ายและไม่แตะ DB — QR พร้อมเพย์คือ
 * "คำสั่งโอนที่ยังไม่ได้สั่ง" แอปธนาคารของผู้จ่ายเป็นคนตัดสินใจทั้งหมด ระบบเรา
 * ไม่เคยแตะเงิน จึงไม่ต้องขอไลเซนส์และไม่มี PCI scope
 *
 * ยังไม่ผ่าน spike S3 — ต้องสแกนด้วยแอปธนาคารจริงอย่างน้อย 3 เจ้าก่อนเชื่อว่า
 * ยอดขึ้นถูก ดู `docs/SPIKE-PHASE0.md`
 */

/** Application ID ของพร้อมเพย์ ตามที่ ITMX กำหนด */
const PROMPTPAY_AID = 'A000000677010111'
const CURRENCY_THB = '764'
const COUNTRY_TH = 'TH'

/** ความยาวสูงสุดของ tag 54 ตามสเปก EMVCo */
const MAX_AMOUNT_LENGTH = 13

/**
 * ลำดับ tag ของ payload
 *
 * สเปก EMVCo ไม่ได้บังคับลำดับ และ generator พร้อมเพย์ที่ใช้กันจริงมีสองสาย —
 * เรียง tag จากน้อยไปมาก (`53` แล้ว `58`) กับสลับเอา `58` ขึ้นก่อน
 * ค่า default คือแบบเรียงตาม tag เพราะตรงตัวอย่างในสเปก · `countryFirst`
 * มีไว้ให้ spike S3 ยิงเทียบสองแบบกับแอปธนาคารจริง ไม่ใช่ตัวเลือกให้ผู้ใช้
 */
export type TagOrder = 'ascending' | 'countryFirst'

export interface PromptPayQrInput {
  /** เบอร์มือถือรูปแบบใดก็ได้ที่ `normalizeThaiMobile` รับ */
  mobile: string
  /** ยอดเป็นสตางค์ integer — ไม่ใส่ = QR ที่ผู้จ่ายกรอกยอดเอง */
  amountSatang?: number
  order?: TagOrder
}

/** ประกอบ TLV หนึ่งช่อง — ความยาวเป็นเลขฐานสิบสองหลักเสมอ */
function tlv(tag: string, value: string): string {
  if (value.length > 99) throw new Error(`ค่าใน tag ${tag} ยาวเกิน 99 อักขระ`)
  return tag + String(value.length).padStart(2, '0') + value
}

const CRC_TABLE = (() => {
  const table = new Uint16Array(256)
  for (let byte = 0; byte < 256; byte++) {
    let crc = byte << 8
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
    table[byte] = crc
  }
  return table
})()

/**
 * CRC-16/CCITT-FALSE — poly `0x1021`, init `0xFFFF`, ไม่กลับบิต ไม่ XOR ท้าย
 *
 * คิดจากไบต์ ASCII ไม่ใช่ code point เพราะสเปกนิยามบนไบต์ · payload ที่เรา
 * สร้างเป็น ASCII ล้วนอยู่แล้ว แต่การอ่านผ่าน Buffer ทำให้ข้อนี้ไม่ใช่เรื่อง
 * ที่ต้องเชื่อใจผู้เรียก
 */
function crc16(input: string): string {
  let crc = 0xffff
  for (const byte of Buffer.from(input, 'ascii')) {
    crc = ((crc << 8) & 0xffff) ^ (CRC_TABLE[((crc >> 8) ^ byte) & 0xff] as number)
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

/**
 * สตางค์ → สตริงบาททศนิยมสองตำแหน่งสำหรับ tag 54
 *
 * ใช้ integer ล้วน ไม่หารด้วย 100 ตามกติกาเงินของโปรเจกต์ · ไม่ใช้
 * `formatSatang` จาก `lib/money.ts` เพราะอันนั้นเป็นรูปแบบสำหรับคนอ่าน
 * (มีคอมมา ตัด `.00` ทิ้ง) ซึ่งทั้งสองอย่างทำให้แอปธนาคารอ่านยอดผิด
 */
function amountToTag54(amountSatang: number): string {
  if (!Number.isSafeInteger(amountSatang)) {
    throw new Error(`ยอดต้องเป็นจำนวนสตางค์แบบ integer: ${amountSatang}`)
  }
  if (amountSatang <= 0) throw new Error(`ยอดต้องมากกว่าศูนย์: ${amountSatang}`)

  const baht = Math.floor(amountSatang / 100)
  const satang = amountSatang % 100
  const text = `${baht}.${String(satang).padStart(2, '0')}`
  if (text.length > MAX_AMOUNT_LENGTH) {
    throw new Error(`ยอดเกินที่ QR รองรับ (${MAX_AMOUNT_LENGTH} อักขระ): ${text}`)
  }
  return text
}

export function buildPromptPayPayload(input: PromptPayQrInput): string {
  const { mobile, amountSatang, order = 'ascending' } = input

  // แปลงเบอร์ก่อนคิดยอด เพื่อให้เบอร์ผิดฟ้องด้วยข้อความของ `normalizeThaiMobile`
  // ซึ่งจงใจไม่ใส่เบอร์ลงใน error ตาม D12
  const local = normalizeThaiMobile(mobile)
  const amount = amountSatang === undefined ? undefined : amountToTag54(amountSatang)

  // พร้อมเพย์ใช้ `0066` + เก้าหลักหลังเลขศูนย์นำ ไม่ใช่ `+66` และไม่ใช่เบอร์ดิบ
  const account =
    tlv('00', PROMPTPAY_AID) + tlv('01', `0066${local.slice(1)}`)

  const currency = tlv('53', CURRENCY_THB)
  const country = tlv('58', COUNTRY_TH)
  const amountField = amount === undefined ? '' : tlv('54', amount)

  const head =
    tlv('00', '01') +
    // `11` = QR ใช้ซ้ำได้ (ไม่ระบุยอด) · `12` = ใช้ครั้งเดียว (ระบุยอด)
    tlv('01', amount === undefined ? '11' : '12') +
    tlv('29', account)

  const tail =
    order === 'ascending' ? currency + amountField + country : country + currency + amountField

  // `6304` ต้องอยู่ในสิ่งที่ถูก CRC ด้วย — ตัดออกแล้วค่าจะผ่านการตรวจของ
  // แอปธนาคารไม่ได้ทั้งที่ payload ดูถูกทุกอย่าง
  const body = `${head}${tail}6304`
  return body + crc16(body)
}
