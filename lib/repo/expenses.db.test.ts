/**
 * โมดูล C — expenses
 *
 * เทสต์ชุดนี้พิสูจน์สามเรื่องที่พังแล้วเจ็บที่สุด:
 * 1. สูตร surcharge ฝั่ง `splitExpense` กับฝั่งที่ตรวจก่อนเขียน DB ตรงกันจริง
 *    — ป้อนผลจริงของ `splitExpense` เข้า `commitExpense` แล้วต้องผ่านทุกเคส
 * 2. commit ที่พังกลางคันไม่ทิ้งแถว `expense` ลอยไว้
 * 3. ลำดับที่คืนออกมา deterministic — หน้าจอไม่สลับที่เองระหว่าง refresh
 *
 * ทุกเทสต์สร้างวงของตัวเองแล้ว assert เฉพาะในวงนั้น ห้าม TRUNCATE
 */

import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { closePool, getPool, withTransaction, type Queryable } from '@/lib/db/client'
import type { Expense, Member } from '@/lib/db/rows'
import {
  makeExpense,
  makeGroup,
  makeMembers,
  uniqueName,
  voidExpense as voidExpenseFixture,
} from '@/lib/db/fixtures'
import { addSurcharge, splitExpense } from '@/lib/split'
import type { MemberId, SplitInput } from '@/lib/types'
import {
  commitExpense,
  findExpenseById,
  listExpenses,
  voidExpense,
  type CommitExpenseInput,
} from '@/lib/repo/expenses'

afterAll(async () => {
  await closePool()
})

// ─── ตัวช่วยของเทสต์ ──────────────────────────────────────────────────

async function makeTrio(groupId: string): Promise<[Member, Member, Member]> {
  const [a, b, c] = await makeMembers(groupId, [
    uniqueName('ก'),
    uniqueName('ข'),
    uniqueName('ค'),
  ])
  if (!a || !b || !c) throw new Error('fixture ไม่ได้สร้างสมาชิกครบสามคน')
  return [a, b, c]
}

