/**
 * promptpay — เข้ารหัสเบอร์มือถือสำหรับ PromptPay (D12)
 *
 * D12 เลือกเก็บ **เบอร์มือถืออย่างเดียว** ไม่เก็บเลขบัตรประชาชน เพื่อไม่ให้
 * ระบบแตะข้อมูลอ่อนไหวตาม PDPA ม.26 เลยสักนิด. เบอร์ที่เหลืออยู่ยังเป็นข้อมูล
 * ส่วนบุคคล จึงเข้ารหัส at rest ส่วน `last4` เก็บเป็น plaintext แยกไว้ให้
 * โชว์ยืนยันปลายทางได้โดยไม่ต้องถอดรหัส
 *
 * โมดูลนี้ไม่รู้จัก DB และไม่รู้จัก LINE — รับสตริง คืน Buffer เท่านั้น
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * 12 ไบต์ (96 บิต) คือความยาว IV ที่ NIST SP 800-38D กำหนดเป็นค่ามาตรฐานของ GCM
 * ความยาวนี้เข้า counter block ตรงๆ ส่วนความยาวอื่นต้องผ่าน GHASH ก่อน ซึ่งช้ากว่า
 * และทำให้ IV ต่างกันสองอันชนกันเป็น counter เดียวกันได้ — GCM ที่ nonce ซ้ำ
 * คือการเปิดเผย authentication key ไม่ใช่แค่รั่ว plaintext
 */
const IV_BYTES = 12

/** authTag เต็มความยาวของ GCM — ตัดให้สั้นลงได้แต่ยิ่งสั้นยิ่งปลอมง่ายขึ้น */
const AUTH_TAG_BYTES = 16

/** AES-256 */
const KEY_BYTES = 32

const KEY_ENV = 'PROMPTPAY_KEY'

const KEY_HOWTO =
  `ตั้งค่า ${KEY_ENV} เป็นสุ่ม ${KEY_BYTES} ไบต์เข้ารหัส base64 ใน .env.local — ` +
  `สร้างด้วย: node -p "require('crypto').randomBytes(${KEY_BYTES}).toString('base64')"`

/** base64 มาตรฐาน (ไม่ใช่ base64url) เพราะค่าที่เอกสารบอกให้สร้างออกมาเป็นแบบนี้ */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * อ่านคีย์ **ตอนเรียกใช้ ไม่ใช่ตอน import**
 *
 * ถ้าอ่านตอน import โมดูลนี้จะ throw ตั้งแต่โหลด แล้วเทสต์ยูนิตของไฟล์อื่นที่
 * บังเอิญ import ต่อกันมาจะแดงตามไปด้วยทั้งที่ไม่เกี่ยวกับ PromptPay เลย
 */
function loadKey(): Buffer {
  const raw = process.env[KEY_ENV]
  if (raw === undefined || raw.trim() === '') {
    throw new Error(`ยังไม่ได้ตั้ง ${KEY_ENV} — ${KEY_HOWTO}`)
  }

  const text = raw.trim()
  // ห้ามใส่ค่าคีย์ลงข้อความ error ทุกกรณี — error ถูก log ได้ คีย์ห้ามอยู่ใน log
  const invalid = new Error(`${KEY_ENV} ไม่ถูกต้อง — ${KEY_HOWTO}`)

  if (!BASE64_RE.test(text) || text.length % 4 !== 0) throw invalid

  const key = Buffer.from(text, 'base64')
  // `Buffer.from(_, 'base64')` ข้ามอักขระที่ถอดไม่ได้แบบเงียบๆ และไม่สนใจว่าบิต
  // ส่วนเกินท้าย padding เป็นศูนย์ไหม — encode กลับมาเทียบคือวิธีจับว่าคีย์ที่ได้
  // ตรงกับที่คนตั้งใจใส่จริงๆ ไม่ใช่ค่าที่ถูกตัดมาให้เฉยๆ
  if (key.byteLength !== KEY_BYTES || key.toString('base64') !== text) throw invalid

  return key
}

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙'

/** ตัวคั่นที่คนพิมพ์เบอร์กันจริง — ขีด ช่องว่าง วงเล็บ จุด */
const SEPARATORS_RE = /[\s\-().]/g

/**
 * มือถือไทยขึ้นต้นด้วย 06 08 09 เท่านั้น (เลขหมายเดิม 01/02/05/07 ย้ายไปหมดแล้ว)
 * เช็คถึงระดับ prefix เพราะ "ยาว 10 หลัก" อย่างเดียวไม่กันเบอร์บ้านที่พิมพ์เกินมา
 * และ PromptPay ผูกได้เฉพาะเบอร์มือถือ — เบอร์บ้านสร้าง QR ไม่ได้อยู่แล้ว
 */
const THAI_MOBILE_RE = /^0[689]\d{8}$/

