/**
 * fixtures เป็นของที่ agent ทุกตัวในคลื่นที่ 1 พึ่ง — ถ้ามันพัง ทุกโมดูลจะแดง
 * พร้อมกันโดยหาสาเหตุไม่เจอ เทสต์ชุดนี้พิสูจน์ว่ามันเขียนลง DB จริงก่อนแตกงาน
 */

import { afterAll, describe, expect, it } from 'vitest'
import { closePool, getPool } from '@/lib/db/client'
import {
  makeAppUser,
  makeExpense,
  makeGroup,
  makeMember,
  makeMembers,
  makePersonalGroup,
  makeSettlement,
  uniqueName,
  voidExpense,
} from '@/lib/db/fixtures'

afterAll(async () => {
  await closePool()
})

describe('วง', () => {
  it('สร้างวง LINE ที่มี line_group_id ไม่ซ้ำใคร', async () => {
    const a = await makeGroup()
    const b = await makeGroup()
    expect(a.kind).toBe('line_group')
    expect(a.status).toBe('active')
    expect(a.lineGroupId).not.toBeNull()
    expect(a.lineGroupId).not.toBe(b.lineGroupId)
  })

  it('สร้างวงส่วนตัวที่มีแต่ token hash ได้ — ผ่าน check ของ D21/D22', async () => {
    const group = await makePersonalGroup()
    expect(group.kind).toBe('personal')
    expect(group.lineGroupId).toBeNull()
    expect(group.ownerId).toBeNull()
    expect(group.ownerTokenHash).toBeInstanceOf(Buffer)
    expect(group.ownerTokenAt).not.toBeNull()
  })

  it('สร้างวงส่วนตัวที่ผูกกับ app_user ได้', async () => {
    const user = await makeAppUser()
    const group = await makePersonalGroup(undefined, { ownerId: user.id })
    expect(group.ownerId).toBe(user.id)
  })
})

describe('สมาชิก', () => {
  it('สร้าง Placeholder เมื่อไม่ส่ง appUserId', async () => {
    const group = await makeGroup()
    const member = await makeMember(group.id, 'กอล์ฟ')
    expect(member.groupId).toBe(group.id)
    expect(member.displayName).toBe('กอล์ฟ')
    expect(member.appUserId).toBeNull()
    expect(member.claimedAt).toBeNull()
  })

  it('ตั้ง claimed_at ให้เองเมื่อผูกกับ app_user', async () => {
    const group = await makeGroup()
    const user = await makeAppUser()
    const member = await makeMember(group.id, 'เบียร์', undefined, { appUserId: user.id })
    expect(member.appUserId).toBe(user.id)
    expect(member.claimedAt).toBeInstanceOf(Date)
  })

  it('สร้างหลายคนรวดเดียวโดยรักษาลำดับ', async () => {
    const group = await makeGroup()
    const members = await makeMembers(group.id, ['กอล์ฟ', 'เบียร์', 'ตูน'])
    expect(members.map(m => m.displayName)).toEqual(['กอล์ฟ', 'เบียร์', 'ตูน'])
  })

  it('uniqueName ไม่ซ้ำ — เทสต์หลายไฟล์รันขนานกันในวงคนละวง', () => {
    const names = new Set(Array.from({ length: 50 }, () => uniqueName()))
    expect(names.size).toBe(50)
  })
})

