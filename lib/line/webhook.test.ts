import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { handleLineWebhook } from './webhook'
import type { LineMessage } from './messages'
import type { ReplyOutcome } from './client'
import type { LineWebhookDeps } from './webhook'

const SECRET = 'test-channel-secret-not-a-real-one'
const GROUP_ID = 'Cffffffffffffffffffffffffffffffff'
const USER_ID = 'Uffffffffffffffffffffffffffffffff'

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body, 'utf8').digest('base64')
}

/** reply ปลอมที่จำทุกครั้งที่ถูกเรียก — เทสต์ยูนิตห้ามยิงเน็ตจริง */
function fakeReply(outcome: ReplyOutcome = { ok: true }) {
  const calls: Array<{ replyToken: string; messages: readonly LineMessage[] }> = []
  const reply = vi.fn(async (replyToken: string, messages: readonly LineMessage[]) => {
    calls.push({ replyToken, messages })
    return outcome
  })
  return { calls, reply }
}

/** ข้อความแรกที่ถูกส่ง ถ้ามันเป็น text — การ์ด Flex ไม่มีฟิลด์ `text` */
function firstText(messages: readonly LineMessage[]): string | null {
  const first = messages[0]
  return first !== undefined && first.type === 'text' ? first.text : null
}

/** DB ปลอม — เทสต์ยูนิตห้ามแตะ Postgres จริง */
function fakeDb(roster: readonly string[] = []) {
  const saved: Array<Parameters<LineWebhookDeps['saveDraft']>[0]> = []
  const loadRoster = vi.fn(async () => roster)
  const saveDraft = vi.fn(async (input: Parameters<LineWebhookDeps['saveDraft']>[0]) => {
    saved.push(input)
    return `draft-${saved.length}`
  })
  return { saved, loadRoster, saveDraft }
}

/** นาฬิกาปลอมที่เดินทีละ 1 ms ทุกครั้งที่ถูกอ่าน — ทำให้ค่าเวลาคาดเดาได้ */
function fakeClock() {
  let t = 0
  return () => ++t
}

function groupText(text: string, replyToken = 'token-1'): unknown {
  return {
    type: 'message',
    replyToken,
    timestamp: 1_787_000_000_000,
    source: { type: 'group', groupId: GROUP_ID, userId: USER_ID },
    message: { id: '1', type: 'text', text },
  }
}

function directText(text: string, replyToken = 'token-1'): unknown {
  return {
    type: 'message',
    replyToken,
    timestamp: 1_787_000_000_000,
    source: { type: 'user', userId: USER_ID },
    message: { id: '1', type: 'text', text },
  }
}

async function run(events: unknown[], outcome?: ReplyOutcome, roster: readonly string[] = []) {
  const body = JSON.stringify({ events })
  const fake = fakeReply(outcome)
  const db = fakeDb(roster)
  const result = await handleLineWebhook(
    { rawBody: body, signature: sign(body), channelSecret: SECRET },
    { reply: fake.reply, loadRoster: db.loadRoster, saveDraft: db.saveDraft, now: fakeClock() },
  )
  return { result, ...fake, ...db }
}

describe('handleLineWebhook — ลายเซ็นไม่ผ่าน', () => {
  it('ตอบ 401 และ **ไม่พูดอะไรออกไปเลย**', async () => {
    const body = '{"events":[]}'
    const { reply } = fakeReply()
    const res = await handleLineWebhook(
      { rawBody: body, signature: 'ปลอม', channelSecret: SECRET },
      { reply, ...fakeDb(), now: fakeClock() },
    )
    expect(res.status).toBe(401)
    expect(reply).not.toHaveBeenCalled()
  })

  it('header หายไปทั้งอัน ก็ 401 ไม่ throw', async () => {
    const { reply } = fakeReply()
    const res = await handleLineWebhook(
      { rawBody: '{}', signature: null, channelSecret: SECRET },
      { reply, ...fakeDb(), now: fakeClock() },
    )
    expect(res.status).toBe(401)
  })

  it('body ถูกแก้หลังเซ็น ก็ 401', async () => {
    const body = '{"events":[]}'
    const { reply } = fakeReply()
    const res = await handleLineWebhook(
      { rawBody: `${body} `, signature: sign(body), channelSecret: SECRET },
      { reply, ...fakeDb(), now: fakeClock() },
    )
    expect(res.status).toBe(401)
  })
})

