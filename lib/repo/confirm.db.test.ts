/**
 * กดยืนยัน — เส้นทางเดียวในระบบที่เขียนเงินลง ledger
 *
 * สิ่งที่เทสต์ชุดนี้มีไว้กัน:
 * 1. **บิลลงซ้ำ** — กดรัว หรือ LINE ยิง postback ซ้ำ ต้องได้บิลใบเดียว
 * 2. **ยอดเพี้ยนจากที่การ์ดโชว์** — ต้องใช้ `lines` ที่แช่ไว้ ไม่คำนวณใหม่
 * 3. **เขียนของทิ้งไว้ตอนล้มเหลว** — ทางที่ไม่สำเร็จต้องไม่ทิ้งวงหรือ draft ที่หายไป
 */

import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { closePool, getPool } from '@/lib/db/client'
import { confirmDraft } from './confirm'
import { createDraft, findDraft } from './drafts'
import { findExpenseById } from './expenses'
import { findActiveGroupByLineGroupId } from './groups'
import { claimMember, ensureMember, listMembers } from './members'
import { makeGroup } from '@/lib/db/fixtures'
import { ensureAppUserByLineUserId } from './users'
import type { DraftLine, ExpenseDraft } from '@/lib/types'

afterAll(async () => {
  await closePool()
})

const DRAFT: ExpenseDraft = {
  description: 'ข้าว',
  totalSatang: 120000,
  mode: 'share',
  participants: [
    { name: 'กอล์ฟ', weight: 1 },
    { name: 'ตูน', weight: 1 },
  ],
  includesPayer: false,
  adjustmentSatang: 0,
}

const LINES: DraftLine[] = [
  { name: 'กอล์ฟ', amountSatang: 60000, isNew: true, isPayer: false },
  { name: 'ตูน', amountSatang: 60000, isNew: true, isPayer: false },
]

function fakeLineGroupId(): string {
  return `C-test-${randomUUID()}`
}

function fakeLineUserId(): string {
  return `U-test-${randomUUID()}`
}

async function makeDraft(
  overrides: {
    lineGroupId?: string | null
    lineUserId?: string
    draft?: ExpenseDraft
    lines?: DraftLine[]
  } = {},
) {
  return createDraft({
    lineGroupId: overrides.lineGroupId === undefined ? fakeLineGroupId() : overrides.lineGroupId,
    lineUserId: overrides.lineUserId ?? fakeLineUserId(),
    draft: overrides.draft ?? DRAFT,
    lines: overrides.lines ?? LINES,
    spentAt: '2026-08-30',
  })
}

async function sharesOf(expenseId: string) {
  const { rows } = await getPool().query<{ display_name: string; amount_satang: number }>(
    `select m.display_name, s.amount_satang
       from expense_share s join member m on m.id = s.member_id
      where s.expense_id = $1
      order by m.display_name`,
    [expenseId],
  )
  return rows
}

