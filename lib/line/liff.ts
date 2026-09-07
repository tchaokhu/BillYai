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

/** เท่ากับ `lib/line/client.ts` — ปลายทางเดียวกัน ไม่มีเหตุให้ต่างกัน */
const DEFAULT_TIMEOUT_MS = 3000

export interface VerifyLiffIdTokenRequest {
  idToken: string
  /** Channel ID ของ **LINE Login channel** ไม่ใช่ของ Messaging API channel */
  channelId: string
  fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>
  timeoutMs?: number
}

/**
 * **`rejected` กับ `unreachable` แยกกัน** — ปลายทางคนละเรื่อง: token ใช้ไม่ได้
 * แปลว่าให้เขากดจากการ์ดใหม่ · ยิงไปหา LINE ไม่ถึงแปลว่าให้ลองใหม่ทีหลัง ·
 * ยุบเป็นค่าเดียวแปลว่าตอนเน็ตขาดเราจะบอกผู้ใช้ว่าเซสชันหมดอายุ แล้วเขาจะไปกด
 * วนอยู่กับสิ่งที่ไม่ใช่ปัญหาของเขา
 */
export type VerifyLiffIdTokenResult =
  | { ok: true; lineUserId: string }
  | { ok: false; reason: 'rejected' | 'unreachable' }

export async function verifyLiffIdToken(
  request: VerifyLiffIdTokenRequest,
): Promise<VerifyLiffIdTokenResult> {
  /**
   * **ต้องมี timeout เสมอ** — เส้นนี้อยู่ระหว่างคนที่กดปุ่มกับหน้าจอที่ยังไม่ขึ้น
   * LINE ที่ตอบช้าโดยไม่ตอบเลยจะกลายเป็น invocation ที่ค้างจนแพลตฟอร์มตัดเอง
   * และผู้ใช้เห็นหน้าขาวค้างตลอดเวลานั้น
   */
  let response: Response
  try {
    response = await request.fetch(VERIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        id_token: request.idToken,
        client_id: request.channelId,
      }).toString(),
      signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
  } catch {
    // DNS · TLS · connection reset · timeout — ทั้งหมดคือ "ยังไม่รู้ว่า token ดีไหม"
    return { ok: false, reason: 'unreachable' }
  }

  /**
   * **ตอบไม่ 200 = ปฏิเสธ ไม่ใช่ throw** — token หมดอายุหรือปลอมได้ `400` กลับมา
   * ซึ่งเป็นคำตอบปกติของ endpoint นี้ ไม่ใช่เหตุขัดข้อง · โยน error ขึ้นไปแปลว่า
   * คนที่เปิดหน้าเว็บได้หน้าขาวแทนที่จะได้คำตอบว่าให้เปิดใหม่
   */
  if (!response.ok) return { ok: false, reason: 'rejected' }

  // body ที่ไม่ใช่ JSON เกิดได้เมื่อมีอะไรคั่นกลางแล้วส่งหน้า error ของตัวเองมาแทน
  let claims: Record<string, unknown>
  try {
    claims = (await response.json()) as Record<string, unknown>
  } catch {
    return { ok: false, reason: 'rejected' }
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
  if (claims.iss !== LINE_ISSUER) return { ok: false, reason: 'rejected' }
  if (claims.aud !== request.channelId) return { ok: false, reason: 'rejected' }

  const exp = claims.exp
  if (typeof exp !== 'number' || exp * 1000 <= Date.now()) return { ok: false, reason: 'rejected' }

  const sub = claims.sub
  return typeof sub === 'string' && sub !== ''
    ? { ok: true, lineUserId: sub }
    : { ok: false, reason: 'rejected' }
}
