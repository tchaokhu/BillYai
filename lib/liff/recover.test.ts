import { describe, expect, it } from 'vitest'
import { shouldRelogin } from './recover'

describe('shouldRelogin — เซสชันที่ใช้ไม่ได้ต้องพาไป login ใหม่ ไม่ใช่ตัน', () => {
  /**
   * `liff.getIDToken()` คืน token ใบที่ได้ตอน login **และไม่รีเฟรชให้** ส่วน
   * `liff.isLoggedIn()` ยังเป็น `true` หลัง token หมดอายุ — หน้าจอจึงไม่พาไป login
   * เอง และคำแนะนำ "ปิดหน้านี้แล้วกดจากการ์ดใหม่" ได้ token ใบเดิมกลับมาทุกครั้ง
   */
  it('ไม่มี ID token หรือ server ตอบ `unauthenticated` → login ใหม่', () => {
    expect(shouldRelogin('no-id-token', false)).toBe(true)
    expect(shouldRelogin('unauthenticated', false)).toBe(true)
  })

  /**
   * **ครั้งเดียวต่อแท็บ** — login ใหม่แล้วยังไม่ผ่านแปลว่าเหตุไม่ได้อยู่ที่เซสชัน
   * (`aud` ผิด · scope `openid` ไม่ได้ติ๊ก) · พาไปอีกรอบคือ redirect วนไม่จบโดย
   * ผู้ใช้ไม่ได้เห็นข้อความสักครั้ง
   */
  it('ลองไปแล้วหนึ่งรอบ → ยอมแพ้ ไม่วน', () => {
    expect(shouldRelogin('no-id-token', true)).toBe(false)
    expect(shouldRelogin('unauthenticated', true)).toBe(false)
  })

  /**
   * เหตุที่เหลือ login ใหม่ไม่ช่วยเลย — การ์ดของคนอื่น (403) · การ์ดหายไปแล้ว
   * (404) · LINE หรือ Postgres ล่ม (503) · env ไม่ครบ (500) · ข้อมูลไม่ครบ (400)
   * พาไป login คือกลืนข้อความที่บอกทางออกทิ้ง แล้วผู้ใช้กลับมาเจอหน้าเดิมเป๊ะ
   */
  it.each(['not-owner', 'draft-gone', 'upstream', 'misconfigured', 'bad-request'])(
    '%s → ไม่ login ใหม่',
    (reason) => {
      expect(shouldRelogin(reason, false)).toBe(false)
    },
  )

  it('ไม่รู้เหตุ → ไม่ login ใหม่', () => {
    expect(shouldRelogin(undefined, false)).toBe(false)
  })
})