describe('confirmDraft — เส้นทางที่สำเร็จ', () => {
  it('วง Member บิล และ share เกิดพร้อมกันหมดในจังหวะเดียว (D30)', async () => {
    const lineGroupId = fakeLineGroupId()
    const lineUserId = fakeLineUserId()
    const draft = await makeDraft({ lineGroupId, lineUserId })

    // ก่อนกด: ยังไม่มีวงเลย
    expect(await findActiveGroupByLineGroupId(lineGroupId)).toBeNull()

    const result = await confirmDraft({ draftId: draft.id, lineUserId, payer: { kind: 'new', displayName: 'เบียร์' } })
    expect(result.kind).toBe('committed')
    if (result.kind !== 'committed') return

    const group = await findActiveGroupByLineGroupId(lineGroupId)
    expect(group).not.toBeNull()
    expect((await listMembers(group?.id ?? '')).map((m) => m.displayName).sort()).toEqual([
      'กอล์ฟ',
      'ตูน',
      'เบียร์',
    ])
    expect(await sharesOf(result.expenseId)).toEqual([
      { display_name: 'กอล์ฟ', amount_satang: 60000 },
      { display_name: 'ตูน', amount_satang: 60000 },
    ])
  })

  it('draft ถูกลบไปพร้อมกัน — การ์ดใบนั้นใช้ไม่ได้อีก', async () => {
    const lineUserId = fakeLineUserId()
    const draft = await makeDraft({ lineUserId })
    await confirmDraft({ draftId: draft.id, lineUserId, payer: { kind: 'new', displayName: 'เบียร์' } })
    expect(await findDraft(draft.id)).toBeNull()
  })

  it('คนพิมพ์ถูก claim ให้ชื่อที่เลือก', async () => {
    const lineGroupId = fakeLineGroupId()
    const lineUserId = fakeLineUserId()
    const draft = await makeDraft({ lineGroupId, lineUserId })
    await confirmDraft({ draftId: draft.id, lineUserId, payer: { kind: 'new', displayName: 'เบียร์' } })

    const group = await findActiveGroupByLineGroupId(lineGroupId)
    const members = await listMembers(group?.id ?? '')
    const payer = members.find((m) => m.displayName === 'เบียร์')
    expect(payer?.appUserId).not.toBeNull()
    expect(payer?.claimedAt).not.toBeNull()
  })

  it('ยอดมาจาก `lines` ที่แช่ไว้ ไม่ได้คำนวณใหม่จาก Roster ณ ตอนกด', async () => {
    // Roster โตขึ้นหลังการ์ดถูกสร้าง — ถ้าคำนวณใหม่ยอดจะเปลี่ยนจากที่คนเห็น
    const lineGroupId = fakeLineGroupId()
    const lineUserId = fakeLineUserId()
    const draft = await makeDraft({ lineGroupId, lineUserId })

    const seeded = await ensureAppUserByLineUserId(fakeLineUserId())
    const other = await confirmDraft({
      draftId: (await makeDraft({ lineGroupId, lineUserId: fakeLineUserId() })).id,
      lineUserId: fakeLineUserId(),
      payer: { kind: 'new', displayName: 'ไม่ควรสำเร็จ' },
    })
    expect(other.kind).toBe('not-yours')
    expect(seeded.id).toBeTruthy()

    const result = await confirmDraft({ draftId: draft.id, lineUserId, payer: { kind: 'new', displayName: 'เบียร์' } })
    if (result.kind !== 'committed') throw new Error('ต้อง committed')
    expect(await sharesOf(result.expenseId)).toEqual([
      { display_name: 'กอล์ฟ', amount_satang: 60000 },
      { display_name: 'ตูน', amount_satang: 60000 },
    ])
  })

  it('แถวของคนพิมพ์ใช้ชื่อที่เลือก ไม่ใช่คำว่า "คุณ"', async () => {
    const lineUserId = fakeLineUserId()
    const draft = await makeDraft({
      lineUserId,
      lines: [
        { name: 'กอล์ฟ', amountSatang: 60000, isNew: true, isPayer: false },
        { name: 'คุณ', amountSatang: 60000, isNew: false, isPayer: true },
      ],
    })
    const result = await confirmDraft({ draftId: draft.id, lineUserId, payer: { kind: 'new', displayName: 'เบียร์' } })
    if (result.kind !== 'committed') throw new Error('ต้อง committed')

    const shares = await sharesOf(result.expenseId)
    expect(shares.map((s) => s.display_name).sort()).toEqual(['กอล์ฟ', 'เบียร์'])
  })

  it('คนที่ claim ไปแล้วใช้ชื่อเดิม ชื่อที่ส่งมาถูกเมิน', async () => {
    const lineGroupId = fakeLineGroupId()
    const lineUserId = fakeLineUserId()
    await confirmDraft({
      draftId: (await makeDraft({ lineGroupId, lineUserId })).id,
      lineUserId,
      payer: { kind: 'new', displayName: 'เบียร์' },
    })

    const second = await makeDraft({
      lineGroupId,
      lineUserId,
      lines: [
        { name: 'กอล์ฟ', amountSatang: 60000, isNew: false, isPayer: false },
        { name: 'ชื่ออื่น', amountSatang: 60000, isNew: false, isPayer: true },
      ],
    })
    const result = await confirmDraft({ draftId: second.id, lineUserId, payer: { kind: 'new', displayName: 'ชื่ออื่น' } })
    if (result.kind !== 'committed') throw new Error('ต้อง committed')

    const shares = await sharesOf(result.expenseId)
    expect(shares.map((s) => s.display_name).sort()).toEqual(['กอล์ฟ', 'เบียร์'])
  })
})

