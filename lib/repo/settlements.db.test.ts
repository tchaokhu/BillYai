/**
 * integration test ของ `lib/repo/settlements.ts` — ต้องมี Postgres จริง
 *
 *   npx vitest run --config vitest.db.config.ts lib/repo/settlements.db.test.ts
 *
 * ทุกเทสต์สร้างวงของตัวเองผ่าน `lib/db/fixtures.ts` แล้ว assert เฉพาะในวงนั้น
 * — ห้าม TRUNCATE ห้าม db:reset เพราะไฟล์อื่นรันขนานกันอยู่บน DB ตัวเดียวกัน
 */

import { afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { closePool, getPool, withTransaction } from '@/lib/db/client'
import { makeGroup, makeMembers, makeSettlement } from '@/lib/db/fixtures'
import { softDeleteGroup } from '@/lib/repo/groups'
import type { SettlementRow, SettlementVia } from '@/lib/db/rows'
import type { MemberId } from '@/lib/types'
import {
  cancelSettlement,
  claimSettlement,
  confirmSettlement,
  findSettlementById,
  listSettlements,
  rejectSettlement,
} from '@/lib/repo/settlements'

afterAll(closePool)

/**
 * วงหนึ่งวงพร้อมลูกหนี้/เจ้าหนี้ — ทุกเทสต์เรียกตัวนี้เพื่อให้แยกกันเด็ดขาด
 */
async function makeScene(): Promise<{
  groupId: string
  debtor: MemberId
  creditor: MemberId
}> {
  const group = await makeGroup()
  const [debtor, creditor] = await makeMembers(group.id, ['ลูกหนี้', 'เจ้าหนี้'])
  if (!debtor || !creditor) throw new Error('makeScene: fixtures ไม่คืนสมาชิกครบ')
  return { groupId: group.id, debtor: debtor.id, creditor: creditor.id }
}

/**
 * จำลองค่าที่มาจากขอบระบบ (HTTP body, LLM, LIFF) ซึ่ง TS ตรวจไม่ถึง
 * — ที่นั่นคือที่เดียวที่ `'line'` จะหลุดเข้ามาได้จริง
 */
function fromOutside(via: string): SettlementVia {
  return via as SettlementVia
}

describe('การตรวจวงของทุก member id ที่เขียนลงแถว', () => {
  it('claimedBy จากวงอื่น → throw', async () => {
    const { groupId, debtor, creditor } = await makeScene()
    const stranger = await makeScene()

    await expect(
      claimSettlement({
        groupId,
        fromMemberId: debtor,
        toMemberId: creditor,
        amountSatang: 5000,
        claimedBy: stranger.debtor,
        claimedVia: 'liff',
      }),
    ).rejects.toThrow(/คนละวง/)
    expect(await listSettlements(groupId)).toHaveLength(0)
  })

  it('confirmedBy จากวงอื่น → throw และแถวยังเป็น claimed', async () => {
    const { groupId, debtor, creditor } = await makeScene()
    const stranger = await makeScene()
    const claim = await claimSettlement({
      groupId,
      fromMemberId: debtor,
      toMemberId: creditor,
      amountSatang: 5000,
      claimedVia: 'liff',
    })

    await expect(
      confirmSettlement(claim.id, {
        confirmedBy: stranger.creditor,
        confirmedVia: 'liff',
      }),
    ).rejects.toThrow(/คนละวง/)
    expect((await findSettlementById(claim.id))?.status).toBe('claimed')
  })

  it('rejectedBy จากวงอื่น → throw เช่นกัน', async () => {
    const { groupId, debtor, creditor } = await makeScene()
    const stranger = await makeScene()
    const claim = await claimSettlement({
      groupId,
      fromMemberId: debtor,
      toMemberId: creditor,
      amountSatang: 5000,
      claimedVia: 'liff',
    })

    await expect(
      rejectSettlement(claim.id, {
        confirmedBy: stranger.creditor,
        confirmedVia: 'liff',
      }),
    ).rejects.toThrow(/คนละวง/)
    expect((await findSettlementById(claim.id))?.status).toBe('claimed')
  })

  it('claim เข้าวงที่ soft-delete แล้ว → throw', async () => {
    const { groupId, debtor, creditor } = await makeScene()
    await softDeleteGroup(groupId)

    await expect(
      claimSettlement({
        groupId,
        fromMemberId: debtor,
        toMemberId: creditor,
        amountSatang: 5000,
        claimedVia: 'liff',
      }),
    ).rejects.toThrow(/ถูกลบ/)
    expect(await listSettlements(groupId)).toHaveLength(0)
  })
})

describe('claimSettlement', () => {
  it('สร้างเป็น claimed เสมอ และช่องของเจ้าหนี้ยังว่างทั้งสามช่อง', async () => {
    const { groupId, debtor, creditor } = await makeScene()

    const settlement = await claimSettlement({
      groupId,
      fromMemberId: debtor,
      toMemberId: creditor,
      amountSatang: 25_000,
      claimedBy: debtor,
      claimedVia: 'liff',
    })

    expect(settlement.status).toBe('claimed')
    expect(settlement.groupId).toBe(groupId)
    expect(settlement.fromMemberId).toBe(debtor)
    expect(settlement.toMemberId).toBe(creditor)
    expect(settlement.amountSatang).toBe(25_000)
    expect(settlement.claimedBy).toBe(debtor)
    expect(settlement.claimedVia).toBe('liff')
    expect(settlement.claimedAt).toBeInstanceOf(Date)
    // D8 — ยังไม่มีใครยืนยันว่าเงินเข้า สามช่องนี้จึงต้องว่างพร้อมกัน
    expect(settlement.confirmedAt).toBeNull()
    expect(settlement.confirmedBy).toBeNull()
    expect(settlement.confirmedVia).toBeNull()
  })

  it('ปุ่มแจ้งจ่ายบน Nudge Link ได้ claimed_via=link และยังต้องรอเจ้าหนี้ยืนยัน', async () => {
    const { groupId, debtor, creditor } = await makeScene()

    const settlement = await claimSettlement({
      groupId,
      fromMemberId: debtor,
      toMemberId: creditor,
      amountSatang: 12_345,
      claimedVia: 'link',
      note: 'โอนแล้วนะ',
    })

    expect(settlement.claimedVia).toBe('link')
    expect(settlement.status).toBe('claimed')
    expect(settlement.note).toBe('โอนแล้วนะ')
  })

  it('ไม่ส่ง claimedBy มา = ไม่รู้ว่าใครกด เก็บเป็น null ไม่เดาแทน', async () => {
    const { groupId, debtor, creditor } = await makeScene()

    const settlement = await claimSettlement({
      groupId,
      fromMemberId: debtor,
      toMemberId: creditor,
      amountSatang: 100,
      claimedVia: 'link',
    })

    expect(settlement.claimedBy).toBeNull()
  })

  it('ไม่มีทางลัดสร้างเป็น confirmed — API ที่รับ status ไม่มีอยู่จริง', async () => {
    const { groupId, debtor, creditor } = await makeScene()

    const settlement = await claimSettlement({
      groupId,
      fromMemberId: debtor,
      toMemberId: creditor,
      amountSatang: 500,
      claimedVia: 'web',
    })

    // ทางเดียวที่จะได้ confirmed คือผ่าน confirmSettlement ซึ่งเป็นขั้นของเจ้าหนี้
    const stored = await findSettlementById(settlement.id)
    expect(stored?.status).toBe('claimed')
  })

  it.each([
    ['ศูนย์', 0],
    ['ติดลบ', -100],
    ['ทศนิยม', 12.5],
  ])('ปฏิเสธยอด %s', async (_label, amountSatang) => {
    const { groupId, debtor, creditor } = await makeScene()

    await expect(
      claimSettlement({
        groupId,
        fromMemberId: debtor,
        toMemberId: creditor,
        amountSatang,
        claimedVia: 'liff',
      }),
    ).rejects.toThrow(/สตางค์|มากกว่า 0/)
  })

  it("ปฏิเสธ claimedVia='line' เพราะยืนยันการจ่ายในแชทกลุ่มไม่ได้", async () => {
    const { groupId, debtor, creditor } = await makeScene()

    await expect(
      claimSettlement({
        groupId,
        fromMemberId: debtor,
        toMemberId: creditor,
        amountSatang: 100,
        claimedVia: fromOutside('line'),
      }),
    ).rejects.toThrow(/liff\|link\|web/)
  })

  it('ปฏิเสธการจ่ายให้ตัวเอง ก่อนถึง DB', async () => {
    const { groupId, debtor } = await makeScene()

    await expect(
      claimSettlement({
        groupId,
        fromMemberId: debtor,
        toMemberId: debtor,
        amountSatang: 100,
        claimedVia: 'liff',
      }),
    ).rejects.toThrow(/ตัวเอง/)
  })

  it('ปฏิเสธสมาชิกที่อยู่คนละวงกับ settlement — หนี้ไม่ข้ามวง', async () => {
    const scene = await makeScene()
    const other = await makeScene()

    await expect(
      claimSettlement({
        groupId: scene.groupId,
        fromMemberId: scene.debtor,
        toMemberId: other.creditor,
        amountSatang: 100,
        claimedVia: 'liff',
      }),
    ).rejects.toThrow(/วง/)
  })

  it('ปฏิเสธสมาชิกที่ไม่มีอยู่จริง', async () => {
    const { groupId, debtor } = await makeScene()

    await expect(
      claimSettlement({
        groupId,
        fromMemberId: debtor,
        toMemberId: randomUUID(),
        amountSatang: 100,
        claimedVia: 'liff',
      }),
    ).rejects.toThrow(/ไม่พบสมาชิก/)
  })
})

describe('constraint ที่ DB เป็นคนกัน ไม่ใช่โค้ด', () => {
  it('insert ดิบที่ from = to ต้องพังที่ check constraint', async () => {
    const { groupId, debtor } = await makeScene()

    await expect(
      getPool().query(
        `insert into settlement (group_id, from_member_id, to_member_id, amount_satang)
         values ($1, $2, $2, 100)`,
        [groupId, debtor],
      ),
    ).rejects.toThrow(/violates check constraint/)
  })

  it("insert ดิบที่ claimed_via='line' ต้องพังที่ check constraint", async () => {
    const { groupId, debtor, creditor } = await makeScene()

    await expect(
      getPool().query(
        `insert into settlement (group_id, from_member_id, to_member_id, amount_satang, claimed_via)
         values ($1, $2, $3, 100, 'line')`,
        [groupId, debtor, creditor],
      ),
    ).rejects.toThrow(/settlement_claimed_via_check/)
  })

  it('insert ดิบที่ยอดเป็น 0 ต้องพังที่ check constraint', async () => {
    const { groupId, debtor, creditor } = await makeScene()

    await expect(
      getPool().query(
        `insert into settlement (group_id, from_member_id, to_member_id, amount_satang)
         values ($1, $2, $3, 0)`,
        [groupId, debtor, creditor],
      ),
    ).rejects.toThrow(/violates check constraint/)
  })
})

describe('confirmSettlement', () => {
  it('เจ้าหนี้ยืนยัน → confirmed พร้อมครบทั้งสามช่อง', async () => {
    const { groupId, debtor, creditor } = await makeScene()
    const claimed = await makeSettlement({
      groupId,
      fromMemberId: debtor,
      toMemberId: creditor,
      amountSatang: 9_900,
    })

    const confirmed = await confirmSettlement(claimed.id, {
      confirmedBy: creditor,
      confirmedVia: 'liff',
    })

    expect(confirmed.status).toBe('confirmed')
    expect(confirmed.confirmedBy).toBe(creditor)
    expect(confirmed.confirmedVia).toBe('liff')
    expect(confirmed.confirmedAt).toBeInstanceOf(Date)
    // ข้อมูลขั้นแรกต้องไม่ถูกเขียนทับ — ประวัติสองขั้นต้องอ่านย้อนได้
    expect(confirmed.claimedAt).toEqual(claimed.claimedAt)
    expect(confirmed.amountSatang).toBe(9_900)
  })

  it.each(['confirmed', 'rejected', 'cancelled'] as const)(
    'ยืนยันตัวที่เป็น %s แล้วต้อง error — double-confirm แปลว่าหนี้หายสองรอบ',
    async (status) => {
      const { groupId, debtor, creditor } = await makeScene()
      const settlement = await makeSettlement({
        groupId,
        fromMemberId: debtor,
        toMemberId: creditor,
        amountSatang: 100,
        status,
      })

      await expect(
        confirmSettlement(settlement.id, { confirmedBy: creditor, confirmedVia: 'liff' }),
      ).rejects.toThrow(new RegExp(status))
    },
  )

  it('ยืนยัน id ที่ไม่มีอยู่ ต้อง throw ไม่ใช่คืน null เงียบๆ', async () => {
    const { creditor } = await makeScene()

    await expect(
      confirmSettlement(randomUUID(), { confirmedBy: creditor, confirmedVia: 'web' }),
    ).rejects.toThrow(/ไม่พบ/)
  })

  it("ปฏิเสธ confirmedVia='line' ด้วยเหตุผลเดียวกับตอน claim", async () => {
    const { groupId, debtor, creditor } = await makeScene()
    const claimed = await makeSettlement({
      groupId,
      fromMemberId: debtor,
      toMemberId: creditor,
      amountSatang: 100,
    })

    await expect(
      confirmSettlement(claimed.id, {
        confirmedBy: creditor,
        confirmedVia: fromOutside('line'),
      }),
    ).rejects.toThrow(/liff\|link\|web/)

    const stored = await findSettlementById(claimed.id)
    expect(stored?.status).toBe('claimed')
  })

  it('กดยืนยันรัวสองครั้งพร้อมกัน สำเร็จครั้งเดียว', async () => {
    const { groupId, debtor, creditor } = await makeScene()
    const claimed = await makeSettlement({
      groupId,
      fromMemberId: debtor,
      toMemberId: creditor,
      amountSatang: 50_000,
    })

    const results = await Promise.allSettled([
      confirmSettlement(claimed.id, { confirmedBy: creditor, confirmedVia: 'liff' }),
      confirmSettlement(claimed.id, { confirmedBy: creditor, confirmedVia: 'liff' }),
    ])

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)

    const stored = await findSettlementById(claimed.id)
    expect(stored?.status).toBe('confirmed')
  })

  it('ยืนยันชนกับปฏิเสธพร้อมกัน ผ่านได้ทางเดียว', async () => {
    const { groupId, debtor, creditor } = await makeScene()
    const claimed = await makeSettlement({
      groupId,
      fromMemberId: debtor,
      toMemberId: creditor,
      amountSatang: 700,
    })

    const results = await Promise.allSettled([
      confirmSettlement(claimed.id, { confirmedBy: creditor, confirmedVia: 'liff' }),
      rejectSettlement(claimed.id, { confirmedBy: creditor, confirmedVia: 'liff' }),
    ])

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)

    const stored = await findSettlementById(claimed.id)
    expect(['confirmed', 'rejected']).toContain(stored?.status)
  })
})

