/**
 * โมดูล F — audit_log
 *
 * `audit_log` คือสิ่งที่ทำให้ D11 ทำงาน: ไม่มีระบบ permission ที่แก้บิลได้/ไม่ได้
 * แต่ทุกการกระทำตามรอยได้ และคนในวงเห็นกันเอง — สังคมคุมแทน permission
 *
 * ทุกเทสต์สร้างวงของตัวเองแล้ว assert เฉพาะในวงนั้น ห้าม TRUNCATE
 */

import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { closePool, getPool, withTransaction } from '@/lib/db/client'
import { makeGroup, makeMembers, uniqueName } from '@/lib/db/fixtures'
import type { ActorVia } from '@/lib/db/rows'
import { softDeleteGroup } from '@/lib/repo/groups'
import { listAudit, writeAudit } from '@/lib/repo/audit'

afterAll(closePool)

async function makeScene(): Promise<{ groupId: string; actor: string; other: string }> {
  const group = await makeGroup()
  const [actor, other] = await makeMembers(group.id, [uniqueName('ก'), uniqueName('ข')])
  if (!actor || !other) throw new Error('fixtures ไม่คืนสมาชิกครบ')
  return { groupId: group.id, actor: actor.id, other: other.id }
}

/** ค่าที่มาจากขอบระบบ (webhook body, LIFF) ซึ่ง TS ตรวจไม่ถึง */
function fromOutside(via: string): ActorVia {
  return via as ActorVia
}

