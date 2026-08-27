/**
 * ตัวจัดการ webhook ของ LINE ที่**ไม่รู้จัก Next.js** — รับสตริงกับฟังก์ชัน คืน object
 *
 * ขอบเขตรอบ M3 คือเส้นทางที่ S4 สั่งไว้เท่านั้น: verify signature → แตะ DB หนึ่งครั้ง
 * → ตอบ 200 · **ยังไม่ parse event ยังไม่จด ยังไม่ตอบกลับกลุ่ม** นั่นคือ Phase 1
 *
 * DB probe รับเข้ามาเป็น dependency ไม่ได้ import repo ตรงๆ เพื่อให้เทสต์ยูนิต
 * รันได้โดยไม่ต้องมี Docker (กติกาเดิมตั้งแต่ M2)
 */

import { verifyLineSignature } from './signature'

/**
 * id ที่ใช้ถาม DB ตอนไม่มีกลุ่มให้ถาม
 *
 * `line_group_id` ของจริงจาก LINE ขึ้นต้นด้วย `C` เสมอ ค่านี้จึงไม่มีวันชนของจริง
 * และตั้งใจให้ query คืน 0 แถว — เราต้องการ **round trip** ไม่ใช่ข้อมูล
 *
 * ตอนทำ Phase 1 จริง การ probe ทิ้งแบบนี้ต้องหายไป แล้วแทนที่ด้วยการ resolve วง
 * จาก event จริง (D21: `source.type` เป็นตัวตัดสินอย่างเดียว)
 */
const PROBE_SENTINEL = '__probe__'

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
  /** อ่านวงจาก `line_group_id` — read-only เท่านั้นในรอบนี้ */
  probeGroup: (lineGroupId: string) => Promise<unknown>
  /** นาฬิกาหน่วย ms — แยกออกมาเพื่อให้เทสต์กำหนดค่าได้ */
  now?: () => number
}

export interface LineWebhookResult {
  status: 200 | 401 | 500
  /** เวลาที่ใช้กับ DB — `null` เมื่อไม่ได้แตะ DB เลย (ลายเซ็นไม่ผ่าน) */
  dbMs: number | null
  totalMs: number
  /** body ผ่านลายเซ็นแต่ parse ไม่ออก */
  malformed: boolean
  retryKey: string | null
}

/**
 * หา `groupId` ตัวแรกจากชุด event โดยไม่เชื่อรูปร่างอะไรเลย
 *
 * body ผ่านลายเซ็นแล้วก็จริง แต่ "มาจาก LINE" ไม่ได้แปลว่า "รูปร่างตรงกับที่เราจำ" —
 * LINE เพิ่ม event type ใหม่ได้ตลอด และ `source` ของ 1:1 กับ room ไม่มี `groupId`
 */
function firstGroupId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null

  const events = (payload as { events?: unknown }).events
  if (!Array.isArray(events)) return null

  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue
    const source = (event as { source?: unknown }).source
    if (typeof source !== 'object' || source === null) continue

    const { type, groupId } = source as { type?: unknown; groupId?: unknown }
    if (type === 'group' && typeof groupId === 'string' && groupId.length > 0) return groupId
  }

  return null
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
    dbMs: number | null,
    malformed = false,
  ): LineWebhookResult => ({ status, dbMs, totalMs: now() - startedAt, malformed, retryKey })

  // ด่านแรกเสมอ — ทุกบรรทัดหลังจากนี้ทำงานให้คนที่พิสูจน์ตัวแล้วเท่านั้น
  if (!verifyLineSignature(req.rawBody, req.signature, req.channelSecret)) {
    return done(401, null)
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

  const dbStartedAt = now()
  try {
    await deps.probeGroup(firstGroupId(payload) ?? PROBE_SENTINEL)
  } catch {
    // DB ล่มแล้วตอบ 200 = LINE ทิ้ง event นั้นถาวร บิลที่คนพิมพ์หายเงียบ
    // 500 ทำให้ LINE retry ซึ่งเป็นพฤติกรรมที่ถูกต้องตอนเราเป็นฝ่ายพัง
    return done(500, now() - dbStartedAt, malformed)
  }

  return done(200, now() - dbStartedAt, malformed)
}
