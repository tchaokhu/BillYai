/**
 * โมดูล F — llm_usage
 *
 * ตารางนี้มีอยู่เพื่อบังคับ Ceiling (D17) — เพดาน LLM call ต่อวัน ทั้งต่อคนและ
 * ทั้งระบบ. สองเรื่องที่พลาดแล้วเจ็บ:
 *
 * 1. **ขอบวันต้องเป็นเวลาไทย ไม่ใช่ UTC** — UTC ตัดวันตอนตี 7 ของไทย เพดานจะ
 *    รีเซ็ตกลางเช้าโดยไม่มีใครเข้าใจว่าทำไม
 * 2. **query ต้องยังใช้ index `created_at` ได้** — เขียนเป็น
 *    `date_trunc('day', created_at at time zone ...) = ...` จะอ่านง่ายกว่าแต่
 *    ทำให้ predicate ใช้ index ไม่ได้ แล้ววันที่ตารางโตจะสแกนทั้งตารางทุก request
 *
 * ตารางนี้ไม่มี group scope ให้แยกเทสต์ได้เหมือนตารางอื่น เทสต์ที่นับยอดรวม
 * ทั้งระบบจึงวัด **ส่วนต่างจากค่าตั้งต้น** ไม่ใช่ค่าสัมบูรณ์ — ห้าม TRUNCATE
 */

import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { closePool, getPool, withTransaction } from '@/lib/db/client'
import { makeAppUser, makeGroup } from '@/lib/db/fixtures'
import {
  USAGE_SINCE_SQL,
  recordLlmUsage,
  thaiDayStart,
  usageSince,
  usageToday,
} from '@/lib/repo/llm'

afterAll(closePool)


/**
 * เที่ยงคืนไทยของวันนี้ **คำนวณเองใน TS** ไม่ได้เรียก `thaiDayStart` มาเทียบกับ
 * ตัวเอง — ใช้ tz database ของ Intl คนละชุดกับของ Postgres แล้วบวก `+07:00`
 * ตรงๆ (ไทยไม่มี DST และอยู่ที่ UTC+7 มาตลอด)
 */
function thaiMidnightIndependently(): Date {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
  return new Date(`${today}T00:00:00+07:00`)
}

/** แถวที่ต้องมี `created_at` เจาะจง — API จริงไม่รับเวลาเข้ามา และไม่ควรรับ */
async function usageAt(
  createdAt: Date,
  overrides: { appUserId?: string; groupId?: string; inputTokens?: number; outputTokens?: number } = {},
): Promise<void> {
  await getPool().query(
    `insert into llm_usage (app_user_id, group_id, input_tokens, output_tokens, created_at)
     values ($1::uuid, $2::uuid, $3, $4, $5)`,
    [
      overrides.appUserId ?? null,
      overrides.groupId ?? null,
      overrides.inputTokens ?? 100,
      overrides.outputTokens ?? 50,
      createdAt,
    ],
  )
}

describe('recordLlmUsage', () => {
  it('เขียนแล้วคืน record ที่ map เป็น camelCase', async () => {
    const user = await makeAppUser()
    const group = await makeGroup()

    const usage = await recordLlmUsage({
      appUserId: user.id,
      groupId: group.id,
      inputTokens: 1200,
      outputTokens: 340,
    })

    expect(usage.id).toBeGreaterThan(0)
    expect(usage.appUserId).toBe(user.id)
    expect(usage.groupId).toBe(group.id)
    expect(usage.inputTokens).toBe(1200)
    expect(usage.outputTokens).toBe(340)
    expect(usage.createdAt).toBeInstanceOf(Date)
  })

  it('ไม่รู้ว่าใครเรียกก็เขียนได้ — คนที่ยังไม่ claim ไม่มี app_user', async () => {
    const usage = await recordLlmUsage({ inputTokens: 10, outputTokens: 5 })
    expect(usage.appUserId).toBeNull()
    expect(usage.groupId).toBeNull()
  })

  it('token ที่ไม่ใช่ integer ไม่ติดลบ → throw', async () => {
    for (const tokens of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        recordLlmUsage({ inputTokens: tokens, outputTokens: 0 }),
      ).rejects.toThrow(/token/)
      await expect(
        recordLlmUsage({ inputTokens: 0, outputTokens: tokens }),
      ).rejects.toThrow(/token/)
    }
  })

  it('0 token เขียนได้ — call ที่ล้มกลางทางก็ยังนับเป็น call', async () => {
    const usage = await recordLlmUsage({ inputTokens: 0, outputTokens: 0 })
    expect(usage.inputTokens).toBe(0)
  })
})

