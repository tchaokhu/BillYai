/**
 * `app_user` — ตัวตนของคนหนึ่งคนที่ข้ามวง
 *
 * แถวนี้เกิดตอนกดยืนยันบิลใบแรกเท่านั้น (D30) ไม่ใช่ตอนมีคนทักเข้ามา · ระบบนี้
 * ไม่มี hard delete ที่ไหนเลย แถวที่เกิดจากคนที่แค่ทักแล้วหายไปจึงอยู่ตลอดกาล
 */

import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { closePool, getPool, withTransaction } from '@/lib/db/client'
import { ensureAppUserByLineUserId, findAppUserByLineUserId } from './users'

afterAll(async () => {
  await closePool()
})

/** id ปลอมที่ไม่มีวันชนของจริง — repo เป็น public ห้ามมี id จริง */
function fakeLineUserId(): string {
  return `U-test-${randomUUID()}`
}

describe('ensureAppUserByLineUserId', () => {
  it('ยังไม่มีก็สร้างให้', async () => {
    const lineUserId = fakeLineUserId()
    const user = await ensureAppUserByLineUserId(lineUserId)
    expect(user.lineUserId).toBe(lineUserId)
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('เรียกซ้ำได้แถวเดิม ไม่ใช่แถวใหม่', async () => {
    const lineUserId = fakeLineUserId()
    const first = await ensureAppUserByLineUserId(lineUserId)
    const second = await ensureAppUserByLineUserId(lineUserId)
    expect(second.id).toBe(first.id)

    const { rows } = await getPool().query<{ n: number }>(
      `select count(*)::int as n from app_user where line_user_id = $1`,
      [lineUserId],
    )
    expect(rows[0]?.n).toBe(1)
  })

  it('ยิงพร้อมกันสองครั้งต้องไม่ชนกันและได้แถวเดียว', async () => {
    // webhook ของ LINE ยิงซ้ำและยิงพร้อมกันได้ · อ่านก่อนเขียนจะมีช่องให้สอง
    // request เห็น "ยังไม่มี" พร้อมกันแล้วแย่งกัน insert
    const lineUserId = fakeLineUserId()
    const [a, b] = await Promise.all([
      ensureAppUserByLineUserId(lineUserId),
      ensureAppUserByLineUserId(lineUserId),
    ])
    expect(a?.id).toBe(b?.id)
  })

  it('รันใน transaction ที่ผู้เรียกเปิดไว้ได้', async () => {
    const lineUserId = fakeLineUserId()
    await expect(
      withTransaction(async (tx) => {
        await ensureAppUserByLineUserId(lineUserId, tx)
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')

    expect(await findAppUserByLineUserId(lineUserId)).toBeNull()
  })

  it('`lineUserId` ว่างไม่ได้', async () => {
    await expect(ensureAppUserByLineUserId('   ')).rejects.toThrow()
  })
})

describe('findAppUserByLineUserId', () => {
  it('ไม่มีคืน null', async () => {
    expect(await findAppUserByLineUserId(fakeLineUserId())).toBeNull()
  })

  it('มีแล้วคืนแถวเดิม', async () => {
    const lineUserId = fakeLineUserId()
    const created = await ensureAppUserByLineUserId(lineUserId)
    expect((await findAppUserByLineUserId(lineUserId))?.id).toBe(created.id)
  })
})
