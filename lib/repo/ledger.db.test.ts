/**
 * โมดูล E — ledger
 *
 * ชั้นนี้ไม่คิดเลขเงินเลยสักบรรทัด หน้าที่เดียวคือโหลดวงทั้งวงมาให้
 * `lib/debt.ts` ตัดสิน (D25) เทสต์ชุดนี้จึงพิสูจน์สองเรื่อง:
 *
 * 1. **สิ่งที่โหลดมาป้อน `computeDebts` ได้ตรงๆ** ไม่ต้องแปลงอะไรอีก
 * 2. **การกรองอยู่ที่ `lib/debt.ts` ที่เดียว** — บิลที่ void และ settlement ที่ยัง
 *    ไม่ confirmed ต้อง**มาถึง** `computeDebts` ไม่ใช่ถูก SQL กรองทิ้งก่อน
 *    ถ้ากรองสองที่ วันที่กติกาเปลี่ยนจะมีที่ต้องแก้สองแห่งที่ไม่มีใครเตือน
 *
 * ค่าคาดหวังทุกค่าคำนวณด้วยมือในเทสต์ ไม่ได้เรียก `computeDebts` มาเทียบกับตัวเอง
 *
 * ทุกเทสต์สร้างวงของตัวเองแล้ว assert เฉพาะในวงนั้น ห้าม TRUNCATE
 */

import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { closePool, getPool, withTransaction } from '@/lib/db/client'
import {
  makeAppUser,
  makeExpense,
  makeGroup,
  makeMember,
  makeMembers,
  makeSettlement,
  uniqueName,
  voidExpense,
} from '@/lib/db/fixtures'
import type { Member } from '@/lib/db/rows'
import { computeDebts, floatOf } from '@/lib/debt'
import { softDeleteGroup } from '@/lib/repo/groups'
import { markMemberLeft } from '@/lib/repo/members'
import { floatAcrossGroups, loadLedger, loadLedgersForAppUser } from '@/lib/repo/ledger'
import type { MemberId, PairDebt } from '@/lib/types'

afterAll(async () => {
  await closePool()
})

async function makeTrio(groupId: string): Promise<[Member, Member, Member]> {
  const [a, b, c] = await makeMembers(groupId, [
    uniqueName('ก'),
    uniqueName('ข'),
    uniqueName('ค'),
  ])
  if (!a || !b || !c) throw new Error('fixture ไม่ได้สร้างสมาชิกครบสามคน')
  return [a, b, c]
}

/** หนี้ของคู่หนึ่งคู่ในผลลัพธ์ — `0` เมื่อคู่นั้นเคลียร์กันแล้ว */
function owed(debts: PairDebt[], debtorId: MemberId, creditorId: MemberId): number {
  const hit = debts.find(d => d.debtorId === debtorId && d.creditorId === creditorId)
  return hit?.amountSatang ?? 0
}

// ─── loadLedger ───────────────────────────────────────────────────────

