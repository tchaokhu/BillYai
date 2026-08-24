import { describe, it, expect } from 'vitest'
import { splitExpense } from './split.js'
import type { Item, SplitInput, SplitMode } from './types.js'

/** อินพุตพื้นฐาน — เทสต์แต่ละตัวทับเฉพาะ field ที่สนใจ */
function input(over: Partial<SplitInput> = {}): SplitInput {
  return {
    totalSatang: 30000,
    surchargePct: 0,
    payerId: 'a',
    mode: 'equal',
    participants: [{ memberId: 'a' }, { memberId: 'b' }, { memberId: 'c' }],
    ...over,
  }
}

const amounts = (shares: { amountSatang: number }[]) => shares.map((s) => s.amountSatang)
const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0)

describe('splitExpense — โหมด equal', () => {
  it('หารเท่าลงตัว', () => {
    const shares = splitExpense(input({ totalSatang: 30000 }))
    expect(shares).toEqual([
      { memberId: 'a', amountSatang: 10000 },
      { memberId: 'b', amountSatang: 10000 },
      { memberId: 'c', amountSatang: 10000 },
    ])
  })

  it('หารเท่าไม่ลงตัว — 1200 สตางค์ / 7 คน ผลรวมยังตรงเป๊ะ', () => {
    const participants = 'abcdefg'.split('').map((memberId) => ({ memberId }))
    const shares = splitExpense(input({ totalSatang: 1200, participants, payerId: 'z' }))
    expect(sum(amounts(shares))).toBe(1200)
    expect(amounts(shares).sort((x, y) => x - y)).toEqual([171, 171, 171, 171, 172, 172, 172])
  })

  it('คนจ่ายรับเศษจริง', () => {
    // 100 สตางค์ / 3 คน → 34/33/33 ก้อน 34 ต้องตกกับ payer
    const shares = splitExpense(input({ totalSatang: 100, payerId: 'c' }))
    expect(amounts(shares)).toEqual([33, 33, 34])
    expect(amounts(splitExpense(input({ totalSatang: 100, payerId: 'a' })))).toEqual([34, 33, 33])
  })

  it('ไม่สนใจ field weight', () => {
    const participants = [
      { memberId: 'a', weight: 5 },
      { memberId: 'b', weight: 1 },
    ]
    expect(amounts(splitExpense(input({ totalSatang: 1000, participants })))).toEqual([500, 500])
  })

  it('คนเดียวได้ทั้งก้อน', () => {
    const shares = splitExpense(input({ totalSatang: 12345, participants: [{ memberId: 'a' }] }))
    expect(shares).toEqual([{ memberId: 'a', amountSatang: 12345 }])
  })

  it('เรียงตามลำดับเดิมใน participants', () => {
    const participants = [{ memberId: 'z' }, { memberId: 'a' }, { memberId: 'm' }]
    const shares = splitExpense(input({ participants }))
    expect(shares.map((s) => s.memberId)).toEqual(['z', 'a', 'm'])
  })
})

describe('splitExpense — โหมด share', () => {
  it('น้ำหนัก [2,1,1]', () => {
    const participants = [
      { memberId: 'a', weight: 2 },
      { memberId: 'b', weight: 1 },
      { memberId: 'c', weight: 1 },
    ]
    const shares = splitExpense(input({ mode: 'share', totalSatang: 40000, participants }))
    expect(amounts(shares)).toEqual([20000, 10000, 10000])
  })

  it('ไม่ระบุ weight = 1', () => {
    const participants = [{ memberId: 'a', weight: 3 }, { memberId: 'b' }]
    const shares = splitExpense(input({ mode: 'share', totalSatang: 4000, participants }))
    expect(amounts(shares)).toEqual([3000, 1000])
  })

  it('น้ำหนักทศนิยม — ผลรวมยังตรง', () => {
    const participants = [
      { memberId: 'a', weight: 1.5 },
      { memberId: 'b', weight: 1 },
    ]
    const shares = splitExpense(input({ mode: 'share', totalSatang: 1000, participants }))
    expect(amounts(shares)).toEqual([600, 400])
  })

  it('หารไม่ลงตัว — คนจ่ายรับเศษ', () => {
    const participants = [
      { memberId: 'a', weight: 1 },
      { memberId: 'b', weight: 1 },
      { memberId: 'c', weight: 1 },
    ]
    const shares = splitExpense(input({ mode: 'share', totalSatang: 100, participants, payerId: 'b' }))
    expect(amounts(shares)).toEqual([33, 34, 33])
    expect(sum(amounts(shares))).toBe(100)
  })
})