describe('rejectSettlement', () => {
  it('เจ้าหนี้ปฏิเสธ → rejected พร้อมบันทึกว่าใครตัดสินและตอนไหน', async () => {
    const { groupId, debtor, creditor } = await makeScene()
    const claimed = await makeSettlement({
      groupId,
      fromMemberId: debtor,
      toMemberId: creditor,
      amountSatang: 100,
    })

    const rejected = await rejectSettlement(claimed.id, {
      confirmedBy: creditor,
      confirmedVia: 'web',
    })

    expect(rejected.status).toBe('rejected')
    expect(rejected.confirmedBy).toBe(creditor)
    expect(rejected.confirmedVia).toBe('web')
    expect(rejected.confirmedAt).toBeInstanceOf(Date)
  })

  it.each(['confirmed', 'rejected', 'cancelled'] as const)(
    'ปฏิเสธตัวที่เป็น %s แล้วต้อง error',
    async (status) => {
      const { groupId, debtor, creditor } = await makeScene()
      const settlement = await makeSettlement({
        groupId,
        fromMemberId: debtor,
        toMemberId: creditor,
        amountSatang: 100,
        status,
      })

      await expect(
        rejectSettlement(settlement.id, { confirmedBy: creditor, confirmedVia: 'liff' }),
      ).rejects.toThrow(new RegExp(status))
    },
  )

  it('ปฏิเสธ id ที่ไม่มีอยู่ ต้อง throw', async () => {
    const { creditor } = await makeScene()

    await expect(
      rejectSettlement(randomUUID(), { confirmedBy: creditor, confirmedVia: 'web' }),
    ).rejects.toThrow(/ไม่พบ/)
  })
})

