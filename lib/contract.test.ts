/**
 * เทสต์ตรวจสอบของ orchestrator — เขียนขึ้นอิสระจากเทสต์ของ agent
 * เพื่อยืนยันสเปกที่สั่งไว้จริง ไม่ใช่สเปกที่ agent เข้าใจ
 *
 * เป็นชุดกันถอยหลัง ห้ามลบ — ถ้าไฟล์นี้แดง แปลว่าสัญญาของโดเมนถูกละเมิด
 */
import { describe, expect, it } from 'vitest'
import { distribute, bahtToSatang } from './money'
import { computeDebts } from './debt'
import { splitExpense } from './split'
import { parseMessage } from './parser/rules'

describe('money — invariant ที่ห้ามพัง', () => {
  it('ผลรวมตรงเป๊ะทุกกรณี สุ่ม 5000 รอบ', () => {
    let seed = 12345
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    for (let i = 0; i < 5000; i++) {
      const total = rnd(10_000_000)
      const count = 1 + rnd(12)
      const weights = Array.from({ length: count }, () => 1 + rnd(9))
      const parts = distribute(total, weights, rnd(count))
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total)
      expect(parts.every((p) => p >= 0)).toBe(true)
    }
  })

  it('เศษเท่ากัน คนจ่ายบิลได้ก่อน', () => {
    // 100 สตางค์ หาร 3 คนเท่ากัน → 34/33/33 คนที่ได้ 34 ต้องเป็น tieBreakIndex
    expect(distribute(100, [1, 1, 1], 2)).toEqual([33, 33, 34])
    expect(distribute(100, [1, 1, 1], 0)).toEqual([34, 33, 33])
  })

  it('กับดัก float ในการแปลงบาท', () => {
    expect(bahtToSatang(1200.15)).toBe(120015)
    expect(bahtToSatang('1200.15')).toBe(120015)
    expect(bahtToSatang(0.29)).toBe(29)
    expect(bahtToSatang('1,200')).toBe(120000)
  })
})

describe('split — invariant ยอดรวม ทุกโหมด', () => {
  const seedRnd = (start: number) => {
    let s = start
    return (n: number) => {
      s = (s * 1103515245 + 12345) % 2147483648
      return s % n
    }
  }

  it('Σ share = grandTotal เป๊ะ ทุกโหมด สุ่ม 2000 รอบ', () => {
    const rnd = seedRnd(98765)
    for (let i = 0; i < 2000; i++) {
      const count = 1 + rnd(8)
      const ids = Array.from({ length: count }, (_, k) => `m${k}`)
      const pct = [0, 7, 10, 17, 7.5][rnd(5)] ?? 0
      const mode = (['equal', 'share', 'exact', 'itemized'] as const)[rnd(4)] ?? 'equal'

      let input
      if (mode === 'exact') {
        const each = ids.map(() => rnd(50_000))
        const total = each.reduce((a, b) => a + b, 0)
        if (total === 0) continue
        input = {
          totalSatang: total,
          surchargePct: pct,
          payerId: ids[rnd(count)] ?? 'm0',
          mode,
          participants: ids.map((id, k) => ({ memberId: id, exactSatang: each[k] ?? 0 })),
        }
      } else if (mode === 'itemized') {
        const items = Array.from({ length: 1 + rnd(5) }, (_, k) => ({
          name: `i${k}`,
          amountSatang: 1 + rnd(20_000),
          // สุ่มกลุ่มคนกิน อย่างน้อยหนึ่งคน — บางคนอาจไม่ได้กินอะไรเลย
          memberIds: ids.filter(() => rnd(2) === 0).length > 0
            ? ids.filter(() => rnd(2) === 0)
            : [ids[0] ?? 'm0'],
        }))
        const total = items.reduce((a, b) => a + b.amountSatang, 0)
        input = {
          totalSatang: total,
          surchargePct: pct,
          payerId: ids[rnd(count)] ?? 'm0',
          mode,
          participants: ids.map((id) => ({ memberId: id })),
          items,
        }
      } else {
        input = {
          totalSatang: 1 + rnd(1_000_000),
          surchargePct: pct,
          payerId: ids[rnd(count)] ?? 'm0',
          mode,
          participants: ids.map((id) => ({ memberId: id, weight: 1 + rnd(5) })),
        }
      }

      const shares = splitExpense(input)
      const grand = expectedGrandTotal(input.totalSatang, pct)
      expect(shares.reduce((a, s) => a + s.amountSatang, 0)).toBe(grand)
      expect(shares.every((s) => s.amountSatang >= 0)).toBe(true)
      expect(shares).toHaveLength(count)
    }
  })

  /** คำนวณยอดรวมหลัง surcharge อิสระจาก implementation — ปัดครึ่งขึ้น */
  function expectedGrandTotal(total: number, pct: number): number {
    const decimals = (String(pct).split('.')[1] ?? '').length
    const scale = 10 ** decimals
    const num = BigInt(total) * BigInt(Math.round(pct * scale) + 100 * scale)
    const den = BigInt(100 * scale)
    return Number((2n * num + den) / (2n * den))
  }

  it('surcharge กระจายตามสัดส่วน ไม่ใช่หารเท่า', () => {
    const shares = splitExpense({
      totalSatang: 10000,
      surchargePct: 17,
      payerId: 'a',
      mode: 'share',
      participants: [
        { memberId: 'a', weight: 3 },
        { memberId: 'b', weight: 1 },
      ],
    })
    // subtotal 7500/2500 → surcharge 1700 แบ่ง 1275/425 (สัดส่วน 3:1)
    expect(shares[0]?.amountSatang).toBe(8775)
    expect(shares[1]?.amountSatang).toBe(2925)
  })

  it('exact ที่ยอดไม่ตรงต้อง error ไม่ใช่เดาให้', () => {
    expect(() =>
      splitExpense({
        totalSatang: 10000,
        surchargePct: 0,
        payerId: 'a',
        mode: 'exact',
        participants: [
          { memberId: 'a', exactSatang: 4000 },
          { memberId: 'b', exactSatang: 5000 },
        ],
      }),
    ).toThrow()
  })

  it('itemized — คนที่ไม่ได้กินอะไรเลยได้ 0 แต่ยอดรวมไม่เพี้ยน', () => {
    const shares = splitExpense({
      totalSatang: 900,
      surchargePct: 17,
      payerId: 'a',
      mode: 'itemized',
      participants: [{ memberId: 'a' }, { memberId: 'b' }, { memberId: 'c' }],
      items: [{ name: 'เหล้า', amountSatang: 900, memberIds: ['a', 'b'] }],
    })
    expect(shares[2]?.amountSatang).toBe(0)
    expect(shares.reduce((a, s) => a + s.amountSatang, 0)).toBe(1053)
  })
})

