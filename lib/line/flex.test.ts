import { describe, expect, it } from 'vitest'
import { balanceCardMessage, draftCardMessage } from './flex'
import type { DraftCard } from '../flow/draft'

const CARD: DraftCard = {
  description: 'ข้าว',
  totalSatang: 120000,
  lines: [
    { name: 'กอล์ฟ', amountSatang: 60000, isNew: true, isPayer: false },
    { name: 'ตูน', amountSatang: 60000, isNew: false, isPayer: false },
  ],
}

const DRAFT_ID = '4f1c2a5e-0000-4000-8000-000000000001'

/** ตัวเลือกตัวตน — id ปลอมที่ยาวคงที่เหมือน uuid ของจริง */
function choices(...names: string[]) {
  return names.map((name, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name }))
}

/** ไล่เก็บข้อความทุกก้อนในโครง Flex — ใช้ตรวจว่าอะไรโผล่บนการ์ดบ้าง */
function allText(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(allText)
  if (typeof node !== 'object' || node === null) return []
  const record = node as Record<string, unknown>
  const here = typeof record.text === 'string' ? [record.text] : []
  return [...here, ...Object.values(record).flatMap(allText)]
}

describe('draftCardMessage — สิ่งที่คนต้องเห็นก่อนกด', () => {
  it('เป็น flex message ที่มี altText อ่านรู้เรื่อง', () => {
    const message = draftCardMessage(CARD, DRAFT_ID)
    expect(message.type).toBe('flex')
    expect(message.altText).toContain('ข้าว')
    expect(message.altText.length).toBeGreaterThan(0)
    expect(message.altText.length).toBeLessThanOrEqual(400)
  })

  it('โชว์ชื่อทุกคนที่จะโดนหารและยอดรายคน (D16)', () => {
    const texts = allText(draftCardMessage(CARD, DRAFT_ID))
    expect(texts).toContain('กอล์ฟ (ใหม่)')
    expect(texts).toContain('ตูน')
    expect(texts.filter((t) => t === '฿600')).toHaveLength(2)
  })

  it('ป้าย (ใหม่) ติดเฉพาะคนที่วงยังไม่รู้จัก', () => {
    const texts = allText(draftCardMessage(CARD, DRAFT_ID))
    expect(texts).not.toContain('ตูน (ใหม่)')
  })

  it('โชว์ยอดรวมและคำอธิบายบิล', () => {
    const texts = allText(draftCardMessage(CARD, DRAFT_ID))
    expect(texts).toContain('ข้าว')
    expect(texts).toContain('฿1,200')
  })

  it('`eventTag` โผล่บนการ์ดเมื่อมี', () => {
    const texts = allText(draftCardMessage({ ...CARD, eventTag: 'เชียงใหม่' }, DRAFT_ID))
    expect(texts).toContain('#เชียงใหม่')
  })

  it('ไม่มี `eventTag` ก็ไม่มี `#` โผล่มาลอยๆ', () => {
    const texts = allText(draftCardMessage(CARD, DRAFT_ID))
    expect(texts.some((t) => t.startsWith('#'))).toBe(false)
  })

  it('**ไม่โชว์วันที่** — คนเพิ่งพิมพ์ไปเมื่อกี้ ไม่มีใครตรวจบรรทัดนั้น', () => {
    const texts = allText(draftCardMessage(CARD, DRAFT_ID))
    expect(texts.some((t) => /\d{4}-\d{2}-\d{2}/.test(t))).toBe(false)
  })
})