describe('cancelSettlement', () => {
  it('ลูกหนี้ถอนคำแจ้งเอง → cancelled และช่องของเจ้าหนี้ยังว่าง', async () => {
    const { groupId, debtor, creditor } = await makeScene()
    const claimed = await makeSettlement({
      groupId,
      fromMemberId: debtor,
      toMemberId: creditor,
      amountSatang: 100,
    })

    const cancelled = await cancelSettlement(claimed.id)

    expect(cancelled.status).toBe('cancelled')
    // เจ้าหนี้ไม่เคยตัดสิน — บันทึกว่าเขาตัดสินคือโกหกประวัติ
    expect(cancelled.confirmedAt).toBeNull()
    expect(cancelled.confirmedBy).toBeNull()
    expect(cancelled.confirmedVia).toBeNull()
  })

  it.each(['confirmed', 'rejected', 'cancelled'] as const)(
    'ถอนตัวที่เป็น %s แล้วต้อง error',
    async (status) => {
      const { groupId, debtor, creditor } = await makeScene()
      const settlement = await makeSettlement({
        groupId,
        fromMemberId: debtor,
        toMemberId: creditor,
        amountSatang: 100,
        status,
      })

      await expect(cancelSettlement(settlement.id)).rejects.toThrow(new RegExp(status))
    },
  )

  it('ถอน id ที่ไม่มีอยู่ ต้อง throw', async () => {
    await expect(cancelSettlement(randomUUID())).rejects.toThrow(/ไม่พบ/)
  })
})