describe('splitExpense — surcharge', () => {
  it('17% บวกเข้ายอดรวมแล้วหารเท่า', () => {
    const participants = [{ memberId: 'a' }, { memberId: 'b' }]
    const shares = splitExpense(input({ totalSatang: 10000, surchargePct: 17, participants }))
    expect(sum(amounts(shares))).toBe(11700)
    expect(amounts(shares)).toEqual([5850, 5850])
  })

  it('กระจายตามสัดส่วน subtotal ไม่ใช่หารเท่า — คนกินเยอะจ่าย surcharge เยอะกว่า', () => {
    const participants = [
      { memberId: 'a', weight: 3 },
      { memberId: 'b', weight: 1 },
    ]
    const shares = splitExpense(
      input({ mode: 'share', totalSatang: 10000, surchargePct: 17, participants }),
    )
    // subtotal 7500/2500 → surcharge 1700 ต้องแบ่ง 1275/425 ไม่ใช่ 850/850
    expect(amounts(shares)).toEqual([8775, 2925])
    expect(amounts(shares)[0]! - 7500).toBe(1275)
    expect(amounts(shares)[1]! - 2500).toBe(425)
    expect(sum(amounts(shares))).toBe(11700)
  })

  it('surchargePct เป็น 0 → ยอดรวมเท่าเดิม', () => {
    const shares = splitExpense(input({ totalSatang: 30000, surchargePct: 0 }))
    expect(sum(amounts(shares))).toBe(30000)
  })

  it('เปอร์เซ็นต์ทศนิยม', () => {
    const participants = [{ memberId: 'a' }]
    const shares = splitExpense(input({ totalSatang: 1000, surchargePct: 7.5, participants }))
    expect(amounts(shares)).toEqual([1075])
  })

  it('ปัดครึ่งขึ้นเป็น integer สตางค์', () => {
    const one = [{ memberId: 'a' }]
    // 333 × 1.17 = 389.61 → 390
    expect(
      amounts(splitExpense(input({ totalSatang: 333, surchargePct: 17, participants: one }))),
    ).toEqual([390])
    // 10 × 1.05 = 10.5 → ครึ่งพอดี ปัดขึ้นเป็น 11
    expect(
      amounts(splitExpense(input({ totalSatang: 10, surchargePct: 5, participants: one }))),
    ).toEqual([11])
  })

  it('surchargePct ติดลบหรือไม่ finite → error', () => {
    expect(() => splitExpense(input({ surchargePct: -1 }))).toThrow()
    expect(() => splitExpense(input({ surchargePct: NaN }))).toThrow()
    expect(() => splitExpense(input({ surchargePct: Infinity }))).toThrow()
  })
})

