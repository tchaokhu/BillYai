/**
 * `POST /api/liff/session` — หน้าจอ LIFF ขอเปิด draft ใบหนึ่ง
 *
 * ไฟล์นี้เป็น**สายไฟอย่างเดียว**: อ่าน env, อ่าน body, เรียก `openLiffSession`,
 * แปลงผลเป็น HTTP · ตรรกะทั้งหมดอยู่ใน `lib/liff/session.ts` ซึ่งเทสต์ได้โดยไม่ต้อง
 * มี Next.js และไม่ต้องมี DB — กติกาเดียวกับ `app/api/line/webhook/route.ts`
 *
 * **นี่คือทางเข้าจากภายนอกเส้นที่สองของระบบ** และเป็นเส้นแรกที่ไม่มีลายเซ็นของ
 * LINE คุ้มอยู่ ทุกไบต์ที่เข้ามาที่นี่มาจากเบราว์เซอร์ที่ผู้ใช้ควบคุมได้เต็มตัว
 */

import { verifyLiffIdToken } from '@/lib/line/liff'
import { readLoginChannelId } from '@/lib/line/env'
import { openLiffSession } from '@/lib/liff/session'
import type { OpenLiffSessionResult } from '@/lib/liff/session'
import { findDraft } from '@/lib/repo/drafts'

/** ต่อ Postgres ด้วย `pg` ซึ่ง edge รันไม่ได้ (D24) — เหตุผลเดียวกับ webhook */
export const runtime = 'nodejs'

/** สิทธิ์ของแต่ละคนไม่เหมือนกัน ห้าม Next แคชคำตอบของเส้นนี้เด็ดขาด */
export const dynamic = 'force-dynamic'

/**
 * เหตุผลจาก domain → HTTP + ข้อความที่ผู้ใช้อ่าน
 *
 * **`not-owner` เป็น 403 ไม่ใช่ 404** — การ์ด Draft ลอยอยู่ในกลุ่มให้ทุกคนเห็น
 * คนที่ไม่ได้พิมพ์กดเข้ามาจึงเป็นกรณีปกติ ไม่ใช่การสอดแนม · ตอบ 404 เหมือนกันหมด
 * จะได้ความลับที่ไม่มีอยู่จริง (เขาเพิ่งเห็นการ์ดใบนั้นมากับตา) แลกกับข้อความที่
 * บอกไม่ได้ว่าให้ทำยังไงต่อ
 */
const OUTCOMES = {
  misconfigured: { status: 500, message: 'ระบบยังตั้งค่าไม่ครบ ลองใหม่อีกครั้งภายหลัง' },
  'bad-request': { status: 400, message: 'ลิงก์ไม่สมบูรณ์ — กลับไปกดปุ่มบนการ์ดในแชทอีกครั้ง' },
  unauthenticated: { status: 401, message: 'เซสชันหมดอายุ — ปิดหน้านี้แล้วกดจากการ์ดใหม่' },
  'draft-gone': { status: 404, message: 'บิลใบนี้ใช้ไม่ได้แล้ว — พิมพ์ใหม่ในแชทได้เลย' },
  'not-owner': { status: 403, message: 'บิลใบนี้เป็นของคนที่พิมพ์ ให้เขาเป็นคนแก้' },
  /**
   * **503 ไม่ใช่ 500** — ของเราไม่ได้พัง ปลายทางที่เราพึ่งอยู่ตอบไม่ได้ชั่วคราว
   * และข้อความต้องบอกให้ลองใหม่ ไม่ใช่ให้ไปกดการ์ดใหม่ซึ่งไม่ช่วยอะไร
   */
  upstream: { status: 503, message: 'ตอนนี้เชื่อมต่อไม่ได้ รอสักครู่แล้วลองใหม่' },
} as const satisfies Record<string, { status: number; message: string }>

export async function POST(request: Request): Promise<Response> {
  const { channelId, hadSurroundingWhitespace } = readLoginChannelId(
    process.env.LINE_LOGIN_CHANNEL_ID,
  )
  if (hadSurroundingWhitespace) {
    // ค่าที่วางมาพร้อม `\n` ยังผ่าน `^[0-9]+$` ไม่ได้ จึงตกเป็น '' แล้วได้ 500
    // ทุก request — ซึ่งใน log แยกไม่ออกจาก "ยังไม่ได้ตั้ง env" ถ้าไม่มีบรรทัดนี้
    console.error('[liff] LINE_LOGIN_CHANNEL_ID มีช่องว่างหัวท้ายติดมา — ตัดให้แล้ว แต่ควรแก้ค่าใน env')
  }

  /**
   * body ที่ไม่ใช่ JSON = คำขอที่เราไม่ได้ออกแบบไว้ ไม่ใช่เหตุขัดข้องของเรา
   * `{}` เดินต่อไปตกด่านใน `openLiffSession` เอง จึงไม่ต้องมีสองทางแยกที่นี่
   */
  let body: Record<string, unknown> = {}
  try {
    const parsed: unknown = await request.json()
    if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>
  } catch {
    // ตั้งใจกลืน — ผลลัพธ์คือ bad-request ซึ่งถูกแล้ว
  }

  const result = await openLiffSession(
    { idToken: body.idToken, draftId: body.draftId },
    {
      channelId,
      verifyIdToken: (idToken) => verifyLiffIdToken({ idToken, channelId, fetch }),
      findDraft,
    },
  )

  logOutcome(result)

  if (result.ok) return json({ ok: true, session: result.session }, 200)
  const { status, message } = OUTCOMES[result.reason]
  return json({ ok: false, reason: result.reason, message }, status)
}

/**
 * log เฉพาะเหตุผลซึ่งเป็นค่าคงที่ล้วน — **ไม่ log `draftId` `sub` หรือ body**
 * repo เป็น public และ log ไม่ควรสะสมของที่ยิงซ้ำได้ (กติกาเดียวกับ webhook)
 */
function logOutcome(result: OpenLiffSessionResult): void {
  if (result.ok) return
  if (result.reason === 'upstream') {
    console.error('[liff] ต่อ LINE หรือ Postgres ไม่ได้ — ไม่ใช่ความผิดของคนที่กด')
    return
  }
  if (result.reason === 'misconfigured') {
    console.error('[liff] LINE_LOGIN_CHANNEL_ID ไม่ได้ตั้ง หรือไม่ใช่ตัวเลขล้วน — ดู SETUP-DEPLOY.md §4')
    return
  }
  console.warn(`[liff] session ปฏิเสธ reason=${result.reason}`)
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // คำตอบผูกกับตัวคนขอ ห้ามมี proxy ไหนเก็บไว้แจกต่อ
      'cache-control': 'no-store',
    },
  })
}

/** เปิดในเบราว์เซอร์ตรงๆ ไม่มีอะไรให้ดู — ไม่แตะ DB ไม่บอกอะไรเกินนี้ */
export function GET(): Response {
  return new Response('LIFF session endpoint — POST only', {
    status: 405,
    headers: { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' },
  })
}
