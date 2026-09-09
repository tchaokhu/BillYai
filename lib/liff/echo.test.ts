import { describe, expect, it } from 'vitest'

import { draftEchoText, liffUrlOf, readDraftEcho } from './echo'

const LIFF_URL = 'https://liff.line.me/1234567890-AbCdEfGh'
const DRAFT_ID = '3f7c1a2e-9b45-4d10-8c3e-77a1b2c3d4e5'

describe('draftEchoText — ข้อความที่หน้าจอยิงเข้าแชทหลังเซฟ', () => {
  it('มีทั้งสรุปที่คนอ่านรู้เรื่อง และลิงก์ที่บอทอ่านออก', () => {
    const text = draftEchoText({ description: 'ข้าวเย็น', liffUrl: LIFF_URL, draftId: DRAFT_ID })

    expect(text).toContain('ข้าวเย็น')
    expect(text).toContain(`${LIFF_URL}?draftId=${DRAFT_ID}`)
  })

  it('ลิงก์อยู่คนละบรรทัดกับสรุป — LINE ตัดลิงก์กลางบรรทัดเป็นข้อความธรรมดา', () => {
    const text = draftEchoText({ description: 'ข้าวเย็น', liffUrl: LIFF_URL, draftId: DRAFT_ID })
    const lines = text.split('\n')

    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe(`${LIFF_URL}?draftId=${DRAFT_ID}`)
  })

  it('ชื่อบิลว่างก็ยังส่งได้ — ลิงก์คือของที่บอทต้องการ ไม่ใช่ชื่อ', () => {
    const text = draftEchoText({ description: '   ', liffUrl: LIFF_URL, draftId: DRAFT_ID })

    expect(readDraftEcho(text, LIFF_URL)).toBe(DRAFT_ID)
  })

  it('ชื่อบิลยาวถูกตัด — ข้อความนี้โผล่ในกลุ่มให้ทุกคนเห็น', () => {
    const text = draftEchoText({
      description: 'ก'.repeat(200),
      liffUrl: LIFF_URL,
      draftId: DRAFT_ID,
    })

    expect(text.split('\n')[0]!.length).toBeLessThanOrEqual(60)
    expect(readDraftEcho(text, LIFF_URL)).toBe(DRAFT_ID)
  })

  it('ชื่อบิลที่มีขึ้นบรรทัดใหม่ไม่ทำให้ลิงก์หลุดบรรทัดตัวเอง', () => {
    const text = draftEchoText({
      description: 'ข้าว\nเย็น',
      liffUrl: LIFF_URL,
      draftId: DRAFT_ID,
    })

    expect(text.split('\n')).toHaveLength(2)
    expect(readDraftEcho(text, LIFF_URL)).toBe(DRAFT_ID)
  })
})