describe('draftCardMessage — ปุ่มยืนยัน', () => {
  it('postback data เป็น id ของ draft เท่านั้น สั้นและยาวคงที่ (ADR 0001)', () => {
    const message = draftCardMessage(CARD, DRAFT_ID)
    const json = JSON.stringify(message)
    expect(json).toContain(DRAFT_ID)

    const found = findPostbackData(message)
    expect(found).not.toBeNull()
    expect(found).toContain(DRAFT_ID)
    // เพดานของ LINE คือ 300 ตัวอักษร — ค่านี้ต้องไม่โตตามจำนวนคนในบิล
    expect((found ?? '').length).toBeLessThanOrEqual(64)
  })

  it('ความยาว postback ไม่ขึ้นกับจำนวนคนในบิล', () => {
    const big: DraftCard = {
      ...CARD,
      lines: Array.from({ length: 30 }, (_, i) => ({
        name: `คนที่ยาวมากๆๆๆ${i}`,
        amountSatang: 4000,
        isNew: true,
        isPayer: false,
      })),
    }
    expect(findPostbackData(draftCardMessage(big, DRAFT_ID))).toBe(
      findPostbackData(draftCardMessage(CARD, DRAFT_ID)),
    )
  })
})

describe('draftCardMessage — ขนาด', () => {
  it('bubble ที่คนเยอะยังไม่ชนเพดาน 10 KB', () => {
    const big: DraftCard = {
      description: 'ทริปเชียงใหม่ มื้อเย็นวันเสาร์',
      totalSatang: 5_000_00,
      eventTag: 'เชียงใหม่',
      lines: Array.from({ length: 30 }, (_, i) => ({
        name: `เพื่อนคนที่ ${i} ชื่อยาวพอสมควร`,
        amountSatang: 16666,
        isNew: i % 2 === 0,
        isPayer: false,
      })),
    }
    const bytes = Buffer.byteLength(JSON.stringify(draftCardMessage(big, DRAFT_ID)), 'utf8')
    expect(bytes).toBeLessThan(10_000)
  })
})

function findPostbackData(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findPostbackData(item)
      if (found !== null) return found
    }
    return null
  }
  if (typeof node !== 'object' || node === null) return null
  const record = node as Record<string, unknown>
  if (record.type === 'postback' && typeof record.data === 'string') return record.data
  for (const value of Object.values(record)) {
    const found = findPostbackData(value)
    if (found !== null) return found
  }
  return null
}

describe('draftCardMessage — คำอธิบายที่ยาวเกิน', () => {
  // description คือทุก token ก่อนยอด ซึ่งยาวได้ถึงเพดานข้อความของ LINE · ปล่อยไว้
  // แล้ว altText จะทะลุเพดานของมัน LINE ปฏิเสธ reply ทั้งก้อน แล้วแถว draft ที่
  // เขียนไปแล้วจะไม่มีการ์ดให้ใครกดจนกว่าจะหมดอายุ
  const LONG = 'ก'.repeat(600)

  it('altText ไม่ทะลุเพดาน 400 ตัวอักษร', () => {
    const message = draftCardMessage({ ...CARD, description: LONG }, DRAFT_ID)
    expect(message.altText.length).toBeLessThanOrEqual(400)
  })

  it('บนการ์ดก็ถูกตัด ไม่ใช่ตัดแค่ใน altText', () => {
    const texts = allText(draftCardMessage({ ...CARD, description: LONG }, DRAFT_ID))
    expect(texts.every((t) => t.length <= 400)).toBe(true)
    expect(texts.some((t) => t.endsWith('…'))).toBe(true)
  })

  it('คำอธิบายสั้นไม่ถูกแตะ', () => {
    const texts = allText(draftCardMessage(CARD, DRAFT_ID))
    expect(texts).toContain('ข้าว')
  })
})