/**
 * แปลงเบอร์มือถือทุกรูปแบบที่คนพิมพ์ให้เหลือรูปเดียว `0812345678`
 *
 * รับเลขไทยด้วย เพราะ rule parser (`lib/parser/rules.ts`) รับอยู่แล้ว —
 * คนที่พิมพ์ `๑๒๐๐` เป็นยอดบิลในกลุ่มก็พิมพ์ `๐๘๑` ในฟอร์มได้เหมือนกัน
 * การรับที่ประตูหนึ่งแล้วปฏิเสธที่อีกประตูคือความไม่สม่ำเสมอที่ผู้ใช้เจอเอง
 * โดยไม่มีทางเดาได้ และการแมปเลขไทย→อารบิกเป็น 1:1 จึงไม่มีความกำกวมให้เสี่ยง
 */
export function normalizeThaiMobile(input: string): string {
  const compact = input
    .replace(/[๐-๙]/g, (digit) => String(THAI_DIGITS.indexOf(digit)))
    .replace(SEPARATORS_RE, '')

  let local = compact
  if (local.startsWith('+66')) {
    local = `0${local.slice(3)}`
  } else if (local.startsWith('66') && local.length === 11) {
    // `66` โดดๆ แปลงเฉพาะตอนยาว 11 หลัก ไม่งั้น `0661234567` (เบอร์ 06 จริง)
    // จะโดนตัดหัวทิ้ง — เงื่อนไขความยาวคือสิ่งเดียวที่แยกสองเคสนี้ออกจากกัน
    local = `0${local.slice(2)}`
  }

  if (!THAI_MOBILE_RE.test(local)) {
    // ต่างจาก `lib/money.ts` ที่ใส่ค่าที่ผิดลงในข้อความ error: เบอร์โทรเป็น
    // ข้อมูลส่วนบุคคล ถ้าเอาลง error ก็เท่ากับเอาลง log ซึ่งขัดกับ D12 ที่
    // อุตส่าห์เข้ารหัสเบอร์ใน DB แล้ว
    throw new Error('เบอร์มือถือไม่ถูกต้อง — ต้องเป็นเบอร์มือถือไทย 10 หลัก ขึ้นต้นด้วย 06 08 หรือ 09')
  }

  return local
}

/**
 * เข้ารหัสเบอร์มือถือเป็นก้อนเดียวสำหรับคอลัมน์ `app_user.promptpay_cipher`
 *
 * เรียง `iv || authTag || ciphertext` ในก้อนเดียวเพราะ `bytea` คอลัมน์เดียว
 * ย้ายพร้อมกันเสมอ — สามคอลัมน์แยกคือสามโอกาสที่จะเขียนไม่ครบชุดแล้วเหลือ
 * cipher ที่ถอดไม่ได้ค้างไว้
 *
 * `last4` คืนแยกให้เก็บลง `promptpay_last4` เป็น plaintext ตาม D12
 */
export function encryptPromptPay(mobile: string): { cipher: Buffer; last4: string } {
  const normalized = normalizeThaiMobile(mobile)
  const key = loadKey()

  // iv สุ่มใหม่ทุกครั้ง — เบอร์เดิมจึงได้ ciphertext คนละอัน ไม่งั้นคนที่อ่าน
  // ตารางได้จะรู้ทันทีว่าสองแถวนี้เป็นเบอร์เดียวกัน ทั้งที่ยังถอดรหัสไม่ได้
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()])

  return {
    cipher: Buffer.concat([iv, cipher.getAuthTag(), body]),
    last4: normalized.slice(-4),
  }
}

/** ถอดรหัสก้อนจาก `encryptPromptPay` — ข้อมูลที่ถูกแก้ต้อง throw ไม่ใช่คืนขยะ */
export function decryptPromptPay(cipher: Buffer): string {
  // กันไว้ก่อนแตะ `subarray` เพราะ buffer ที่สั้นเกินจะกลายเป็น authTag ที่สั้น
  // แล้ว `setAuthTag` โยน RangeError จากข้างในออกมาแทน ซึ่งอ่านไม่ออกว่าเกิดอะไร
  const minimum = IV_BYTES + AUTH_TAG_BYTES + 1
  if (cipher.byteLength < minimum) {
    throw new Error(
      `ข้อมูล PromptPay สั้นเกินกว่าจะถอดรหัสได้: ${cipher.byteLength} ไบต์ (ต้องอย่างน้อย ${minimum})`,
    )
  }

  const key = loadKey()
  const decipher = createDecipheriv('aes-256-gcm', key, cipher.subarray(0, IV_BYTES))
  decipher.setAuthTag(cipher.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES))

  try {
    const body = cipher.subarray(IV_BYTES + AUTH_TAG_BYTES)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    // authTag ไม่ผ่านคือคำตอบเดียวที่ GCM ให้ได้ — แยกไม่ออกว่าคีย์ผิดหรือข้อมูลถูกแก้
    throw new Error('ถอดรหัสเบอร์ PromptPay ไม่สำเร็จ — ข้อมูลถูกแก้ไข หรือคีย์ไม่ตรงกับตอนเข้ารหัส')
  }
}
