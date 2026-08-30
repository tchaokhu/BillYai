import { describe, expect, it } from 'vitest'
import { PAYER_LABEL, buildDraft } from './draft'
import type { ExpenseDraft } from '../types'

function draft(overrides: Partial<ExpenseDraft> = {}): ExpenseDraft {
  return {
    description: 'ข้าว',
    totalSatang: 120000,
    mode: 'equal',
    participants: [],
    includesPayer: true,
    surchargePct: 0,
    ...overrides,
  }
}

function named(...names: string[]) {
  return names.map((name) => ({ name, weight: 1 }))
}

/** ยอดรวมของทุกแถวบนการ์ด — invariant ที่ห้ามพังไม่ว่าอินพุตเป็นอะไร */
function sum(lines: ReadonlyArray<{ amountSatang: number }>): number {
  return lines.reduce((total, line) => total + line.amountSatang, 0)
}

describe('buildDraft — ระบุชื่อคนหาร', () => {
  it('หารเฉพาะคนที่ถูกเอ่ยชื่อ คนจ่ายไม่อยู่ในรายการ', () => {
    const result = buildDraft(draft({ participants: named('กอล์ฟ', 'ตูน'), includesPayer: false }), [])
    expect(result.kind).toBe('card')
    if (result.kind !== 'card') return
    expect(result.card.lines).toEqual([
      { name: 'กอล์ฟ', amountSatang: 60000, isNew: true },
      { name: 'ตูน', amountSatang: 60000, isNew: true },
    ])
  })

  it('`รวมฉัน` เพิ่มคนจ่ายเป็นอีกหนึ่งแถว', () => {
    const result = buildDraft(
      draft({ totalSatang: 90000, participants: named('กอล์ฟ', 'ตูน'), includesPayer: true }),
      [],
    )
    if (result.kind !== 'card') throw new Error('ต้องได้การ์ด')
    expect(result.card.lines.map((l) => l.name)).toEqual(['กอล์ฟ', 'ตูน', PAYER_LABEL])
    expect(result.card.lines.every((l) => l.amountSatang === 30000)).toBe(true)
  })

  it('คนจ่ายไม่เคยติดป้าย (ใหม่) — ยังไม่รู้ว่าเขาคือใครในวง', () => {
    const result = buildDraft(draft({ participants: named('กอล์ฟ'), includesPayer: true }), [])
    if (result.kind !== 'card') throw new Error('ต้องได้การ์ด')
    expect(result.card.lines.find((l) => l.name === PAYER_LABEL)?.isNew).toBe(false)
  })

  it('คนในวงที่ชื่อ "คุณ" จริงๆ ไม่ยุบรวมกับแถวของคนจ่าย', () => {
    // น้ำหนักต่างกันโดยตั้งใจ — ถ้าคีย์ภายในของคนจ่ายชนกับชื่อจริงของคนในวง
    // สองแถวจะได้ยอดเดียวกันแล้วผลรวมจะไม่เท่ายอดบิล
    const result = buildDraft(
      draft({
        totalSatang: 100000,
        mode: 'share',
        includesPayer: true,
        participants: [
          { name: 'คุณ', weight: 3 },
          { name: 'ตูน', weight: 1 },
        ],
      }),
      [],
    )
    if (result.kind !== 'card') throw new Error('ต้องได้การ์ด')
    expect(result.card.lines).toHaveLength(3)
    expect(result.card.lines.map((l) => l.amountSatang)).toEqual([60000, 20000, 20000])
    expect(sum(result.card.lines)).toBe(100000)
  })

  it('น้ำหนักจาก `กอล์ฟx2`', () => {
    const result = buildDraft(
      draft({
        totalSatang: 800000,
        mode: 'share',
        includesPayer: false,
        participants: [
          { name: 'กอล์ฟ', weight: 2 },
          { name: 'เบียร์', weight: 1 },
          { name: 'ตูน', weight: 1 },
        ],
      }),
      [],
    )
    if (result.kind !== 'card') throw new Error('ต้องได้การ์ด')
    expect(result.card.lines.map((l) => l.amountSatang)).toEqual([400000, 200000, 200000])
  })
})

