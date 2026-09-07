import { describe, expect, it } from 'vitest'
import { openLiffSession } from './session'
import type { OpenLiffSessionDeps } from './session'
import type { DraftRecord } from '@/lib/repo/drafts'

const CHANNEL_ID = '1234567890'
/** รูปแบบเดียวกับไฟล์เทสต์อื่นในโปรเจกต์ — repo public ห้ามมี id จริง */
const OWNER = 'U-test-1111-2222'
const STRANGER = 'U-test-3333-4444'
const DRAFT_ID = '11111111-2222-4333-8444-555555555555'

function draftRecord(over: Partial<DraftRecord> = {}): DraftRecord {
  return {
    id: DRAFT_ID,
    lineGroupId: 'C-test-group',
    lineUserId: OWNER,
    draft: {
      description: 'ข้าว',
      totalSatang: 120000,
      mode: 'equal',
      participants: [{ name: 'กอล์ฟ', weight: 1 }],
      includesPayer: true,
      adjustmentSatang: 0,
    },
    lines: [
      { name: 'คุณ', amountSatang: 60000, isNew: false, isPayer: true },
      { name: 'กอล์ฟ', amountSatang: 60000, isNew: true, isPayer: false },
    ],
    spentAt: '2026-09-07',
    createdAt: new Date(),
    ...over,
  }
}

/**
 * deps ที่นับว่าถูกเรียกไปกี่ครั้ง — ด่านที่สำคัญที่สุดของไฟล์นี้ครึ่งหนึ่งคือ
 * "ต้อง**ไม่**เรียกอะไรต่อ" ไม่ใช่ "คืนค่าอะไร"
 */
function deps(over: Partial<OpenLiffSessionDeps> = {}) {
  const calls = { verify: 0, find: 0 }
  const base: OpenLiffSessionDeps = {
    channelId: CHANNEL_ID,
    verifyIdToken: async () => {
      calls.verify += 1
      return { ok: true, lineUserId: OWNER }
    },
    findDraft: async () => {
      calls.find += 1
      return draftRecord()
    },
  }
  return { calls, deps: { ...base, ...over } }
}

describe('openLiffSession — ทางที่ผ่าน', () => {
  it('เจ้าของ draft เปิดได้ และได้ draft ทั้งใบกลับไปวาดหน้าจอ', async () => {
    const { deps: d } = deps()
    const result = await openLiffSession({ idToken: 'a.b.c', draftId: DRAFT_ID }, d)

    expect(result).toEqual({
      ok: true,
      session: {
        id: DRAFT_ID,
        draft: draftRecord().draft,
        lines: draftRecord().lines,
        spentAt: '2026-09-07',
      },
    })
  })

  it('ส่ง idToken ที่ตัดช่องว่างแล้วเข้า verify — คีย์บอร์ดมือถือแถมช่องว่างท้ายได้', async () => {
    let seen = ''
    const { deps: d } = deps({
      verifyIdToken: async (idToken) => {
        seen = idToken
        return { ok: true, lineUserId: OWNER }
      },
    })
    await openLiffSession({ idToken: ' a.b.c ', draftId: DRAFT_ID }, d)
    expect(seen).toBe('a.b.c')
  })

  /**
   * D15 — หน้าเว็บไม่ต้องรู้ `line_user_id` หรือ `line_group_id` ของใครเลย
   * มันเปิดจากในแอป LINE อยู่แล้ว และค่าเหล่านี้เป็น id จริงที่ใช้ยิง API ได้
   */
  it('ไม่ส่ง lineUserId / lineGroupId ออกไปให้ client', async () => {
    const { deps: d } = deps()
    const result = await openLiffSession({ idToken: 'a.b.c', draftId: DRAFT_ID }, d)
    const dumped = JSON.stringify(result)
    expect(dumped).not.toContain(OWNER)
    expect(dumped).not.toContain('C-test-group')
  })
})

