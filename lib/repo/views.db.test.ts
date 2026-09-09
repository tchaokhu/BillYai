/**
 * มุมมองที่ webhook ใช้ — ต่อจาก repo จริงทั้งเส้น
 *
 * เทสต์ชุดนี้เดินเส้นทางเดียวกับที่ผู้ใช้เดิน: จดบิล → กดยืนยัน → ถามยอด · สิ่งที่
 * ต้องคุมคือ **ยอดในการ์ด `ยอด` ต้องตรงกับยอดที่ลง ledger ไปจริง**
 */

import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { closePool } from '@/lib/db/client'
import { makeGroup, makeMembers } from '@/lib/db/fixtures'
import { confirmDraft } from './confirm'
import { createDraft } from './drafts'
import { markMemberLeft } from './members'
import { commitExpense, voidExpense } from './expenses'
import { splitExpense } from '@/lib/split'
import { loadBalance, loadBillDetail, loadBillList, loadGroupView } from './views'
import type { DraftLine, ExpenseDraft } from '@/lib/types'

afterAll(async () => {
  await closePool()
})

function fakeLineGroupId(): string {
  return `C-test-${randomUUID()}`
}

function fakeLineUserId(): string {
  return `U-test-${randomUUID()}`
}

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

/** จดบิลแล้วกดยืนยันให้จบในทีเดียว — เส้นทางเดียวกับที่ผู้ใช้เดิน */
async function recordBill(
  lineGroupId: string | null,
  lineUserId: string,
  payerName: string,
  lines: DraftLine[] = LINES,
  draft: ExpenseDraft = DRAFT,
): Promise<void> {
  const created = await createDraft({
    lineGroupId,
    lineUserId,
    draft,
    lines,
    spentAt: '2026-08-30',
  })
  const result = await confirmDraft({
    draftId: created.id,
    lineUserId,
    payer: { kind: 'new', displayName: payerName },
  })
  if (result.kind !== 'committed') throw new Error(`ยืนยันไม่สำเร็จ: ${result.kind}`)
}

describe('loadBalance', () => {
  it('วงที่ยังไม่เคยจดบิลตอบ `no-bills` ไม่ใช่ยอดศูนย์', async () => {
    expect(await loadBalance(fakeLineGroupId(), fakeLineUserId())).toBe('no-bills')
  })

  it('แชท 1:1 ที่ยังไม่เคยจดบิลก็ `no-bills`', async () => {
    expect(await loadBalance(null, fakeLineUserId())).toBe('no-bills')
  })

  it('วงที่มีอยู่แต่ยังไม่มีบิลก็ `no-bills` ไม่ใช่ "ไม่มีใครติดใคร"', async () => {
    // ปกติเกิดไม่ได้เพราะวงเกิดพร้อมบิลใบแรก (D30) แต่ Phase 3 มี restore วงที่ถูก
    // soft-delete ซึ่งเปิดช่องนี้ · ตอบไกด์ ไม่ใช่ตอบว่าเคลียร์กันหมดแล้ว
    const group = await makeGroup()
    expect(await loadBalance(group.lineGroupId, fakeLineUserId())).toBe('no-bills')
  })

  it('ยอดในการ์ดตรงกับยอดที่ลง ledger', async () => {
    const lineGroupId = fakeLineGroupId()
    const lineUserId = fakeLineUserId()
    await recordBill(lineGroupId, lineUserId, 'เบียร์')

    const view = await loadBalance(lineGroupId, lineUserId)
    if (typeof view === 'string' || view.kind !== 'debts') throw new Error('ต้องมีหนี้')
    expect(view.blocks).toEqual([
      {
        creditorName: 'เบียร์',
        totalSatang: 120000,
        rows: [
          { debtorName: 'กอล์ฟ', amountSatang: 60000 },
          { debtorName: 'ตูน', amountSatang: 60000 },
        ],
      },
    ])
  })

  it('**ไม่ยุบข้ามคน** — สองคนจ่ายคือสองบล็อก (D5)', async () => {
    const lineGroupId = fakeLineGroupId()
    const first = fakeLineUserId()
    const second = fakeLineUserId()

    await recordBill(lineGroupId, first, 'เบียร์')
    await recordBill(lineGroupId, second, 'แนน', [
      { name: 'เบียร์', amountSatang: 30000, isNew: false, isPayer: false },
    ], { ...DRAFT, totalSatang: 30000, participants: [{ name: 'เบียร์', weight: 1 }] })

    const view = await loadBalance(lineGroupId, first)
    if (typeof view === 'string' || view.kind !== 'debts') throw new Error('ต้องมีหนี้')
    expect(view.blocks.map((b) => b.creditorName)).toEqual(['เบียร์', 'แนน'])
  })

  it('แชท 1:1 อ่านวงส่วนตัวของคนนั้น', async () => {
    const lineUserId = fakeLineUserId()
    await recordBill(null, lineUserId, 'ฉัน')

    const view = await loadBalance(null, lineUserId)
    if (typeof view === 'string' || view.kind !== 'debts') throw new Error('ต้องมีหนี้')
    expect(view.blocks[0]?.creditorName).toBe('ฉัน')
  })

  it('วงของคนอื่นไม่ปนกัน', async () => {
    const lineUserId = fakeLineUserId()
    await recordBill(null, lineUserId, 'ฉัน')
    expect(await loadBalance(null, fakeLineUserId())).toBe('no-bills')
  })
})