describe('loadLedger', () => {
  it('วงเปล่าคืนสองอาเรย์ว่าง ไม่ใช่ throw', async () => {
    const group = await makeGroup()
    expect(await loadLedger(group.id)).toEqual({ expenses: [], settlements: [] })
  })

  it('บิลใบเดียวสามคน — ป้อน computeDebts ได้ตรงๆ', async () => {
    const group = await makeGroup()
    const [a, b, c] = await makeTrio(group.id)
    // ก ควัก 300 บาท หารสามคนละ 100 — ข กับ ค ติด ก คนละ 10000 สตางค์
    await makeExpense({
      groupId: group.id,
      payerMemberId: a.id,
      totalSatang: 30000,
      shares: [
        { memberId: a.id, amountSatang: 10000 },
        { memberId: b.id, amountSatang: 10000 },
        { memberId: c.id, amountSatang: 10000 },
      ],
    })

    const ledger = await loadLedger(group.id)
    expect(ledger.expenses).toHaveLength(1)
    expect(ledger.expenses[0]?.payerId).toBe(a.id)
    expect(ledger.expenses[0]?.shares).toHaveLength(3)
    expect(ledger.settlements).toEqual([])

    const debts = computeDebts(ledger.expenses, ledger.settlements)
    expect(owed(debts, b.id, a.id)).toBe(10000)
    expect(owed(debts, c.id, a.id)).toBe(10000)
    // ก ไม่ติดตัวเอง — share ของคนจ่ายไม่ใช่หนี้
    expect(debts).toHaveLength(2)
    expect(floatOf(debts, a.id)).toBe(20000)
    expect(floatOf(debts, b.id)).toBe(0)
  })

  it('สองบิลสวนทางกันในคู่เดียว — หักกลบเหลือยอดเดียว', async () => {
    const group = await makeGroup()
    const [a, b] = await makeTrio(group.id)
    // ก ควัก 200 หารสอง → ข ติด ก 10000
    await makeExpense({
      groupId: group.id,
      payerMemberId: a.id,
      totalSatang: 20000,
      shares: [
        { memberId: a.id, amountSatang: 10000 },
        { memberId: b.id, amountSatang: 10000 },
      ],
    })
    // ข ควัก 60 หารสอง → ก ติด ข 3000
    await makeExpense({
      groupId: group.id,
      payerMemberId: b.id,
      totalSatang: 6000,
      shares: [
        { memberId: a.id, amountSatang: 3000 },
        { memberId: b.id, amountSatang: 3000 },
      ],
    })

    const { expenses, settlements } = await loadLedger(group.id)
    const debts = computeDebts(expenses, settlements)
    // 10000 − 3000 = 7000 เหลือทิศเดียว
    expect(debts).toHaveLength(1)
    expect(owed(debts, b.id, a.id)).toBe(7000)
  })

  it('บิลที่ void มาถึง computeDebts พร้อมธง voided — ไม่ได้ถูก SQL กรองทิ้ง', async () => {
    const group = await makeGroup()
    const [a, b] = await makeTrio(group.id)
    const dropped = await makeExpense({
      groupId: group.id,
      payerMemberId: a.id,
      totalSatang: 20000,
      shares: [
        { memberId: a.id, amountSatang: 10000 },
        { memberId: b.id, amountSatang: 10000 },
      ],
    })
    await voidExpense(dropped.id)

    const { expenses, settlements } = await loadLedger(group.id)
    // มาถึงจริง — การกรองเป็นหน้าที่ของ lib/debt.ts ที่เดียว (D25)
    expect(expenses).toHaveLength(1)
    expect(expenses[0]?.voided).toBe(true)
    expect(computeDebts(expenses, settlements)).toEqual([])
  })

  it('บิลที่ยัง active ได้ voided === false ไม่ใช่ undefined', async () => {
    const group = await makeGroup()
    const [a, b] = await makeTrio(group.id)
    await makeExpense({
      groupId: group.id,
      payerMemberId: a.id,
      totalSatang: 20000,
      shares: [
        { memberId: a.id, amountSatang: 10000 },
        { memberId: b.id, amountSatang: 10000 },
      ],
    })

    const { expenses } = await loadLedger(group.id)
    expect(expenses[0]?.voided).toBe(false)
  })

  it('settlement ทุกสถานะมาถึง computeDebts — มีแต่ confirmed ที่หักยอด', async () => {
    const group = await makeGroup()
    const [a, b] = await makeTrio(group.id)
    await makeExpense({
      groupId: group.id,
      payerMemberId: a.id,
      totalSatang: 20000,
      shares: [
        { memberId: a.id, amountSatang: 10000 },
        { memberId: b.id, amountSatang: 10000 },
      ],
    })
    // ข แจ้งจ่าย 3000 แต่ ก ยังไม่ยืนยัน → ยังไม่หัก (D8)
    await makeSettlement({
      groupId: group.id,
      fromMemberId: b.id,
      toMemberId: a.id,
      amountSatang: 3000,
      status: 'claimed',
    })
    // อันที่ ก ยืนยันแล้ว 2500 → หัก
    await makeSettlement({
      groupId: group.id,
      fromMemberId: b.id,
      toMemberId: a.id,
      amountSatang: 2500,
      status: 'confirmed',
    })
    // อันที่ถูกปฏิเสธ → ไม่หัก
    await makeSettlement({
      groupId: group.id,
      fromMemberId: b.id,
      toMemberId: a.id,
      amountSatang: 9999,
      status: 'rejected',
    })

    const { expenses, settlements } = await loadLedger(group.id)
    expect(settlements).toHaveLength(3)
    expect(settlements.map(s => s.status).sort()).toEqual(['claimed', 'confirmed', 'rejected'])

    const debts = computeDebts(expenses, settlements)
    // 10000 − 2500 = 7500
    expect(owed(debts, b.id, a.id)).toBe(7500)
    expect(floatOf(debts, a.id)).toBe(7500)
  })

  it('settlement ที่ confirmed จนเกินหนี้ → พลิกทิศทาง', async () => {
    const group = await makeGroup()
    const [a, b] = await makeTrio(group.id)
    await makeExpense({
      groupId: group.id,
      payerMemberId: a.id,
      totalSatang: 20000,
      shares: [
        { memberId: a.id, amountSatang: 10000 },
        { memberId: b.id, amountSatang: 10000 },
      ],
    })
    await makeSettlement({
      groupId: group.id,
      fromMemberId: b.id,
      toMemberId: a.id,
      amountSatang: 12000,
      status: 'confirmed',
    })

    const { expenses, settlements } = await loadLedger(group.id)
    const debts = computeDebts(expenses, settlements)
    // จ่ายเกินไป 2000 — ตอนนี้ ก ติด ข
    expect(owed(debts, a.id, b.id)).toBe(2000)
  })

  it('ไม่ปนข้อมูลของวงอื่น', async () => {
    const mine = await makeGroup()
    const theirs = await makeGroup()
    const [a, b] = await makeTrio(mine.id)
    const [x, y] = await makeTrio(theirs.id)
    await makeExpense({
      groupId: mine.id,
      payerMemberId: a.id,
      totalSatang: 20000,
      shares: [
        { memberId: a.id, amountSatang: 10000 },
        { memberId: b.id, amountSatang: 10000 },
      ],
    })
    await makeExpense({
      groupId: theirs.id,
      payerMemberId: x.id,
      totalSatang: 60000,
      shares: [
        { memberId: x.id, amountSatang: 30000 },
        { memberId: y.id, amountSatang: 30000 },
      ],
    })
    await makeSettlement({
      groupId: theirs.id,
      fromMemberId: y.id,
      toMemberId: x.id,
      amountSatang: 30000,
      status: 'confirmed',
    })

    const ledger = await loadLedger(mine.id)
    expect(ledger.expenses).toHaveLength(1)
    expect(ledger.settlements).toHaveLength(0)
    const debts = computeDebts(ledger.expenses, ledger.settlements)
    expect(debts).toEqual([{ debtorId: b.id, creditorId: a.id, amountSatang: 10000 }])
  })

  it('คนที่ออกจากกลุ่มแล้วยังอยู่ในยอด (D18 — มาร์ก ไม่ลบ)', async () => {
    const group = await makeGroup()
    const [a, b] = await makeTrio(group.id)
    await makeExpense({
      groupId: group.id,
      payerMemberId: a.id,
      totalSatang: 20000,
      shares: [
        { memberId: a.id, amountSatang: 10000 },
        { memberId: b.id, amountSatang: 10000 },
      ],
    })
    await markMemberLeft(b.id)

    const { expenses, settlements } = await loadLedger(group.id)
    const debts = computeDebts(expenses, settlements)
    expect(owed(debts, b.id, a.id)).toBe(10000)
  })

  it('สตางค์กลับมาเป็น number ไม่ใช่ string ที่ `+` แล้วต่อกัน', async () => {
    const group = await makeGroup()
    const [a, b] = await makeTrio(group.id)
    await makeExpense({
      groupId: group.id,
      payerMemberId: a.id,
      totalSatang: 240000,
      shares: [
        { memberId: a.id, amountSatang: 120000 },
        { memberId: b.id, amountSatang: 120000 },
      ],
    })
    await makeSettlement({
      groupId: group.id,
      fromMemberId: b.id,
      toMemberId: a.id,
      amountSatang: 20000,
      status: 'confirmed',
    })

    const { expenses, settlements } = await loadLedger(group.id)
    const share = expenses[0]?.shares[0]
    expect(typeof share?.amountSatang).toBe('number')
    expect(typeof settlements[0]?.amountSatang).toBe('number')
    // ถ้าเป็นสตริง ค่านี้จะกลายเป็น "120000120000"
    const total = (expenses[0]?.shares ?? []).reduce((s, x) => s + x.amountSatang, 0)
    expect(total).toBe(240000)
  })

  it('ผลลัพธ์เรียงเหมือนเดิมทุกครั้งที่เรียก', async () => {
    const group = await makeGroup()
    const [a, b, c] = await makeTrio(group.id)
    for (let i = 0; i < 5; i++) {
      await makeExpense({
        groupId: group.id,
        payerMemberId: [a, b, c][i % 3]?.id ?? a.id,
        totalSatang: 30000,
        shares: [
          { memberId: a.id, amountSatang: 10000 },
          { memberId: b.id, amountSatang: 10000 },
          { memberId: c.id, amountSatang: 10000 },
        ],
      })
    }

    const first = await loadLedger(group.id)
    const second = await loadLedger(group.id)
    expect(second).toEqual(first)
  })

  it('ใช้ client ที่ผู้เรียกส่งมา — เห็นบิลที่ยังไม่ commit ใน transaction เดียวกัน', async () => {
    const group = await makeGroup()
    const [a, b] = await makeTrio(group.id)

    await withTransaction(async tx => {
      await makeExpense(
        {
          groupId: group.id,
          payerMemberId: a.id,
          totalSatang: 20000,
          shares: [
            { memberId: a.id, amountSatang: 10000 },
            { memberId: b.id, amountSatang: 10000 },
          ],
        },
        tx,
      )
      const inside = await loadLedger(group.id, tx)
      expect(inside.expenses).toHaveLength(1)
    })

    expect((await loadLedger(group.id)).expenses).toHaveLength(1)
  })

  /**
   * บิลกับ settlement อ่านคนละคำสั่ง — ภายใต้ `read committed` แต่ละคำสั่งเห็น
   * snapshot ของตัวเอง แล้วยอดที่คืนออกไปจะเป็นยอดที่ไม่เคยมีอยู่จริง ณ เวลาใดเลย
   * เทสต์นี้พิสูจน์ว่าใน transaction แบบ `repeatable read` (ซึ่งเป็นสิ่งที่
   * `loadLedger` เปิดให้เองเมื่อผู้เรียกไม่ได้ส่ง client มา) การอ่านสองครั้ง
   * เห็นภาพเดียวกันแม้มีคน commit คั่นกลาง
   */
  it('ใน repeatable read การอ่านสองครั้งเห็น snapshot เดียวกัน', async () => {
    const group = await makeGroup()
    const [a, b] = await makeTrio(group.id)
    await makeExpense({
      groupId: group.id,
      payerMemberId: a.id,
      totalSatang: 20000,
      shares: [
        { memberId: a.id, amountSatang: 10000 },
        { memberId: b.id, amountSatang: 10000 },
      ],
    })

    await withTransaction(async tx => {
      await tx.query('set transaction isolation level repeatable read')
      expect((await loadLedger(group.id, tx)).settlements).toHaveLength(0)

      // อีก connection หนึ่งยืนยันการจ่ายแล้ว commit คั่นกลาง
      await makeSettlement({
        groupId: group.id,
        fromMemberId: b.id,
        toMemberId: a.id,
        amountSatang: 5000,
        status: 'confirmed',
      })

      expect((await loadLedger(group.id, tx)).settlements).toHaveLength(0)
    })

    expect((await loadLedger(group.id)).settlements).toHaveLength(1)
  })

  /**
   * `Pool` ก็เข้า `Queryable` ได้ ผู้เรียกที่ส่ง pool มาจึงข้าม transaction ที่
   * `loadLedger` ตั้งใจเปิดให้ แล้วสองคำสั่งจะวิ่งคนละ snapshot — ได้ยอดที่ไม่เคย
   * มีอยู่จริง ณ เวลาใดเลย ซึ่งเป็นยอดที่คนเอาไปทวงกัน
   */
  it('ส่ง Pool มาแทน client ใน transaction → throw', async () => {
    const group = await makeGroup()
    await expect(
      loadLedger(group.id, getPool() as unknown as PoolClient),
    ).rejects.toThrow(/transaction/)
  })

  it('ส่ง null มา (ผู้เรียกที่ไม่ผ่าน tsc) → เปิด transaction เอง ไม่ใช่ TypeError', async () => {
    const group = await makeGroup()
    const [a, b] = await makeTrio(group.id)
    await makeExpense({
      groupId: group.id,
      payerMemberId: a.id,
      totalSatang: 20000,
      shares: [
        { memberId: a.id, amountSatang: 10000 },
        { memberId: b.id, amountSatang: 10000 },
      ],
    })

    const ledger = await loadLedger(group.id, null as unknown as PoolClient)
    expect(ledger.expenses).toHaveLength(1)
  })
})

