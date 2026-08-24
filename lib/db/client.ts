/**
 * การต่อ Postgres ที่เดียวของทั้งโปรเจกต์ (D24)
 *
 * ห้าม agent แก้ไฟล์นี้ — repository ทุกตัวคอมไพล์กับสัญญาในนี้
 *
 * type parser ข้างล่างคือส่วนที่พลาดแล้วเจ็บโดยเงียบ อ่านคอมเมนต์ก่อนแก้
 */

import { Pool, types, type PoolClient, type QueryResultRow } from 'pg'

/**
 * รับได้ทั้ง Pool และ client ที่อยู่ใน transaction
 *
 * repository ที่เขียนหลายตารางต้องรับตัวนี้เข้ามา ห้ามไปหยิบจาก pool เอง
 * ไม่งั้นจะได้คนละ transaction กับที่ผู้เรียกเปิดไว้
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>
}

// ─── type parser ──────────────────────────────────────────────────────

/**
 * `bigint` (oid 20) — default ของ `pg` คืนเป็น **string** เพราะ int8 กว้างกว่า
 * `Number.MAX_SAFE_INTEGER` ถ้าปล่อยไว้ `amountSatang` จะเป็น `"120000"`
 * แล้ว `+` กลายเป็นต่อสตริงแทนบวก ซึ่งเป็นบั๊กเงินที่เทสต์ยูนิตจับไม่ได้
 *
 * เพดานที่ปลอดภัยคือ 9,007,199,254,740,991 สตางค์ ≈ 9 หมื่นล้านบาท
 * เกินกว่านั้นเราอยากให้พังดังๆ มากกว่าปัดเงียบ
 */
types.setTypeParser(types.builtins.INT8, (value: string): number => {
  const n = Number(value)
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`bigint ${value} เกินช่วงที่ JS number เก็บได้แบบไม่เพี้ยน`)
  }
  return n
})

/**
 * `date` (oid 1082) — default ของ `pg` แปลงเป็น `Date` ที่เที่ยงคืน **local time**
 * แปลว่า `spent_at` ของบิลจะเลื่อนไปวันก่อนหน้าทันทีที่ server อยู่คนละ timezone
 * กับคนจด. เก็บเป็น `'YYYY-MM-DD'` ตามที่ Postgres ส่งมาดิบๆ
 */
types.setTypeParser(types.builtins.DATE, (value: string): string => value)

/**
 * `numeric` (oid 1700) **ตั้งใจไม่ตั้ง parser** — ปล่อยเป็น string ให้ mapper
 * ของแต่ละตารางแปลงเอง. ในโปรเจกต์นี้ numeric มีแค่ `surcharge_pct` กับ `weight`
 * ซึ่งทั้งคู่ไม่ใช่เงิน (เงินเป็น bigint สตางค์เสมอ) การแปลงทั่วระบบจะทำให้
 * numeric ที่เพิ่มมาทีหลังกลายเป็น float โดยไม่มีใครสังเกต
 *
 * `timestamptz` ปล่อยตาม default (`Date`) ถูกอยู่แล้ว
 */

// ─── pool ─────────────────────────────────────────────────────────────

let pool: Pool | undefined

/**
 * สร้าง pool ครั้งแรกที่เรียก — ไม่ต่อตอน import เพื่อให้ไฟล์นี้ถูก import
 * จากที่ที่ไม่มี DB ได้โดยไม่พัง
 *
 * บน Vercel ต้องชี้ `DATABASE_URL` ไปที่ **Supavisor pooler** (พอร์ต 6543,
 * transaction mode) ไม่ใช่ direct connection พอร์ต 5432 และตั้ง `DB_POOL_MAX`
 * ให้เล็ก เพราะ serverless หนึ่ง instance ต่อหนึ่ง request
 */
export function getPool(): Pool {
  if (pool) return pool

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('ไม่ได้ตั้ง DATABASE_URL — ดู .env.local.example')
  }

  pool = new Pool({
    connectionString,
    max: Number(process.env.DB_POOL_MAX ?? 10),
  })
  return pool
}

/** ปิด pool — ใช้ตอนจบเทสต์ ไม่ใช้ใน request path */
export async function closePool(): Promise<void> {
  if (!pool) return
  const p = pool
  pool = undefined
  await p.end()
}

// ─── transaction ──────────────────────────────────────────────────────

/**
 * รัน `fn` ใน transaction เดียว — commit เมื่อสำเร็จ rollback เมื่อ throw
 *
 * client ถูกคืนเข้า pool ใน `finally` เสมอ แม้ตอน rollback พังเอง
 */
export async function withTransaction<T>(
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // connection พังไปแล้ว — rollback เกิดเองตอน client ถูกทิ้ง
      // กลืน error ตัวนี้เพื่อไม่ให้มันบัง error จริงที่ทำให้เข้ามาถึงตรงนี้
    }
    throw err
  } finally {
    client.release()
  }
}