describe('loadGroupView', () => {
  it('วงที่ยังไม่มีอะไรเลยได้มุมมองว่าง', async () => {
    expect(await loadGroupView(fakeLineGroupId(), fakeLineUserId())).toEqual({
      roster: [],
      payerName: null,
      unclaimed: [],
    })
  })

  it('หลังจดบิลใบแรก คนจ่ายมีชื่อแล้ว ส่วนคนอื่นยังไม่มีเจ้าของ', async () => {
    const lineGroupId = fakeLineGroupId()
    const lineUserId = fakeLineUserId()
    await recordBill(lineGroupId, lineUserId, 'เบียร์')

    const view = await loadGroupView(lineGroupId, lineUserId)
    expect(view.payerName).toBe('เบียร์')
    expect([...view.roster].sort()).toEqual(['กอล์ฟ', 'ตูน', 'เบียร์'])
    expect(view.unclaimed.map((c) => c.name).sort()).toEqual(['กอล์ฟ', 'ตูน'])
  })

  it('คนที่ยังไม่เคยยืนยันตัวตนในวงเดิมยังได้ `payerName` เป็น null', async () => {
    const lineGroupId = fakeLineGroupId()
    await recordBill(lineGroupId, fakeLineUserId(), 'เบียร์')

    const view = await loadGroupView(lineGroupId, fakeLineUserId())
    expect(view.payerName).toBeNull()
    expect(view.roster).toHaveLength(3)
  })

  it('ตัวเลือกตัวตนเรียงใหม่ก่อน — คนที่เพิ่งถูกพิมพ์ชื่อเข้ามาอยู่ต้นแถว', async () => {
    const lineGroupId = fakeLineGroupId()
    const lineUserId = fakeLineUserId()
    await recordBill(lineGroupId, lineUserId, 'เบียร์')
    await recordBill(lineGroupId, fakeLineUserId(), 'แนน', [
      { name: 'คนมาใหม่', amountSatang: 30000, isNew: true, isPayer: false },
    ], { ...DRAFT, totalSatang: 30000, participants: [{ name: 'คนมาใหม่', weight: 1 }] })

    const view = await loadGroupView(lineGroupId, fakeLineUserId())
    expect(view.unclaimed[0]?.name).toBe('คนมาใหม่')
  })

  it('แชท 1:1 อ่านวงส่วนตัว ไม่ใช่ว่างเสมอ', async () => {
    const lineUserId = fakeLineUserId()
    await recordBill(null, lineUserId, 'ฉัน')

    const view = await loadGroupView(null, lineUserId)
    expect(view.payerName).toBe('ฉัน')
    expect([...view.roster].sort()).toEqual(['กอล์ฟ', 'ฉัน', 'ตูน'])
  })
})

