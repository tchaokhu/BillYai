/**
 * ตัวจัดการ webhook ของ LINE ที่**ไม่รู้จัก Next.js** — รับสตริงกับฟังก์ชัน คืน object
 *
 * ขอบเขตรอบ M4: verify signature → อ่าน event → ตัดสินว่าจะตอบอะไร → ตอบกลับ
 * **ยังไม่แตะ DB เลยสักบรรทัด** การจดบิลเป็นของ M5/M6
 *
 * การยิง reply ฉีดเข้ามาเป็น dependency ไม่ import client ตรงๆ เพื่อให้เทสต์ยูนิต
 * รันได้โดยไม่ยิงเน็ตและไม่ต้องมี env จริง (กติกาเดิมตั้งแต่ M2)
 */

import type { ReplyOutcome } from './client'
import { parseLineEvents, type LineEvent } from './events'
import { verifyLineSignature } from './signature'
import { stripMentions } from './mention'
import { renderReply, type LineTextMessage } from './messages'
import { decideReply, type Surface } from '../flow/dispatch'
import { parseAddressedMessage, parseMessage } from '../parser/rules'

export interface LineWebhookRequest {
  /** ไบต์ที่มาจริง ยังไม่ผ่าน JSON.parse — ลายเซ็นคิดจากตัวนี้ */
  rawBody: string
  /** header `x-line-signature` */
  signature: string | null | undefined
  channelSecret: string
  /** header `x-line-retry-key` — LINE ส่งค่าเดิมซ้ำเมื่อ retry ชุดเดิม */
  retryKey?: string | null
}

export interface LineWebhookDeps {
  reply: (replyToken: string, messages: readonly LineTextMessage[]) => Promise<ReplyOutcome>
  /** นาฬิกาหน่วย ms — แยกออกมาเพื่อให้เทสต์กำหนดค่าได้ */
  now?: () => number
}

export interface LineWebhookResult {
  status: 200 | 401
  totalMs: number
  /** body ผ่านลายเซ็นแต่ parse ไม่ออก */
  malformed: boolean
  retryKey: string | null
  /** จำนวน event ที่เราพูดตอบไป (หรือพยายามพูด) */
  replied: number
  /**
   * สาเหตุที่ reply ไม่ออก เรียงตาม event — ผู้เรียกเป็นคน log
   *
   * ค่าคงที่ล้วน ไม่มี `replyToken` ไม่มี id ของใคร: repo เป็น public และ log
   * ไม่ควรสะสมของที่ยิงซ้ำได้ · แต่ต้องแยกสาเหตุให้ออก เพราะ `invalid-reply-token`
   * (เราช้าไป) กับ `unauthorized` (access token ผิด) แก้คนละทางกันคนละเรื่อง
   */
  replyFailures: string[]
}

/** วงส่วนตัวใน 1:1 กับวงกลุ่ม เป็นคนละ surface แต่ใช้โค้ดร่วมกันทั้งหมด (D21) */
function surfaceOf(event: LineEvent): Surface {
  return event.source.kind === 'group' ? 'group' : 'direct'
}

/**
 * `stripMentions` ตัดเฉพาะ mention ที่เรียกบอท — ของคนอื่นอยู่ในข้อความต่อไป
 * ไม่งั้น `@กอล์ฟ เลิก` จะเหลือ `เลิก` แล้วบอทโพล่งใส่บทสนทนาที่ไม่ได้พูดกับมัน
 *
 * `mentionsBot` ทำสองหน้าที่: เลือกทางเข้าของ parser และบอก `decideReply` ว่า
 * คนพูดกับเราอยู่ ซึ่งทำให้กฎเงียบไม่มีผลกับข้อความนั้น
 */
function messagesFor(event: LineEvent): LineTextMessage[] {
  if (event.kind !== 'text') {
    // postback มาจากการ์ดของเราเอง ซึ่งยังไม่มีในระบบจนถึง M6
    return []
  }

  const { text, mentionsBot } = stripMentions(event.text, event.mentionees)
  const parsed = mentionsBot ? parseAddressedMessage(text) : parseMessage(text)
  return renderReply(decideReply({ surface: surfaceOf(event), addressed: mentionsBot }, parsed))
}

export async function handleLineWebhook(
  req: LineWebhookRequest,
  deps: LineWebhookDeps,
): Promise<LineWebhookResult> {
  const now = deps.now ?? (() => performance.now())
  const startedAt = now()
  const retryKey = req.retryKey ?? null

  const done = (
    status: LineWebhookResult['status'],
    extra: { malformed?: boolean; replied?: number; replyFailures?: string[] } = {},
  ): LineWebhookResult => ({
    status,
    totalMs: now() - startedAt,
    malformed: extra.malformed ?? false,
    retryKey,
    replied: extra.replied ?? 0,
    replyFailures: extra.replyFailures ?? [],
  })

  // ด่านแรกเสมอ — ทุกบรรทัดหลังจากนี้ทำงานให้คนที่พิสูจน์ตัวแล้วเท่านั้น
  if (!verifyLineSignature(req.rawBody, req.signature, req.channelSecret)) {
    return done(401)
  }

  let payload: unknown
  let malformed = false
  try {
    payload = JSON.parse(req.rawBody)
  } catch {
    // ลายเซ็นผ่าน = body มาจาก LINE จริง ตอบ non-200 จะได้ body พังตัวเดิม
    // กลับมาซ้ำไม่รู้จบ · บันทึกไว้ว่าเพี้ยนแล้วปล่อยผ่าน
    payload = null
    malformed = true
  }

  /**
   * ยิงขนาน ไม่ใช่ทีละอัน — แต่ละ event มี `replyToken` ของตัวเองและไม่มีลำดับ
   * ที่ต้องรักษา · ต่อคิวกันแปลว่า timeout หนึ่งครั้งกิน 3 วินาทีของทุก event
   * ที่รอข้างหลัง ชุดละ 5 event = 15 วินาที ซึ่งเลยเพดานเวลาของ function และ
   * นานพอที่ reply token ของอันหลังๆ จะหมดอายุก่อนถูกใช้
   */
  const sent = await Promise.all(
    parseLineEvents(payload)
      .map((event) => ({ event, messages: messagesFor(event) }))
      .filter(({ messages }) => messages.length > 0)
      .map(async ({ event, messages }) => {
        try {
          const outcome = await deps.reply(event.replyToken, messages)
          return outcome.ok ? null : outcome.reason
        } catch {
          // reply ที่ throw ต้องไม่ทำให้ event ที่เหลือในชุดเดียวกันไม่ถูกตอบ
          return 'threw'
        }
      }),
  )

  const replied = sent.length
  const replyFailures = sent.filter((reason) => reason !== null)

  // **200 เสมอเมื่อผ่านลายเซ็น** (D36) — รอบนี้ไม่มีการเขียนอะไรลง DB เลย
  // จึงไม่มีความล้มเหลวแบบที่ retry แล้วผลจะต่าง · M5/M6 ที่เริ่มเขียนจริงต้อง
  // กลับมาตอบ 500 เมื่อพังก่อนเขียน ตามเกณฑ์ "เขียนลงไปแล้วหรือยัง"
  return done(200, { malformed, replied, replyFailures })
}
