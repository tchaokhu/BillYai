import { describe, it, expect } from 'vitest'
import { computeDebts, floatOf } from './debt'
import type { ExpenseForDebt, SettlementForDebt } from './types'

describe('computeDebts', () => {
  it('บิลเดียว คนจ่ายไม่ร่วมหาร — ทุกคนติดคนจ่าย', () => {
    const expenses: ExpenseForDebt[] = [
      {
        payerId: 'a',
        shares: [
          { memberId: 'b', amountSatang: 30000 },
          { memberId: 'c', amountSatang: 20000 },
        ],
      },
    ]

    expect(computeDebts(expenses, [])).toEqual([
      { debtorId: 'b', creditorId: 'a', amountSatang: 30000 },
      { debtorId: 'c', creditorId: 'a', amountSatang: 20000 },
    ])
  })

  it('บิลเดียว คนจ่ายร่วมหารด้วย — share ของตัวเองไม่กลายเป็นหนี้กับตัวเอง', () => {
    const expenses: ExpenseForDebt[] = [
      {
        payerId: 'a',
        shares: [
          { memberId: 'a', amountSatang: 40000 },
          { memberId: 'b', amountSatang: 40000 },
        ],
      },
    ]

    expect(computeDebts(expenses, [])).toEqual([
      { debtorId: 'b', creditorId: 'a', amountSatang: 40000 },
    ])
  })

  it('สองคนจ่ายสลับกัน — หักกลบภายในคู่เหลือทางเดียว', () => {
    const expenses: ExpenseForDebt[] = [
      { payerId: 'a', shares: [{ memberId: 'b', amountSatang: 50000 }] },
      { payerId: 'b', shares: [{ memberId: 'a', amountSatang: 20000 }] },
    ]

    expect(computeDebts(expenses, [])).toEqual([
      { debtorId: 'b', creditorId: 'a', amountSatang: 30000 },
    ])
  })

  it('A ติด B และ B ติด C — ต้องได้ 2 คู่ ห้ามยุบข้ามคนเป็น A ติด C', () => {
    const expenses: ExpenseForDebt[] = [
      { payerId: 'b', shares: [{ memberId: 'a', amountSatang: 50000 }] },
      { payerId: 'c', shares: [{ memberId: 'b', amountSatang: 30000 }] },
    ]

    // ห้ามยุบเป็น a→c 30000 + a→b 20000 แบบ Splitwise — คนต้องจ่ายคืนคนที่
    // สำรองจ่ายให้ตัวเองเท่านั้น (การตัดสินใจเชิงโดเมน ดู CONTEXT.md หัวข้อ Debt)
    expect(computeDebts(expenses, [])).toEqual([
      { debtorId: 'a', creditorId: 'b', amountSatang: 50000 },
      { debtorId: 'b', creditorId: 'c', amountSatang: 30000 },
    ])
  })

  it('หักกลบแล้วเหลือศูนย์พอดี — คู่นั้นต้องหายไป ไม่ใช่คู่ที่มีค่า 0', () => {
    const expenses: ExpenseForDebt[] = [
      { payerId: 'a', shares: [{ memberId: 'b', amountSatang: 25000 }] },
      { payerId: 'b', shares: [{ memberId: 'a', amountSatang: 25000 }] },
    ]

    expect(computeDebts(expenses, [])).toEqual([])
  })

  it('settlement ที่ confirmed หักยอดหนี้', () => {
    const expenses: ExpenseForDebt[] = [
      { payerId: 'a', shares: [{ memberId: 'b', amountSatang: 60000 }] },
    ]
    const settlements: SettlementForDebt[] = [
      { fromId: 'b', toId: 'a', amountSatang: 25000, status: 'confirmed' },
    ]

    expect(computeDebts(expenses, settlements)).toEqual([
      { debtorId: 'b', creditorId: 'a', amountSatang: 35000 },
    ])
  })

  it('settlement ที่ confirmed จ่ายเกิน — หนี้กลับด้าน', () => {
    const expenses: ExpenseForDebt[] = [
      { payerId: 'a', shares: [{ memberId: 'b', amountSatang: 10000 }] },
    ]
    const settlements: SettlementForDebt[] = [
      { fromId: 'b', toId: 'a', amountSatang: 15000, status: 'confirmed' },
    ]

    expect(computeDebts(expenses, settlements)).toEqual([
      { debtorId: 'a', creditorId: 'b', amountSatang: 5000 },
    ])
  })

  it('settlement ที่ยังไม่ confirmed ไม่หักยอดเลย', () => {
    const expenses: ExpenseForDebt[] = [
      { payerId: 'a', shares: [{ memberId: 'b', amountSatang: 60000 }] },
    ]
    const settlements: SettlementForDebt[] = [
      { fromId: 'b', toId: 'a', amountSatang: 10000, status: 'claimed' },
      { fromId: 'b', toId: 'a', amountSatang: 10000, status: 'rejected' },
      { fromId: 'b', toId: 'a', amountSatang: 10000, status: 'cancelled' },
    ]

    expect(computeDebts(expenses, settlements)).toEqual([
      { debtorId: 'b', creditorId: 'a', amountSatang: 60000 },
    ])
  })

  it('settlement confirmed ที่ไม่มีบิลรองรับ — เจ้าหนี้กลายเป็นลูกหนี้', () => {
    const settlements: SettlementForDebt[] = [
      { fromId: 'b', toId: 'a', amountSatang: 7000, status: 'confirmed' },
    ]

    expect(computeDebts([], settlements)).toEqual([
      { debtorId: 'a', creditorId: 'b', amountSatang: 7000 },
    ])
  })

  it('บิลที่ voided ไม่นับ', () => {
    const expenses: ExpenseForDebt[] = [
      {
        payerId: 'a',
        shares: [{ memberId: 'b', amountSatang: 90000 }],
        voided: true,
      },
      {
        payerId: 'a',
        shares: [{ memberId: 'b', amountSatang: 10000 }],
        voided: false,
      },
    ]

    expect(computeDebts(expenses, [])).toEqual([
      { debtorId: 'b', creditorId: 'a', amountSatang: 10000 },
    ])
  })

  it('ไม่มีบิลและไม่มี settlement เลย — คืน array ว่าง', () => {
    expect(computeDebts([], [])).toEqual([])
  })

  it('เรียงผลลัพธ์ตาม debtorId แล้ว creditorId เสมอ', () => {
    const expenses: ExpenseForDebt[] = [
      { payerId: 'c', shares: [{ memberId: 'b', amountSatang: 100 }] },
      { payerId: 'b', shares: [{ memberId: 'a', amountSatang: 200 }] },
      { payerId: 'c', shares: [{ memberId: 'a', amountSatang: 300 }] },
    ]

    expect(computeDebts(expenses, [])).toEqual([
      { debtorId: 'a', creditorId: 'b', amountSatang: 200 },
      { debtorId: 'a', creditorId: 'c', amountSatang: 300 },
      { debtorId: 'b', creditorId: 'c', amountSatang: 100 },
    ])
  })

  it('สลับลำดับ input แล้วผลลัพธ์เหมือนเดิมเป๊ะ', () => {
    const expenses: ExpenseForDebt[] = [
      {
        payerId: 'c',
        shares: [
          { memberId: 'a', amountSatang: 4500 },
          { memberId: 'b', amountSatang: 4500 },
        ],
      },
      { payerId: 'a', shares: [{ memberId: 'c', amountSatang: 1000 }] },
      {
        payerId: 'b',
        shares: [{ memberId: 'a', amountSatang: 2000 }],
        voided: true,
      },
    ]
    const settlements: SettlementForDebt[] = [
      { fromId: 'a', toId: 'c', amountSatang: 500, status: 'confirmed' },
      { fromId: 'b', toId: 'c', amountSatang: 500, status: 'claimed' },
    ]

    const forward = computeDebts(expenses, settlements)
    const reversed = computeDebts([...expenses].reverse(), [...settlements].reverse())

    expect(reversed).toEqual(forward)
    expect(forward).toEqual([
      { debtorId: 'a', creditorId: 'c', amountSatang: 3000 },
      { debtorId: 'b', creditorId: 'c', amountSatang: 4500 },
    ])
  })

  it('ทุกยอดที่คืนออกมาต้องเป็นบวกเสมอ ไม่มีศูนย์หรือติดลบหลุดออกมา', () => {
    const expenses: ExpenseForDebt[] = [
      {
        payerId: 'ตูน',
        shares: [
          { memberId: 'ตูน', amountSatang: 33334 },
          { memberId: 'กอล์ฟ', amountSatang: 33333 },
          { memberId: 'เบียร์', amountSatang: 33333 },
        ],
      },
      { payerId: 'กอล์ฟ', shares: [{ memberId: 'ตูน', amountSatang: 33333 }] },
      { payerId: 'เบียร์', shares: [{ memberId: 'กอล์ฟ', amountSatang: 1 }] },
    ]
    const settlements: SettlementForDebt[] = [
      { fromId: 'เบียร์', toId: 'ตูน', amountSatang: 33333, status: 'confirmed' },
    ]

    const debts = computeDebts(expenses, settlements)

    // กอล์ฟ↔ตูน หักกลบเหลือ 0 และ เบียร์↔ตูน จ่ายครบพอดี — เหลือคู่เดียว
    expect(debts).toEqual([
      { debtorId: 'กอล์ฟ', creditorId: 'เบียร์', amountSatang: 1 },
    ])
    for (const debt of debts) {
      expect(debt.amountSatang).toBeGreaterThan(0)
      expect(Number.isInteger(debt.amountSatang)).toBe(true)
      expect(debt.debtorId).not.toBe(debt.creditorId)
    }
  })

  it('settlement ที่จ่ายให้ตัวเองไม่ทำให้เกิดหนี้กับตัวเอง', () => {
    const settlements: SettlementForDebt[] = [
      { fromId: 'a', toId: 'a', amountSatang: 5000, status: 'confirmed' },
    ]

    expect(computeDebts([], settlements)).toEqual([])
  })
})