describe('บิล', () => {
  it('เขียน expense พร้อม shares และคืนค่าที่ map แล้ว', async () => {
    const group = await makeGroup()
    const [payer, other] = await makeMembers(group.id, ['กอล์ฟ', 'เบียร์'])
    if (!payer || !other) throw new Error('fixture ไม่ได้สร้างสมาชิกครบ')

    const expense = await makeExpense({
      groupId: group.id,
      payerMemberId: payer.id,
      totalSatang: 120000,
      description: 'ข้าว',
      shares: [
        { memberId: payer.id, amountSatang: 60000 },
        { memberId: other.id, amountSatang: 60000 },
      ],
    })

    expect(expense.totalSatang).toBe(120000)
    expect(expense.status).toBe('active')
    expect(expense.splitMode).toBe('equal')
    expect(expense.createdBy).toBe(payer.id)

    const { rows } = await getPool().query<{ amount_satang: number }>(
      `select amount_satang from expense_share where expense_id = $1 order by amount_satang`,
      [expense.id],
    )
    expect(rows.map(r => r.amount_satang)).toEqual([60000, 60000])
  })

  it('เงินกลับมาเป็น number ไม่ใช่ string — type parser ของ bigint ทำงาน', async () => {
    const group = await makeGroup()
    const payer = await makeMember(group.id)
    const expense = await makeExpense({
      groupId: group.id,
      payerMemberId: payer.id,
      totalSatang: 999999,
      shares: [{ memberId: payer.id, amountSatang: 999999 }],
    })
    expect(typeof expense.totalSatang).toBe('number')
    expect(expense.totalSatang).toBe(999999)
  })

  it('spent_at กลับมาเป็นสตริง YYYY-MM-DD ไม่ใช่ Date ที่เลื่อน timezone', async () => {
    const group = await makeGroup()
    const payer = await makeMember(group.id)
    const expense = await makeExpense({
      groupId: group.id,
      payerMemberId: payer.id,
      totalSatang: 100,
      spentAt: '2026-01-01',
      shares: [{ memberId: payer.id, amountSatang: 100 }],
    })
    expect(expense.spentAt).toBe('2026-01-01')
  })

  it('surchargePct กลับมาเป็นตัวเลข ไม่ใช่ numeric string', async () => {
    const group = await makeGroup()
    const payer = await makeMember(group.id)
    const expense = await makeExpense({
      groupId: group.id,
      payerMemberId: payer.id,
      totalSatang: 100000,
      surchargePct: 17,
      shares: [{ memberId: payer.id, amountSatang: 117000 }],
    })
    expect(expense.surchargePct).toBe(17)
  })

  it('ไม่ตรวจ invariant ให้ — เทสต์ต้องสร้างสภาพที่ผิดปกติได้', async () => {
    const group = await makeGroup()
    const payer = await makeMember(group.id)
    const expense = await makeExpense({
      groupId: group.id,
      payerMemberId: payer.id,
      totalSatang: 100000,
      shares: [{ memberId: payer.id, amountSatang: 1 }],
    })
    expect(expense.totalSatang).toBe(100000)
  })

  it('voidExpense มาร์กบิลโดยไม่ลบแถว', async () => {
    const group = await makeGroup()
    const payer = await makeMember(group.id)
    const expense = await makeExpense({
      groupId: group.id,
      payerMemberId: payer.id,
      totalSatang: 100,
      shares: [{ memberId: payer.id, amountSatang: 100 }],
    })
    await voidExpense(expense.id, payer.id)

    const { rows } = await getPool().query<{ status: string; voided_by: string }>(
      `select status, voided_by from expense where id = $1`,
      [expense.id],
    )
    expect(rows[0]?.status).toBe('voided')
    expect(rows[0]?.voided_by).toBe(payer.id)
  })
})

describe('การเคลียร์หนี้', () => {
  it('default เป็น claimed และยังไม่มีการยืนยัน (D8)', async () => {
    const group = await makeGroup()
    const [from, to] = await makeMembers(group.id, ['กอล์ฟ', 'เบียร์'])
    if (!from || !to) throw new Error('fixture ไม่ได้สร้างสมาชิกครบ')

    const settlement = await makeSettlement({
      groupId: group.id,
      fromMemberId: from.id,
      toMemberId: to.id,
      amountSatang: 50000,
    })
    expect(settlement.status).toBe('claimed')
    expect(settlement.claimedVia).toBe('liff')
    expect(settlement.claimedBy).toBe(from.id)
    expect(settlement.confirmedAt).toBeNull()
    expect(settlement.confirmedVia).toBeNull()
  })

  it('สร้างอันที่ confirmed แล้วได้ พร้อมข้อมูลฝั่งยืนยันครบ', async () => {
    const group = await makeGroup()
    const [from, to] = await makeMembers(group.id, ['กอล์ฟ', 'เบียร์'])
    if (!from || !to) throw new Error('fixture ไม่ได้สร้างสมาชิกครบ')

    const settlement = await makeSettlement({
      groupId: group.id,
      fromMemberId: from.id,
      toMemberId: to.id,
      amountSatang: 50000,
      status: 'confirmed',
      confirmedVia: 'link',
    })
    expect(settlement.status).toBe('confirmed')
    expect(settlement.confirmedAt).toBeInstanceOf(Date)
    expect(settlement.confirmedBy).toBe(to.id)
    expect(settlement.confirmedVia).toBe('link')
  })
})
