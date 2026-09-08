import { describe, expect, it } from 'vitest'
import { eatersOf, isNewName, parseSatang, payerOf, scaleRound, similarName, totalsOf } from './bill'
import type { BillState } from './bill'
import type { DraftLine } from '@/lib/types'

const BILL: BillState = {
  paidSatang: 48700,
  people: ['aek', 'dear'],
  payerName: 'aek',
  items: [
    { name: 'บิงซู', amountSatang: 22000, eaterNames: ['aek', 'dear'] },
    { name: 'โทสต์', amountSatang: 18000, eaterNames: ['dear'] },
    { name: 'ชาเขียว', amountSatang: 4000, eaterNames: [] },
  ],
  mode: 'auto',
  svcOn: false,
  vatOn: false,
  svcPct: 1000,
  vatPct: 700,
  typedAdjustmentSatang: 0,
}

describe('payerOf — คนจ่ายมาจากแถวของ draft เท่านั้น', () => {
  const line = (name: string, isPayer: boolean): DraftLine => ({
    name,
    amountSatang: 60000,
    isNew: false,
    isPayer,
  })

  it('แถวที่ติดป้าย `isPayer` คือคนจ่าย', () => {
    expect(payerOf([line('คุณ', true), line('dear', false)])).toBe('คุณ')
  })

  /**
   * `+ ข้าว 1200 กอล์ฟ ตูน` ที่ไม่มี `รวมฉัน` — คนพิมพ์จ่ายแทนล้วน ไม่ได้กินด้วย
   * จึงไม่มีแถวของเขาในบิล · **เดาว่าเป็นคนแรกในลิสต์คือติดป้ายผิดคน** แล้วคนนั้น
   * จะหายจากบิลทั้งคนตอนกดยืนยัน เพราะแถว `isPayer` ถูกยัดให้คนที่กดยืนยัน
   */
  it('ไม่มีแถวไหนติดป้ายเลย → `null` ไม่ใช่คนแรกในลิสต์', () => {
    expect(payerOf([line('กอล์ฟ', false), line('ตูน', false)])).toBeNull()
  })
})

/**
 * ป้าย `(ใหม่)` บนหน้าจอต้องตอบเหมือน `saveLiffDraft` เป๊ะ — ไม่งั้นคนเห็นป้ายตอน
 * แก้ แล้วป้ายหายตอนเซฟ (หรือกลับกัน) ซึ่งอ่านได้ว่าระบบเปลี่ยนใจเงียบๆ
 */
describe('isNewName — ป้าย `(ใหม่)`', () => {
  it('ชื่อที่วงยังไม่รู้จักติดป้าย ชื่อที่รู้จักแล้วไม่ติด', () => {
    expect(isNewName('แนน', 'คุณ', ['dear'])).toBe(true)
    expect(isNewName('dear', 'คุณ', ['dear'])).toBe(false)
  })

  /**
   * แถวของคนพิมพ์ชื่อ `คุณ` (ADR 0002) ซึ่งไม่มีวันอยู่ใน Roster — เทียบตรงๆ จึง
   * ติดป้ายให้เขาทุกครั้ง · `save.ts` จงใจไม่ติด หน้าจอต้องตอบเหมือนกัน
   */
  it('คนจ่ายไม่ติดป้ายเลย ต่อให้ชื่อไม่อยู่ใน Roster', () => {
    expect(isNewName('คุณ', 'คุณ', ['dear'])).toBe(false)
  })

  it('บิลที่คนจ่ายไม่ได้อยู่ในบิล — ทุกชื่อยังเทียบกับ Roster ตามปกติ', () => {
    expect(isNewName('กอล์ฟ', null, ['dear'])).toBe(true)
    expect(isNewName('dear', null, ['dear'])).toBe(false)
  })
})

