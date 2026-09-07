/**
 * `POST /api/liff/draft` — หน้าจอ LIFF เซฟรายการรายชิ้นกลับลง draft ใบเดิม (D57)
 *
 * สายไฟอย่างเดียว เหมือน `../session/route.ts` · ตรรกะและด่านสิทธิ์ทั้งหมดอยู่ใน
 * `lib/liff/save.ts` กับ `lib/liff/authorize.ts`
 *
 * **ไม่แตะ ledger** — D30 ให้เขียนตอนกดยืนยันในแชทเท่านั้น เส้นนี้เขียนแค่ `payload`
 * ของ draft · `POST` ไม่ใช่ `PATCH` เพราะมันเขียนทับทั้งบิล ไม่ได้แก้ทีละฟิลด์
 */

import { verifyLiffIdToken } from '@/lib/line/liff'
import { readLoginChannelId } from '@/lib/line/env'
import { saveLiffDraft } from '@/lib/liff/save'
import { LIFF_OUTCOMES, liffJson, logLiffFailure } from '@/lib/liff/outcomes'
import { findDraft, updateDraft } from '@/lib/repo/drafts'
import { loadGroupView } from '@/lib/repo/views'
import { readLiffBody } from '../body'

/** ต่อ Postgres ด้วย `pg` ซึ่ง edge รันไม่ได้ (D24) */
export const runtime = 'nodejs'

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const { channelId, hadSurroundingWhitespace } = readLoginChannelId(
    process.env.LINE_LOGIN_CHANNEL_ID,
  )
  if (hadSurroundingWhitespace) {
    console.error('[liff/draft] LINE_LOGIN_CHANNEL_ID มีช่องว่างหัวท้ายติดมา — ตัดให้แล้ว แต่ควรแก้ค่าใน env')
  }

  const body = await readLiffBody(request)

  const result = await saveLiffDraft(
    { idToken: body.idToken, draftId: body.draftId, bill: body.bill },
    {
      channelId,
      verifyIdToken: (idToken) => verifyLiffIdToken({ idToken, channelId, fetch }),
      findDraft,
      loadRoster: async (draft) =>
        (await loadGroupView(draft.lineGroupId, draft.lineUserId)).roster,
      updateDraft,
    },
  )

  if (result.ok) return liffJson({ ok: true, session: result.session }, 200)
  logLiffFailure('draft', result.reason)
  const { status, message } = LIFF_OUTCOMES[result.reason]
  return liffJson({ ok: false, reason: result.reason, message }, status)
}

/** เปิดในเบราว์เซอร์ตรงๆ ไม่มีอะไรให้ดู */
export function GET(): Response {
  return new Response('LIFF draft endpoint — POST only', {
    status: 405,
    headers: { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' },
  })
}
