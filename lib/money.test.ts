import { describe, it, expect } from 'vitest'
import { bahtToSatang, satangToBaht, formatSatang, distribute } from './money'

describe('bahtToSatang', () => {
  it('รับ number จำนวนเต็ม', () => {
    expect(bahtToSatang(1200)).toBe(120000)
    expect(bahtToSatang(0)).toBe(0)
    expect(bahtToSatang(1)).toBe(100)
  })

  it('รับ number ที่มีทศนิยม 1–2 ตำแหน่ง', () => {
    expect(bahtToSatang(1200.5)).toBe(120050)
    expect(bahtToSatang(0.01)).toBe(1)
    expect(bahtToSatang(0.1)).toBe(10)
  })

  it('ไม่พังเพราะ float — เคสคลาสสิกที่ x*100 แล้วปัดลงผิด', () => {
    expect(bahtToSatang(1200.15)).toBe(120015)
    expect(bahtToSatang(8.29)).toBe(829)
    expect(bahtToSatang(1.15)).toBe(115)
    expect(bahtToSatang(1.13)).toBe(113)
    expect(bahtToSatang(10.07)).toBe(1007)
    expect(bahtToSatang('1200.15')).toBe(120015)
  })

  it('รับ string ธรรมดา', () => {
    expect(bahtToSatang('1200')).toBe(120000)
    expect(bahtToSatang('1200.50')).toBe(120050)
    expect(bahtToSatang('1200.5')).toBe(120050)
  })

  it('รับ string ที่มีคอมมาและช่องว่าง', () => {
    expect(bahtToSatang('1,200')).toBe(120000)
    expect(bahtToSatang(' 1200 ')).toBe(120000)
    expect(bahtToSatang('1,200,000.25')).toBe(120000025)
  })

  it('ปฏิเสธค่าติดลบ', () => {
    expect(() => bahtToSatang(-1)).toThrow()
    expect(() => bahtToSatang('-1200')).toThrow()
  })

  it('ปฏิเสธ NaN และ Infinity', () => {
    expect(() => bahtToSatang(NaN)).toThrow()
    expect(() => bahtToSatang(Infinity)).toThrow()
    expect(() => bahtToSatang(-Infinity)).toThrow()
  })

  it('ปฏิเสธทศนิยมเกิน 2 ตำแหน่ง', () => {
    expect(() => bahtToSatang(1.005)).toThrow()
    expect(() => bahtToSatang(0.001)).toThrow()
    expect(() => bahtToSatang('1200.505')).toThrow()
  })

  it('ปฏิเสธ string ที่แปลงไม่ได้', () => {
    expect(() => bahtToSatang('')).toThrow()
    expect(() => bahtToSatang('   ')).toThrow()
    expect(() => bahtToSatang('1.2k')).toThrow()
    expect(() => bahtToSatang('๑๒๐๐')).toThrow()
    expect(() => bahtToSatang('abc')).toThrow()
    expect(() => bahtToSatang('12 00')).toThrow()
    expect(() => bahtToSatang('1200฿')).toThrow()
    expect(() => bahtToSatang('1,20')).toThrow()
  })
})

describe('satangToBaht', () => {
  it('แปลงกลับเป็นบาท', () => {
    expect(satangToBaht(120000)).toBe(1200)
    expect(satangToBaht(120050)).toBe(1200.5)
    expect(satangToBaht(1)).toBe(0.01)
    expect(satangToBaht(0)).toBe(0)
  })

  it('ทศนิยมไม่เกิน 2 ตำแหน่ง ไม่มีหางลอย', () => {
    for (const satang of [829, 1007, 120015, 3333, 1, 99, 100001]) {
      const baht = satangToBaht(satang)
      const decimals = (String(baht).split('.')[1] ?? '').length
      expect(decimals).toBeLessThanOrEqual(2)
    }
  })

  it('ไป-กลับแล้วได้ค่าเดิม', () => {
    for (const satang of [0, 1, 7, 829, 120015, 999999]) {
      expect(bahtToSatang(satangToBaht(satang))).toBe(satang)
    }
  })

  it('ปฏิเสธค่าที่ไม่ใช่ integer หรือติดลบ', () => {
    expect(() => satangToBaht(1.5)).toThrow()
    expect(() => satangToBaht(-1)).toThrow()
    expect(() => satangToBaht(NaN)).toThrow()
    expect(() => satangToBaht(Infinity)).toThrow()
  })
})

