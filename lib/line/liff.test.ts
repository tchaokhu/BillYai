import { describe, expect, it } from 'vitest'
import { verifyLiffIdToken } from './liff'

const CHANNEL_ID = '1234567890'
/** รูปแบบเดียวกับไฟล์เทสต์อื่นในโปรเจกต์ — repo public ห้ามมี id จริง */
const USER_ID = 'U-test-1111-2222'

/** เวลาหมดอายุที่ยังไม่ถึง — วินาที ไม่ใช่มิลลิวินาที ตามที่ LINE คืนมา */
function soon(): number {
  return Math.floor(Date.now() / 1000) + 600
}

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://access.line.me',
    sub: USER_ID,
    aud: CHANNEL_ID,
    exp: soon(),
    iat: Math.floor(Date.now() / 1000),
    ...over,
  }
}

/** `fetch` ปลอมที่คืนสิ่งที่เทสต์กำหนด และเก็บ request ไว้ให้ตรวจ */
function stub(body: unknown, status = 200) {
  const seen: { url?: string; init?: RequestInit } = {}
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url)
    if (init !== undefined) seen.init = init
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetchImpl, seen }
}

describe('verifyLiffIdToken', () => {
  it('token ที่ผ่านการตรวจคืน `lineUserId` จาก `sub`', async () => {
    const { fetchImpl } = stub(payload())
    const result = await verifyLiffIdToken({
      idToken: 'header.body.signature',
      channelId: CHANNEL_ID,
      fetch: fetchImpl,
    })
    expect(result).toEqual({ ok: true, lineUserId: USER_ID })
  })

  it('ยิงไป endpoint ของ LINE พร้อม `client_id` ที่เป็น Channel ID ของเรา', async () => {
    const { fetchImpl, seen } = stub(payload())
    await verifyLiffIdToken({ idToken: 'a.b.c', channelId: CHANNEL_ID, fetch: fetchImpl })

    expect(seen.url).toBe('https://api.line.me/oauth2/v2.1/verify')
    expect(seen.init?.method).toBe('POST')
    // ส่ง client_id ผิดแปลว่า LINE ตรวจ `aud` ให้กับ channel ที่ไม่ใช่ของเรา
    const body = new URLSearchParams(String(seen.init?.body))
    expect(body.get('client_id')).toBe(CHANNEL_ID)
    expect(body.get('id_token')).toBe('a.b.c')
  })
})

describe('verifyLiffIdToken — ทางที่ต้องปฏิเสธ', () => {
  async function verify(body: unknown, status = 200) {
    const { fetchImpl } = stub(body, status)
    return verifyLiffIdToken({ idToken: 'a.b.c', channelId: CHANNEL_ID, fetch: fetchImpl })
  }

  it('LINE ตอบไม่ 200 → ปฏิเสธ ไม่ throw', async () => {
    // token หมดอายุหรือปลอมได้ 400 พร้อม `error_description` — ไม่ใช่เหตุให้ทั้ง
    // request พัง คนที่เปิดหน้าเว็บต้องได้คำตอบ ไม่ใช่หน้าขาว
    // **body เป็น payload ที่ครบทุกอย่าง** — ถ้าไม่ดูสถานะ โค้ดจะรับ token ที่ LINE
    // เพิ่งบอกว่าใช้ไม่ได้ · proxy ที่คั่นกลางส่ง body แปลกๆ พร้อมสถานะ error ได้จริง
    expect(await verify(payload(), 400)).toEqual({ ok: false })
    expect(await verify({ error: 'invalid_request' }, 400)).toEqual({ ok: false })
  })

  it('`aud` ไม่ใช่ Channel ID ของเรา → ปฏิเสธ', async () => {
    // LINE ตรวจให้แล้วเมื่อส่ง `client_id` ถูก · ด่านนี้กันกรณีที่เราส่ง client_id
    // ผิดเอง ซึ่งจะกลายเป็นการรับ token ของ channel อื่นมาเป็นตัวตนในระบบเรา
    expect(await verify(payload({ aud: '9999999999' }))).toEqual({ ok: false })
  })

  it('`iss` ไม่ใช่ของ LINE → ปฏิเสธ', async () => {
    expect(await verify(payload({ iss: 'https://evil.example.com' }))).toEqual({ ok: false })
  })

  it('token หมดอายุแล้ว → ปฏิเสธ', async () => {
    expect(await verify(payload({ exp: Math.floor(Date.now() / 1000) - 1 }))).toEqual({
      ok: false,
    })
  })

  it('ไม่มี `sub` → ปฏิเสธ', async () => {
    expect(await verify(payload({ sub: undefined }))).toEqual({ ok: false })
  })

  it('body ที่ไม่ใช่ JSON → ปฏิเสธ ไม่ throw', async () => {
    const fetchImpl = async () => new Response('<html>gateway error</html>', { status: 200 })
    expect(
      await verifyLiffIdToken({ idToken: 'a.b.c', channelId: CHANNEL_ID, fetch: fetchImpl }),
    ).toEqual({ ok: false })
  })
})
