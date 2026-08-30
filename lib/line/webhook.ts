/**
 * ตัวจัดการ webhook ของ LINE ที่**ไม่รู้จัก Next.js** — รับสตริงกับฟังก์ชัน คืน object
 *
 * ขอบเขตรอบ M5: verify signature → อ่าน event → ตัดสินว่าจะตอบอะไร → อ่าน Roster
 * → เขียน draft → ตอบการ์ดกลับ · **ปุ่มยืนยันยังไม่ทำงาน** นั่นคือ M6
 *
 * ทั้ง reply และงาน DB ฉีดเข้ามาเป็น dependency ไม่ import ของจริงตรงๆ เพื่อให้
 * เทสต์ยูนิตรันได้โดยไม่ยิงเน็ต ไม่ต้องมี Docker และไม่ต้องมี env จริง
 */

import type { ReplyOutcome } from './client'
import { parseLineEvents, type LineEvent } from './events'
import { draftCardMessage, type IdentityChoice } from './flex'
import { verifyLineSignature } from './signature'
import { stripMentions } from './mention'
import { renderReply, type LineMessage } from './messages'
import { buildDraft } from '../flow/draft'
import { decideReply, type Surface } from '../flow/dispatch'
import { parseAddressedMessage, parseMessage } from '../parser/rules'
import { bangkokDate } from '../time'
import type { DraftLine, ExpenseDraft } from '../types'

export interface LineWebhookRequest {
  /** ไบต์ที่มาจริง ยังไม่ผ่าน JSON.parse — ลายเซ็นคิดจากตัวนี้ */
  rawBody: string
  /** header `x-line-signature` */
  signature: string | null | undefined
  channelSecret: string
  /** header `x-line-retry-key` — LINE ส่งค่าเดิมซ้ำเมื่อ retry ชุดเดิม */
  retryKey?: string | null
}

export interface SaveDraftInput {
  /** `null` = แชท 1:1 */
  lineGroupId: string | null
  lineUserId: string
  draft: ExpenseDraft
  /** ผลหารที่คำนวณเสร็จแล้ว — ตัวเลขชุดเดียวกับที่คนเห็นบนการ์ด */
  lines: readonly DraftLine[]
  /** `'YYYY-MM-DD'` เวลาไทย แช่ไว้ตั้งแต่ตอนนี้ (D35) */
  spentAt: string
}

/**
 * ทุกอย่างที่ต้องรู้เกี่ยวกับวงเพื่อวาดการ์ดหนึ่งใบ — **อ่านอย่างเดียว** (D28)
 *
 * รวมเป็นก้อนเดียวเพราะทั้งสามค่ามาจาก query ชุดเดียวกัน และแยกเรียกจะกลายเป็น
 * round trip สองรอบบนเส้นทางร้อนของทุกบิล
 */
export interface GroupView {
  /** ชื่อ Member ทุกคนที่วงรู้จัก ณ ตอนนี้ */
  roster: readonly string[]
  /** ชื่อ Member ของคนพิมพ์ · `null` = เขายังไม่เคยยืนยันตัวตนในวงนี้ (D29) */
  payerName: string | null
  /** Member ที่ยังไม่มีเจ้าของ — ตัวเลือกตอนถามตัวตน (ADR 0002) */
  unclaimed: readonly IdentityChoice[]
}

/** ผลของการกดยืนยัน — ตรงกับ `ConfirmDraftResult` ของ `lib/repo/confirm.ts` */
export type ConfirmOutcome =
  | { kind: 'committed'; description: string; totalSatang: number }
  | { kind: 'gone' }
  | { kind: 'not-yours' }
  | { kind: 'name-taken'; name: string }
  | { kind: 'needs-identity' }

export interface LineWebhookDeps {
  reply: (replyToken: string, messages: readonly LineMessage[]) => Promise<ReplyOutcome>
  loadGroupView: (lineGroupId: string | null, lineUserId: string) => Promise<GroupView>
  /** คืน id ของ draft ที่เพิ่งเขียน — ใช้เป็น postback data */
  saveDraft: (input: SaveDraftInput) => Promise<string>
  /** ยืนยันบิล — transaction เดียวที่แตะเงิน (M6) */
  confirmDraft: (input: {
    draftId: string
    lineUserId: string
    payer?: { kind: 'member'; memberId: string } | { kind: 'new'; displayName: string }
  }) => Promise<ConfirmOutcome>
  /** ชื่อที่คนตั้งไว้ใน LINE — `null` = ดึงไม่ได้ ห้ามเดาแทน */
  fetchDisplayName: (lineGroupId: string | null, lineUserId: string) => Promise<string | null>
  /** นาฬิกาหน่วย ms — แยกออกมาเพื่อให้เทสต์กำหนดค่าได้ */
  now?: () => number
}