describe('handleLineWebhook — กฎเงียบของกลุ่ม', () => {
  it('ข้อความคุยกันปกติไม่ถูกตอบ', async () => {
    const { result, reply } = await run([groupText('ไปกินข้าวกันไหม')])
    expect(result.status).toBe(200)
    expect(reply).not.toHaveBeenCalled()
  })

  it('เบอร์โทรที่ขึ้นต้นด้วย + ก็ยังเงียบ', async () => {
    const { reply } = await run([groupText('+66812345678')])
    expect(reply).not.toHaveBeenCalled()
  })

  it('events ว่างไม่ทำอะไร แต่ยัง 200', async () => {
    const { result, reply } = await run([])
    expect(result.status).toBe(200)
    expect(reply).not.toHaveBeenCalled()
  })
})

describe('handleLineWebhook — ตอบเมื่อถูกเรียก', () => {
  it('คำสั่งที่ยังไม่เปิดใช้ได้คำตอบ ไม่ใช่ความเงียบ', async () => {
    const { calls } = await run([groupText('ยอด')])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.replyToken).toBe('token-1')
    expect(firstText(calls[0]?.messages ?? [])).toContain('ยังไม่เปิดใช้')
  })

  it('จดบิลแล้วได้การ์ดกลับมา', async () => {
    const { calls, saved } = await run([groupText('+ ข้าว 1200 กอล์ฟ ตูน')])
    expect(saved).toHaveLength(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.messages[0]?.type).toBe('flex')
  })

  it('แชท 1:1 ตอบไกด์กับข้อความที่ไม่เข้า Trigger', async () => {
    const { calls } = await run([directText('สวัสดีครับ')])
    expect(calls).toHaveLength(1)
    expect(firstText(calls[0]?.messages ?? [])).toContain('บิลใหญ่')
  })

  it('mention บอทเปล่าๆ ในกลุ่มได้ไกด์', async () => {
    const event = {
      type: 'message',
      replyToken: 'token-1',
      timestamp: 1_787_000_000_000,
      source: { type: 'group', groupId: GROUP_ID, userId: USER_ID },
      message: {
        id: '1',
        type: 'text',
        text: '@บิลใหญ่',
        mention: { mentionees: [{ index: 0, length: 8, isSelf: true }] },
      },
    }
    const { calls } = await run([event])
    expect(calls).toHaveLength(1)
    expect(firstText(calls[0]?.messages ?? [])).toContain('บิลใหญ่')
  })

  it('@All ไม่ปลุกบอท และชื่อที่ค้างอยู่ทำให้ไม่ตรงคำสั่งด้วย', async () => {
    const withAll = (text: string) => ({
      type: 'message',
      replyToken: 'token-1',
      timestamp: 1_787_000_000_000,
      source: { type: 'group', groupId: GROUP_ID, userId: USER_ID },
      message: {
        id: '1',
        type: 'text',
        text,
        mention: { mentionees: [{ index: 0, length: 4, type: 'all' }] },
      },
    })
    expect((await run([withAll('@All ปิ้งย่างเมื่อคืน')])).calls).toHaveLength(0)
    expect((await run([withAll('@All ยอด')])).calls).toHaveLength(0)
  })

  it('mention ถึงคนอื่นไม่ถูกตัด — คำสั่งที่ซ่อนอยู่ข้างหลังต้องไม่ถูกปลุก', async () => {
    // `@กอล์ฟ เลิก` คือคนคุยกันเอง ถ้าตัดชื่อออกจะเหลือคำสั่ง `เลิก` พอดี
    const event = {
      type: 'message',
      replyToken: 'token-1',
      timestamp: 1_787_000_000_000,
      source: { type: 'group', groupId: GROUP_ID, userId: USER_ID },
      message: {
        id: '1',
        type: 'text',
        text: '@กอล์ฟ เลิก',
        mention: { mentionees: [{ index: 0, length: 6, type: 'user', userId: 'Uother' }] },
      },
    }
    expect((await run([event])).calls).toHaveLength(0)
  })

  it('เรียกบอทแล้วพิมพ์อะไรที่แปลไม่ออก ต้องได้ไกด์ ไม่ใช่ความเงียบ', async () => {
    const event = {
      type: 'message',
      replyToken: 'token-1',
      timestamp: 1_787_000_000_000,
      source: { type: 'group', groupId: GROUP_ID, userId: USER_ID },
      message: {
        id: '1',
        type: 'text',
        text: '@บิลใหญ่ ช่วยหน่อย',
        mention: { mentionees: [{ index: 0, length: 8, isSelf: true }] },
      },
    }
    const { calls } = await run([event])
    expect(calls).toHaveLength(1)
    expect(firstText(calls[0]?.messages ?? [])).toContain('บิลใหญ่')
  })

  it('postback ยังไม่มีของให้ทำ — เงียบ ไม่ throw', async () => {
    const event = {
      type: 'postback',
      replyToken: 'token-1',
      timestamp: 1_787_000_000_000,
      source: { type: 'group', groupId: GROUP_ID, userId: USER_ID },
      postback: { data: 'confirm=1' },
    }
    const { result, reply } = await run([event])
    expect(result.status).toBe(200)
    expect(reply).not.toHaveBeenCalled()
  })
})

