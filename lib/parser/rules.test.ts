import { describe, it, expect } from 'vitest'
import { parseMessage } from './rules'

describe('Trigger filter — ข้อความที่ bot ไม่สนใจต้องคืน null', () => {
  it('ข้อความธรรมดาคืน null', () => {
    expect(parseMessage('ไปกินข้าวกันไหม')).toBeNull()
  })

  it('ตัวเลขเปล่าๆ ไม่มี + คืน null (ห้ามกลายเป็นบิล)', () => {
    expect(parseMessage('1200')).toBeNull()
  })

  it('คำสั่งที่ไม่ใช่คำเดียวคืน null', () => {
    expect(parseMessage('ยอดเงินเท่าไหร่')).toBeNull()
  })

  it('ข้อความว่างคืน null', () => {
    expect(parseMessage('')).toBeNull()
  })

  it('ช่องว่างล้วนคืน null', () => {
    expect(parseMessage('   \n\t ')).toBeNull()
  })

  it('+ ที่อยู่กลางข้อความไม่นับเป็น trigger', () => {
    expect(parseMessage('ราคา 1+1 บาท')).toBeNull()
  })
})

describe('คำสั่งคำเดียว', () => {
  it('ยอด → balance', () => {
    expect(parseMessage('ยอด')).toEqual({ kind: 'command', command: 'balance' })
  })

  it('ทวง → nudge', () => {
    expect(parseMessage('ทวง')).toEqual({ kind: 'command', command: 'nudge' })
  })

  it('แก้ → edit', () => {
    expect(parseMessage('แก้')).toEqual({ kind: 'command', command: 'edit' })
  })

  it('เลิก → undo', () => {
    expect(parseMessage('เลิก')).toEqual({ kind: 'command', command: 'undo' })
  })

  it('ช่องว่างรอบคำสั่งไม่ทำให้พัง', () => {
    expect(parseMessage('  ยอด \n')).toEqual({ kind: 'command', command: 'balance' })
  })

  it('คำสั่งที่มีคำอื่นต่อท้ายคืน null', () => {
    expect(parseMessage('ทวง ใครบ้าง')).toBeNull()
    expect(parseMessage('เลิกใช้แล้ว')).toBeNull()
  })
})

describe('บิลแบบง่าย — ไม่ระบุชื่อใคร', () => {
  it('+ ข้าว 1200 → หารเท่าทุกคนใน Roster', () => {
    expect(parseMessage('+ ข้าว 1200')).toEqual({
      kind: 'expense',
      draft: {
        description: 'ข้าว',
        totalSatang: 120000,
        mode: 'share',
        participants: [],
        includesPayer: true,
        surchargePct: 0,
      },
    })
  })

  it('ไม่มีชื่อใครเลย → ไม่ใส่ field eventTag (exactOptionalPropertyTypes)', () => {
    const result = parseMessage('+ ข้าว 1200')
    expect(result?.kind).toBe('expense')
    if (result?.kind !== 'expense') throw new Error('unreachable')
    expect('eventTag' in result.draft).toBe(false)
  })

  it('คำอธิบายหลายคำก็ได้', () => {
    const result = parseMessage('+ ข้าวเย็น วันเสาร์ 1200')
    expect(result).toMatchObject({ kind: 'expense', draft: { description: 'ข้าวเย็น วันเสาร์' } })
  })

  it('ไม่มีช่องว่างหลัง + ก็ยังอ่านได้', () => {
    const result = parseMessage('+ข้าว 1200')
    expect(result).toMatchObject({ kind: 'expense', draft: { description: 'ข้าว' } })
  })
})

describe('เข้า Trigger แต่แปลไม่ออก → unparsed (ไม่ใช่ null และไม่ใช่บิล)', () => {
  it('+1 ไม่มีคำอธิบาย → unparsed', () => {
    expect(parseMessage('+1')).toEqual({ kind: 'unparsed', text: '+1' })
  })

  it('+66812345678 เบอร์โทร → unparsed ไม่ใช่บิล', () => {
    expect(parseMessage('+66812345678')).toEqual({ kind: 'unparsed', text: '+66812345678' })
  })

  it('+ ข้าว ไม่มีตัวเลข → unparsed', () => {
    expect(parseMessage('+ ข้าว')).toEqual({ kind: 'unparsed', text: '+ ข้าว' })
  })

  it('+ เปล่าๆ → unparsed', () => {
    expect(parseMessage('+')).toEqual({ kind: 'unparsed', text: '+' })
  })

  it('unparsed คืนข้อความต้นฉบับไม่ตัดแต่ง', () => {
    expect(parseMessage('  + ข้าว  ')).toEqual({ kind: 'unparsed', text: '  + ข้าว  ' })
  })
})

