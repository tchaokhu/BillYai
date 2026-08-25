/**
 * ชุดตรวจสอบของ orchestrator ระดับ persistence — คู่ขนานกับ `lib/contract.test.ts`
 * ของ M1 แต่ตรวจสิ่งที่พังได้เฉพาะเมื่อมี DB จริงอยู่ตรงกลาง
 *
 * **กติกาของไฟล์นี้: ห้ามเอา repository มาเทียบกับตัวเอง**
 * ค่าคาดหวังทุกค่าคำนวณจากทางที่สอง — SQL ดิบที่เขียนตามนิยามใน `docs/DESIGN.md`
 * หรือคำนวณด้วยมือในเทสต์ ถ้าสองทางนี้ให้คำตอบไม่ตรงกัน แปลว่าฝั่งใดฝั่งหนึ่งผิด
 * และนั่นคือสิ่งที่ไฟล์นี้มีหน้าที่จับ
 *
 * เป็นชุดกันถอยหลัง **ห้ามลบ ห้ามผ่อนเกณฑ์** — แดงที่นี่ = สัญญาโดเมนถูกละเมิด
 * ไม่ใช่เทสต์พัง
 *
 * ทุกเทสต์สร้างวงของตัวเองแล้ว assert เฉพาะในวงนั้น ห้าม TRUNCATE
 */

import { readFileSync, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { closePool, getPool } from '@/lib/db/client'
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
import { commitExpense } from '@/lib/repo/expenses'
import { hardDeleteGroup, softDeleteGroup } from '@/lib/repo/groups'
import { floatAcrossGroups, loadLedger, loadLedgersForAppUser } from '@/lib/repo/ledger'
import { splitExpense } from '@/lib/split'
import type { MemberId, SplitMode } from '@/lib/types'

afterAll(closePool)

/** PRNG ที่ seed คงที่ — ชุดข้อมูลเดิมทุกครั้ง ไม่ใช่แดงสลับเขียวรอบเว้นรอบ */
function seeded(seed: number): (n: number) => number {
  let s = seed
  return (n: number) => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s % n
  }
}

async function makeCrowd(groupId: string, size: number): Promise<Member[]> {
  return makeMembers(
    groupId,
    Array.from({ length: size }, (_, i) => uniqueName(`c${i}`)),
  )
}

/**
 * เขียนบิลสุ่มเข้าวงผ่านเส้นทางจริง (`splitExpense` → `commitExpense`)
 *
 * ตั้งใจไม่ใช้ `makeExpense` ที่เขียน SQL ตรง เพราะสิ่งที่อยากตรวจคือของที่
 * **เส้นทางจริง** ทิ้งไว้ในตาราง ไม่ใช่ของที่เทสต์ยัดเข้าไปเอง
 */
async function seedBills(
  groupId: string,
  members: readonly Member[],
  rounds: number,
  rnd: (n: number) => number,
): Promise<void> {
  const modes: SplitMode[] = ['equal', 'share', 'exact', 'itemized']
  const pcts = [0, 7, 10, 17, 7.5, 12.25]

  for (let round = 0; round < rounds; round++) {
    const count = 2 + rnd(members.length - 1)
    const crowd = members.slice(0, count)
    const ids = crowd.map(m => m.id)
    const payerId = ids[rnd(count)] ?? ids[0] ?? ''
    const surchargePct = pcts[rnd(pcts.length)] ?? 0
    const mode = modes[rnd(modes.length)] ?? 'equal'

    if (mode === 'exact') {
      const each = ids.map(() => rnd(80_000))
      if (each.reduce((a, b) => a + b, 0) === 0) each[0] = 1
      const totalSatang = each.reduce((a, b) => a + b, 0)
      const participants = ids.map((memberId, i) => ({
        memberId,
        exactSatang: each[i] ?? 0,
      }))
      await commitFrom(groupId, { totalSatang, surchargePct, payerId, mode, participants })
      continue
    }

    if (mode === 'itemized') {
      const items = Array.from({ length: 1 + rnd(4) }, (_, k) => {
        const eaters = ids.filter(() => rnd(2) === 0)
        return {
          name: `i${k}`,
          amountSatang: 1 + rnd(40_000),
          memberIds: eaters.length > 0 ? eaters : [ids[rnd(count)] ?? ids[0] ?? ''],
        }
      })
      const totalSatang = items.reduce((a, b) => a + b.amountSatang, 0)
      await commitFrom(
        groupId,
        {
          totalSatang,
          surchargePct,
          payerId,
          mode,
          participants: ids.map(memberId => ({ memberId })),
          items,
        },
        items,
      )
      continue
    }

    const participants =
      mode === 'share'
        ? ids.map(memberId => ({ memberId, weight: 1 + rnd(4) }))
        : ids.map(memberId => ({ memberId }))
    await commitFrom(groupId, {
      totalSatang: 1 + rnd(500_000),
      surchargePct,
      payerId,
      mode,
      participants,
    })
  }
}

