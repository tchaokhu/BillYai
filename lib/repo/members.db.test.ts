/**
 * Integration test ของ Roster — โมดูล B
 *
 * ทุกเทสต์สร้างวงของตัวเองผ่าน `lib/db/fixtures.ts` แล้ว assert เฉพาะในวงนั้น
 * ห้าม TRUNCATE ห้าม db:reset — ไฟล์อื่นรันขนานกันอยู่
 */

import { createHash, randomUUID } from 'node:crypto'
import { DatabaseError } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { closePool, getPool, withTransaction, type Queryable } from '@/lib/db/client'
import { makeAppUser, makeGroup, makeMember, uniqueName } from '@/lib/db/fixtures'
import type { Member } from '@/lib/db/rows'
import { ensureAppUserByLineUserId } from './users'
import {
  claimMember,
  ensureMember,
  ensureMembers,
  findMemberByAppUser,
  findMemberById,
  findMemberByLineUserId,
  findMemberByLinkTokenHash,
  findMemberByName,
  issueNudgeToken,
  listMembers,
  markMemberLeft,
  markMemberRejoined,
} from '@/lib/repo/members'

afterAll(async () => {
  await closePool()
})

/** จำนวนสายที่ยิงพร้อมกันในเทสต์แข่งกัน — ต้องไม่เกิน max ของ pool */
const PARALLEL = 8

/**
 * เปิด connection ทิ้งไว้ให้ครบก่อนแข่ง — ถ้าไม่ทำ ตัวแรกจะ query เสร็จก่อนที่
 * ตัวที่สองจะต่อ connection ได้ด้วยซ้ำ ทำให้ "ขนาน" กลายเป็นเรียงกันเงียบๆ
 */
async function warmPool(n: number): Promise<void> {
  const clients = await Promise.all(Array.from({ length: n }, () => getPool().connect()))
  for (const client of clients) client.release()
}

/**
 * รอจนกว่า backend ตัวนั้นจะ**ติดล็อกจริง** ไม่ใช่รอตามเวลา
 *
 * นี่คือสิ่งที่ทำให้เทสต์แข่งกันข้างล่าง deterministic: เมื่อเห็นว่ามันติดล็อก
 * แปลว่ามันผ่านขั้นอ่านไปแล้วและกำลังรอเขียน ซึ่งคือจังหวะที่เราอยากให้อีกฝั่ง
 * commit พอดี. ถ้ารอด้วย setTimeout เฉยๆ ลำดับจะสลับเองบนเครื่องที่ช้ากว่า
 */