describe('ขอบวันของ Ceiling เป็นเวลาไทย ไม่ใช่ UTC', () => {
  it('thaiDayStart ตรงกับเที่ยงคืนไทยที่คำนวณเองใน TS', async () => {
    const start = await thaiDayStart()
    expect(start.getTime()).toBe(thaiMidnightIndependently().getTime())

    // 07:00 UTC ของวันเดียวกันคือ 14:00 ไทย — ต้องอยู่หลังขอบเสมอ
    expect(start.getTime()).toBeLessThanOrEqual(Date.now())
    // ห่างจากตอนนี้ไม่เกิน 24 ชม.
    expect(Date.now() - start.getTime()).toBeLessThan(24 * 60 * 60 * 1000)

    const { rows } = await getPool().query<{ thai: string }>(
      `select to_char($1::timestamptz at time zone 'Asia/Bangkok', 'HH24:MI:SS') as thai`,
      [start],
    )
    expect(rows[0]?.thai).toBe('00:00:00')
  })

  /**
   * นี่คือเทสต์ที่แยก "ตัดวันแบบไทย" ออกจาก "ตัดวันแบบ UTC" จริงๆ:
   * 18:00 UTC ของเมื่อวานคือ 01:00 ของ **วันนี้** ตามเวลาไทย — ต้องนับ
   * ถ้าใครเผลอเขียนขอบเป็น UTC แถวนี้จะหายไปจากยอดทันที
   */
  it('แถวที่เป็นเมื่อวานตาม UTC แต่เป็นวันนี้ตามเวลาไทย → นับ', async () => {
    const user = await makeAppUser()
    const start = thaiMidnightIndependently()

    await usageAt(new Date(start.getTime() + 1000), { appUserId: user.id })
    await usageAt(new Date(start.getTime() + 3 * 60 * 60 * 1000), { appUserId: user.id })

    const today = await usageToday({ appUserId: user.id })
    expect(today.calls).toBe(2)

    // ยืนยันว่าแถวแรกอยู่ก่อนเที่ยงคืน UTC ของวันนี้จริง (ไม่งั้นเทสต์ไม่ได้พิสูจน์อะไร)
    const { rows } = await getPool().query<{ utc_date: string; thai_date: string }>(
      `select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as utc_date,
              to_char(created_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD') as thai_date
         from llm_usage where app_user_id = $1 order by created_at limit 1`,
      [user.id],
    )
    expect(rows[0]?.thai_date).toBe(
      (
        await getPool().query<{ d: string }>(
          `select to_char(now() at time zone 'Asia/Bangkok', 'YYYY-MM-DD') as d`,
        )
      ).rows[0]?.d,
    )
  })

  it('แถวก่อนเที่ยงคืนไทยหนึ่งวินาที → ไม่นับ', async () => {
    const user = await makeAppUser()
    const start = thaiMidnightIndependently()

    await usageAt(new Date(start.getTime() - 1000), { appUserId: user.id })
    await usageAt(new Date(start.getTime() + 1000), { appUserId: user.id })

    expect((await usageToday({ appUserId: user.id })).calls).toBe(1)
  })

  it('รวม token ของทั้งวัน ไม่ใช่แค่นับ call', async () => {
    const user = await makeAppUser()
    const start = thaiMidnightIndependently()

    await usageAt(new Date(start.getTime() + 1000), {
      appUserId: user.id,
      inputTokens: 1000,
      outputTokens: 200,
    })
    await usageAt(new Date(start.getTime() + 2000), {
      appUserId: user.id,
      inputTokens: 250,
      outputTokens: 75,
    })

    expect(await usageToday({ appUserId: user.id })).toEqual({
      calls: 2,
      inputTokens: 1250,
      outputTokens: 275,
    })
  })

  it('คนที่ยังไม่ได้ใช้วันนี้ได้ศูนย์ ไม่ใช่ null', async () => {
    const user = await makeAppUser()
    expect(await usageToday({ appUserId: user.id })).toEqual({
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
    })
  })
})

