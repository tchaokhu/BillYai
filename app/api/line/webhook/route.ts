/**
 * `/api/line/webhook` — ปลายทางที่ตั้งไว้ใน LINE Developers Console
 *
 * ไฟล์นี้เป็น**สายไฟอย่างเดียว**: อ่าน env, อ่าน header, เรียก `handleLineWebhook`,
 * แปลงผลเป็น HTTP · ตรรกะทั้งหมดอยู่ใน `lib/line/webhook.ts` ซึ่งเทสต์ได้โดยไม่ต้อง
 * มี Next.js และไม่ต้องมี DB
 *
 * รอบ M4 ทำเส้นทาง verify → อ่าน event → ตอบกลับด้วย reply API · **ยังไม่แตะ DB
 * เลยสักบรรทัด** การจดบิลเป็นของ M5/M6
 */

import { replyToLine } from '@/lib/line/client'
import { readAccessToken, readChannelSecret } from '@/lib/line/env'
import { handleLineWebhook, type GroupView } from '@/lib/line/webhook'
import { createDraft } from '@/lib/repo/drafts'
import { findActiveGroupByLineGroupId } from '@/lib/repo/groups'
import { findMemberByLineUserId, listMembers } from '@/lib/repo/members'

/**
 * ทุกอย่างที่ต้องรู้เกี่ยวกับวงเพื่อวาดการ์ดหนึ่งใบ — **อ่านอย่างเดียว** (D28)
 *
 * ไม่มีวง = ว่างทั้งก้อน ซึ่งถูกต้องและเกิดบ่อยที่สุด: วงเกิดตอนกดยืนยันบิลใบแรก
 * (D30) กลุ่มที่ยังไม่มีใครยืนยันอะไรเลยจึงยังไม่มีแถวใน `ledger_group`
 */
async function loadGroupView(
  lineGroupId: string | null,
  lineUserId: string,
): Promise<GroupView> {
  const empty: GroupView = { roster: [], payerName: null, unclaimed: [] }
  if (lineGroupId === null) return empty
  const group = await findActiveGroupByLineGroupId(lineGroupId)
  if (group === null) return empty

  const members = await listMembers(group.id)
  const payer = await findMemberByLineUserId(group.id, lineUserId)
  return {
    roster: members.map((member) => member.displayName),
    payerName: payer?.displayName ?? null,
    // คนที่ถูก claim ไปแล้วไม่ใช่ตัวเลือก — เขามีเจ้าของอยู่แล้ว
    unclaimed: members.filter((m) => m.appUserId === null).map((m) => m.displayName),
  }
}

/**
 * ยังเป็น node runtime — M5 เป็นต้นไปต่อ Postgres ด้วย `pg` ซึ่ง edge รันไม่ได้ (D24)
 * และการสลับ runtime ไปมาระหว่างเฟสไม่ได้ประโยชน์อะไร
 */
export const runtime = 'nodejs'

/** ทุก request ต้องวิ่งจริง ห้ามให้ Next แคชคำตอบของ webhook */
export const dynamic = 'force-dynamic'

/**
 * region ตั้งที่ `vercel.json` (`sin1`) ไม่ใช่ที่ไฟล์นี้ — `preferredRegion` ของ
 * route segment ถูก deprecate ใน Next 16 แล้ว
 *
 * S4 บันทึกไว้เองว่า region สำคัญกว่า cold start — default ของ Vercel ไม่ใช่สิงคโปร์
 * ผู้ใช้อยู่ไทย และ Supabase ที่สร้างไว้ก็อยู่ `ap-southeast-1` ให้ตรงกัน
 */