describe('loadBalance — คนที่ออกจากกลุ่มไปแล้ว', () => {
  it('หนี้ของเขาต้องยังโผล่ในยอด — ไม่ใช่หายไปเงียบๆ (D18)', async () => {
    // `member` ไม่เคยถูกลบ และ `computeDebts` ก็ยังคืนหนี้ของเขามา · ถ้า name map
    // ไม่มีชื่อเขา ยอดจะขาดหายไปโดยไม่มีใครรู้ ซึ่งใน ledger คือความผิดพลาดที่รับไม่ได้
    const lineGroupId = fakeLineGroupId()
    const lineUserId = fakeLineUserId()
    await recordBill(lineGroupId, lineUserId, 'เบียร์')

    const before = await loadGroupView(lineGroupId, lineUserId)
    const golf = before.unclaimed.find((c) => c.name === 'กอล์ฟ')
    if (golf === undefined) throw new Error('ต้องมีกอล์ฟใน Roster')
    await markMemberLeft(golf.id)

    const view = await loadBalance(lineGroupId, lineUserId)
    if (typeof view === 'string' || view.kind !== 'debts') throw new Error('ต้องมีหนี้')
    expect(view.blocks[0]?.rows.map((r) => r.debtorName).sort()).toEqual(['กอล์ฟ', 'ตูน'])
    expect(view.blocks[0]?.totalSatang).toBe(120000)
  })

  it('คนที่ออกไปแล้วไม่ถูกเสนอเป็นตัวเลือกตัวตนอีก', async () => {
    const lineGroupId = fakeLineGroupId()
    const lineUserId = fakeLineUserId()
    await recordBill(lineGroupId, lineUserId, 'เบียร์')

    const before = await loadGroupView(lineGroupId, lineUserId)
    const golf = before.unclaimed.find((c) => c.name === 'กอล์ฟ')
    if (golf === undefined) throw new Error('ต้องมีกอล์ฟใน Roster')
    await markMemberLeft(golf.id)

    const after = await loadGroupView(lineGroupId, fakeLineUserId())
    expect(after.unclaimed.map((c) => c.name)).not.toContain('กอล์ฟ')
  })
})

describe('loadBillList (D45)', () => {
  it('วงที่ยังไม่เคยจดบิลตอบ `no-bills` — ตอบไกด์ ไม่ใช่รายการว่าง', async () => {
    expect(await loadBillList(fakeLineGroupId(), fakeLineUserId())).toBe('no-bills')
    expect(await loadBillList(null, fakeLineUserId())).toBe('no-bills')
  })

  it('วงที่มีอยู่แต่ยังไม่มีบิลก็ `no-bills`', async () => {
    const group = await makeGroup()
    expect(await loadBillList(group.lineGroupId, fakeLineUserId())).toBe('no-bills')
  })

  it('คืนบิลที่จดไว้ พร้อมจำนวนทั้งหมด', async () => {
    const lineGroupId = fakeLineGroupId()
    const lineUserId = fakeLineUserId()
    await recordBill(lineGroupId, lineUserId, 'เบียร์')
    await recordBill(lineGroupId, lineUserId, 'เบียร์')

    const list = await loadBillList(lineGroupId, lineUserId)
    if (list === 'no-bills') throw new Error('ต้องมีบิล')
    expect(list.totalCount).toBe(2)
    expect(list.bills).toHaveLength(2)
    expect(list.bills[0]).toMatchObject({ description: 'ข้าว', spentAt: '2026-08-30' })
    expect(list.bills.every((bill) => bill.id.length > 0)).toBe(true)
  })

  it('ตัดที่ 20 ใบ แต่ `totalCount` ยังบอกจำนวนจริง — ห้ามตัดเงียบ', async () => {
    const lineGroupId = fakeLineGroupId()
    const lineUserId = fakeLineUserId()
    for (let i = 0; i < 22; i += 1) await recordBill(lineGroupId, lineUserId, 'เบียร์')

    const list = await loadBillList(lineGroupId, lineUserId)
    if (list === 'no-bills') throw new Error('ต้องมีบิล')
    expect(list.bills).toHaveLength(20)
    expect(list.totalCount).toBe(22)
  })

  it('วงอื่นไม่ปนเข้ามา', async () => {
    const mine = fakeLineGroupId()
    const theirs = fakeLineGroupId()
    await recordBill(mine, fakeLineUserId(), 'เบียร์')
    await recordBill(theirs, fakeLineUserId(), 'เบียร์')

    const list = await loadBillList(mine, fakeLineUserId())
    if (list === 'no-bills') throw new Error('ต้องมีบิล')
    expect(list.totalCount).toBe(1)
  })
})

