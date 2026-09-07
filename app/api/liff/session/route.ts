/**
 * `POST /api/liff/session` — หน้าจอ LIFF ขอเปิด draft ใบหนึ่ง
 *
 * ไฟล์นี้เป็น**สายไฟอย่างเดียว**: อ่าน env, อ่าน body, เรียก `openLiffSession`,
 * แปลงผลเป็น HTTP · ตรรกะทั้งหมดอยู่ใน `lib/liff/` ซึ่งเทสต์ได้โดยไม่ต้องมี
 * Next.js และไม่ต้องมี DB — กติกาเดียวกับ `app/api/line/webhook/route.ts`
 *
 * **นี่คือทางเข้าจากภายนอกเส้นที่สองของระบบ** และเป็นเส้นแรกที่ไม่มีลายเซ็นของ
 * LINE คุ้มอยู่ ทุกไบต์ที่เข้ามาที่นี่มาจากเบราว์เซอร์ที่ผู้ใช้ควบคุมได้เต็มตัว
 */

import { verifyLiffIdToken } from '@/lib/line/liff'
import { readLoginChannelId } from '@/lib/line/env'
import { openLiffSession } from '@/lib/liff/session'
import { LIFF_OUTCOMES, liffJson, logLiffFailure } from '@/lib/liff/outcomes'
import { findDraft } from '@/lib/repo/drafts'
import { loadGroupView } from '@/lib/repo/views'
import { readLiffBody } from '../body'

/** ต่อ Postgres ด้วย `pg` ซึ่ง edge รันไม่ได้ (D24) — เหตุผลเดียวกับ webhook */
export const runtime = 'nodejs'

/** สิทธิ์ของแต่ละคนไม่เหมือนกัน ห้าม Next แคชคำตอบของเส้นนี้เด็ดขาด */
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const { channelId, hadSurroundingWhitespace } = readLoginChannelId(
    process.env.LINE_LOGIN_CHANNEL_ID,
  )
  if (hadSurroundingWhitespace) {
    // ค่าที่วางมาพร้อม `\n` ยังผ่าน `^[0-9]+$` ไม่ได้ จึงตกเป็น '' แล้วได้ 500
    // ทุก request — ซึ่งใน log แยกไม่ออกจาก "ยังไม่ได้ตั้ง env" ถ้าไม่มีบรรทัดนี้
    console.error('[liff/session] LINE_LOGIN_CHANNEL_ID มีช่องว่างหัวท้ายติดมา — ตัดให้แล้ว แต่ควรแก้ค่าใน env')
  }

  const body = await readLiffBody(request)

  const result = await openLiffSession(
    { idToken: body.idToken, draftId: body.draftId },
    {
      channelId,
      verifyIdToken: (idToken) => verifyLiffIdToken({ idToken, channelId, fetch }),
      findDraft,
      /**
       * วงมาจาก draft ที่เราเขียนเอง **ไม่ใช่จาก `liff.getContext()`** — ค่านั้น
       * บอกได้แค่ว่าขอดูวงไหน ไม่ใช่ว่ามีสิทธิ์ (D46)
       */
      loadRoster: async (draft) =>
        (await loadGroupView(draft.lineGroupId, draft.lineUserId)).roster,
    },
  )

  if (result.ok) return liffJson({ ok: true, session: result.session }, 200)
  logLiffFailure('session', result.reason)
  const { status, message } = LIFF_OUTCOMES[result.reason]
  return liffJson({ ok: false, reason: result.reason, message }, status)
}

/** เปิดในเบราว์เซอร์ตรงๆ ไม่มีอะไรให้ดู — ไม่แตะ DB ไม่บอกอะไรเกินนี้ */
export function GET(): Response {
  return new Response('LIFF session endpoint — POST only', {
    status: 405,
    headers: { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' },
  })
}