async function commitFrom(
  groupId: string,
  input: Parameters<typeof splitExpense>[0],
  items?: ReadonlyArray<{ name: string; amountSatang: number; memberIds: MemberId[] }>,
): Promise<void> {
  const shares = splitExpense(input)
  await commitExpense({
    groupId,
    description: 'บิลของชุดตรวจสัญญา',
    totalSatang: input.totalSatang,
    surchargePct: input.surchargePct,
    payerMemberId: input.payerId,
    splitMode: input.mode,
    spentAt: '2026-02-01',
    createdBy: input.payerId,
    source: 'rule',
    shares: shares.map(s => ({ memberId: s.memberId, amountSatang: s.amountSatang })),
    ...(items === undefined
      ? {}
      : {
          items: items.map(item => ({
            name: item.name,
            amountSatang: item.amountSatang,
            shares: item.memberIds.map(memberId => ({ memberId })),
          })),
        }),
  })
}

// ─── invariant ของเงินที่อยู่ในตารางจริง ──────────────────────────────

describe('Σ share = round(total × (1 + surcharge/100)) — ตรวจด้วย SQL ไม่ใช่ด้วยสูตรเดิม', () => {
  /**
   * ฝั่ง TypeScript ปัดด้วย `floor((2n + d) / 2d)` บน BigInt ส่วนฝั่งนี้ให้
   * Postgres ปัดด้วย `round()` บน `numeric` ซึ่งเป็นการปัดครึ่งขึ้นเหมือนกัน
   * แต่คนละ implementation คนละภาษา — ตรงกันเมื่อไหร่แปลว่าสูตรถูกจริง
   * ไม่ใช่ถูกเพราะเทียบกับตัวเอง
   */
  it('บิลสุ่ม 60 ใบทุกโหมด ไม่มีใบไหนละเมิด', async () => {
    const group = await makeGroup()
    const members = await makeCrowd(group.id, 6)
    await seedBills(group.id, members, 60, seeded(20260825))

    const { rows } = await getPool().query<{
      id: string
      total_satang: number
      surcharge_pct: string
      sum_shares: number
      expected: number
    }>(
      `select e.id,
              e.total_satang,
              e.surcharge_pct,
              sum(s.amount_satang)::bigint as sum_shares,
              round(e.total_satang * (1 + e.surcharge_pct / 100))::bigint as expected
         from expense e
         join expense_share s on s.expense_id = e.id
        where e.group_id = $1
        group by e.id, e.total_satang, e.surcharge_pct
       having sum(s.amount_satang) <> round(e.total_satang * (1 + e.surcharge_pct / 100))`,
      [group.id],
    )

    expect(rows).toEqual([])

    const { rows: counted } = await getPool().query<{ n: number }>(
      `select count(*)::int as n from expense where group_id = $1`,
      [group.id],
    )
    expect(counted[0]?.n).toBe(60)
  })

  it('ไม่มี share ติดลบ และไม่มีบิลที่ share หายไปทั้งใบ', async () => {
    const group = await makeGroup()
    const members = await makeCrowd(group.id, 5)
    await seedBills(group.id, members, 25, seeded(4242))

    const { rows: negative } = await getPool().query<{ n: number }>(
      `select count(*)::int as n
         from expense_share s join expense e on e.id = s.expense_id
        where e.group_id = $1 and s.amount_satang < 0`,
      [group.id],
    )
    expect(negative[0]?.n).toBe(0)

    const { rows: orphan } = await getPool().query<{ n: number }>(
      `select count(*)::int as n
         from expense e
        where e.group_id = $1
          and not exists (select 1 from expense_share s where s.expense_id = e.id)`,
      [group.id],
    )
    expect(orphan[0]?.n).toBe(0)
  })

  it('ยอดรายการ itemized รวมกันเท่ายอดบิลเสมอ', async () => {
    const group = await makeGroup()
    const members = await makeCrowd(group.id, 5)
    await seedBills(group.id, members, 30, seeded(777))

    const { rows } = await getPool().query<{ id: string }>(
      `select e.id
         from expense e
         join expense_item i on i.expense_id = e.id
        where e.group_id = $1
        group by e.id, e.total_satang
       having sum(i.amount_satang) <> e.total_satang`,
      [group.id],
    )
    expect(rows).toEqual([])
  })
})

