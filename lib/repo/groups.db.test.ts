/**
 * integration test ของ repository วง (โมดูล A)
 *
 * ทุกเทสต์สร้างวงของตัวเองแล้ว assert เฉพาะในวงนั้น — ไฟล์นี้รันขนานกับ
 * เทสต์ของโมดูลอื่นบน DB ตัวเดียวกัน ห้าม TRUNCATE ห้ามนับแถวทั้งตาราง
 *
 * เทสต์ที่ต้องการวงที่ถูกลบ ใช้ SQL ดิบมาร์กเอง ไม่เรียก `softDeleteGroup`
 * เพราะเทสต์ของ "หาวงที่ถูกลบเจอไหม" ไม่ควรแดงเมื่อ `softDeleteGroup` พัง
 */

import { createHash, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { closePool, getPool, withTransaction, type Queryable } from '@/lib/db/client'
import {
  makeAppUser,
  makeExpense,
  makeGroup,
  makeMembers,
  makePersonalGroup,
  makeSettlement,
  uniqueName,
} from '@/lib/db/fixtures'
import type { LedgerGroupRow } from '@/lib/db/rows'
import {
  createPersonalGroup,
  ensureLineGroup,
  findActiveGroupByLineGroupId,
  findGroupById,
  findGroupByLineGroupId,
  findGroupByOwnerTokenHash,
  hardDeleteGroup,
  linkPersonalGroupToLine,
  restoreGroup,
  rotateOwnerToken,
  softDeleteGroup,
} from '@/lib/repo/groups'

afterAll(async () => {
  await closePool()
})

// ─── ตัวช่วย ──────────────────────────────────────────────────────────

/** id ของกลุ่ม LINE หน้าตาเดียวกับของจริง และไม่ชนกับเทสต์ที่รันขนานอยู่ */
function newLineGroupId(): string {
  return `C${randomUUID().replace(/-/g, '')}`
}

function sha256(raw: string): Buffer {
  return createHash('sha256').update(raw).digest()
}

function newTokenHash(): Buffer {
  return sha256(randomUUID())
}

/** uuid ที่ไม่มีวงไหนถือ — ใช้พิสูจน์ทางที่ "ไม่เจอแถว" */
function missingId(): string {
  return randomUUID()
}

async function softDeleteRaw(groupId: string): Promise<void> {
  await getPool().query(
    `update ledger_group set status = 'soft_deleted', deleted_at = now() where id = $1`,
    [groupId],
  )
}

async function readRow(groupId: string): Promise<LedgerGroupRow> {
  const { rows } = await getPool().query<LedgerGroupRow>(
    `select * from ledger_group where id = $1`,
    [groupId],
  )
  const row = rows[0]
  if (!row) throw new Error(`ไม่พบวง ${groupId}`)
  return row
}

/**
 * Queryable ที่ระเบิดทันทีที่ถูกแตะ — ใช้พิสูจน์ว่า guard ทำงาน**ก่อน**ถึง DB
 * ไม่ใช่ปล่อยให้ constraint เป็นคนจับ
 */
const forbiddenDb: Queryable = {
  query: async () => {
    throw new Error('ไม่ควรมี query ถูกยิงในเคสนี้')
  },
}

// ─── หาวง ─────────────────────────────────────────────────────────────

describe('หาวง', () => {
  it('findGroupById คืนวงที่มีอยู่จริง', async () => {
    const group = await makeGroup()
    const found = await findGroupById(group.id)
    expect(found?.id).toBe(group.id)
    expect(found?.kind).toBe('line_group')
    expect(found?.lineGroupId).toBe(group.lineGroupId)
  })

  it('findGroupById คืน null เมื่อไม่มีวงนั้น', async () => {
    expect(await findGroupById(missingId())).toBeNull()
  })

  it('findGroupByLineGroupId คืนวงที่ผูกกับ id นั้น', async () => {
    const lineGroupId = newLineGroupId()
    const group = await makeGroup(undefined, { lineGroupId })
    const found = await findGroupByLineGroupId(lineGroupId)
    expect(found?.id).toBe(group.id)
  })

  it('findGroupByLineGroupId คืน null เมื่อยังไม่มีวงของ id นั้น', async () => {
    expect(await findGroupByLineGroupId(newLineGroupId())).toBeNull()
  })

  it('findGroupByLineGroupId เจอวงที่ถูก soft-delete ด้วย — ไม่งั้น restore ไม่ได้', async () => {
    const lineGroupId = newLineGroupId()
    const group = await makeGroup(undefined, { lineGroupId })
    await softDeleteRaw(group.id)

    const found = await findGroupByLineGroupId(lineGroupId)
    expect(found?.id).toBe(group.id)
    expect(found?.status).toBe('soft_deleted')
    expect(found?.deletedAt).not.toBeNull()
  })

  it('findActiveGroupByLineGroupId กรองวงที่ถูก soft-delete ออก', async () => {
    const lineGroupId = newLineGroupId()
    const group = await makeGroup(undefined, { lineGroupId })
    expect((await findActiveGroupByLineGroupId(lineGroupId))?.id).toBe(group.id)

    await softDeleteRaw(group.id)
    expect(await findActiveGroupByLineGroupId(lineGroupId)).toBeNull()
  })
})

// ─── ensureLineGroup ──────────────────────────────────────────────────

describe('ensureLineGroup', () => {
  it('สร้างวงใหม่เมื่อยังไม่เคยเห็น line_group_id นี้', async () => {
    const lineGroupId = newLineGroupId()
    const group = await ensureLineGroup(lineGroupId)

    expect(group.kind).toBe('line_group')
    expect(group.lineGroupId).toBe(lineGroupId)
    expect(group.status).toBe('active')
    expect(group.deletedAt).toBeNull()
    expect((await findGroupById(group.id))?.id).toBe(group.id)
  })

  it('idempotent — เรียกซ้ำด้วย id เดิมได้วงเดิม ไม่ใช่วงใหม่', async () => {
    const lineGroupId = newLineGroupId()
    const first = await ensureLineGroup(lineGroupId)
    const second = await ensureLineGroup(lineGroupId)
    expect(second.id).toBe(first.id)
    expect(second.createdAt).toEqual(first.createdAt)
  })

  it('webhook ยิงพร้อมกันหลายครั้งยังได้วงเดียว', async () => {
    const lineGroupId = newLineGroupId()
    const groups = await Promise.all([
      ensureLineGroup(lineGroupId),
      ensureLineGroup(lineGroupId),
      ensureLineGroup(lineGroupId),
      ensureLineGroup(lineGroupId),
      ensureLineGroup(lineGroupId),
    ])
    const ids = new Set(groups.map(g => g.id))
    expect(ids.size).toBe(1)
  })

  it('เชิญ bot กลับกลุ่มเดิม = restore วงเดิม ไม่ใช่วงใหม่', async () => {
    const lineGroupId = newLineGroupId()
    const original = await ensureLineGroup(lineGroupId)
    await softDeleteRaw(original.id)

    const back = await ensureLineGroup(lineGroupId)
    expect(back.id).toBe(original.id)
    expect(back.status).toBe('active')
    expect(back.deletedAt).toBeNull()
    expect(back.createdAt).toEqual(original.createdAt)
  })

  it('รับ client ของ transaction ที่ผู้เรียกเปิดไว้ — rollback แล้วต้องไม่เหลือวง', async () => {
    const lineGroupId = newLineGroupId()
    await expect(
      withTransaction(async tx => {
        await ensureLineGroup(lineGroupId, tx)
        throw new Error('ตั้งใจให้ rollback')
      }),
    ).rejects.toThrow('ตั้งใจให้ rollback')

    expect(await findGroupByLineGroupId(lineGroupId)).toBeNull()
  })
})

// ─── วงส่วนตัว ────────────────────────────────────────────────────────

describe('createPersonalGroup', () => {
  it('สร้างวงที่มีแต่ owner token hash ได้ (D22 — เจ้าของวงที่ยังไม่มี LINE)', async () => {
    const hash = newTokenHash()
    const group = await createPersonalGroup({ ownerTokenHash: hash })

    expect(group.kind).toBe('personal')
    expect(group.lineGroupId).toBeNull()
    expect(group.ownerId).toBeNull()
    expect(group.ownerTokenHash).toEqual(hash)
    expect(group.ownerTokenAt).not.toBeNull()
    expect(group.status).toBe('active')
  })

  it('สร้างวงที่มีแต่ owner_id ได้ และไม่ตั้ง owner_token_at', async () => {
    const user = await makeAppUser()
    const group = await createPersonalGroup({ ownerId: user.id })

    expect(group.ownerId).toBe(user.id)
    expect(group.ownerTokenHash).toBeNull()
    expect(group.ownerTokenAt).toBeNull()
  })

  it('สร้างวงที่มีทั้ง owner_id และ token hash ได้ (D23 — ผูก LINE แล้วยังใช้ลิงก์ได้)', async () => {
    const user = await makeAppUser()
    const hash = newTokenHash()
    const group = await createPersonalGroup({ ownerId: user.id, ownerTokenHash: hash })

    expect(group.ownerId).toBe(user.id)
    expect(group.ownerTokenHash).toEqual(hash)
  })

  it('ไม่มีทั้ง ownerId และ ownerTokenHash → พังก่อนถึง DB', async () => {
    await expect(createPersonalGroup({}, forbiddenDb)).rejects.toThrow(
      /ownerId.*ownerTokenHash|ownerTokenHash.*ownerId/,
    )
  })

  it('DB เองก็กัน — insert ดิบที่ไม่มีทางเข้าเลยต้องชน ledger_group_identity_check', async () => {
    await expect(
      getPool().query(`insert into ledger_group (kind) values ('personal')`),
    ).rejects.toThrow(/ledger_group_identity_check/)
  })
})

// ─── Owner token ──────────────────────────────────────────────────────

describe('Owner token', () => {
  it('findGroupByOwnerTokenHash คืนวงที่ถือ hash นั้น', async () => {
    const hash = newTokenHash()
    const group = await createPersonalGroup({ ownerTokenHash: hash })
    expect((await findGroupByOwnerTokenHash(hash))?.id).toBe(group.id)
  })

  it('findGroupByOwnerTokenHash คืน null เมื่อไม่มีวงไหนถือ hash นั้น', async () => {
    await createPersonalGroup({ ownerTokenHash: newTokenHash() })
    expect(await findGroupByOwnerTokenHash(newTokenHash())).toBeNull()
  })

  it('rotateOwnerToken — token เก่าใช้ไม่ได้ทันที (D20/D22 เพิกถอนด้วยการหมุน)', async () => {
    const oldHash = newTokenHash()
    const group = await createPersonalGroup({ ownerTokenHash: oldHash })
    const before = await readRow(group.id)

    const newHash = newTokenHash()
    const rotated = await rotateOwnerToken(group.id, newHash)

    expect(rotated.id).toBe(group.id)
    expect(rotated.ownerTokenHash).toEqual(newHash)
    expect(await findGroupByOwnerTokenHash(oldHash)).toBeNull()
    expect((await findGroupByOwnerTokenHash(newHash))?.id).toBe(group.id)
    expect(rotated.ownerTokenAt?.getTime() ?? 0).toBeGreaterThanOrEqual(
      before.owner_token_at?.getTime() ?? 0,
    )
  })

  it('rotateOwnerToken วงที่ไม่มี → throw ไม่ใช่คืน null เงียบๆ', async () => {
    await expect(rotateOwnerToken(missingId(), newTokenHash())).rejects.toThrow(/ไม่พบวง/)
  })

  it('ไม่มีคอลัมน์ไหนเก็บ token ตัวจริง — เก็บแต่ sha256', async () => {
    const rawToken = randomUUID() + randomUUID()
    const group = await createPersonalGroup({ ownerTokenHash: sha256(rawToken) })

    const row = await readRow(group.id)
    expect(row.owner_token_hash).toEqual(sha256(rawToken))

    for (const [column, value] of Object.entries(row)) {
      const asText = Buffer.isBuffer(value)
        ? `${value.toString('hex')} ${value.toString('utf8')}`
        : String(value)
      expect(asText, `คอลัมน์ ${column} มี token ตัวจริงอยู่`).not.toContain(rawToken)
    }
  })
})

// ─── ลบ / กู้คืน ──────────────────────────────────────────────────────

describe('soft-delete และ restore', () => {
  it('softDeleteGroup ตั้ง status และ deleted_at โดยไม่ลบแถว (D18)', async () => {
    const group = await makeGroup()
    const deleted = await softDeleteGroup(group.id)

    expect(deleted.status).toBe('soft_deleted')
    expect(deleted.deletedAt).not.toBeNull()
    expect((await findGroupById(group.id))?.status).toBe('soft_deleted')
  })

  it('softDeleteGroup ซ้ำไม่รีเซ็ตนาฬิกา 30 วัน', async () => {
    const group = await makeGroup()
    const first = await softDeleteGroup(group.id)
    const second = await softDeleteGroup(group.id)
    expect(second.deletedAt).toEqual(first.deletedAt)
  })

  it('softDeleteGroup วงที่ไม่มี → throw', async () => {
    await expect(softDeleteGroup(missingId())).rejects.toThrow(/ไม่พบวง/)
  })

  it('restoreGroup พาวงกลับมา active และล้าง deleted_at', async () => {
    const group = await makeGroup()
    await softDeleteRaw(group.id)

    const restored = await restoreGroup(group.id)
    expect(restored.status).toBe('active')
    expect(restored.deletedAt).toBeNull()
  })

  it('restoreGroup วงที่ไม่มี → throw', async () => {
    await expect(restoreGroup(missingId())).rejects.toThrow(/ไม่พบวง/)
  })
})

// ─── ผูกวงส่วนตัวเข้ากลุ่ม ────────────────────────────────────────────

describe('hardDeleteGroup', () => {
  /**
   * D18 ให้ลบข้อมูลตัวเองได้ และวงที่ soft-delete ครบ 30 วันต้องหายถาวร — แต่
   * `delete from ledger_group` ตรงๆ ทำไม่ได้เมื่อวงมีบิล เพราะ
   * `expense_share.member_id` ชี้ `member(id)` โดยไม่มี on-delete action
   * (ตั้งใจ: คนที่ยังมีบิลค้างอยู่ต้องลบทิ้งเฉยๆ ไม่ได้ ตาม "มาร์ก ไม่ลบ")
   * การลบทั้งวงจึงต้องไล่ลบลูกตามลำดับใน transaction เดียว
   */
  it('ลบวงที่มีบิล สมาชิก settlement และ audit ได้จนไม่เหลือเศษ', async () => {
    const group = await makeGroup()
    const [payer, other] = await makeMembers(group.id, [uniqueName('ก'), uniqueName('ข')])
    if (!payer || !other) throw new Error('fixture')
    const expense = await makeExpense({
      groupId: group.id,
      payerMemberId: payer.id,
      totalSatang: 20000,
      splitMode: 'itemized',
      shares: [
        { memberId: payer.id, amountSatang: 10000 },
        { memberId: other.id, amountSatang: 10000 },
      ],
    })
    const { rows: itemRows } = await getPool().query<{ id: string }>(
      `insert into expense_item (expense_id, name, amount_satang)
       values ($1, 'หมู', 20000) returning id`,
      [expense.id],
    )
    await getPool().query(
      `insert into expense_item_share (item_id, member_id) values ($1, $2)`,
      [itemRows[0]?.id, other.id],
    )
    await makeSettlement({
      groupId: group.id,
      fromMemberId: other.id,
      toMemberId: payer.id,
      amountSatang: 5000,
      status: 'confirmed',
    })
    await getPool().query(
      `insert into audit_log (group_id, actor, actor_via, action, target_type)
       values ($1, $2, 'line', 'expense.commit', 'expense')`,
      [group.id, payer.id],
    )

    await hardDeleteGroup(group.id)

    const { rows } = await getPool().query<{ leftovers: string }>(
      `select (select count(*) from ledger_group where id = $1)
            + (select count(*) from member where group_id = $1)
            + (select count(*) from expense where group_id = $1)
            + (select count(*) from settlement where group_id = $1)
            + (select count(*) from audit_log where group_id = $1)
            + (select count(*) from expense_share where expense_id = $2)
            + (select count(*) from expense_item where expense_id = $2)
              as leftovers`,
      [group.id, expense.id],
    )
    expect(Number(rows[0]?.leftovers)).toBe(0)
  })

  it('วงที่ไม่มีอยู่จริง → throw ไม่ใช่เงียบ', async () => {
    await expect(hardDeleteGroup(randomUUID())).rejects.toThrow(/ไม่พบวง/)
  })

  it('ไม่แตะวงอื่น', async () => {
    const doomed = await makeGroup()
    const keep = await makeGroup()
    const [a, b] = await makeMembers(keep.id, [uniqueName('ก'), uniqueName('ข')])
    if (!a || !b) throw new Error('fixture')
    await makeExpense({
      groupId: keep.id,
      payerMemberId: a.id,
      totalSatang: 1000,
      shares: [{ memberId: b.id, amountSatang: 1000 }],
    })

    await hardDeleteGroup(doomed.id)

    const { rows } = await getPool().query<{ n: number }>(
      `select count(*)::int as n from expense where group_id = $1`,
      [keep.id],
    )
    expect(rows[0]?.n).toBe(1)
  })
})

describe('linkPersonalGroupToLine', () => {
  it('ผูกแล้วกลายเป็นวงกลุ่ม และหาเจอด้วย line_group_id', async () => {
    const personal = await makePersonalGroup()
    const lineGroupId = newLineGroupId()

    const linked = await linkPersonalGroupToLine(personal.id, lineGroupId)
    expect(linked.id).toBe(personal.id)
    expect(linked.kind).toBe('line_group')
    expect(linked.lineGroupId).toBe(lineGroupId)
    expect(linked.ownerTokenHash).toEqual(personal.ownerTokenHash)

    expect((await findGroupByLineGroupId(lineGroupId))?.id).toBe(personal.id)
  })

  it('ทางเดียว — วงที่เป็นวงกลุ่มอยู่แล้วผูกซ้ำไม่ได้', async () => {
    const group = await makeGroup()
    await expect(linkPersonalGroupToLine(group.id, newLineGroupId())).rejects.toThrow(
      /วงกลุ่ม/,
    )
  })

  it('วงส่วนตัวที่ผูกไปแล้ว ผูกกลุ่มที่สองไม่ได้', async () => {
    const personal = await makePersonalGroup()
    await linkPersonalGroupToLine(personal.id, newLineGroupId())
    await expect(linkPersonalGroupToLine(personal.id, newLineGroupId())).rejects.toThrow(
      /วงกลุ่ม/,
    )
  })

  it('กลุ่ม LINE ที่มีวงอื่นถืออยู่แล้ว ผูกซ้ำไม่ได้ และบอกเหตุผลอ่านรู้เรื่อง', async () => {
    const lineGroupId = newLineGroupId()
    await makeGroup(undefined, { lineGroupId })
    const personal = await makePersonalGroup()

    await expect(linkPersonalGroupToLine(personal.id, lineGroupId)).rejects.toThrow(
      /มีวงอื่นผูกอยู่แล้ว/,
    )
  })

  it('วงที่ไม่มี → throw', async () => {
    await expect(linkPersonalGroupToLine(missingId(), newLineGroupId())).rejects.toThrow(
      /ไม่พบวง/,
    )
  })
})
