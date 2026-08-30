import { describe, expect, it } from 'vitest'
import { draftCardMessage } from './flex'
import type { DraftCard } from '../flow/draft'

const CARD: DraftCard = {
  description: 'ข้าว',
  totalSatang: 120000,
  lines: [
    { name: 'กอล์ฟ', amountSatang: 60000, isNew: true },
    { name: 'ตูน', amountSatang: 60000, isNew: false },
  ],
}

const DRAFT_ID = '4f1c2a5e-0000-4000-8000-000000000001'

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
