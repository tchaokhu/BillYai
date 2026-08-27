/**
 * `/api/line/webhook` — ปลายทางที่ตั้งไว้ใน LINE Developers Console
 *
 * ไฟล์นี้เป็น**สายไฟอย่างเดียว**: อ่าน env, อ่าน header, เรียก `handleLineWebhook`,
 * แปลงผลเป็น HTTP · ตรรกะทั้งหมดอยู่ใน `lib/line/webhook.ts` ซึ่งเทสต์ได้โดยไม่ต้อง
 * มี Next.js และไม่ต้องมี DB
 *
 * รอบ M3 ทำแค่เส้นทางของ S4 (verify → แตะ DB หนึ่งครั้ง → 200) ยังไม่จดบิล
 */

import { readChannelSecret } from '@/lib/line/env'
import { handleLineWebhook } from '@/lib/line/webhook'
import { findGroupByLineGroupId } from '@/lib/repo/groups'

/** `pg` ต่อ TCP — edge runtime ทำไม่ได้ ต้องเป็น node เท่านั้น (D24) */
export const runtime = 'nodejs'

/** ทุก request ต้องวิ่งจริง ห้ามให้ Next แคชคำตอบของ webhook */
export const dynamic = 'force-dynamic'

/**
 * region ตั้งที่ `vercel.json` (`sin1`) ไม่ใช่ที่ไฟล์นี้ — `preferredRegion` ของ
 * route segment ถูก deprecate ใน Next 16 แล้ว
 *
 * S4 บันทึกไว้เองว่า region สำคัญกว่า cold start — default ของ Vercel ไม่ใช่สิงคโปร์
 * ผู้ใช้อยู่ไทย และ Supabase ที่จะสร้างก็ต้องอยู่ `ap-southeast-1` ให้ตรงกัน
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
    { probeGroup: (lineGroupId) => findGroupByLineGroupId(lineGroupId) },
  )

  // S4 ถามว่า LINE retry จริงไหม ตอบได้จาก retryKey ที่ซ้ำใน log เท่านั้น
  // จงใจไม่ log groupId/userId — log ของ spike ไม่ควรสะสมข้อมูลส่วนบุคคล
  console.info(
    `[webhook] status=${result.status} db=${result.dbMs?.toFixed(1) ?? '-'}ms ` +
      `total=${result.totalMs.toFixed(1)}ms retryKey=${result.retryKey ?? '-'}` +
      (result.malformed ? ' malformed=true' : ''),
  )

  return new Response(result.status === 200 ? 'ok' : 'no', {
    status: result.status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      // ตัวเลขล้วน ไม่มีข้อมูลใคร — ให้ S4 แยกได้ว่าช้าที่เน็ต ที่ function หรือที่ DB
      'server-timing': [
        result.dbMs === null ? null : `db;dur=${result.dbMs.toFixed(1)}`,
        `total;dur=${result.totalMs.toFixed(1)}`,
      ]
        .filter((part): part is string => part !== null)
        .join(', '),
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
