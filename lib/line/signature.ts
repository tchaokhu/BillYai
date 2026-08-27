/**
 * ตรวจ `X-Line-Signature` ของ webhook — adapter ของ LINE ไม่ใช่ domain core
 *
 * LINE เซ็น **raw body** ด้วย channel secret เป็น HMAC-SHA256 แล้วส่ง base64 มาใน
 * header ผู้รับต้องแฮชไบต์ชุดเดียวกันเป๊ะ ดังนั้นห้าม `JSON.parse` แล้ว
 * `JSON.stringify` กลับก่อนตรวจ — key order กับ whitespace เปลี่ยนแล้วแฮชเปลี่ยน
 *
 * ฟังก์ชันนี้**ไม่อ่าน `process.env` เอง** ผู้เรียกเป็นคนหา secret มาให้ เพื่อให้
 * เทสต์ยูนิตรันได้โดยไม่ต้องมี env จริง และเพื่อให้มีที่อ่าน env ที่เดียวคือ route
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** SHA-256 → ไดเจสต์ 32 ไบต์เสมอ */
const DIGEST_BYTES = 32

/**
 * `true` เมื่อ body นี้ถูกเซ็นด้วย channel secret นี้จริง
 *
 * header ที่ผิดรูปทุกแบบคืน `false` — คนนอกที่ยิงมั่วไม่ควรทำให้ route กลายเป็น 500
 * ซึ่งจะทำให้ LINE เข้าใจว่าเราล่มแล้ว retry ซ้ำ
 *
 * @param rawBody  ไบต์ที่มาจริงจาก request — `req.text()` หรือ Buffer ดิบ
 * @param signature ค่า header `x-line-signature` (รับ null/undefined ได้)
 * @param channelSecret  channel secret ของ Messaging API channel
 * @throws ถ้า `channelSecret` ว่าง — นั่นคือ env ไม่ได้ตั้ง ไม่ใช่ลายเซ็นไม่ผ่าน
 */
export function verifyLineSignature(
  rawBody: string | Buffer,
  signature: string | null | undefined,
  channelSecret: string,
): boolean {
  if (channelSecret.length === 0) {
    throw new Error('ไม่ได้ตั้ง LINE_CHANNEL_SECRET — ดู .env.local.example')
  }

  if (typeof signature !== 'string') return false

  const received = Buffer.from(signature, 'base64')

  // ยาวไม่เท่าไดเจสต์ = ไม่ใช่ลายเซ็นแน่นอน · ต้องกันตรงนี้ก่อนถึง
  // `timingSafeEqual` ซึ่ง**โยน error** เมื่อสองฝั่งยาวไม่เท่ากัน
  if (received.length !== DIGEST_BYTES) return false

  // `Buffer.from(s,'base64')` **ข้ามอักขระที่ไม่ใช่ base64 เงียบๆ** สตริงที่มี
  // ช่องว่างหรือขยะแทรกจึงถอดออกมาได้ 32 ไบต์ชุดเดียวกับของจริง การเข้ารหัสกลับ
  // แล้วเทียบตัวต่อตัวคือด่านที่บังคับว่า header ต้องเป็น**ค่าที่ LINE ส่งมาเป๊ะ**
  // ไม่ใช่แค่ค่าที่ถอดแล้วบังเอิญตรง (base64url ก็ตกด่านนี้ ซึ่งถูกแล้ว)
  if (received.toString('base64') !== signature) return false

  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody
  const expected = createHmac('sha256', channelSecret).update(body).digest()

  // ความยาวเท่ากันแน่แล้วจากสองด่านบน — `timingSafeEqual` โยน error ถ้าไม่เท่า
  return timingSafeEqual(expected, received)
}
