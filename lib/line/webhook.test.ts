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
function fakeDb(roster: readonly string[] = [], payerName: string | null = null) {
  const saved: Array<Parameters<LineWebhookDeps['saveDraft']>[0]> = []
  const viewed: Array<{ lineGroupId: string | null; lineUserId: string }> = []
  const confirmed: Array<Parameters<LineWebhookDeps['confirmDraft']>[0]> = []
  const loadGroupView = vi.fn(async (lineGroupId: string | null, lineUserId: string) => {
    viewed.push({ lineGroupId, lineUserId })
    return {
      roster,
      payerName,
      unclaimed: roster.map((name, i) => ({ id: `member-${i}`, name })),
    }
  })
  const saveDraft = vi.fn(async (input: Parameters<LineWebhookDeps['saveDraft']>[0]) => {
    saved.push(input)
    return `draft-${saved.length}`
  })
  const confirmDraft = vi.fn<LineWebhookDeps['confirmDraft']>(async (input) => {
    confirmed.push(input)
    return { kind: 'committed', description: 'ข้าว', totalSatang: 120000 }
  })
  const fetchDisplayName = vi.fn<LineWebhookDeps['fetchDisplayName']>(async () => 'ชื่อจาก LINE')
  const loadBalance = vi.fn<LineWebhookDeps['loadBalance']>(async () => 'no-bills')
  const loadBillList = vi.fn<LineWebhookDeps['loadBillList']>(async () => 'no-bills')
  /** ทุกคำขอรายละเอียด — ใช้ตรวจว่าวงกับคนกดถูกส่งไปให้ repo จริง */
  const detailAsked: Array<Parameters<LineWebhookDeps['loadBillDetail']>[0]> = []
  const loadBillDetail = vi.fn<LineWebhookDeps['loadBillDetail']>(async (input) => {
    detailAsked.push(input)
    return 'not-found'
  })
  return {
    saved,
    viewed,
    confirmed,
    detailAsked,
    loadGroupView,
    saveDraft,
    confirmDraft,
    fetchDisplayName,
    loadBalance,
    loadBillList,
    loadBillDetail,
  }
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

/**
 * ข้อความในกลุ่มที่ **เรียกบอทตรงๆ** — คีย์เวิร์ดในกลุ่มต้องมาแบบนี้ตั้งแต่ D47
 *
 * `isSelf` เป็นของที่ LINE ตัดสินให้ ไม่ใช่การเทียบชื่อในข้อความ · ความยาว 8
 * คือ `@บิลใหญ่` พอดี ซึ่ง adapter จะตัดออกก่อนส่งเข้า parser
 */
function groupCommand(text: string, replyToken = 'token-1'): unknown {
  return {
    type: 'message',
    replyToken,
    timestamp: 1_787_000_000_000,
    source: { type: 'group', groupId: GROUP_ID, userId: USER_ID },
    message: {
      id: '1',
      type: 'text',
      text: `@บิลใหญ่ ${text}`,
      mention: { mentionees: [{ index: 0, length: 8, isSelf: true }] },
    },
  }
}

function postback(data: string, replyToken = 'token-1'): unknown {
  return {
    type: 'postback',
    replyToken,
    timestamp: 1_787_000_000_000,
    source: { type: 'group', groupId: GROUP_ID, userId: USER_ID },
    postback: { data },
  }
}

async function run(
  events: unknown[],
  outcome?: ReplyOutcome,
  roster: readonly string[] = [],
  /** ทับ dependency ทีละตัวสำหรับเคสที่ของปลอมมาตรฐานตอบไม่ตรง */
  overrides: Partial<LineWebhookDeps> = {},
) {
  const body = JSON.stringify({ events })
  const fake = fakeReply(outcome)
  const db = fakeDb(roster)
  const result = await handleLineWebhook(
    { rawBody: body, signature: sign(body), channelSecret: SECRET },
    {
      reply: fake.reply,
      loadGroupView: db.loadGroupView,
      saveDraft: db.saveDraft,
      confirmDraft: db.confirmDraft,
      fetchDisplayName: db.fetchDisplayName,
      loadBalance: db.loadBalance,
      loadBillList: db.loadBillList,
      loadBillDetail: db.loadBillDetail,
      now: fakeClock(),
      ...overrides,
    },
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
    const { calls } = await run([groupCommand('ทวง')])
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

  it('postback ที่ไม่ใช่ของเรา — เงียบ ไม่เดาว่าเป็นอะไร', async () => {
    const { result, reply } = await run([postback('อะไรก็ไม่รู้')])
    expect(result.status).toBe(200)
    expect(reply).not.toHaveBeenCalled()
  })
})

describe('handleLineWebhook — หลาย event ในชุดเดียว', () => {
  it('ตอบทีละ event ด้วย replyToken ของตัวเอง', async () => {
    const { calls } = await run([groupCommand('ยอด', 'token-a'), groupCommand('ทวง', 'token-b')])
    expect(calls.map((c) => c.replyToken)).toEqual(['token-a', 'token-b'])
  })

  it('event ที่พังไม่ทำให้อันที่เหลือไม่ถูกตอบ', async () => {
    const broken = { type: 'message', message: { type: 'text', text: 'ยอด' } }
    const { calls } = await run([broken, groupCommand('ยอด', 'token-b'), null])
    expect(calls.map((c) => c.replyToken)).toEqual(['token-b'])
  })
})

describe('handleLineWebhook — reply พังแล้วยังต้อง 200 (D36)', () => {
  it('ยิงไม่ออกก็ยัง 200 พร้อมบอกสาเหตุกลับไปให้ผู้เรียก log', async () => {
    const { result } = await run([groupCommand('ยอด')], { ok: false, reason: 'invalid-reply-token' })
    expect(result.status).toBe(200)
    expect(result.replyFailures).toEqual(['invalid-reply-token'])
  })

  it('reply throw ก็ยัง 200 ไม่ปล่อยให้หลุดออกไป', async () => {
    const body = JSON.stringify({ events: [groupCommand('ยอด')] })
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
    const { result } = await run([groupCommand('ยอด')])
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
  it('อ่านวงของกลุ่มที่ข้อความมา พร้อมบอกว่าใครถาม', async () => {
    const { viewed } = await run([groupText('+ ข้าว 1200 กอล์ฟ')])
    expect(viewed).toEqual([{ lineGroupId: GROUP_ID, lineUserId: USER_ID }])
  })

  it('แชท 1:1 ไม่มีกลุ่มให้อ่าน', async () => {
    const { viewed, saved } = await run([directText('+ ข้าว 1200 โอ๋ บาส')])
    expect(viewed[0]?.lineGroupId).toBeNull()
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

  it('Roster ที่มีคนอยู่แล้ว หารให้ครบทุกคน รวมคนพิมพ์ที่ยังไม่ยืนยันตัวตน', async () => {
    const { calls, saved } = await run([groupText('+ ข้าว 1200')], undefined, ['กอล์ฟ', 'ตูน'])
    expect(saved).toHaveLength(1)
    const json = JSON.stringify(calls[0]?.messages)
    expect(json).toContain('กอล์ฟ')
    // กอล์ฟ + ตูน + คนพิมพ์ = 3 คน
    expect(json).toContain('฿400')
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
        loadGroupView: async () => {
          throw new Error('connection refused')
        },
        saveDraft: async () => 'ไม่ควรถูกเรียก',
        confirmDraft: async () => ({ kind: 'gone' as const }),
        fetchDisplayName: async () => null,
        loadBalance: async () => 'no-bills' as const,
      loadBillList: async () => 'no-bills' as const,
      loadBillDetail: async () => 'not-found' as const,
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
        loadGroupView: async () => ({ roster: [], payerName: null, unclaimed: [] }),
        saveDraft: async () => {
          throw new Error('connection refused')
        },
        confirmDraft: async () => ({ kind: 'gone' as const }),
        fetchDisplayName: async () => null,
        loadBalance: async () => 'no-bills' as const,
      loadBillList: async () => 'no-bills' as const,
      loadBillDetail: async () => 'not-found' as const,
        now: fakeClock(),
      },
    )
    expect(res.status).toBe(500)
    expect(fake.reply).not.toHaveBeenCalled()
  })

  it('event ที่เตรียมสำเร็จยังได้รับคำตอบ ถึงเพื่อนร่วมชุดจะพัง', async () => {
    const body = JSON.stringify({
      events: [groupCommand('ยอด', 'token-a'), groupText('+ ข้าว 1200 กอล์ฟ', 'token-b')],
    })
    const fake = fakeReply()
    const res = await handleLineWebhook(
      { rawBody: body, signature: sign(body), channelSecret: SECRET },
      {
        reply: fake.reply,
        loadGroupView: async () => {
          throw new Error('connection refused')
        },
        saveDraft: async () => 'ไม่ควรถูกเรียก',
        confirmDraft: async () => ({ kind: 'gone' as const }),
        fetchDisplayName: async () => null,
        loadBalance: async () => 'no-bills' as const,
      loadBillList: async () => 'no-bills' as const,
      loadBillDetail: async () => 'not-found' as const,
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
        loadGroupView: async () => {
          throw new Error('connection refused')
        },
        saveDraft: async () => 'ไม่ควรถูกเรียก',
        confirmDraft: async () => ({ kind: 'gone' as const }),
        fetchDisplayName: async () => null,
        loadBalance: async () => 'no-bills' as const,
      loadBillList: async () => 'no-bills' as const,
      loadBillDetail: async () => 'not-found' as const,
        now: fakeClock(),
      },
    )
    expect(res.prepareFailed).toBe(1)
  })
})

describe('handleLineWebhook — กดยืนยัน (M6)', () => {
  const DRAFT_ID = '4f1c2a5e-0000-4000-8000-000000000001'

  it('กดปุ่มยืนยันเปล่าๆ ส่งต่อไปโดยไม่มีตัวตนแนบมา', async () => {
    const { confirmed, calls } = await run([postback(`confirm=${DRAFT_ID}`)])
    expect(confirmed).toEqual([{ draftId: DRAFT_ID, lineUserId: USER_ID }])
    expect(firstText(calls[0]?.messages ?? [])).toContain('จดแล้ว')
  })

  it('เลือกชื่อที่มีอยู่แล้ว ส่ง member id ไปให้', async () => {
    const { confirmed } = await run([postback(`confirm=${DRAFT_ID}&as=member-0`)])
    expect(confirmed[0]?.payer).toEqual({ kind: 'member', memberId: 'member-0' })
  })

  it('กด "ฉันเป็นคนใหม่" ตรวจว่าใครกดก่อน แล้วค่อยดึงชื่อจาก LINE', async () => {
    const body = JSON.stringify({ events: [postback(`confirm=${DRAFT_ID}&as=new`)] })
    const fake = fakeReply()
    const db = fakeDb()
    db.confirmDraft
      .mockResolvedValueOnce({ kind: 'needs-identity' })
      .mockResolvedValueOnce({ kind: 'committed', description: 'ข้าว', totalSatang: 120000 })

    await handleLineWebhook(
      { rawBody: body, signature: sign(body), channelSecret: SECRET },
      { reply: fake.reply, ...db, now: fakeClock() },
    )

    // `mockResolvedValueOnce` แทนที่ implementation ทั้งอัน จึงอ่านจาก mock.calls
    // ไม่ใช่จาก array ที่ implementation เดิมเก็บไว้
    const calls = db.confirmDraft.mock.calls
    // รอบแรกไม่มีตัวตนแนบไป — เป็นด่านตรวจว่าใครกด ไม่ใช่การลงบิล
    expect(calls[0]?.[0].payer).toBeUndefined()
    expect(db.fetchDisplayName).toHaveBeenCalledWith(GROUP_ID, USER_ID)
    expect(calls[1]?.[0].payer).toEqual({ kind: 'new', displayName: 'ชื่อจาก LINE' })
    expect(firstText(fake.calls[0]?.messages ?? [])).toContain('จดแล้ว')
  })

  it('คนอื่นกด "ฉันเป็นคนใหม่" บนการ์ดของเรา — ไม่เผา API call ทิ้ง (D26)', async () => {
    const body = JSON.stringify({ events: [postback(`confirm=${DRAFT_ID}&as=new`)] })
    const fake = fakeReply()
    const db = fakeDb()
    db.confirmDraft.mockResolvedValue({ kind: 'not-yours' })

    await handleLineWebhook(
      { rawBody: body, signature: sign(body), channelSecret: SECRET },
      { reply: fake.reply, ...db, now: fakeClock() },
    )
    expect(db.fetchDisplayName).not.toHaveBeenCalled()
    expect(fake.reply).not.toHaveBeenCalled()
  })

  it('ดึงชื่อจาก LINE ไม่ได้ → บอกตรงๆ และไม่ลงบิล', async () => {
    const body = JSON.stringify({ events: [postback(`confirm=${DRAFT_ID}&as=new`)] })
    const fake = fakeReply()
    const db = fakeDb()
    db.confirmDraft.mockResolvedValue({ kind: 'needs-identity' })
    db.fetchDisplayName.mockResolvedValue(null)
    await handleLineWebhook(
      { rawBody: body, signature: sign(body), channelSecret: SECRET },
      { reply: fake.reply, ...db, now: fakeClock() },
    )
    // เรียกได้แค่รอบตรวจสิทธิ์ ไม่มีรอบที่ลงบิล
    expect(db.confirmDraft).toHaveBeenCalledTimes(1)
    expect(firstText(fake.calls[0]?.messages ?? [])).toContain('ดึงชื่อของคุณจาก LINE ไม่ได้')
  })

  it('คนอื่นกดการ์ดของเรา — **เงียบ** ไม่ประกาศว่าไม่มีสิทธิ์ (D26)', async () => {
    const body = JSON.stringify({ events: [postback(`confirm=${DRAFT_ID}`)] })
    const fake = fakeReply()
    const db = fakeDb()
    db.confirmDraft.mockResolvedValue({ kind: 'not-yours' })
    const res = await handleLineWebhook(
      { rawBody: body, signature: sign(body), channelSecret: SECRET },
      { reply: fake.reply, ...db, now: fakeClock() },
    )
    expect(res.status).toBe(200)
    expect(fake.reply).not.toHaveBeenCalled()
  })

  it.each([
    ['gone', 'ใช้ไม่ได้แล้ว'],
    ['needs-identity', 'เลือกชื่อของคุณ'],
  ] as const)('ผล %s ได้คำตอบที่บอกว่าต้องทำอะไรต่อ', async (kind, expected) => {
    const body = JSON.stringify({ events: [postback(`confirm=${DRAFT_ID}`)] })
    const fake = fakeReply()
    const db = fakeDb()
    db.confirmDraft.mockResolvedValue({ kind })
    await handleLineWebhook(
      { rawBody: body, signature: sign(body), channelSecret: SECRET },
      { reply: fake.reply, ...db, now: fakeClock() },
    )
    expect(firstText(fake.calls[0]?.messages ?? [])).toContain(expected)
  })

  it('ชื่อชนกับคนอื่น — บอกชื่อที่ชนกลับไปด้วย', async () => {
    const body = JSON.stringify({ events: [postback(`confirm=${DRAFT_ID}&as=member-0`)] })
    const fake = fakeReply()
    const db = fakeDb()
    db.confirmDraft.mockResolvedValue({ kind: 'name-taken', name: 'กอล์ฟ' })
    await handleLineWebhook(
      { rawBody: body, signature: sign(body), channelSecret: SECRET },
      { reply: fake.reply, ...db, now: fakeClock() },
    )
    expect(firstText(fake.calls[0]?.messages ?? [])).toContain('กอล์ฟ')
  })

  it('การ์ดของคนที่ยังไม่ยืนยันตัวตนมีแถวเลือกตัวตน', async () => {
    const { calls } = await run([groupText('+ ข้าว 1200 กอล์ฟ')], undefined, ['ตูน'])
    const message = calls[0]?.messages[0]
    expect(message?.type).toBe('flex')
    expect(JSON.stringify(message)).toContain('ฉันเป็นคนใหม่')
  })

  it('การ์ดของคนที่ยืนยันตัวตนแล้วไม่มีแถวนั้น', async () => {
    const body = JSON.stringify({ events: [groupText('+ ข้าว 1200 กอล์ฟ')] })
    const fake = fakeReply()
    const db = fakeDb(['ตูน'], 'ตูน')
    await handleLineWebhook(
      { rawBody: body, signature: sign(body), channelSecret: SECRET },
      { reply: fake.reply, ...db, now: fakeClock() },
    )
    expect(JSON.stringify(fake.calls[0]?.messages)).not.toContain('ฉันเป็นคนใหม่')
  })
})

describe('handleLineWebhook — `ยอด` (M7)', () => {
  it('วงที่ยังไม่เคยจดบิลตอบไกด์ ไม่ใช่ตอบว่ายอดเป็นศูนย์', async () => {
    const { calls, loadBalance } = await run([groupCommand('ยอด')])
    expect(loadBalance).toHaveBeenCalledWith(GROUP_ID, USER_ID)
    expect(firstText(calls[0]?.messages ?? [])).toContain('บิลใหญ่ช่วยจด')
  })

  it('เคลียร์กันหมดแล้วบอกตรงๆ — ไม่ใช่ตอบไกด์ซ้ำ', async () => {
    const body = JSON.stringify({ events: [groupCommand('ยอด')] })
    const fake = fakeReply()
    const db = fakeDb()
    db.loadBalance.mockResolvedValue({ kind: 'settled' })
    await handleLineWebhook(
      { rawBody: body, signature: sign(body), channelSecret: SECRET },
      { reply: fake.reply, ...db, now: fakeClock() },
    )
    expect(firstText(fake.calls[0]?.messages ?? [])).toContain('ไม่มีใครติดใคร')
  })

  it('มีหนี้แล้วได้การ์ดจัดกลุ่มตามเจ้าหนี้', async () => {
    const body = JSON.stringify({ events: [groupCommand('ยอด')] })
    const fake = fakeReply()
    const db = fakeDb()
    db.loadBalance.mockResolvedValue({
      kind: 'debts',
      blocks: [
        {
          creditorName: 'กอล์ฟ',
          totalSatang: 90000,
          rows: [
            { debtorName: 'ตูน', amountSatang: 60000 },
            { debtorName: 'เบียร์', amountSatang: 30000 },
          ],
        },
      ],
    })
    await handleLineWebhook(
      { rawBody: body, signature: sign(body), channelSecret: SECRET },
      { reply: fake.reply, ...db, now: fakeClock() },
    )
    const message = fake.calls[0]?.messages[0]
    expect(message?.type).toBe('flex')
    const json = JSON.stringify(message)
    expect(json).toContain('กอล์ฟ ได้คืน')
    expect(json).toContain('฿600')
    expect(json).toContain('฿300')
  })

  it('`ยอด` ใน 1:1 อ่านวงส่วนตัว', async () => {
    const { loadBalance } = await run([directText('ยอด')])
    expect(loadBalance).toHaveBeenCalledWith(null, USER_ID)
  })

  it('`ยอด #tag` ยังไม่เปิดใช้ ไม่แตะ ledger เลย (D34)', async () => {
    const { calls, loadBalance } = await run([groupCommand('ยอด #เชียงใหม่')])
    expect(loadBalance).not.toHaveBeenCalled()
    expect(firstText(calls[0]?.messages ?? [])).toContain('ยังไม่เปิดใช้')
  })
})

describe('handleLineWebhook — `บิล` (M8 / D45)', () => {
  const BILLS = {
    bills: [
      { id: 'e1', description: 'ตี๋น้อย', spentAt: '2026-09-01', totalSatang: 90000 },
      { id: 'e2', description: 'ข้าว', spentAt: '2026-08-31', totalSatang: 30000 },
    ],
    totalCount: 23,
  } as const

  it('วงที่ยังไม่เคยจดบิลตอบไกด์ ไม่ใช่ตอบรายการว่าง', async () => {
    const { calls } = await run([groupCommand('บิล')])
    expect(firstText(calls[0]?.messages ?? [])).toContain('+ ข้าว 1200')
  })

  it('มีบิลแล้วได้การ์ดรายการ พร้อมบอกจำนวนที่ไม่ได้แสดง', async () => {
    const { calls } = await run([groupCommand('บิล')], undefined, [], {
      loadBillList: async () => BILLS,
    })
    const message = calls[0]?.messages[0]
    expect(message?.type).toBe('flex')
    const json = JSON.stringify(message)
    expect(json).toContain('ตี๋น้อย')
    expect(json).toContain('bill=e1')
    // 23 ทั้งหมด แสดง 2 → เหลือ 21 ที่ต้องบอก ห้ามตัดเงียบ (D31/D44)
    expect(json).toContain('21')
  })

  it('อ่านรายการด้วยวงกับคนที่ถามจริง — 1:1 ส่ง `null` เป็นวง', async () => {
    const asked: Array<[string | null, string]> = []
    await run([directText('บิล')], undefined, [], {
      loadBillList: async (lineGroupId, lineUserId) => {
        asked.push([lineGroupId, lineUserId])
        return BILLS
      },
    })
    expect(asked).toEqual([[null, USER_ID]])
  })

  it('`บิล` เปล่าๆ ในกลุ่มไม่แตะ DB เลย (D47)', async () => {
    const { reply, loadBillList } = await run([groupText('บิล')])
    expect(loadBillList).not.toHaveBeenCalled()
    expect(reply).not.toHaveBeenCalled()
  })

  it('ไม่รู้ว่าใครพิมพ์ก็หาวงส่วนตัวไม่ได้ — บอกสาเหตุ ไม่ใช่ตอบไกด์', async () => {
    // LINE ไม่ส่ง `userId` มาเมื่อคนพิมพ์ยังไม่ยอมรับข้อตกลงบัญชีทางการ — เกิดในกลุ่ม
    const { calls, loadBillList } = await run([
      {
        type: 'message',
        replyToken: 'token-1',
        timestamp: 1_787_000_000_000,
        source: { type: 'group', groupId: GROUP_ID },
        message: {
          id: '1',
          type: 'text',
          text: '@บิลใหญ่ บิล',
          mention: { mentionees: [{ index: 0, length: 8, isSelf: true }] },
        },
      },
    ])
    expect(loadBillList).not.toHaveBeenCalled()
    expect(firstText(calls[0]?.messages ?? [])).toContain('ข้อตกลง')
  })
})

describe('handleLineWebhook — กดแถวในรายการบิล', () => {
  const DETAIL = {
    description: 'ตี๋น้อย',
    spentAt: '2026-09-01',
    totalSatang: 90000,
    lines: [
      { name: 'นัท', amountSatang: 30000, isPayer: true },
      { name: 'เดียร์', amountSatang: 60000, isPayer: false },
    ],
  } as const

  it('ได้การ์ดรายละเอียดของใบนั้น', async () => {
    const { calls } = await run([postback('bill=e1')], undefined, [], {
      loadBillDetail: async () => DETAIL,
    })
    const json = JSON.stringify(calls[0]?.messages[0])
    expect(json).toContain('ตี๋น้อย')
    expect(json).toContain('1 ก.ย. 69')
    expect(json).toContain('เดียร์')
  })

  it('ส่งวงกับคนกดไปให้ repo ด้วย — id เดี่ยวๆ ไม่พอที่จะให้สิทธิ์ดู', async () => {
    // การ์ด `บิล` ลอยอยู่ในแชทได้ตลอดกาล และ postback data ปลอมได้ · ด่านที่กัน
    // การดูข้ามวงอยู่ที่ repo ซึ่งจะทำงานไม่ได้เลยถ้าไม่รู้ว่าใครกดจากวงไหน
    const { detailAsked } = await run([postback('bill=e1')])
    expect(detailAsked).toEqual([{ expenseId: 'e1', lineGroupId: GROUP_ID, lineUserId: USER_ID }])
  })

  it('บิลที่ไม่มีในวงนี้ตอบว่าหาไม่เจอ — ไม่บอกว่ามีอยู่ที่อื่น', async () => {
    const { calls } = await run([postback('bill=e1')], undefined, [], {
      loadBillDetail: async () => 'not-found',
    })
    const text = firstText(calls[0]?.messages ?? [])
    expect(text).toContain('ไม่เจอ')
  })

  it('บิลที่ถูกยกเลิกบอกว่ายกเลิก ไม่ใช่เงียบ และไม่ใช่โชว์ยอดเก่า', async () => {
    const { calls } = await run([postback('bill=e1')], undefined, [], {
      loadBillDetail: async () => 'voided',
    })
    const text = firstText(calls[0]?.messages ?? [])
    expect(text).toContain('ยกเลิก')
    expect(text).not.toContain('900')
  })

  it('`bill=` ที่ไม่มี id ไม่ใช่ postback ของเรา — เงียบ ไม่เดา', async () => {
    const { reply, loadBillDetail } = await run([postback('bill=')])
    expect(loadBillDetail).not.toHaveBeenCalled()
    expect(reply).not.toHaveBeenCalled()
  })

  it('`confirm=` ยังทำงานเหมือนเดิม — สอง key แยกกันได้', async () => {
    const { confirmed } = await run([postback('confirm=draft-1')])
    expect(confirmed).toHaveLength(1)
  })
})