export async function POST(request: Request): Promise<Response> {
  const { secret: channelSecret, hadSurroundingWhitespace } = readChannelSecret(
    process.env.LINE_CHANNEL_SECRET,
  )
  if (hadSurroundingWhitespace) {
    // ค่าที่วางมาพร้อม `\n` ยังไม่ว่าง โค้ดจึงเดินต่อปกติแล้ว 401 ทุก request
    // ซึ่งใน log แยกไม่ออกจากคนนอกยิงลายเซ็นปลอม — บรรทัดนี้คือตัวแยก
    console.error('[webhook] LINE_CHANNEL_SECRET มีช่องว่างหัวท้ายติดมา — ตัดให้แล้ว แต่ควรแก้ค่าใน env')
  }
  if (channelSecret.length === 0) {
    // ตอบ 500 ไม่ใช่ 401 — LINE จะ retry ซึ่งถูกแล้ว เพราะพอตั้ง env ถูกเมื่อไหร่
    // event ชุดเดิมก็จะเข้ามาสำเร็จ ส่วน 401 จะทำให้ event หายถาวรเพราะเราตั้งค่าพลาด
    console.error('[webhook] LINE_CHANNEL_SECRET ไม่ได้ตั้ง — ดู .env.local.example')
    return new Response('misconfigured', { status: 500 })
  }

  const { token: accessToken, hadSurroundingWhitespace: tokenHadWhitespace } = readAccessToken(
    process.env.LINE_CHANNEL_ACCESS_TOKEN,
  )
  if (tokenHadWhitespace) {
    // อาการของ token ที่เพี้ยนคือ "บอทเงียบ" ไม่ใช่ 401 ที่ webhook — แยกยากกว่า
    console.error('[webhook] LINE_CHANNEL_ACCESS_TOKEN มีช่องว่างหัวท้ายติดมา — ตัดให้แล้ว แต่ควรแก้ค่าใน env')
  }
  const canReply = accessToken.length > 0

  // **ต้องเป็น text() ไม่ใช่ json()** — ลายเซ็นคิดจากไบต์ที่มาจริง
  // parse แล้ว stringify กลับจะได้คนละไบต์ แล้วลายเซ็นจะไม่ผ่านทั้งที่ของแท้
  const rawBody = await request.text()

  const result = await handleLineWebhook(
    {
      rawBody,
      signature: request.headers.get('x-line-signature'),
      channelSecret,
      retryKey: request.headers.get('x-line-retry-key'),
    },
    {
      reply: async (replyToken, messages) =>
        canReply
          ? replyToLine({ replyToken, messages, accessToken }, { fetch })
          : { ok: false, reason: 'no-access-token' },
      loadGroupView,
      /**
       * ตอบกลับไม่ได้ก็อย่าเพิ่งเขียน — draft ที่ลงตารางแล้วแต่ไม่มีการ์ดให้กด
       * คือแถวที่ไม่มีใครเข้าถึงได้จนกว่าจะหมดอายุ และ retry จะสร้างเพิ่มอีกใบ
       * ทุกรอบ · โยนตรงนี้ทำให้ event นั้นนับเป็น `prepareFailed` แล้วได้ 500
       * ซึ่งเป็นคำตอบที่ถูก: ยังไม่มีอะไรถูกเขียน การ retry หลังตั้ง env จึงกู้ได้
       */
      saveDraft: async (input) => {
        if (!canReply) throw new Error('ไม่มี access token — ยังไม่เขียน draft')
        return (await createDraft(input)).id
      },
    },
  )

  /**
   * token หายแล้วตอบ 500 **เฉพาะตอนที่มีอะไรจะพูดจริงๆ**
   *
   * เช็คตั้งแต่ต้น request แล้วตอบ 500 ทุกครั้งจะทำให้ข้อความคุยกันธรรมดาในกลุ่ม
   * ซึ่งไม่ต้องการคำตอบอยู่แล้ว กลายเป็น 500 ไปด้วย · LINE retry ของพวกนั้นฟรีๆ
   * และถ้าพังต่อเนื่องจะปิด webhook endpoint ให้เอง = เปลี่ยนจาก "บอทตอบไม่ได้"
   * เป็น "บอทไม่ได้รับอะไรเลย" ซึ่งแย่กว่ากันมาก
   *
   * เส้นทางที่ต้องเขียน draft ถูกกันไว้ที่ `saveDraft` ข้างบนแล้ว — มันโยนก่อนแตะ
   * DB ตอนตอบกลับไม่ได้ · ที่เหลือที่มาถึงบรรทัดนี้จึงเป็นคำตอบที่ไม่เขียนอะไรเลย
   * (ไกด์ คำสั่งที่ยังไม่เปิด) ซึ่ง retry หลังตั้ง env กู้ได้ครบ (D36)
   */
  if (!canReply && result.replied > 0) {
    console.error('[webhook] LINE_CHANNEL_ACCESS_TOKEN ไม่ได้ตั้ง — มีของจะตอบแต่ตอบไม่ได้')
    return new Response('misconfigured', { status: 500 })
  }

  // จงใจไม่ log groupId/userId/replyToken — repo เป็น public และ log ไม่ควรสะสม
  // ข้อมูลส่วนบุคคลหรือของที่ยิงซ้ำได้ · retryKey เก็บไว้เพราะเป็นทางเดียวที่ตอบได้
  // ว่า LINE retry จริงไหม ส่วนสาเหตุที่ reply พังเป็นค่าคงที่ล้วน
  console.warn(
    `[webhook] status=${result.status} total=${result.totalMs.toFixed(1)}ms ` +
      `replied=${result.replied} retryKey=${result.retryKey ?? '-'}` +
      (result.prepareFailed > 0 ? ` prepareFailed=${result.prepareFailed}` : '') +
      (result.malformed ? ' malformed=true' : '') +
      (result.replyFailures.length > 0 ? ` replyFailed=${result.replyFailures.join(',')}` : ''),
  )

  return new Response(result.status === 200 ? 'ok' : 'no', {
    status: result.status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      // ตัวเลขล้วน ไม่มีข้อมูลใคร — ยังใช้ไล่ได้ว่าช้าที่เน็ตหรือที่ function
      'server-timing': `total;dur=${result.totalMs.toFixed(1)}`,
    },
  })
}

/**
 * LINE ยิง POST อย่างเดียว — GET มีไว้ให้คนเปิดในเบราว์เซอร์แล้วรู้ว่ามาถูกที่
 * ไม่แตะ DB ไม่บอกอะไรเกินนี้
 */
export function GET(): Response {
  return new Response('LINE webhook endpoint — POST only', {
    status: 405,
    headers: { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' },
  })
}