describe('splitExpense — โหมด exact', () => {
  it('ยอดที่ระบุตรงๆ ไม่มี surcharge → ได้คืนเป๊ะตามที่ระบุ', () => {
    const participants = [
      { memberId: 'a', exactSatang: 10000 },
      { memberId: 'b', exactSatang: 15000 },
      { memberId: 'c', exactSatang: 5000 },
    ]
    const shares = splitExpense(input({ mode: 'exact', totalSatang: 30000, participants }))
    expect(amounts(shares)).toEqual([10000, 15000, 5000])
  })

  it('surcharge กระจายตามสัดส่วน exactSatang', () => {
    const participants = [
      { memberId: 'a', exactSatang: 333 },
      { memberId: 'b', exactSatang: 667 },
    ]
    // 1000 × 1.10 = 1100 → a 366.3 / b 733.7 เศษตกกับคนที่เศษมากกว่า (b)
    const shares = splitExpense(
      input({ mode: 'exact', totalSatang: 1000, surchargePct: 10, participants }),
    )
    expect(amounts(shares)).toEqual([366, 734])
    expect(sum(amounts(shares))).toBe(1100)
  })

  it('exactSatang เป็น 0 ได้ — ยังอยู่ในผลลัพธ์และยอดรวมไม่เพี้ยน', () => {
    const participants = [
      { memberId: 'a', exactSatang: 1000 },
      { memberId: 'b', exactSatang: 0 },
      { memberId: 'c', exactSatang: 0 },
    ]
    const shares = splitExpense(
      input({ mode: 'exact', totalSatang: 1000, surchargePct: 17, participants }),
    )
    expect(shares).toEqual([
      { memberId: 'a', amountSatang: 1170 },
      { memberId: 'b', amountSatang: 0 },
      { memberId: 'c', amountSatang: 0 },
    ])
  })

  it('เศษเท่ากัน คนจ่ายได้ก่อน แล้วไล่ตาม index', () => {
    const participants = [
      { memberId: 'a', exactSatang: 100 },
      { memberId: 'b', exactSatang: 100 },
      { memberId: 'c', exactSatang: 100 },
    ]
    // 300 × 1.005 = 301.5 → ปัดขึ้น 302 เหลือเศษ 2 ก้อน: payer 'c' ก่อน แล้ว 'a'
    const shares = splitExpense(
      input({ mode: 'exact', totalSatang: 300, surchargePct: 0.5, payerId: 'c', participants }),
    )
    expect(amounts(shares)).toEqual([101, 100, 101])
    expect(sum(amounts(shares))).toBe(302)
  })

  it('ผลรวม exactSatang ไม่เท่ากับ totalSatang → error ไม่ใช่เดาให้', () => {
    const participants = [
      { memberId: 'a', exactSatang: 500 },
      { memberId: 'b', exactSatang: 400 },
    ]
    expect(() => splitExpense(input({ mode: 'exact', totalSatang: 1000, participants }))).toThrow()
  })

  it('มีคนไม่ระบุ exactSatang → error', () => {
    const participants = [{ memberId: 'a', exactSatang: 1000 }, { memberId: 'b' }]
    expect(() => splitExpense(input({ mode: 'exact', totalSatang: 1000, participants }))).toThrow()
  })

  it('exactSatang ติดลบ → error แม้ผลรวมจะตรง', () => {
    const participants = [
      { memberId: 'a', exactSatang: 1100 },
      { memberId: 'b', exactSatang: -100 },
    ]
    expect(() => splitExpense(input({ mode: 'exact', totalSatang: 1000, participants }))).toThrow()
  })

  it('exactSatang ไม่ใช่ integer → error', () => {
    const participants = [
      { memberId: 'a', exactSatang: 500.5 },
      { memberId: 'b', exactSatang: 499.5 },
    ]
    expect(() => splitExpense(input({ mode: 'exact', totalSatang: 1000, participants }))).toThrow()
  })
})