export interface LineWebhookResult {
  status: 200 | 401 | 500
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
  /**
   * จำนวน event ที่เตรียมคำตอบไม่สำเร็จ (DB ล่ม) — ผู้เรียกเป็นคน log
   *
   * มากกว่าศูนย์เมื่อไหร่ status เป็น 500 เสมอ · แยกออกมาเพื่อให้ log บอกได้ว่า
   * 500 มาจาก DB ไม่ใช่จากอย่างอื่น
   */
  prepareFailed: number
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
async function messagesFor(event: LineEvent, deps: LineWebhookDeps): Promise<LineMessage[]> {
  if (event.kind === 'postback') return messagesForPostback(event, deps)

  const { text, mentionsBot } = stripMentions(event.text, event.mentionees)
  const parsed = mentionsBot ? parseAddressedMessage(text) : parseMessage(text)
  const plan = decideReply({ surface: surfaceOf(event), addressed: mentionsBot }, parsed)
  if (plan.kind !== 'draft') return renderReply(plan)

  const lineGroupId = event.source.kind === 'group' ? event.source.lineGroupId : null
  const lineUserId = event.source.lineUserId
  if (lineUserId === null) {
    // LINE ไม่ส่ง `userId` มาให้เมื่อคนพิมพ์ยังไม่ยอมรับข้อตกลงการใช้งานบัญชีทางการ
    // · D26 ให้เฉพาะคนพิมพ์กดยืนยันได้ ซึ่งเช็คไม่ได้เลยถ้าไม่รู้ว่าใครพิมพ์
    return renderReply({ kind: 'unknown-sender' })
  }

  // **อ่าน Roster ตอน draft ไม่เขียน** (D28) — ชื่อที่วงยังไม่รู้จักติดป้าย (ใหม่)
  const view = await deps.loadGroupView(lineGroupId, lineUserId)
  const outcome = buildDraft(plan.draft, view.roster, view.payerName)
  if (outcome.kind === 'need-names') return renderReply({ kind: 'need-names' })

  const draftId = await deps.saveDraft({
    lineGroupId,
    lineUserId,
    draft: plan.draft,
    lines: outcome.card.lines,
    spentAt: bangkokDate(event.timestamp),
  })
  // ยังไม่รู้ว่าเขาคือใคร = การ์ดมีแถวเลือกตัวตนแทนปุ่มยืนยัน (D29 / ADR 0002)
  return [draftCardMessage(outcome.card, draftId, view.payerName === null ? view.unclaimed : null)]
}

/**
 * `confirm=<draftId>` หรือ `confirm=<draftId>&as=<memberId|new>`
 *
 * ยาวคงที่และไม่มีชื่อคนอยู่ในนั้น — ชื่อไทยที่ผ่าน `encodeURIComponent` ยาวขึ้น
 * เก้าเท่าแล้วทะลุเพดาน 300 ตัวอักษรของ postback data (ADR 0001)
 */
function parseConfirmData(
  data: string,
): { draftId: string; as: string | null } | null {
  const params = new URLSearchParams(data)
  const draftId = params.get('confirm')
  if (draftId === null || draftId === '') return null
  const as = params.get('as')
  return { draftId, as: as === null || as === '' ? null : as }
}

async function messagesForPostback(
  event: LineEvent & { kind: 'postback' },
  deps: LineWebhookDeps,
): Promise<LineMessage[]> {
  const parsed = parseConfirmData(event.data)
  // postback ที่ไม่ใช่ของเรา — เงียบ ไม่เดาว่าเป็นอะไร
  if (parsed === null) return []

  const lineUserId = event.source.lineUserId
  if (lineUserId === null) return renderReply({ kind: 'unknown-sender' })

  const lineGroupId = event.source.kind === 'group' ? event.source.lineGroupId : null

  /**
   * `ฉันเป็นคนใหม่` ยิงสองรอบโดยตั้งใจ
   *
   * รอบแรกไม่มีตัวตนแนบไป ทำหน้าที่เป็นด่านตรวจว่าใครกด (D26) และการ์ดยังใช้ได้ไหม
   * — ทั้งสองอย่างตอบได้จากแถว draft อย่างเดียว และรอบนี้ยังไม่ลบอะไรเลย · ดึงชื่อ
   * จาก LINE ก่อนแล้วค่อยตรวจ แปลว่าใครก็ได้ในกลุ่มกดการ์ดของคนอื่นแล้วเผา API call
   * กับเวลาของ reply token ทิ้งได้ฟรีๆ ทั้งที่คำตอบสุดท้ายคือความเงียบ
   *
   * รอบที่สองเกิดเฉพาะตอนระบบยืนยันแล้วว่าเขาคือคนพิมพ์และยังไม่รู้ว่าเขาคือใคร
   */
  let outcome = await deps.confirmDraft({
    draftId: parsed.draftId,
    lineUserId,
    ...(parsed.as === null || parsed.as === 'new'
      ? {}
      : { payer: { kind: 'member' as const, memberId: parsed.as } }),
  })

  if (outcome.kind === 'needs-identity' && parsed.as === 'new') {
    // ดึงชื่อ**นอก transaction** — เรียก API ของ LINE ระหว่างถือ lock อยู่คือการผูก
    // อายุ transaction ไว้กับความเร็วของเน็ตคนอื่น
    const displayName = await deps.fetchDisplayName(lineGroupId, lineUserId)
    if (displayName === null) return renderReply({ kind: 'no-display-name' })
    outcome = await deps.confirmDraft({
      draftId: parsed.draftId,
      lineUserId,
      payer: { kind: 'new', displayName },
    })
  }

  switch (outcome.kind) {
    case 'committed':
      return renderReply({
        kind: 'committed',
        description: outcome.description,
        totalSatang: outcome.totalSatang,
      })
    case 'gone':
      return renderReply({ kind: 'draft-gone' })
    case 'not-yours':
      // **เงียบ** ไม่ตอบว่า "ไม่มีสิทธิ์" — การประกาศแบบนั้นในกลุ่มเพื่อนคือการ
      // ทำให้เสียหน้าโดยไม่จำเป็น (D26)
      return []
    case 'name-taken':
      return renderReply({ kind: 'name-taken', name: outcome.name })
    case 'needs-identity':
      return renderReply({ kind: 'needs-identity' })
  }
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
    extra: {
      malformed?: boolean
      replied?: number
      replyFailures?: string[]
      prepareFailed?: number
    } = {},
  ): LineWebhookResult => ({
    status,
    totalMs: now() - startedAt,
    malformed: extra.malformed ?? false,
    retryKey,
    replied: extra.replied ?? 0,
    replyFailures: extra.replyFailures ?? [],
    prepareFailed: extra.prepareFailed ?? 0,
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
   * เตรียมคำตอบของทุก event ก่อน แล้วค่อยส่ง — แต่ **event ที่เตรียมสำเร็จต้องได้
   * รับคำตอบเสมอ ต่อให้เพื่อนร่วมชุดจะพัง**
   *
   * `allSettled` ไม่ใช่ `all` เพราะการทิ้งทั้งชุดทำให้เกิดของที่แย่กว่าเดิม: บิลที่
   * `saveDraft` สำเร็จไปแล้วจะมีแถวอยู่ใน DB โดยไม่มีการ์ดให้ใครกด แถวนั้นกู้ไม่ได้
   * เลยจนกว่าจะหมดอายุ 24 ชั่วโมง · ส่วนราคาของการส่ง คือ retry จะทำให้การ์ดใบนั้น
   * โผล่ซ้ำอีกครั้ง ซึ่ง ADR 0001 รับไว้แล้วว่าเป็นแค่ความรำคาญ
   *
   * ชุดที่มี event พังอย่างน้อยหนึ่งอันตอบ 500 เพื่อให้ LINE ส่งมาใหม่ — อันที่พัง
   * ยังไม่มีอะไรถูกเขียน การ retry จึงยังกู้บิลที่คนพิมพ์กลับมาได้ (D36)
   */
  const settled = await Promise.allSettled(
    parseLineEvents(payload).map(async (event) => ({
      event,
      messages: await messagesFor(event, deps),
    })),
  )
  const prepared = settled.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  )
  const prepareFailed = settled.length - prepared.length

  /**
   * ยิงขนาน ไม่ใช่ทีละอัน — แต่ละ event มี `replyToken` ของตัวเองและไม่มีลำดับ
   * ที่ต้องรักษา · ต่อคิวกันแปลว่า timeout หนึ่งครั้งกิน 3 วินาทีของทุก event
   * ที่รอข้างหลัง ชุดละ 5 event = 15 วินาที ซึ่งเลยเพดานเวลาของ function และ
   * นานพอที่ reply token ของอันหลังๆ จะหมดอายุก่อนถูกใช้
   */
  const sent = await Promise.all(
    prepared
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

  // reply ที่ยิงไม่ออกตอบ 200 ตามเกณฑ์ "เขียนลงไปแล้วหรือยัง" (D36) — retry ช่วย
  // อะไรไม่ได้แล้วเมื่อ draft ลงตารางไปเรียบร้อย
  return done(prepareFailed > 0 ? 500 : 200, { malformed, replied, replyFailures, prepareFailed })
}
