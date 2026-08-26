import { describe, expect, it } from 'vitest'
import { buildPromptPayPayload } from '@/lib/promptpay/emv'

/**
 * CRC ฉบับอิสระของเทสต์ — เขียนแบบ bitwise ส่วนโค้ดจริงเขียนแบบ table-driven
 * ตั้งใจให้คนละอัลกอริทึม เพราะถ้าลอกกันมาเทสต์ก็แค่ยืนยันบั๊กเดียวกันสองรอบ
 */
function crc16Bitwise(input: string): number {
  let crc = 0xffff
  for (const byte of Buffer.from(input, 'ascii')) {
    crc ^= byte << 8
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc
}

/** อ่าน TLV ทั้งชั้นออกมาเป็น map เพื่อตรวจโครงสร้างโดยไม่ผูกกับลำดับ */
function parseTlv(payload: string): Map<string, string> {
  const out = new Map<string, string>()
  let i = 0
  while (i < payload.length) {
    const tag = payload.slice(i, i + 2)
    const len = Number(payload.slice(i + 2, i + 4))
    expect(Number.isInteger(len)).toBe(true)
    const value = payload.slice(i + 4, i + 4 + len)
    expect(value.length).toBe(len)
    out.set(tag, value)
    i += 4 + len
  }
  return out
}

describe('buildPromptPayPayload — ค่าคาดหวังตายตัว', () => {
  it('QR แบบไม่ระบุยอด', () => {
    expect(buildPromptPayPayload({ mobile: '0812345678' })).toBe(
      '00020101021129370016A0000006770101110113006681234567853037645802TH6304823E',
    )
  })

  it('QR ระบุยอด 100.00 บาท', () => {
    expect(buildPromptPayPayload({ mobile: '0812345678', amountSatang: 10_000 })).toBe(
      '00020101021229370016A0000006770101110113006681234567853037645406100.005802TH6304F142',
    )
  })

  it('ยอดมีสตางค์', () => {
    expect(buildPromptPayPayload({ mobile: '0812345678', amountSatang: 123_456 })).toBe(
      '00020101021229370016A00000067701011101130066812345678530376454071234.565802TH630471D1',
    )
  })

  it('ยอดหนึ่งสตางค์ — ขอบล่าง', () => {
    expect(buildPromptPayPayload({ mobile: '0912345678', amountSatang: 1 })).toBe(
      '00020101021229370016A00000067701011101130066912345678530376454040.015802TH63043CC2',
    )
  })

  it('เบอร์ 06 ที่ขึ้นต้นเหมือนรหัสประเทศ ไม่โดนตัดหัว', () => {
    expect(buildPromptPayPayload({ mobile: '0661234567', amountSatang: 99_999_999 })).toBe(
      '00020101021229370016A0000006770101110113006666123456753037645409999999.995802TH6304449C',
    )
  })
})

describe('buildPromptPayPayload — โครงสร้าง', () => {
  it('CRC ท้ายสตริงคำนวณจากทุกอย่างรวม "6304" ด้วย', () => {
    const payload = buildPromptPayPayload({ mobile: '0812345678', amountSatang: 55_555 })
    const body = payload.slice(0, -4)
    expect(body.endsWith('6304')).toBe(true)
    expect(payload.slice(-4)).toBe(crc16Bitwise(body).toString(16).toUpperCase().padStart(4, '0'))
  })

  it('CRC เป็นตัวพิมพ์ใหญ่สี่หลักเสมอ แม้ค่าจะนำหน้าด้วยศูนย์', () => {
    // ไล่หายอดที่ทำให้ CRC มีศูนย์นำ เพื่อกันบั๊ก padStart ที่โผล่เฉพาะบางยอด
    let found = false
    for (let satang = 1; satang <= 20_000 && !found; satang++) {
      const payload = buildPromptPayPayload({ mobile: '0812345678', amountSatang: satang })
      if (payload.slice(-4).startsWith('0')) {
        found = true
        expect(payload.slice(-4)).toMatch(/^[0-9A-F]{4}$/)
        expect(payload.slice(-4)).toBe(
          crc16Bitwise(payload.slice(0, -4)).toString(16).toUpperCase().padStart(4, '0'),
        )
      }
    }
    expect(found).toBe(true)
  })

  it('ไม่ระบุยอด → point of initiation = 11 และไม่มี tag 54', () => {
    const tlv = parseTlv(buildPromptPayPayload({ mobile: '0812345678' }))
    expect(tlv.get('01')).toBe('11')
    expect(tlv.has('54')).toBe(false)
  })

  it('ระบุยอด → point of initiation = 12 และ tag 54 มีทศนิยมสองตำแหน่งเสมอ', () => {
    const tlv = parseTlv(buildPromptPayPayload({ mobile: '0812345678', amountSatang: 500 }))
    expect(tlv.get('01')).toBe('12')
    expect(tlv.get('54')).toBe('5.00')
  })

  it('tag คงที่ตามสเปก — payload format, AID, สกุลเงิน, ประเทศ', () => {
    const tlv = parseTlv(buildPromptPayPayload({ mobile: '0812345678', amountSatang: 500 }))
    expect(tlv.get('00')).toBe('01')
    expect(tlv.get('53')).toBe('764')
    expect(tlv.get('58')).toBe('TH')
    const account = parseTlv(tlv.get('29') ?? '')
    expect(account.get('00')).toBe('A000000677010111')
    expect(account.get('01')).toBe('0066812345678')
  })

  it('เบอร์แปลงเป็น 0066 + เก้าหลัก ยาว 13 เสมอ', () => {
    for (const input of ['0812345678', '081-234-5678', '+66812345678', '66812345678', '๐๘๑๒๓๔๕๖๗๘']) {
      const tlv = parseTlv(buildPromptPayPayload({ mobile: input }))
      const account = parseTlv(tlv.get('29') ?? '')
      expect(account.get('01')).toBe('0066812345678')
    }
  })

  it('เบอร์ทุกรูปแบบที่เขียนต่างกันให้ payload เดียวกัน', () => {
    const canonical = buildPromptPayPayload({ mobile: '0812345678', amountSatang: 10_000 })
    for (const input of ['081 234 5678', '+66 81-234-5678', '๐๘๑๒๓๔๕๖๗๘']) {
      expect(buildPromptPayPayload({ mobile: input, amountSatang: 10_000 })).toBe(canonical)
    }
  })

  it('payload เป็น ASCII ล้วน — QR ต้องเข้ารหัสโหมดตัวเลข/ตัวอักษรได้', () => {
    const payload = buildPromptPayPayload({ mobile: '0812345678', amountSatang: 10_000 })
    expect(payload).toMatch(/^[0-9A-Za-z.]+$/)
  })
})

describe('buildPromptPayPayload — ลำดับ tag สองแบบสำหรับ spike S3', () => {
  it('countryFirst ย้าย 58 ขึ้นก่อน 53 และ 54', () => {
    const payload = buildPromptPayPayload({
      mobile: '0812345678',
      amountSatang: 10_000,
      order: 'countryFirst',
    })
    expect(payload.indexOf('5802TH')).toBeLessThan(payload.indexOf('5303764'))
    expect(payload.indexOf('5303764')).toBeLessThan(payload.indexOf('5406100.00'))
  })

  it('สองลำดับให้สตริงต่างกัน แต่ CRC ถูกทั้งคู่และ TLV อ่านได้เหมือนกัน', () => {
    const ascending = buildPromptPayPayload({ mobile: '0812345678', amountSatang: 10_000 })
    const countryFirst = buildPromptPayPayload({
      mobile: '0812345678',
      amountSatang: 10_000,
      order: 'countryFirst',
    })
    expect(countryFirst).not.toBe(ascending)
    for (const payload of [ascending, countryFirst]) {
      expect(payload.slice(-4)).toBe(
        crc16Bitwise(payload.slice(0, -4)).toString(16).toUpperCase().padStart(4, '0'),
      )
      const tlv = parseTlv(payload)
      expect(tlv.get('53')).toBe('764')
      expect(tlv.get('54')).toBe('100.00')
      expect(tlv.get('58')).toBe('TH')
    }
  })

  it('ไม่ระบุยอดก็สลับลำดับได้ ไม่มี tag 54 โผล่มา', () => {
    const payload = buildPromptPayPayload({ mobile: '0812345678', order: 'countryFirst' })
    expect(parseTlv(payload).has('54')).toBe(false)
    expect(payload.slice(-4)).toBe(
      crc16Bitwise(payload.slice(0, -4)).toString(16).toUpperCase().padStart(4, '0'),
    )
  })
})

describe('buildPromptPayPayload — ค่าที่ต้องปฏิเสธ', () => {
  it('ยอดศูนย์', () => {
    expect(() => buildPromptPayPayload({ mobile: '0812345678', amountSatang: 0 })).toThrow(/ยอด/)
  })

  it('ยอดติดลบ', () => {
    expect(() => buildPromptPayPayload({ mobile: '0812345678', amountSatang: -1 })).toThrow(/ยอด/)
  })

  it('ยอดไม่ใช่ integer — สตางค์ต้องเป็นจำนวนเต็มตามกติกาของโปรเจกต์', () => {
    expect(() => buildPromptPayPayload({ mobile: '0812345678', amountSatang: 10.5 })).toThrow(/ยอด/)
    expect(() => buildPromptPayPayload({ mobile: '0812345678', amountSatang: NaN })).toThrow(/ยอด/)
    expect(() => buildPromptPayPayload({ mobile: '0812345678', amountSatang: Infinity })).toThrow(/ยอด/)
  })

  it('ยอดเกิน 13 หลักตามที่ tag 54 รับได้', () => {
    expect(() =>
      buildPromptPayPayload({ mobile: '0812345678', amountSatang: 1_000_000_000_000 }),
    ).toThrow(/ยอด/)
  })

  it('เบอร์ที่ไม่ใช่มือถือไทย', () => {
    expect(() => buildPromptPayPayload({ mobile: '021234567' })).toThrow(/เบอร์มือถือ/)
  })

  it('ข้อความ error ไม่มีเบอร์โทรอยู่ในนั้น (D12 — เบอร์ห้ามลง log)', () => {
    expect(() => buildPromptPayPayload({ mobile: '0212345678' })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('0212345678') }),
    )
  })
})
