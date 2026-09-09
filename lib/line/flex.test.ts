import { describe, expect, it } from 'vitest'
import { balanceCardMessage, billDetailCardMessage, billListCardMessage, draftCardMessage } from './flex'
import type { DraftCard } from '../flow/draft'
import type { LineFlexMessage } from './flex'
import type { LineMessage } from './messages'

/** ตัวคั่นตอนยุบข้อความในการ์ดมาเทียบ — แยกไว้กันบรรทัดจริงหลุดเข้าไปในสตริง */
const LF = String.fromCharCode(10)

const CARD: DraftCard = {
  description: 'ข้าว',
  totalSatang: 120000,
  lines: [
    { name: 'กอล์ฟ', amountSatang: 60000, isNew: true, isPayer: false },
    { name: 'ตูน', amountSatang: 60000, isNew: false, isPayer: false },
  ],
}

/**
 * การ์ดที่คาดว่าเป็น Flex ใบเดียว — **ยืนยันว่ามีก้อนเดียวไปด้วยในตัว**
 *
 * ทางลงเป็นข้อความมีเทสต์ของมันเองแยกไว้ · ตัวช่วยนี้จึงต้องดังทันทีถ้าการ์ดปกติ
 * เผลอแตกเป็นหลายก้อน
 */
function only(messages: LineMessage[]): LineFlexMessage {
  expect(messages).toHaveLength(1)
  const first = messages[0]
  if (first === undefined || first.type !== 'flex') throw new Error('ต้องเป็นการ์ด Flex ใบเดียว')
  return first
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

/** footer ของ bubble ใบแรก — การ์ดเล็กมีใบเดียวอยู่แล้ว */
function footerOf(message: unknown): unknown {
  const first = bubblesOf(message)[0]
  return typeof first === 'object' && first !== null
    ? (first as { footer?: unknown }).footer
    : undefined
}

/** นับ separator ทั้งโครง — ใช้ตรวจว่าเส้นคั่นระหว่างสองส่วนยังอยู่ */
function countSeparators(node: unknown): number {
  if (Array.isArray(node)) return node.reduce<number>((sum, n) => sum + countSeparators(n), 0)
  if (typeof node !== 'object' || node === null) return 0
  const record = node as Record<string, unknown>
  const here = record.type === 'separator' ? 1 : 0
  return here + Object.values(record).reduce<number>((sum, n) => sum + countSeparators(n), 0)
}

/** ทุก bubble ในข้อความ ไม่ว่าจะเป็นใบเดี่ยวหรือ carousel */
function bubblesOf(message: unknown): unknown[] {
  if (typeof message !== 'object' || message === null) return []
  const contents = (message as { contents?: unknown }).contents
  if (typeof contents !== 'object' || contents === null) return []
  const record = contents as { type?: string; contents?: unknown }
  if (record.type === 'carousel' && Array.isArray(record.contents)) return record.contents
  return [contents]
}

describe('draftCardMessage — สิ่งที่คนต้องเห็นก่อนกด', () => {
  it('เป็น flex message ที่มี altText อ่านรู้เรื่อง', () => {
    const message = only(draftCardMessage(CARD, DRAFT_ID))
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

/**
 * ปุ่มเปิดหน้าจอจดรายชิ้น (D56) — **URI action ไม่ใช่ postback**
 *
 * LIFF URL เป็นลิงก์ธรรมดา · `draftId` เดินทางไปทาง query string เพราะหน้าจอต้อง
 * รู้ว่าจะเปิดบิลใบไหน และเป็นค่าที่ฝั่ง server ตรวจสิทธิ์ซ้ำอยู่แล้ว (D26)
 */
describe('draftCardMessage — ปุ่มเปิดหน้าจอจดรายชิ้น', () => {
  const LIFF_URL = 'https://liff.line.me/1234567890-AbCdEfGh'

  function uris(message: unknown): string[] {
    const found: string[] = []
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk)
        return
      }
      if (typeof node !== 'object' || node === null) return
      const record = node as Record<string, unknown>
      if (record.type === 'uri' && typeof record.uri === 'string') found.push(record.uri)
      Object.values(record).forEach(walk)
    }
    walk(message)
    return found
  }

  it('มีปุ่มที่พา `draftId` ไปเปิดหน้าจอ', () => {
    const message = only(draftCardMessage(CARD, DRAFT_ID, null, LIFF_URL))
    expect(uris(message)).toContain(`${LIFF_URL}?draftId=${DRAFT_ID}`)
  })

  /**
   * ยังไม่ได้ตั้ง `NEXT_PUBLIC_LIFF_ID` = **ไม่มีปุ่ม ไม่ใช่ปุ่มที่กดแล้วพัง** ·
   * ลิงก์เสียบนการ์ดในกลุ่มแย่กว่าการ์ดที่ไม่มีปุ่มนั้น
   */
  it('ไม่ได้ตั้ง LIFF URL → ไม่มีปุ่มนั้นเลย และการ์ดยังใช้ได้ตามปกติ', () => {
    const message = only(draftCardMessage(CARD, DRAFT_ID))
    expect(uris(message)).toEqual([])
    expect(findPostbackData(message)).toBe(`confirm=${DRAFT_ID}`)
  })

  /**
   * คนที่ยังไม่ยืนยันตัวตนไม่มีปุ่ม `ยืนยัน` (ADR 0002) — **แต่ยังจดรายชิ้นได้**
   * ตัวตนถูกถามตอนกดยืนยัน ไม่ใช่ตอนแก้รายการ
   */
  it('การ์ดของคนที่ยังไม่ยืนยันตัวตนก็มีปุ่มนี้', () => {
    const message = only(draftCardMessage(CARD, DRAFT_ID, choices('กอล์ฟ'), LIFF_URL))
    expect(uris(message)).toContain(`${LIFF_URL}?draftId=${DRAFT_ID}`)
  })

  it('ทุก bubble ของ carousel มีปุ่มนี้ เหมือนปุ่มยืนยัน', () => {
    const big: DraftCard = {
      description: 'ทริปเชียงใหม่',
      totalSatang: 500000,
      lines: Array.from({ length: 90 }, (_, i) => ({
        name: `เพื่อนหมายเลข ${i}`,
        amountSatang: 5555,
        isNew: false,
        isPayer: false,
      })),
    }
    const message = only(draftCardMessage(big, DRAFT_ID, null, LIFF_URL))
    const bubbles = bubblesOf(message)
    expect(bubbles.length).toBeGreaterThan(1)
    for (const bubble of bubbles) {
      expect(uris(bubble)).toContain(`${LIFF_URL}?draftId=${DRAFT_ID}`)
    }
  })
})

describe('draftCardMessage — วงที่ใหญ่เกินหนึ่ง bubble (D52)', () => {
  const BIG: DraftCard = {
    description: 'ทริปเชียงใหม่',
    totalSatang: 5_000_00,
    lines: Array.from({ length: 90 }, (_, i) => ({
      name: `เพื่อนหมายเลข ${i}`,
      amountSatang: 5555,
      isNew: i % 2 === 0,
      isPayer: false,
    })),
  }

  it('กลายเป็น carousel ไม่ใช่การ์ดที่ LINE ปฏิเสธทั้งก้อน', () => {
    const message = only(draftCardMessage(BIG, DRAFT_ID))
    expect(message.contents.type).toBe('carousel')

    // D16 — ชื่อทุกคนที่จะโดนหารต้องอยู่ครบ ไม่ว่าการ์ดจะถูกแบ่งกี่ใบ
    const texts = allText(message).join(LF)
    for (const line of BIG.lines) expect(texts).toContain(line.name)
  })

  /**
   * **หัวการ์ดต้องซ้ำอยู่ทุกใบ** — สิ่งที่คนเลื่อนไปใบที่สามแล้วต้องยังรู้คือ
   * "นี่บิลอะไร ยอดเท่าไหร่" · ใบที่ไม่มีหัวคือรายชื่อกับตัวเลขลอยๆ ที่อ่านไม่ได้
   */
  it('ทุก bubble มีหัวการ์ด ไม่ใช่เฉพาะใบแรก', () => {
    const message = only(draftCardMessage(BIG, DRAFT_ID))
    const bubbles = bubblesOf(message)
    expect(bubbles.length).toBeGreaterThan(1)
    for (const bubble of bubbles) {
      const texts = allText(bubble).join(LF)
      expect(texts).toContain(BIG.description)
      expect(texts).toContain('฿5,000')
    }
  })

  it('ทุก bubble มีปุ่มยืนยัน — ปุ่มที่อยู่ใบเดียวคือปุ่มที่เลื่อนผ่านแล้วหาไม่เจอ', () => {
    const message = only(draftCardMessage(BIG, DRAFT_ID))
    for (const bubble of bubblesOf(message)) {
      expect(findPostbackData(bubble)).toBe(`confirm=${DRAFT_ID}`)
    }
  })
})

describe('draftCardMessage — ปุ่มยืนยัน', () => {
  it('postback data เป็น id ของ draft เท่านั้น สั้นและยาวคงที่ (ADR 0001)', () => {
    const message = only(draftCardMessage(CARD, DRAFT_ID))
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
    const bytes = Buffer.byteLength(JSON.stringify(only(draftCardMessage(big, DRAFT_ID))), 'utf8')
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
    const message = only(draftCardMessage({ ...CARD, description: LONG }, DRAFT_ID))
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
    const message = only(draftCardMessage(CARD, DRAFT_ID))
    expect(message.quickReply).toBeUndefined()
    expect(findPostbackData(footerOf(message))).toBe(`confirm=${DRAFT_ID}`)
  })

  it('คนที่ยังไม่ยืนยันตัวตน — **ไม่มีปุ่มยืนยันบนการ์ด** เพราะกดแล้วไปต่อไม่ได้', () => {
    const message = only(draftCardMessage(CARD, DRAFT_ID, choices('กอล์ฟ', 'ตูน')))
    expect(findPostbackData(footerOf(message))).toBeNull()
    expect(allText(footerOf(message)).join('')).toContain('เลือกชื่อของคุณ')
  })

  it('quick reply มีชื่อที่ยังไม่มีเจ้าของ บวก `ฉันเป็นคนใหม่` ต่อท้ายเสมอ', () => {
    const message = only(draftCardMessage(CARD, DRAFT_ID, choices('กอล์ฟ', 'ตูน')))
    const labels = message.quickReply?.items.map((i) => i.action.label)
    expect(labels).toEqual(['กอล์ฟ', 'ตูน', 'ฉันเป็นคนใหม่'])
  })

  it('ทุกปุ่มพา draft id ไปด้วย — กดคือ claim + ยืนยันในจังหวะเดียว', () => {
    const message = only(draftCardMessage(CARD, DRAFT_ID, choices('กอล์ฟ')))
    for (const item of message.quickReply?.items ?? []) {
      expect(item.action.data).toContain(DRAFT_ID)
      expect(item.action.data.length).toBeLessThanOrEqual(300)
    }
  })

  it('วงว่างก็ยังมี `ฉันเป็นคนใหม่` ให้กด', () => {
    const message = only(draftCardMessage(CARD, DRAFT_ID, []))
    expect(message.quickReply?.items).toHaveLength(1)
    expect(message.quickReply?.items[0]?.action.data).toBe(`confirm=${DRAFT_ID}&as=new`)
  })

  it('วงใหญ่ไม่ทะลุเพดาน 13 ปุ่มของ LINE', () => {
    const many = choices(...Array.from({ length: 40 }, (_, i) => `คนที่ ${i}`))
    const message = only(draftCardMessage(CARD, DRAFT_ID, many))
    expect(message.quickReply?.items.length).toBeLessThanOrEqual(13)
    // ช่องสุดท้ายต้องเป็น `ฉันเป็นคนใหม่` เสมอ ไม่งั้นคนที่ยังไม่มีชื่อไปต่อไม่ได้
    expect(message.quickReply?.items.at(-1)?.action.label).toBe('ฉันเป็นคนใหม่')
  })

  it('ชื่อยาวถูกตัดบนปุ่ม แต่ยังส่ง id เต็มกลับมา', () => {
    const long = 'ชื่อที่ยาวมากจนล้นปุ่มแน่นอนเลยจริงๆ'
    const message = only(draftCardMessage(CARD, DRAFT_ID, choices(long)))
    const item = message.quickReply?.items[0]
    expect(item?.action.label.length).toBeLessThanOrEqual(20)
    expect(item?.action.displayText).toBe(long)
  })

  it('ชื่อยาวแค่ไหน postback ก็ยาวเท่าเดิม — ส่ง id ไม่ได้ส่งชื่อ', () => {
    // ชื่อไทยที่ผ่าน encodeURIComponent ยาวขึ้นเก้าเท่า แล้วทะลุเพดาน 300
    // ตั้งแต่ชื่อยาวราว 27 ตัวอักษร ซึ่งเป็นชื่อเล่นที่ยาวแต่ไม่ได้เพี้ยน
    const absurd = 'ก'.repeat(200)
    const message = only(draftCardMessage(CARD, DRAFT_ID, choices(absurd, 'ตูน')))
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
    const texts = allText(balanceCardMessage(BLOCKS, 'group'))
    expect(texts).toContain('กอล์ฟ ได้คืน')
    expect(texts).toContain('฿900')
  })

  it('ยอดรวมทั้งวงอยู่หัวการ์ดและใน altText', () => {
    const [message] = balanceCardMessage(BLOCKS, 'group')
    if (message?.type !== 'flex') throw new Error('วงเล็กต้องได้ Flex')
    expect(allText(message.contents)).toContain('฿1,100')
    expect(message.altText).toContain('฿1,100')
    expect(message.altText.length).toBeLessThanOrEqual(400)
  })

  it('ลูกหนี้ทุกคนโผล่ครบ', () => {
    const texts = allText(balanceCardMessage(BLOCKS, 'group')).join('|')
    expect(texts).toContain('ตูน')
    expect(texts).toContain('เบียร์')
    expect(texts).toContain('แนน')
  })

  it('**ไม่มีปุ่ม** — การ์ดนี้อ่านอย่างเดียว', () => {
    expect(findPostbackData(balanceCardMessage(BLOCKS, 'group'))).toBeNull()
  })

  it('วงเล็กได้ Flex ก้อนเดียว', () => {
    expect(balanceCardMessage(BLOCKS, 'group')).toHaveLength(1)
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
    const messages = balanceCardMessage(realistic, 'group')
    expect(messages).toHaveLength(1)
    expect(messages[0]?.type).toBe('flex')

    /**
     * **เพดาน 10 KB เป็นของ bubble ใบเดียว ไม่ใช่ของทั้งข้อความ**
     *
     * เทสต์นี้เคยวัดทั้งข้อความแล้วผ่าน ทั้งที่ผลลัพธ์ตอนนั้นเป็น text ไม่ใช่ Flex
     * เลยด้วยซ้ำ — ชื่อเทสต์บอกว่า "ยังเป็น Flex" แต่ไม่มีบรรทัดไหนตรวจ (แก้ D52)
     */
    for (const bubble of bubblesOf(messages[0])) {
      expect(Buffer.byteLength(JSON.stringify(bubble), 'utf8')).toBeLessThan(10_000)
    }
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
    const messages = balanceCardMessage(huge, 'group')
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

/** ไล่เก็บ `displayText` ทุกอันในโครง Flex — LINE จำกัดไว้ 300 ตัวอักษร */
function allDisplayText(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(allDisplayText)
  if (typeof node !== 'object' || node === null) return []
  const record = node as Record<string, unknown>
  const action = record.action as Record<string, unknown> | undefined
  const here =
    action !== undefined && typeof action.displayText === 'string' ? [action.displayText] : []
  return [...here, ...Object.values(record).flatMap(allDisplayText)]
}

/** ไล่เก็บ postback data ทุกอันในโครง Flex */
function allPostbackData(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(allPostbackData)
  if (typeof node !== 'object' || node === null) return []
  const record = node as Record<string, unknown>
  const action = record.action as Record<string, unknown> | undefined
  const here =
    action !== undefined && action.type === 'postback' && typeof action.data === 'string'
      ? [action.data]
      : []
  return [...here, ...Object.values(record).flatMap(allPostbackData)]
}

function billRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    description: `บิลที่ ${i + 1}`,
    date: '1 ก.ย. 69',
    totalSatang: 90000,
  }))
}

describe('billListCardMessage — รายการบิล (D45)', () => {
  it('หนึ่งบิลหนึ่งแถว โชว์ชื่อ วันที่ ยอด', () => {
    const [message] = billListCardMessage({ kind: 'bills', rows: billRows(2), omitted: 0 })
    const texts = allText(message)
    expect(texts).toContain('บิลที่ 1')
    expect(texts).toContain('1 ก.ย. 69')
    expect(texts.some((t) => t.includes('900'))).toBe(true)
  })

  it('ทุกแถวกดได้ และ postback พา `expense.id` เท่านั้น', () => {
    const rows = billRows(3)
    const [message] = billListCardMessage({ kind: 'bills', rows, omitted: 0 })
    expect(allPostbackData(message)).toEqual(rows.map((r) => `bill=${r.id}`))
  })

  it('postback data ไม่มีชื่อบิลอยู่ในนั้นเลย — เพดาน 300 (ADR 0002)', () => {
    // ชื่อไทยผ่าน `encodeURIComponent` ยาวขึ้นเก้าเท่า · uuid ยาวคงที่เสมอ
    const rows = [
      { id: '00000000-0000-4000-8000-000000000001', description: 'หมูกระทะบุฟเฟต์ริมน้ำเจ้าเก่า', date: '1 ก.ย. 69', totalSatang: 90000 },
    ]
    for (const data of allPostbackData(billListCardMessage({ kind: 'bills', rows, omitted: 0 })[0])) {
      expect(data).not.toContain('หมูกระทะ')
      expect(data.length).toBeLessThanOrEqual(300)
    }
  })

  it('บอกจำนวนที่ไม่ได้แสดง — ห้ามตัดเงียบ (D31/D44)', () => {
    const shown = billListCardMessage({ kind: 'bills', rows: billRows(20), omitted: 3 })
    expect(allText(shown[0]).join('\n')).toContain('3')
  })

  it('ไม่มีของที่ถูกตัดก็ไม่ต้องพูดถึง', () => {
    const texts = allText(billListCardMessage({ kind: 'bills', rows: billRows(2), omitted: 0 })).join('\n')
    expect(texts).not.toContain('อีก')
  })

  it('altText บอกจำนวนบิล — คนเห็นบรรทัดนี้ก่อนเห็นการ์ด', () => {
    const [message] = billListCardMessage({ kind: 'bills', rows: billRows(2), omitted: 0 })
    expect(message?.type === 'flex' && message.altText).toContain('2')
  })

  it('ยาวเกิน bubble ลดรูปเป็นข้อความ ไม่ตัดใบไหนทิ้ง (D44)', () => {
    const messages = billListCardMessage({ kind: 'bills', rows: billRows(400), omitted: 0 })
    expect(messages.every((m) => m.type === 'text')).toBe(true)
    const joined = messages.map((m) => (m.type === 'text' ? m.text : '')).join('\n')
    expect(joined).toContain('บิลที่ 1')
    for (const message of messages) {
      if (message.type === 'text') expect(message.text.length).toBeLessThanOrEqual(5000)
    }
    expect(messages.length).toBeLessThanOrEqual(5)
  })
})

describe('balanceCardMessage — วงที่ใหญ่เกินหนึ่ง bubble (D52)', () => {
  it('เลื่อนข้างก่อน แล้วค่อยลดรูปเป็น text — ไม่มีใครหายทั้งสองทาง', () => {
    // 15 บล็อก ≈ 33 KB ยังอยู่ใต้เพดาน carousel · ใหญ่กว่านี้ตกเป็น text ตามเดิม
    const blocks = Array.from({ length: 15 }, (_, i) => ({
      creditorName: `เจ้าหนี้คนที่ ${i}`,
      totalSatang: 10000,
      rows: Array.from({ length: 8 }, (_, k) => ({
        debtorName: `ลูกหนี้ ${i}-${k}`,
        amountSatang: 1250,
      })),
    }))
    const messages = balanceCardMessage(blocks, 'group')
    expect(messages).toHaveLength(1)
    expect(messages[0]?.type).toBe('flex')
    expect((messages[0] as { contents: { type: string } }).contents.type).toBe('carousel')

    const texts = allText(messages[0]).join(LF)
    for (const block of blocks) expect(texts).toContain(block.creditorName)
  })

  it('ทุก bubble มีหัวการ์ด `ยอดค้าง` กับยอดรวม ไม่ใช่เฉพาะใบแรก', () => {
    const blocks = Array.from({ length: 15 }, (_, i) => ({
      creditorName: `เจ้าหนี้คนที่ ${i}`,
      totalSatang: 10000,
      rows: Array.from({ length: 8 }, (_, k) => ({
        debtorName: `ลูกหนี้ ${i}-${k}`,
        amountSatang: 1250,
      })),
    }))
    const bubbles = bubblesOf(balanceCardMessage(blocks, 'group')[0])
    expect(bubbles.length).toBeGreaterThan(1)
    for (const bubble of bubbles) {
      const texts = allText(bubble).join(LF)
      expect(texts).toContain('ยอดค้าง')
      // 15 บล็อก × ฿100
      expect(texts).toContain('฿1,500')
    }
  })
})

describe('billDetailCardMessage — บิลใบเดียว', () => {
  const DETAIL = {
    description: 'ตี๋น้อย',
    date: '1 ก.ย. 69',
    payerName: 'นัท',
    totalSatang: 90000,
    lines: [
      { name: 'นัท', amountSatang: 30000, isPayer: true },
      { name: 'เดียร์', amountSatang: 30000, isPayer: false },
    ],
  }

  const ITEMIZED = {
    ...DETAIL,
    description: 'soul bingsu',
    totalSatang: 45200,
    items: [
      { name: 'บิงซู', amountSatang: 22000, eaterNames: ['aek', 'dear'] },
      { name: 'ชาเขียว', amountSatang: 4000, eaterNames: ['aek', 'dear', 'game'] },
    ],
  }

  it('บิล itemized โชว์ทั้งรายการและรายคน — คนละคำถามกัน (D51)', () => {
    const texts = allText(billDetailCardMessage(ITEMIZED)[0]).join(LF)
    // รายการตอบ "ใครกินอะไร"
    expect(texts).toContain('บิงซู')
    expect(texts).toContain('฿220')
    expect(texts).toContain('aek, dear')
    // รายคนตอบ "ฉันติดเท่าไหร่" — ต้องยังอยู่ครบ
    expect(texts).toContain('นัท')
    expect(texts).toContain('เดียร์')
  })

  it('บิลที่ยาวเกินหนึ่ง bubble กลายเป็น carousel ไม่ใช่ text (D52)', () => {
    const many = {
      ...DETAIL,
      // ชื่อสั้นพอที่จะไม่ถูก `shorten` ตัด — เทสต์นี้ตรวจว่าไม่มีใครหาย ไม่ใช่ตรวจการตัดชื่อ
      lines: Array.from({ length: 60 }, (_, i) => ({
        name: `เพื่อนหมายเลข ${i}`,
        amountSatang: 1500,
        isPayer: false,
      })),
      items: [{ name: 'บิงซู', amountSatang: 22000, eaterNames: ['aek', 'dear'] }],
    }
    const messages = billDetailCardMessage(many)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.type).toBe('flex')

    const contents = (messages[0] as { contents: { type: string } }).contents
    expect(contents.type).toBe('carousel')

    // **ห้ามตัดใครทิ้ง** — ทุกชื่อต้องยังอยู่ครบ เกณฑ์เดียวกับ D44
    const texts = allText(messages[0]).join(LF)
    for (const line of many.lines) expect(texts).toContain(line.name)
    expect(texts).toContain('บิงซู')
  })

  it('ทุก bubble ของ carousel มีหัวการ์ด — ชื่อบิล วันที่ คนจ่าย ยอดรวม', () => {
    const many = {
      ...DETAIL,
      lines: Array.from({ length: 60 }, (_, i) => ({
        name: `เพื่อนหมายเลข ${i}`,
        amountSatang: 1500,
        isPayer: false,
      })),
      items: [{ name: 'บิงซู', amountSatang: 22000, eaterNames: ['aek', 'dear'] }],
    }
    const bubbles = bubblesOf(billDetailCardMessage(many)[0])
    expect(bubbles.length).toBeGreaterThan(1)
    for (const bubble of bubbles) {
      const texts = allText(bubble).join(LF)
      expect(texts).toContain(DETAIL.description)
      expect(texts).toContain(DETAIL.date)
      expect(texts).toContain(DETAIL.payerName)
      expect(texts).toContain('฿900')
    }
  })

  /**
   * ทาง bubble เดี่ยวคั่นสองส่วนด้วย separator อยู่แล้ว — ทาง carousel ต้องคั่น
   * ด้วย ไม่งั้นแถวสุดท้ายของรายการกับแถวแรกของรายคนไหลติดกันเป็นกองเดียว
   */
  it('carousel ยังมีเส้นคั่นระหว่างส่วนรายการกับส่วนรายคน', () => {
    const many = {
      ...DETAIL,
      lines: Array.from({ length: 60 }, (_, i) => ({
        name: `เพื่อนหมายเลข ${i}`,
        amountSatang: 1500,
        isPayer: false,
      })),
      items: [{ name: 'บิงซู', amountSatang: 22000, eaterNames: ['aek', 'dear'] }],
    }
    const bubbles = bubblesOf(billDetailCardMessage(many)[0])
    // หัวการ์ดมี separator ของตัวเองอยู่แล้วหนึ่งเส้นต่อใบ — ที่นับคือเส้นที่เกินมา
    const separators = countSeparators(bubbles)
    const headerSeparators = countSeparators(bubblesOf(billDetailCardMessage(DETAIL)[0]))
    expect(separators).toBeGreaterThan(headerSeparators * bubbles.length)
  })

  it('บิลที่ยาวจนต้องลดรูปเป็น text ยังขนรายการไปด้วย — ไม่ตัดครึ่งใบทิ้ง', () => {
    // ใหญ่จนแม้แต่ carousel ก็ใส่ไม่ลง — วงขนาดนี้เกินกว่าที่ระบบออกแบบมารับไหว
    const many = {
      ...DETAIL,
      lines: Array.from({ length: 900 }, (_, i) => ({
        name: `เพื่อนคนที่ ${i} ชื่อยาว`,
        amountSatang: 1500,
        isPayer: false,
      })),
      items: [
        { name: 'บิงซูสตรอว์เบอร์รี่', amountSatang: 22000, eaterNames: ['aek', 'dear'] },
        { name: 'ฮันนี่โทสต์', amountSatang: 14900, eaterNames: ['game'] },
      ],
    }
    const messages = billDetailCardMessage(many)
    expect(messages[0]?.type).toBe('text')
    const all = messages.map((m) => (m.type === 'text' ? m.text : '')).join(LF)
    expect(all).toContain('บิงซูสตรอว์เบอร์รี่')
    expect(all).toContain('ฮันนี่โทสต์')
    expect(all).toContain('aek, dear')
  })

  it('บิลที่ไม่มีรายการเงียบเรื่องรายการไปเลย — ห้ามเขียนว่า "ไม่มีรายการ" (D51)', () => {
    const texts = allText(billDetailCardMessage({ ...DETAIL, items: [] })[0]).join(LF)
    expect(texts).not.toContain('รายการ')
  })

  it('โชว์ชื่อบิล วันที่ ยอดรวม และรายคนครบ', () => {
    const texts = allText(billDetailCardMessage(DETAIL)[0]).join('\n')
    expect(texts).toContain('ตี๋น้อย')
    expect(texts).toContain('1 ก.ย. 69')
    expect(texts).toContain('นัท')
    expect(texts).toContain('เดียร์')
  })

  it('ป้ายบอกว่าใครเป็นคนจ่าย — ยอดรายคนอ่านไม่รู้เรื่องถ้าไม่รู้ว่าใครออกก่อน', () => {
    const texts = allText(billDetailCardMessage(DETAIL)[0]).join('\n')
    expect(texts).toContain('จ่าย')
  })

  it('ไม่มีปุ่ม — บิลลง ledger ไปแล้ว ไม่มีอะไรให้กดยืนยันอีก', () => {
    expect(allPostbackData(billDetailCardMessage(DETAIL)[0])).toEqual([])
  })
})

describe('billListCardMessage — ของที่ยาวเกินเพดานของ LINE', () => {
  it('`displayText` ของ postback ต้องถูกตัด — เพดาน 300 ตัวอักษร', () => {
    // คำอธิบายบิลยาวได้ถึงเพดานข้อความของ LINE (เส้น @mention ไม่ต้องมี `+` นำหน้า)
    // · ทะลุเมื่อไหร่ LINE ปฏิเสธ reply ทั้งก้อน แล้วคนพิมพ์ `บิล` จะไม่เห็นอะไรเลย
    const long = 'ก'.repeat(400)
    const [message] = billListCardMessage({
      kind: 'bills',
      rows: [{ id: 'e1', description: long, date: '1 ก.ย. 69', totalSatang: 90000 }],
      omitted: 0,
    })
    for (const value of allDisplayText(message)) {
      expect(value.length).toBeLessThanOrEqual(300)
    }
  })

  it('ลดรูปเป็นข้อความแล้วต้องบอกด้วยว่าแถวกดไม่ได้', () => {
    // ข้อความไม่มี action — คนที่เคยกดแถวได้จะกดแล้วไม่เกิดอะไรโดยไม่รู้สาเหตุ
    const messages = billListCardMessage({ kind: 'bills', rows: billRows(400), omitted: 0 })
    const joined = messages.map((m) => (m.type === 'text' ? m.text : '')).join('\n')
    expect(joined).toContain('กด')
  })
})

describe('billDetailCardMessage — ขนาดกับคนจ่าย', () => {
  function detail(lineCount: number, payerName = 'นัท') {
    return {
      description: 'ตี๋น้อย',
      date: '1 ก.ย. 69',
      payerName,
      totalSatang: lineCount * 10000,
      lines: Array.from({ length: lineCount }, (_, i) => ({
        name: `คนที่ ${i + 1}`,
        amountSatang: 10000,
        isPayer: false,
      })),
    }
  }

  it('บอกว่าใครจ่าย แม้คนจ่ายจะไม่มีแถวของตัวเองในบิล', () => {
    const texts = allText(billDetailCardMessage(detail(2))[0]).join('\n')
    expect(texts).toContain('นัท')
    expect(texts).toContain('จ่าย')
  })

  it('การ์ดที่ใหญ่เกิน bubble ลดรูปเป็นข้อความ ไม่ให้ LINE ปฏิเสธทั้งก้อน', () => {
    const messages = billDetailCardMessage(detail(300))
    expect(messages.every((m) => m.type === 'text')).toBe(true)
    const joined = messages.map((m) => (m.type === 'text' ? m.text : '')).join('\n')
    expect(joined).toContain('ตี๋น้อย')
    expect(joined).toContain('นัท')
    for (const message of messages) {
      if (message.type === 'text') expect(message.text.length).toBeLessThanOrEqual(5000)
    }
    expect(messages.length).toBeLessThanOrEqual(5)
  })
})

/**
 * **ทางลงสุดท้ายของการ์ด Draft** — ก่อนหน้านี้ไม่มี
 *
 * `pages === null` หรือ carousel ทะลุเพดาน แล้วโค้ดคืน bubble ใบเกินเพดานออกไป
 * ทั้งใบ · LINE ปฏิเสธ reply ทั้งก้อน ผลคือ **แถว draft ถูกเขียนไปแล้วแต่ไม่มี
 * การ์ดให้ใครกด** ซึ่งกู้ไม่ได้จนกว่าจะหมดอายุ 24 ชั่วโมง — คนพิมพ์ไม่ได้คำตอบ
 * สักครั้งเดียว และพิมพ์ใหม่ก็ได้ผลเดิม
 *
 * เกณฑ์เดียวกับ `balanceCardMessage`: **ลดรูป ไม่ใช่ตัดเนื้อหา**
 */
describe('draftCardMessage — ใหญ่เกิน carousel ก็ยังต้องมีอะไรให้กด', () => {
  const LIFF_URL = 'https://liff.line.me/1234567890-AbCdEfGh'

  function huge(count: number): DraftCard {
    return {
      description: 'ทริปบริษัท',
      totalSatang: count * 5555,
      lines: Array.from({ length: count }, (_, i) => ({
        name: `เพื่อนหมายเลข ${i}`,
        amountSatang: 5555,
        isNew: i % 2 === 0,
        isPayer: false,
      })),
    }
  }

  /** ใหญ่พอให้ carousel รับไม่ไหว — 10 bubble ต่อ carousel คือเพดานที่ตั้งไว้ */
  const HUGE = huge(600)

  it('ตกลงมาเป็นข้อความ ไม่ใช่ bubble ที่ LINE ปฏิเสธ', () => {
    const messages = draftCardMessage(HUGE, DRAFT_ID)
    expect(messages.length).toBeGreaterThan(0)
    for (const message of messages) expect(message.type).toBe('text')
  })

  it('ทุกก้อนอยู่ใต้เพดานของ LINE และไม่เกินห้าก้อนต่อ reply', () => {
    const messages = draftCardMessage(HUGE, DRAFT_ID)
    expect(messages.length).toBeLessThanOrEqual(5)
    for (const message of messages) {
      if (message.type !== 'text') throw new Error('ต้องเป็นข้อความ')
      expect(message.text.length).toBeLessThanOrEqual(5000)
    }
  })

  /**
   * **นี่คือเหตุผลทั้งหมดที่ทางลงนี้มีอยู่** — ข้อความที่กดยืนยันไม่ได้ก็เท่ากับ
   * ไม่มีการ์ด · postback ติดกับ text message ได้ผ่าน quick reply
   */
  it('ยังกดยืนยันได้ — quick reply ถือ postback ตัวเดิม', () => {
    const messages = draftCardMessage(HUGE, DRAFT_ID)
    expect(findPostbackData(messages)).toBe(`confirm=${DRAFT_ID}`)
  })

  /**
   * LINE แสดง quick reply ของ**ข้อความก้อนสุดท้าย** · ติดไว้ก้อนแรกแล้วมันจะหาย
   * ไปกับก้อนที่ตามมา
   */
  it('quick reply อยู่ก้อนสุดท้าย ไม่ใช่ก้อนแรก', () => {
    const messages = draftCardMessage(HUGE, DRAFT_ID)
    const last = messages[messages.length - 1]
    expect(findPostbackData(last)).toBe(`confirm=${DRAFT_ID}`)
    expect(findPostbackData(messages.slice(0, -1))).toBeNull()
  })

  it('ยังไม่รู้ว่าเขาคือใคร → quick reply เป็นตัวเลือกตัวตน ไม่ใช่ปุ่มยืนยัน', () => {
    const messages = draftCardMessage(HUGE, DRAFT_ID, choices('กอล์ฟ', 'ตูน'))
    const json = JSON.stringify(messages)
    expect(json).toContain(`confirm=${DRAFT_ID}&as=`)
    expect(json).toContain('ฉันเป็นคนใหม่')
  })

  // D16 — ชื่อทุกคนที่จะโดนหารต้องอยู่ครบ ไม่ว่าการ์ดจะถูกลดรูปแค่ไหน
  it('ชื่อทุกคนกับยอดของเขาอยู่ครบ', () => {
    const texts = allText(draftCardMessage(HUGE, DRAFT_ID)).join(LF)
    for (const line of HUGE.lines) expect(texts).toContain(line.name)
  })

  it('ก้อนแรกบอกว่าบิลอะไร ยอดเท่าไหร่', () => {
    const first = allText(draftCardMessage(HUGE, DRAFT_ID)[0]).join(LF)
    expect(first).toContain('ทริปบริษัท')
    expect(first).toContain('฿33,330')
  })

  it('ป้าย (ใหม่) ยังอยู่ — มันคือคำเตือนว่าจะมีคนใหม่เกิดในวงถาวร', () => {
    const texts = allText(draftCardMessage(HUGE, DRAFT_ID)).join(LF)
    expect(texts).toContain('เพื่อนหมายเลข 0 (ใหม่)')
  })

  /**
   * ป้าย event อยู่บนหัวการ์ดทั้ง bubble และทุกใบของ carousel · หายไปในทางลงแปลว่า
   * คนตรวจก่อนกดยืนยันไม่เห็นว่าบิลถูกจดเข้าทริปไหน แล้วแท็กที่พิมพ์ผิดจะลง ledger
   * โดยไม่มีใครทัน — ขัดเกณฑ์ "ลดรูป ไม่ใช่ตัดเนื้อหา" ของทางลงนี้เอง
   */
  it('ป้าย event ยังอยู่ในทางลง', () => {
    const tagged = { ...HUGE, eventTag: 'เชียงใหม่' }
    const first = allText(draftCardMessage(tagged, DRAFT_ID)[0]).join(LF)
    expect(first).toContain('#เชียงใหม่')
  })

  it('ตั้ง LIFF URL แล้ว ทางไปหน้าจดรายชิ้นยังอยู่', () => {
    const texts = allText(draftCardMessage(HUGE, DRAFT_ID, null, LIFF_URL)).join(LF)
    expect(texts).toContain(`${LIFF_URL}?draftId=${DRAFT_ID}`)
  })

  it('ไม่ได้ตั้ง LIFF URL → ไม่มีบรรทัดนั้นเลย ไม่ใช่ลิงก์ที่พัง', () => {
    const texts = allText(draftCardMessage(HUGE, DRAFT_ID)).join(LF)
    expect(texts).not.toContain('liff.line.me')
    // ลิงก์ที่ประกอบจาก null คือลิงก์เสีย ซึ่งแย่กว่าไม่มีบรรทัดนั้นเลย
    expect(texts).not.toContain('จดรายชิ้น')
  })

  /**
   * ใหญ่กว่าที่ระบบนี้ออกแบบมารับไหว — **บอกตรงๆ ว่าตัด** ไม่ใช่เงียบๆ ตัดทิ้ง
   * ซึ่งในบิลคือคนหายไปจากการหารโดยไม่มีอะไรส่งเสียง
   */
  it('ใหญ่จนห้าก้อนยังไม่พอ → บอกว่าตัด ไม่ใช่เงียบ', () => {
    const messages = draftCardMessage(huge(3000), DRAFT_ID)
    expect(messages.length).toBeLessThanOrEqual(5)
    expect(allText(messages).join(LF)).toContain('ยาวเกินกว่าจะส่งในครั้งเดียว')
    // บิลที่ใหญ่จนต้องตัดคือบิลที่คนอยากเปิดหน้าจอไปแก้ที่สุด — ลิงก์ห้ามหายไปกับส่วนที่ถูกตัด
    const withLiff = draftCardMessage(huge(3000), DRAFT_ID, null, LIFF_URL)
    expect(allText(withLiff).join(LF)).toContain(`${LIFF_URL}?draftId=${DRAFT_ID}`)
    // ถึงจะตัด ก็ยังต้องกดยืนยันได้
    expect(findPostbackData(messages)).toBe(`confirm=${DRAFT_ID}`)
  })

  /**
   * **ด่านที่ห้ามพัง** — ไม่ว่าบิลจะใหญ่แค่ไหน สิ่งที่คืนออกไปต้องเป็นของที่ LINE
   * รับได้เสมอ · ค่าที่ยิงคือขนาดรอบๆ จุดที่รูปแบบเปลี่ยน
   */
  it('ทุกขนาดของวง คืนของที่ LINE รับได้เสมอ และกดยืนยันได้เสมอ', () => {
    for (const count of [1, 2, 30, 40, 200, 340, 360, 400, 800, 1500, 3000, 8000]) {
      const messages = draftCardMessage(huge(count), DRAFT_ID, null, LIFF_URL)
      expect(messages.length).toBeGreaterThan(0)
      expect(messages.length).toBeLessThanOrEqual(5)
      for (const message of messages) {
        const bytes = Buffer.byteLength(JSON.stringify(message), 'utf8')
        expect(bytes).toBeLessThanOrEqual(50_000)
        if (message.type === 'text') expect(message.text.length).toBeLessThanOrEqual(5000)
      }
      expect(findPostbackData(messages)).toBe(`confirm=${DRAFT_ID}`)
    }
  })
})

/**
 * การ์ด `ยอด #เชียงใหม่` — **สรุปทริป ไม่ใช่ยอดค้าง** (D60)
 *
 * `settlement` ไม่มี `event_tag` และไม่ชี้ `expense` (D33 ตั้งใจ) การกรองตามแท็ก
 * จึงหักเงินที่จ่ายคืนกันแล้วไม่ได้ · D34 ปฏิเสธ "ตอบยอดพร้อม disclaimer" ไว้แล้ว
 * เพราะคนที่กวาดตาผ่านจำแค่ตัวเลข — **คำบนการ์ดจึงต้องต่างกันเอง** ไม่ใช่พึ่ง
 * บรรทัดเตือนอย่างเดียว
 */
describe('balanceCardMessage — การ์ดสรุปตามแท็ก (D60)', () => {
  const BLOCKS = [
    {
      creditorName: 'กอล์ฟ',
      totalSatang: 90000,
      rows: [
        { debtorName: 'ตูน', amountSatang: 60000 },
        { debtorName: 'เบียร์', amountSatang: 30000 },
      ],
    },
  ]

  it('หัวการ์ดเป็นชื่อแท็ก ไม่ใช่ `ยอดค้าง`', () => {
    const texts = allText(balanceCardMessage(BLOCKS, 'group', 'เชียงใหม่'))
    expect(texts).toContain('สรุป #เชียงใหม่')
    expect(texts).not.toContain('ยอดค้าง')
  })

  /**
   * **ห้ามมีคำว่า "ค้าง" อยู่บนการ์ดนี้เลย** — มันคือคำที่บอกว่าเงินยังไม่ถูกจ่าย
   * ซึ่งการ์ดนี้ตอบไม่ได้ · D33 เขียนไว้ว่าประโยคแบบนั้นไม่มีอยู่ในระบบ
   */
  it('ไม่มีคำว่า "ค้าง" ที่ไหนเลยบนการ์ด', () => {
    const json = JSON.stringify(balanceCardMessage(BLOCKS, 'group', 'เชียงใหม่'))
    expect(json).not.toContain('ค้าง')
  })

  it('หัวบล็อกใช้คำที่ไม่ได้แปลว่ายังไม่ได้จ่าย', () => {
    const texts = allText(balanceCardMessage(BLOCKS, 'group', 'เชียงใหม่'))
    expect(texts).toContain('กอล์ฟ ออกไปก่อน')
    expect(texts).not.toContain('กอล์ฟ ได้คืน')
  })

  it('บอกตรงๆ ว่าไม่ได้หักเงินที่จ่ายคืนกันแล้ว และชี้ทางไปยอดจริง', () => {
    const texts = allText(balanceCardMessage(BLOCKS, 'group', 'เชียงใหม่')).join(LF)
    expect(texts).toContain('ไม่ได้หักเงินที่จ่ายคืน')
    expect(texts).toContain('ยอด')
  })

  it('altText บอกว่าเป็นสรุปของแท็กไหน', () => {
    const [message] = balanceCardMessage(BLOCKS, 'group', 'เชียงใหม่')
    if (message?.type !== 'flex') throw new Error('วงเล็กต้องได้ Flex')
    expect(message.altText).toContain('#เชียงใหม่')
    expect(message.altText.length).toBeLessThanOrEqual(400)
  })

  it('ไม่ส่งแท็กมา = การ์ด `ยอด` เดิมทุกอย่าง', () => {
    expect(balanceCardMessage(BLOCKS, 'group')).toEqual(balanceCardMessage(BLOCKS, 'group', null))
    expect(allText(balanceCardMessage(BLOCKS, 'group'))).toContain('ยอดค้าง')
  })

  /**
   * คนเลื่อนไปใบที่สามต้องยังรู้ว่ากำลังอ่านสรุปของทริป ไม่ใช่ยอดค้าง — หัวการ์ด
   * กับบรรทัดเตือนซ้ำทุกใบด้วยเกณฑ์เดียวกับที่ D52 ให้หัวการ์ดซ้ำ
   */
  it('carousel ซ้ำทั้งหัวและบรรทัดเตือนทุกใบ', () => {
    // 15 บล็อก — ขนาดเดียวกับเทสต์ carousel ของ `ยอด` ซึ่งยังอยู่ใต้เพดาน
    const many = Array.from({ length: 15 }, (_, i) => ({
      creditorName: `เจ้าหนี้คนที่ ${i}`,
      totalSatang: 5000,
      rows: Array.from({ length: 8 }, (_, j) => ({
        debtorName: `ลูกหนี้คนที่ ${i}-${j}`,
        amountSatang: 625,
      })),
    }))
    const [message] = balanceCardMessage(many, 'group', 'เชียงใหม่')
    if (message?.type !== 'flex') throw new Error('ยังต้องเป็น carousel ไม่ใช่ข้อความ')
    const bubbles = bubblesOf(message)
    expect(bubbles.length).toBeGreaterThan(1)
    for (const bubble of bubbles) {
      const texts = allText(bubble).join(LF)
      expect(texts).toContain('สรุป #เชียงใหม่')
      expect(texts).toContain('ไม่ได้หักเงินที่จ่ายคืน')
    }
  })

  it('ทางลงเป็นข้อความก็ยังไม่พูดว่าค้าง', () => {
    const huge = Array.from({ length: 900 }, (_, i) => ({
      creditorName: `เจ้าหนี้คนที่ ${i}`,
      totalSatang: 5000,
      rows: Array.from({ length: 6 }, (_, j) => ({
        debtorName: `ลูกหนี้คนที่ ${i}-${j}`,
        amountSatang: 833,
      })),
    }))
    const messages = balanceCardMessage(huge, 'group', 'เชียงใหม่')
    for (const message of messages) expect(message.type).toBe('text')
    const texts = allText(messages).join(LF)
    expect(texts).toContain('สรุป #เชียงใหม่')
    expect(texts).toContain('ไม่ได้หักเงินที่จ่ายคืน')
    expect(texts).not.toContain('ค้าง')
  })
})

/**
 * บรรทัดเตือนชี้ทางไปยอดจริง — **ต้องชี้ให้ถูกที่ที่คนอ่านอยู่**
 *
 * ในกลุ่ม `ยอด` เปล่าๆ ตกเป็นความเงียบตาม D47 · บอกให้พิมพ์ `ยอด` เฉยๆ แปลว่าเขา
 * จะพิมพ์แล้วไม่มีอะไรเกิดขึ้น ซึ่งอ่านออกได้อย่างเดียวว่าบอทพัง · เกณฑ์เดียวกับที่
 * `buildGuide` ใส่ `@บิลใหญ่` ให้ตามที่ที่ข้อความไปโผล่
 */
describe('balanceCardMessage — บรรทัดเตือนชี้ทางตามที่ที่คนอ่านอยู่', () => {
  const BLOCKS = [
    { creditorName: 'กอล์ฟ', totalSatang: 90000, rows: [{ debtorName: 'ตูน', amountSatang: 90000 }] },
  ]

  it('ในกลุ่มต้องบอกให้เรียกบอทด้วย', () => {
    const texts = allText(balanceCardMessage(BLOCKS, 'group', 'เชียงใหม่')).join(LF)
    expect(texts).toContain('@บิลใหญ่ ยอด')
  })

  it('ใน 1:1 ไม่มี `@บิลใหญ่` — LINE ไม่มี mention ที่นั่น', () => {
    const texts = allText(balanceCardMessage(BLOCKS, 'direct', 'เชียงใหม่')).join(LF)
    expect(texts).toContain('พิมพ์ ยอด')
    expect(texts).not.toContain('@บิลใหญ่')
  })

  /**
   * `push` ขึ้นก้อนใหม่แล้วเริ่มจากบรรทัดนั้นเลย — ก้อนที่สองถึงห้าจึงเป็นรายชื่อ
   * ลอยๆ ที่ไม่บอกว่าเป็นสรุปของทริปหรือยอดค้าง ซึ่งเป็นความต่างทั้งหมดของการ์ดนี้
   */
  it('ทางลงเป็นข้อความ — ทุกก้อนบอกว่ากำลังอ่านอะไรอยู่', () => {
    const huge = Array.from({ length: 900 }, (_, i) => ({
      creditorName: `เจ้าหนี้คนที่ ${i}`,
      totalSatang: 5000,
      rows: Array.from({ length: 6 }, (_, j) => ({
        debtorName: `ลูกหนี้คนที่ ${i}-${j}`,
        amountSatang: 833,
      })),
    }))
    const messages = balanceCardMessage(huge, 'group', 'เชียงใหม่')
    expect(messages.length).toBeGreaterThan(1)
    for (const message of messages) {
      if (message.type !== 'text') throw new Error('ต้องเป็นข้อความ')
      expect(message.text).toContain('สรุป #เชียงใหม่')
      expect(message.text.length).toBeLessThanOrEqual(5000)
    }
  })

  it('ยอดค้างทั้งวงที่ตกเป็นข้อความก็บอกทุกก้อนเหมือนกัน', () => {
    const huge = Array.from({ length: 900 }, (_, i) => ({
      creditorName: `เจ้าหนี้คนที่ ${i}`,
      totalSatang: 5000,
      rows: Array.from({ length: 6 }, (_, j) => ({
        debtorName: `ลูกหนี้คนที่ ${i}-${j}`,
        amountSatang: 833,
      })),
    }))
    const messages = balanceCardMessage(huge, 'group')
    expect(messages.length).toBeGreaterThan(1)
    for (const message of messages) {
      if (message.type !== 'text') throw new Error('ต้องเป็นข้อความ')
      expect(message.text).toContain('ยอดค้างทั้งวง')
    }
  })
})