// ─── Debt: TS กับนิยาม SQL ต้องให้คำตอบเดียวกัน ───────────────────────

/**
 * สูตร Debt ที่เขียนไว้ใน `docs/DESIGN.md` เป็น **นิยาม** (D25) ส่วน
 * `lib/debt.ts` เป็น implementation. เทสต์ชุดนี้รันนิยามนั้นจริงๆ บน Postgres
 * แล้วเทียบกับผลของเส้นทาง `loadLedger` → `computeDebts`
 *
 * เทียบคู่ด้วย `least/greatest` บน uuid (ไม่ใช่ text) เพราะ uuid เรียงตามไบต์
 * ซึ่งตรงกับการเทียบสตริงของ JS ส่วนการเทียบแบบ text ขึ้นกับ collation ของ DB
 */
const DEBT_BY_DEFINITION_SQL = `
  with legs as (
    select s.member_id            as debtor,
           e.payer_member_id      as creditor,
           s.amount_satang        as amount
      from expense_share s
      join expense e on e.id = s.expense_id
     where e.group_id = $1
       and e.status = 'active'
       and s.member_id <> e.payer_member_id
    union all
    -- จ่ายคืนที่เจ้าหนี้ยืนยันแล้ว = หนี้ทิศตรงข้าม (D8: claimed ยังไม่นับ)
    select to_member_id, from_member_id, amount_satang
      from settlement
     where group_id = $1 and status = 'confirmed'
  )
  select least(debtor, creditor)::text as lo,
         greatest(debtor, creditor)::text as hi,
         sum(case when debtor < creditor then amount else -amount end)::bigint as net
    from legs
   group by 1, 2
  having sum(case when debtor < creditor then amount else -amount end) <> 0
   order by 1, 2
`

interface PairRow {
  lo: string
  hi: string
  net: number
}

/** ผลของ `computeDebts` ในรูปเดียวกับที่ SQL คืน — เพื่อให้เทียบกันได้ตรงๆ */
async function debtsAsPairs(groupId: string): Promise<PairRow[]> {
  const { expenses, settlements } = await loadLedger(groupId)
  return computeDebts(expenses, settlements)
    .map(debt => {
      const flipped = debt.debtorId > debt.creditorId
      return {
        lo: flipped ? debt.creditorId : debt.debtorId,
        hi: flipped ? debt.debtorId : debt.creditorId,
        net: flipped ? -debt.amountSatang : debt.amountSatang,
      }
    })
    .sort((a, b) => (a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : a.hi < b.hi ? -1 : a.hi > b.hi ? 1 : 0))
}

