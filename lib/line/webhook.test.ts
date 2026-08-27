import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { handleLineWebhook } from './webhook'

const SECRET = 'test-channel-secret-not-a-real-one'

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body, 'utf8').digest('base64')
}

/** probe ปลอมที่นับจำนวนครั้งและจำ id ที่ถูกถาม — เทสต์ยูนิตห้ามแตะ DB จริง */
function fakeProbe() {
  const calls: string[] = []
  const probeGroup = vi.fn(async (id: string) => {
    calls.push(id)
    return null
  })
  return { calls, probeGroup }
}

/** นาฬิกาปลอมที่เดินทีละ 1 ms ทุกครั้งที่ถูกอ่าน — ทำให้ค่าเวลาคาดเดาได้ */
function fakeClock() {
  let t = 0
  return () => ++t
}

describe('handleLineWebhook — ลายเซ็นไม่ผ่าน', () => {
  it('ตอบ 401 และ **ไม่แตะ DB**', async () => {
    // ปล่อยให้คนนอกยิงแล้วเราวิ่งไป query ทุกครั้ง = ใครก็ปลุก Supabase free
    // ของเราให้หมดโควตาได้ฟรีๆ ด่านลายเซ็นจึงต้องมาก่อน DB เสมอ
    const { probeGroup, calls } = fakeProbe()

    const res = await handleLineWebhook(
      { rawBody: '{"events":[]}', signature: 'dummy', channelSecret: SECRET },
      { probeGroup, now: fakeClock() },
    )

    expect(res.status).toBe(401)
    expect(probeGroup).not.toHaveBeenCalled()
    expect(calls).toEqual([])
    expect(res.dbMs).toBeNull()
  })

  it('header หายไปทั้งอัน ก็ 401 ไม่ throw', async () => {
    const { probeGroup } = fakeProbe()
    const res = await handleLineWebhook(
      { rawBody: '{}', signature: null, channelSecret: SECRET },
      { probeGroup, now: fakeClock() },
    )
    expect(res.status).toBe(401)
  })

  it('body ถูกแก้หลังเซ็น ก็ 401', async () => {
    const { probeGroup } = fakeProbe()
    const original = '{"events":[],"n":1}'
    const res = await handleLineWebhook(
      { rawBody: '{"events":[],"n":2}', signature: sign(original), channelSecret: SECRET },
      { probeGroup, now: fakeClock() },
    )
    expect(res.status).toBe(401)
  })
})

describe('handleLineWebhook — ลายเซ็นผ่าน', () => {
  it('events ว่างก็ยังแตะ DB หนึ่งครั้ง แล้วตอบ 200', async () => {
    // S4 วัด cold start ของ **ทั้งเส้น** — ถ้า body ว่างแล้วเราข้าม DB
    // ตัวเลขที่วัดได้จะไม่รวมเวลาปลุก Supabase ซึ่งเป็นครึ่งหนึ่งของคำถาม
    const { probeGroup, calls } = fakeProbe()
    const body = '{"destination":"Uxxxx","events":[]}'

    const res = await handleLineWebhook(
      { rawBody: body, signature: sign(body), channelSecret: SECRET },
      { probeGroup, now: fakeClock() },
    )

    expect(res.status).toBe(200)
    expect(probeGroup).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(1)
  })

  it('มี event จากกลุ่ม → probe ด้วย groupId ของกลุ่มนั้น', async () => {
    const { probeGroup, calls } = fakeProbe()
    const body = JSON.stringify({
      events: [
        { type: 'message', source: { type: 'group', groupId: 'Cgroup1', userId: 'Uuser1' } },
      ],
    })

    const res = await handleLineWebhook(
      { rawBody: body, signature: sign(body), channelSecret: SECRET },
      { probeGroup, now: fakeClock() },
    )

    expect(res.status).toBe(200)
    expect(calls).toEqual(['Cgroup1'])
  })

  it('หลาย event หลายกลุ่ม → ยิง DB ครั้งเดียวเท่านั้น', async () => {
    // LINE ส่ง event มาเป็นชุดได้ ถ้า probe ต่อ event เวลาที่วัดจะขึ้นกับ
    // ขนาดชุดที่ส่งมา ไม่ใช่ cold start ที่เรากำลังถาม
    const { probeGroup, calls } = fakeProbe()
    const body = JSON.stringify({
      events: [
        { type: 'message', source: { type: 'group', groupId: 'Cgroup1' } },
        { type: 'message', source: { type: 'group', groupId: 'Cgroup2' } },
        { type: 'join', source: { type: 'group', groupId: 'Cgroup1' } },
      ],
    })

    await handleLineWebhook(
      { rawBody: body, signature: sign(body), channelSecret: SECRET },
      { probeGroup, now: fakeClock() },
    )

    expect(probeGroup).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['Cgroup1'])
  })

  it('event จากแชท 1:1 ไม่มี groupId → ยังตอบ 200 และยัง probe', async () => {
    const { probeGroup, calls } = fakeProbe()
    const body = JSON.stringify({
      events: [{ type: 'message', source: { type: 'user', userId: 'Uuser1' } }],
    })

    const res = await handleLineWebhook(
      { rawBody: body, signature: sign(body), channelSecret: SECRET },
      { probeGroup, now: fakeClock() },
    )

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]).not.toBe('Uuser1') // ห้ามเอา userId ไปถามช่อง line_group_id
  })

  it('source รูปร่างแปลก ไม่ทำให้พัง', async () => {
    const { probeGroup } = fakeProbe()
    for (const events of [
      [{ type: 'message' }],
      [{ type: 'message', source: null }],
      [{ type: 'message', source: { type: 'group' } }],
      [{ type: 'message', source: { type: 'group', groupId: 42 } }],
      'ไม่ใช่ array',
      null,
    ]) {
      const body = JSON.stringify({ events })
      const res = await handleLineWebhook(
        { rawBody: body, signature: sign(body), channelSecret: SECRET },
        { probeGroup, now: fakeClock() },
      )
      expect(res.status).toBe(200)
    }
  })

  it('body ที่เซ็นถูกแต่ JSON พัง → 200 ไม่ throw', async () => {
    // ลายเซ็นผ่านแปลว่า body มาจาก LINE จริง การตอบ non-200 จะทำให้ LINE
    // retry body เดิมที่พังเหมือนเดิมไปเรื่อยๆ โดยไม่มีวันสำเร็จ
    const { probeGroup } = fakeProbe()
    const body = 'not json at all'

    const res = await handleLineWebhook(
      { rawBody: body, signature: sign(body), channelSecret: SECRET },
      { probeGroup, now: fakeClock() },
    )

    expect(res.status).toBe(200)
    expect(res.malformed).toBe(true)
  })

  it('body ภาษาไทยผ่านด่านลายเซ็นได้', async () => {
    const { probeGroup } = fakeProbe()
    const body = JSON.stringify({
      events: [
        {
          type: 'message',
          message: { type: 'text', text: 'หมูกระทะ 1,200 หาร 4 คน' },
          source: { type: 'group', groupId: 'Cgroup1' },
        },
      ],
    })

    const res = await handleLineWebhook(
      { rawBody: body, signature: sign(body), channelSecret: SECRET },
      { probeGroup, now: fakeClock() },
    )

    expect(res.status).toBe(200)
  })
})

