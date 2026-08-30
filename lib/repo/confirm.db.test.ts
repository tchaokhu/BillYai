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
  surchargePct: 0,
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