describe('loadBillDetail — บิล itemized (D51)', () => {
  /** บิลรายชิ้นเขียนตรงผ่าน `commitExpense` — ไวยากรณ์ในแชทยังสร้าง items ไม่ได้ */
  async function recordItemized(lineGroupId: string): Promise<string> {
    const group = await makeGroup(undefined, { lineGroupId })
    const [aek, dear, game] = await makeMembers(group.id, ['aek', 'dear', 'game'])
    if (!aek || !dear || !game) throw new Error('fixture')

    const items = [
      { name: 'บิงซู', amountSatang: 22000, memberIds: [aek.id, dear.id] },
      { name: 'โทสต์', amountSatang: 14900, memberIds: [game.id] },
      { name: 'ชาเขียว', amountSatang: 4000, memberIds: [aek.id, dear.id, game.id] },
    ]
    const shares = splitExpense({
      totalSatang: 40900,
      adjustmentSatang: 4300,
      payerId: aek.id,
      mode: 'itemized',
      participants: [{ memberId: aek.id }, { memberId: dear.id }, { memberId: game.id }],
      items,
    })
    const expense = await commitExpense({
      groupId: group.id,
      description: 'soul bingsu',
      totalSatang: 40900,
      adjustmentSatang: 4300,
      payerMemberId: aek.id,
      splitMode: 'itemized',
      spentAt: '2026-09-05',
      createdBy: aek.id,
      source: 'liff',
      shares: shares.map((s) => ({ memberId: s.memberId, amountSatang: s.amountSatang })),
      // `commitExpense` รับคนกินเป็น `shares` ส่วน `splitExpense` รับเป็น `memberIds`
      items: items.map((item) => ({
        name: item.name,
        amountSatang: item.amountSatang,
        shares: item.memberIds.map((memberId) => ({ memberId })),
      })),
    })
    return expense.id
  }

  it('คืนรายการรายชิ้นพร้อมชื่อคนกิน ไม่ใช่แค่ยอดรายคน', async () => {
    const lineGroupId = fakeLineGroupId()
    const expenseId = await recordItemized(lineGroupId)

    const detail = await loadBillDetail({
      expenseId,
      lineGroupId,
      lineUserId: fakeLineUserId(),
    })
    if (detail === 'not-found' || detail === 'voided') throw new Error(detail)

    // เรียงจากชิ้นแพงสุด — ลำดับเดียวกับที่ `findExpenseById` คืนมา
    expect(detail.items).toEqual([
      { name: 'บิงซู', amountSatang: 22000, eaterNames: ['aek', 'dear'] },
      { name: 'โทสต์', amountSatang: 14900, eaterNames: ['game'] },
      { name: 'ชาเขียว', amountSatang: 4000, eaterNames: ['aek', 'dear', 'game'] },
    ])
  })
})