describe('handleLineWebhook — DB ล่ม', () => {
  it('probe throw → 500 ไม่ใช่ 200', async () => {
    // 200 ตอนที่เราทำงานไม่สำเร็จ = LINE ทิ้ง event นั้นถาวร บิลที่คนพิมพ์หายเงียบ
    const probeGroup = vi.fn(async () => {
      throw new Error('connection refused')
    })
    const body = '{"events":[]}'

    const res = await handleLineWebhook(
      { rawBody: body, signature: sign(body), channelSecret: SECRET },
      { probeGroup, now: fakeClock() },
    )

    expect(res.status).toBe(500)
    expect(res.dbMs).not.toBeNull()
  })
})

describe('handleLineWebhook — ตัวเลขที่ S4 ต้องใช้', () => {
  it('แยกเวลา DB ออกจากเวลารวมได้', async () => {
    const { probeGroup } = fakeProbe()
    const body = '{"events":[]}'

    const res = await handleLineWebhook(
      { rawBody: body, signature: sign(body), channelSecret: SECRET },
      { probeGroup, now: fakeClock() },
    )

    expect(res.dbMs).toBeGreaterThan(0)
    expect(res.totalMs).toBeGreaterThanOrEqual(res.dbMs ?? 0)
  })

  it('401 มี totalMs แต่ไม่มี dbMs', async () => {
    const { probeGroup } = fakeProbe()
    const res = await handleLineWebhook(
      { rawBody: '{}', signature: 'dummy', channelSecret: SECRET },
      { probeGroup, now: fakeClock() },
    )

    expect(res.dbMs).toBeNull()
    expect(res.totalMs).toBeGreaterThan(0)
  })

  it('คืน retryKey ที่ได้รับกลับไปให้ผู้เรียก log', async () => {
    // ตาราง S4 ถามว่า LINE retry จริงไหม — ดูได้จาก key ซ้ำเท่านั้น
    const { probeGroup } = fakeProbe()
    const body = '{"events":[]}'

    const res = await handleLineWebhook(
      {
        rawBody: body,
        signature: sign(body),
        channelSecret: SECRET,
        retryKey: '123e4567-e89b-12d3-a456-426614174000',
      },
      { probeGroup, now: fakeClock() },
    )

    expect(res.retryKey).toBe('123e4567-e89b-12d3-a456-426614174000')
  })
})

describe('handleLineWebhook — ตั้งค่าผิดต้องดัง', () => {
  it('channel secret ว่าง → throw ออกไปให้ route ตอบ 500', async () => {
    const { probeGroup } = fakeProbe()
    await expect(
      handleLineWebhook(
        { rawBody: '{}', signature: 'AAAA', channelSecret: '' },
        { probeGroup, now: fakeClock() },
      ),
    ).rejects.toThrow()
  })
})