// ─── Float ข้ามวง ─────────────────────────────────────────────────────

describe('loadLedgersForAppUser', () => {
  it('รวมทุกวงที่ active ของคนคนเดียว — วงที่ soft-deleted ไม่นับ', async () => {
    const user = await makeAppUser()
    const alive1 = await makeGroup()
    const alive2 = await makeGroup()
    const dead = await makeGroup()

    const me1 = await makeMember(alive1.id, uniqueName('ฉัน'), undefined, { appUserId: user.id })
    const me2 = await makeMember(alive2.id, uniqueName('ฉัน'), undefined, { appUserId: user.id })
    const me3 = await makeMember(dead.id, uniqueName('ฉัน'), undefined, { appUserId: user.id })
    const friend1 = await makeMember(alive1.id)
    const friend2 = await makeMember(alive2.id)
    const friend3 = await makeMember(dead.id)

    // วงที่ 1: ฉันควัก 200 หารสอง → เพื่อนติดฉัน 10000
    await makeExpense({
      groupId: alive1.id,
      payerMemberId: me1.id,
      totalSatang: 20000,
      shares: [
        { memberId: me1.id, amountSatang: 10000 },
        { memberId: friend1.id, amountSatang: 10000 },
      ],
    })
    // วงที่ 2: ฉันควัก 500 หารสอง → เพื่อนติดฉัน 25000
    await makeExpense({
      groupId: alive2.id,
      payerMemberId: me2.id,
      totalSatang: 50000,
      shares: [
        { memberId: me2.id, amountSatang: 25000 },
        { memberId: friend2.id, amountSatang: 25000 },
      ],
    })
    // วงที่ลบไปแล้ว: ยอดใหญ่กว่าทั้งสองวงรวมกัน ถ้าหลุดเข้ามาจะเห็นทันที
    await makeExpense({
      groupId: dead.id,
      payerMemberId: me3.id,
      totalSatang: 200000,
      shares: [
        { memberId: me3.id, amountSatang: 100000 },
        { memberId: friend3.id, amountSatang: 100000 },
      ],
    })
    await softDeleteGroup(dead.id)

    const ledgers = await loadLedgersForAppUser(user.id)
    expect(ledgers.map(l => l.groupId).sort()).toEqual([alive1.id, alive2.id].sort())

    const float = floatAcrossGroups(ledgers)
    expect(float.totalSatang).toBe(35000)
    expect(
      float.byGroup.find(g => g.groupId === alive1.id)?.floatSatang,
    ).toBe(10000)
    expect(
      float.byGroup.find(g => g.groupId === alive2.id)?.floatSatang,
    ).toBe(25000)
  })

  it('เงินจมไม่หักกับยอดที่ตัวเองติดคนอื่น (ดู CONTEXT.md หัวข้อ Float)', async () => {
    const user = await makeAppUser()
    const lending = await makeGroup()
    const owing = await makeGroup()
    const me1 = await makeMember(lending.id, uniqueName('ฉัน'), undefined, { appUserId: user.id })
    const me2 = await makeMember(owing.id, uniqueName('ฉัน'), undefined, { appUserId: user.id })
    const friend1 = await makeMember(lending.id)
    const friend2 = await makeMember(owing.id)

    // วงแรก: ฉันควักแทน → เพื่อนติดฉัน 10000
    await makeExpense({
      groupId: lending.id,
      payerMemberId: me1.id,
      totalSatang: 20000,
      shares: [
        { memberId: me1.id, amountSatang: 10000 },
        { memberId: friend1.id, amountSatang: 10000 },
      ],
    })
    // วงสอง: เพื่อนควักแทน → ฉันติดเพื่อน 40000
    await makeExpense({
      groupId: owing.id,
      payerMemberId: friend2.id,
      totalSatang: 80000,
      shares: [
        { memberId: me2.id, amountSatang: 40000 },
        { memberId: friend2.id, amountSatang: 40000 },
      ],
    })

    const float = floatAcrossGroups(await loadLedgersForAppUser(user.id))
    // เงินจม = 10000 เท่านั้น ไม่ใช่ 10000 − 40000
    expect(float.totalSatang).toBe(10000)
  })

  it('settlement ที่ confirmed ลดเงินจมของวงนั้น', async () => {
    const user = await makeAppUser()
    const group = await makeGroup()
    const me = await makeMember(group.id, uniqueName('ฉัน'), undefined, { appUserId: user.id })
    const friend = await makeMember(group.id)
    await makeExpense({
      groupId: group.id,
      payerMemberId: me.id,
      totalSatang: 20000,
      shares: [
        { memberId: me.id, amountSatang: 10000 },
        { memberId: friend.id, amountSatang: 10000 },
      ],
    })
    await makeSettlement({
      groupId: group.id,
      fromMemberId: friend.id,
      toMemberId: me.id,
      amountSatang: 4000,
      status: 'confirmed',
    })

    const float = floatAcrossGroups(await loadLedgersForAppUser(user.id))
    expect(float.totalSatang).toBe(6000)
  })

  it('คนที่ยังไม่มีวงไหนเลยได้ 0 ไม่ใช่ throw', async () => {
    const user = await makeAppUser()
    const ledgers = await loadLedgersForAppUser(user.id)
    expect(ledgers).toEqual([])
    expect(floatAcrossGroups(ledgers)).toEqual({ totalSatang: 0, byGroup: [] })
  })

  it('ส่ง Pool มาแทน client ใน transaction → throw', async () => {
    const user = await makeAppUser()
    await expect(
      loadLedgersForAppUser(user.id, getPool() as unknown as PoolClient),
    ).rejects.toThrow(/transaction/)
  })

  it('app_user ที่ไม่มีอยู่จริงได้อาเรย์ว่าง', async () => {
    expect(await loadLedgersForAppUser(randomUUID())).toEqual([])
  })

  it('คนละ app_user ในวงเดียวกันได้เงินจมของตัวเอง', async () => {
    const mine = await makeAppUser()
    const theirs = await makeAppUser()
    const group = await makeGroup()
    const me = await makeMember(group.id, uniqueName('ฉัน'), undefined, { appUserId: mine.id })
    const them = await makeMember(group.id, uniqueName('เขา'), undefined, { appUserId: theirs.id })

    await makeExpense({
      groupId: group.id,
      payerMemberId: me.id,
      totalSatang: 20000,
      shares: [
        { memberId: me.id, amountSatang: 10000 },
        { memberId: them.id, amountSatang: 10000 },
      ],
    })

    expect(floatAcrossGroups(await loadLedgersForAppUser(mine.id)).totalSatang).toBe(10000)
    expect(floatAcrossGroups(await loadLedgersForAppUser(theirs.id)).totalSatang).toBe(0)
  })

  it('ledger ที่คืนมาป้อน computeDebts ได้ตรงๆ เหมือน loadLedger', async () => {
    const user = await makeAppUser()
    const group = await makeGroup()
    const me = await makeMember(group.id, uniqueName('ฉัน'), undefined, { appUserId: user.id })
    const [x, y] = await makeTrio(group.id)
    await makeExpense({
      groupId: group.id,
      payerMemberId: me.id,
      totalSatang: 30000,
      shares: [
        { memberId: me.id, amountSatang: 10000 },
        { memberId: x.id, amountSatang: 10000 },
        { memberId: y.id, amountSatang: 10000 },
      ],
    })

    const [ledger] = await loadLedgersForAppUser(user.id)
    if (!ledger) throw new Error('ควรได้วงเดียว')
    expect(ledger.memberId).toBe(me.id)
    const debts = computeDebts(ledger.expenses, ledger.settlements)
    expect(owed(debts, x.id, me.id)).toBe(10000)
    expect(owed(debts, y.id, me.id)).toBe(10000)
    expect(floatOf(debts, ledger.memberId)).toBe(20000)
  })

  it('ใช้ pool เดียวกับที่ส่งเข้ามา — อ่านในวงเดียวกับ transaction ของผู้เรียก', async () => {
    const user = await makeAppUser()
    const group = await makeGroup()

    await withTransaction(async tx => {
      const me = await makeMember(group.id, uniqueName('ฉัน'), tx, { appUserId: user.id })
      const friend = await makeMember(group.id, uniqueName('เพื่อน'), tx)
      await makeExpense(
        {
          groupId: group.id,
          payerMemberId: me.id,
          totalSatang: 20000,
          shares: [
            { memberId: me.id, amountSatang: 10000 },
            { memberId: friend.id, amountSatang: 10000 },
          ],
        },
        tx,
      )
      const ledgers = await loadLedgersForAppUser(user.id, tx)
      expect(floatAcrossGroups(ledgers).totalSatang).toBe(10000)
    })
  })
})