describe('ระบุชื่อคนหลังยอด', () => {
  it('+ ข้าว 1200 กอล์ฟ เบียร์ ตูน → หาร 3 คน ไม่รวมคนจ่าย', () => {
    expect(parseMessage('+ ข้าว 1200 กอล์ฟ เบียร์ ตูน')).toEqual({
      kind: 'expense',
      draft: {
        description: 'ข้าว',
        totalSatang: 120000,
        mode: 'share',
        participants: [
          { name: 'กอล์ฟ', weight: 1 },
          { name: 'เบียร์', weight: 1 },
          { name: 'ตูน', weight: 1 },
        ],
        includesPayer: false,
        surchargePct: 0,
      },
    })
  })

  it('+ เหล้า 900 กอล์ฟ ตูน รวมฉัน → รวมคนจ่าย และ รวมฉัน ไม่ใช่ชื่อคน', () => {
    expect(parseMessage('+ เหล้า 900 กอล์ฟ ตูน รวมฉัน')).toEqual({
      kind: 'expense',
      draft: {
        description: 'เหล้า',
        totalSatang: 90000,
        mode: 'share',
        participants: [
          { name: 'กอล์ฟ', weight: 1 },
          { name: 'ตูน', weight: 1 },
        ],
        includesPayer: true,
        surchargePct: 0,
      },
    })
  })

  it('รวมฉัน อยู่ก่อนชื่อคนก็ได้', () => {
    expect(parseMessage('+ เหล้า 900 รวมฉัน กอล์ฟ')).toMatchObject({
      kind: 'expense',
      draft: { participants: [{ name: 'กอล์ฟ', weight: 1 }], includesPayer: true },
    })
  })

  it('ชื่อซ้ำในรายการเดียวกัน → unparsed (กำกวมเกินกว่าจะเดา)', () => {
    expect(parseMessage('+ ข้าว 1200 กอล์ฟ กอล์ฟ')).toMatchObject({ kind: 'unparsed' })
  })

  it('ชื่อซ้ำที่ต่างน้ำหนักก็ยัง unparsed', () => {
    expect(parseMessage('+ ข้าว 1200 กอล์ฟx2 กอล์ฟ')).toMatchObject({ kind: 'unparsed' })
  })

  it('ชื่อที่เป็นตัวเลขล้วน → unparsed (กันยอดที่สองกลายเป็นชื่อคน)', () => {
    expect(parseMessage('+ ข้าว 1200 1300')).toMatchObject({ kind: 'unparsed' })
  })
})

