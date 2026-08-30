/**
 * อ่านค่า env ของ LINE ให้ปลอดภัยจากอุบัติเหตุตอนวาง — adapter ไม่ใช่ domain core
 *
 * มีไฟล์นี้เพราะ failure mode ที่แพงที่สุดของ webhook ไม่ใช่โค้ดผิด แต่คือ **secret
 * ที่ถูกวางมาพร้อมช่องว่างหรือขึ้นบรรทัดใหม่ติดท้าย** ค่านั้นไม่ว่าง โค้ดจึงเดินต่อ
 * ปกติทุกบรรทัด แล้ว HMAC ออกมาไม่ตรงทุก request → 401 ตลอดกาล → LINE retry ไม่เลิก
 * และ log ที่ได้หน้าตาเหมือนคนนอกยิงลายเซ็นปลอมเป๊ะ แยกไม่ออกเลยว่าเป็นเรื่อง env
 */

export interface ChannelSecret {
  /** ค่าที่เอาไปใช้จริง — ตัดช่องว่างหัวท้ายแล้ว */
  secret: string
  /** ค่าดิบมีช่องว่างหัวท้ายติดมา — ผู้เรียกควรเตือนดังๆ ครั้งเดียว */
  hadSurroundingWhitespace: boolean
}

/**
 * channel secret ของ LINE เป็นอักขระ hex/ตัวอักษรล้วน **ไม่มีช่องว่างอยู่ในค่าจริง**
 * การตัดหัวท้ายจึงไม่มีทางทำให้ secret ที่ถูกต้องเสียหาย มีแต่กู้ค่าที่วางพลาดคืนมา
 */
export function readChannelSecret(raw: string | undefined | null): ChannelSecret {
  const { trimmed, hadSurroundingWhitespace } = trimPasted(raw)
  return { secret: trimmed, hadSurroundingWhitespace }
}

export interface AccessToken {
  /** ค่าที่เอาไปใช้จริง — ตัดช่องว่างหัวท้ายแล้ว */
  token: string
  hadSurroundingWhitespace: boolean
}

/**
 * channel access token อยู่คนละแท็บกับ channel secret (Messaging API vs Basic
 * settings) และยาวกว่ามาก จึงถูกก๊อปวางแบบมีบรรทัดใหม่ติดมาได้ง่ายกว่าด้วยซ้ำ
 *
 * failure mode ต่างจาก secret: token ที่เพี้ยนไม่ทำให้ webhook 401 แต่ทำให้ทุก
 * reply ได้ 401 กลับมาจาก LINE ซึ่งผู้ใช้เห็นเป็น "บอทเงียบ" เฉยๆ
 */
export function readAccessToken(raw: string | undefined | null): AccessToken {
  const { trimmed, hadSurroundingWhitespace } = trimPasted(raw)
  return { token: trimmed, hadSurroundingWhitespace }
}

/** ค่าว่างไม่ถือว่าเป็นความผิดเรื่องช่องว่าง — มันคือ "ยังไม่ได้ตั้ง" ซึ่งคนละอาการ */
function trimPasted(raw: string | undefined | null): {
  trimmed: string
  hadSurroundingWhitespace: boolean
} {
  const value = raw ?? ''
  const trimmed = value.trim()
  return { trimmed, hadSurroundingWhitespace: trimmed.length > 0 && trimmed !== value }
}