describe('draftCardMessage — แถวเลือกตัวตน (D29 / ADR 0002)', () => {
  it('คนที่ยืนยันตัวตนแล้วได้ปุ่มยืนยันตามปกติ ไม่มี quick reply', () => {
    const message = draftCardMessage(CARD, DRAFT_ID)
    expect(message.quickReply).toBeUndefined()
    expect(findPostbackData(message.contents.footer)).toBe(`confirm=${DRAFT_ID}`)
  })

  it('คนที่ยังไม่ยืนยันตัวตน — **ไม่มีปุ่มยืนยันบนการ์ด** เพราะกดแล้วไปต่อไม่ได้', () => {
    const message = draftCardMessage(CARD, DRAFT_ID, choices('กอล์ฟ', 'ตูน'))
    expect(findPostbackData(message.contents.footer)).toBeNull()
    expect(allText(message.contents.footer).join('')).toContain('เลือกชื่อของคุณ')
  })

  it('quick reply มีชื่อที่ยังไม่มีเจ้าของ บวก `ฉันเป็นคนใหม่` ต่อท้ายเสมอ', () => {
    const message = draftCardMessage(CARD, DRAFT_ID, choices('กอล์ฟ', 'ตูน'))
    const labels = message.quickReply?.items.map((i) => i.action.label)
    expect(labels).toEqual(['กอล์ฟ', 'ตูน', 'ฉันเป็นคนใหม่'])
  })

  it('ทุกปุ่มพา draft id ไปด้วย — กดคือ claim + ยืนยันในจังหวะเดียว', () => {
    const message = draftCardMessage(CARD, DRAFT_ID, choices('กอล์ฟ'))
    for (const item of message.quickReply?.items ?? []) {
      expect(item.action.data).toContain(DRAFT_ID)
      expect(item.action.data.length).toBeLessThanOrEqual(300)
    }
  })

  it('วงว่างก็ยังมี `ฉันเป็นคนใหม่` ให้กด', () => {
    const message = draftCardMessage(CARD, DRAFT_ID, [])
    expect(message.quickReply?.items).toHaveLength(1)
    expect(message.quickReply?.items[0]?.action.data).toBe(`confirm=${DRAFT_ID}&as=new`)
  })

  it('วงใหญ่ไม่ทะลุเพดาน 13 ปุ่มของ LINE', () => {
    const many = choices(...Array.from({ length: 40 }, (_, i) => `คนที่ ${i}`))
    const message = draftCardMessage(CARD, DRAFT_ID, many)
    expect(message.quickReply?.items.length).toBeLessThanOrEqual(13)
    // ช่องสุดท้ายต้องเป็น `ฉันเป็นคนใหม่` เสมอ ไม่งั้นคนที่ยังไม่มีชื่อไปต่อไม่ได้
    expect(message.quickReply?.items.at(-1)?.action.label).toBe('ฉันเป็นคนใหม่')
  })

  it('ชื่อยาวถูกตัดบนปุ่ม แต่ยังส่ง id เต็มกลับมา', () => {
    const long = 'ชื่อที่ยาวมากจนล้นปุ่มแน่นอนเลยจริงๆ'
    const message = draftCardMessage(CARD, DRAFT_ID, choices(long))
    const item = message.quickReply?.items[0]
    expect(item?.action.label.length).toBeLessThanOrEqual(20)
    expect(item?.action.displayText).toBe(long)
  })

  it('ชื่อยาวแค่ไหน postback ก็ยาวเท่าเดิม — ส่ง id ไม่ได้ส่งชื่อ', () => {
    // ชื่อไทยที่ผ่าน encodeURIComponent ยาวขึ้นเก้าเท่า แล้วทะลุเพดาน 300
    // ตั้งแต่ชื่อยาวราว 27 ตัวอักษร ซึ่งเป็นชื่อเล่นที่ยาวแต่ไม่ได้เพี้ยน
    const absurd = 'ก'.repeat(200)
    const message = draftCardMessage(CARD, DRAFT_ID, choices(absurd, 'ตูน'))
    for (const item of message.quickReply?.items ?? []) {
      expect(item.action.data.length).toBeLessThanOrEqual(300)
    }
    expect(message.quickReply?.items.map((i) => i.action.displayText)).toEqual([
      absurd,
      'ตูน',
      'ฉันเป็นคนใหม่',
    ])
  })
})