describe('handleLineWebhook — หลาย event ในชุดเดียว', () => {
  it('ตอบทีละ event ด้วย replyToken ของตัวเอง', async () => {
    const { calls } = await run([groupText('ยอด', 'token-a'), groupText('ทวง', 'token-b')])
    expect(calls.map((c) => c.replyToken)).toEqual(['token-a', 'token-b'])
  })

  it('event ที่พังไม่ทำให้อันที่เหลือไม่ถูกตอบ', async () => {
    const broken = { type: 'message', message: { type: 'text', text: 'ยอด' } }
    const { calls } = await run([broken, groupText('ยอด', 'token-b'), null])
    expect(calls.map((c) => c.replyToken)).toEqual(['token-b'])
  })
})

describe('handleLineWebhook — reply พังแล้วยังต้อง 200 (D36)', () => {
  it('ยิงไม่ออกก็ยัง 200 พร้อมบอกสาเหตุกลับไปให้ผู้เรียก log', async () => {
    const { result } = await run([groupText('ยอด')], { ok: false, reason: 'invalid-reply-token' })
    expect(result.status).toBe(200)
    expect(result.replyFailures).toEqual(['invalid-reply-token'])
  })

  it('reply throw ก็ยัง 200 ไม่ปล่อยให้หลุดออกไป', async () => {
    const body = JSON.stringify({ events: [groupText('ยอด')] })
    const reply = vi.fn(async () => {
      throw new Error('เน็ตหลุด')
    })
    const res = await handleLineWebhook(
      { rawBody: body, signature: sign(body), channelSecret: SECRET },
      { reply, ...fakeDb(), now: fakeClock() },
    )
    expect(res.status).toBe(200)
    expect(res.replyFailures).toEqual(['threw'])
  })

  it('สำเร็จหมดก็ไม่มีสาเหตุอะไรค้าง', async () => {
    const { result } = await run([groupText('ยอด')])
    expect(result.replyFailures).toEqual([])
  })
})