describe('confirmDraft — กดได้ครั้งเดียว', () => {
  it('กดซ้ำครั้งที่สองไม่มีอะไรเกิดขึ้น', async () => {
    const lineGroupId = fakeLineGroupId()
    const lineUserId = fakeLineUserId()
    const draft = await makeDraft({ lineGroupId, lineUserId })

    const first = await confirmDraft({ draftId: draft.id, lineUserId, payer: { kind: 'new', displayName: 'เบียร์' } })
    const second = await confirmDraft({ draftId: draft.id, lineUserId, payer: { kind: 'new', displayName: 'เบียร์' } })
    expect(first.kind).toBe('committed')
    expect(second).toEqual({ kind: 'gone' })

    const group = await findActiveGroupByLineGroupId(lineGroupId)
    const { rows } = await getPool().query<{ n: number }>(
      `select count(*)::int as n from expense where group_id = $1`,
      [group?.id ?? ''],
    )
    expect(rows[0]?.n).toBe(1)
  })

  it('กดพร้อมกันสองครั้งได้บิลใบเดียว', async () => {
    const lineGroupId = fakeLineGroupId()
    const lineUserId = fakeLineUserId()
    const draft = await makeDraft({ lineGroupId, lineUserId })

    const [a, b] = await Promise.all([
      confirmDraft({ draftId: draft.id, lineUserId, payer: { kind: 'new', displayName: 'เบียร์' } }),
      confirmDraft({ draftId: draft.id, lineUserId, payer: { kind: 'new', displayName: 'เบียร์' } }),
    ])
    const kinds = [a?.kind, b?.kind].sort()
    expect(kinds).toEqual(['committed', 'gone'])

    const group = await findActiveGroupByLineGroupId(lineGroupId)
    const { rows } = await getPool().query<{ n: number }>(
      `select count(*)::int as n from expense where group_id = $1`,
      [group?.id ?? ''],
    )
    expect(rows[0]?.n).toBe(1)
  })
})

describe('confirmDraft — ทางที่ไม่สำเร็จต้องไม่ทิ้งอะไรไว้', () => {
  it('คนอื่นกดการ์ดของเรา — ไม่ทำอะไรเลย และการ์ดยังอยู่ (D26)', async () => {
    const lineGroupId = fakeLineGroupId()
    const draft = await makeDraft({ lineGroupId })

    const result = await confirmDraft({
      draftId: draft.id,
      lineUserId: fakeLineUserId(),
      payer: { kind: 'new', displayName: 'คนแปลกหน้า' },
    })
    expect(result).toEqual({ kind: 'not-yours' })
    expect(await findDraft(draft.id)).not.toBeNull()
    expect(await findActiveGroupByLineGroupId(lineGroupId)).toBeNull()
  })

  it('draft ที่ไม่มีอยู่จริง', async () => {
    expect(
      await confirmDraft({ draftId: randomUUID(), lineUserId: fakeLineUserId(), payer: { kind: 'new', displayName: 'ก' } }),
    ).toEqual({ kind: 'gone' })
  })

  it('การ์ดหมดอายุ', async () => {
    const lineUserId = fakeLineUserId()
    const draft = await makeDraft({ lineUserId })
    await getPool().query(
      `update expense_draft set created_at = now() - interval '25 hours' where id = $1`,
      [draft.id],
    )
    expect(await confirmDraft({ draftId: draft.id, lineUserId, payer: { kind: 'new', displayName: 'ก' } })).toEqual({
      kind: 'gone',
    })
  })

  it('ชื่อที่เลือกเป็นของคนอื่นแล้ว — บอกให้รู้ และ**การ์ดต้องยังอยู่**', async () => {
    const lineGroupId = fakeLineGroupId()
    const lineUserId = fakeLineUserId()
    // วงมีอยู่แล้วและมี `เบียร์` ที่ถูก claim ไปแล้วโดยคนอื่น
    const first = await makeDraft({ lineGroupId, lineUserId: fakeLineUserId() })
    await confirmDraft({
      draftId: first.id,
      lineUserId: first.lineUserId,
      payer: { kind: 'new', displayName: 'เบียร์' },
    })

    const mine = await makeDraft({ lineGroupId, lineUserId })
    const result = await confirmDraft({ draftId: mine.id, lineUserId, payer: { kind: 'new', displayName: 'เบียร์' } })
    expect(result).toEqual({ kind: 'name-taken', name: 'เบียร์' })
    // ถ้าการ์ดหายไปด้วย คนจะเสียบิลทั้งใบเพราะเลือกชื่อชนคนอื่น
    expect(await findDraft(mine.id)).not.toBeNull()
  })

  it('ชื่อที่ยังไม่มีเจ้าของ claim ทับได้ — Placeholder มีไว้ให้เจ้าตัวมารับ (D4)', async () => {
    const lineGroupId = fakeLineGroupId()
    const owner = fakeLineUserId()
    const seed = await makeDraft({ lineGroupId, lineUserId: owner })
    await confirmDraft({ draftId: seed.id, lineUserId: owner, payer: { kind: 'new', displayName: 'เจ้าของวง' } })

    const group = await findActiveGroupByLineGroupId(lineGroupId)
    await ensureMember(group?.id ?? '', 'กอล์ฟ')

    const lineUserId = fakeLineUserId()
    const mine = await makeDraft({ lineGroupId, lineUserId })
    const result = await confirmDraft({ draftId: mine.id, lineUserId, payer: { kind: 'new', displayName: 'กอล์ฟ' } })
    expect(result.kind).toBe('committed')
  })
})