describe('loadBillDetail (D45)', () => {
  async function firstBillId(lineGroupId: string, lineUserId: string): Promise<string> {
    const list = await loadBillList(lineGroupId, lineUserId)
    if (list === 'no-bills') throw new Error('ต้องมีบิล')
    const first = list.bills[0]
    if (first === undefined) throw new Error('ต้องมีบิล')
    return first.id
  }

  it('คืนรายละเอียดพร้อมรายคนและป้ายคนจ่าย', async () => {
    const lineGroupId = fakeLineGroupId()
    const lineUserId = fakeLineUserId()
    await recordBill(lineGroupId, lineUserId, 'เบียร์')
    const expenseId = await firstBillId(lineGroupId, lineUserId)

    const detail = await loadBillDetail({ expenseId, lineGroupId, lineUserId })
    if (detail === 'not-found' || detail === 'voided') throw new Error(`ไม่ควรได้ ${detail}`)
    expect(detail.description).toBe('ข้าว')
    expect(detail.spentAt).toBe('2026-08-30')
    // ผลรวมรายคนต้องเท่ากับยอดบิลเป๊ะ — invariant เดียวกับที่สคีมาเขียนไว้
    expect(detail.lines.reduce((sum, line) => sum + line.amountSatang, 0)).toBe(120000)
    expect(detail.lines.map((line) => line.name).sort()).toEqual(['กอล์ฟ', 'ตูน'])
  })

  it('**บิลของวงอื่นตอบ `not-found`** — id เดี่ยวๆ ไม่ใช่สิทธิ์ดู', async () => {
    // การ์ด `บิล` ลอยอยู่ในแชทได้ตลอดกาล และ postback data ปลอมได้ · ด่านนี้คือ
    // ที่เดียวที่กันไม่ให้คนในวงหนึ่งอ่าน ledger ของอีกวง
    const mine = fakeLineGroupId()
    const theirs = fakeLineGroupId()
    const theirUser = fakeLineUserId()
    await recordBill(mine, fakeLineUserId(), 'เบียร์')
    await recordBill(theirs, theirUser, 'เบียร์')
    const theirBill = await firstBillId(theirs, theirUser)

    expect(
      await loadBillDetail({ expenseId: theirBill, lineGroupId: mine, lineUserId: fakeLineUserId() }),
    ).toBe('not-found')
  })

  it('id ที่ไม่มีอยู่จริงตอบ `not-found` ไม่ throw', async () => {
    const lineGroupId = fakeLineGroupId()
    const lineUserId = fakeLineUserId()
    await recordBill(lineGroupId, lineUserId, 'เบียร์')
    expect(await loadBillDetail({ expenseId: randomUUID(), lineGroupId, lineUserId })).toBe(
      'not-found',
    )
  })

  it('วงที่ยังไม่มีตอบ `not-found` ไม่ throw', async () => {
    expect(
      await loadBillDetail({
        expenseId: randomUUID(),
        lineGroupId: fakeLineGroupId(),
        lineUserId: fakeLineUserId(),
      }),
    ).toBe('not-found')
  })

  it('บิลที่ถูกยกเลิกตอบ `voided` — ไม่ใช่ `not-found` และไม่ใช่ยอดเก่า', async () => {
    const lineGroupId = fakeLineGroupId()
    const lineUserId = fakeLineUserId()
    await recordBill(lineGroupId, lineUserId, 'เบียร์')
    const expenseId = await firstBillId(lineGroupId, lineUserId)

    const before = await loadBillDetail({ expenseId, lineGroupId, lineUserId })
    if (before === 'not-found' || before === 'voided') throw new Error('ต้องอ่านได้ก่อนยกเลิก')
    await voidExpense(expenseId)

    expect(await loadBillDetail({ expenseId, lineGroupId, lineUserId })).toBe('voided')
  })

  it('ชื่อคนที่ออกจากกลุ่มไปแล้วต้องยังอยู่ในบิลเก่า', async () => {
    // `listMembers` ตัดคนที่ออกไปแล้วโดย default — ลืม `includeLeft` แปลว่าแถวของเขา
    // หายจากการ์ดเงียบๆ แล้วยอดรวมจะไม่ตรงกับผลรวมรายคนที่เห็น
    const lineGroupId = fakeLineGroupId()
    const lineUserId = fakeLineUserId()
    await recordBill(lineGroupId, lineUserId, 'เบียร์')
    const expenseId = await firstBillId(lineGroupId, lineUserId)

    const view = await loadGroupView(lineGroupId, lineUserId)
    const golf = view.unclaimed.find((choice) => choice.name === 'กอล์ฟ')
    if (golf === undefined) throw new Error('ต้องมีกอล์ฟใน Roster')
    await markMemberLeft(golf.id)

    const detail = await loadBillDetail({ expenseId, lineGroupId, lineUserId })
    if (detail === 'not-found' || detail === 'voided') throw new Error(`ไม่ควรได้ ${detail}`)
    expect(detail.lines.map((line) => line.name)).toContain('กอล์ฟ')
    // ยอดยังครบทั้งใบ — แถวที่หายไปเงียบๆ จะทำให้ผลรวมขาดไปครึ่งหนึ่งพอดี
    expect(detail.lines.reduce((sum, line) => sum + line.amountSatang, 0)).toBe(120000)
  })
})

