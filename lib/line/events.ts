/**
 * แปลง JSON ของ webhook ให้เป็น event ที่มีชนิดแน่นอน — **ไม่เชื่อรูปร่างอะไรเลย**
 *
 * body ผ่านลายเซ็นแล้วก็จริง แต่ "มาจาก LINE" ไม่ได้แปลว่า "รูปร่างตรงกับที่เราจำ":
 * LINE เพิ่ม event type ใหม่ได้ตลอดโดยไม่แจ้ง และ `source` ของกลุ่ม ห้องแชท และ 1:1
 * เป็นคนละรูปร่างกัน · อะไรที่อ่านไม่ออกให้**ข้ามเงียบๆ ไม่ throw** เพราะ event หนึ่ง
 * ที่เราไม่รู้จักต้องไม่ทำให้บิลของอีกคนในชุดเดียวกันหาย
 *
 * ไฟล์นี้ไม่ตีความอะไรทั้งสิ้น — ไม่ตัดสินว่าเข้า Trigger ไหม ไม่ตัด mention
 * ไม่แปลงเป็นวันที่ นั่นเป็นงานของชั้นถัดไป
 */

/** ที่มาของ event — `room` ไม่มีในนี้เพราะถูกทิ้งตั้งแต่ชั้นนี้ (D21) */
export type LineSource =
  | { kind: 'group'; lineGroupId: string; lineUserId: string | null }
  | { kind: 'user'; lineUserId: string }

/**
 * ตำแหน่งของ mention หนึ่งอันในข้อความ
 *
 * `index`/`length` นับเป็น **UTF-16 code unit** ตามที่ LINE กำหนด · `isSelf` คือ
 * ตัวเดียวที่บอกว่า mention นั้นเรียกบอทตัวที่รับ webhook อยู่หรือไม่ — ไม่ใช่การ
 * เทียบชื่อในข้อความ · `@All` ไม่มี `isSelf` จึงกลายเป็น `false` ตามที่ควร
 */
export interface Mentionee {
  index: number
  length: number
  isSelf: boolean
}

export type LineEvent =
  | {
      kind: 'text'
      replyToken: string
      timestamp: number
      source: LineSource
      text: string
      mentionees: Mentionee[]
    }
  | {
      kind: 'postback'
      replyToken: string
      timestamp: number
      source: LineSource
      data: string
    }

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function parseSource(value: unknown): LineSource | null {
  const source = asRecord(value)
  if (source === null) return null

  if (source.type === 'group') {
    const lineGroupId = asNonEmptyString(source.groupId)
    if (lineGroupId === null) return null
    // `userId` หายได้จริงเมื่อคนพิมพ์ยังไม่ยอมรับข้อตกลงการใช้งานของ LINE
    return { kind: 'group', lineGroupId, lineUserId: asNonEmptyString(source.userId) }
  }

  if (source.type === 'user') {
    const lineUserId = asNonEmptyString(source.userId)
    if (lineUserId === null) return null
    return { kind: 'user', lineUserId }
  }

  // `room` และชนิดที่ยังไม่รู้จัก — ทิ้ง
  return null
}

function parseMentionees(value: unknown): Mentionee[] {
  const mention = asRecord(value)
  if (mention === null) return []
  const raw = mention.mentionees
  if (!Array.isArray(raw)) return []

  const mentionees: Mentionee[] = []
  for (const entry of raw) {
    const mentionee = asRecord(entry)
    if (mentionee === null) continue
    const { index, length, isSelf } = mentionee
    // ตำแหน่งที่ใช้ไม่ได้ = ตัดสตริงผิดที่ ซึ่งแย่กว่าไม่ตัดเลย — ทิ้งทีละอัน
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) continue
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length <= 0) continue
    mentionees.push({ index, length, isSelf: isSelf === true })
  }
  return mentionees
}

function parseEvent(value: unknown): LineEvent | null {
  const event = asRecord(value)
  if (event === null) return null

  // ไม่มี replyToken = ตอบกลับไม่ได้ · อ่านออกไปก็ทำอะไรต่อไม่ได้
  const replyToken = asNonEmptyString(event.replyToken)
  if (replyToken === null) return null

  // timestamp คือที่มาเดียวของ `spentAt` (D35) — เดาแทนไม่ได้
  const { timestamp } = event
  if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp)) return null

  const source = parseSource(event.source)
  if (source === null) return null

  const base = { replyToken, timestamp, source }

  if (event.type === 'message') {
    const message = asRecord(event.message)
    if (message === null || message.type !== 'text') return null
    if (typeof message.text !== 'string') return null
    return { kind: 'text', ...base, text: message.text, mentionees: parseMentionees(message.mention) }
  }

  if (event.type === 'postback') {
    const postback = asRecord(event.postback)
    if (postback === null) return null
    const data = asNonEmptyString(postback.data)
    if (data === null) return null
    return { kind: 'postback', ...base, data }
  }

  return null
}

export function parseLineEvents(payload: unknown): LineEvent[] {
  const body = asRecord(payload)
  if (body === null) return []
  const events = body.events
  if (!Array.isArray(events)) return []

  const parsed: LineEvent[] = []
  for (const event of events) {
    const one = parseEvent(event)
    if (one !== null) parsed.push(one)
  }
  return parsed
}