describe('totalsOf — โหมด auto (ส่วนต่าง)', () => {
  it('ส่วนปรับคือ `ยอดที่จ่ายจริง − รวมรายชิ้น` และผลรวมรายคนเท่ายอดที่จ่ายจริง', () => {
    const totals = totalsOf(BILL)
    expect(totals.sumItemsSatang).toBe(44000)
    expect(totals.adjustmentSatang).toBe(4700)
    expect(totals.driftSatang).toBe(0)
    expect(totals.blocked).toBe(false)
    expect(totals.shares.reduce((sum, share) => sum + share.amountSatang, 0)).toBe(48700)
  })

  it('ยอดหัวน้อยกว่ารายชิ้นในโหมด auto = จดตก ไม่ใช่ส่วนลด → เซฟไม่ได้ (D54)', () => {
    expect(totalsOf({ ...BILL, paidSatang: 40000 }).blocked).toBe(true)
  })

  it('ไม่มีรายการเลย → เซฟไม่ได้', () => {
    expect(totalsOf({ ...BILL, items: [] }).blocked).toBe(true)
  })

  /**
   * `assertItems` ตอน commit ต้องการราคา `> 0` ทุกชิ้น — ปล่อยให้เซฟได้แปลว่า
   * ปุ่มยืนยันในแชทจะ 500 แล้ว LINE ยิง postback เดิมกลับมาไม่รู้จบ
   */
  it('มีรายการราคาศูนย์ปนอยู่ → เซฟไม่ได้ ("น้ำเปล่า ฟรี" ต้องลบทิ้ง ไม่ใช่จดเป็น 0)', () => {
    expect(
      totalsOf({
        ...BILL,
        paidSatang: 44000,
        items: [
          { name: 'บิงซู', amountSatang: 44000, eaterNames: ['aek'] },
          { name: 'น้ำเปล่า', amountSatang: 0, eaterNames: ['dear'] },
        ],
      }).blocked,
    ).toBe(true)
  })
})

describe('totalsOf — โหมด rates (ติ๊ก % )', () => {
  const rates: BillState = { ...BILL, mode: 'rates', svcOn: true, vatOn: true }

  /**
   * **VAT ทบบน `รวมรายชิ้น + service` ไม่ใช่บน subtotal เปล่าๆ** (D54)
   *
   * 440.00 → service 10% = 44.00 → VAT 7% ของ 484.00 = 33.88 → รวม 77.88
   * ซึ่งคือ 17.7% ไม่ใช่ 17% (ถ้าบวกกันเฉยๆ จะได้ 74.80)
   */
  it('VAT ทบบน service charge — 10% แล้ว 7% = 17.7% ไม่ใช่ 17%', () => {
    const totals = totalsOf({ ...rates, paidSatang: 44000 + 7788 })
    expect(totals.serviceSatang).toBe(4400)
    expect(totals.vatSatang).toBe(3388)
    expect(totals.adjustmentSatang).toBe(7788)
    expect(totals.driftSatang).toBe(0)
    expect(totals.blocked).toBe(false)
  })

  it('ติ๊ก VAT อย่างเดียว — ฐานคือรวมรายชิ้นเปล่าๆ', () => {
    const totals = totalsOf({ ...rates, svcOn: false, paidSatang: 44000 + 3080 })
    expect(totals.serviceSatang).toBe(0)
    expect(totals.vatSatang).toBe(3080)
  })

  /**
   * ยอดหัวเป็น**ตัวทาน**ในโหมดนี้ — ลืมจดรายการแล้วผลบวกไม่ถึงยอดหัว จึงจับได้
   * ต่างจากโหมด auto ที่ส่วนต่างจะกลืนความผิดพลาดนั้นไปเงียบๆ
   */
  it('ยอดหัวไม่ตรงกับ รายชิ้น + % → drift ไม่เป็นศูนย์ แล้วเซฟไม่ได้', () => {
    const totals = totalsOf({ ...rates, paidSatang: 50000 })
    expect(totals.driftSatang).not.toBe(0)
    expect(totals.blocked).toBe(true)
  })

  it('ติ๊กออกหมดในโหมด rates = ส่วนปรับศูนย์ ไม่ใช่กลับไปคิดส่วนต่างให้เอง', () => {
    const totals = totalsOf({ ...rates, svcOn: false, vatOn: false, paidSatang: 44000 })
    expect(totals.adjustmentSatang).toBe(0)
    expect(totals.blocked).toBe(false)
  })
})