describe('confirmDraft — วงส่วนตัวในแชท 1:1 (D21)', () => {
  it('บิลใบแรกสร้างวงส่วนตัวให้', async () => {
    const lineUserId = fakeLineUserId()
    const draft = await makeDraft({ lineGroupId: null, lineUserId })
    const result = await confirmDraft({ draftId: draft.id, lineUserId, payer: { kind: 'new', displayName: 'ฉัน' } })
    expect(result.kind).toBe('committed')

    const user = await ensureAppUserByLineUserId(lineUserId)
    const { rows } = await getPool().query<{ n: number }>(
      `select count(*)::int as n from ledger_group where owner_id = $1 and kind = 'personal'`,
      [user.id],
    )
    expect(rows[0]?.n).toBe(1)
  })

  it('บิลใบที่สองใช้วงเดิม ไม่สร้างวงใหม่', async () => {
    const lineUserId = fakeLineUserId()
    for (const _ of [1, 2]) {
      const draft = await makeDraft({ lineGroupId: null, lineUserId })
      const result = await confirmDraft({ draftId: draft.id, lineUserId, payer: { kind: 'new', displayName: 'ฉัน' } })
      expect(result.kind).toBe('committed')
    }

    const user = await ensureAppUserByLineUserId(lineUserId)
    const { rows } = await getPool().query<{ n: number }>(
      `select count(*)::int as n from ledger_group where owner_id = $1 and kind = 'personal'`,
      [user.id],
    )
    expect(rows[0]?.n).toBe(1)
  })
})