describe('น้ำหนัก', () => {
  it('+ คอนโด 8000 กอล์ฟx2 เบียร์ ตูน → กอล์ฟ 2 ส่วน ที่เหลือคนละ 1', () => {
    expect(parseMessage('+ คอนโด 8000 กอล์ฟx2 เบียร์ ตูน')).toMatchObject({
      kind: 'expense',
      draft: {
        totalSatang: 800000,
        participants: [
          { name: 'กอล์ฟ', weight: 2 },
          { name: 'เบียร์', weight: 1 },
          { name: 'ตูน', weight: 1 },
        ],
        includesPayer: false,
      },
    })
  })

  it('X ตัวใหญ่ก็ได้', () => {
    expect(parseMessage('+ คอนโด 8000 กอล์ฟX3')).toMatchObject({
      kind: 'expense',
      draft: { participants: [{ name: 'กอล์ฟ', weight: 3 }] },
    })
  })

  it('x0 → unparsed', () => {
    expect(parseMessage('+ คอนโด 8000 กอล์ฟx0')).toMatchObject({ kind: 'unparsed' })
  })

  it('น้ำหนักติดลบ → unparsed', () => {
    expect(parseMessage('+ คอนโด 8000 กอล์ฟx-2')).toMatchObject({ kind: 'unparsed' })
  })

  it('น้ำหนักเป็นเลขไทย', () => {
    expect(parseMessage('+ คอนโด 8000 กอล์ฟx๒ เบียร์')).toMatchObject({
      kind: 'expense',
      draft: {
        participants: [
          { name: 'กอล์ฟ', weight: 2 },
          { name: 'เบียร์', weight: 1 },
        ],
      },
    })
  })

  it('น้ำหนักเป็นทศนิยมได้', () => {
    expect(parseMessage('+ คอนโด 8000 กอล์ฟx1.5')).toMatchObject({
      kind: 'expense',
      draft: { participants: [{ name: 'กอล์ฟ', weight: 1.5 }] },
    })
  })

  it('น้ำหนักซ้อนกัน กอล์ฟx2x3 → unparsed ไม่ใช่เดาว่าชื่อ "กอล์ฟx2"', () => {
    expect(parseMessage('+ คอนโด 8000 กอล์ฟx2x3')).toMatchObject({ kind: 'unparsed' })
  })

  it('ชื่อที่มีเลขไทยอยู่ในตัวต้องไม่ถูกแปลงเลข', () => {
    expect(parseMessage('+ คอนโด 8000 ห้อง๒x2')).toMatchObject({
      kind: 'expense',
      draft: { participants: [{ name: 'ห้อง๒', weight: 2 }] },
    })
  })

  it('x2 ลอยๆ ไม่มีชื่อ → unparsed', () => {
    expect(parseMessage('+ คอนโด 8000 x2')).toMatchObject({ kind: 'unparsed' })
  })
})

describe('#tag', () => {
  it('+ ข้าว 1200 #เชียงใหม่ → eventTag ไม่มี #', () => {
    expect(parseMessage('+ ข้าว 1200 #เชียงใหม่')).toEqual({
      kind: 'expense',
      draft: {
        description: 'ข้าว',
        totalSatang: 120000,
        eventTag: 'เชียงใหม่',
        mode: 'share',
        participants: [],
        includesPayer: true,
        surchargePct: 0,
      },
    })
  })

  it('tag แทรกกลางชื่อคนก็ได้ และไม่นับเป็นชื่อคน', () => {
    expect(parseMessage('+ ข้าว 1200 กอล์ฟ #เชียงใหม่ ตูน')).toMatchObject({
      kind: 'expense',
      draft: {
        eventTag: 'เชียงใหม่',
        participants: [
          { name: 'กอล์ฟ', weight: 1 },
          { name: 'ตูน', weight: 1 },
        ],
        includesPayer: false,
      },
    })
  })

  it('tag ว่าง (# เปล่า) → unparsed', () => {
    expect(parseMessage('+ ข้าว 1200 #')).toMatchObject({ kind: 'unparsed' })
  })

  it('tag มากกว่าหนึ่งอัน → unparsed (บิลหนึ่งใบมี event เดียว)', () => {
    expect(parseMessage('+ ข้าว 1200 #เชียงใหม่ #ปีใหม่')).toMatchObject({ kind: 'unparsed' })
  })

  it('# ที่อยู่ในคำอธิบาย (ก่อนยอด) ไม่ใช่ tag', () => {
    expect(parseMessage('+ ข้าว#1 1200')).toMatchObject({
      kind: 'expense',
      draft: { description: 'ข้าว#1' },
    })
  })
})