describe('loadBillList / loadBillDetail — ที่ code review จับได้', () => {
  it('บอกคนจ่ายได้แม้เขาไม่ได้ร่วมหาร — รูปแบบที่ใช้บ่อยที่สุด', async () => {
    // `+ ข้าว 1200 กอล์ฟ ตูน` ระบุชื่อแล้วคนจ่ายไม่ร่วมหาร (D43) เขาจึงไม่มีแถวใน
    // `expense_share` · ก่อนแก้ การ์ดใบนี้ไม่บอกเลยว่าใครออกเงิน
    const lineGroupId = fakeLineGroupId()
    const lineUserId = fakeLineUserId()
    await recordBill(lineGroupId, lineUserId, 'เบียร์')

    const list = await loadBillList(lineGroupId, lineUserId)
    if (list === 'no-bills') throw new Error('ต้องมีบิล')
    const first = list.bills[0]
    if (first === undefined) throw new Error('ต้องมีบิล')

    const detail = await loadBillDetail({ expenseId: first.id, lineGroupId, lineUserId })
    if (detail === 'not-found' || detail === 'voided') throw new Error(`ไม่ควรได้ ${detail}`)
    expect(detail.payerName).toBe('เบียร์')
    expect(detail.lines.map((line) => line.name)).not.toContain('เบียร์')
  })

  it('ยอดในแถวรายการตรงกับยอดในการ์ดรายละเอียดเป๊ะ', async () => {
    // สองที่คิดคนละทางเมื่อไหร่ คนกดแถวจะเห็นเลขไม่ตรงกับที่เพิ่งอ่าน
    const lineGroupId = fakeLineGroupId()
    const lineUserId = fakeLineUserId()
    await recordBill(lineGroupId, lineUserId, 'เบียร์')

    const list = await loadBillList(lineGroupId, lineUserId)
    if (list === 'no-bills') throw new Error('ต้องมีบิล')
    const first = list.bills[0]
    if (first === undefined) throw new Error('ต้องมีบิล')

    const detail = await loadBillDetail({ expenseId: first.id, lineGroupId, lineUserId })
    if (detail === 'not-found' || detail === 'voided') throw new Error(`ไม่ควรได้ ${detail}`)
    expect(first.totalSatang).toBe(
      detail.lines.reduce((sum, line) => sum + line.amountSatang, 0),
    )
  })
})

/**
 * `ยอด #เชียงใหม่` — **สรุปของบิลที่ติดแท็ก ไม่ใช่ยอดค้าง** (D60)
 *
 * `settlement` ไม่มี `event_tag` และไม่ชี้ `expense` (D33 ตั้งใจ) — เงินที่จ่ายคืน
 * กันแล้วจึงไม่มีทางรู้ว่าเป็นของทริปไหน · เส้นนี้จึงคิดจากบิลอย่างเดียว และคำบน
 * การ์ดเป็นตัวบอกเรื่องนั้น (`lib/line/flex.ts`)
 */