describe('Debt — lib/debt.ts ต้องตรงกับนิยาม SQL ใน DESIGN.md', () => {
  it('วงสุ่ม 40 บิล + settlement คละสถานะ → ทุกคู่ตรงกันหมด', async () => {
    const rnd = seeded(31337)
    const group = await makeGroup()
    const members = await makeCrowd(group.id, 5)
    await seedBills(group.id, members, 40, rnd)

    // settlement คละสถานะ — มีแต่ confirmed ที่ต้องขยับยอด
    const statuses = ['claimed', 'confirmed', 'rejected', 'cancelled'] as const
    for (let i = 0; i < 12; i++) {
      const from = members[rnd(members.length)]
      const to = members[rnd(members.length)]
      if (!from || !to || from.id === to.id) continue
      await makeSettlement({
        groupId: group.id,
        fromMemberId: from.id,
        toMemberId: to.id,
        amountSatang: 1 + rnd(30_000),
        status: statuses[rnd(statuses.length)] ?? 'claimed',
      })
    }

    const { rows } = await getPool().query<PairRow>(DEBT_BY_DEFINITION_SQL, [group.id])
    expect(await debtsAsPairs(group.id)).toEqual(rows)
    // ถ้าไม่มีคู่ไหนเหลือเลยแปลว่าเทสต์ไม่ได้พิสูจน์อะไร
    expect(rows.length).toBeGreaterThan(0)
  })

  it('บิลที่ void แล้วหายจากยอดทั้งสองทาง', async () => {
    const group = await makeGroup()
    const [a, b] = await makeCrowd(group.id, 2)
    if (!a || !b) throw new Error('fixture')
    const dropped = await makeExpense({
      groupId: group.id,
      payerMemberId: a.id,
      totalSatang: 20000,
      shares: [
        { memberId: a.id, amountSatang: 10000 },
        { memberId: b.id, amountSatang: 10000 },
      ],
    })

    const beforeVoid = await getPool().query<PairRow>(DEBT_BY_DEFINITION_SQL, [group.id])
    expect(await debtsAsPairs(group.id)).toEqual(beforeVoid.rows)
    expect(beforeVoid.rows).toHaveLength(1)

    await voidExpense(dropped.id)

    const afterVoid = await getPool().query<PairRow>(DEBT_BY_DEFINITION_SQL, [group.id])
    expect(afterVoid.rows).toEqual([])
    expect(await debtsAsPairs(group.id)).toEqual([])
  })

  it('settlement ที่ยังไม่ confirmed ไม่ขยับยอดทั้งสองทาง (D8)', async () => {
    const group = await makeGroup()
    const [a, b] = await makeCrowd(group.id, 2)
    if (!a || !b) throw new Error('fixture')
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
      amountSatang: 10000,
      status: 'claimed',
    })

    const { rows } = await getPool().query<PairRow>(DEBT_BY_DEFINITION_SQL, [group.id])
    // ยอดคำนวณด้วยมือ: หนี้ 10000 เต็ม เพราะ claimed ไม่หัก
    expect(rows).toEqual([{ lo: a.id < b.id ? a.id : b.id, hi: a.id < b.id ? b.id : a.id, net: a.id < b.id ? -10000 : 10000 }])
    expect(await debtsAsPairs(group.id)).toEqual(rows)
  })

  it('ไม่มีหนี้ข้ามวงแม้คนเดียวกันอยู่สองวง', async () => {
    const user = await makeAppUser()
    const one = await makeGroup()
    const two = await makeGroup()
    const meOne = await makeMember(one.id, uniqueName('ฉัน'), undefined, { appUserId: user.id })
    const meTwo = await makeMember(two.id, uniqueName('ฉัน'), undefined, { appUserId: user.id })
    const friendOne = await makeMember(one.id)
    const friendTwo = await makeMember(two.id)

    await makeExpense({
      groupId: one.id,
      payerMemberId: meOne.id,
      totalSatang: 20000,
      shares: [
        { memberId: meOne.id, amountSatang: 10000 },
        { memberId: friendOne.id, amountSatang: 10000 },
      ],
    })
    await makeExpense({
      groupId: two.id,
      payerMemberId: friendTwo.id,
      totalSatang: 60000,
      shares: [
        { memberId: meTwo.id, amountSatang: 30000 },
        { memberId: friendTwo.id, amountSatang: 30000 },
      ],
    })

    for (const groupId of [one.id, two.id]) {
      const { rows } = await getPool().query<PairRow>(DEBT_BY_DEFINITION_SQL, [groupId])
      expect(rows).toHaveLength(1)
      expect(await debtsAsPairs(groupId)).toEqual(rows)
    }
  })
})

// ─── Float ───────────────────────────────────────────────────────────