async function countExpenses(groupId: string, db: Queryable = getPool()): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from expense where group_id = $1`,
    [groupId],
  )
  return rows[0]?.n ?? -1
}

async function countShares(expenseId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `select count(*)::int as n from expense_share where expense_id = $1`,
    [expenseId],
  )
  return rows[0]?.n ?? -1
}

async function shareAmounts(expenseId: string): Promise<Map<MemberId, number>> {
  const { rows } = await getPool().query<{ member_id: string; amount_satang: number }>(
    `select member_id, amount_satang from expense_share where expense_id = $1`,
    [expenseId],
  )
  return new Map(rows.map(r => [r.member_id, r.amount_satang]))
}

/** อินพุตที่ถูกต้องหนึ่งชุด — เทสต์ที่พิสูจน์ข้อผิดพลาดค่อย override ทีละอย่าง */
function validInput(
  groupId: string,
  payer: Member,
  other: Member,
): CommitExpenseInput {
  return {
    groupId,
    description: 'ข้าวเย็น',
    totalSatang: 120000,
    surchargePct: 0,
    payerMemberId: payer.id,
    splitMode: 'equal',
    spentAt: '2026-02-01',
    createdBy: payer.id,
    source: 'rule',
    shares: [
      { memberId: payer.id, amountSatang: 60000 },
      { memberId: other.id, amountSatang: 60000 },
    ],
  }
}

/**
 * ป้อน **ผลจริง** ของ `splitExpense` เข้า `commitExpense`
 *
 * นี่คือข้อพิสูจน์ว่าสูตรที่ `split.ts` ใช้แตกบิล กับสูตรที่ repository ใช้ตรวจ
 * invariant ก่อนเขียน เป็นสูตรเดียวกันจริง ไม่ใช่สองสูตรที่บังเอิญตรงกันวันนี้
 */
async function commitFromSplit(
  groupId: string,
  split: SplitInput,
  items?: CommitExpenseInput['items'],
): Promise<{ expense: Expense; grandTotal: number }> {
  const shares = splitExpense(split)
  const base: CommitExpenseInput = {
    groupId,
    description: 'บิลจาก splitExpense',
    totalSatang: split.totalSatang,
    surchargePct: split.surchargePct,
    payerMemberId: split.payerId,
    splitMode: split.mode,
    spentAt: '2026-02-01',
    createdBy: split.payerId,
    source: 'rule',
    shares: shares.map(s => ({ memberId: s.memberId, amountSatang: s.amountSatang })),
  }
  const input: CommitExpenseInput = items === undefined ? base : { ...base, items }
  const expense = await commitExpense(input)
  return { expense, grandTotal: addSurcharge(split.totalSatang, split.surchargePct) }
}

// ─── commitExpense ────────────────────────────────────────────────────

describe('commitExpense', () => {
  it('เขียน expense พร้อม shares แล้วคืน record ที่ map เป็น camelCase', async () => {
    const group = await makeGroup()
    const [payer, other] = await makeTrio(group.id)

    const expense = await commitExpense({
      ...validInput(group.id, payer, other),
      eventTag: 'เชียงใหม่',
    })

    expect(expense.groupId).toBe(group.id)
    expect(expense.description).toBe('ข้าวเย็น')
    expect(expense.totalSatang).toBe(120000)
    expect(expense.surchargePct).toBe(0)
    expect(expense.payerMemberId).toBe(payer.id)
    expect(expense.splitMode).toBe('equal')
    expect(expense.spentAt).toBe('2026-02-01')
    expect(expense.eventTag).toBe('เชียงใหม่')
    expect(expense.source).toBe('rule')
    expect(expense.status).toBe('active')
    expect(expense.voidedAt).toBeNull()

    const amounts = await shareAmounts(expense.id)
    expect(amounts.get(payer.id)).toBe(60000)
    expect(amounts.get(other.id)).toBe(60000)
  })

  it('เก็บ weight ของโหมด share ไว้เพื่อให้แก้บิลทีหลังรู้ที่มาของยอด', async () => {
    const group = await makeGroup()
    const [payer, other] = await makeTrio(group.id)

    const expense = await commitExpense({
      ...validInput(group.id, payer, other),
      splitMode: 'share',
      totalSatang: 90000,
      shares: [
        { memberId: payer.id, amountSatang: 60000, weight: 2 },
        { memberId: other.id, amountSatang: 30000, weight: 1 },
      ],
    })

    const { rows } = await getPool().query<{ member_id: string; weight: string | null }>(
      `select member_id, weight from expense_share where expense_id = $1`,
      [expense.id],
    )
    const weights = new Map(rows.map(r => [r.member_id, r.weight]))
    expect(Number(weights.get(payer.id))).toBe(2)
    expect(Number(weights.get(other.id))).toBe(1)
  })

  it('ยอมให้ share เป็น 0 ได้ในโหมด exact — คนที่มาแต่ไม่ได้กิน', async () => {
    const group = await makeGroup()
    const [payer, other] = await makeTrio(group.id)

    const expense = await commitExpense({
      ...validInput(group.id, payer, other),
      splitMode: 'exact',
      shares: [
        { memberId: payer.id, amountSatang: 120000 },
        { memberId: other.id, amountSatang: 0 },
      ],
    })

    const amounts = await shareAmounts(expense.id)
    expect(amounts.get(other.id)).toBe(0)
  })
})

// ─── สูตรสองฝั่งต้องตรงกัน ────────────────────────────────────────────

describe('commitExpense รับผลจริงของ splitExpense', () => {
  it('equal ที่หารลงตัว', async () => {
    const group = await makeGroup()
    const [a, b, c] = await makeTrio(group.id)
    const { expense, grandTotal } = await commitFromSplit(group.id, {
      totalSatang: 120000,
      surchargePct: 0,
      payerId: a.id,
      mode: 'equal',
      participants: [{ memberId: a.id }, { memberId: b.id }, { memberId: c.id }],
    })

    const amounts = await shareAmounts(expense.id)
    expect([...amounts.values()].reduce((s, n) => s + n, 0)).toBe(grandTotal)
    expect([...amounts.values()]).toEqual([40000, 40000, 40000])
  })

  it('equal ที่มีเศษ — Payer รับเศษเอง', async () => {
    const group = await makeGroup()
    const [a, b, c] = await makeTrio(group.id)
    const { expense, grandTotal } = await commitFromSplit(group.id, {
      totalSatang: 100001,
      surchargePct: 0,
      payerId: a.id,
      mode: 'equal',
      participants: [{ memberId: a.id }, { memberId: b.id }, { memberId: c.id }],
    })

    const amounts = await shareAmounts(expense.id)
    expect([...amounts.values()].reduce((s, n) => s + n, 0)).toBe(grandTotal)
    expect(amounts.get(a.id)).toBe(33334)
  })

  it('surcharge 17% — เคสที่สูตรเขียนเองด้วย float จะเพี้ยน', async () => {
    const group = await makeGroup()
    const [a, b, c] = await makeTrio(group.id)
    const { expense, grandTotal } = await commitFromSplit(group.id, {
      totalSatang: 100000,
      surchargePct: 17,
      payerId: a.id,
      mode: 'equal',
      participants: [{ memberId: a.id }, { memberId: b.id }, { memberId: c.id }],
    })

    expect(grandTotal).toBe(117000)
    const amounts = await shareAmounts(expense.id)
    expect([...amounts.values()].reduce((s, n) => s + n, 0)).toBe(117000)
  })

  it('surcharge ที่ตกครึ่งพอดี — สูตร float จะได้คนละยอดกับสูตร BigInt', async () => {
    const group = await makeGroup()
    const [a, b] = await makeTrio(group.id)
    // 6450 × 1.17 = 7546.5 พอดี ปัดครึ่งขึ้นได้ 7547
    // แต่ `Math.round(6450 * (1 + 17/100))` ได้ 7546 เพราะ 1.17 ใน IEEE754
    // เล็กกว่าค่าจริงนิดเดียว — เคสนี้คือตัวจับว่าฝั่ง repository เผลอเขียนสูตรเอง
    const { expense, grandTotal } = await commitFromSplit(group.id, {
      totalSatang: 6450,
      surchargePct: 17,
      payerId: a.id,
      mode: 'equal',
      participants: [{ memberId: a.id }, { memberId: b.id }],
    })

    expect(grandTotal).toBe(7547)
    const amounts = await shareAmounts(expense.id)
    expect([...amounts.values()].reduce((s, n) => s + n, 0)).toBe(7547)
    expect(expense.totalSatang).toBe(6450)
  })

  it('share ที่น้ำหนักไม่เท่ากัน พร้อม surcharge', async () => {
    const group = await makeGroup()
    const [a, b, c] = await makeTrio(group.id)
    const { expense, grandTotal } = await commitFromSplit(group.id, {
      totalSatang: 79999,
      surchargePct: 17,
      payerId: a.id,
      mode: 'share',
      participants: [
        { memberId: a.id, weight: 2 },
        { memberId: b.id, weight: 1 },
        { memberId: c.id, weight: 1.5 },
      ],
    })

    const amounts = await shareAmounts(expense.id)
    expect([...amounts.values()].reduce((s, n) => s + n, 0)).toBe(grandTotal)
  })

  it('exact ที่มี surcharge — กระจายตามสัดส่วน subtotal', async () => {
    const group = await makeGroup()
    const [a, b, c] = await makeTrio(group.id)
    const { expense, grandTotal } = await commitFromSplit(group.id, {
      totalSatang: 100000,
      surchargePct: 7,
      payerId: a.id,
      mode: 'exact',
      participants: [
        { memberId: a.id, exactSatang: 50000 },
        { memberId: b.id, exactSatang: 30000 },
        { memberId: c.id, exactSatang: 20000 },
      ],
    })

    const amounts = await shareAmounts(expense.id)
    expect([...amounts.values()].reduce((s, n) => s + n, 0)).toBe(grandTotal)
  })

  it('itemized — เขียน expense_item และ expense_item_share ครบในบิลเดียวกัน', async () => {
    const group = await makeGroup()
    const [a, b, c] = await makeTrio(group.id)
    const { expense, grandTotal } = await commitFromSplit(
      group.id,
      {
        totalSatang: 30000,
        surchargePct: 17,
        payerId: a.id,
        mode: 'itemized',
        participants: [{ memberId: a.id }, { memberId: b.id }, { memberId: c.id }],
        items: [
          { name: 'หมู', amountSatang: 20000, memberIds: [a.id, b.id] },
          { name: 'ผัก', amountSatang: 10000, memberIds: [b.id, c.id] },
        ],
      },
      [
        { name: 'หมู', amountSatang: 20000, shares: [{ memberId: a.id }, { memberId: b.id }] },
        { name: 'ผัก', amountSatang: 10000, shares: [{ memberId: b.id }, { memberId: c.id }] },
      ],
    )

    const amounts = await shareAmounts(expense.id)
    expect([...amounts.values()].reduce((s, n) => s + n, 0)).toBe(grandTotal)

    const detail = await findExpenseById(expense.id)
    // เรียงจากชิ้นแพงสุดลงมา — ไม่พึ่ง collation ของภาษาไทยในการเทียบชื่อ
    expect(detail?.items.map(i => i.item.name)).toEqual(['หมู', 'ผัก'])
    const items = detail?.items ?? []
    const pork = items.find(i => i.item.name === 'หมู')
    expect(pork?.item.amountSatang).toBe(20000)
    expect(pork?.shares.map(s => s.memberId).sort()).toEqual([a.id, b.id].sort())
    expect(pork?.shares.every(s => s.weight === 1)).toBe(true)
  })
})

// ─── invariant กลาง ───────────────────────────────────────────────────

describe('commitExpense ปฏิเสธอินพุตที่ผิด', () => {
  it('Σ shares ไม่เท่ากับยอดรวมหลัง surcharge → throw และไม่เขียนอะไรเลย', async () => {
    const group = await makeGroup()
    const [payer, other] = await makeTrio(group.id)

    await expect(
      commitExpense({
        ...validInput(group.id, payer, other),
        surchargePct: 17,
        shares: [
          { memberId: payer.id, amountSatang: 60000 },
          { memberId: other.id, amountSatang: 60000 },
        ],
      }),
    ).rejects.toThrow(/140400/)

    expect(await countExpenses(group.id)).toBe(0)
  })

  it('shares ว่าง → throw', async () => {
    const group = await makeGroup()
    const [payer, other] = await makeTrio(group.id)

    await expect(
      commitExpense({ ...validInput(group.id, payer, other), shares: [] }),
    ).rejects.toThrow(/อย่างน้อยหนึ่งคน/)
  })

  it('memberId ซ้ำใน shares → throw', async () => {
    const group = await makeGroup()
    const [payer, other] = await makeTrio(group.id)

    await expect(
      commitExpense({
        ...validInput(group.id, payer, other),
        shares: [
          { memberId: payer.id, amountSatang: 60000 },
          { memberId: payer.id, amountSatang: 60000 },
        ],
      }),
    ).rejects.toThrow(/ซ้ำ/)
    expect(await countExpenses(group.id)).toBe(0)
  })

  it('amountSatang ติดลบ → throw', async () => {
    const group = await makeGroup()
    const [payer, other] = await makeTrio(group.id)

    await expect(
      commitExpense({
        ...validInput(group.id, payer, other),
        shares: [
          { memberId: payer.id, amountSatang: 130000 },
          { memberId: other.id, amountSatang: -10000 },
        ],
      }),
    ).rejects.toThrow(/ติดลบ/)
  })

  it('amountSatang ไม่ใช่ integer → throw ก่อนไปถึงการเทียบผลรวม', async () => {
    const group = await makeGroup()
    const [payer, other] = await makeTrio(group.id)

    await expect(
      commitExpense({
        ...validInput(group.id, payer, other),
        shares: [
          { memberId: payer.id, amountSatang: 60000.5 },
          { memberId: other.id, amountSatang: 59999.5 },
        ],
      }),
    ).rejects.toThrow(/integer/)
  })

  it('totalSatang ที่ไม่เป็นบวก → throw', async () => {
    const group = await makeGroup()
    const [payer, other] = await makeTrio(group.id)

    await expect(
      commitExpense({
        ...validInput(group.id, payer, other),
        totalSatang: 0,
        shares: [{ memberId: payer.id, amountSatang: 0 }],
      }),
    ).rejects.toThrow(/ยอดบิล/)
  })

  it('surchargePct นอกช่วง 0–100 → throw', async () => {
    const group = await makeGroup()
    const [payer, other] = await makeTrio(group.id)

    await expect(
      commitExpense({ ...validInput(group.id, payer, other), surchargePct: 120 }),
    ).rejects.toThrow(/surchargePct/)
  })

  it('surchargePct ที่ทศนิยมเกินสองตำแหน่ง → throw เพราะ DB เก็บได้แค่สองตำแหน่ง', async () => {
    const group = await makeGroup()
    const [payer, other] = await makeTrio(group.id)

    // numeric(5,2) จะปัด 17.005 เป็น 17.01 เงียบๆ แล้วยอดที่อ่านกลับมาจะไม่ตรง
    // กับ Σ shares ที่เพิ่งเขียนลงไป — invariant พังหลังบันทึกสำเร็จ
    await expect(
      commitExpense({ ...validInput(group.id, payer, other), surchargePct: 17.005 }),
    ).rejects.toThrow(/ทศนิยม/)
  })

  it('spentAt ที่ไม่ใช่ YYYY-MM-DD → throw', async () => {
    const group = await makeGroup()
    const [payer, other] = await makeTrio(group.id)

    await expect(
      commitExpense({ ...validInput(group.id, payer, other), spentAt: '1/2/2026' }),
    ).rejects.toThrow(/spentAt/)
  })

  it('description ว่าง → throw', async () => {
    const group = await makeGroup()
    const [payer, other] = await makeTrio(group.id)

    await expect(
      commitExpense({ ...validInput(group.id, payer, other), description: '   ' }),
    ).rejects.toThrow(/รายละเอียด/)
  })

  it('สมาชิกจากคนละวง → throw ก่อนเขียน (ไม่มี FK ตัวไหนกันให้)', async () => {
    const group = await makeGroup()
    const otherGroup = await makeGroup()
    const [payer] = await makeTrio(group.id)
    const [stranger] = await makeTrio(otherGroup.id)

    await expect(
      commitExpense({
        ...validInput(group.id, payer, stranger),
        shares: [
          { memberId: payer.id, amountSatang: 60000 },
          { memberId: stranger.id, amountSatang: 60000 },
        ],
      }),
    ).rejects.toThrow(/คนละวง/)
    expect(await countExpenses(group.id)).toBe(0)
  })

  /**
   * `weight numeric(8,3)` เก็บได้สูงสุด 99999.999 — ค่าที่เกินต้องตายที่ `assertInput`
   * ไม่ใช่ไปตายกลาง `insertShares` ด้วย `numeric field overflow` ดิบๆ หลังจาก
   * transaction เปิดและ `insertExpense` ผ่านไปแล้ว
   */
  it('น้ำหนักเกินความกว้างของคอลัมน์ → throw ก่อนเปิด transaction', async () => {
    const group = await makeGroup()
    const [payer, other] = await makeTrio(group.id)

    await expect(
      commitExpense({
        ...validInput(group.id, payer, other),
        splitMode: 'share',
        shares: [
          { memberId: payer.id, amountSatang: 60000, weight: 1000000 },
          { memberId: other.id, amountSatang: 60000, weight: 1 },
        ],
      }),
    ).rejects.toThrow(/น้ำหนัก/)
    expect(await countExpenses(group.id)).toBe(0)
  })

  it('น้ำหนักที่ขอบพอดี (99999.999) ยังผ่าน', async () => {
    const group = await makeGroup()
    const [payer, other] = await makeTrio(group.id)

    const expense = await commitExpense({
      ...validInput(group.id, payer, other),
      splitMode: 'share',
      shares: [
        { memberId: payer.id, amountSatang: 60000, weight: 99999.999 },
        { memberId: other.id, amountSatang: 60000, weight: 1 },
      ],
    })
    expect(await countShares(expense.id)).toBe(2)
  })

  it("splitMode='itemized' ที่ไม่ส่ง items → throw", async () => {
    const group = await makeGroup()
    const [payer, other] = await makeTrio(group.id)

    await expect(
      commitExpense({ ...validInput(group.id, payer, other), splitMode: 'itemized' }),
    ).rejects.toThrow(/items/)
  })

  it('ส่ง items มาในโหมดที่ไม่ใช่ itemized → throw', async () => {
    const group = await makeGroup()
    const [payer, other] = await makeTrio(group.id)

    await expect(
      commitExpense({
        ...validInput(group.id, payer, other),
        items: [
          { name: 'หมู', amountSatang: 120000, shares: [{ memberId: payer.id }] },
        ],
      }),
    ).rejects.toThrow(/items/)
  })

  it('ผลรวมราคารายการไม่เท่ากับยอดบิล → throw', async () => {
    const group = await makeGroup()
    const [payer, other] = await makeTrio(group.id)

    await expect(
      commitExpense({
        ...validInput(group.id, payer, other),
        splitMode: 'itemized',
        items: [
          { name: 'หมู', amountSatang: 100000, shares: [{ memberId: payer.id }] },
        ],
      }),
    ).rejects.toThrow(/ยอดบิล/)
    expect(await countExpenses(group.id)).toBe(0)
  })

  it('รายการที่ tag คนที่ไม่ได้ร่วมหาร → throw', async () => {
    const group = await makeGroup()
    const [payer, other, outsider] = await makeTrio(group.id)

    await expect(
      commitExpense({
        ...validInput(group.id, payer, other),
        splitMode: 'itemized',
        items: [
          { name: 'หมู', amountSatang: 120000, shares: [{ memberId: outsider.id }] },
        ],
      }),
    ).rejects.toThrow(/ไม่ได้ร่วมหาร/)
  })

  it('รายการที่ราคาไม่เป็นบวก → throw พร้อมชื่อรายการ (DB มี check เดียวกัน)', async () => {
    const group = await makeGroup()
    const [payer, other] = await makeTrio(group.id)

    await expect(
      commitExpense({
        ...validInput(group.id, payer, other),
        splitMode: 'itemized',
        items: [
          { name: 'หมู', amountSatang: 120000, shares: [{ memberId: payer.id }] },
          { name: 'น้ำเปล่า', amountSatang: 0, shares: [{ memberId: other.id }] },
        ],
      }),
    ).rejects.toThrow(/น้ำเปล่า/)
    expect(await countExpenses(group.id)).toBe(0)
  })

  it('รายการที่ไม่มีคนกิน → throw', async () => {
    const group = await makeGroup()
    const [payer, other] = await makeTrio(group.id)

    await expect(
      commitExpense({
        ...validInput(group.id, payer, other),
        splitMode: 'itemized',
        items: [{ name: 'หมู', amountSatang: 120000, shares: [] }],
      }),
    ).rejects.toThrow(/ไม่มีคนกิน/)
  })
})

// ─── transaction ──────────────────────────────────────────────────────

describe('commitExpense กับ transaction', () => {
  it('พังกลางคันเพราะ memberId ที่ไม่มีจริง → ไม่เหลือแถว expense ลอยอยู่', async () => {
    const group = await makeGroup()
    const [payer] = await makeTrio(group.id)
    const ghost = randomUUID()

    // ยอดรวมถูกต้อง invariant จึงผ่าน แล้วไปพังที่ FK ของ expense_share
    // ซึ่งเกิด **หลัง** insert expense สำเร็จไปแล้ว — จุดที่ต้องมี rollback จริง
    await expect(
      commitExpense({
        groupId: group.id,
        description: 'บิลที่ต้องหายไปทั้งใบ',
        totalSatang: 120000,
        surchargePct: 0,
        payerMemberId: payer.id,
        splitMode: 'equal',
        spentAt: '2026-02-01',
        createdBy: payer.id,
        source: 'rule',
        shares: [
          { memberId: payer.id, amountSatang: 60000 },
          { memberId: ghost, amountSatang: 60000 },
        ],
      }),
    ).rejects.toThrow()

    expect(await countExpenses(group.id)).toBe(0)
  })

  it('ใช้ client ที่ผู้เรียกส่งมา — rollback ของผู้เรียกลบบิลนี้ไปด้วย', async () => {
    const group = await makeGroup()
    const [payer, other] = await makeTrio(group.id)
    const abort = new Error('ผู้เรียกล้ม transaction ของตัวเอง')

    await expect(
      withTransaction(async tx => {
        await commitExpense(validInput(group.id, payer, other), tx)
        // เห็นแถวของตัวเองใน transaction เดียวกัน = ใช้ client ที่ส่งมาจริง
        expect(await countExpenses(group.id, tx)).toBe(1)
        throw abort
      }),
    ).rejects.toBe(abort)

    expect(await countExpenses(group.id)).toBe(0)
  })

  /**
   * `Pool` ก็มีเมธอด `query` เหมือน `PoolClient` — ถ้ารับมาเฉยๆ `commitExpense`
   * จะเข้าใจผิดว่าผู้เรียกเปิด transaction ไว้แล้ว ทั้งที่ statement สามชุดกำลัง
   * วิ่งแบบ autocommit คนละ connection แล้วบิลที่ share ไม่ครบจะค้างอยู่จริง
   */
  it('ส่ง Pool มาแทน client ใน transaction → throw ไม่ใช่เขียนแบบ autocommit', async () => {
    const group = await makeGroup()
    const [payer, other] = await makeTrio(group.id)

    await expect(
      commitExpense(
        validInput(group.id, payer, other),
        getPool() as unknown as PoolClient,
      ),
    ).rejects.toThrow(/transaction/)
    expect(await countExpenses(group.id)).toBe(0)
  })

  it('ผู้เรียก commit transaction เอง → บิลอยู่ครบ', async () => {
    const group = await makeGroup()
    const [payer, other] = await makeTrio(group.id)

    const expense = await withTransaction(tx =>
      commitExpense(validInput(group.id, payer, other), tx),
    )

    expect(await countExpenses(group.id)).toBe(1)
    expect(await countShares(expense.id)).toBe(2)
  })
})

// ─── findExpenseById ──────────────────────────────────────────────────

describe('findExpenseById', () => {
  it('คืน shares ครบและเรียงเหมือนเดิมทุกครั้งที่เรียก', async () => {
    const group = await makeGroup()
    const [a, b, c] = await makeTrio(group.id)
    const expense = await commitExpense({
      groupId: group.id,
      description: 'หมูกระทะ',
      totalSatang: 90000,
      surchargePct: 0,
      payerMemberId: a.id,
      splitMode: 'equal',
      spentAt: '2026-03-02',
      createdBy: a.id,
      source: 'llm',
      shares: [
        { memberId: a.id, amountSatang: 30000 },
        { memberId: b.id, amountSatang: 30000 },
        { memberId: c.id, amountSatang: 30000 },
      ],
    })

    const first = await findExpenseById(expense.id)
    const second = await findExpenseById(expense.id)

    expect(first?.expense.id).toBe(expense.id)
    expect(first?.shares).toHaveLength(3)
    expect(first?.items).toEqual([])
    expect(second?.shares.map(s => s.memberId)).toEqual(first?.shares.map(s => s.memberId))
    expect([...(first?.shares ?? [])].map(s => s.memberId).sort()).toEqual(
      [a.id, b.id, c.id].sort(),
    )
    expect(first?.shares.every(s => s.amountSatang === 30000)).toBe(true)
  })

  it('คืน null เมื่อไม่เจอ', async () => {
    expect(await findExpenseById(randomUUID())).toBeNull()
  })
})

// ─── listExpenses ─────────────────────────────────────────────────────

describe('listExpenses', () => {
  async function seed(groupId: string, payer: Member, spentAts: readonly string[]) {
    const out: Expense[] = []
    for (const spentAt of spentAts) {
      out.push(
        await commitExpense({
          groupId,
          description: `บิล ${spentAt}`,
          totalSatang: 10000,
          surchargePct: 0,
          payerMemberId: payer.id,
          splitMode: 'equal',
          spentAt,
          createdBy: payer.id,
          source: 'rule',
          shares: [{ memberId: payer.id, amountSatang: 10000 }],
        }),
      )
    }
    return out
  }

  it('เรียง spentAt จากใหม่ไปเก่า', async () => {
    const group = await makeGroup()
    const [payer] = await makeTrio(group.id)
    await seed(group.id, payer, ['2026-01-05', '2026-03-01', '2026-02-10'])

    const list = await listExpenses(group.id)
    expect(list.map(e => e.spentAt)).toEqual(['2026-03-01', '2026-02-10', '2026-01-05'])
  })

  it('ลำดับคงที่เมื่อวันซ้ำกัน — เรียกซ้ำได้ผลเดิมทุกครั้ง', async () => {
    const group = await makeGroup()
    const [payer] = await makeTrio(group.id)
    await seed(group.id, payer, Array.from({ length: 5 }, () => '2026-04-04'))

    const runs = [
      await listExpenses(group.id),
      await listExpenses(group.id),
      await listExpenses(group.id),
    ]
    const ids = runs.map(run => run.map(e => e.id))
    expect(ids[0]).toHaveLength(5)
    expect(ids[1]).toEqual(ids[0])
    expect(ids[2]).toEqual(ids[0])
  })

  it('ตัดบิลที่ voided ออกโดยปริยาย แต่ includeVoided ดึงกลับมาได้', async () => {
    const group = await makeGroup()
    const [payer] = await makeTrio(group.id)
    const [keep, dropped] = await seed(group.id, payer, ['2026-05-01', '2026-05-02'])
    if (!keep || !dropped) throw new Error('seed ไม่ครบ')
    await voidExpenseFixture(dropped.id)

    const visible = await listExpenses(group.id)
    expect(visible.map(e => e.id)).toEqual([keep.id])

    const all = await listExpenses(group.id, { includeVoided: true })
    expect(all.map(e => e.id).sort()).toEqual([keep.id, dropped.id].sort())
  })

  it('กรองตาม eventTag', async () => {
    const group = await makeGroup()
    const [payer] = await makeTrio(group.id)
    const tagged = await commitExpense({
      groupId: group.id,
      description: 'ที่พัก',
      totalSatang: 50000,
      surchargePct: 0,
      payerMemberId: payer.id,
      splitMode: 'equal',
      spentAt: '2026-06-01',
      createdBy: payer.id,
      source: 'rule',
      eventTag: 'เชียงใหม่',
      shares: [{ memberId: payer.id, amountSatang: 50000 }],
    })
    await seed(group.id, payer, ['2026-06-02'])

    const list = await listExpenses(group.id, { eventTag: 'เชียงใหม่' })
    expect(list.map(e => e.id)).toEqual([tagged.id])
  })

  it('จำกัดจำนวนด้วย limit โดยยังเป็นใบล่าสุดก่อน', async () => {
    const group = await makeGroup()
    const [payer] = await makeTrio(group.id)
    await seed(group.id, payer, ['2026-07-01', '2026-07-02', '2026-07-03'])

    const list = await listExpenses(group.id, { limit: 2 })
    expect(list.map(e => e.spentAt)).toEqual(['2026-07-03', '2026-07-02'])
  })

  it('ไม่ปนบิลของวงอื่น', async () => {
    const group = await makeGroup()
    const otherGroup = await makeGroup()
    const [payer] = await makeTrio(group.id)
    const [otherPayer] = await makeTrio(otherGroup.id)
    await seed(group.id, payer, ['2026-08-01'])
    await seed(otherGroup.id, otherPayer, ['2026-08-02'])

    const list = await listExpenses(group.id)
    expect(list).toHaveLength(1)
    expect(list[0]?.groupId).toBe(group.id)
  })
})

// ─── voidExpense ──────────────────────────────────────────────────────

describe('voidExpense', () => {
  it('มาร์กว่ายกเลิกโดยไม่ลบแถวและไม่แตะ shares', async () => {
    const group = await makeGroup()
    const [payer, other] = await makeTrio(group.id)
    const expense = await commitExpense(validInput(group.id, payer, other))

    const voided = await voidExpense(expense.id)
    expect(voided.status).toBe('voided')
    expect(voided.voidedAt).toBeInstanceOf(Date)
    expect(voided.totalSatang).toBe(120000)

    expect(await countExpenses(group.id)).toBe(1)
    expect(await countShares(expense.id)).toBe(2)
  })

  it('void บิลที่ void ไปแล้ว → throw', async () => {
    const group = await makeGroup()
    const [payer, other] = await makeTrio(group.id)
    const expense = await commitExpense(validInput(group.id, payer, other))
    await voidExpense(expense.id)

    await expect(voidExpense(expense.id)).rejects.toThrow(/ยกเลิกไปแล้ว/)
  })

  it('void บิลที่ไม่มีอยู่ → throw', async () => {
    await expect(voidExpense(randomUUID())).rejects.toThrow(/ไม่พบบิล/)
  })
})

// ─── cascade ──────────────────────────────────────────────────────────

describe('on delete cascade', () => {
  it('ลบบิลที่เทสต์นี้สร้างเอง แล้ว share/item/item_share หายตาม', async () => {
    const group = await makeGroup()
    const [a, b] = await makeTrio(group.id)
    const expense = await commitExpense({
      groupId: group.id,
      description: 'บิลที่จะลบทิ้ง',
      totalSatang: 30000,
      surchargePct: 0,
      payerMemberId: a.id,
      splitMode: 'itemized',
      spentAt: '2026-09-09',
      createdBy: a.id,
      source: 'web',
      shares: [
        { memberId: a.id, amountSatang: 20000 },
        { memberId: b.id, amountSatang: 10000 },
      ],
      items: [
        { name: 'หมู', amountSatang: 20000, shares: [{ memberId: a.id }] },
        { name: 'ผัก', amountSatang: 10000, shares: [{ memberId: b.id }] },
      ],
    })

    const pool = getPool()
    const detail = await findExpenseById(expense.id)
    const itemIds = (detail?.items ?? []).map(i => i.item.id)
    expect(itemIds).toHaveLength(2)

    const countItemShares = async (): Promise<number> => {
      const { rows } = await pool.query<{ n: number }>(
        `select count(*)::int as n from expense_item_share where item_id = any($1::uuid[])`,
        [itemIds],
      )
      return rows[0]?.n ?? -1
    }
    expect(await countItemShares()).toBe(2)

    await pool.query(`delete from expense where id = $1`, [expense.id])

    expect(await countShares(expense.id)).toBe(0)
    const items = await pool.query<{ n: number }>(
      `select count(*)::int as n from expense_item where expense_id = $1`,
      [expense.id],
    )
    expect(items.rows[0]?.n).toBe(0)
    expect(await countItemShares()).toBe(0)
    expect(await findExpenseById(expense.id)).toBeNull()
  })

  it('บิลที่ fixtures สร้างไว้ก็ลบได้ — cascade ไม่ผูกกับทางที่เขียนเข้ามา', async () => {
    const group = await makeGroup()
    const [a] = await makeTrio(group.id)
    const expense = await makeExpense({
      groupId: group.id,
      payerMemberId: a.id,
      totalSatang: 10000,
      shares: [{ memberId: a.id, amountSatang: 10000 }],
    })

    await getPool().query(`delete from expense where id = $1`, [expense.id])
    expect(await countShares(expense.id)).toBe(0)
  })
})