describe('splitExpense — โหมด itemized', () => {
  it('แต่ละชิ้นหารเท่าในกลุ่มคนกิน แล้วรวมเป็น subtotal รายคน', () => {
    const items = [
      { name: 'ข้าว', amountSatang: 600, memberIds: ['a', 'b'] },
      { name: 'เบียร์', amountSatang: 400, memberIds: ['b', 'c'] },
    ]
    const shares = splitExpense(input({ mode: 'itemized', totalSatang: 1000, items }))
    // a = 300 · b = 300 + 200 · c = 200
    expect(amounts(shares)).toEqual([300, 500, 200])
  })

  it('เศษภายในชิ้นตกกับคนจ่าย ถ้าเขากินชิ้นนั้น', () => {
    const items = [{ name: 'หมูกระทะ', amountSatang: 100, memberIds: ['a', 'b', 'c'] }]
    expect(
      amounts(splitExpense(input({ mode: 'itemized', totalSatang: 100, items, payerId: 'b' }))),
    ).toEqual([33, 34, 33])
    expect(
      amounts(splitExpense(input({ mode: 'itemized', totalSatang: 100, items, payerId: 'a' }))),
    ).toEqual([34, 33, 33])
  })

  it('คนที่ไม่ได้กินอะไรเลยได้ 0 แต่ยังอยู่ในผลลัพธ์ และยอดรวมไม่เพี้ยน', () => {
    const items = [{ name: 'ข้าว', amountSatang: 1000, memberIds: ['a', 'b'] }]
    const shares = splitExpense(
      input({ mode: 'itemized', totalSatang: 1000, surchargePct: 17, items }),
    )
    expect(shares).toEqual([
      { memberId: 'a', amountSatang: 585 },
      { memberId: 'b', amountSatang: 585 },
      { memberId: 'c', amountSatang: 0 },
    ])
    expect(sum(amounts(shares))).toBe(1170)
  })

  it('ชิ้นราคา 0 ไม่ทำให้ยอดเพี้ยน — คนที่กินแต่ของฟรีได้ 0', () => {
    const items = [
      { name: 'ข้าว', amountSatang: 1000, memberIds: ['a'] },
      { name: 'น้ำเปล่า', amountSatang: 0, memberIds: ['b', 'c'] },
    ]
    const shares = splitExpense(input({ mode: 'itemized', totalSatang: 1000, items }))
    expect(amounts(shares)).toEqual([1000, 0, 0])
  })

  it('surcharge กระจายตามสัดส่วน subtotal ของ itemized', () => {
    const participants = [{ memberId: 'a' }, { memberId: 'b' }]
    const items = [
      { name: 'สเต๊ก', amountSatang: 7500, memberIds: ['a'] },
      { name: 'สลัด', amountSatang: 2500, memberIds: ['b'] },
    ]
    const shares = splitExpense(
      input({ mode: 'itemized', totalSatang: 10000, surchargePct: 17, participants, items }),
    )
    expect(amounts(shares)).toEqual([8775, 2925])
    expect(sum(amounts(shares))).toBe(11700)
  })

  it('ผลรวม item.amountSatang ไม่เท่ากับ totalSatang → error', () => {
    const items = [{ name: 'ข้าว', amountSatang: 900, memberIds: ['a', 'b'] }]
    expect(() => splitExpense(input({ mode: 'itemized', totalSatang: 1000, items }))).toThrow()
  })

  it('ชิ้นที่ไม่มีใครกิน (memberIds ว่าง) → error', () => {
    const items = [{ name: 'ข้าว', amountSatang: 1000, memberIds: [] }]
    expect(() => splitExpense(input({ mode: 'itemized', totalSatang: 1000, items }))).toThrow()
  })

  it('memberIds อ้างถึงคนที่ไม่ได้ร่วมหาร → error', () => {
    const items = [{ name: 'ข้าว', amountSatang: 1000, memberIds: ['a', 'zz'] }]
    expect(() => splitExpense(input({ mode: 'itemized', totalSatang: 1000, items }))).toThrow()
  })

  it('memberIds มีชื่อซ้ำในชิ้นเดียวกัน → error', () => {
    const items = [{ name: 'ข้าว', amountSatang: 1000, memberIds: ['a', 'a', 'b'] }]
    expect(() => splitExpense(input({ mode: 'itemized', totalSatang: 1000, items }))).toThrow()
  })

  it('items ว่าง → error', () => {
    expect(() => splitExpense(input({ mode: 'itemized', totalSatang: 1000, items: [] }))).toThrow()
  })

  it('amountSatang ของชิ้นติดลบหรือไม่ใช่ integer → error', () => {
    const negative = [
      { name: 'ข้าว', amountSatang: 1100, memberIds: ['a'] },
      { name: 'ส่วนลด', amountSatang: -100, memberIds: ['b'] },
    ]
    expect(() =>
      splitExpense(input({ mode: 'itemized', totalSatang: 1000, items: negative })),
    ).toThrow()

    const fractional = [{ name: 'ข้าว', amountSatang: 1000.5, memberIds: ['a'] }]
    expect(() =>
      splitExpense(input({ mode: 'itemized', totalSatang: 1000.5, items: fractional })),
    ).toThrow()
  })
})

