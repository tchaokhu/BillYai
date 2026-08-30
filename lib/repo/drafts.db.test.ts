/**
 * `expense_draft` — สถานะระหว่าง "การ์ดโผล่" กับ "คนกดยืนยัน" (ADR 0001)
 *
 * สามเรื่องที่ตารางนี้มีอยู่เพื่อรับประกัน และต้องมีเทสต์คุมทุกข้อ:
 *
 * 1. **กดยืนยันได้ครั้งเดียว** — commit คือ `delete draft` + `insert expense` ใน
 *    transaction เดียว การกดซ้ำจึงหา draft ไม่เจอแล้วไม่ทำอะไร
 * 2. **หมดอายุใน 24 ชั่วโมงนับจากตอนสร้าง** ไม่ผูกกับขอบวัน `Asia/Bangkok`
 * 3. **ไม่มี FK ไป `ledger_group`** — วงเกิดตอนกดยืนยัน ไม่ใช่ตอน draft (D30)
 */

import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { closePool, getPool, withTransaction } from '@/lib/db/client'
import { createDraft, deleteDraft, findDraft, sweepExpiredDrafts } from './drafts'
import type { DraftLine, ExpenseDraft } from '@/lib/types'

afterAll(async () => {
  await closePool()
})

const DRAFT: ExpenseDraft = {
  description: 'ข้าว',
  totalSatang: 120000,
  mode: 'equal',
  participants: [{ name: 'กอล์ฟ', weight: 1 }],
  includesPayer: false,
  surchargePct: 0,
}

/** ผลหารที่คำนวณเสร็จแล้ว — เก็บคู่กับ draft เพื่อให้ยอดบนการ์ดกับ ledger ตรงกัน */
const LINES: DraftLine[] = [{ name: 'กอล์ฟ', amountSatang: 120000, isNew: true, isPayer: false }]

/** id ปลอมที่ไม่มีวันชนของจริง — repo เป็น public ห้ามมี id จริง */
function fakeLineGroupId(): string {
  return `C-test-${randomUUID()}`
}

function fakeLineUserId(): string {
  return `U-test-${randomUUID()}`
}

function input(overrides: Partial<Parameters<typeof createDraft>[0]> = {}) {
  return {
    lineGroupId: fakeLineGroupId(),
    lineUserId: fakeLineUserId(),
    draft: DRAFT,
    lines: LINES,
    spentAt: '2026-08-30',
    ...overrides,
  }
}

async function countDrafts(): Promise<number> {
  const result = await getPool().query<{ n: number }>(
    `select count(*)::int as n from expense_draft`,
  )
  return result.rows[0]?.n ?? -1
}

/** ดันอายุแถวให้แก่ขึ้นโดยไม่ต้องรอจริง */
async function ageDraft(id: string, hours: number): Promise<void> {
  await getPool().query(
    `update expense_draft set created_at = now() - ($2 || ' hours')::interval where id = $1`,
    [id, String(hours)],
  )
}

