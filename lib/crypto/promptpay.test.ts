import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  normalizeThaiMobile,
  encryptPromptPay,
  decryptPromptPay,
} from '@/lib/crypto/promptpay'

/**
 * คีย์ของเทสต์สร้างเองทุกครั้ง — ไฟล์นี้ต้องไม่มีคีย์จริงหรือเบอร์จริงอยู่เลย
 * และ `beforeAll`/`afterAll` คืนค่าเดิมเพื่อไม่ให้ env รั่วไปหาไฟล์เทสต์อื่น
 * ที่ vitest รันขนานกัน
 */
const TEST_KEY = randomBytes(32).toString('base64')
let savedKey: string | undefined

beforeAll(() => {
  savedKey = process.env.PROMPTPAY_KEY
  process.env.PROMPTPAY_KEY = TEST_KEY
})

afterAll(() => {
  if (savedKey === undefined) delete process.env.PROMPTPAY_KEY
  else process.env.PROMPTPAY_KEY = savedKey
})

/** ตั้งคีย์ชั่วคราวแล้วคืนค่าเดิมเสมอ แม้ `fn` จะ throw */
function withKey<T>(value: string | undefined, fn: () => T): T {
  const before = process.env.PROMPTPAY_KEY
  if (value === undefined) delete process.env.PROMPTPAY_KEY
  else process.env.PROMPTPAY_KEY = value
  try {
    return fn()
  } finally {
    if (before === undefined) delete process.env.PROMPTPAY_KEY
    else process.env.PROMPTPAY_KEY = before
  }
}

/**
 * พลิกบิตเดียวที่ตำแหน่งหนึ่ง — ใช้ `readUInt8`/`writeUInt8` แทน `[i] ^= 1`
 * เพราะ `noUncheckedIndexedAccess` ทำให้ index ของ Buffer เป็น `number | undefined`
 */
function flipBit(cipher: Buffer, index: number): Buffer {
  const copy = Buffer.from(cipher)
  copy.writeUInt8(copy.readUInt8(index) ^ 0x01, index)
  return copy
}