// ─── ไม่คิดเลขใน SQL (D25) ────────────────────────────────────────────

describe('ledger ไม่คิดเลขเงินใน SQL', () => {
  it('ยอดที่โหลดมาเป็นยอดดิบรายแถว ไม่ใช่ยอดที่ SQL รวมมาให้แล้ว', async () => {
    const group = await makeGroup()
    const [a, b] = await makeTrio(group.id)
    await makeExpense({
      groupId: group.id,
      payerMemberId: a.id,
      totalSatang: 20000,
      shares: [
        { memberId: a.id, amountSatang: 7000 },
        { memberId: b.id, amountSatang: 13000 },
      ],
    })

    const { expenses } = await loadLedger(group.id)
    const amounts = (expenses[0]?.shares ?? [])
      .map(s => s.amountSatang)
      .sort((x, y) => x - y)
    // เห็นสองแถวแยกกัน ไม่ใช่ 20000 ก้อนเดียวที่ SQL sum มาให้
    expect(amounts).toEqual([7000, 13000])
  })

  it('ยอดรวมของวงตรงกับที่นับจาก DB ตรงๆ', async () => {
    const group = await makeGroup()
    const [a, b] = await makeTrio(group.id)
    for (let i = 1; i <= 4; i++) {
      await makeExpense({
        groupId: group.id,
        payerMemberId: a.id,
        totalSatang: i * 1000,
        shares: [
          { memberId: a.id, amountSatang: i * 400 },
          { memberId: b.id, amountSatang: i * 600 },
        ],
      })
    }

    const { expenses } = await loadLedger(group.id)
    const fromLedger = expenses
      .flatMap(e => e.shares)
      .reduce((sum, s) => sum + s.amountSatang, 0)

    const { rows } = await getPool().query<{ total: number }>(
      `select coalesce(sum(s.amount_satang), 0)::bigint as total
         from expense_share s
         join expense e on e.id = s.expense_id
        where e.group_id = $1`,
      [group.id],
    )
    expect(fromLedger).toBe(rows[0]?.total)
    // 1000+2000+3000+4000
    expect(fromLedger).toBe(10000)
  })
})