describe('readDraftEcho — บอทอ่านลิงก์ของตัวเองกลับ', () => {
  it('อ่าน draftId จากข้อความที่ตัวเองสร้าง', () => {
    const text = draftEchoText({ description: 'ข้าวเย็น', liffUrl: LIFF_URL, draftId: DRAFT_ID })

    expect(readDraftEcho(text, LIFF_URL)).toBe(DRAFT_ID)
  })

  /**
   * ยังไม่ได้ตั้ง `NEXT_PUBLIC_LIFF_ID` = ไม่มีที่อยู่ให้เทียบ · เทียบกับสตริงว่าง
   * แปลว่าลิงก์ของ LIFF app ใครก็ได้กลายเป็นคำสั่งของบอทเรา
   */
  it('ไม่ได้ตั้ง liffUrl = ไม่มีอะไรเป็น Trigger ได้เลย', () => {
    const text = draftEchoText({ description: 'ข้าวเย็น', liffUrl: LIFF_URL, draftId: DRAFT_ID })

    expect(readDraftEcho(text, null)).toBeNull()
    expect(readDraftEcho(text, '')).toBeNull()
  })

  it('ข้อความธรรมดาไม่ใช่ Trigger', () => {
    expect(readDraftEcho('จดรายชิ้นแล้ว — ข้าวเย็น', LIFF_URL)).toBeNull()
    expect(readDraftEcho('', LIFF_URL)).toBeNull()
  })

  /**
   * D47 ถูกยกเว้นได้เพราะ **ลิงก์ไปหา LIFF ของบอทเราคือการเรียกบอท** · ลิงก์ของ
   * LIFF app ใบอื่นไม่ใช่ และต้องไม่ถูกอ่านเป็นคำสั่ง
   */
  it('ลิงก์ของ LIFF app ใบอื่นไม่ใช่ Trigger', () => {
    const other = `https://liff.line.me/9999999999-ZzZzZzZz?draftId=${DRAFT_ID}`

    expect(readDraftEcho(other, LIFF_URL)).toBeNull()
  })

  /**
   * `1234567890-AbCdEfGh` เป็นคำนำหน้าของ `1234567890-AbCdEfGhIj` ตรงๆ · เทียบ
   * ด้วย `startsWith` เฉยๆ แปลว่า LIFF app ของคนอื่นที่ id ขึ้นต้นเหมือนกันสั่งเราได้
   */
  it('LIFF id ที่ขึ้นต้นเหมือนกันแต่ยาวกว่าไม่ใช่ Trigger', () => {
    const longer = `https://liff.line.me/1234567890-AbCdEfGhIj?draftId=${DRAFT_ID}`

    expect(readDraftEcho(longer, LIFF_URL)).toBeNull()
  })

  it('ลิงก์ที่ไม่มี draftId ไม่ใช่ Trigger — ปุ่มบนการ์ดใบอื่นก็หน้าตาแบบนี้', () => {
    expect(readDraftEcho(`เปิดดู ${LIFF_URL}`, LIFF_URL)).toBeNull()
    expect(readDraftEcho(`${LIFF_URL}?draftId=`, LIFF_URL)).toBeNull()
  })

  /**
   * ค่าที่ไม่ใช่ uuid ไม่ได้ "หาไม่เจอ" แต่ทำให้ Postgres โยน แล้วกลายเป็น 500 ซึ่ง
   * LINE ตอบด้วยการยิง webhook เดิมซ้ำ · ด่านเดียวกับ `lib/db/uuid.ts`
   */
  it('draftId ที่ไม่ใช่ uuid ไม่ใช่ Trigger', () => {
    expect(readDraftEcho(`${LIFF_URL}?draftId=ไม่ใช่ยูยูไอดี`, LIFF_URL)).toBeNull()
    expect(readDraftEcho(`${LIFF_URL}?draftId=00000000-0000-0000-0000-000000000000`, LIFF_URL))
      .toBeNull()
  })

  it('uuid ตัวพิมพ์ใหญ่อ่านได้ — Postgres ไม่แคร์ตัวพิมพ์', () => {
    const upper = DRAFT_ID.toUpperCase()

    expect(readDraftEcho(`${LIFF_URL}?draftId=${upper}`, LIFF_URL)).toBe(upper)
  })

  it('uuid ที่มีตัวอักษรต่อท้ายติดกันไม่ใช่ Trigger', () => {
    expect(readDraftEcho(`${LIFF_URL}?draftId=${DRAFT_ID}f`, LIFF_URL)).toBeNull()
  })

  it('ลิงก์ที่คนแปะมาเองพร้อมข้อความอื่นก็อ่านได้', () => {
    const pasted = `ดูรายการที่นี่นะ ${LIFF_URL}?draftId=${DRAFT_ID} ใครกินอะไรติ๊กด้วย`

    expect(readDraftEcho(pasted, LIFF_URL)).toBe(DRAFT_ID)
  })

  /**
   * `liffUrl` ประกอบจาก env ที่คนตั้งเอง · จุดกับขีดใน id ต้องไม่ถูกอ่านเป็น
   * metacharacter ของ regex ไม่งั้น `.` จะแมตช์อักษรอะไรก็ได้
   */
  it('อักขระพิเศษใน liffUrl ไม่ถูกอ่านเป็น regex', () => {
    const dotted = 'https://liff.line.me/1234567890-AbCdEfGh'
    const spoofed = `https://liffxline.me/1234567890-AbCdEfGh?draftId=${DRAFT_ID}`

    expect(readDraftEcho(spoofed, dotted)).toBeNull()
  })
})

/**
 * `NEXT_PUBLIC_LIFF_ID` ถูกอ่านทั้งฝั่งบอท (สร้างปุ่มบนการ์ด) และฝั่งหน้าจอ
 * (สร้างลิงก์ใน Trigger) · กฎว่า "ค่าแบบไหนใช้ได้" ต้องอยู่ที่เดียว ไม่งั้นวันหนึ่ง
 * ปุ่มจะมีแต่ Trigger จะไม่มี แล้วอาการคือ "เซฟแล้วการ์ดไม่มา" ซึ่งไล่ยากมาก
 */
describe('liffUrlOf — ค่า env เป็นที่อยู่ของ LIFF app ได้ไหม', () => {
  it('รูปที่ถูกกลายเป็น URL เต็ม', () => {
    expect(liffUrlOf('1234567890-AbCdEfGh')).toBe('https://liff.line.me/1234567890-AbCdEfGh')
  })

  it('ช่องว่างหัวท้ายที่ติดมากับการ copy ไม่ทำให้ลิงก์เสีย', () => {
    expect(liffUrlOf('  1234567890-AbCdEfGh \n')).toBe('https://liff.line.me/1234567890-AbCdEfGh')
  })

  it('ยังไม่ได้ตั้ง = ไม่มีที่อยู่', () => {
    expect(liffUrlOf(undefined)).toBeNull()
    expect(liffUrlOf(null)).toBeNull()
    expect(liffUrlOf('   ')).toBeNull()
  })

  /**
   * อาการจริงที่เจอตอนตั้ง env: วาง Channel ID (ตัวเลขล้วน) ลงช่อง LIFF ID ·
   * **ไม่มีปุ่มดีกว่าปุ่มที่กดแล้วพัง** — ดู `SETUP-DEPLOY.md` §4
   */
  it('Channel ID ตัวเลขล้วนไม่ใช่ LIFF ID', () => {
    expect(liffUrlOf('1234567890')).toBeNull()
  })

  it('ค่าที่มีอักขระของ URL ปนมาไม่ใช่ LIFF ID', () => {
    expect(liffUrlOf('1234567890-AbCdEfGh/../evil')).toBeNull()
    expect(liffUrlOf('1234567890-AbCdEfGh?draftId=x')).toBeNull()
    expect(liffUrlOf('https://liff.line.me/1234567890-AbCdEfGh')).toBeNull()
  })
})