describe('รูปแบบตัวเลขและการแปลงเป็นสตางค์', () => {
  const totalOf = (text: string): unknown => {
    const result = parseMessage(text)
    if (result?.kind !== 'expense') return result
    return result.draft.totalSatang
  }

  it('จำนวนเต็ม', () => {
    expect(totalOf('+ ข้าว 1200')).toBe(120000)
  })

  it('คอมมาคั่นหลักพัน', () => {
    expect(totalOf('+ ข้าว 1,200')).toBe(120000)
    expect(totalOf('+ ข้าว 1,234,567')).toBe(123456700)
  })

  it('ทศนิยม 2 ตำแหน่ง', () => {
    expect(totalOf('+ ข้าว 1200.50')).toBe(120050)
  })

  it('ทศนิยมตำแหน่งเดียวเติม 0 ให้เอง', () => {
    expect(totalOf('+ ข้าว 1200.5')).toBe(120050)
  })

  it('ทศนิยมที่ float คูณ 100 แล้วเพี้ยน ต้องได้ integer เป๊ะ', () => {
    // 1200.15 * 100 === 120014.99999999999 ใน IEEE754
    expect(totalOf('+ ข้าว 1200.15')).toBe(120015)
    expect(totalOf('+ ข้าว 0.29')).toBe(29)
    expect(totalOf('+ ข้าว 8.29')).toBe(829)
    expect(totalOf('+ ข้าว 1.005')).toMatchObject({ kind: 'unparsed' })
  })

  it('ผลลัพธ์เป็น integer เสมอ', () => {
    for (const text of ['+ ข้าว 1200.15', '+ ข้าว 999.99', '+ ข้าว 0.01']) {
      const satang = totalOf(text)
      expect(Number.isInteger(satang)).toBe(true)
    }
  })

  it('เลขไทย ๑๒๐๐', () => {
    expect(totalOf('+ ข้าว ๑๒๐๐')).toBe(120000)
    expect(totalOf('+ ข้าว ๑,๒๐๐.๕๐')).toBe(120050)
  })

  it('คอมมาคั่นแบบผิดหลัก → ไม่ใช่ยอด', () => {
    expect(parseMessage('+ ข้าว 1,20')).toMatchObject({ kind: 'unparsed' })
  })

  it('ทศนิยมเกิน 2 ตำแหน่ง → unparsed (สตางค์เก็บได้แค่ 2)', () => {
    expect(parseMessage('+ ข้าว 1200.555')).toMatchObject({ kind: 'unparsed' })
  })

  it('ยอด 0 หรือติดลบ → unparsed', () => {
    expect(parseMessage('+ ข้าว 0')).toMatchObject({ kind: 'unparsed' })
    expect(parseMessage('+ ข้าว 0.00')).toMatchObject({ kind: 'unparsed' })
    expect(parseMessage('+ ข้าว -500')).toMatchObject({ kind: 'unparsed' })
  })

  it('ยอดใหญ่เกิน safe integer → unparsed ไม่ใช่เลขเพี้ยน', () => {
    expect(parseMessage('+ ข้าว 99999999999999999999')).toMatchObject({ kind: 'unparsed' })
  })

  it('เลขไทยล้วนหลังยอดก็ไม่ใช่ชื่อคน', () => {
    expect(parseMessage('+ ข้าว 1200 ๑๓๐๐')).toMatchObject({ kind: 'unparsed' })
  })

  it('ยอดต้องเป็น token ของตัวเอง — 1200บาท ไม่ใช่ยอด', () => {
    expect(parseMessage('+ ข้าว 1200บาท')).toMatchObject({ kind: 'unparsed' })
  })
})

describe('เคสรวมจากสเปก', () => {
  it('ครบทุกอย่างพร้อมกัน', () => {
    expect(parseMessage('+ ปิ้งย่าง วันเสาร์ 2,400.50 กอล์ฟx2 เบียร์ ตูน รวมฉัน #เชียงใหม่')).toEqual({
      kind: 'expense',
      draft: {
        description: 'ปิ้งย่าง วันเสาร์',
        totalSatang: 240050,
        eventTag: 'เชียงใหม่',
        mode: 'share',
        participants: [
          { name: 'กอล์ฟ', weight: 2 },
          { name: 'เบียร์', weight: 1 },
          { name: 'ตูน', weight: 1 },
        ],
        includesPayer: true,
        surchargePct: 0,
      },
    })
  })

  it('ขึ้นบรรทัดใหม่ใช้แทนช่องว่างได้', () => {
    expect(parseMessage('+ ข้าว 1200\nกอล์ฟ\nตูน')).toMatchObject({
      kind: 'expense',
      draft: {
        participants: [
          { name: 'กอล์ฟ', weight: 1 },
          { name: 'ตูน', weight: 1 },
        ],
      },
    })
  })

  it('rule parser คืน mode share และ surchargePct 0 เสมอ', () => {
    for (const text of ['+ ข้าว 1200', '+ ข้าว 1200 กอล์ฟ', '+ ข้าว 1200 กอล์ฟx2 รวมฉัน']) {
      expect(parseMessage(text)).toMatchObject({
        kind: 'expense',
        draft: { mode: 'share', surchargePct: 0 },
      })
    }
  })
})