describe('findSettlementById', () => {
  it('คืนตัวที่มีอยู่ผ่าน mapper camelCase', async () => {
    const { groupId, debtor, creditor } = await makeScene()
    const made = await makeSettlement({
      groupId,
      fromMemberId: debtor,
      toMemberId: creditor,
      amountSatang: 4_200,
      note: 'ค่าข้าว',
    })

    const found = await findSettlementById(made.id)

    expect(found).not.toBeNull()
    expect(found?.fromMemberId).toBe(debtor)
    expect(found?.toMemberId).toBe(creditor)
    expect(found?.amountSatang).toBe(4_200)
    expect(found?.note).toBe('ค่าข้าว')
  })

  it('คืน null เมื่อไม่มี — การอ่านที่ไม่เจอไม่ใช่ความผิดพลาด', async () => {
    expect(await findSettlementById(randomUUID())).toBeNull()
  })
})

describe('listSettlements', () => {
  it('คืนเฉพาะของวงตัวเอง เรียงใหม่สุดก่อน', async () => {
    const { groupId, debtor, creditor } = await makeScene()
    const other = await makeScene()
    await makeSettlement({
      groupId: other.groupId,
      fromMemberId: other.debtor,
      toMemberId: other.creditor,
      amountSatang: 100,
    })

    const first = await makeSettlement({
      groupId,
      fromMemberId: debtor,
      toMemberId: creditor,
      amountSatang: 100,
    })
    const second = await makeSettlement({
      groupId,
      fromMemberId: debtor,
      toMemberId: creditor,
      amountSatang: 200,
    })
    const third = await makeSettlement({
      groupId,
      fromMemberId: debtor,
      toMemberId: creditor,
      amountSatang: 300,
    })

    const list = await listSettlements(groupId)

    expect(list.map((s) => s.id)).toEqual([third.id, second.id, first.id])
  })

  it('เวลาแจ้งซ้ำกันเป๊ะ ก็ยังเรียงเหมือนเดิมทุกครั้ง (tie-break ด้วย id)', async () => {
    const { groupId, debtor, creditor } = await makeScene()

    // now() ใน transaction เดียวคือค่าเดียวกันทุกแถว — สร้าง tie ของจริง
    const tied = await withTransaction(async (tx) => [
      await makeSettlement({ groupId, fromMemberId: debtor, toMemberId: creditor, amountSatang: 1 }, tx),
      await makeSettlement({ groupId, fromMemberId: debtor, toMemberId: creditor, amountSatang: 2 }, tx),
      await makeSettlement({ groupId, fromMemberId: debtor, toMemberId: creditor, amountSatang: 3 }, tx),
    ])

    const claimedAts = new Set(tied.map((s) => s.claimedAt.getTime()))
    expect(claimedAts.size).toBe(1)

    const expected = [...tied].sort((a, b) => (a.id < b.id ? 1 : -1)).map((s) => s.id)
    expect((await listSettlements(groupId)).map((s) => s.id)).toEqual(expected)
    expect((await listSettlements(groupId)).map((s) => s.id)).toEqual(expected)
  })

  it('กรองตามสถานะได้', async () => {
    const { groupId, debtor, creditor } = await makeScene()
    const claimed = await makeSettlement({
      groupId,
      fromMemberId: debtor,
      toMemberId: creditor,
      amountSatang: 100,
    })
    const confirmed = await makeSettlement({
      groupId,
      fromMemberId: debtor,
      toMemberId: creditor,
      amountSatang: 200,
      status: 'confirmed',
    })

    expect((await listSettlements(groupId, { status: 'claimed' })).map((s) => s.id)).toEqual([
      claimed.id,
    ])
    expect((await listSettlements(groupId, { status: 'confirmed' })).map((s) => s.id)).toEqual([
      confirmed.id,
    ])
    expect(await listSettlements(groupId, { status: 'cancelled' })).toEqual([])
  })

  it('คืนวงเปล่าเป็น array ว่าง ไม่ใช่ throw', async () => {
    const group = await makeGroup()
    expect(await listSettlements(group.id)).toEqual([])
  })

  it('เก็บทุกสถานะไว้ให้ลูกค้าฝั่งบนตัดสินเอง ไม่กรอง cancelled ทิ้งเงียบๆ', async () => {
    const { groupId, debtor, creditor } = await makeScene()
    await makeSettlement({
      groupId,
      fromMemberId: debtor,
      toMemberId: creditor,
      amountSatang: 100,
      status: 'cancelled',
    })

    const rows = await getPool().query<SettlementRow>(
      `select * from settlement where group_id = $1`,
      [groupId],
    )
    expect((await listSettlements(groupId)).length).toBe(rows.rows.length)
  })
})