/** จับ Error ที่ถูกโยนออกมาเพื่อตรวจ "ข้อความ" ของมัน — คืน null ถ้าไม่ throw */
function catchError(fn: () => unknown): Error | null {
  try {
    fn()
    return null
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

const IV_BYTES = 12
const AUTH_TAG_BYTES = 16

describe('normalizeThaiMobile', () => {
  it('รูปแบบที่คนพิมพ์จริงทุกแบบให้ผลเดียวกัน', () => {
    expect(normalizeThaiMobile('0812345678')).toBe('0812345678')
    expect(normalizeThaiMobile('081-234-5678')).toBe('0812345678')
    expect(normalizeThaiMobile('081 234 5678')).toBe('0812345678')
    expect(normalizeThaiMobile('+66812345678')).toBe('0812345678')
    expect(normalizeThaiMobile('66812345678')).toBe('0812345678')
  })

  it('ตัดช่องว่างรอบนอกและวงเล็บ', () => {
    expect(normalizeThaiMobile('  0812345678  ')).toBe('0812345678')
    expect(normalizeThaiMobile('(081) 234-5678')).toBe('0812345678')
    expect(normalizeThaiMobile('+66 81-234 5678')).toBe('0812345678')
  })

  it('รับเลขไทย เพราะ rule parser รับอยู่แล้ว', () => {
    expect(normalizeThaiMobile('๐๘๑๒๓๔๕๖๗๘')).toBe('0812345678')
    expect(normalizeThaiMobile('๐๘๑-๒๓๔-๕๖๗๘')).toBe('0812345678')
    // ปนกันก็ยังได้ — คนพิมพ์สลับคีย์บอร์ดกลางเบอร์
    expect(normalizeThaiMobile('081-๒๓๔-5678')).toBe('0812345678')
  })

  it('รับทุกเลขหมายมือถือไทย 06 08 09', () => {
    expect(normalizeThaiMobile('0612345678')).toBe('0612345678')
    expect(normalizeThaiMobile('0912345678')).toBe('0912345678')
  })

  it('ปฏิเสธค่าว่าง', () => {
    expect(() => normalizeThaiMobile('')).toThrow()
    expect(() => normalizeThaiMobile('   ')).toThrow()
    expect(() => normalizeThaiMobile('---')).toThrow()
  })

  it('ปฏิเสธเมื่อมีตัวอักษรปน', () => {
    expect(() => normalizeThaiMobile('081234567a')).toThrow()
    expect(() => normalizeThaiMobile('โทร 0812345678')).toThrow()
    expect(() => normalizeThaiMobile('O812345678')).toThrow()
  })

  it('ปฏิเสธความยาวที่ผิด', () => {
    expect(() => normalizeThaiMobile('081234567')).toThrow()
    expect(() => normalizeThaiMobile('08123456789')).toThrow()
    expect(() => normalizeThaiMobile('0')).toThrow()
  })

  it('ปฏิเสธเบอร์บ้าน', () => {
    expect(() => normalizeThaiMobile('021234567')).toThrow()
    expect(() => normalizeThaiMobile('02-123-4567')).toThrow()
    expect(() => normalizeThaiMobile('053123456')).toThrow()
  })

  it('ปฏิเสธเบอร์ที่ไม่ได้ขึ้นต้นด้วย 0 หลัง normalize', () => {
    expect(() => normalizeThaiMobile('1812345678')).toThrow()
    expect(() => normalizeThaiMobile('+15551234567')).toThrow()
    expect(() => normalizeThaiMobile('8812345678')).toThrow()
  })

  it('ปฏิเสธหมายเลขนำหน้าที่ไม่ใช่มือถือ แม้ยาว 10 หลักและขึ้นต้นด้วย 0', () => {
    expect(() => normalizeThaiMobile('0712345678')).toThrow()
    expect(() => normalizeThaiMobile('0012345678')).toThrow()
    expect(() => normalizeThaiMobile('0512345678')).toThrow()
  })

  it('ปฏิเสธ +66 ที่ตามด้วย 0 ซ้ำ — กำกวมเกินกว่าจะเดาแทนผู้ใช้', () => {
    expect(() => normalizeThaiMobile('+660812345678')).toThrow()
  })

  it('ไม่เอาเบอร์เข้าไปในข้อความ error — error ถูก log ได้ แต่เบอร์คือข้อมูลส่วนบุคคล', () => {
    const thrown = catchError(() => normalizeThaiMobile('0812345'))
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown?.message).not.toContain('0812345')
  })
})

describe('การอ่านคีย์', () => {
  it('ไม่อ่านคีย์ตอน import — โมดูลโหลดได้แม้ยังไม่ได้ตั้งคีย์', async () => {
    const before = process.env.PROMPTPAY_KEY
    delete process.env.PROMPTPAY_KEY
    try {
      vi.resetModules()
      const mod = await import('@/lib/crypto/promptpay')
      expect(typeof mod.encryptPromptPay).toBe('function')
      expect(typeof mod.decryptPromptPay).toBe('function')
      expect(typeof mod.normalizeThaiMobile).toBe('function')
    } finally {
      if (before === undefined) delete process.env.PROMPTPAY_KEY
      else process.env.PROMPTPAY_KEY = before
      vi.resetModules()
    }
  })

  it('normalize ไม่ต้องใช้คีย์ — validate เบอร์ได้แม้ env ยังไม่ตั้ง', () => {
    expect(withKey(undefined, () => normalizeThaiMobile('081-234-5678'))).toBe('0812345678')
  })

  it('คีย์ไม่ได้ตั้ง → throw ตอนเรียกใช้ พร้อมบอกวิธีแก้', () => {
    const thrown = withKey(undefined, () => catchError(() => encryptPromptPay('0812345678')))
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown?.message).toContain('PROMPTPAY_KEY')
    expect(thrown?.message).toContain('base64')
    expect(thrown?.message).toContain('32')
  })

  it('คีย์ไม่ใช่ base64 → throw', () => {
    expect(() => withKey('ไม่ใช่ base64 แน่ๆ !!!', () => encryptPromptPay('0812345678'))).toThrow()
    expect(() => withKey('****************', () => encryptPromptPay('0812345678'))).toThrow()
    // ความยาวไม่หารด้วย 4 ลงตัว
    expect(() => withKey(`${TEST_KEY.slice(0, 43)}==`, () => encryptPromptPay('0812345678'))).toThrow()
  })

  it('คีย์ base64 ที่ไม่ canonical → throw แม้จะถอดออกมาได้ 32 ไบต์', () => {
    // ตัวอักษรตัวสุดท้ายก่อน padding เก็บข้อมูลแค่ 2 บิต ที่เหลือต้องเป็นศูนย์
    // `B` ทำให้บิตส่วนเกินไม่เป็นศูนย์ — `Buffer.from` ยอมรับเงียบๆ แล้วคืน 32 ไบต์
    // ซึ่งแปลว่าคีย์ที่ใช้จริงไม่ตรงกับสตริงที่คนตั้งใจใส่ ต้องพังให้เห็น
    const nonCanonical = `${TEST_KEY.slice(0, 42)}B=`
    expect(nonCanonical).toHaveLength(44)
    expect(Buffer.from(nonCanonical, 'base64')).toHaveLength(32)
    expect(() => withKey(nonCanonical, () => encryptPromptPay('0812345678'))).toThrow()
  })

  it('คีย์ base64 ที่ไม่ใช่ 32 ไบต์ → throw', () => {
    for (const bytes of [16, 24, 31, 33, 64]) {
      const wrong = randomBytes(bytes).toString('base64')
      expect(() => withKey(wrong, () => encryptPromptPay('0812345678'))).toThrow()
    }
  })

  it('ข้อความ error ไม่มีค่าคีย์อยู่ในนั้น', () => {
    const wrong = randomBytes(31).toString('base64')
    const thrown = withKey(wrong, () => catchError(() => encryptPromptPay('0812345678')))
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown?.message).not.toContain(wrong)
    // เศษของคีย์ก็ห้ามหลุด
    expect(thrown?.message).not.toContain(wrong.slice(0, 8))
  })

  it('decrypt ก็ตรวจคีย์ด้วยกฎเดียวกัน', () => {
    const { cipher } = encryptPromptPay('0812345678')
    expect(() => withKey(undefined, () => decryptPromptPay(cipher))).toThrow()
    expect(() => withKey('not-base64!!', () => decryptPromptPay(cipher))).toThrow()
    expect(() =>
      withKey(randomBytes(16).toString('base64'), () => decryptPromptPay(cipher)),
    ).toThrow()
  })

  it('อ่านคีย์ทุกครั้งที่เรียก — เปลี่ยนคีย์ระหว่างรันแล้วผลเปลี่ยนตาม', () => {
    const { cipher } = encryptPromptPay('0812345678')
    const otherKey = randomBytes(32).toString('base64')
    expect(() => withKey(otherKey, () => decryptPromptPay(cipher))).toThrow()
    // คีย์เดิมยังถอดได้ตามปกติ
    expect(decryptPromptPay(cipher)).toBe('0812345678')
  })
})