describe('floatOf', () => {
  it('รวมทุกคู่ที่คนนั้นเป็นเจ้าหนี้', () => {
    const debts = computeDebts(
      [
        {
          payerId: 'a',
          shares: [
            { memberId: 'a', amountSatang: 10000 },
            { memberId: 'b', amountSatang: 10000 },
            { memberId: 'c', amountSatang: 10000 },
          ],
        },
        { payerId: 'b', shares: [{ memberId: 'c', amountSatang: 2500 }] },
      ],
      [],
    )

    expect(floatOf(debts, 'a')).toBe(20000)
    expect(floatOf(debts, 'b')).toBe(2500)
  })

  it('คนที่ไม่มีใครติด — คืน 0', () => {
    const debts = computeDebts(
      [{ payerId: 'a', shares: [{ memberId: 'b', amountSatang: 5000 }] }],
      [],
    )

    expect(floatOf(debts, 'b')).toBe(0)
    expect(floatOf(debts, 'ไม่มีตัวตน')).toBe(0)
  })

  it('ยอดที่ตัวเองติดคนอื่นไม่หักออกจาก float', () => {
    const debts = computeDebts(
      [
        { payerId: 'a', shares: [{ memberId: 'b', amountSatang: 8000 }] },
        { payerId: 'c', shares: [{ memberId: 'a', amountSatang: 3000 }] },
      ],
      [],
    )

    // float = เงินที่ควักไปก่อนแล้วยังไม่ได้คืน ไม่ใช่ยอดสุทธิของคนคนนั้น
    expect(floatOf(debts, 'a')).toBe(8000)
  })

  it('ไม่มีหนี้เลย — คืน 0', () => {
    expect(floatOf([], 'a')).toBe(0)
  })
})
