/**
 * repository ของ `llm_usage` — วัตถุดิบของ Ceiling (D17)
 *
 * Ceiling คือเพดาน LLM call ต่อวัน ทั้งต่อคนและทั้งระบบ. ชนเพดานระดับระบบแล้ว
 * LLM ดับหมด เหลือแต่ rule parser — บริการยังไม่ตาย แต่บิลไม่บาน. rate limit
 * ต่อคนกันคนเดียวสแปม ส่วนเพดานรวมกัน 1,000 กลุ่มมาพร้อมกันตอนไวรัล ซึ่งเป็น
 * กรณีที่เราเป็นคนจ่ายบิล
 *
 * สองข้อที่โมดูลนี้มีอยู่เพื่อกัน:
 *
 * 1. **ขอบวันเป็นเวลาไทย ไม่ใช่ UTC** — UTC ตัดวันตอนตี 7 ของไทย เพดานจะรีเซ็ต
 *    กลางเช้าโดยไม่มีใครเข้าใจว่าทำไม
 * 2. **predicate ต้อง sargable** — เขียนขอบวันเป็น
 *    `date_trunc('day', created_at at time zone 'Asia/Bangkok') = ...` จะอ่านง่าย
 *    กว่า แต่ index `created_at` ใช้ไม่ได้เลย แล้ววันที่ตารางโตจะสแกนทั้งตาราง
 *    ทุก request — ซึ่งคือ request ที่อยู่บนเส้นทางร้อนของทุกข้อความที่เข้า LLM
 */

import { getPool, type Queryable } from '@/lib/db/client'
import { toLlmUsage, type LlmUsage, type LlmUsageRow } from '@/lib/db/rows'

export interface RecordLlmUsageInput {
  /** `null` = ยังไม่รู้ว่าใคร (คนที่ยังไม่ได้ claim member ของตัวเอง) */
  appUserId?: string | null
  groupId?: string | null
  inputTokens: number
  outputTokens: number
}

export interface UsageScope {
  appUserId?: string | null
  groupId?: string | null
}

export interface UsageTotals {
  calls: number
  inputTokens: number
  outputTokens: number
}

/**
 * export ไว้ให้เทสต์ `explain` ได้ว่ายังใช้ index `llm_usage_created_at_idx` อยู่
 * ไม่ได้ตั้งใจให้เรียกใช้ตรงๆ — ใช้ `usageSince` / `usageToday` แทน
 *
 * `$2`/`$3` เป็น `null` แปลว่าไม่กรองด้านนั้น: การเขียนแบบนี้ทำให้ query เดียว
 * รับใช้ทั้งเพดานรวม เพดานต่อคน และเพดานต่อวง โดยที่ `created_at >= $1` ยังเป็น
 * ตัวนำ index อยู่เสมอ
 */
export const USAGE_SINCE_SQL = `
  select count(*)::int                    as calls,
         coalesce(sum(input_tokens), 0)::int  as input_tokens,
         coalesce(sum(output_tokens), 0)::int as output_tokens
    from llm_usage
   where created_at >= $1
     and ($2::uuid is null or app_user_id = $2::uuid)
     and ($3::uuid is null or group_id = $3::uuid)
`

export async function recordLlmUsage(
  input: RecordLlmUsageInput,
  db: Queryable = getPool(),
): Promise<LlmUsage> {
  assertTokens(input.inputTokens, 'inputTokens')
  assertTokens(input.outputTokens, 'outputTokens')

  const { rows } = await db.query<LlmUsageRow>(
    `insert into llm_usage (app_user_id, group_id, input_tokens, output_tokens)
     values ($1::uuid, $2::uuid, $3, $4)
     returning id, app_user_id, group_id, input_tokens, output_tokens, created_at`,
    [input.appUserId ?? null, input.groupId ?? null, input.inputTokens, input.outputTokens],
  )
  const row = rows[0]
  if (!row) throw new Error('recordLlmUsage: insert ไม่คืนแถว')
  return toLlmUsage(row)
}

/**
 * เที่ยงคืนของ "วันนี้" ตามเวลาไทย เป็น `timestamptz`
 *
 * อ่านจากนาฬิกาของ DB ไม่ใช่ของ process: ตัวนับกับขอบวันต้องมาจากนาฬิกาเดียวกัน
 * ไม่งั้น server ที่เวลาเพี้ยนไปครึ่งชั่วโมงจะนับคร่อมวันโดยไม่มีใครเห็น
 *
 * ไทยไม่มี DST และอยู่ที่ UTC+7 มาตลอด แต่ใช้ชื่อโซนไม่ใช่ `+07` ตายตัว —
 * ถ้าวันหนึ่งต้องรองรับโซนอื่น ที่ที่ต้องแก้จะเป็นที่นี่ที่เดียว
 */
export async function thaiDayStart(db: Queryable = getPool()): Promise<Date> {
  const { rows } = await db.query<{ day_start: Date }>(
    `select (date_trunc('day', now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok')
              as day_start`,
  )
  const dayStart = rows[0]?.day_start
  if (!dayStart) throw new Error('thaiDayStart: query ไม่คืนแถว')
  return dayStart
}

/**
 * ยอดใช้งานตั้งแต่เวลาหนึ่งถึงตอนนี้ — ขอบล่างเป็นแบบรวม (`>=`)
 *
 * ใช้กับ rate limit รายคน: ส่ง `since` เป็น "ตอนนี้ลบหน้าต่างเวลา" แล้วเทียบ
 * `calls` กับเพดานของหน้าต่างนั้น
 */
export async function usageSince(
  since: Date,
  scope: UsageScope = {},
  db: Queryable = getPool(),
): Promise<UsageTotals> {
  const { rows } = await db.query<{
    calls: number
    input_tokens: number
    output_tokens: number
  }>(USAGE_SINCE_SQL, [since, scope.appUserId ?? null, scope.groupId ?? null])

  const row = rows[0]
  if (!row) throw new Error('usageSince: query ไม่คืนแถว')
  return {
    calls: row.calls,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
  }
}

/**
 * ยอดใช้งานของวันนี้ตามเวลาไทย — ไม่ส่ง scope มาคือยอดรวมทั้งระบบ
 *
 * สองคำสั่ง (หาขอบวัน แล้วค่อยนับ) ไม่ใช่คำสั่งเดียว เพราะขอบวันต้องเป็น
 * **พารามิเตอร์** ของคำสั่งที่นับ ไม่ใช่นิพจน์ที่คำนวณจากคอลัมน์ — นั่นคือสิ่ง
 * เดียวที่ทำให้ index `created_at` ยังใช้ได้ ราคาที่จ่ายคือ round trip เดียวที่
 * ไม่แตะตารางเลย
 */
export async function usageToday(
  scope: UsageScope = {},
  db: Queryable = getPool(),
): Promise<UsageTotals> {
  return usageSince(await thaiDayStart(db), scope, db)
}

// ─── ภายใน ────────────────────────────────────────────────────────────

/**
 * token เป็น `int` ใน DB และมาจากคำตอบของ API ภายนอก — ค่าที่ไม่ใช่ integer
 * หรือติดลบแปลว่าฝั่งบนอ่านคำตอบผิด ไม่ใช่ว่ามีคนใช้ติดลบจริง
 */
function assertTokens(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} ต้องเป็นจำนวน token แบบ integer ที่ไม่ติดลบ — ได้ ${value}`)
  }
}