describe('Float ข้ามวง — ต้องตรงกับผลรวมที่นับจาก SQL', () => {
  it('รวมเฉพาะวง active และไม่หักกับหนี้ที่ตัวเองติดคนอื่น', async () => {
    const rnd = seeded(90210)
    const user = await makeAppUser()
    const groups: string[] = []
    const mine: MemberId[] = []

    for (let i = 0; i < 3; i++) {
      const group = await makeGroup()
      const me = await makeMember(group.id, uniqueName('ฉัน'), undefined, { appUserId: user.id })
      const crowd = await makeCrowd(group.id, 3)
      await seedBills(group.id, [me, ...crowd], 12, rnd)
      groups.push(group.id)
      mine.push(me.id)
    }

    // วงที่สามถูกลบ — ยอดของมันต้องหายจากเงินจมรวม
    const deadGroup = groups[2]
    if (deadGroup === undefined) throw new Error('fixture')
    await softDeleteGroup(deadGroup)

    let expected = 0
    for (const [i, groupId] of groups.entries()) {
      const memberId = mine[i]
      if (memberId === undefined) continue
      const { rows } = await getPool().query<PairRow>(DEBT_BY_DEFINITION_SQL, [groupId])
      // เงินจม = ผลรวมยอดที่คนอื่นติดเรา ในวงที่ยังไม่ถูกลบ
      const credit = rows.reduce((sum, pair) => {
        if (pair.lo === memberId && pair.net < 0) return sum - pair.net
        if (pair.hi === memberId && pair.net > 0) return sum + pair.net
        return sum
      }, 0)
      if (groupId !== deadGroup) expected += credit
    }

    const float = floatAcrossGroups(await loadLedgersForAppUser(user.id))
    expect(float.totalSatang).toBe(expected)
    expect(float.byGroup).toHaveLength(2)
    expect(expected).toBeGreaterThan(0)
  })

  it('floatOf ของแต่ละวงตรงกับยอดเจ้าหนี้ที่นับจาก SQL', async () => {
    const rnd = seeded(1357)
    const user = await makeAppUser()
    const group = await makeGroup()
    const me = await makeMember(group.id, uniqueName('ฉัน'), undefined, { appUserId: user.id })
    const crowd = await makeCrowd(group.id, 4)
    await seedBills(group.id, [me, ...crowd], 20, rnd)

    const { rows } = await getPool().query<{ credit: number }>(
      `with legs as (
         select s.member_id as debtor, e.payer_member_id as creditor, s.amount_satang as amount
           from expense_share s join expense e on e.id = s.expense_id
          where e.group_id = $1 and e.status = 'active' and s.member_id <> e.payer_member_id
         union all
         select to_member_id, from_member_id, amount_satang
           from settlement where group_id = $1 and status = 'confirmed'
       ),
       pairs as (
         select least(debtor, creditor) as lo, greatest(debtor, creditor) as hi,
                sum(case when debtor < creditor then amount else -amount end) as net
           from legs group by 1, 2
       )
       select coalesce(sum(
                case when hi = $2::uuid and net > 0 then net
                     when lo = $2::uuid and net < 0 then -net
                     else 0 end), 0)::bigint as credit
         from pairs`,
      [group.id, me.id],
    )

    const { expenses, settlements } = await loadLedger(group.id)
    expect(floatOf(computeDebts(expenses, settlements), me.id)).toBe(rows[0]?.credit)
    expect(rows[0]?.credit).toBeGreaterThan(0)
  })
})

// ─── สัญญาของชนิดข้อมูลที่ขอบ DB ──────────────────────────────────────

