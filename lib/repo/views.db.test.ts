/**
 * มุมมองที่ webhook ใช้ — ต่อจาก repo จริงทั้งเส้น
 *
 * เทสต์ชุดนี้เดินเส้นทางเดียวกับที่ผู้ใช้เดิน: จดบิล → กดยืนยัน → ถามยอด · สิ่งที่
 * ต้องคุมคือ **ยอดในการ์ด `ยอด` ต้องตรงกับยอดที่ลง ledger ไปจริง**
 */

import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { closePool } from '@/lib/db/client'
import { makeGroup } from '@/lib/db/fixtures'
import { confirmDraft } from './confirm'
import { createDraft } from './drafts'
import { markMemberLeft } from './members'
import { loadBalance, loadGroupView } from './views'
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
  surchargePct: 0,
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
    if (view === 'no-bills' || view.kind !== 'debts') throw new Error('ต้องมีหนี้')
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
    if (view === 'no-bills' || view.kind !== 'debts') throw new Error('ต้องมีหนี้')
    expect(view.blocks.map((b) => b.creditorName)).toEqual(['เบียร์', 'แนน'])
  })

  it('แชท 1:1 อ่านวงส่วนตัวของคนนั้น', async () => {
    const lineUserId = fakeLineUserId()
    await recordBill(null, lineUserId, 'ฉัน')

    const view = await loadBalance(null, lineUserId)
    if (view === 'no-bills' || view.kind !== 'debts') throw new Error('ต้องมีหนี้')
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
    if (view === 'no-bills' || view.kind !== 'debts') throw new Error('ต้องมีหนี้')
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
