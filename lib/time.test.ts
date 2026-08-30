import { describe, expect, it } from 'vitest'
import { bangkokDate } from './time'

/**
 * เส้นทางตรวจอิสระ — บวก offset คงที่แล้วตัดสตริง ISO
 *
 * จงใจไม่ใช้ `Intl` เพราะโค้ดจริงใช้ตัวนั้น ถ้าเทสต์เรียกของเดียวกันก็แค่ยืนยัน
 * บั๊กเดียวกันสองรอบ · ไทยใช้ UTC+7 คงที่ ไม่มี DST เส้นทางนี้จึงตรงกับของจริง
 * ได้ทุกค่า และถ้าวันหนึ่งมันไม่ตรง แปลว่ามีสมมติฐานข้อหนึ่งพังซึ่งเราอยากรู้
 */
function bangkokDateByOffset(epochMs: number): string {
  return new Date(epochMs + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** epoch ms ของเวลา UTC ที่อ่านง่ายในเทสต์ */
function utc(iso: string): number {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) throw new Error(`ISO ไม่ถูกต้อง: ${iso}`)
  return ms
}

describe('bangkokDate — ขอบวันอยู่ที่ 17:00Z', () => {
  it('17:00Z คือเที่ยงคืนของวันถัดไปในไทย', () => {
    expect(bangkokDate(utc('2026-08-30T16:59:59.999Z'))).toBe('2026-08-30')
    expect(bangkokDate(utc('2026-08-30T17:00:00.000Z'))).toBe('2026-08-31')
  })

  it('บิลมื้อดึกยังเป็นของวันนั้น', () => {
    // 23:50 ตามเวลาไทย = 16:50Z ของวันเดียวกัน
    expect(bangkokDate(utc('2026-08-30T16:50:00Z'))).toBe('2026-08-30')
  })

  it('ข้ามสิ้นเดือน', () => {
    expect(bangkokDate(utc('2026-08-31T16:59:59Z'))).toBe('2026-08-31')
    expect(bangkokDate(utc('2026-08-31T17:00:00Z'))).toBe('2026-09-01')
  })

  it('ข้ามปี', () => {
    expect(bangkokDate(utc('2026-12-31T16:59:59Z'))).toBe('2026-12-31')
    expect(bangkokDate(utc('2026-12-31T17:00:00Z'))).toBe('2027-01-01')
  })

  it('ปีอธิกสุรทิน', () => {
    expect(bangkokDate(utc('2028-02-28T17:00:00Z'))).toBe('2028-02-29')
    expect(bangkokDate(utc('2028-02-29T17:00:00Z'))).toBe('2028-03-01')
  })

  it('เติมศูนย์หน้าเดือนและวันเสมอ — รูปแบบต้องเป็น YYYY-MM-DD เป๊ะ', () => {
    const date = bangkokDate(utc('2027-01-05T03:00:00Z'))
    expect(date).toBe('2027-01-05')
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('ตรงกับเส้นทางตรวจอิสระทุกค่าที่สุ่มมา', () => {
    // ค่าคงที่ ไม่ใช่ random จริง — เทสต์ที่ผลต่างกันทุกรอบคือเทสต์ที่ debug ไม่ได้
    const start = utc('2026-01-01T00:00:00Z')
    const step = 6_361_237 // ราว 1.77 ชั่วโมง — ไม่หารลงตัวกับวัน จึงกวาดทุกช่วงเวลา
    for (let i = 0; i < 3000; i++) {
      const ms = start + i * step
      expect(bangkokDate(ms)).toBe(bangkokDateByOffset(ms))
    }
  })

  it('ผลลัพธ์ไม่ขึ้นกับ timezone ของเครื่องที่รัน', () => {
    // ค่านี้คือ 00:30 ของวันที่ 31 ตามเวลาไทย · เครื่องที่ตั้งเป็น UTC หรือ
    // ตะวันตกจะยังอยู่วันที่ 30 ถ้าโค้ดเผลอใช้เวลาท้องถิ่น
    expect(bangkokDate(utc('2026-08-30T17:30:00Z'))).toBe('2026-08-31')
  })

  it('ปฏิเสธค่าที่ไม่ใช่ epoch ms ที่ใช้ได้', () => {
    expect(() => bangkokDate(Number.NaN)).toThrow()
    expect(() => bangkokDate(Number.POSITIVE_INFINITY)).toThrow()
    expect(() => bangkokDate(1.5)).toThrow()
  })

  it('integer ที่เกินช่วงของ Date ต้องพังด้วยข้อความของเราเอง', () => {
    // `Number.isSafeInteger` ผ่านถึง 9.007e15 แต่ `Date` รับได้แค่ ±8.64e15
    // ปล่อยไว้จะได้ `RangeError: Invalid time value` จาก `formatToParts` แทน
    // ซึ่งเป็น throw ที่ไม่มีใครดักในลูปตอบ reply
    expect(() => bangkokDate(8_640_000_000_000_001)).toThrow(/epoch ms/)
    expect(() => bangkokDate(-8_640_000_000_000_001)).toThrow(/epoch ms/)
    // ขอบบนพอดีต้องไม่พัง (ปีของมันคือ 275760 จึงไม่ใช่สี่หลัก)
    expect(() => bangkokDate(8_640_000_000_000_000)).not.toThrow()
  })
})
