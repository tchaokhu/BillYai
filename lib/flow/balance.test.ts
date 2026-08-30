import { describe, expect, it } from 'vitest'
import { buildBalance } from './balance'
import type { PairDebt } from '../types'

/** ชื่อสมมติที่อ่านง่าย — id จริงเป็น uuid ซึ่งไม่ได้ช่วยให้เทสต์อ่านรู้เรื่อง */
const NAMES = new Map([
  ['m-golf', 'กอล์ฟ'],
  ['m-toon', 'ตูน'],
  ['m-beer', 'เบียร์'],
  ['m-nan', 'แนน'],
])

function debt(debtorId: string, creditorId: string, amountSatang: number): PairDebt {
  return { debtorId, creditorId, amountSatang }
}

describe('buildBalance — จัดกลุ่มตามเจ้าหนี้ (D31)', () => {
  it('เจ้าหนี้หนึ่งคน ลูกหนี้หลายคน อยู่บล็อกเดียวกัน', () => {
    const result = buildBalance(
      [debt('m-toon', 'm-golf', 60000), debt('m-beer', 'm-golf', 40000)],
      NAMES,
    )
    expect(result).toEqual({
      kind: 'debts',
      blocks: [
        {
          creditorName: 'กอล์ฟ',
          totalSatang: 100000,
          rows: [
            { debtorName: 'ตูน', amountSatang: 60000 },
            { debtorName: 'เบียร์', amountSatang: 40000 },
          ],
        },
      ],
    })
  })

  it('เจ้าหนี้ที่ได้คืนรวมมากสุดขึ้นก่อน', () => {
    const result = buildBalance(
      [debt('m-toon', 'm-golf', 10000), debt('m-nan', 'm-beer', 90000)],
      NAMES,
    )
    if (result.kind !== 'debts') throw new Error('ต้องมีหนี้')
    expect(result.blocks.map((b) => b.creditorName)).toEqual(['เบียร์', 'กอล์ฟ'])
  })

  it('ในบล็อกเรียงยอดมากไปน้อย', () => {
    const result = buildBalance(
      [
        debt('m-toon', 'm-golf', 10000),
        debt('m-beer', 'm-golf', 50000),
        debt('m-nan', 'm-golf', 30000),
      ],
      NAMES,
    )
    if (result.kind !== 'debts') throw new Error('ต้องมีหนี้')
    expect(result.blocks[0]?.rows.map((r) => r.debtorName)).toEqual(['เบียร์', 'แนน', 'ตูน'])
  })

  it('ยอดเท่ากันตัดสินด้วยชื่อ — ผลต้องไม่ขึ้นกับลำดับที่บิลเข้ามา', () => {
    const forward = buildBalance(
      [debt('m-toon', 'm-golf', 50000), debt('m-beer', 'm-golf', 50000)],
      NAMES,
    )
    const backward = buildBalance(
      [debt('m-beer', 'm-golf', 50000), debt('m-toon', 'm-golf', 50000)],
      NAMES,
    )
    expect(forward).toEqual(backward)
  })

  it('ยอดรวมของเจ้าหนี้เท่ากันก็ยังเรียงเหมือนเดิมทุกครั้ง', () => {
    const pairs = [debt('m-toon', 'm-golf', 50000), debt('m-nan', 'm-beer', 50000)]
    expect(buildBalance(pairs, NAMES)).toEqual(buildBalance([...pairs].reverse(), NAMES))
  })

  it('**ไม่ยุบข้ามคน** — เจ้าหนี้สองคนคือสองบล็อก (D5)', () => {
    // ตูนติดกอล์ฟ กอล์ฟติดเบียร์ — Splitwise จะยุบให้ตูนจ่ายเบียร์ตรงๆ
    // ระบบนี้ไม่ทำ เพราะ "จ่ายคนที่ไม่ได้สำรองจ่ายให้เรา" ทำให้คนงงและเถียงกัน
    const result = buildBalance(
      [debt('m-toon', 'm-golf', 50000), debt('m-golf', 'm-beer', 50000)],
      NAMES,
    )
    if (result.kind !== 'debts') throw new Error('ต้องมีหนี้')
    expect(result.blocks).toHaveLength(2)
    expect(result.blocks.flatMap((b) => b.rows.map((r) => r.debtorName)).sort()).toEqual([
      'กอล์ฟ',
      'ตูน',
    ])
  })

  it('ไม่ตัดใครทิ้ง แม้วงจะใหญ่', () => {
    const many = Array.from({ length: 28 }, (_, i) => debt(`m-${i}`, 'm-golf', 1000 + i))
    const names = new Map([...NAMES, ...many.map((d, i) => [d.debtorId, `คน${i}`] as const)])
    const result = buildBalance(many, names)
    if (result.kind !== 'debts') throw new Error('ต้องมีหนี้')
    expect(result.blocks[0]?.rows).toHaveLength(28)
  })
})

describe('buildBalance — เคสที่ไม่ใช่ "มีหนี้"', () => {
  it('ไม่มีหนี้เลย = เคลียร์กันหมด', () => {
    expect(buildBalance([], NAMES)).toEqual({ kind: 'settled' })
  })

  it('คู่ที่ยอดศูนย์ไม่โผล่ — `computeDebts` ตัดให้แล้ว ที่นี่ไม่ต้องเดาซ้ำ', () => {
    expect(buildBalance([debt('m-toon', 'm-golf', 0)], NAMES)).toEqual({ kind: 'settled' })
  })
})

describe('buildBalance — ชื่อที่หาไม่เจอ', () => {
  it('member ที่ไม่มีชื่อในตารางถูกข้าม ไม่ใช่โชว์ id ดิบ', () => {
    // id ดิบบนการ์ดคือขยะที่คนอ่านไม่รู้เรื่อง และเป็นข้อมูลภายในที่ไม่ควรหลุด
    const result = buildBalance([debt('m-ghost', 'm-golf', 50000)], NAMES)
    expect(result).toEqual({ kind: 'settled' })
  })

  it('ข้ามเฉพาะแถวที่หาชื่อไม่เจอ แถวอื่นยังอยู่', () => {
    const result = buildBalance(
      [debt('m-ghost', 'm-golf', 50000), debt('m-toon', 'm-golf', 30000)],
      NAMES,
    )
    if (result.kind !== 'debts') throw new Error('ต้องมีหนี้')
    expect(result.blocks[0]?.rows).toEqual([{ debtorName: 'ตูน', amountSatang: 30000 }])
    expect(result.blocks[0]?.totalSatang).toBe(30000)
  })
})