describe('encryptPromptPay', () => {
  it('คืน Buffer กับ last4', () => {
    const { cipher, last4 } = encryptPromptPay('0812345678')
    expect(Buffer.isBuffer(cipher)).toBe(true)
    expect(last4).toBe('5678')
  })

  it('last4 คือ 4 ตัวท้ายของเบอร์ที่ normalize แล้ว ไม่ใช่ของ input ดิบ (D12)', () => {
    expect(encryptPromptPay('081-234-5678').last4).toBe('5678')
    expect(encryptPromptPay('+66812345678').last4).toBe('5678')
    expect(encryptPromptPay('๐๘๑๒๓๔๕๖๗๘').last4).toBe('5678')
    expect(encryptPromptPay('0912345600').last4).toBe('5600')
  })

  it('normalize ให้ก่อนเข้ารหัส — รูปแบบต่างกันถอดออกมาได้เบอร์เดียวกัน', () => {
    for (const form of ['0812345678', '081-234-5678', '081 234 5678', '+66812345678', '66812345678']) {
      expect(decryptPromptPay(encryptPromptPay(form).cipher)).toBe('0812345678')
    }
  })

  it('ปฏิเสธเบอร์ที่ไม่ถูกต้องก่อนถึงขั้นเข้ารหัส', () => {
    expect(() => encryptPromptPay('')).toThrow()
    expect(() => encryptPromptPay('021234567')).toThrow()
    expect(() => encryptPromptPay('abc')).toThrow()
  })

  it('เข้ารหัสเบอร์เดิมสองครั้งได้ ciphertext คนละอัน แต่ถอดได้เบอร์เดิมทั้งคู่', () => {
    const first = encryptPromptPay('0812345678')
    const second = encryptPromptPay('0812345678')
    expect(first.cipher.equals(second.cipher)).toBe(false)
    // iv คือส่วนที่ต้องต่างกัน
    expect(first.cipher.subarray(0, IV_BYTES).equals(second.cipher.subarray(0, IV_BYTES))).toBe(false)
    expect(decryptPromptPay(first.cipher)).toBe('0812345678')
    expect(decryptPromptPay(second.cipher)).toBe('0812345678')
    expect(first.last4).toBe(second.last4)
  })

  it('ก้อนเดียวเรียง iv || authTag || ciphertext', () => {
    const { cipher } = encryptPromptPay('0812345678')
    // GCM ไม่ขยายความยาว — ciphertext ยาวเท่า plaintext (10 หลัก)
    expect(cipher.byteLength).toBe(IV_BYTES + AUTH_TAG_BYTES + 10)
  })

  it('ไม่มีเบอร์เป็น plaintext อยู่ในก้อน cipher', () => {
    const { cipher } = encryptPromptPay('0812345678')
    expect(cipher.toString('latin1')).not.toContain('0812345678')
    expect(cipher.toString('latin1')).not.toContain('5678')
  })
})

