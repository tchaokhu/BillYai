import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyLineSignature } from './signature'

/**
 * HMAC-SHA256 เขียนใหม่จาก RFC 2104 ตรงๆ ด้วย `createHash` อย่างเดียว
 *
 * จงใจไม่ใช้ `createHmac` เพราะโค้ดจริงใช้ตัวนั้น — ถ้าเทสต์เรียกของเดียวกัน
 * ก็แค่ยืนยันบั๊กเดียวกันสองรอบ ชุดนี้จึงเดินคนละเส้นทั้งเส้น
 */
function hmacSha256FromScratch(key: Buffer, message: Buffer): Buffer {
  const BLOCK = 64
  let k = key
  if (k.length > BLOCK) k = createHash('sha256').update(k).digest()
  if (k.length < BLOCK) k = Buffer.concat([k, Buffer.alloc(BLOCK - k.length)])

  const ipad = Buffer.alloc(BLOCK)
  const opad = Buffer.alloc(BLOCK)
  for (let i = 0; i < BLOCK; i++) {
    const byte = k[i] ?? 0
    ipad[i] = byte ^ 0x36
    opad[i] = byte ^ 0x5c
  }

  const inner = createHash('sha256').update(Buffer.concat([ipad, message])).digest()
  return createHash('sha256').update(Buffer.concat([opad, inner])).digest()
}

/** ลายเซ็นที่ LINE จะส่งมาจริงสำหรับ body นี้ — คิดจากเส้นทางอิสระข้างบน */
function signIndependently(body: string, secret: string): string {
  return hmacSha256FromScratch(Buffer.from(secret, 'utf8'), Buffer.from(body, 'utf8')).toString(
    'base64',
  )
}

const SECRET = 'test-channel-secret-not-a-real-one'

describe('verifyLineSignature — ค่าอ้างอิงจากภายนอก', () => {
  it('ตรงกับ RFC 4231 test case 2', () => {
    // key="Jefe" data="what do ya want for nothing?"
    // → 5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843
    const expected = Buffer.from(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
      'hex',
    ).toString('base64')

    expect(verifyLineSignature('what do ya want for nothing?', expected, 'Jefe')).toBe(true)
  })

  it('เส้นทางอิสระใน  เทสต์ให้ผลเดียวกับ createHmac', () => {
    const body = '{"events":[]}'
    expect(signIndependently(body, SECRET)).toBe(
      createHmac('sha256', SECRET).update(body, 'utf8').digest('base64'),
    )
  })
})

describe('verifyLineSignature — ทางที่ต้องผ่าน', () => {
  it('ลายเซ็นถูกต้อง', () => {
    const body = '{"destination":"Uxxxx","events":[]}'
    expect(verifyLineSignature(body, signIndependently(body, SECRET), SECRET)).toBe(true)
  })

  it('body เป็น Buffer ให้ผลเดียวกับ string เดียวกัน', () => {
    const body = '{"events":[{"type":"message"}]}'
    const sig = signIndependently(body, SECRET)
    expect(verifyLineSignature(Buffer.from(body, 'utf8'), sig, SECRET)).toBe(true)
  })

  it('body ว่างก็ยังเซ็นและตรวจได้', () => {
    expect(verifyLineSignature('', signIndependently('', SECRET), SECRET)).toBe(true)
  })

  it('body ภาษาไทยต้องแฮชจากไบต์ ไม่ใช่ code point', () => {
    // ถ้าอิมพลีเมนต์เผลอแฮชแบบ latin1 หรือนับเป็นตัวอักษร ค่าจะไม่ตรงกับ
    // ไบต์ UTF-8 ที่ LINE ส่งมาจริง แล้ว webhook จะ 401 เฉพาะข้อความไทย
    const body = JSON.stringify({ text: 'หมูกระทะ 1,200 หาร 4 คน' })
    const sig = signIndependently(body, SECRET)

    expect(verifyLineSignature(body, sig, SECRET)).toBe(true)
    expect(Buffer.from(body, 'utf8').length).toBeGreaterThan(body.length)
  })

  it('emoji และ surrogate pair', () => {
    const body = JSON.stringify({ text: 'จ่ายแล้ว 🙏🏽' })
    expect(verifyLineSignature(body, signIndependently(body, SECRET), SECRET)).toBe(true)
  })
})