describe('splitExpense — ตรวจ input ทุกโหมด', () => {
  const modes = ['equal', 'exact', 'share', 'itemized'] as const

  it('participants ว่าง → error', () => {
    for (const mode of modes) {
      expect(() => splitExpense(input({ mode, participants: [] }))).toThrow()
    }
  })

  it('memberId ซ้ำใน participants → error', () => {
    const participants = [{ memberId: 'a' }, { memberId: 'b' }, { memberId: 'a' }]
    expect(() => splitExpense(input({ participants }))).toThrow()
  })

  it('totalSatang ไม่ใช่ integer → error', () => {
    expect(() => splitExpense(input({ totalSatang: 1000.5 }))).toThrow()
    expect(() => splitExpense(input({ totalSatang: NaN }))).toThrow()
    expect(() => splitExpense(input({ totalSatang: Infinity }))).toThrow()
  })

  it('totalSatang ติดลบ → error', () => {
    expect(() => splitExpense(input({ totalSatang: -1 }))).toThrow()
  })

  it('totalSatang เป็น 0 → error', () => {
    expect(() => splitExpense(input({ totalSatang: 0 }))).toThrow()
  })

  it('โหมด itemized แต่ไม่มี items → error', () => {
    expect(() => splitExpense(input({ mode: 'itemized' }))).toThrow()
  })

  it('โหมดอื่นแต่ส่ง items มา → error (กันเรียกผิดโหมด)', () => {
    const items = [{ name: 'ข้าว', amountSatang: 30000, memberIds: ['a', 'b', 'c'] }]
    expect(() => splitExpense(input({ mode: 'equal', items }))).toThrow()
    expect(() => splitExpense(input({ mode: 'share', items }))).toThrow()
    const participants = [
      { memberId: 'a', exactSatang: 10000 },
      { memberId: 'b', exactSatang: 10000 },
      { memberId: 'c', exactSatang: 10000 },
    ]
    expect(() => splitExpense(input({ mode: 'exact', participants, items }))).toThrow()
  })

  it('weight <= 0 หรือไม่ finite ในโหมด share → error', () => {
    const withWeight = (weight: number) => [{ memberId: 'a', weight }, { memberId: 'b' }]
    expect(() => splitExpense(input({ mode: 'share', participants: withWeight(0) }))).toThrow()
    expect(() => splitExpense(input({ mode: 'share', participants: withWeight(-2) }))).toThrow()
    expect(() => splitExpense(input({ mode: 'share', participants: withWeight(NaN) }))).toThrow()
    expect(() =>
      splitExpense(input({ mode: 'share', participants: withWeight(Infinity) })),
    ).toThrow()
  })

  it('weight ที่ผิดในโหมดอื่นไม่ error — โหมดนั้นไม่ได้ใช้ weight', () => {
    const participants = [{ memberId: 'a', weight: 0 }, { memberId: 'b' }]
    expect(amounts(splitExpense(input({ totalSatang: 1000, participants })))).toEqual([500, 500])
  })
})

