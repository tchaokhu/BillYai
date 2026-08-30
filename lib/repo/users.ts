/**
 * `app_user` — ตัวตนของคนหนึ่งคนที่ข้ามวง
 *
 * ใช้กับสามเรื่องเท่านั้น: Float, สรุปรายจ่ายส่วนตัว, พร้อมเพย์ (`CONTEXT.md`)
 * · PK เป็น uuid ไม่ใช่ `line_user_id` เพราะคนที่มาทางเว็บไม่มี LINE เลย (D22)
 *
 * **แถวนี้เกิดตอนกดยืนยันบิลใบแรกเท่านั้น** (D30) ไม่ใช่ตอนมีคนทักเข้ามา · ระบบนี้
 * ไม่มี hard delete ที่ไหนเลย แถวที่เกิดจากคนที่แค่ทักแล้วหายไปจะอยู่ตลอดกาล
 */

import { getPool, type Queryable } from '@/lib/db/client'
import { toAppUser, type AppUser, type AppUserRow } from '@/lib/db/rows'

function q(db?: Queryable): Queryable {
  return db ?? getPool()
}

const COLUMNS = `id, line_user_id, promptpay_cipher, promptpay_last4,
                 is_oa_friend, policy_accepted_at, created_at`

export async function findAppUserByLineUserId(
  lineUserId: string,
  db?: Queryable,
): Promise<AppUser | null> {
  const { rows } = await q(db).query<AppUserRow>(
    `select ${COLUMNS} from app_user where line_user_id = $1`,
    [lineUserId],
  )
  const row = rows[0]
  return row ? toAppUser(row) : null
}

/**
 * หา `app_user` ของ LINE user คนนี้ ไม่มีก็สร้าง
 *
 * เขียนเป็น statement เดียวด้วย `on conflict` แทนการอ่านก่อนเขียน เพราะ webhook
 * ของ LINE ยิงซ้ำและยิงพร้อมกันได้ — อ่านก่อนเขียนจะมีช่องให้สอง request เห็น
 * "ยังไม่มี" พร้อมกันแล้วแย่งกัน insert (เหตุผลเดียวกับ `ensureLineGroup`)
 *
 * `do update set line_user_id = excluded.line_user_id` เป็นการเขียนทับด้วยค่าเดิม
 * ซึ่งไม่เปลี่ยนอะไร แต่ทำให้ `returning` คืนแถวเสมอ ต่างจาก `do nothing` ที่คืน
 * ศูนย์แถวเมื่อชน
 */
export async function ensureAppUserByLineUserId(
  lineUserId: string,
  db?: Queryable,
): Promise<AppUser> {
  if (lineUserId.trim() === '') {
    throw new Error('users: lineUserId ว่างไม่ได้')
  }
  const { rows } = await q(db).query<AppUserRow>(
    `insert into app_user (line_user_id)
     values ($1)
     on conflict (line_user_id) do update set line_user_id = excluded.line_user_id
     returning ${COLUMNS}`,
    [lineUserId],
  )
  const row = rows[0]
  if (!row) throw new Error(`users: insert ไม่คืนแถวสำหรับ ${lineUserId}`)
  return toAppUser(row)
}