describe('debt — ห้ามยุบหนี้ข้ามคน', () => {
  it('A ติด B, B ติด C ต้องได้ 2 คู่ ไม่ใช่ 1', () => {
    const debts = computeDebts(
      [
        { payerId: 'B', shares: [{ memberId: 'A', amountSatang: 50000 }] },
        { payerId: 'C', shares: [{ memberId: 'B', amountSatang: 30000 }] },
      ],
      [],
    )
    expect(debts).toHaveLength(2)
    expect(debts.some((d) => d.debtorId === 'A' && d.creditorId === 'C')).toBe(false)
  })

  it('ลำดับ input ไม่มีผลต่อผลลัพธ์', () => {
    const a = { payerId: 'B', shares: [{ memberId: 'A', amountSatang: 500 }] }
    const b = { payerId: 'A', shares: [{ memberId: 'B', amountSatang: 200 }] }
    expect(computeDebts([a, b], [])).toEqual(computeDebts([b, a], []))
  })
})

describe('parser — รูปแบบตัวเลขตามสเปก', () => {
  it('รับคอมมา', () => {
    const r = parseMessage('+ ข้าว 1,200')
    expect(r?.kind).toBe('expense')
  })

  it('รับทศนิยม', () => {
    const r = parseMessage('+ ข้าว 1200.50')
    expect(r?.kind).toBe('expense')
  })

  it('รับเลขไทย', () => {
    const r = parseMessage('+ ข้าว ๑๒๐๐')
    expect(r?.kind).toBe('expense')
  })

  it('ทศนิยมแปลงเป็นสตางค์ถูกต้อง', () => {
    const r = parseMessage('+ ข้าว 1200.15')
    expect(r?.kind === 'expense' && r.draft.totalSatang).toBe(120015)
  })
})

describe('parser — ห้าม false positive', () => {
  it.each(['1200', 'ยอดเงินเท่าไหร่', '', '   ', 'สวัสดีครับ'])('%j ต้องคืน null', (t) => {
    expect(parseMessage(t)).toBeNull()
  })

  it.each(['+1', '+66812345678', '+ ข้าว'])('%j ต้องเป็น unparsed', (t) => {
    expect(parseMessage(t)?.kind).toBe('unparsed')
  })
})