describe('splitExpense — property test', () => {
  /**
   * PRNG แบบ deterministic — seed คงที่ ผลลัพธ์ซ้ำได้ทุกครั้ง
   *
   * ใช้ mulberry32 ไม่ใช่ LCG `state * 1103515245` แบบใน contract.test.ts เพราะ
   * ผลคูณนั้นทะลุ 2^53 แล้ว float ปัดบิตล่างทิ้งจนหมด — `rnd(2)`/`rnd(8)` คืน 0
   * ทุกครั้ง ทำให้ตัวสุ่มไม่สุ่มจริง. mulberry32 คิดใน 32-bit ล้วนด้วย Math.imul
   */
  function makeRandom(seed: number): (n: number) => number {
    let state = seed >>> 0
    return (n) => {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) % n
    }
  }

  /**
   * grandTotal ที่คาดหวัง — คำนวณอิสระจาก split.ts ด้วย BigInt ล้วน
   * ปัดครึ่งขึ้น = floor((2n + d) / 2d)
   */
  function expectedGrandTotal(totalSatang: number, surchargePct: number): number {
    const [intPart = '', fracPart = ''] = String(surchargePct).split('.')
    const denominator = 100n * 10n ** BigInt(fracPart.length)
    const numerator = BigInt(totalSatang) * (denominator + BigInt(intPart + fracPart))
    return Number((2n * numerator + denominator) / (2n * denominator))
  }

  const pcts = [0, 0.5, 7, 7.5, 10, 12.25, 17, 100]
  const modes = ['equal', 'exact', 'share', 'itemized'] as const

  function randomInput(rnd: (n: number) => number, mode: SplitMode): SplitInput {
    const count = 1 + rnd(8)
    const memberIds = Array.from({ length: count }, (_, i) => `p${i}`)
    const surchargePct = pcts[rnd(pcts.length)] ?? 0
    // บางรอบ payer ไม่ได้ร่วมหาร (จ่ายแทนคนอื่นล้วน) — ต้องไม่พัง
    const payerId = `p${rnd(count + 1)}`

    if (mode === 'exact') {
      const exact = memberIds.map(() => rnd(200_000))
      // ยอดบิลต้อง > 0 เสมอ — ถ้าสุ่มได้ 0 หมดก็ดันขึ้นหนึ่งสตางค์
      if (exact.reduce((a, b) => a + b, 0) === 0) exact[0] = 1
      const totalSatang = exact.reduce((a, b) => a + b, 0)
      const participants = memberIds.map((memberId, i) => ({
        memberId,
        exactSatang: exact[i] ?? 0,
      }))
      return { totalSatang, surchargePct, payerId, mode, participants }
    }

    if (mode === 'itemized') {
      const items: Item[] = Array.from({ length: 1 + rnd(5) }, (_, k) => {
        const chosen = memberIds.filter(() => rnd(2) === 0)
        return {
          name: `item${k}`,
          amountSatang: rnd(200_000),
          memberIds: chosen.length > 0 ? chosen : [memberIds[rnd(count)] ?? 'p0'],
        }
      })
      const first = items[0]
      if (items.reduce((a, it) => a + it.amountSatang, 0) === 0 && first) first.amountSatang = 1
      const totalSatang = items.reduce((a, it) => a + it.amountSatang, 0)
      const participants = memberIds.map((memberId) => ({ memberId }))
      return { totalSatang, surchargePct, payerId, mode, participants, items }
    }

    const totalSatang = 1 + rnd(10_000_000)
    if (mode === 'share') {
      // ครึ่งหนึ่งเป็น integer อีกครึ่งลงท้าย .5 เพื่อกวน path ทศนิยมของ distribute
      const participants = memberIds.map((memberId) => ({
        memberId,
        weight: rnd(2) === 0 ? 1 + rnd(9) : (1 + rnd(19)) / 2,
      }))
      return { totalSatang, surchargePct, payerId, mode, participants }
    }
    return {
      totalSatang,
      surchargePct,
      payerId,
      mode,
      participants: memberIds.map((memberId) => ({ memberId })),
    }
  }

  it('Σ share === grandTotal เป๊ะ และไม่มีค่าติดลบ — สุ่ม 1000 รอบ ครบ 4 โหมด', () => {
    const rnd = makeRandom(987_654_321)
    // นับไว้ยืนยันว่าตัวสุ่มสุ่มจริง — ถ้า PRNG เพี้ยนจนสร้างแต่เคสง่ายๆ ต้องรู้ตัว
    const hit = { zeroShare: 0, manyPeople: 0, payerOutside: 0, withSurcharge: 0 }

    for (let round = 0; round < 1000; round++) {
      const mode = modes[round % modes.length] ?? 'equal'
      const spec = randomInput(rnd, mode)
      const shares = splitExpense(spec)

      expect(shares).toHaveLength(spec.participants.length)
      expect(shares.map((s) => s.memberId)).toEqual(spec.participants.map((p) => p.memberId))
      expect(sum(amounts(shares))).toBe(expectedGrandTotal(spec.totalSatang, spec.surchargePct))
      expect(amounts(shares).every((a) => Number.isSafeInteger(a) && a >= 0)).toBe(true)

      if (amounts(shares).some((a) => a === 0)) hit.zeroShare++
      if (spec.participants.length > 1) hit.manyPeople++
      if (!spec.participants.some((p) => p.memberId === spec.payerId)) hit.payerOutside++
      if (spec.surchargePct > 0) hit.withSurcharge++
    }

    expect(hit.zeroShare).toBeGreaterThan(0)
    expect(hit.manyPeople).toBeGreaterThan(100)
    expect(hit.payerOutside).toBeGreaterThan(0)
    expect(hit.withSurcharge).toBeGreaterThan(100)
  })

  it('ผลลัพธ์ deterministic — อินพุตเดิมให้ผลเดิมเสมอ', () => {
    for (const mode of modes) {
      const spec = randomInput(makeRandom(24_680), mode)
      expect(splitExpense(spec)).toEqual(splitExpense(spec))
    }
  })
})