describe('writeAudit', () => {
  it('เขียนแล้วคืน record ที่ map เป็น camelCase ครบ', async () => {
    const { groupId, actor } = await makeScene()

    const entry = await writeAudit({
      groupId,
      actor,
      actorVia: 'line',
      action: 'expense.void',
      targetType: 'expense',
      targetId: randomUUID(),
      before: { status: 'active' },
      after: { status: 'voided' },
    })

    expect(entry.id).toBeGreaterThan(0)
    expect(entry.groupId).toBe(groupId)
    expect(entry.actor).toBe(actor)
    expect(entry.actorVia).toBe('line')
    expect(entry.action).toBe('expense.void')
    expect(entry.targetType).toBe('expense')
    expect(entry.createdAt).toBeInstanceOf(Date)
  })

  it('before/after เก็บเป็น jsonb จริง ไม่ใช่สตริง', async () => {
    const { groupId, actor } = await makeScene()
    const entry = await writeAudit({
      groupId,
      actor,
      actorVia: 'liff',
      action: 'expense.update',
      targetType: 'expense',
      before: { totalSatang: 12000, ผู้จ่าย: 'กอล์ฟ', shares: [1, 2, 3] },
      after: { totalSatang: 15000, ผู้จ่าย: 'บาส', shares: [4, 5] },
    })

    // ถ้าเก็บเป็นสตริง `->>` จะคืน null — นี่คือด่านที่แยกสองกรณีออกจากกัน
    const { rows } = await getPool().query<{ total: string; name: string; count: number }>(
      `select after->>'totalSatang' as total,
              before->>'ผู้จ่าย'    as name,
              jsonb_array_length(before->'shares') as count
         from audit_log where id = $1`,
      [entry.id],
    )
    expect(rows[0]?.total).toBe('15000')
    expect(rows[0]?.name).toBe('กอล์ฟ')
    expect(rows[0]?.count).toBe(3)
  })

  it('อ่านกลับมาได้เป็น object เดิม ไม่ใช่สตริง JSON', async () => {
    const { groupId, actor } = await makeScene()
    const before = { nested: { a: [1, { b: 'ค' }] }, flag: false, missing: null }
    await writeAudit({
      groupId,
      actor,
      actorVia: 'web',
      action: 'group.rename',
      targetType: 'ledger_group',
      before,
      after: null,
    })

    const [entry] = await listAudit(groupId)
    expect(entry?.before).toEqual(before)
    expect(entry?.after).toBeNull()
  })

  it('ไม่ส่ง before/after มาเลย → เก็บเป็น null ทั้งคู่', async () => {
    const { groupId, actor } = await makeScene()
    await writeAudit({
      groupId,
      actor,
      actorVia: 'line',
      action: 'member.join',
      targetType: 'member',
    })

    const [entry] = await listAudit(groupId)
    expect(entry?.before).toBeNull()
    expect(entry?.after).toBeNull()
    expect(entry?.targetId).toBeNull()
  })

  it('เหตุการณ์ระดับระบบไม่มีวงและไม่มี actor ก็เขียนได้', async () => {
    const entry = await writeAudit({
      actorVia: 'web',
      action: 'ceiling.hit',
      targetType: 'system',
    })
    expect(entry.groupId).toBeNull()
    expect(entry.actor).toBeNull()
  })

  it('actorVia นอกสี่ค่าที่ DB ยอม → throw ก่อนแตะ DB', async () => {
    const { groupId, actor } = await makeScene()
    for (const via of ['sms', 'LINE', '', 'email']) {
      await expect(
        writeAudit({
          groupId,
          actor,
          actorVia: fromOutside(via),
          action: 'expense.void',
          targetType: 'expense',
        }),
      ).rejects.toThrow(/actorVia/)
    }
    expect(await listAudit(groupId)).toHaveLength(0)
  })

  it('action หรือ targetType ว่าง → throw', async () => {
    const { groupId, actor } = await makeScene()
    await expect(
      writeAudit({ groupId, actor, actorVia: 'line', action: '  ', targetType: 'expense' }),
    ).rejects.toThrow(/action/)
    await expect(
      writeAudit({ groupId, actor, actorVia: 'line', action: 'expense.void', targetType: '' }),
    ).rejects.toThrow(/targetType/)
    expect(await listAudit(groupId)).toHaveLength(0)
  })

  /**
   * เหตุผลเดียวกับที่ `expense.voided_by` ถูกตัดทิ้งและที่ `claimedBy` ต้องตรวจวง:
   * FK ชี้ `member(id)` การันตีแค่ว่ามีตัวตน ไม่ได้การันตีว่าอยู่วงเดียวกับเหตุการณ์
   * audit ที่ชี้คนนอกวงคือ audit ที่โกหก ซึ่งแย่กว่าไม่มี audit
   */
  it('actor จากวงอื่น → throw', async () => {
    const { groupId } = await makeScene()
    const stranger = await makeScene()

    await expect(
      writeAudit({
        groupId,
        actor: stranger.actor,
        actorVia: 'line',
        action: 'expense.void',
        targetType: 'expense',
      }),
    ).rejects.toThrow(/คนละวง/)
    expect(await listAudit(groupId)).toHaveLength(0)
  })

  /**
   * ต่างจาก `commitExpense`/`claimSettlement` ที่ปฏิเสธวงที่ถูกลบ — การลบวงเอง
   * ต้อง audit ได้ ไม่งั้นเหตุการณ์ที่สำคัญที่สุดคือเหตุการณ์เดียวที่ไม่มีร่องรอย
   */
  it('วงที่ soft-delete แล้วยังเขียน audit ได้', async () => {
    const { groupId, actor } = await makeScene()
    await softDeleteGroup(groupId)

    const entry = await writeAudit({
      groupId,
      actor,
      actorVia: 'line',
      action: 'group.soft_delete',
      targetType: 'ledger_group',
      targetId: groupId,
    })
    expect(entry.action).toBe('group.soft_delete')
  })

  it('ใช้ client ที่ผู้เรียกส่งมา — rollback แล้วไม่เหลือแถว', async () => {
    const { groupId, actor } = await makeScene()

    await expect(
      withTransaction(async tx => {
        await writeAudit(
          { groupId, actor, actorVia: 'line', action: 'expense.void', targetType: 'expense' },
          tx,
        )
        expect(await listAudit(groupId, {}, tx)).toHaveLength(1)
        throw new Error('ผู้เรียกล้ม transaction ของตัวเอง')
      }),
    ).rejects.toThrow('ผู้เรียกล้ม')

    expect(await listAudit(groupId)).toHaveLength(0)
  })
})