describe('buildDraft — ไม่ระบุชื่อใครเลย', () => {
  it('หารทุกคนใน Roster', () => {
    const result = buildDraft(draft(), ['กอล์ฟ', 'ตูน', 'เบียร์'])
    if (result.kind !== 'card') throw new Error('ต้องได้การ์ด')
    expect(result.card.lines.map((l) => l.name)).toEqual(['กอล์ฟ', 'ตูน', 'เบียร์'])
    expect(result.card.lines.every((l) => l.amountSatang === 40000)).toBe(true)
  })

  it('ทุกคนใน Roster ไม่ติดป้าย (ใหม่) เพราะวงรู้จักอยู่แล้ว', () => {
    const result = buildDraft(draft(), ['กอล์ฟ', 'ตูน'])
    if (result.kind !== 'card') throw new Error('ต้องได้การ์ด')
    expect(result.card.lines.every((l) => l.isNew === false)).toBe(true)
  })

  it('ไม่เพิ่มแถว "คุณ" — คนจ่ายอยู่ใน Roster แล้วถ้าเคยยืนยันตัวตน', () => {
    const result = buildDraft(draft(), ['กอล์ฟ', 'ตูน'])
    if (result.kind !== 'card') throw new Error('ต้องได้การ์ด')
    expect(result.card.lines.map((l) => l.name)).not.toContain(PAYER_LABEL)
  })

  it('Roster ว่าง = ยังไม่รู้จักใคร ต้องขอชื่อ ไม่ใช่สร้างการ์ด', () => {
    // การ์ดที่มีแต่คนจ่ายคนเดียวคือบิลที่ไม่มีหนี้อยู่ในนั้น กดยืนยันแล้วไม่ได้อะไร
    expect(buildDraft(draft(), [])).toEqual({ kind: 'need-names' })
  })
})

describe('buildDraft — ป้าย (ใหม่) ตาม D28', () => {
  it('เทียบชื่อแบบ exact ไม่ใช่ fuzzy', () => {
    // `กอล์ป` ต่างจาก `กอล์ฟ` หนึ่งตัวอักษร — เดาให้แล้วบิลไปลงหัวคนผิดแบบเงียบ
    const result = buildDraft(
      draft({ participants: named('กอล์ฟ', 'กอล์ป'), includesPayer: false }),
      ['กอล์ฟ'],
    )
    if (result.kind !== 'card') throw new Error('ต้องได้การ์ด')
    expect(result.card.lines).toEqual([
      { name: 'กอล์ฟ', amountSatang: 60000, isNew: false },
      { name: 'กอล์ป', amountSatang: 60000, isNew: true },
    ])
  })

  it('ช่องว่างหัวท้ายไม่ทำให้กลายเป็นคนใหม่', () => {
    const result = buildDraft(draft({ participants: named(' กอล์ฟ '), includesPayer: false }), [
      'กอล์ฟ',
    ])
    if (result.kind !== 'card') throw new Error('ต้องได้การ์ด')
    expect(result.card.lines[0]?.isNew).toBe(false)
  })
})

describe('buildDraft — ยอดบนการ์ดต้องเป็นยอดที่จะลง ledger', () => {
  it('ผลรวมของทุกแถวเท่ากับยอดบิลเป๊ะ แม้หารไม่ลงตัว', () => {
    const result = buildDraft(
      draft({ totalSatang: 120100, participants: named('ก', 'ข', 'ค'), includesPayer: false }),
      [],
    )
    if (result.kind !== 'card') throw new Error('ต้องได้การ์ด')
    expect(sum(result.card.lines)).toBe(120100)
    expect(result.card.totalSatang).toBe(120100)
  })

  it('เศษไม่หายและไม่งอก ทุกจำนวนคนตั้งแต่ 1 ถึง 12', () => {
    for (let count = 1; count <= 12; count++) {
      const names = Array.from({ length: count }, (_, i) => `คน${i}`)
      const result = buildDraft(
        draft({ totalSatang: 100003, participants: named(...names), includesPayer: false }),
        [],
      )
      if (result.kind !== 'card') throw new Error('ต้องได้การ์ด')
      expect(sum(result.card.lines)).toBe(100003)
    }
  })

  it('`eventTag` ติดไปกับการ์ด', () => {
    const result = buildDraft(
      draft({ participants: named('กอล์ฟ'), includesPayer: false, eventTag: 'เชียงใหม่' }),
      [],
    )
    if (result.kind !== 'card') throw new Error('ต้องได้การ์ด')
    expect(result.card.eventTag).toBe('เชียงใหม่')
  })

  it('ไม่มี `eventTag` ก็ไม่มีคีย์นั้น', () => {
    const result = buildDraft(draft({ participants: named('กอล์ฟ'), includesPayer: false }), [])
    if (result.kind !== 'card') throw new Error('ต้องได้การ์ด')
    expect('eventTag' in result.card).toBe(false)
  })

  it('description ติดไปกับการ์ด', () => {
    const result = buildDraft(
      draft({ description: 'หมูกระทะ', participants: named('กอล์ฟ'), includesPayer: false }),
      [],
    )
    if (result.kind !== 'card') throw new Error('ต้องได้การ์ด')
    expect(result.card.description).toBe('หมูกระทะ')
  })
})