async function waitUntilBlocked(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { rows } = await getPool().query<{ blocked: boolean | null }>(
      `select wait_event_type = 'Lock' as blocked from pg_stat_activity where pid = $1`,
      [pid],
    )
    if (rows[0]?.blocked === true) return
    if (Date.now() > deadline) {
      throw new Error(`backend ${pid} ไม่ติดล็อกภายใน ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** sha256 ของ token สมมุติ — ตัว token จริงไม่เคยถูกเก็บ (D20) */
function tokenHash(seed = randomUUID()): Buffer {
  return createHash('sha256').update(seed).digest()
}

/** นับสมาชิกในวงเดียวโดยไม่ผ่าน repository — กันเทสต์เชื่อโค้ดที่กำลังทดสอบ */
async function countMembers(groupId: string, name?: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `select count(*)::int as n from member
     where group_id = $1 and ($2::text is null or display_name = $2)`,
    [groupId, name ?? null],
  )
  const row = rows[0]
  if (!row) throw new Error('count ไม่คืนแถว')
  return row.n
}

async function rawMember(id: string): Promise<{ left_group_at: Date | null } | undefined> {
  const { rows } = await getPool().query<{ left_group_at: Date | null }>(
    `select left_group_at from member where id = $1`,
    [id],
  )
  return rows[0]
}

/** เรียก fn แล้วคืน error ที่โยนออกมา — ใช้แทน rejects.toThrow เมื่อต้องดูฟิลด์ของ error */
async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
  } catch (err: unknown) {
    return err
  }
  throw new Error('คาดว่าจะ throw แต่ผ่านไปได้')
}

function asDatabaseError(err: unknown): DatabaseError {
  if (!(err instanceof DatabaseError)) {
    throw new Error(`คาดว่าเป็น DatabaseError จาก Postgres แต่ได้ ${String(err)}`)
  }
  return err
}

/** เกณฑ์เรียงของ listMembers ที่ประกาศไว้: created_at asc แล้ว id asc */
function byRosterOrder(a: Member, b: Member): number {
  const t = a.createdAt.getTime() - b.createdAt.getTime()
  if (t !== 0) return t
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// ─── findMemberById ───────────────────────────────────────────────────

describe('findMemberById', () => {
  it('คืน member ที่มีอยู่ แบบ camelCase ผ่าน mapper', async () => {
    const group = await makeGroup()
    const member = await makeMember(group.id, uniqueName())

    const found = await findMemberById(member.id)

    expect(found).not.toBeNull()
    expect(found?.id).toBe(member.id)
    expect(found?.groupId).toBe(group.id)
    expect(found?.displayName).toBe(member.displayName)
    expect(found?.appUserId).toBeNull()
    expect(found?.createdAt).toBeInstanceOf(Date)
  })

  it('คืน null เมื่อไม่มี id นั้น', async () => {
    expect(await findMemberById(randomUUID())).toBeNull()
  })
})

// ─── Roster ที่โตเอง (D16) ────────────────────────────────────────────

describe('ensureMember — Roster โตเอง (D16)', () => {
  it('ชื่อที่ยังไม่มีในวง สร้าง Placeholder ให้ (app_user_id null)', async () => {
    const group = await makeGroup()
    const name = uniqueName('กอล์ฟ')

    const member = await ensureMember(group.id, name)

    expect(member.groupId).toBe(group.id)
    expect(member.displayName).toBe(name)
    expect(member.appUserId).toBeNull()
    expect(member.claimedAt).toBeNull()
    expect(member.leftGroupAt).toBeNull()
    expect(member.linkTokenHash).toBeNull()
    expect(await countMembers(group.id, name)).toBe(1)
  })

  it('ชื่อเดิมในวงเดิม คืนตัวเดิม ไม่สร้างซ้ำ', async () => {
    const group = await makeGroup()
    const name = uniqueName('บาส')

    const first = await ensureMember(group.id, name)
    const second = await ensureMember(group.id, name)

    expect(second.id).toBe(first.id)
    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime())
    expect(await countMembers(group.id, name)).toBe(1)
  })

  it('ชื่อเดิมคนละวง เป็นคนละคน (D9)', async () => {
    const a = await makeGroup()
    const b = await makeGroup()
    const name = uniqueName('เมย์')

    const inA = await ensureMember(a.id, name)
    const inB = await ensureMember(b.id, name)

    expect(inA.id).not.toBe(inB.id)
    expect(inA.groupId).toBe(a.id)
    expect(inB.groupId).toBe(b.id)
  })

  it('คนสองคนพิมพ์ชื่อเดียวกันพร้อมกัน ต้องไม่พังด้วย unique violation', async () => {
    const group = await makeGroup()
    const name = uniqueName('พร้อมกัน')
    await warmPool(PARALLEL)

    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () => ensureMember(group.id, name)),
    )

    const ids = new Set(results.map((m) => m.id))
    expect(ids.size).toBe(1)
    expect(await countMembers(group.id, name)).toBe(1)
  })

  /**
   * Promise.all ข้างบนแข่งกันจริงแต่ไม่การันตีว่าจะซ้อนทับกันทุกครั้ง — ตัวนี้
   * บังคับให้ซ้อนแน่นอนด้วยสอง transaction ที่ค้างไว้ ถ้า ensureMember เป็น
   * select-then-insert ตัวที่สองจะได้ 23505 ทุกครั้งที่รัน ไม่ใช่บางครั้ง
   */
  it('อีกคนแทรกกลางระหว่าง select กับ insert — ตัวที่มาทีหลังต้องได้ตัวเดิม ไม่ใช่ error', async () => {
    const group = await makeGroup()
    const name = uniqueName('แทรกกลาง')
    const first = await getPool().connect()
    const second = await getPool().connect()

    try {
      await first.query('begin')
      await second.query('begin')
      const { rows } = await second.query<{ pid: number }>('select pg_backend_pid() as pid')
      const pid = rows[0]?.pid
      if (pid === undefined) throw new Error('หา backend pid ของ connection ที่สองไม่ได้')

      const inserted = await ensureMember(group.id, name, first)
      // second มองไม่เห็นแถวของ first ที่ยังไม่ commit จึงพยายามสร้างเอง แล้วติดล็อก
      const pending = ensureMember(group.id, name, second)
      pending.catch(() => {}) // กัน unhandledRejection ระหว่างรอ — ยัง throw ตอน await ข้างล่าง
      await waitUntilBlocked(pid)
      await first.query('commit')

      expect((await pending).id).toBe(inserted.id)
      await second.query('commit')
    } finally {
      first.release()
      second.release()
    }

    expect(await countMembers(group.id, name)).toBe(1)
  })

  it('ชื่อที่เจ้าของออกจากกลุ่มไปแล้ว คืนตัวเดิมโดยไม่ปลุกกลับเอง', async () => {
    const group = await makeGroup()
    const name = uniqueName('ออกไปแล้ว')
    const member = await ensureMember(group.id, name)
    await markMemberLeft(member.id)

    const again = await ensureMember(group.id, name)

    expect(again.id).toBe(member.id)
    expect(again.leftGroupAt).not.toBeNull()
  })

  it('ใช้ Queryable ที่ส่งเข้ามา — rollback แล้วต้องไม่เหลือแถว', async () => {
    const group = await makeGroup()
    const name = uniqueName('ล้มกลางคัน')

    await expect(
      withTransaction(async (tx: Queryable) => {
        await ensureMember(group.id, name, tx)
        throw new Error('พังกลางคัน')
      }),
    ).rejects.toThrow('พังกลางคัน')

    expect(await countMembers(group.id, name)).toBe(0)
  })
})

describe('findMemberByName', () => {
  it('เจอชื่อที่ตรงเป๊ะในวงนั้น', async () => {
    const group = await makeGroup()
    const member = await ensureMember(group.id, uniqueName('โอ๋'))

    const found = await findMemberByName(group.id, member.displayName)

    expect(found?.id).toBe(member.id)
  })

  it('คืน null เมื่อวงนั้นไม่รู้จักชื่อนี้', async () => {
    const group = await makeGroup()
    expect(await findMemberByName(group.id, uniqueName('ไม่มีตัวตน'))).toBeNull()
  })

  it('ไม่ข้ามวง — ชื่อเดียวกันในอีกวงไม่ถือว่าเจอ (D9)', async () => {
    const a = await makeGroup()
    const b = await makeGroup()
    const name = uniqueName('ข้ามวง')
    await ensureMember(a.id, name)

    expect(await findMemberByName(b.id, name)).toBeNull()
  })

  it('ยังเจอคนที่ออกจากกลุ่มไปแล้ว (D18 — มาร์กไม่ลบ)', async () => {
    const group = await makeGroup()
    const member = await ensureMember(group.id, uniqueName('ยังติดหนี้'))
    await markMemberLeft(member.id)

    const found = await findMemberByName(group.id, member.displayName)

    expect(found?.id).toBe(member.id)
    expect(found?.leftGroupAt).not.toBeNull()
  })
})

describe('ชื่อว่างสร้างไม่ได้', () => {
  /**
   * `display_name` ว่างสร้าง member ที่เป็นผู้จ่ายได้ ถือหนี้ได้ แต่เรียกชื่อใน
   * แชทไม่ได้ — และมันจองสล็อต `unique (group_id, display_name)` ของสตริงว่าง
   * ไว้ถาวร. rule parser สร้างไม่ได้ แต่ทาง LLM/LIFF ที่ Roster โตเองรองรับได้
   */
  it('ensureMember ด้วยชื่อว่างหรือช่องว่างล้วน → throw', async () => {
    const group = await makeGroup()
    for (const name of ['', '   ', '\t', '\n ']) {
      await expect(ensureMember(group.id, name)).rejects.toThrow(/ชื่อ/)
    }
    expect(await countMembers(group.id)).toBe(0)
  })

  it('ensureMembers ที่มีชื่อว่างปนมา → throw ทั้งชุด ไม่สร้างคนอื่นทิ้งไว้', async () => {
    const group = await makeGroup()
    await expect(
      ensureMembers(group.id, [uniqueName('ดี'), '  ', uniqueName('ดี2')]),
    ).rejects.toThrow(/ชื่อ/)
    expect(await countMembers(group.id)).toBe(0)
  })

  it('DB กันอีกชั้น — insert ตรงด้วยชื่อว่างต้องพังที่ constraint', async () => {
    const group = await makeGroup()
    await expect(
      getPool().query(`insert into member (group_id, display_name) values ($1, '  ')`, [
        group.id,
      ]),
    ).rejects.toThrow(/member_display_name_check/)
  })

  it('ชื่อที่มีช่องว่างหัวท้ายแต่มีตัวอักษรจริงยังใช้ได้ — แต่ถูกตัดช่องว่างก่อนเก็บ', async () => {
    // M2 เก็บดิบๆ · เปลี่ยนตอน M6 เพราะชื่อจาก LINE มีช่องว่างติดมาได้ แล้วชั้นที่
    // เทียบชื่อกับ Roster เทียบแบบ trim — ` กอล์ฟ ` ในตารางจึงไม่มีวันตรงกับ `กอล์ฟ`
    // ที่ส่งมาเทียบ ผลคือคนจ่ายหายจากบิล แล้วรอบถัดไปเกิด Member ที่สองของคนเดิม
    // ซึ่งลบไม่ได้ตลอดกาล (D18)
    const group = await makeGroup()
    const member = await ensureMember(group.id, ' กอล์ฟ ')
    expect(member.displayName).toBe('กอล์ฟ')
  })
})

describe('ensureMembers', () => {
  it('รักษาลำดับตาม input', async () => {
    const group = await makeGroup()
    const names = [uniqueName('ก'), uniqueName('ข'), uniqueName('ค')]

    const members = await ensureMembers(group.id, names)

    expect(members.map((m) => m.displayName)).toEqual(names)
  })

  it('ชื่อซ้ำใน input เดียวกัน ไม่สร้างซ้ำ แต่ยังคืนครบทุกตำแหน่ง', async () => {
    const group = await makeGroup()
    const dup = uniqueName('ซ้ำ')
    const other = uniqueName('ไม่ซ้ำ')

    const members = await ensureMembers(group.id, [dup, other, dup])

    expect(members).toHaveLength(3)
    expect(members.map((m) => m.displayName)).toEqual([dup, other, dup])
    expect(members[0]?.id).toBe(members[2]?.id)
    expect(await countMembers(group.id, dup)).toBe(1)
  })

  it('ผสมคนเดิมกับคนใหม่ — คนเดิมคืน id เดิม', async () => {
    const group = await makeGroup()
    const old = await ensureMember(group.id, uniqueName('คนเดิม'))
    const fresh = uniqueName('คนใหม่')

    const members = await ensureMembers(group.id, [fresh, old.displayName])

    expect(members[1]?.id).toBe(old.id)
    expect(members[0]?.displayName).toBe(fresh)
    expect(await countMembers(group.id)).toBe(2)
  })

  it('input ว่างคืน array ว่างโดยไม่แตะ DB', async () => {
    const group = await makeGroup()
    expect(await ensureMembers(group.id, [])).toEqual([])
    expect(await countMembers(group.id)).toBe(0)
  })

  /**
   * `on conflict do update` ล็อกแถวที่ชนตามลำดับที่มันเจอใน array — สองข้อความ
   * ในวงเดียวกันที่มาพร้อมกันแต่เรียงชื่อคนละทาง (`+ ข้าว 1200 กอล์ฟ บาส` กับ
   * `+ เหล้า 800 บาส กอล์ฟ`) จึงล็อกไขว้กันแล้ว Postgres ฆ่าทิ้งฝั่งหนึ่งด้วย
   * 40P01 deadlock detected
   *
   * เรียงชื่อก่อนยิงทำให้ทุกสายล็อกทิศทางเดียวกัน วงจรรอจึงเกิดไม่ได้ตั้งแต่ต้น
   */
  it('ยิงพร้อมกันด้วยลำดับชื่อสวนทางกัน → ต้องไม่ deadlock', async () => {
    const group = await makeGroup()
    const names = Array.from({ length: 6 }, (_, i) => uniqueName(`ผู้ร่วมหาร${i}`))
    // สร้างไว้ก่อน เพื่อให้ทุกสายเข้าทาง `do update` ซึ่งเป็นทางที่ล็อกแถวจริง
    await ensureMembers(group.id, names)
    await warmPool(PARALLEL)

    const reversed = [...names].reverse()
    for (let round = 0; round < 15; round++) {
      const results = await Promise.allSettled([
        ensureMembers(group.id, names),
        ensureMembers(group.id, reversed),
        ensureMembers(group.id, names),
        ensureMembers(group.id, reversed),
      ])
      const failed = results.filter((r) => r.status === 'rejected')
      expect(failed.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([])
    }

    expect(await countMembers(group.id)).toBe(names.length)
  })

  it('ใช้ Queryable ที่ส่งเข้ามา — rollback แล้วไม่เหลือแถว', async () => {
    const group = await makeGroup()
    const names = [uniqueName('tx1'), uniqueName('tx2')]

    await expect(
      withTransaction(async (tx: Queryable) => {
        await ensureMembers(group.id, names, tx)
        throw new Error('พังกลางคัน')
      }),
    ).rejects.toThrow('พังกลางคัน')

    expect(await countMembers(group.id)).toBe(0)
  })
})

// ─── listMembers ──────────────────────────────────────────────────────

describe('listMembers', () => {
  it('คืนเฉพาะสมาชิกของวงตัวเอง', async () => {
    const a = await makeGroup()
    const b = await makeGroup()
    await ensureMembers(a.id, [uniqueName(), uniqueName()])
    await ensureMembers(b.id, [uniqueName()])

    const inA = await listMembers(a.id)

    expect(inA).toHaveLength(2)
    expect(inA.every((m) => m.groupId === a.id)).toBe(true)
  })

  it('default ไม่รวมคนที่ออกจากกลุ่มไปแล้ว', async () => {
    const group = await makeGroup()
    const [stay, gone] = await ensureMembers(group.id, [uniqueName('อยู่'), uniqueName('ไป')])
    if (!stay || !gone) throw new Error('fixture ไม่ครบ')
    await markMemberLeft(gone.id)

    const list = await listMembers(group.id)

    expect(list.map((m) => m.id)).toEqual([stay.id])
  })

  it('includeLeft: true รวมคนที่ออกไปแล้ว (D18 — หนี้ค้างต้องยังโผล่)', async () => {
    const group = await makeGroup()
    const [stay, gone] = await ensureMembers(group.id, [uniqueName('อยู่'), uniqueName('ไป')])
    if (!stay || !gone) throw new Error('fixture ไม่ครบ')
    await markMemberLeft(gone.id)

    const list = await listMembers(group.id, { includeLeft: true })

    expect(list.map((m) => m.id).sort()).toEqual([stay.id, gone.id].sort())
    expect(list.find((m) => m.id === gone.id)?.leftGroupAt).toBeInstanceOf(Date)
  })

  it('เรียง created_at asc แล้ว id asc และเรียกซ้ำได้ลำดับเดิม', async () => {
    const group = await makeGroup()
    // ก้อนเดียวกัน = created_at เท่ากันเป๊ะ (now() เป็นเวลาของ statement)
    // ถ้าไม่มี tie-break ด้วย id ลำดับตรงนี้จะสลับเองระหว่างครั้ง
    await ensureMembers(group.id, [uniqueName('a'), uniqueName('b'), uniqueName('c')])
    await ensureMember(group.id, uniqueName('ทีหลัง'))

    const first = await listMembers(group.id)
    const second = await listMembers(group.id)

    expect(first.map((m) => m.id)).toEqual(second.map((m) => m.id))
    expect(first.map((m) => m.id)).toEqual([...first].sort(byRosterOrder).map((m) => m.id))
    // คนที่มาทีหลังอยู่ท้ายเสมอ — created_at เป็นเกณฑ์แรก ไม่ใช่ id
    expect(first[first.length - 1]?.displayName).toContain('ทีหลัง')
  })

  it('วงที่ยังไม่มีใครคืน array ว่าง', async () => {
    const group = await makeGroup()
    expect(await listMembers(group.id)).toEqual([])
  })
})

// ─── claim (D4, D10) ──────────────────────────────────────────────────

describe('claimMember', () => {
  it('ผูก app_user_id และปั๊ม claimed_at', async () => {
    const group = await makeGroup()
    const member = await ensureMember(group.id, uniqueName())
    const user = await makeAppUser()

    const claimed = await claimMember(member.id, user.id)

    expect(claimed.id).toBe(member.id)
    expect(claimed.appUserId).toBe(user.id)
    expect(claimed.claimedAt).toBeInstanceOf(Date)
  })

  it('claim ตัวที่ถูก claim ไปแล้วต้อง error', async () => {
    const group = await makeGroup()
    const member = await ensureMember(group.id, uniqueName())
    const first = await makeAppUser()
    const second = await makeAppUser()
    await claimMember(member.id, first.id)

    await expect(claimMember(member.id, second.id)).rejects.toThrow(/claim/)

    const still = await findMemberById(member.id)
    expect(still?.appUserId).toBe(first.id)
  })

  it('claim member ที่ไม่มีอยู่ต้อง throw ไม่ใช่คืน null เงียบๆ', async () => {
    const user = await makeAppUser()
    await expect(claimMember(randomUUID(), user.id)).rejects.toThrow(/ไม่พบ/)
  })

  it('คนเดียวถือสอง member ในวงเดียว — DB เป็นคนกัน ไม่ใช่โค้ด', async () => {
    const group = await makeGroup()
    const [one, two] = await ensureMembers(group.id, [uniqueName(), uniqueName()])
    if (!one || !two) throw new Error('fixture ไม่ครบ')
    const user = await makeAppUser()
    await claimMember(one.id, user.id)

    const err = asDatabaseError(await caught(() => claimMember(two.id, user.id)))

    expect(err.code).toBe('23505')
    expect(err.constraint).toBe('member_group_id_app_user_id_key')
  })

  it('คนเดียวถือ member คนละวงได้', async () => {
    const a = await makeGroup()
    const b = await makeGroup()
    const inA = await ensureMember(a.id, uniqueName())
    const inB = await ensureMember(b.id, uniqueName())
    const user = await makeAppUser()

    await claimMember(inA.id, user.id)
    const claimedB = await claimMember(inB.id, user.id)

    expect(claimedB.appUserId).toBe(user.id)
  })

  it('Placeholder หลายตัวในวงเดียวกันอยู่ร่วมกันได้ — null ไม่ชนใน unique index', async () => {
    const group = await makeGroup()

    const members = await ensureMembers(group.id, [
      uniqueName(),
      uniqueName(),
      uniqueName(),
      uniqueName(),
    ])

    expect(members).toHaveLength(4)
    expect(members.every((m) => m.appUserId === null)).toBe(true)
    expect(await countMembers(group.id)).toBe(4)
  })
})

describe('findMemberByAppUser', () => {
  it('เจอ member ของคนนั้นในวงนั้น', async () => {
    const group = await makeGroup()
    const member = await ensureMember(group.id, uniqueName())
    const user = await makeAppUser()
    await claimMember(member.id, user.id)

    const found = await findMemberByAppUser(group.id, user.id)

    expect(found?.id).toBe(member.id)
  })

  it('คืน null เมื่อคนนั้นยังไม่ claim อะไรในวงนี้', async () => {
    const group = await makeGroup()
    const user = await makeAppUser()
    expect(await findMemberByAppUser(group.id, user.id)).toBeNull()
  })

  it('ไม่ข้ามวง — claim ในวง A ไม่ทำให้เจอในวง B', async () => {
    const a = await makeGroup()
    const b = await makeGroup()
    const member = await ensureMember(a.id, uniqueName())
    const user = await makeAppUser()
    await claimMember(member.id, user.id)

    expect(await findMemberByAppUser(b.id, user.id)).toBeNull()
  })

  it('ยังเจอแม้เจ้าตัวออกจากกลุ่มไปแล้ว', async () => {
    const group = await makeGroup()
    const member = await ensureMember(group.id, uniqueName())
    const user = await makeAppUser()
    await claimMember(member.id, user.id)
    await markMemberLeft(member.id)

    expect((await findMemberByAppUser(group.id, user.id))?.id).toBe(member.id)
  })
})

// ─── ออกจากกลุ่ม / กลับเข้ากลุ่ม (D18) ────────────────────────────────

describe('markMemberLeft / markMemberRejoined', () => {
  it('มาร์กไม่ลบ — แถวยังอยู่ หนี้จึงยังตามได้', async () => {
    const group = await makeGroup()
    const member = await ensureMember(group.id, uniqueName())

    const left = await markMemberLeft(member.id)

    expect(left.leftGroupAt).toBeInstanceOf(Date)
    expect(await countMembers(group.id, member.displayName)).toBe(1)
    expect((await findMemberById(member.id))?.leftGroupAt).toBeInstanceOf(Date)
  })

  it('มาร์กซ้ำไม่เลื่อนเวลาที่ออกไปแล้ว', async () => {
    const group = await makeGroup()
    const member = await ensureMember(group.id, uniqueName())
    const first = await markMemberLeft(member.id)

    const second = await markMemberLeft(member.id)

    expect(second.leftGroupAt?.getTime()).toBe(first.leftGroupAt?.getTime())
  })

  it('markMemberLeft กับ id ที่ไม่มี ต้อง throw', async () => {
    await expect(markMemberLeft(randomUUID())).rejects.toThrow(/ไม่พบ/)
  })

  it('markMemberRejoined ล้าง left_group_at แล้วกลับมาใน listMembers', async () => {
    const group = await makeGroup()
    const member = await ensureMember(group.id, uniqueName())
    await markMemberLeft(member.id)

    const back = await markMemberRejoined(member.id)

    expect(back.leftGroupAt).toBeNull()
    expect((await rawMember(member.id))?.left_group_at).toBeNull()
    expect((await listMembers(group.id)).map((m) => m.id)).toEqual([member.id])
  })

  it('ออกอีกรอบหลังกลับเข้ามา ได้เวลาใหม่', async () => {
    const group = await makeGroup()
    const member = await ensureMember(group.id, uniqueName())
    const first = await markMemberLeft(member.id)
    await markMemberRejoined(member.id)

    const second = await markMemberLeft(member.id)

    expect(second.leftGroupAt).toBeInstanceOf(Date)
    expect(second.leftGroupAt?.getTime()).toBeGreaterThan(first.leftGroupAt?.getTime() ?? 0)
  })

  it('markMemberRejoined กับ id ที่ไม่มี ต้อง throw', async () => {
    await expect(markMemberRejoined(randomUUID())).rejects.toThrow(/ไม่พบ/)
  })
})

// ─── Nudge token (D20) ────────────────────────────────────────────────

describe('issueNudgeToken / findMemberByLinkTokenHash', () => {
  it('เก็บ hash และเวลาที่ออก token', async () => {
    const group = await makeGroup()
    const member = await ensureMember(group.id, uniqueName())
    const hash = tokenHash()

    const withToken = await issueNudgeToken(member.id, hash)

    expect(withToken.linkTokenHash?.equals(hash)).toBe(true)
    expect(withToken.linkTokenAt).toBeInstanceOf(Date)
  })

  it('หา member จาก hash ได้ และรู้ว่าอยู่วงไหน', async () => {
    const group = await makeGroup()
    const member = await ensureMember(group.id, uniqueName())
    const hash = tokenHash()
    await issueNudgeToken(member.id, hash)

    const found = await findMemberByLinkTokenHash(hash)

    expect(found?.id).toBe(member.id)
    expect(found?.groupId).toBe(group.id)
  })

  it('ออก token ใหม่ = อันเก่าใช้ไม่ได้ทันที (revoke by rotation)', async () => {
    const group = await makeGroup()
    const member = await ensureMember(group.id, uniqueName())
    const oldHash = tokenHash()
    const newHash = tokenHash()
    await issueNudgeToken(member.id, oldHash)

    await issueNudgeToken(member.id, newHash)

    expect(await findMemberByLinkTokenHash(oldHash)).toBeNull()
    expect((await findMemberByLinkTokenHash(newHash))?.id).toBe(member.id)
  })

  it('hash ที่ไม่เคยออกให้ใคร คืน null', async () => {
    expect(await findMemberByLinkTokenHash(tokenHash())).toBeNull()
  })

  it('token ชนกันข้ามคนต้องพังที่ DB ตอน insert ไม่ใช่ตอนใช้', async () => {
    const group = await makeGroup()
    const [one, two] = await ensureMembers(group.id, [uniqueName(), uniqueName()])
    if (!one || !two) throw new Error('fixture ไม่ครบ')
    const hash = tokenHash()
    await issueNudgeToken(one.id, hash)

    const err = asDatabaseError(await caught(() => issueNudgeToken(two.id, hash)))

    expect(err.code).toBe('23505')
    expect(err.constraint).toBe('member_link_token_hash_key')
  })

  it('issueNudgeToken กับ id ที่ไม่มี ต้อง throw', async () => {
    await expect(issueNudgeToken(randomUUID(), tokenHash())).rejects.toThrow(/ไม่พบ/)
  })

  it('คนที่ยังไม่เคยออก token ไม่ถูก match ด้วย hash ของคนอื่น', async () => {
    const group = await makeGroup()
    const [withToken, without] = await ensureMembers(group.id, [uniqueName(), uniqueName()])
    if (!withToken || !without) throw new Error('fixture ไม่ครบ')
    const hash = tokenHash()
    await issueNudgeToken(withToken.id, hash)

    expect((await findMemberByLinkTokenHash(hash))?.id).toBe(withToken.id)
    expect((await findMemberById(without.id))?.linkTokenHash).toBeNull()
  })
})

describe('findMemberByLineUserId — คนพิมพ์คือ Member ตัวไหนในวงนี้ (D29)', () => {
  it('ยังไม่มีใคร claim คืน null', async () => {
    const group = await makeGroup()
    expect(await findMemberByLineUserId(group.id, `U-test-${randomUUID()}`)).toBeNull()
  })

  it('claim แล้วเจอ', async () => {
    const group = await makeGroup()
    const member = await ensureMember(group.id, 'กอล์ฟ')
    const lineUserId = `U-test-${randomUUID()}`
    const user = await ensureAppUserByLineUserId(lineUserId)
    await claimMember(member.id, user.id)

    expect((await findMemberByLineUserId(group.id, lineUserId))?.id).toBe(member.id)
  })

  it('claim ในวงหนึ่งไม่ทำให้เจอในอีกวง — Member เป็นของวง ไม่ใช่ของคน (D9)', async () => {
    const first = await makeGroup()
    const second = await makeGroup()
    const member = await ensureMember(first.id, 'กอล์ฟ')
    const lineUserId = `U-test-${randomUUID()}`
    const user = await ensureAppUserByLineUserId(lineUserId)
    await claimMember(member.id, user.id)

    expect(await findMemberByLineUserId(second.id, lineUserId)).toBeNull()
  })
})

describe('ชื่อถูก trim ตอนเขียน — กัน Member ซ้ำแบบเงียบ', () => {
  it('`ensureMember` เก็บชื่อที่ตัดช่องว่างหัวท้ายแล้ว', async () => {
    const group = await makeGroup()
    const member = await ensureMember(group.id, '  กอล์ฟ  ')
    expect(member.displayName).toBe('กอล์ฟ')
  })

  it('ชื่อที่ต่างกันแค่ช่องว่างคือคนเดียวกัน ไม่ใช่สองแถว', async () => {
    // ชื่อจาก LINE มีช่องว่างติดมาได้ · เก็บดิบๆ แล้วรอบถัดไปจะกลายเป็นคนที่สอง
    // ซึ่งลบไม่ได้ตลอดกาล (D18) และหนี้ของเขาแตกเป็นสองก้อน
    const group = await makeGroup()
    const first = await ensureMember(group.id, 'ตูน')
    const second = await ensureMember(group.id, ' ตูน ')
    expect(second.id).toBe(first.id)
  })

  it('`ensureMembers` ก็ trim เหมือนกัน — ชื่อที่ต่างแค่ช่องว่างยุบเป็นแถวเดียว', async () => {
    const group = await makeGroup()
    const members = await ensureMembers(group.id, ['เบียร์', ' เบียร์ '])
    expect(new Set(members.map((m) => m.id)).size).toBe(1)
    const names = (await listMembers(group.id)).map((m) => m.displayName)
    expect(names.filter((n) => n === 'เบียร์')).toHaveLength(1)
  })
})