describe('listAudit', () => {
  it('เรียงใหม่สุดก่อน และ deterministic เมื่อ created_at ซ้ำ', async () => {
    const { groupId, actor } = await makeScene()
    // เขียนใน transaction เดียว → `now()` เท่ากันเป๊ะทุกแถว ต้อง tie-break ด้วย id
    await withTransaction(async tx => {
      for (let i = 0; i < 5; i++) {
        await writeAudit(
          {
            groupId,
            actor,
            actorVia: 'line',
            action: `step.${i}`,
            targetType: 'expense',
          },
          tx,
        )
      }
    })

    const first = await listAudit(groupId)
    expect(first.map(e => e.action)).toEqual([
      'step.4',
      'step.3',
      'step.2',
      'step.1',
      'step.0',
    ])
    expect((await listAudit(groupId)).map(e => e.id)).toEqual(first.map(e => e.id))
  })

  it('limit ตัดจากใหม่สุดลงมา', async () => {
    const { groupId, actor } = await makeScene()
    await withTransaction(async tx => {
      for (let i = 0; i < 4; i++) {
        await writeAudit(
          { groupId, actor, actorVia: 'line', action: `step.${i}`, targetType: 'expense' },
          tx,
        )
      }
    })

    const recent = await listAudit(groupId, { limit: 2 })
    expect(recent.map(e => e.action)).toEqual(['step.3', 'step.2'])
  })

  it('limit ที่ไม่ใช่ integer บวก → throw', async () => {
    const { groupId } = await makeScene()
    for (const limit of [0, -1, 1.5]) {
      await expect(listAudit(groupId, { limit })).rejects.toThrow(/limit/)
    }
  })

  it('ไม่ปนวงอื่น', async () => {
    const mine = await makeScene()
    const theirs = await makeScene()
    await writeAudit({
      groupId: mine.groupId,
      actor: mine.actor,
      actorVia: 'line',
      action: 'ของฉัน',
      targetType: 'expense',
    })
    await writeAudit({
      groupId: theirs.groupId,
      actor: theirs.actor,
      actorVia: 'line',
      action: 'ของเขา',
      targetType: 'expense',
    })

    const mineOnly = await listAudit(mine.groupId)
    expect(mineOnly.map(e => e.action)).toEqual(['ของฉัน'])
  })
})

describe('การลบวงจริงลบ audit ตามไปด้วย — ตั้งใจ ไม่ใช่อุบัติเหตุ', () => {
  /**
   * `on delete cascade` ตรงนี้คือสิ่งที่ทำให้ "ลบข้อมูลตัวเองได้" ของ D18 จบจริง
   * ถ้า audit ค้างอยู่หลังลบวง ข้อมูลที่ผู้ใช้ขอให้ลบจะยังอยู่ในตารางนี้ทั้งก้อน
   * — รวมทั้ง `before`/`after` ที่มีชื่อคนและยอดเงินอยู่ข้างใน
   */
  it('hard delete วง → audit ของวงนั้นหายหมด', async () => {
    const { groupId, actor } = await makeScene()
    await writeAudit({
      groupId,
      actor,
      actorVia: 'line',
      action: 'expense.commit',
      targetType: 'expense',
      after: { totalSatang: 12000 },
    })
    expect(await listAudit(groupId)).toHaveLength(1)

    await getPool().query(`delete from ledger_group where id = $1`, [groupId])

    const { rows } = await getPool().query<{ n: number }>(
      `select count(*)::int as n from audit_log where group_id = $1`,
      [groupId],
    )
    expect(rows[0]?.n).toBe(0)
  })
})
