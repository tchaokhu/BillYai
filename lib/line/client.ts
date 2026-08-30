/**
 * ยิง reply API ของ LINE — ช่องทางเดียวที่บอทพูดออกไปใน Phase 1
 *
 * reply **ฟรีไม่จำกัด ไม่กินโควตา 300 ข้อความ/เดือน** (C2/C3) ต่างจาก push
 * ทั้งระบบจึงเดินผ่านฟังก์ชันนี้ทางเดียว
 *
 * `fetch` กับ access token ฉีดเข้ามาเป็นพารามิเตอร์ ไม่อ่าน `process.env` เอง
 * และไม่ยิงเน็ตตอนเทสต์ — กติกาเดียวกับ `readChannelSecret`
 *
 * **ไม่ log อะไรในไฟล์นี้** ทั้ง access token และ `replyToken` เป็นของที่ยิงซ้ำได้
 * ผู้เรียกเป็นคน log ผลลัพธ์ที่คืนไป ซึ่งเป็นค่าคงที่ ไม่มีข้อมูลใคร
 */

import type { LineTextMessage } from './messages'

const REPLY_ENDPOINT = 'https://api.line.me/v2/bot/message/reply'

/** LINE รับได้สูงสุด 5 ก้อนต่อหนึ่ง reply */
const MAX_MESSAGES = 5

const DEFAULT_TIMEOUT_MS = 3000

export interface ReplyRequest {
  replyToken: string
  messages: readonly LineTextMessage[]
  accessToken: string
}

export interface ReplyDeps {
  fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>
  timeoutMs?: number
}

/**
 * สาเหตุที่แยกกันเพราะ**แก้คนละทาง** — reply token หมดอายุแปลว่าเราช้าเกินไป
 * ส่วน `unauthorized` แปลว่า access token ผิด ซึ่งไม่มีทางหายเองด้วยการรอ
 */
export type ReplyOutcome =
  | { ok: true }
  | {
      ok: false
      reason:
        | 'invalid-reply-token'
        | 'bad-request'
        | 'unauthorized'
        | 'rate-limited'
        | 'server'
        | 'network'
        | 'timeout'
        | 'too-many-messages'
        /**
         * ไม่ได้ตั้ง `LINE_CHANNEL_ACCESS_TOKEN` — ผู้เรียกเป็นคนคืนค่านี้เอง
         * ไม่ใช่ฟังก์ชันนี้ · อยู่ในชนิดเดียวกันเพราะมันคือผลของ "พยายามพูด"
         * เหมือนกัน และเป็นสาเหตุเดียวที่ route ต้องยกระดับเป็น 500
         */
        | 'no-access-token'
    }

/** LINE ตอบ `{"message":"Invalid reply token"}` ทั้งกรณีหมดอายุและกรณีใช้ไปแล้ว */
async function isInvalidReplyToken(response: Response): Promise<boolean> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    // ตอบไม่ใช่ JSON ได้จริงเมื่อโดน proxy หรือ gateway คั่นกลาง
    return false
  }
  if (typeof body !== 'object' || body === null) return false
  const { message } = body as { message?: unknown }
  return message === 'Invalid reply token'
}

export async function replyToLine(req: ReplyRequest, deps: ReplyDeps): Promise<ReplyOutcome> {
  // ไม่มีอะไรจะพูด = ไม่ต้องยิง · ต่างจากส่งข้อความว่าง ซึ่ง LINE ปฏิเสธ
  if (req.messages.length === 0) return { ok: true }
  if (req.messages.length > MAX_MESSAGES) return { ok: false, reason: 'too-many-messages' }

  let response: Response
  try {
    response = await deps.fetch(REPLY_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${req.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ replyToken: req.replyToken, messages: req.messages }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    return { ok: false, reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' }
  }

  if (response.ok) return { ok: true }

  if (response.status === 400) {
    return {
      ok: false,
      reason: (await isInvalidReplyToken(response)) ? 'invalid-reply-token' : 'bad-request',
    }
  }
  if (response.status === 401 || response.status === 403) return { ok: false, reason: 'unauthorized' }
  if (response.status === 429) return { ok: false, reason: 'rate-limited' }
  return { ok: false, reason: 'server' }
}