describe('ชนิดข้อมูลที่ขอบ — พังตรงนี้แล้วเงียบที่สุด', () => {
  it('สตางค์กลับมาเป็น number ไม่ใช่ string', async () => {
    const group = await makeGroup()
    const [a, b] = await makeCrowd(group.id, 2)
    if (!a || !b) throw new Error('fixture')
    await makeExpense({
      groupId: group.id,
      payerMemberId: a.id,
      totalSatang: 240000,
      shares: [
        { memberId: a.id, amountSatang: 120000 },
        { memberId: b.id, amountSatang: 120000 },
      ],
    })

    const { expenses } = await loadLedger(group.id)
    for (const share of expenses[0]?.shares ?? []) {
      expect(typeof share.amountSatang).toBe('number')
    }
  })

  /**
   * `bigint` กว้างกว่า `Number.MAX_SAFE_INTEGER` — ค่าที่เกินต้องพังดังๆ
   * ไม่ใช่ปัดเงียบแล้วกลายเป็นยอดหนี้ที่ผิดไปไม่กี่สตางค์โดยไม่มีใครเห็น
   */
  it('ยอดที่เกินช่วง safe integer ต้อง throw ตอนอ่าน ไม่ใช่ปัดเงียบ', async () => {
    const group = await makeGroup()
    const [a, b] = await makeCrowd(group.id, 2)
    if (!a || !b) throw new Error('fixture')
    const { rows } = await getPool().query<{ id: string }>(
      `insert into expense (group_id, description, total_satang, surcharge_pct,
                            payer_member_id, split_mode, spent_at, created_by, source)
       values ($1, 'ยอดเกินช่วง', 9007199254740993, 0, $2, 'equal', '2026-02-01', $2, 'rule')
       returning id`,
      [group.id, a.id],
    )
    const expenseId = rows[0]?.id
    if (expenseId === undefined) throw new Error('insert ไม่คืนแถว')
    await getPool().query(
      `insert into expense_share (expense_id, member_id, amount_satang)
       values ($1, $2, 9007199254740993)`,
      [expenseId, b.id],
    )

    await expect(loadLedger(group.id)).rejects.toThrow(/9007199254740993/)
  })

  it("spent_at ยังเป็นสตริง 'YYYY-MM-DD' ไม่ถูกแปลงเป็น Date", async () => {
    const group = await makeGroup()
    const [a, b] = await makeCrowd(group.id, 2)
    if (!a || !b) throw new Error('fixture')
    const expense = await makeExpense({
      groupId: group.id,
      payerMemberId: a.id,
      totalSatang: 100,
      spentAt: '2026-12-31',
      shares: [{ memberId: b.id, amountSatang: 100 }],
    })

    expect(expense.spentAt).toBe('2026-12-31')
    expect(typeof expense.spentAt).toBe('string')
  })

  it('surcharge_pct ที่เป็น numeric กลับมาเป็น number ที่ตรงค่า', async () => {
    const group = await makeGroup()
    const [a, b] = await makeCrowd(group.id, 2)
    if (!a || !b) throw new Error('fixture')
    const expense = await makeExpense({
      groupId: group.id,
      payerMemberId: a.id,
      totalSatang: 10000,
      surchargePct: 7.5,
      shares: [{ memberId: b.id, amountSatang: 10750 }],
    })
    expect(expense.surchargePct).toBe(7.5)
  })
})

// ─── การลบวง ─────────────────────────────────────────────────────────

describe('ลบวงจริงต้องไม่เหลือเศษไว้ที่ไหนเลย (D18)', () => {
  it('ทุกตารางลูกหายตาม cascade', async () => {
    const rnd = seeded(24680)
    const group = await makeGroup()
    const members = await makeCrowd(group.id, 4)
    await seedBills(group.id, members, 10, rnd)
    const [a, b] = members
    if (!a || !b) throw new Error('fixture')
    // บิล itemized หนึ่งใบแบบเจาะจง — ไม่ฝากไว้กับการสุ่มว่าจะได้โหมดนี้หรือไม่
    await commitFrom(
      group.id,
      {
        totalSatang: 30000,
        surchargePct: 0,
        payerId: a.id,
        mode: 'itemized',
        participants: [{ memberId: a.id }, { memberId: b.id }],
        items: [
          { name: 'หมู', amountSatang: 20000, memberIds: [a.id, b.id] },
          { name: 'ผัก', amountSatang: 10000, memberIds: [b.id] },
        ],
      },
      [
        { name: 'หมู', amountSatang: 20000, memberIds: [a.id, b.id] },
        { name: 'ผัก', amountSatang: 10000, memberIds: [b.id] },
      ],
    )
    await makeSettlement({
      groupId: group.id,
      fromMemberId: b.id,
      toMemberId: a.id,
      amountSatang: 500,
      status: 'confirmed',
    })
    await getPool().query(
      `insert into audit_log (group_id, actor, actor_via, action, target_type)
       values ($1, $2, 'line', 'expense.commit', 'expense')`,
      [group.id, a.id],
    )

    const counts = async (): Promise<Record<string, number>> => {
      const { rows } = await getPool().query<Record<string, number>>(
        `select
           (select count(*)::int from member where group_id = $1) as members,
           (select count(*)::int from expense where group_id = $1) as expenses,
           (select count(*)::int from expense_share s
              join expense e on e.id = s.expense_id where e.group_id = $1) as shares,
           (select count(*)::int from expense_item i
              join expense e on e.id = i.expense_id where e.group_id = $1) as items,
           (select count(*)::int from expense_item_share x
              join expense_item i on i.id = x.item_id
              join expense e on e.id = i.expense_id where e.group_id = $1) as item_shares,
           (select count(*)::int from settlement where group_id = $1) as settlements,
           (select count(*)::int from audit_log where group_id = $1) as audits`,
        [group.id],
      )
      const row = rows[0]
      if (!row) throw new Error('count query ไม่คืนแถว')
      return row
    }

    const before = await counts()
    expect(before.members).toBe(4)
    expect(before.expenses).toBe(11)
    expect(before.shares).toBeGreaterThan(0)
    expect(before.items).toBeGreaterThan(0)
    expect(before.item_shares).toBeGreaterThan(0)
    expect(before.settlements).toBe(1)
    expect(before.audits).toBe(1)

    await hardDeleteGroup(group.id)

    expect(await counts()).toEqual({
      members: 0,
      expenses: 0,
      shares: 0,
      items: 0,
      item_shares: 0,
      settlements: 0,
      audits: 0,
    })
  })

  it('soft-delete ไม่ลบอะไรเลย — เชิญ bot กลับแล้วข้อมูลต้องอยู่ครบ', async () => {
    const group = await makeGroup()
    const members = await makeCrowd(group.id, 3)
    await seedBills(group.id, members, 5, seeded(112233))

    const before = await getPool().query<{ n: number }>(
      `select count(*)::int as n from expense where group_id = $1`,
      [group.id],
    )
    await softDeleteGroup(group.id)
    const after = await getPool().query<{ n: number }>(
      `select count(*)::int as n from expense where group_id = $1`,
      [group.id],
    )

    expect(after.rows[0]?.n).toBe(before.rows[0]?.n)
    expect(after.rows[0]?.n).toBe(5)
  })
})

