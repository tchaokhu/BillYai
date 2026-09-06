/**
 * ตรวจ ID token ที่ LIFF ส่งมา — **ด่านเดียวที่บอกว่าใครกำลังเปิดหน้าเว็บอยู่**
 *
 * D15 ให้ verify ฝั่ง server ทุก request และไม่ใช้ RLS · หน้าเว็บส่ง `sub` (LINE
 * user id) มาเองไม่ได้ เพราะใครก็พิมพ์ค่าอะไรก็ได้ในคำขอ HTTP
 *
 * `fetch` ฉีดเข้ามาเป็นพารามิเตอร์ ไม่อ่าน `process.env` เอง และไม่ยิงเน็ตตอนเทสต์
 * — กติกาเดียวกับ `lib/line/client.ts`
 */

const VERIFY_ENDPOINT = 'https://api.line.me/oauth2/v2.1/verify'

/** ค่าที่เอกสาร LINE ระบุไว้ตายตัวสำหรับ ID token ที่ออกโดย LINE Login */
const LINE_ISSUER = 'https://access.line.me'

export interface VerifyLiffIdTokenRequest {
  idToken: string
  /** Channel ID ของ **LINE Login channel** ไม่ใช่ของ Messaging API channel */
  channelId: string
  fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>
}

export type VerifyLiffIdTokenResult =
  | { ok: true; lineUserId: string }
  | { ok: false }

export async function verifyLiffIdToken(
  request: VerifyLiffIdTokenRequest,
): Promise<VerifyLiffIdTokenResult> {
  const response = await request.fetch(VERIFY_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      id_token: request.idToken,
      client_id: request.channelId,
    }).toString(),
  })

  /**
   * **ตอบไม่ 200 = ปฏิเสธ ไม่ใช่ throw** — token หมดอายุหรือปลอมได้ `400` กลับมา
   * ซึ่งเป็นคำตอบปกติของ endpoint นี้ ไม่ใช่เหตุขัดข้อง · โยน error ขึ้นไปแปลว่า
   * คนที่เปิดหน้าเว็บได้หน้าขาวแทนที่จะได้คำตอบว่าให้เปิดใหม่
   */
  if (!response.ok) return { ok: false }

  // body ที่ไม่ใช่ JSON เกิดได้เมื่อมีอะไรคั่นกลางแล้วส่งหน้า error ของตัวเองมาแทน
  let claims: Record<string, unknown>
  try {
    claims = (await response.json()) as Record<string, unknown>
  } catch {
    return { ok: false }
  }

  /**
   * **ตรวจซ้ำเองทั้งสามข้อ ทั้งที่ LINE ตรวจให้แล้ว**
   *
   * เอกสารระบุว่า endpoint ตรวจลายเซ็น `iss` `exp` และ `aud` ให้เมื่อส่ง `client_id`
   * ไปด้วย — แต่ความถูกต้องนั้นขึ้นกับว่า**เราส่ง `client_id` ตัวถูก** ถ้าวันหนึ่ง
   * env ถูกตั้งผิดเป็น channel อื่น LINE จะตอบ 200 ให้กับ token ของ channel นั้น
   * แล้วเราจะรับคนของคนอื่นเข้ามาเป็นตัวตนในระบบโดยไม่มีอะไรฟ้อง · ด่านนี้ราคาสาม
   * บรรทัดและเป็นอิสระจากค่าที่ส่งออกไป
   */
  if (claims.iss !== LINE_ISSUER) return { ok: false }
  if (claims.aud !== request.channelId) return { ok: false }

  const exp = claims.exp
  if (typeof exp !== 'number' || exp * 1000 <= Date.now()) return { ok: false }

  const sub = claims.sub
  return typeof sub === 'string' && sub !== '' ? { ok: true, lineUserId: sub } : { ok: false }
}
