import { describe, expect, it } from 'vitest'
import { replyToLine } from './client'
import type { LineTextMessage } from './messages'

const TOKEN = 'access-token-not-a-real-one'
const REPLY_TOKEN = 'ffffffffffffffffffffffffffffffff'
const MESSAGES: LineTextMessage[] = [{ type: 'text', text: 'ยอด' }]

/** fetch ปลอมที่บันทึกสิ่งที่ถูกเรียก แล้วตอบตามที่สั่ง */
function stubFetch(response: Response | Error) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} })
    if (response instanceof Error) throw response
    return response
  }
  return { fn, calls }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('replyToLine — คำขอที่ส่งออกไป', () => {
  it('ยิงไปที่ endpoint ของ LINE ด้วย token และ body ที่ถูกต้อง', async () => {
    const { fn, calls } = stubFetch(new Response('{}', { status: 200 }))
    const outcome = await replyToLine(
      { replyToken: REPLY_TOKEN, messages: MESSAGES, accessToken: TOKEN },
      { fetch: fn },
    )

    expect(outcome).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call?.url).toBe('https://api.line.me/v2/bot/message/reply')
    expect(call?.init.method).toBe('POST')
    const headers = new Headers(call?.init.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(headers.get('content-type')).toBe('application/json')
    expect(JSON.parse(String(call?.init.body))).toEqual({
      replyToken: REPLY_TOKEN,
      messages: MESSAGES,
    })
  })

  it('ตั้ง signal ไว้เสมอ — webhook ค้างรอ LINE คือทางเดียวที่จะพลาด reply token', async () => {
    const { fn, calls } = stubFetch(new Response('{}', { status: 200 }))
    await replyToLine(
      { replyToken: REPLY_TOKEN, messages: MESSAGES, accessToken: TOKEN },
      { fetch: fn },
    )
    expect(calls[0]?.init.signal).toBeDefined()
  })

  it('ไม่มีข้อความให้ส่ง = ไม่ยิงเลย', async () => {
    const { fn, calls } = stubFetch(new Response('{}', { status: 200 }))
    const outcome = await replyToLine(
      { replyToken: REPLY_TOKEN, messages: [], accessToken: TOKEN },
      { fetch: fn },
    )
    expect(outcome).toEqual({ ok: true })
    expect(calls).toHaveLength(0)
  })

  it('เกิน 5 ก้อนไม่ยิง — เป็นบั๊กของเรา ไม่ใช่ของ LINE', async () => {
    const { fn, calls } = stubFetch(new Response('{}', { status: 200 }))
    const many: LineTextMessage[] = Array.from({ length: 6 }, () => ({ type: 'text', text: 'x' }))
    const outcome = await replyToLine(
      { replyToken: REPLY_TOKEN, messages: many, accessToken: TOKEN },
      { fetch: fn },
    )
    expect(outcome).toEqual({ ok: false, reason: 'too-many-messages' })
    expect(calls).toHaveLength(0)
  })
})

describe('replyToLine — แยกความล้มเหลวให้ออกจากกัน', () => {
  it('reply token หมดอายุหรือใช้ไปแล้ว', async () => {
    const { fn } = stubFetch(json(400, { message: 'Invalid reply token' }))
    const outcome = await replyToLine(
      { replyToken: REPLY_TOKEN, messages: MESSAGES, accessToken: TOKEN },
      { fetch: fn },
    )
    expect(outcome).toEqual({ ok: false, reason: 'invalid-reply-token' })
  })

  it('400 เรื่องอื่นไม่ใช่ reply token — คนละสาเหตุ แก้คนละทาง', async () => {
    const { fn } = stubFetch(json(400, { message: 'The property, messages[0].text, may not be empty' }))
    const outcome = await replyToLine(
      { replyToken: REPLY_TOKEN, messages: MESSAGES, accessToken: TOKEN },
      { fetch: fn },
    )
    expect(outcome).toEqual({ ok: false, reason: 'bad-request' })
  })

  it('access token ผิดหรือหมดอายุ', async () => {
    for (const status of [401, 403]) {
      const { fn } = stubFetch(json(status, { message: 'Authentication failed' }))
      const outcome = await replyToLine(
        { replyToken: REPLY_TOKEN, messages: MESSAGES, accessToken: TOKEN },
        { fetch: fn },
      )
      expect(outcome).toEqual({ ok: false, reason: 'unauthorized' })
    }
  })

  it('โดนจำกัดอัตรา', async () => {
    const { fn } = stubFetch(json(429, { message: 'Too Many Requests' }))
    const outcome = await replyToLine(
      { replyToken: REPLY_TOKEN, messages: MESSAGES, accessToken: TOKEN },
      { fetch: fn },
    )
    expect(outcome).toEqual({ ok: false, reason: 'rate-limited' })
  })

  it('ฝั่ง LINE พัง', async () => {
    const { fn } = stubFetch(new Response('oops', { status: 500 }))
    const outcome = await replyToLine(
      { replyToken: REPLY_TOKEN, messages: MESSAGES, accessToken: TOKEN },
      { fetch: fn },
    )
    expect(outcome).toEqual({ ok: false, reason: 'server' })
  })

  it('เน็ตไม่ถึง', async () => {
    const { fn } = stubFetch(new TypeError('fetch failed'))
    const outcome = await replyToLine(
      { replyToken: REPLY_TOKEN, messages: MESSAGES, accessToken: TOKEN },
      { fetch: fn },
    )
    expect(outcome).toEqual({ ok: false, reason: 'network' })
  })

  it('หมดเวลา', async () => {
    const { fn } = stubFetch(new DOMException('อืดเกินไป', 'TimeoutError'))
    const outcome = await replyToLine(
      { replyToken: REPLY_TOKEN, messages: MESSAGES, accessToken: TOKEN },
      { fetch: fn },
    )
    expect(outcome).toEqual({ ok: false, reason: 'timeout' })
  })

  it('body ที่ไม่ใช่ JSON ไม่ทำให้ throw', async () => {
    const { fn } = stubFetch(new Response('<html>bad gateway</html>', { status: 400 }))
    const outcome = await replyToLine(
      { replyToken: REPLY_TOKEN, messages: MESSAGES, accessToken: TOKEN },
      { fetch: fn },
    )
    expect(outcome).toEqual({ ok: false, reason: 'bad-request' })
  })
})