describe('confirmDraft — ยอดรวมห้ามเพี้ยน', () => {
  it('แถวที่ตกกับคนเดียวกันถูกรวม ไม่ใช่ทิ้งแถวหนึ่ง', async () => {
    // `+ ข้าว 1200 กอล์ฟ รวมฉัน` ที่คนพิมพ์ก็ชื่อกอล์ฟ — สองแถวของคนเดียวกัน
    const lineUserId = fakeLineUserId()
    const draft = await makeDraft({
      lineUserId,
      lines: [
        { name: 'กอล์ฟ', amountSatang: 60000, isNew: true, isPayer: false },
        { name: 'คุณ', amountSatang: 60000, isNew: false, isPayer: true },
      ],
    })
    const result = await confirmDraft({ draftId: draft.id, lineUserId, payer: { kind: 'new', displayName: 'กอล์ฟ' } })
    if (result.kind !== 'committed') throw new Error('ต้อง committed')

    const shares = await sharesOf(result.expenseId)
    expect(shares).toEqual([{ display_name: 'กอล์ฟ', amount_satang: 120000 }])
  })

  it('เศษที่หารไม่ลงตัวยังรวมได้เท่ายอดบิลเป๊ะ', async () => {
    const lineUserId = fakeLineUserId()
    const draft = await makeDraft({
      lineUserId,
      draft: { ...DRAFT, totalSatang: 100003 },
      lines: [
        { name: 'ก', amountSatang: 33334, isNew: true, isPayer: false },
        { name: 'ข', amountSatang: 33334, isNew: true, isPayer: false },
        { name: 'ค', amountSatang: 33335, isNew: true, isPayer: false },
      ],
    })
    const result = await confirmDraft({ draftId: draft.id, lineUserId, payer: { kind: 'new', displayName: 'ง' } })
    if (result.kind !== 'committed') throw new Error('ต้อง committed')

    const total = (await sharesOf(result.expenseId)).reduce((sum, s) => sum + s.amount_satang, 0)
    expect(total).toBe(100003)
  })
})

describe('confirmDraft — เลือกชื่อที่มีอยู่แล้วใน Roster', () => {
  it('claim ชื่อนั้นให้แล้วลงบิลด้วย id ของมัน', async () => {
    const lineGroupId = fakeLineGroupId()
    const owner = fakeLineUserId()
    const seed = await makeDraft({ lineGroupId, lineUserId: owner })
    await confirmDraft({
      draftId: seed.id,
      lineUserId: owner,
      payer: { kind: 'new', displayName: 'เจ้าของวง' },
    })

    const group = await findActiveGroupByLineGroupId(lineGroupId)
    const placeholder = await ensureMember(group?.id ?? '', 'กอล์ฟ')

    const lineUserId = fakeLineUserId()
    const mine = await makeDraft({ lineGroupId, lineUserId })
    const result = await confirmDraft({
      draftId: mine.id,
      lineUserId,
      payer: { kind: 'member', memberId: placeholder.id },
    })
    expect(result.kind).toBe('committed')

    const members = await listMembers(group?.id ?? '')
    expect(members.find((m) => m.id === placeholder.id)?.appUserId).not.toBeNull()
  })

  it('ชื่อที่ถูกคนอื่นกดตัดหน้าไปแล้ว — บอกให้รู้ และการ์ดยังอยู่', async () => {
    const lineGroupId = fakeLineGroupId()
    const owner = fakeLineUserId()
    const seed = await makeDraft({ lineGroupId, lineUserId: owner })
    await confirmDraft({
      draftId: seed.id,
      lineUserId: owner,
      payer: { kind: 'new', displayName: 'เจ้าของวง' },
    })

    const group = await findActiveGroupByLineGroupId(lineGroupId)
    const taken = await ensureMember(group?.id ?? '', 'กอล์ฟ')
    const thief = await ensureAppUserByLineUserId(fakeLineUserId())
    await claimMember(taken.id, thief.id)

    const lineUserId = fakeLineUserId()
    const mine = await makeDraft({ lineGroupId, lineUserId })
    const result = await confirmDraft({
      draftId: mine.id,
      lineUserId,
      payer: { kind: 'member', memberId: taken.id },
    })
    expect(result).toEqual({ kind: 'name-taken', name: 'กอล์ฟ' })
    expect(await findDraft(mine.id)).not.toBeNull()
  })
})

describe('confirmDraft — ยังไม่รู้ว่าเขาคือใคร', () => {
  it('ไม่ได้เลือกตัวตนมา และยังไม่เคย claim → บอกว่ายังไม่รู้ และการ์ดยังอยู่', async () => {
    const lineUserId = fakeLineUserId()
    const draft = await makeDraft({ lineUserId })
    expect(await confirmDraft({ draftId: draft.id, lineUserId })).toEqual({
      kind: 'needs-identity',
    })
    expect(await findDraft(draft.id)).not.toBeNull()
  })

  it('คนที่ claim แล้วกดปุ่มยืนยันเปล่าๆ ได้เลย ไม่ต้องเลือกอะไรอีก', async () => {
    const lineGroupId = fakeLineGroupId()
    const lineUserId = fakeLineUserId()
    await confirmDraft({
      draftId: (await makeDraft({ lineGroupId, lineUserId })).id,
      lineUserId,
      payer: { kind: 'new', displayName: 'เบียร์' },
    })

    const second = await makeDraft({ lineGroupId, lineUserId })
    expect((await confirmDraft({ draftId: second.id, lineUserId })).kind).toBe('committed')
  })
})