describe('totalsOf — โหมด amount (พิมพ์เอง)', () => {
  it('ส่วนลดที่พิมพ์เองติดลบได้ ถ้ายอดหัวยังตรง (D54)', () => {
    const totals = totalsOf({
      ...BILL,
      mode: 'amount',
      typedAdjustmentSatang: -4000,
      paidSatang: 40000,
    })
    expect(totals.adjustmentSatang).toBe(-4000)
    expect(totals.driftSatang).toBe(0)
    expect(totals.blocked).toBe(false)
  })

  it('พิมพ์ส่วนปรับแล้วยอดหัวไม่ตรง → เซฟไม่ได้', () => {
    expect(
      totalsOf({ ...BILL, mode: 'amount', typedAdjustmentSatang: 1000, paidSatang: 48700 })
        .blocked,
    ).toBe(true)
  })
})

describe('eatersOf — ของกลาง (D53)', () => {
  it('ไม่ติ๊กใครเลย = ทุกคนในบิล', () => {
    expect(eatersOf({ name: 'ชาเขียว', amountSatang: 4000, eaterNames: [] }, ['a', 'b'])).toEqual([
      'a',
      'b',
    ])
  })

  it('ติ๊กแล้วใช้ตามที่ติ๊ก', () => {
    expect(eatersOf({ name: 'x', amountSatang: 1, eaterNames: ['a'] }, ['a', 'b'])).toEqual(['a'])
  })
})

describe('scaleRound — ปัดครึ่งขึ้นทั้งบวกและลบ', () => {
  it.each([
    [50, 100, 1],
    [49, 100, 0],
    [150, 100, 2],
    [-50, 100, -1],
  ])('scaleRound(%i, %i) = %i', (numerator, denominator, expected) => {
    expect(scaleRound(numerator, denominator)).toBe(expected)
  })
})

describe('parseSatang', () => {
  it.each([
    ['487', 48700],
    ['487.00', 48700],
    ['487.5', 48750],
    ['1,200', 120000],
    ['  220  ', 22000],
  ])('อ่าน %s เป็น %i สตางค์', (text, expected) => {
    expect(parseSatang(text)).toBe(expected)
  })

  it.each(['', 'สองร้อย', '1.234', '4-8-7', '487.'])('อ่าน %s ไม่ออก → null', (text) => {
    expect(parseSatang(text)).toBeNull()
  })

  it('ค่าติดลบผ่านเฉพาะตอนที่ผู้เรียกอนุญาต — ราคารายชิ้นติดลบไม่ได้ (D54)', () => {
    expect(parseSatang('-50')).toBeNull()
    expect(parseSatang('-50', true)).toBe(-5000)
  })
})

describe('similarName — เตือน ไม่ห้าม (D55)', () => {
  it('ต่างกันตัวเดียวถือว่าคล้าย', () => {
    expect(similarName('โจ', ['โจ้', 'ตูน'])).toBe('โจ้')
  })

  it('ต่างกันแค่ตัวพิมพ์ถือว่าคล้าย', () => {
    expect(similarName('Aek', ['aek'])).toBe('aek')
  })

  it('ชื่อที่ต่างกันชัดเจนไม่เตือน', () => {
    expect(similarName('แนน', ['กอล์ฟ', 'ตูน'])).toBeNull()
  })

  it('ชื่อเดียวกันเป๊ะไม่ใช่เรื่องให้เตือน — เป็นคนเดิม', () => {
    expect(similarName('ตูน', ['ตูน'])).toBeNull()
  })
})