describe('formatSatang', () => {
  it('ตัด .00 ทิ้งเมื่อลงตัว', () => {
    expect(formatSatang(120000)).toBe('1,200')
    expect(formatSatang(100)).toBe('1')
    expect(formatSatang(0)).toBe('0')
  })

  it('แสดงทศนิยม 2 ตำแหน่งเมื่อมีเศษ', () => {
    expect(formatSatang(120050)).toBe('1,200.50')
    expect(formatSatang(120015)).toBe('1,200.15')
    expect(formatSatang(1)).toBe('0.01')
    expect(formatSatang(10)).toBe('0.10')
  })

  it('คั่นหลักพันทุกหลัก', () => {
    expect(formatSatang(100000000)).toBe('1,000,000')
    expect(formatSatang(99900)).toBe('999')
    expect(formatSatang(100000)).toBe('1,000')
    expect(formatSatang(123456789)).toBe('1,234,567.89')
  })

  it('ปฏิเสธค่าที่ไม่ใช่ integer หรือติดลบ', () => {
    expect(() => formatSatang(1.5)).toThrow()
    expect(() => formatSatang(-100)).toThrow()
    expect(() => formatSatang(NaN)).toThrow()
  })
})

describe('distribute', () => {
  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)

  it('หารลงตัว', () => {
    expect(distribute(1000, [1, 1])).toEqual([500, 500])
    expect(distribute(900, [1, 1, 1])).toEqual([300, 300, 300])
  })

  it('1200 สตางค์ หาร 7 คน', () => {
    const result = distribute(1200, [1, 1, 1, 1, 1, 1, 1])
    expect(result).toEqual([172, 172, 172, 171, 171, 171, 171])
    expect(sum(result)).toBe(1200)
  })

  it('1000 สตางค์ หาร 3 คน', () => {
    const result = distribute(1000, [1, 1, 1])
    expect(result).toEqual([334, 333, 333])
    expect(sum(result)).toBe(1000)
  })

  it('เศษน้อยกว่าจำนวนคน — 1 สตางค์ หาร 3 คน', () => {
    const result = distribute(1, [1, 1, 1])
    expect(result).toEqual([1, 0, 0])
    expect(sum(result)).toBe(1)
  })

  it('0 สตางค์', () => {
    expect(distribute(0, [1, 1, 1])).toEqual([0, 0, 0])
    expect(distribute(0, [3, 1])).toEqual([0, 0])
  })

  it('คนเดียวได้ทั้งหมด', () => {
    expect(distribute(1201, [1])).toEqual([1201])
    expect(distribute(0, [5])).toEqual([0])
  })

  it('น้ำหนักไม่เท่ากัน [2,1,1]', () => {
    expect(distribute(1000, [2, 1, 1])).toEqual([500, 250, 250])
    const odd = distribute(1001, [2, 1, 1])
    expect(sum(odd)).toBe(1001)
    expect(odd).toEqual([501, 250, 250])
  })

  it('น้ำหนักเป็นทศนิยม', () => {
    expect(distribute(1000, [1.5, 1, 1])).toEqual([428, 286, 286])
    expect(sum(distribute(1000, [1.5, 1, 1]))).toBe(1000)
    expect(distribute(1000, [0.5, 0.5])).toEqual([500, 500])
    expect(sum(distribute(777, [2.25, 1.75, 3.5]))).toBe(777)
  })

  it('tieBreakIndex ได้เศษก่อนเมื่อเศษเท่ากัน', () => {
    // เศษ 1 สตางค์ เท่ากันทั้ง 3 คน → คนที่ระบุต้องได้
    expect(distribute(1, [1, 1, 1], 2)).toEqual([0, 0, 1])
    expect(distribute(1, [1, 1, 1], 1)).toEqual([0, 1, 0])
    expect(distribute(1, [1, 1, 1], 0)).toEqual([1, 0, 0])
    // เศษ 3 สตางค์ เท่ากันทั้ง 7 คน → คนที่ระบุก่อน แล้วไล่ตาม index
    expect(distribute(1200, [1, 1, 1, 1, 1, 1, 1], 5)).toEqual([172, 172, 171, 171, 171, 172, 171])
  })

  it('tieBreakIndex ไม่ล้มล้างลำดับเศษ — คนเศษมากกว่ายังได้ก่อน', () => {
    // [2,1,1] total=1001: base 500/250/250, เศษ 0.5 อยู่ที่ index 1,2 เท่านั้น
    // index 0 เศษ 0 → แม้เป็น tieBreak ก็ไม่ได้เพิ่ม
    expect(distribute(1001, [2, 1, 1], 0)).toEqual([501, 250, 250])
    expect(distribute(1001, [2, 1, 1], 2)).toEqual([501, 250, 250])
  })

  it('tieBreakIndex นอกช่วงหรือไม่ส่ง → ไล่ตาม index อย่างเดียว', () => {
    const expected = [1, 0, 0]
    expect(distribute(1, [1, 1, 1])).toEqual(expected)
    expect(distribute(1, [1, 1, 1], -1)).toEqual(expected)
    expect(distribute(1, [1, 1, 1], 3)).toEqual(expected)
    expect(distribute(1, [1, 1, 1], 1.5)).toEqual(expected)
    expect(distribute(1, [1, 1, 1], NaN)).toEqual(expected)
  })

  it('deterministic — เรียกซ้ำได้ผลเดิมเสมอ', () => {
    const first = distribute(12345, [3, 1, 1, 2, 1], 3)
    for (let i = 0; i < 20; i++) {
      expect(distribute(12345, [3, 1, 1, 2, 1], 3)).toEqual(first)
    }
  })

  it('รองรับยอดใหญ่โดยไม่เพี้ยน', () => {
    const big = 99_999_999_999
    const result = distribute(big, [7, 3, 11])
    expect(sum(result)).toBe(big)
  })

  it('error เมื่ออินพุตไม่ถูกต้อง', () => {
    expect(() => distribute(100, [])).toThrow()
    expect(() => distribute(100, [1, 0])).toThrow()
    expect(() => distribute(100, [1, -2])).toThrow()
    expect(() => distribute(100, [0])).toThrow()
    expect(() => distribute(100, [1, NaN])).toThrow()
    expect(() => distribute(100, [1, Infinity])).toThrow()
    expect(() => distribute(-1, [1, 1])).toThrow()
    expect(() => distribute(10.5, [1, 1])).toThrow()
    expect(() => distribute(NaN, [1, 1])).toThrow()
    expect(() => distribute(Infinity, [1, 1])).toThrow()
  })

  it('property: ผลรวมเท่ากับ total เป๊ะเสมอ (200 รอบสุ่ม)', () => {
    // LCG แทน Math.random เพื่อให้ reproduce เคสที่พังได้
    let seed = 42
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }

    for (let round = 0; round < 200; round++) {
      const n = 1 + Math.floor(rand() * 12)
      const weights = Array.from({ length: n }, () =>
        rand() < 0.3 ? Math.round(rand() * 400 + 1) / 4 : 1 + Math.floor(rand() * 5),
      )
      const total = Math.floor(rand() * 5_000_000)
      const tieBreakIndex = Math.floor(rand() * n)

      const result = distribute(total, weights, tieBreakIndex)
      expect(result).toHaveLength(n)
      expect(sum(result)).toBe(total)
      expect(result.every((x) => Number.isInteger(x) && x >= 0)).toBe(true)
      // ไม่มีใครควรต่างจากส่วนแบ่งตามสัดส่วนเกิน 1 สตางค์
      const totalWeight = sum(weights)
      result.forEach((share, i) => {
        const ideal = (total * (weights[i] ?? 0)) / totalWeight
        expect(Math.abs(share - ideal)).toBeLessThan(1)
      })
    }
  })
})