describe('verifyLineSignature — ทางที่ต้องไม่ผ่าน', () => {
  const body = '{"events":[{"type":"message","amount":120000}]}'
  const good = signIndependently(body, SECRET)

  it('secret ผิด', () => {
    expect(verifyLineSignature(body, good, `${SECRET}x`)).toBe(false)
  })

  it('body ถูกแก้แม้ไบต์เดียว', () => {
    const tampered = body.replace('120000', '120001')
    expect(tampered).not.toBe(body)
    expect(verifyLineSignature(tampered, good, SECRET)).toBe(false)
  })

  it('body ต่อท้ายด้วยช่องว่าง', () => {
    expect(verifyLineSignature(`${body} `, good, SECRET)).toBe(false)
  })

  it('ลายเซ็นถูกแก้ทีละไบต์ ทุกตำแหน่ง', () => {
    const raw = Buffer.from(good, 'base64')
    for (let i = 0; i < raw.length; i++) {
      const flipped = Buffer.from(raw)
      flipped[i] = (flipped[i] ?? 0) ^ 0x01
      expect(verifyLineSignature(body, flipped.toString('base64'), SECRET)).toBe(false)
    }
  })

  it('header ว่าง / null / undefined → false ไม่ throw', () => {
    expect(verifyLineSignature(body, '', SECRET)).toBe(false)
    expect(verifyLineSignature(body, null, SECRET)).toBe(false)
    expect(verifyLineSignature(body, undefined, SECRET)).toBe(false)
  })

  it('header ไม่ใช่ base64 → false ไม่ throw', () => {
    for (const junk of ['dummy', 'not base64 at all!!', '****', '=', 'AAAA AAAA']) {
      expect(verifyLineSignature(body, junk, SECRET)).toBe(false)
    }
  })

  it('ลายเซ็นที่ถูกต้องแต่มีอักขระขยะแทรก → false', () => {
    // `Buffer.from(s,'base64')` **ข้ามอักขระที่ไม่ใช่ base64 เงียบๆ** สตริงที่มี
    // ช่องว่างหรือ `!` แทรกอยู่จึงถอดออกมาได้ 32 ไบต์ชุดเดียวกับของจริงเป๊ะ
    // ถ้าไม่ปฏิเสธตั้งแต่ต้น เท่ากับยอมรับลายเซ็นที่ไม่ใช่ค่าที่ LINE ส่งมา
    for (const junk of [
      `${good.slice(0, 10)} ${good.slice(10)}`,
      `${good.slice(0, 10)}!${good.slice(10)}`,
      `${good.slice(0, 10)}\n${good.slice(10)}`,
      ` ${good}`,
      `${good}\n`,
    ]) {
      expect(junk).not.toBe(good)
      expect(Buffer.from(junk, 'base64').equals(Buffer.from(good, 'base64'))).toBe(true)
      expect(verifyLineSignature(body, junk, SECRET)).toBe(false)
    }
  })

  it('base64url (`-` `_`) ไม่ใช่รูปแบบที่ LINE ส่งมา → false', () => {
    const url = Buffer.from(good, 'base64').toString('base64url')
    if (url !== good) expect(verifyLineSignature(body, url, SECRET)).toBe(false)
  })

  it('header เป็น base64 ที่ถอดแล้วยาวไม่ใช่ 32 ไบต์ → false', () => {
    // ตัวเทียบแบบ timing-safe ของ node โยน error ถ้าความยาวสองฝั่งไม่เท่ากัน
    // ความยาวจึงต้องถูกเช็คก่อน ไม่ใช่ปล่อยให้ throw ออกไปเป็น 500
    const short = Buffer.from(good, 'base64').subarray(0, 16).toString('base64')
    const long = Buffer.concat([Buffer.from(good, 'base64'), Buffer.alloc(8)]).toString('base64')

    expect(verifyLineSignature(body, short, SECRET)).toBe(false)
    expect(verifyLineSignature(body, long, SECRET)).toBe(false)
  })

  it('ลายเซ็นของ body อื่นที่เซ็นด้วย secret เดียวกัน', () => {
    const other = '{"events":[]}'
    expect(verifyLineSignature(body, signIndependently(other, SECRET), SECRET)).toBe(false)
  })
})

describe('verifyLineSignature — ตั้งค่าผิดต้องดัง', () => {
  it('channel secret ว่าง → throw ไม่ใช่คืน false เงียบๆ', () => {
    // คืน false เงียบๆ จะกลายเป็น 401 ทุก request แล้ว LINE retry ไม่เลิก
    // โดยที่ log ไม่มีอะไรบอกว่าเป็นเรื่อง env ไม่ใช่เรื่องลายเซ็น
    expect(() => verifyLineSignature('{}', 'AAAA', '')).toThrow()
  })
})