describe('createDraft', () => {
  it('เขียนแล้วอ่านกลับได้เหมือนเดิมทุกฟิลด์', async () => {
    const created = await createDraft(input())
    const found = await findDraft(created.id)

    expect(found).not.toBeNull()
    expect(found?.id).toBe(created.id)
    expect(found?.lineGroupId).toBe(created.lineGroupId)
    expect(found?.lineUserId).toBe(created.lineUserId)
    expect(found?.spentAt).toBe('2026-08-30')
    expect(found?.draft).toEqual(DRAFT)
    expect(found?.lines).toEqual(LINES)
  })

  it('draft ของแชท 1:1 ไม่มี `lineGroupId`', async () => {
    const created = await createDraft(input({ lineGroupId: null }))
    expect(created.lineGroupId).toBeNull()
    expect((await findDraft(created.id))?.lineGroupId).toBeNull()
  })

  it('**ไม่สร้างวงให้** — วงเกิดตอนกดยืนยันเท่านั้น (D30)', async () => {
    const lineGroupId = fakeLineGroupId()
    await createDraft(input({ lineGroupId }))

    const groups = await getPool().query(
      `select count(*)::int as n from ledger_group where line_group_id = $1`,
      [lineGroupId],
    )
    expect(groups.rows[0]?.n).toBe(0)
  })

  it('`eventTag` เดินทางไปกลับได้', async () => {
    const tagged = { ...DRAFT, eventTag: 'เชียงใหม่' }
    const created = await createDraft(input({ draft: tagged }))
    expect((await findDraft(created.id))?.draft).toEqual(tagged)
  })

  it('`spentAt` ต้องเป็น `YYYY-MM-DD` ที่มีอยู่จริง', async () => {
    await expect(createDraft(input({ spentAt: '2026-8-30' }))).rejects.toThrow()
    await expect(createDraft(input({ spentAt: '2026-02-30' }))).rejects.toThrow()
  })

  it('payload ที่ไม่ผ่านสัญญาต้องไม่ถูกเขียนลงไปตั้งแต่แรก', async () => {
    // throw อย่างเดียวไม่พอ — ถ้าตรวจตอนอ่านกลับแทนที่จะตรวจก่อนเขียน แถวเสีย
    // จะนอนอยู่ในตารางไปอีก 24 ชั่วโมงโดยไม่มีใครรู้
    const before = await countDrafts()
    const broken = { ...DRAFT, totalSatang: 0 }
    await expect(createDraft(input({ draft: broken }))).rejects.toThrow()
    expect(await countDrafts()).toBe(before)
  })

  it('`lineUserId` ว่างไม่ได้ — D26 ต้องรู้ว่าใครพิมพ์', async () => {
    await expect(createDraft(input({ lineUserId: '   ' }))).rejects.toThrow()
  })

  it('รันใน transaction ที่ผู้เรียกเปิดไว้ได้', async () => {
    let id = ''
    await expect(
      withTransaction(async (tx) => {
        const created = await createDraft(input(), tx)
        id = created.id
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')

    expect(await findDraft(id)).toBeNull()
  })
})

describe('อายุ 24 ชั่วโมง', () => {
  it('23 ชั่วโมงยังอ่านได้ 25 ชั่วโมงอ่านไม่ได้', async () => {
    const young = await createDraft(input())
    const old = await createDraft(input())
    await ageDraft(young.id, 23)
    await ageDraft(old.id, 25)

    expect(await findDraft(young.id)).not.toBeNull()
    expect(await findDraft(old.id)).toBeNull()
  })

  it('นับจากเวลาสร้าง ไม่ผูกกับขอบวันไทย', async () => {
    // บิลมื้อดึกที่สร้างตอน 23:50 ต้องไม่เหลืออายุ 10 นาทีเพราะข้ามเที่ยงคืน
    const created = await createDraft(input())
    await ageDraft(created.id, 12)
    expect(await findDraft(created.id)).not.toBeNull()
  })

  it('ของหมดอายุยังอยู่ในตารางจนกว่าจะมีใครกวาด', async () => {
    const old = await createDraft(input())
    await ageDraft(old.id, 30)

    const still = await getPool().query(`select count(*)::int as n from expense_draft where id = $1`, [
      old.id,
    ])
    expect(still.rows[0]?.n).toBe(1)
  })
})

describe('เก็บกวาดตอนเขียน ไม่ใช่ด้วย cron (D7)', () => {
  it('สร้าง draft ใหม่แล้วของหมดอายุหายไปด้วย', async () => {
    const old = await createDraft(input())
    await ageDraft(old.id, 25)

    await createDraft(input())

    expect(await findDraft(old.id)).toBeNull()
    const gone = await getPool().query(`select count(*)::int as n from expense_draft where id = $1`, [
      old.id,
    ])
    expect(gone.rows[0]?.n).toBe(0)
  })

  it('ไม่แตะของที่ยังไม่หมดอายุของใครเลย', async () => {
    const young = await createDraft(input())
    await ageDraft(young.id, 23)

    await createDraft(input())

    expect(await findDraft(young.id)).not.toBeNull()
  })

  it('`sweepExpiredDrafts` คืนจำนวนที่ลบ', async () => {
    const old = await createDraft(input())
    await ageDraft(old.id, 48)
    expect(await sweepExpiredDrafts()).toBeGreaterThanOrEqual(1)
    expect(await findDraft(old.id)).toBeNull()
  })
})

describe('deleteDraft — กดยืนยันได้ครั้งเดียว', () => {
  it('ครั้งแรกลบได้ ครั้งที่สองไม่เจอ', async () => {
    const created = await createDraft(input())
    expect(await deleteDraft(created.id)).toBe(true)
    expect(await deleteDraft(created.id)).toBe(false)
    expect(await findDraft(created.id)).toBeNull()
  })

  it('id ที่ไม่มีอยู่จริงคืน false ไม่ throw', async () => {
    expect(await deleteDraft(randomUUID())).toBe(false)
  })

  it('ลบของหมดอายุได้ — คนกดการ์ดเก่าต้องไม่ทิ้งแถวค้างไว้', async () => {
    // ไม่ assert ค่าที่ `deleteDraft` คืน เพราะการกวาดของหมดอายุทำทั้งตาราง ไฟล์อื่น
    // ที่รันขนานกันอาจกวาดแถวนี้ไปก่อนแล้ว · สิ่งที่ต้องจริงคือ "แถวไม่เหลือ"
    const old = await createDraft(input())
    await ageDraft(old.id, 30)
    await deleteDraft(old.id)

    const { rows } = await getPool().query<{ n: number }>(
      `select count(*)::int as n from expense_draft where id = $1`,
      [old.id],
    )
    expect(rows[0]?.n).toBe(0)
  })
})

describe('findDraft', () => {
  it('id ที่ไม่มีอยู่จริงคืน null', async () => {
    expect(await findDraft(randomUUID())).toBeNull()
  })

  it('payload ที่อ่านไม่ออกคืน null ไม่ throw — ปฏิบัติเหมือนการ์ดหมดอายุ', async () => {
    // payload ที่เขียนด้วยโค้ดเวอร์ชันก่อนหน้ายังนอนอยู่ได้ถึง 24 ชม. หลัง deploy
    const created = await createDraft(input())
    await getPool().query(`update expense_draft set payload = $2::jsonb where id = $1`, [
      created.id,
      JSON.stringify({ description: 'ข้าว' }),
    ])
    expect(await findDraft(created.id)).toBeNull()
  })
})