describe('loadBalance — กรองตามแท็ก (D60)', () => {
  /**
   * บิลติดแท็กหนึ่งใบ (เบียร์ออก ฿1,200) กับบิลที่ไม่ติดแท็กหนึ่งใบ (แนนออก ฿600)
   * — คนจ่ายคนละคนเพราะ `payer: new` ตั้งชื่อให้คนพิมพ์ ซึ่งทำได้ครั้งเดียวต่อคน
   */
  async function twoBills(): Promise<{ lineGroupId: string; lineUserId: string }> {
    const lineGroupId = fakeLineGroupId()
    const lineUserId = fakeLineUserId()
    await recordBill(lineGroupId, lineUserId, 'เบียร์', undefined, {
      ...DRAFT,
      eventTag: 'เชียงใหม่',
    })
    await recordBill(lineGroupId, fakeLineUserId(), 'แนน', [
      { name: 'กอล์ฟ', amountSatang: 60000, isNew: false, isPayer: false },
    ], {
      ...DRAFT,
      description: 'ข้าวเช้า',
      totalSatang: 60000,
      participants: [{ name: 'กอล์ฟ', weight: 1 }],
    })
    return { lineGroupId, lineUserId }
  }

  it('นับเฉพาะบิลที่ติดแท็กนั้น', async () => {
    const { lineGroupId, lineUserId } = await twoBills()

    const view = await loadBalance(lineGroupId, lineUserId, 'เชียงใหม่')
    if (typeof view === 'string' || view.kind !== 'debts') throw new Error('ต้องมีตัวเลข')
    expect(view.blocks).toEqual([
      {
        creditorName: 'เบียร์',
        totalSatang: 120000,
        rows: [
          { debtorName: 'กอล์ฟ', amountSatang: 60000 },
          { debtorName: 'ตูน', amountSatang: 60000 },
        ],
      },
    ])
  })

  it('ไม่ส่งแท็กมา = ยอดทั้งวงตามเดิม รวมบิลที่ไม่ได้ติดแท็ก', async () => {
    const { lineGroupId, lineUserId } = await twoBills()

    const view = await loadBalance(lineGroupId, lineUserId)
    if (typeof view === 'string' || view.kind !== 'debts') throw new Error('ต้องมีหนี้')
    expect(view.blocks.map((b) => b.creditorName).sort()).toEqual(['เบียร์', 'แนน'])
  })

  /**
   * ตอบ `no-bills` แล้วชั้นบนจะตอบไกด์ ซึ่งเป็นคำตอบของวงที่ยังไม่เคยใช้ — ผิดคำถาม
   * ของคนที่เพิ่งพิมพ์ชื่อแท็กมาเอง
   */
  it('แท็กที่ไม่มีบิลเลย ต่างจากวงที่ยังไม่เคยจดบิล', async () => {
    const { lineGroupId, lineUserId } = await twoBills()

    expect(await loadBalance(lineGroupId, lineUserId, 'ปีใหม่')).toBe('no-bills-for-tag')
    expect(await loadBalance(fakeLineGroupId(), fakeLineUserId(), 'ปีใหม่')).toBe('no-bills')
  })

  it('เทียบชื่อแท็กตรงตัว ไม่ใช่บางส่วน', async () => {
    const { lineGroupId, lineUserId } = await twoBills()

    expect(await loadBalance(lineGroupId, lineUserId, 'เชียง')).toBe('no-bills-for-tag')
  })

  /**
   * บิลที่ยกเลิกแล้วยังอยู่ในตาราง (D18 ไม่ลบอะไร) — `computeDebts` ข้ามให้เอง ·
   * แท็กที่เหลือแต่บิลที่ถูกยกเลิกจึงเป็น "หารกันลงตัว" ไม่ใช่ "ไม่มีบิล"
   */
  it('บิลที่ถูกยกเลิกไม่ถูกนับ แต่แท็กยังมีอยู่', async () => {
    const lineGroupId = fakeLineGroupId()
    const lineUserId = fakeLineUserId()
    await recordBill(lineGroupId, lineUserId, 'เบียร์', undefined, {
      ...DRAFT,
      eventTag: 'เชียงใหม่',
    })
    const list = await loadBillList(lineGroupId, lineUserId)
    if (list === 'no-bills') throw new Error('ต้องมีบิลก่อนยกเลิก')
    const first = list.bills[0]
    if (first === undefined) throw new Error('ต้องมีบิลก่อนยกเลิก')
    await voidExpense(first.id)

    expect(await loadBalance(lineGroupId, lineUserId, 'เชียงใหม่')).toEqual({ kind: 'settled' })
  })

  it('แชท 1:1 กรองได้เหมือนกัน', async () => {
    const lineUserId = fakeLineUserId()
    await recordBill(null, lineUserId, 'ฉัน', undefined, { ...DRAFT, eventTag: 'เชียงใหม่' })

    const view = await loadBalance(null, lineUserId, 'เชียงใหม่')
    if (typeof view === 'string' || view.kind !== 'debts') throw new Error('ต้องมีตัวเลข')
    expect(view.blocks[0]?.creditorName).toBe('ฉัน')
  })
})
