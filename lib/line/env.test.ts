import { describe, expect, it } from 'vitest'
import { readAccessToken, readChannelSecret } from './env'

const REAL = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

describe('readChannelSecret', () => {
  it('ค่าปกติผ่านไปเหมือนเดิม ไม่ตั้งธงเตือน', () => {
    expect(readChannelSecret(REAL)).toEqual({ secret: REAL, hadSurroundingWhitespace: false })
  })

  it('ตัดช่องว่าง/ขึ้นบรรทัดใหม่ที่ติดมาตอนวาง แล้วตั้งธงเตือน', () => {
    // เคสจริงที่แพงที่สุด: วาง secret ลงช่อง env แล้วติด `\n` มาด้วย
    // ค่าไม่ว่าง โค้ดจึงเดินต่อปกติ แต่ HMAC ผิดทุก request → 401 ตลอดกาล
    for (const raw of [` ${REAL}`, `${REAL} `, `\n${REAL}\n`, `\t${REAL}`, `${REAL}\r\n`]) {
      expect(readChannelSecret(raw)).toEqual({ secret: REAL, hadSurroundingWhitespace: true })
    }
  })

  it('ไม่ได้ตั้ง env → สตริงว่าง และ **ไม่ใช่** เคสช่องว่าง', () => {
    // ต้องแยกสองเรื่องออกจากกัน: "ไม่ได้ตั้ง" กับ "ตั้งแล้วแต่วางพลาด"
    // ข้อความที่ต้องบอกผู้ดูแลระบบคนละอันกันคนละเรื่อง
    for (const raw of [undefined, null, '', '   ', '\n']) {
      expect(readChannelSecret(raw)).toEqual({ secret: '', hadSurroundingWhitespace: false })
    }
  })

  it('ช่องว่างที่อยู่กลางค่าไม่ถูกแตะ', () => {
    // ถ้าตัดกลางค่าด้วย เราจะแอบแก้ secret ให้ต่างจากที่ผู้ใช้ตั้งใจ
    const odd = 'aaa bbb'
    expect(readChannelSecret(` ${odd} `)).toEqual({ secret: odd, hadSurroundingWhitespace: true })
  })
})

describe('readAccessToken — ค่าที่คนก๊อปวางจากแท็บ Messaging API', () => {
  it('ตัดช่องว่างหัวท้ายแล้วบอกว่าเจอ', () => {
    expect(readAccessToken('  abc123  ')).toEqual({ token: 'abc123', hadSurroundingWhitespace: true })
    expect(readAccessToken('abc123\n')).toEqual({
      token: 'abc123',
      hadSurroundingWhitespace: true,
    })
  })

  it('ค่าปกติไม่ถูกมาร์กว่าเพี้ยน', () => {
    expect(readAccessToken('abc123')).toEqual({ token: 'abc123', hadSurroundingWhitespace: false })
  })

  it('ไม่ได้ตั้งเลย = ว่าง และไม่ใช่ความผิดเรื่องช่องว่าง', () => {
    expect(readAccessToken(undefined)).toEqual({ token: '', hadSurroundingWhitespace: false })
    expect(readAccessToken(null)).toEqual({ token: '', hadSurroundingWhitespace: false })
    expect(readAccessToken('   ')).toEqual({ token: '', hadSurroundingWhitespace: false })
  })
})