describe('handleLineWebhook — ของที่ผู้เรียกต้องใช้ log', () => {
  it('body ที่เซ็นถูกแต่ JSON พัง → 200 พร้อมมาร์กว่าเพี้ยน', async () => {
    const body = 'ไม่ใช่ json'
    const { reply } = fakeReply()
    const res = await handleLineWebhook(
      { rawBody: body, signature: sign(body), channelSecret: SECRET },
      { reply, ...fakeDb(), now: fakeClock() },
    )
    expect(res.status).toBe(200)
    expect(res.malformed).toBe(true)
    expect(reply).not.toHaveBeenCalled()
  })

  it('body ภาษาไทยผ่านด่านลายเซ็นได้', async () => {
    const { result, calls } = await run([groupText('+ ข้าวหมูกรอบ 1200 กอล์ฟ')])
    expect(result.status).toBe(200)
    expect(calls).toHaveLength(1)
  })

  it('คืน retryKey ที่ได้รับกลับไปให้ผู้เรียก log', async () => {
    const body = '{"events":[]}'
    const { reply } = fakeReply()
    const res = await handleLineWebhook(
      {
        rawBody: body,
        signature: sign(body),
        channelSecret: SECRET,
        retryKey: '123e4567-e89b-12d3-a456-426614174000',
      },
      { reply, ...fakeDb(), now: fakeClock() },
    )
    expect(res.retryKey).toBe('123e4567-e89b-12d3-a456-426614174000')
  })

  it('มี totalMs เสมอ', async () => {
    const { result } = await run([])
    expect(result.totalMs).toBeGreaterThan(0)
  })
})

describe('handleLineWebhook — ตั้งค่าผิดต้องดัง', () => {
  it('channel secret ว่าง → throw ออกไปให้ route ตอบ 500', async () => {
    const { reply } = fakeReply()
    await expect(
      handleLineWebhook(
        { rawBody: '{}', signature: 'AAAA', channelSecret: '' },
        { reply, ...fakeDb(), now: fakeClock() },
      ),
    ).rejects.toThrow()
  })
})

describe('handleLineWebhook — เส้นทางสร้าง draft (M5)', () => {
  it('อ่าน Roster ของกลุ่มที่ข้อความมา', async () => {
    const { loadRoster } = await run([groupText('+ ข้าว 1200 กอล์ฟ')])
    expect(loadRoster).toHaveBeenCalledWith(GROUP_ID)
  })

  it('แชท 1:1 ไม่มีกลุ่มให้อ่าน', async () => {
    const { loadRoster, saved } = await run([directText('+ ข้าว 1200 โอ๋ บาส')])
    expect(loadRoster).toHaveBeenCalledWith(null)
    expect(saved[0]?.lineGroupId).toBeNull()
  })

  it('`spentAt` มาจาก timestamp ของ event แปลงเป็นวันไทย (D35)', async () => {
    // 2026-08-30T17:00:00Z = เที่ยงคืนของวันที่ 31 ตามเวลาไทย
    const event = {
      type: 'message',
      replyToken: 'token-1',
      timestamp: Date.parse('2026-08-30T17:00:00Z'),
      source: { type: 'group', groupId: GROUP_ID, userId: USER_ID },
      message: { id: '1', type: 'text', text: '+ ข้าว 1200 กอล์ฟ' },
    }
    const { saved } = await run([event])
    expect(saved[0]?.spentAt).toBe('2026-08-31')
  })

  it('เก็บว่าใครพิมพ์ไว้กับ draft — D26 ให้เฉพาะคนนั้นกดยืนยันได้', async () => {
    const { saved } = await run([groupText('+ ข้าว 1200 กอล์ฟ')])
    expect(saved[0]?.lineUserId).toBe(USER_ID)
  })

  it('ปุ่มบนการ์ดถือ id ของ draft ที่เพิ่งเขียน', async () => {
    const { calls } = await run([groupText('+ ข้าว 1200 กอล์ฟ')])
    expect(JSON.stringify(calls[0]?.messages)).toContain('draft-1')
  })

  it('ไม่ระบุชื่อใครในวงที่ Roster ว่าง → ขอชื่อ ไม่เขียนอะไรลง DB', async () => {
    const { calls, saved } = await run([groupText('+ ข้าว 1200')])
    expect(saved).toHaveLength(0)
    expect(firstText(calls[0]?.messages ?? [])).toContain('ยังไม่รู้จักใครในวงนี้')
  })

  it('Roster ที่มีคนอยู่แล้ว หารให้ครบทุกคนโดยไม่ต้องพิมพ์ชื่อ', async () => {
    const { calls, saved } = await run([groupText('+ ข้าว 1200')], undefined, ['กอล์ฟ', 'ตูน'])
    expect(saved).toHaveLength(1)
    const json = JSON.stringify(calls[0]?.messages)
    expect(json).toContain('กอล์ฟ')
    expect(json).toContain('฿600')
  })

  it('กลุ่มที่ LINE ไม่บอกว่าใครพิมพ์ → บอกตรงๆ ไม่เขียน draft', async () => {
    const event = {
      type: 'message',
      replyToken: 'token-1',
      timestamp: 1_787_000_000_000,
      source: { type: 'group', groupId: GROUP_ID },
      message: { id: '1', type: 'text', text: '+ ข้าว 1200 กอล์ฟ' },
    }
    const { calls, saved } = await run([event])
    expect(saved).toHaveLength(0)
    expect(firstText(calls[0]?.messages ?? [])).toContain('ข้อตกลงการใช้งาน')
  })
})