describe('decryptPromptPay', () => {
  it('ถอดกลับได้เบอร์เดิม', () => {
    for (const mobile of ['0812345678', '0612345678', '0999999999', '0600000000']) {
      expect(decryptPromptPay(encryptPromptPay(mobile).cipher)).toBe(mobile)
    }
  })

  it('พลิกบิตในส่วน ciphertext แล้ว throw ไม่ใช่คืนขยะ', () => {
    const { cipher } = encryptPromptPay('0812345678')
    for (let i = IV_BYTES + AUTH_TAG_BYTES; i < cipher.byteLength; i += 1) {
      expect(() => decryptPromptPay(flipBit(cipher, i))).toThrow()
    }
  })

  it('พลิกบิตในส่วน authTag แล้ว throw', () => {
    const { cipher } = encryptPromptPay('0812345678')
    for (let i = IV_BYTES; i < IV_BYTES + AUTH_TAG_BYTES; i += 1) {
      expect(() => decryptPromptPay(flipBit(cipher, i))).toThrow()
    }
  })

  it('พลิกบิตในส่วน iv แล้ว throw', () => {
    const { cipher } = encryptPromptPay('0812345678')
    for (let i = 0; i < IV_BYTES; i += 1) {
      expect(() => decryptPromptPay(flipBit(cipher, i))).toThrow()
    }
  })

  it('ตัดท้ายทิ้งหนึ่งไบต์แล้ว throw', () => {
    const { cipher } = encryptPromptPay('0812345678')
    expect(() => decryptPromptPay(cipher.subarray(0, cipher.byteLength - 1))).toThrow()
  })

  it('buffer สั้นเกินกว่าจะเป็นข้อมูลที่ถูกต้อง → throw ข้อความของเราเอง', () => {
    // ถ้าปล่อยให้ไหลเข้า node โดยไม่กันก่อน จะได้ TypeError ภายใน
    // (`ERR_CRYPTO_INVALID_IV` / `ERR_CRYPTO_INVALID_AUTH_TAG`) ที่อ่านแล้ว
    // ไม่รู้ว่าข้อมูลในคอลัมน์เสียหาย — ข้อความของเราต้องบอกความยาวที่ขาดไป
    for (const size of [0, 1, IV_BYTES, IV_BYTES + AUTH_TAG_BYTES - 1, IV_BYTES + AUTH_TAG_BYTES]) {
      const thrown = catchError(() => decryptPromptPay(randomBytes(size)))
      expect(thrown).toBeInstanceOf(Error)
      expect(thrown?.constructor.name).toBe('Error')
      expect(thrown?.message).toContain('สั้นเกิน')
      expect(thrown?.message).toContain(String(size))
    }
  })

  it('buffer ขยะที่ยาวพอ → throw ไม่ใช่คืนขยะ', () => {
    expect(() => decryptPromptPay(randomBytes(38))).toThrow()
    expect(() => decryptPromptPay(Buffer.alloc(38))).toThrow()
  })

  it('ข้อความ error ตอนถอดไม่สำเร็จบอกได้ว่าเกิดอะไร โดยไม่หลุดคีย์', () => {
    const thrown = catchError(() => decryptPromptPay(randomBytes(38)))
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown?.message).not.toContain(TEST_KEY)
  })
})