describe('confirmDraft — ทางที่ล้มเหลวต้องไม่กินการ์ด', () => {
  it('member id ที่ชี้ไปนอกวง — ตอบว่าการ์ดใช้ไม่ได้ ไม่ใช่ throw', async () => {
    // throw จะกลายเป็น 500 แล้ว LINE ส่ง postback เดิมกลับมาให้พังซ้ำไม่รู้จบ
    const outsider = await makeGroup()
    const stray = await ensureMember(outsider.id, 'คนนอกวง')

    const lineUserId = fakeLineUserId()
    const draft = await makeDraft({ lineUserId })
    const result = await confirmDraft({
      draftId: draft.id,
      lineUserId,
      payer: { kind: 'member', memberId: stray.id },
    })
    expect(result).toEqual({ kind: 'gone' })
  })
})

/**
 * บิล itemized ที่มาจากหน้าจอ LIFF — **รายการต้องลง `expense_item` ด้วย**
 * ไม่ใช่แค่ยอดรายคน · ไม่งั้นการ์ดรายละเอียด (D51) ไม่มีอะไรจะโชว์ และคำถาม
 * "ใครกินอะไร" ตอบไม่ได้ทั้งที่คนอุตส่าห์ติ๊กมาแล้ว
 */
describe('confirmDraft — บิล itemized จากหน้าจอ LIFF', () => {
  const ITEM_DRAFT: ExpenseDraft = {
    description: 'soul bingsu',
    // ผลรวมรายชิ้น — ยอดที่จ่ายจริงคือ 44000 + 4700
    totalSatang: 44000,
    mode: 'itemized',
    participants: [
      { name: 'กอล์ฟ', weight: 1 },
      { name: 'ตูน', weight: 1 },
    ],
    includesPayer: true,
    adjustmentSatang: 4700,
    items: [
      { name: 'บิงซู', amountSatang: 20000, eaterNames: ['กอล์ฟ'] },
      { name: 'โทสต์', amountSatang: 20000, eaterNames: ['ตูน'] },
      // ไม่ติ๊กใครเลย = ของกลาง หารทุกคนในบิล (D53)
      { name: 'ชาเขียว', amountSatang: 4000, eaterNames: [] },
    ],
  }

  /**
   * ยอดที่แช่ไว้ตอนสร้าง draft — คิดจาก 48700 ตามสัดส่วน subtotal
   * กอล์ฟ 20000+2000=22000 · ตูน 20000+2000=22000 → คนละ 24350
   */
  const ITEM_LINES: DraftLine[] = [
    { name: 'กอล์ฟ', amountSatang: 24350, isNew: true, isPayer: true },
    { name: 'ตูน', amountSatang: 24350, isNew: true, isPayer: false },
  ]

  it('รายการลง `expense_item` พร้อมคนกิน และของกลางกางเป็นทุกคนในบิล', async () => {
    const lineUserId = fakeLineUserId()
    const draft = await makeDraft({ lineUserId, draft: ITEM_DRAFT, lines: ITEM_LINES })

    const result = await confirmDraft({
      draftId: draft.id,
      lineUserId,
      payer: { kind: 'new', displayName: 'กอล์ฟ' },
    })
    expect(result.kind).toBe('committed')
    if (result.kind !== 'committed') return

    const detail = await findExpenseById(result.expenseId)
    expect(detail).not.toBeNull()
    if (detail === null) return

    expect(detail.expense.totalSatang).toBe(44000)
    expect(detail.expense.adjustmentSatang).toBe(4700)

    const byName = new Map(
      detail.items.map((entry) => [entry.item.name, entry.shares.length] as const),
    )
    expect(byName.get('บิงซู')).toBe(1)
    expect(byName.get('โทสต์')).toBe(1)
    // ของกลางกางเป็นทุกคนในบิล ไม่ใช่แถวที่ไม่มีคนกิน
    expect(byName.get('ชาเขียว')).toBe(2)

    expect(await sharesOf(result.expenseId)).toEqual([
      { display_name: 'กอล์ฟ', amount_satang: 24350 },
      { display_name: 'ตูน', amount_satang: 24350 },
    ])
  })

  /**
   * postback data ปลอมได้ และการ์ดลอยอยู่ในแชทได้ตลอดกาล · ทั้ง `confirm=` และ
   * `as=` ถูกยัดเข้า `where id = $1` ของคอลัมน์ uuid — ค่าที่ไม่ใช่ uuid เคยทำให้
   * Postgres โยนแล้วกลายเป็น 500 ซึ่ง **LINE ยิง postback เดิมกลับมาซ้ำ** จึงวน
   * อยู่อย่างนั้นโดยคนกดไม่ได้ข้อความสักครั้ง · `gone` คือคำตอบเดียวกับ id ที่หาไม่เจอ
   */
  it.each([
    ['draftId ไม่ใช่ uuid', { draftId: 'ไม่ใช่ uuid', as: null }],
    ['`as=` ไม่ใช่ uuid', { draftId: null, as: 'member-0' }],
  ])('%s → `gone` ไม่ใช่ error', async (_label, forged) => {
    const lineUserId = fakeLineUserId()
    const draft = await makeDraft({ lineUserId, draft: ITEM_DRAFT, lines: ITEM_LINES })

    const result = await confirmDraft({
      draftId: forged.draftId ?? draft.id,
      lineUserId,
      ...(forged.as === null
        ? { payer: { kind: 'new' as const, displayName: 'กอล์ฟ' } }
        : { payer: { kind: 'member' as const, memberId: forged.as } }),
    })
    expect(result).toEqual({ kind: 'gone' })
  })

  /**
   * **บิล itemized ที่คนจ่ายไม่ได้กินด้วย** — `+ ข้าว 1200 กอล์ฟ ตูน` ที่ไม่มี
   * `รวมฉัน` แล้วเอาเข้าหน้าจอจดรายชิ้น · draft แบบนี้ไม่มีแถวไหน `isPayer` เลย
   *
   * ก่อนแก้บั๊ก หน้าจอเดาว่าคนแรกในลิสต์คือคนจ่าย แล้วเซฟ `isPayer: true` ทับลงไป
   * ตอนยืนยัน `commitExpense` ยัด `payerMemberId` ให้แถวนั้น (บรรทัด `line.isPayer
   * ? payerMemberId : ...`) — **กอล์ฟหายจากบิลทั้งคน และคนจ่ายรับหนี้ของเขาไป
   * เงียบๆ** · เทสต์นี้ยึดฝั่งที่ถูกไว้: ทุกคนในบิลต้องได้ยอดของตัวเองครบ และ
   * คนจ่ายต้องไม่มีแถวหนี้เลย
   */
  it('คนจ่ายที่ไม่ได้อยู่ในบิล — ทุกคนในบิลได้ยอดของตัวเอง คนจ่ายไม่มีหนี้', async () => {
    const lineUserId = fakeLineUserId()
    const draft = await makeDraft({
      lineUserId,
      draft: {
        ...ITEM_DRAFT,
        description: 'ข้าว',
        totalSatang: 120000,
        adjustmentSatang: 0,
        includesPayer: false,
        items: [
          { name: 'ข้าวผัด', amountSatang: 60000, eaterNames: ['กอล์ฟ'] },
          { name: 'ผัดไทย', amountSatang: 60000, eaterNames: ['ตูน'] },
        ],
      },
      lines: [
        { name: 'กอล์ฟ', amountSatang: 60000, isNew: true, isPayer: false },
        { name: 'ตูน', amountSatang: 60000, isNew: true, isPayer: false },
      ],
    })

    const result = await confirmDraft({
      draftId: draft.id,
      lineUserId,
      payer: { kind: 'new', displayName: 'nut' },
    })
    expect(result.kind).toBe('committed')
    if (result.kind !== 'committed') return

    // `nut` จ่ายไปทั้งใบและไม่ได้กิน — ไม่มีแถวของเขาใน `expense_share`
    expect(await sharesOf(result.expenseId)).toEqual([
      { display_name: 'กอล์ฟ', amount_satang: 60000 },
      { display_name: 'ตูน', amount_satang: 60000 },
    ])
  })

  /**
   * **คนพิมพ์ที่ยังไม่ claim เพิ่มชื่อจริงของตัวเองเข้าบิลจากหน้าจอ**
   *
   * การ์ดเรียกเขาว่า `คุณ` (ADR 0002) ส่วนชื่อจริงของเขายังลอยอยู่ใน Roster ปุ่ม
   * `+ เพิ่มคน` จึงเสนอชื่อนั้นให้ · พอกดยืนยันแล้วเลือกชื่อนั้นเป็นตัวตน สองแถว
   * ยุบเป็น Member คนเดียว ยอดรายคนที่แช่ไว้จึงอธิบายรายการไม่ได้อีกต่อไป และ
   * `assertItemsMatchShares` โยนทิ้ง → 500 → LINE ยิง postback เดิมกลับมาไม่รู้จบ
   *
   * ต้องตอบให้เขารู้ตัว **ก่อน** ลบ draft ไม่ใช่ปล่อยให้พังแล้วเงียบ
   */
  it('คนพิมพ์เลือกตัวตนเป็นชื่อที่อยู่ในบิลอยู่แล้ว → บอกว่าชื่อชน ไม่ใช่ 500', async () => {
    const lineGroupId = fakeLineGroupId()
    const lineUserId = fakeLineUserId()

    // วงมีอยู่แล้วและมี `กอล์ฟ` ที่ยังไม่มีเจ้าของ
    const seed = await makeDraft({ lineGroupId, lineUserId: fakeLineUserId() })
    await confirmDraft({
      draftId: seed.id,
      lineUserId: seed.lineUserId,
      payer: { kind: 'new', displayName: 'เบียร์' },
    })

    // คนพิมพ์คนใหม่ ยังไม่ claim — การ์ดเรียกเขาว่า `คุณ` และเขาเพิ่ม `กอล์ฟ` เข้าบิล
    const draft = await makeDraft({
      lineGroupId,
      lineUserId,
      draft: {
        ...ITEM_DRAFT,
        totalSatang: 30000,
        adjustmentSatang: 0,
        participants: [
          { name: 'กอล์ฟ', weight: 1 },
          { name: 'ตูน', weight: 1 },
        ],
        items: [{ name: 'บิงซู', amountSatang: 30000, eaterNames: ['คุณ', 'กอล์ฟ', 'ตูน'] }],
      },
      // สามคนหาร 300 คนละ 100 — พอ `คุณ` กับ `กอล์ฟ` ยุบเป็นคนเดียวจะเหลือสองคน
      // ที่ถือ 200/100 ทั้งที่รายการเดียวกันหารสองต้องได้ 150/150
      lines: [
        { name: 'คุณ', amountSatang: 10000, isNew: false, isPayer: true },
        { name: 'กอล์ฟ', amountSatang: 10000, isNew: false, isPayer: false },
        { name: 'ตูน', amountSatang: 10000, isNew: false, isPayer: false },
      ],
    })

    const result = await confirmDraft({
      draftId: draft.id,
      lineUserId,
      payer: { kind: 'new', displayName: 'กอล์ฟ' },
    })
    expect(result.kind).toBe('name-in-bill')
    // ยังไม่ได้ลบอะไร — เขากลับไปเอาชื่อนั้นออกจากบิลแล้วกดใหม่ได้
    expect(await findDraft(draft.id)).not.toBeNull()
  })

  it('รายการที่อ้างชื่อนอกบิลเขียนลงตารางไม่ได้เลย — กันไว้ก่อนถึงปุ่มยืนยัน', async () => {
    await expect(
      makeDraft({
        draft: {
          ...ITEM_DRAFT,
          items: [{ name: 'บิงซู', amountSatang: 44000, eaterNames: ['คนที่ไม่ได้อยู่ในบิล'] }],
        },
        lines: ITEM_LINES,
      }),
    ).rejects.toThrow('draft ไม่ผ่านสัญญาของ payload')
  })
})
