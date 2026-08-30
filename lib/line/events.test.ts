import { describe, expect, it } from 'vitest'
import { parseLineEvents } from './events'

/**
 * ตัวอย่าง payload เขียนตามรูปร่างที่เอกสาร LINE ระบุ — id ทั้งหมดเป็นของปลอม
 * (repo เป็น public ห้ามมี `groupId`/`userId` จริง) แต่ขึ้นต้นด้วยตัวอักษรเดียวกับ
 * ของจริง เพื่อไม่ให้เผลอเขียนเงื่อนไขที่ผูกกับรูปแบบของ id
 */
const GROUP_ID = 'Cffffffffffffffffffffffffffffffff'
const USER_ID = 'Uffffffffffffffffffffffffffffffff'
const REPLY_TOKEN = 'ffffffffffffffffffffffffffffffff'
const TS = 1_787_000_000_000

function textEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: 'message',
    replyToken: REPLY_TOKEN,
    timestamp: TS,
    source: { type: 'group', groupId: GROUP_ID, userId: USER_ID },
    message: { id: '1', type: 'text', text: '+ ข้าว 1200' },
    ...overrides,
  }
}

function payload(...events: unknown[]): unknown {
  return { destination: 'Uffffffffffffffffffffffffffffffff', events }
}

describe('parseLineEvents — ไม่เชื่อรูปร่างอะไรเลย', () => {
  it('ทิ้งทุกอย่างที่ไม่ใช่ payload ที่มี events เป็น array', () => {
    expect(parseLineEvents(null)).toEqual([])
    expect(parseLineEvents(undefined)).toEqual([])
    expect(parseLineEvents('{}')).toEqual([])
    expect(parseLineEvents(42)).toEqual([])
    expect(parseLineEvents({})).toEqual([])
    expect(parseLineEvents({ events: null })).toEqual([])
    expect(parseLineEvents({ events: {} })).toEqual([])
    expect(parseLineEvents(payload())).toEqual([])
    expect(parseLineEvents(payload(null, 7, 'x', []))).toEqual([])
  })

  it('อ่านข้อความจากกลุ่มได้ครบทุกฟิลด์ที่ต้องใช้', () => {
    expect(parseLineEvents(payload(textEvent()))).toEqual([
      {
        kind: 'text',
        replyToken: REPLY_TOKEN,
        timestamp: TS,
        source: { kind: 'group', lineGroupId: GROUP_ID, lineUserId: USER_ID },
        text: '+ ข้าว 1200',
        mentionees: [],
      },
    ])
  })

  it('กลุ่มที่ไม่มี userId ยังอ่านได้ แต่ไม่รู้ว่าใครพิมพ์', () => {
    const event = textEvent({ source: { type: 'group', groupId: GROUP_ID } })
    const [parsed] = parseLineEvents(payload(event))
    expect(parsed?.source).toEqual({ kind: 'group', lineGroupId: GROUP_ID, lineUserId: null })
  })

  it('แชท 1:1 เป็นคนละชนิดกับกลุ่ม', () => {
    const event = textEvent({ source: { type: 'user', userId: USER_ID } })
    const [parsed] = parseLineEvents(payload(event))
    expect(parsed?.source).toEqual({ kind: 'user', lineUserId: USER_ID })
  })

  it('`room` ทิ้ง — ยังไม่มีนิยามว่าวงในห้องแชทคืออะไร (D21)', () => {
    const event = textEvent({ source: { type: 'room', roomId: 'Rffffffffffffffffffffffffffffffff' } })
    expect(parseLineEvents(payload(event))).toEqual([])
  })

  it('ทิ้ง event ที่ไม่มีของจำเป็น แทนที่จะเดาค่าให้', () => {
    // ไม่มี replyToken = ตอบกลับไม่ได้ ต่อให้อ่านออกก็ทำอะไรไม่ได้
    expect(parseLineEvents(payload(textEvent({ replyToken: undefined })))).toEqual([])
    expect(parseLineEvents(payload(textEvent({ replyToken: '' })))).toEqual([])
    // timestamp คือที่มาของ spentAt (D35) — เดาเองไม่ได้
    expect(parseLineEvents(payload(textEvent({ timestamp: undefined })))).toEqual([])
    expect(parseLineEvents(payload(textEvent({ timestamp: '1787000000000' })))).toEqual([])
    expect(parseLineEvents(payload(textEvent({ timestamp: 1.5 })))).toEqual([])
    expect(parseLineEvents(payload(textEvent({ source: undefined })))).toEqual([])
    expect(parseLineEvents(payload(textEvent({ source: { type: 'group' } })))).toEqual([])
    expect(parseLineEvents(payload(textEvent({ source: { type: 'user' } })))).toEqual([])
    expect(parseLineEvents(payload(textEvent({ message: undefined })))).toEqual([])
    expect(parseLineEvents(payload(textEvent({ message: { type: 'text' } })))).toEqual([])
  })

  it('ข้ามข้อความที่ไม่ใช่ตัวอักษร และ event ชนิดที่ยังไม่รู้จัก', () => {
    expect(parseLineEvents(payload(textEvent({ message: { id: '1', type: 'sticker' } })))).toEqual([])
    expect(parseLineEvents(payload(textEvent({ message: { id: '1', type: 'image' } })))).toEqual([])
    expect(parseLineEvents(payload(textEvent({ type: 'follow' })))).toEqual([])
    expect(parseLineEvents(payload(textEvent({ type: 'join' })))).toEqual([])
    expect(parseLineEvents(payload(textEvent({ type: 'memberJoined' })))).toEqual([])
  })

  it('ตัดสินด้วย `message.type` ไม่ใช่ด้วยการมีอยู่ของฟิลด์ `text`', () => {
    // ข้อความชนิดอื่นที่บังเอิญมีฟิลด์ชื่อ `text` ติดมาต้องไม่ถูกอ่านเป็นข้อความ
    const event = textEvent({ message: { id: '1', type: 'image', text: 'ไม่ควรอ่านอันนี้' } })
    expect(parseLineEvents(payload(event))).toEqual([])
  })

  it('อ่าน postback ได้ — เป็นทางเดียวที่ปุ่มยืนยันจะกลับมาถึงเรา', () => {
    const event = {
      type: 'postback',
      replyToken: REPLY_TOKEN,
      timestamp: TS,
      source: { type: 'group', groupId: GROUP_ID, userId: USER_ID },
      postback: { data: 'confirm=1' },
    }
    expect(parseLineEvents(payload(event))).toEqual([
      {
        kind: 'postback',
        replyToken: REPLY_TOKEN,
        timestamp: TS,
        source: { kind: 'group', lineGroupId: GROUP_ID, lineUserId: USER_ID },
        data: 'confirm=1',
      },
    ])
  })

  it('postback ที่ไม่มี data ทิ้ง', () => {
    const event = {
      type: 'postback',
      replyToken: REPLY_TOKEN,
      timestamp: TS,
      source: { type: 'user', userId: USER_ID },
      postback: {},
    }
    expect(parseLineEvents(payload(event))).toEqual([])
  })

  it('อ่าน mentionees มาครบ แต่ไม่ตีความ', () => {
    const event = textEvent({
      message: {
        id: '1',
        type: 'text',
        text: '@บิลใหญ่ ยอด',
        mention: {
          mentionees: [
            { index: 0, length: 8, type: 'user', userId: USER_ID, isSelf: true },
            { index: 9, length: 4, type: 'all' },
          ],
        },
      },
    })
    const [parsed] = parseLineEvents(payload(event))
    expect(parsed?.kind).toBe('text')
    expect(parsed?.kind === 'text' ? parsed.mentionees : null).toEqual([
      { index: 0, length: 8, isSelf: true },
      { index: 9, length: 4, isSelf: false },
    ])
  })

  it('mentionee ที่ตัวเลขใช้ไม่ได้ ถูกทิ้งทีละอัน ไม่ทิ้งทั้ง event', () => {
    const event = textEvent({
      message: {
        id: '1',
        type: 'text',
        text: '@บิลใหญ่ ยอด',
        mention: {
          mentionees: [
            { index: -1, length: 8, isSelf: true },
            { index: 0, length: 0, isSelf: true },
            { index: 1.5, length: 8, isSelf: true },
            { index: 0, length: 8, isSelf: true },
            'ไม่ใช่ object',
          ],
        },
      },
    })
    const [parsed] = parseLineEvents(payload(event))
    expect(parsed?.kind === 'text' ? parsed.mentionees : null).toEqual([
      { index: 0, length: 8, isSelf: true },
    ])
  })

  it('event ที่พังหนึ่งอันไม่ทำให้อันที่เหลือหาย', () => {
    const good = textEvent({ message: { id: '2', type: 'text', text: 'ยอด' } })
    const parsed = parseLineEvents(payload(textEvent({ source: undefined }), good, null))
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.kind === 'text' ? parsed[0].text : null).toBe('ยอด')
  })

  it('ข้อความว่างยังเป็น event ที่อ่านได้ — ให้ชั้นถัดไปตัดสิน', () => {
    const event = textEvent({ message: { id: '1', type: 'text', text: '' } })
    const [parsed] = parseLineEvents(payload(event))
    expect(parsed?.kind === 'text' ? parsed.text : null).toBe('')
  })
})