describe('handleLineWebhook — DB ล่มตอนยังไม่ได้เขียนอะไร (D36)', () => {
  it('อ่าน Roster ไม่ได้ → 500 และไม่พูดอะไรออกไปเลย', async () => {
    const body = JSON.stringify({ events: [groupText('+ ข้าว 1200 กอล์ฟ')] })
    const fake = fakeReply()
    const res = await handleLineWebhook(
      { rawBody: body, signature: sign(body), channelSecret: SECRET },
      {
        reply: fake.reply,
        loadRoster: async () => {
          throw new Error('connection refused')
        },
        saveDraft: async () => 'ไม่ควรถูกเรียก',
        now: fakeClock(),
      },
    )
    expect(res.status).toBe(500)
    expect(fake.reply).not.toHaveBeenCalled()
  })

  it('เขียน draft ไม่ได้ → 500 เช่นกัน', async () => {
    const body = JSON.stringify({ events: [groupText('+ ข้าว 1200 กอล์ฟ')] })
    const fake = fakeReply()
    const res = await handleLineWebhook(
      { rawBody: body, signature: sign(body), channelSecret: SECRET },
      {
        reply: fake.reply,
        loadRoster: async () => [],
        saveDraft: async () => {
          throw new Error('connection refused')
        },
        now: fakeClock(),
      },
    )
    expect(res.status).toBe(500)
    expect(fake.reply).not.toHaveBeenCalled()
  })

  it('event ที่เตรียมสำเร็จยังได้รับคำตอบ ถึงเพื่อนร่วมชุดจะพัง', async () => {
    const body = JSON.stringify({
      events: [groupText('ยอด', 'token-a'), groupText('+ ข้าว 1200 กอล์ฟ', 'token-b')],
    })
    const fake = fakeReply()
    const res = await handleLineWebhook(
      { rawBody: body, signature: sign(body), channelSecret: SECRET },
      {
        reply: fake.reply,
        loadRoster: async () => {
          throw new Error('connection refused')
        },
        saveDraft: async () => 'ไม่ควรถูกเรียก',
        now: fakeClock(),
      },
    )
    // ทิ้งทั้งชุดจะทำให้บิลที่ `saveDraft` สำเร็จไปแล้วมีแถวอยู่ใน DB โดยไม่มี
    // การ์ดให้ใครกด ซึ่งกู้ไม่ได้เลยจนกว่าจะหมดอายุ — แย่กว่าการ์ดโผล่ซ้ำตอน retry
    expect(res.status).toBe(500)
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.replyToken).toBe('token-a')
  })

  it('นับจำนวน event ที่เตรียมไม่สำเร็จกลับไปให้ผู้เรียก log', async () => {
    const body = JSON.stringify({ events: [groupText('+ ข้าว 1200 กอล์ฟ')] })
    const fake = fakeReply()
    const res = await handleLineWebhook(
      { rawBody: body, signature: sign(body), channelSecret: SECRET },
      {
        reply: fake.reply,
        loadRoster: async () => {
          throw new Error('connection refused')
        },
        saveDraft: async () => 'ไม่ควรถูกเรียก',
        now: fakeClock(),
      },
    )
    expect(res.prepareFailed).toBe(1)
  })
})