describe('Ceiling ระดับระบบกับระดับคน', () => {
  it('ยอดรวมทั้งระบบนับทุกคน — วัดเป็นส่วนต่างจากค่าตั้งต้น', async () => {
    const before = await usageToday()
    const start = thaiMidnightIndependently()
    const a = await makeAppUser()
    const b = await makeAppUser()

    await usageAt(new Date(start.getTime() + 1000), { appUserId: a.id, inputTokens: 10, outputTokens: 1 })
    await usageAt(new Date(start.getTime() + 2000), { appUserId: b.id, inputTokens: 20, outputTokens: 2 })
    await usageAt(new Date(start.getTime() + 3000), { inputTokens: 30, outputTokens: 3 })

    const after = await usageToday()
    expect(after.calls - before.calls).toBe(3)
    expect(after.inputTokens - before.inputTokens).toBe(60)
    expect(after.outputTokens - before.outputTokens).toBe(6)
  })

  it('ยอดต่อคนไม่ปนกัน', async () => {
    const start = thaiMidnightIndependently()
    const a = await makeAppUser()
    const b = await makeAppUser()

    await usageAt(new Date(start.getTime() + 1000), { appUserId: a.id })
    await usageAt(new Date(start.getTime() + 2000), { appUserId: a.id })
    await usageAt(new Date(start.getTime() + 3000), { appUserId: b.id })

    expect((await usageToday({ appUserId: a.id })).calls).toBe(2)
    expect((await usageToday({ appUserId: b.id })).calls).toBe(1)
  })

  it('ยอดต่อวงแยกจากยอดต่อคน', async () => {
    const start = thaiMidnightIndependently()
    const group = await makeGroup()
    const user = await makeAppUser()

    await usageAt(new Date(start.getTime() + 1000), { groupId: group.id, appUserId: user.id })
    await usageAt(new Date(start.getTime() + 2000), { groupId: group.id })

    expect((await usageToday({ groupId: group.id })).calls).toBe(2)
    expect((await usageToday({ appUserId: user.id })).calls).toBe(1)
  })

  it('app_user ที่ไม่มีอยู่จริงได้ศูนย์', async () => {
    expect((await usageToday({ appUserId: randomUUID() })).calls).toBe(0)
  })
})

describe('usageSince — หน้าต่างเวลาของ rate limit รายคน', () => {
  it('นับเฉพาะในหน้าต่าง', async () => {
    const user = await makeAppUser()
    const now = Date.now()

    await usageAt(new Date(now - 10 * 60 * 1000), { appUserId: user.id })
    await usageAt(new Date(now - 30 * 1000), { appUserId: user.id })
    await usageAt(new Date(now - 5 * 1000), { appUserId: user.id })

    const lastMinute = await usageSince(new Date(now - 60 * 1000), { appUserId: user.id })
    expect(lastMinute.calls).toBe(2)
  })

  it('ขอบล่างเป็นแบบรวม (>=) ไม่ใช่ตัดทิ้ง', async () => {
    const user = await makeAppUser()
    const edge = new Date(Date.now() - 60 * 1000)

    await usageAt(edge, { appUserId: user.id })

    expect((await usageSince(edge, { appUserId: user.id })).calls).toBe(1)
    expect((await usageSince(new Date(edge.getTime() + 1), { appUserId: user.id })).calls).toBe(0)
  })

  it('ใช้ client ที่ผู้เรียกส่งมา — เห็นแถวที่ยังไม่ commit', async () => {
    const user = await makeAppUser()

    await withTransaction(async tx => {
      await recordLlmUsage({ appUserId: user.id, inputTokens: 5, outputTokens: 5 }, tx)
      const inside = await usageSince(new Date(Date.now() - 60_000), { appUserId: user.id }, tx)
      expect(inside.calls).toBe(1)
      throw new Error('ล้ม transaction')
    }).catch((err: unknown) => {
      expect((err as Error).message).toBe('ล้ม transaction')
    })

    expect((await usageSince(new Date(Date.now() - 60_000), { appUserId: user.id })).calls).toBe(0)
  })
})

describe('query ของ Ceiling ต้องยังใช้ index created_at ได้', () => {
  /**
   * ตารางเทสต์เล็กเกินกว่าที่ planner จะเลือก index เอง — ปิด seq scan ชั่วคราว
   * แล้วดูว่า **เลือกได้ไหม** ซึ่งคือคุณสมบัติที่ต้องการจริง: predicate ยัง
   * sargable อยู่. ถ้าวันหนึ่งมีคนเขียนใหม่เป็น `date_trunc(created_at) = ...`
   * planner จะเลือก index ไม่ได้เลยแม้ปิด seq scan และเทสต์นี้จะแดง
   */
  it('planner เลือก llm_usage_created_at_idx ได้เมื่อปิด seq scan', async () => {
    const plan = await withTransaction(async tx => {
      await tx.query('set local enable_seqscan = off')
      const { rows } = await tx.query<{ 'QUERY PLAN': string }>(
        `explain ${USAGE_SINCE_SQL}`,
        [new Date(Date.now() - 60_000), null, null],
      )
      return rows.map(r => r['QUERY PLAN']).join('\n')
    })

    expect(plan).toContain('llm_usage_created_at_idx')
  })
})
