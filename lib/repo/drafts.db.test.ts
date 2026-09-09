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
import {
  createDraft,
  deleteDraft,
  findDraft,
  findDraftInScope,
  sweepExpiredDrafts,
  updateDraft,
} from './drafts'
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
  adjustmentSatang: 0,
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

/**
 * นับ draft **ของคนคนเดียว** ไม่ใช่ทั้งตาราง
 *
 * นับทั้งตารางจะ racy ทันทีที่มีไฟล์เทสต์อื่นสร้าง draft ขนานกันอยู่ — ซึ่งเกิดจริง
 * ตั้งแต่ `views.db.test.ts` เดินเส้นทางจดบิลเต็มเส้น · `line_user_id` ที่สุ่มใหม่
 * ทุกเทสต์ทำให้ตัวเลขเป็นของเทสต์นั้นคนเดียว ไม่ว่าใครจะรันอะไรอยู่ข้างๆ
 */
async function countDraftsFor(lineUserId: string): Promise<number> {
  const result = await getPool().query<{ n: number }>(
    `select count(*)::int as n from expense_draft where line_user_id = $1`,
    [lineUserId],
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
    const lineUserId = fakeLineUserId()
    const before = await countDraftsFor(lineUserId)
    const broken = { ...DRAFT, totalSatang: 0 }
    await expect(createDraft(input({ lineUserId, draft: broken }))).rejects.toThrow()
    expect(await countDraftsFor(lineUserId)).toBe(before)
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

  /**
   * **ทำใน transaction เดียวทั้งหมด ไม่ใช่บน pool**
   *
   * `createDraft` กวาดของหมดอายุ**ทุกแถวทั้งตาราง** ในคำสั่งเดียวกับที่ insert
   * (นั่นคือทั้งหมดที่ D7 ต้องการ: ไม่มี cron) · ไฟล์เทสต์อื่นที่รันขนานกันจึงชิง
   * กวาดแถวของเทสต์นี้ไปก่อนได้ แล้ว `sweepExpiredDrafts()` จะคืน 0 แบบสุ่มตาม
   * จังหวะ — แถวที่เกิดในทรานแซกชันนี้ไม่มีใครนอกทรานแซกชันมองเห็น จึงกวาดไม่ได้
   */
  it('`sweepExpiredDrafts` คืนจำนวนที่ลบ', async () => {
    await withTransaction(async (tx) => {
      const old = await createDraft(input(), tx)
      await tx.query(
        `update expense_draft set created_at = now() - interval '48 hours' where id = $1`,
        [old.id],
      )
      expect(await sweepExpiredDrafts(tx)).toBeGreaterThanOrEqual(1)
      expect(await findDraft(old.id, tx)).toBeNull()
    })
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

  /**
   * `draftId` มาจาก postback ของการ์ด Draft ซึ่งปลอมได้ · ค่าที่ไม่ใช่ uuid ทำให้
   * Postgres โยนแล้วกลายเป็น 500 ซึ่ง LINE จะยิง postback เดิมกลับมาซ้ำไม่รู้จบ
   */
  it('id ที่ไม่ใช่ uuid คือหาไม่เจอ ไม่ใช่ error', async () => {
    await expect(findDraft('ไม่ใช่ uuid')).resolves.toBeNull()
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

/**
 * `updateDraft` — หน้าจอ LIFF เซฟรายการรายชิ้นกลับลง draft ใบเดิม (D57)
 *
 * เขียนทับ `payload` อย่างเดียว · **ห้ามขยับ `created_at`** เพราะมันคือนาฬิกา
 * หมดอายุ: รีเซ็ตทุกครั้งที่แก้แปลว่าการ์ดที่ถูกแตะเรื่อยๆ ไม่มีวันหมดอายุ ทั้งที่
 * ADR 0001 ตั้ง 24 ชั่วโมงไว้เพื่อไม่ให้ของค้างในตารางตลอดกาล
 */
describe('updateDraft — หน้าจอเซฟกลับลง draft ใบเดิม', () => {
  const ITEMIZED: ExpenseDraft = {
    description: 'soul bingsu',
    totalSatang: 44000,
    mode: 'itemized',
    participants: [{ name: 'กอล์ฟ', weight: 1 }],
    includesPayer: true,
    adjustmentSatang: 4700,
    items: [{ name: 'บิงซู', amountSatang: 44000, eaterNames: ['กอล์ฟ'] }],
  }
  const NEW_LINES: DraftLine[] = [
    { name: 'กอล์ฟ', amountSatang: 48700, isNew: true, isPayer: false },
  ]

  it('เขียนทับ payload แล้วอ่านกลับได้ของใหม่', async () => {
    const created = await createDraft(input())
    const updated = await updateDraft(
      { id: created.id, draft: ITEMIZED, lines: NEW_LINES },
    )

    expect(updated).not.toBeNull()
    expect(updated?.draft).toEqual(ITEMIZED)
    expect(updated?.lines).toEqual(NEW_LINES)

    const read = await findDraft(created.id)
    expect(read?.draft).toEqual(ITEMIZED)
    expect(read?.lines).toEqual(NEW_LINES)
  })

  it('ไม่ขยับ `created_at` — นาฬิกาหมดอายุต้องเดินต่อจากตอนการ์ดโผล่', async () => {
    const created = await createDraft(input())
    const updated = await updateDraft({ id: created.id, draft: ITEMIZED, lines: NEW_LINES })
    expect(updated?.createdAt.getTime()).toBe(created.createdAt.getTime())
  })

  it('ไม่แตะ `line_user_id` / `line_group_id` — เจ้าของการ์ดเปลี่ยนไม่ได้', async () => {
    const created = await createDraft(input())
    const updated = await updateDraft({ id: created.id, draft: ITEMIZED, lines: NEW_LINES })
    expect(updated?.lineUserId).toBe(created.lineUserId)
    expect(updated?.lineGroupId).toBe(created.lineGroupId)
  })

  it('draft ที่ไม่มีอยู่ → null ไม่ throw', async () => {
    expect(
      await updateDraft({ id: randomUUID(), draft: ITEMIZED, lines: NEW_LINES }),
    ).toBeNull()
  })

  it('payload ที่ผิดสัญญาเขียนไม่ได้เลย — ตรวจก่อนเขียน เหมือน `createDraft`', async () => {
    const created = await createDraft(input())
    await expect(
      updateDraft({
        id: created.id,
        draft: { ...ITEMIZED, items: [{ name: 'บิงซู', amountSatang: 1, eaterNames: [] }] },
        lines: NEW_LINES,
      }),
    ).rejects.toThrow('draft ไม่ผ่านสัญญาของ payload')
    // ของเดิมต้องยังอยู่ครบ ไม่ใช่ถูกเขียนทับครึ่งทาง
    expect((await findDraft(created.id))?.draft.description).toBe('ข้าว')
  })
})

/**
 * ตัวอ่านของ Trigger `จดรายชิ้นแล้ว` (D58) — ข้อความมาจากแชท ใครก็แปะลิงก์ซ้ำได้
 *
 * ขอบเขตคือ **วง** ไม่ใช่เจ้าของ: การ์ด Draft ลอยอยู่ในกลุ่มให้ทุกคนเห็นอยู่แล้ว
 * คนอื่นในวงเดียวกันขอให้วาดใหม่จึงไม่ได้เห็นอะไรที่เขายังไม่เคยเห็น · ส่วน 1:1
 * ไม่มีวงให้เทียบ ขอบเขตจึงเป็นตัวคนพิมพ์เอง
 */
describe('findDraftInScope — วาดการ์ดใบเดิมใหม่ ต้องไม่ข้ามวง', () => {
  it('คนในวงเดียวกันขอได้ ถึงจะไม่ใช่คนพิมพ์', async () => {
    const lineGroupId = fakeLineGroupId()
    const created = await createDraft(input({ lineGroupId }))
    const found = await findDraftInScope({
      draftId: created.id,
      lineGroupId,
      lineUserId: fakeLineUserId(),
    })
    expect(found?.id).toBe(created.id)
  })

  it('วงอื่นขอไม่ได้ — แปะลิงก์ข้ามกลุ่มต้องไม่เห็นบิลของวงนั้น', async () => {
    const created = await createDraft(input())
    const found = await findDraftInScope({
      draftId: created.id,
      lineGroupId: fakeLineGroupId(),
      lineUserId: created.lineUserId,
    })
    expect(found).toBeNull()
  })

  it('บิลของกลุ่มขอจากแชท 1:1 ไม่ได้ ถึงจะเป็นคนพิมพ์เอง', async () => {
    const created = await createDraft(input())
    const found = await findDraftInScope({
      draftId: created.id,
      lineGroupId: null,
      lineUserId: created.lineUserId,
    })
    expect(found).toBeNull()
  })

  it('บิลใน 1:1 เจ้าของขอได้', async () => {
    const created = await createDraft(input({ lineGroupId: null }))
    const found = await findDraftInScope({
      draftId: created.id,
      lineGroupId: null,
      lineUserId: created.lineUserId,
    })
    expect(found?.id).toBe(created.id)
  })

  it('บิลใน 1:1 ของคนอื่นขอไม่ได้ — ไม่มีวงให้ใช้เป็นขอบเขต', async () => {
    const created = await createDraft(input({ lineGroupId: null }))
    const found = await findDraftInScope({
      draftId: created.id,
      lineGroupId: null,
      lineUserId: fakeLineUserId(),
    })
    expect(found).toBeNull()
  })

  it('การ์ดที่หมดอายุแล้วไม่ถูกวาดใหม่', async () => {
    const lineGroupId = fakeLineGroupId()
    const created = await createDraft(input({ lineGroupId }))
    await ageDraft(created.id, 25)
    const found = await findDraftInScope({
      draftId: created.id,
      lineGroupId,
      lineUserId: created.lineUserId,
    })
    expect(found).toBeNull()
  })

  // id ที่ไม่ใช่ uuid ไม่ได้ "หาไม่เจอ" แต่ทำให้ Postgres โยน แล้วกลายเป็น 500
  it('id ที่ไม่ใช่ uuid คือไม่เจอ ไม่ใช่พัง', async () => {
    await expect(
      findDraftInScope({
        draftId: 'ไม่ใช่ยูยูไอดี',
        lineGroupId: fakeLineGroupId(),
        lineUserId: fakeLineUserId(),
      }),
    ).resolves.toBeNull()
  })
})