describe('balanceCardMessage — การ์ด `ยอด` (D31)', () => {
  const BLOCKS = [
    {
      creditorName: 'กอล์ฟ',
      totalSatang: 90000,
      rows: [
        { debtorName: 'ตูน', amountSatang: 60000 },
        { debtorName: 'เบียร์', amountSatang: 30000 },
      ],
    },
    {
      creditorName: 'แนน',
      totalSatang: 20000,
      rows: [{ debtorName: 'ตูน', amountSatang: 20000 }],
    },
  ]

  it('หัวบล็อกบอกยอดรวมที่เจ้าหนี้ได้คืน', () => {
    const texts = allText(balanceCardMessage(BLOCKS))
    expect(texts).toContain('กอล์ฟ ได้คืน')
    expect(texts).toContain('฿900')
  })

  it('ยอดรวมทั้งวงอยู่หัวการ์ดและใน altText', () => {
    const [message] = balanceCardMessage(BLOCKS)
    if (message?.type !== 'flex') throw new Error('วงเล็กต้องได้ Flex')
    expect(allText(message.contents.body)).toContain('฿1,100')
    expect(message.altText).toContain('฿1,100')
    expect(message.altText.length).toBeLessThanOrEqual(400)
  })

  it('ลูกหนี้ทุกคนโผล่ครบ', () => {
    const texts = allText(balanceCardMessage(BLOCKS)).join('|')
    expect(texts).toContain('ตูน')
    expect(texts).toContain('เบียร์')
    expect(texts).toContain('แนน')
  })

  it('**ไม่มีปุ่ม** — การ์ดนี้อ่านอย่างเดียว', () => {
    expect(findPostbackData(balanceCardMessage(BLOCKS))).toBeNull()
  })

  it('วงเล็กได้ Flex ก้อนเดียว', () => {
    expect(balanceCardMessage(BLOCKS)).toHaveLength(1)
  })

  it('วงแปดคนที่ทุกคนเคยจ่าย (28 คู่) ยังเป็น Flex และไม่ชนเพดาน 10 KB', () => {
    // 28 คือจำนวนคู่สูงสุดของวง 8 คน — หนี้เก็บทิศทางเดียวต่อคู่ (D5)
    const realistic = Array.from({ length: 7 }, (_, i) => ({
      creditorName: `เจ้าหนี้คนที่ ${i}`,
      totalSatang: 10000 * (7 - i),
      rows: Array.from({ length: 7 - i }, (_, j) => ({
        debtorName: `ลูกหนี้คนที่ ${j} ชื่อยาวพอควร`,
        amountSatang: 10000,
      })),
    }))
    const messages = balanceCardMessage(realistic)
    expect(messages).toHaveLength(1)
    expect(Buffer.byteLength(JSON.stringify(messages), 'utf8')).toBeLessThan(10_000)
  })

  it('วงที่ใหญ่จน Flex ใส่ไม่ไหว ลดรูปเป็น text — **ไม่ตัดใครทิ้ง** (D31)', () => {
    // ทะลุเพดานแล้ว LINE ปฏิเสธทั้งข้อความ = คนพิมพ์ `ยอด` ไม่เห็นอะไรเลย
    const huge = Array.from({ length: 20 }, (_, i) => ({
      creditorName: `เจ้าหนี้คนที่ ${i}`,
      totalSatang: 100000,
      rows: Array.from({ length: 10 }, (_, j) => ({
        debtorName: `ลูกหนี้คนที่ ${j} ชื่อยาวพอสมควรจริงๆ`,
        amountSatang: 10000,
      })),
    }))
    const messages = balanceCardMessage(huge)
    expect(messages.every((m) => m.type === 'text')).toBe(true)
    // reply ส่งได้ 5 ก้อน ก้อนละ 5000 ตัวอักษร
    expect(messages.length).toBeLessThanOrEqual(5)
    for (const message of messages) {
      if (message.type !== 'text') throw new Error('ต้องเป็น text')
      expect(message.text.length).toBeLessThanOrEqual(5000)
    }
    // ทุกเจ้าหนี้ยังอยู่ครบ ไม่มีใครถูกตัดทิ้งเงียบๆ
    const joined = messages.map((m) => (m.type === 'text' ? m.text : '')).join('')
    expect(joined.split('ได้คืน')).toHaveLength(21)
  })
})