// ─── D25 ที่ระดับซอร์ส ────────────────────────────────────────────────

describe('D25 — ห้ามมีสูตรเงินใน SQL ของ repository', () => {
  /**
   * เทสต์อื่นจับได้เฉพาะตอนที่สูตรที่สองให้คำตอบ**ต่าง**จากสูตรแรก. สูตรที่สอง
   * ซึ่งบังเอิญตรงกันวันนี้จะผ่านทุกเทสต์ แล้วค่อยแตกวันที่มีคนแก้ข้างเดียว
   * ด่านนี้จึงอ่านซอร์สตรงๆ ว่ามีการคิดเลขเงินใน SQL โผล่มาไหม
   *
   * `llm.ts` รวม token ไม่ใช่เงิน จึงไม่เข้าข่าย — ตัวจับดูเฉพาะคอลัมน์เงิน
   */
  it('ไม่มี sum/avg/round ของคอลัมน์สตางค์ใน lib/repo/*.ts', () => {
    const moneyMath =
      /\b(sum|avg|round|min|max)\s*\(\s*[a-z_.]*(amount_satang|total_satang)/i
    const scaling = /(total_satang|amount_satang)\s*[*/]/i

    const offenders: string[] = []
    for (const file of readdirSync('lib/repo')) {
      if (!file.endsWith('.ts') || file.includes('.test.')) continue
      const source = readFileSync(`lib/repo/${file}`, 'utf8')
      if (moneyMath.test(source) || scaling.test(source)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('ตัวจับใช้งานได้จริง — ยิงใส่ข้อความตัวอย่างแล้วต้องติด', () => {
    const moneyMath =
      /\b(sum|avg|round|min|max)\s*\(\s*[a-z_.]*(amount_satang|total_satang)/i
    const scaling = /(total_satang|amount_satang)\s*[*/]/i

    expect(moneyMath.test('select sum(s.amount_satang) from expense_share s')).toBe(true)
    expect(moneyMath.test('select sum(input_tokens) from llm_usage')).toBe(false)
    expect(scaling.test('round(total_satang * (1 + surcharge_pct / 100))')).toBe(true)
    expect(scaling.test('select amount_satang from expense_share')).toBe(false)
  })
})

// ─── ความสม่ำเสมอของ id ที่ไม่มีอยู่จริง ─────────────────────────────

describe('id ที่ไม่มีอยู่จริงต้องได้ค่าว่าง ไม่ใช่ throw', () => {
  it('loadLedger ของวงที่ไม่มี และ float ของคนที่ไม่มี', async () => {
    expect(await loadLedger(randomUUID())).toEqual({ expenses: [], settlements: [] })
    expect(floatAcrossGroups(await loadLedgersForAppUser(randomUUID()))).toEqual({
      totalSatang: 0,
      byGroup: [],
    })
  })
})