describe('openLiffSession — ทางที่ต้องปฏิเสธ', () => {
  it('ไม่ได้ตั้ง LINE_LOGIN_CHANNEL_ID → misconfigured และไม่ยิง verify เลย', async () => {
    const { calls, deps: d } = deps({ channelId: '' })
    const result = await openLiffSession({ idToken: 'a.b.c', draftId: DRAFT_ID }, d)

    expect(result).toEqual({ ok: false, reason: 'misconfigured' })
    expect(calls.verify).toBe(0)
    expect(calls.find).toBe(0)
  })

  it.each([
    ['ว่าง', ''],
    ['ช่องว่างล้วน', '   '],
    ['ไม่ใช่ string', 42],
    ['หายไป', undefined],
  ])('idToken %s → bad-request และไม่ยิง verify', async (_label, idToken) => {
    const { calls, deps: d } = deps()
    const result = await openLiffSession({ idToken, draftId: DRAFT_ID }, d)

    expect(result).toEqual({ ok: false, reason: 'bad-request' })
    expect(calls.verify).toBe(0)
  })

  /**
   * `draftId` มาจาก query string ที่ใครก็แก้ได้ · `findDraft` ยิง `where id = $1`
   * ใส่ตาราง uuid ตรงๆ — ค่าที่ไม่ใช่ uuid ทำให้ Postgres โยน `invalid input
   * syntax for type uuid` ซึ่งเดินทางออกมาเป็น 500 ทุกครั้ง · ด่านนี้จึงต้องอยู่
   * **ก่อน** ถึง DB ไม่ใช่จับ error ทีหลัง
   */
  it.each([
    ['ไม่ใช่ uuid', 'ไม่ใช่ uuid'],
    ['sql ที่พยายามหลุด', "' or '1'='1"],
    ['ว่าง', ''],
    ['ไม่ใช่ string', { id: DRAFT_ID }],
    ['หายไป', undefined],
  ])('draftId %s → bad-request และไม่แตะ DB', async (_label, draftId) => {
    const { calls, deps: d } = deps()
    const result = await openLiffSession({ idToken: 'a.b.c', draftId }, d)

    expect(result).toEqual({ ok: false, reason: 'bad-request' })
    expect(calls.find).toBe(0)
  })

  it('uuid ตัวพิมพ์ใหญ่ยังผ่าน — Postgres ไม่แคร์ตัวพิมพ์', async () => {
    const { calls, deps: d } = deps({
      findDraft: async () => {
        calls.find += 1
        return draftRecord()
      },
    })
    const result = await openLiffSession(
      { idToken: 'a.b.c', draftId: DRAFT_ID.toUpperCase() },
      d,
    )
    expect(result.ok).toBe(true)
  })

  it('token ที่ verify ไม่ผ่าน → unauthenticated และไม่แตะ DB', async () => {
    const { calls, deps: d } = deps({ verifyIdToken: async () => ({ ok: false, reason: 'rejected' }) })
    const result = await openLiffSession({ idToken: 'a.b.c', draftId: DRAFT_ID }, d)

    expect(result).toEqual({ ok: false, reason: 'unauthenticated' })
    expect(calls.find).toBe(0)
  })

  it('draft หมดอายุหรือถูกยืนยันไปแล้ว → draft-gone', async () => {
    const { deps: d } = deps({ findDraft: async () => null })
    const result = await openLiffSession({ idToken: 'a.b.c', draftId: DRAFT_ID }, d)

    expect(result).toEqual({ ok: false, reason: 'draft-gone' })
  })

  /**
   * D26 — การ์ด Draft ลอยอยู่ในกลุ่ม ทุกคนเห็นและกดได้ · คนที่ไม่ได้พิมพ์กดเข้ามา
   * เป็นกรณีปกติ ไม่ใช่การโจมตี จึงแยกจาก `draft-gone` เพื่อบอกเหตุผลที่ถูกได้
   */
  it('คนอื่นในกลุ่มกดการ์ดของคนอื่น → not-owner', async () => {
    const { deps: d } = deps({
      verifyIdToken: async () => ({ ok: true, lineUserId: STRANGER }),
    })
    const result = await openLiffSession({ idToken: 'a.b.c', draftId: DRAFT_ID }, d)

    expect(result).toEqual({ ok: false, reason: 'not-owner' })
  })
})

/**
 * **ปลายทางเราล่ม ไม่ใช่คนที่กดทำอะไรผิด** — บอกว่า "เซสชันหมดอายุ" ตอน LINE
 * ตอบไม่ได้ หรือตอน Postgres ล่ม จะทำให้เขาไปกดจากการ์ดใหม่วนอยู่อย่างนั้น
 * ทั้งที่ไม่มีอะไรที่เขาทำแล้วดีขึ้น
 */
describe('openLiffSession — ของเราเองล่ม', () => {
  it('verify ไปหา LINE ไม่ถึง → upstream ไม่ใช่ unauthenticated', async () => {
    const { deps: d } = deps({
      verifyIdToken: async () => ({ ok: false, reason: 'unreachable' }),
    })
    const result = await openLiffSession({ idToken: 'a.b.c', draftId: DRAFT_ID }, d)
    expect(result).toEqual({ ok: false, reason: 'upstream' })
  })

  it('verify โยน error ที่ไม่ได้คาดไว้ → upstream ไม่ใช่ 500 ที่ไม่มีรูป', async () => {
    const { deps: d } = deps({
      verifyIdToken: async () => {
        throw new Error('boom')
      },
    })
    const result = await openLiffSession({ idToken: 'a.b.c', draftId: DRAFT_ID }, d)
    expect(result).toEqual({ ok: false, reason: 'upstream' })
  })

  it('Postgres ต่อไม่ได้ → upstream ไม่ใช่ draft-gone', async () => {
    const { deps: d } = deps({
      findDraft: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    const result = await openLiffSession({ idToken: 'a.b.c', draftId: DRAFT_ID }, d)
    expect(result).toEqual({ ok: false, reason: 'upstream' })
  })
})
