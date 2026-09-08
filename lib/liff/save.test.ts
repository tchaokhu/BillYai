import { describe, expect, it } from 'vitest'
import { saveLiffDraft } from './save'
import type { SaveLiffDraftDeps, SaveLiffDraftBill } from './save'
import type { DraftRecord } from '@/lib/repo/drafts'

const CHANNEL_ID = '1234567890'
const OWNER = 'U-test-1111-2222'
const DRAFT_ID = '11111111-2222-4333-8444-555555555555'

function draftRecord(over: Partial<DraftRecord> = {}): DraftRecord {
  return {
    id: DRAFT_ID,
    lineGroupId: 'C-test-group',
    lineUserId: OWNER,
    draft: {
      description: 'soul bingsu',
      totalSatang: 48700,
      eventTag: 'เชียงใหม่',
      mode: 'equal',
      participants: [{ name: 'dear', weight: 1 }],
      includesPayer: true,
      adjustmentSatang: 0,
    },
    lines: [
      { name: 'คุณ', amountSatang: 24350, isNew: false, isPayer: true },
      { name: 'dear', amountSatang: 24350, isNew: false, isPayer: false },
    ],
    spentAt: '2026-09-07',
    createdAt: new Date(),
    ...over,
  }
}

/** บิลที่หน้าจอส่งกลับมา — ยอดที่จ่ายจริง 487.00 · รายชิ้นรวม 440.00 */
const BILL: SaveLiffDraftBill = {
  paidSatang: 48700,
  people: ['คุณ', 'dear'],
  items: [
    { name: 'บิงซู', amountSatang: 22000, eaterNames: ['คุณ', 'dear'] },
    { name: 'โทสต์', amountSatang: 18000, eaterNames: ['dear'] },
    { name: 'ชาเขียว', amountSatang: 4000, eaterNames: [] },
  ],
}

function deps(over: Partial<SaveLiffDraftDeps> = {}) {
  const saved: { input?: unknown } = {}
  const base: SaveLiffDraftDeps = {
    channelId: CHANNEL_ID,
    verifyIdToken: async () => ({ ok: true, lineUserId: OWNER }),
    findDraft: async () => draftRecord(),
    loadRoster: async () => ['dear', 'game'],
    updateDraft: async (input) => {
      saved.input = input
      return draftRecord({ draft: input.draft, lines: [...input.lines] })
    },
  }
  return { saved, deps: { ...base, ...over } }
}

function save(bill: unknown, over: Partial<SaveLiffDraftDeps> = {}) {
  const { saved, deps: d } = deps(over)
  return saveLiffDraft({ idToken: 'a.b.c', draftId: DRAFT_ID, bill }, d).then((result) => ({
    result,
    saved,
  }))
}

describe('saveLiffDraft — ยอดคำนวณใหม่ฝั่ง server เสมอ', () => {
  /**
   * **ตัวเลขที่หน้าจอโชว์ไม่ได้ถูกส่งมาเลย** — หน้าจอส่งมาแค่ราคาแต่ละชิ้นกับ
   * ใครกินอะไร ส่วนยอดรายคนคำนวณที่นี่ด้วย `splitExpense` ตัวเดียวกับที่แชทใช้ ·
   * เชื่อยอดที่ client ส่งมาแปลว่าใครก็เขียนหนี้ให้ใครเท่าไหร่ก็ได้
   */
  it('คืนยอดรายคนที่คำนวณเอง และผลรวมเท่ายอดที่จ่ายจริงเป๊ะ', async () => {
    const { result, saved } = await save(BILL)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const total = result.session.lines.reduce((sum, line) => sum + line.amountSatang, 0)
    expect(total).toBe(48700)
    expect(saved.input).toBeDefined()
  })

  it('เก็บผลรวมรายชิ้นลง `totalSatang` และส่วนต่างลง `adjustmentSatang` (D50)', async () => {
    const { result } = await save(BILL)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.session.draft.totalSatang).toBe(44000)
    expect(result.session.draft.adjustmentSatang).toBe(4700)
    expect(result.session.draft.mode).toBe('itemized')
  })

  it('รายการที่ไม่ติ๊กใครเลยหารกับทุกคนในบิล (D53)', async () => {
    const onlyShared = {
      ...BILL,
      paidSatang: 44000,
      items: [{ name: 'ชาเขียว', amountSatang: 44000, eaterNames: [] }],
    }
    const { result } = await save(onlyShared)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.session.lines.map((line) => line.amountSatang)).toEqual([22000, 22000])
  })

  it('ป้าย `(ใหม่)` มาจาก Roster ของวง ไม่ใช่จากที่ client บอก (D28)', async () => {
    const withNew = {
      ...BILL,
      people: ['คุณ', 'dear', 'แนน'],
      items: [{ name: 'บิงซู', amountSatang: 44000, eaterNames: ['แนน'] }],
    }
    const { result } = await save(withNew)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const byName = new Map(result.session.lines.map((line) => [line.name, line.isNew]))
    expect(byName.get('dear')).toBe(false)
    expect(byName.get('แนน')).toBe(true)
  })

  /**
   * `buildDraft` จงใจไม่ติดป้ายให้คนพิมพ์ (`lib/flow/draft.ts`) — ป้ายนี้ถามว่า
   * "พิมพ์ชื่อผิดหรือเปล่า" ซึ่งไม่มีความหมายกับคนที่ยังไม่ถูกระบุตัวตน · แถวของ
   * เขาชื่อ `คุณ` ซึ่งไม่มีวันอยู่ใน Roster การเทียบตรงๆ จึงติดป้ายให้ทุกครั้ง
   */
  it('แถวคนจ่ายไม่ติดป้าย `(ใหม่)` ต่อให้ชื่อ `คุณ` ไม่เคยอยู่ใน Roster', async () => {
    const { result } = await save(BILL)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.session.lines.find((line) => line.isPayer)?.isNew).toBe(false)
  })

  it('บิลที่คนจ่ายกินด้วย ยังคง `includesPayer` ไว้หลังเซฟ', async () => {
    const { result } = await save(BILL)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.session.draft.includesPayer).toBe(true)
    expect(result.session.lines.find((line) => line.isPayer)?.name).toBe('คุณ')
  })

  it('เก็บ `description` กับ `eventTag` เดิมไว้ — หน้าจอแก้รายการ ไม่ได้แก้ชื่อบิล', async () => {
    const { result } = await save(BILL)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.session.draft.description).toBe('soul bingsu')
    expect(result.session.draft.eventTag).toBe('เชียงใหม่')
  })

  it('ส่วนลดที่ทำให้ยอดจริงต่ำกว่าผลรวมรายชิ้นบันทึกได้ (D54)', async () => {
    const { result } = await save({ ...BILL, paidSatang: 40000 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.session.draft.adjustmentSatang).toBe(-4000)
  })
})

/**
 * `+ ข้าว 1200 กอล์ฟ ตูน` — คนพิมพ์จ่ายแทนล้วน ไม่ได้กินด้วย · draft แบบนี้
 * `includesPayer: false` และ **ไม่มีแถวไหน `isPayer` เลย** ซึ่งถูกต้องแล้ว
 */
describe('saveLiffDraft — คนจ่ายที่ไม่ได้อยู่ในบิล', () => {
  const RECORD = draftRecord({
    draft: {
      description: 'ข้าว',
      totalSatang: 120000,
      mode: 'equal',
      participants: [
        { name: 'กอล์ฟ', weight: 1 },
        { name: 'ตูน', weight: 1 },
      ],
      includesPayer: false,
      adjustmentSatang: 0,
    },
    lines: [
      { name: 'กอล์ฟ', amountSatang: 60000, isNew: false, isPayer: false },
      { name: 'ตูน', amountSatang: 60000, isNew: false, isPayer: false },
    ],
  })

  const BILL_OUTSIDE = {
    paidSatang: 120000,
    people: ['กอล์ฟ', 'ตูน'],
    items: [{ name: 'ข้าว', amountSatang: 120000, eaterNames: [] }],
  }

  /**
   * แถว `isPayer` แปลว่า "แถวนี้เป็นของคนที่กดยืนยัน" — `commitExpense` เอา
   * `payerMemberId` ยัดให้แถวนั้นตรงๆ · ติดป้ายผิดคนแปลว่าคนนั้นหายจากบิลทั้งคน
   * และคนจ่ายรับหนี้ของเขาไปเงียบๆ · client จึงตั้งคนจ่ายเองไม่ได้เด็ดขาด
   */
  it('ไม่มีแถวไหนเป็นคนจ่าย ต่อให้ client ยืนยันว่ามี', async () => {
    const { result } = await save(
      { ...BILL_OUTSIDE, payerName: 'กอล์ฟ' },
      { findDraft: async () => RECORD },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.session.lines.filter((line) => line.isPayer)).toEqual([])
    expect(result.session.draft.includesPayer).toBe(false)
  })
})

describe('saveLiffDraft — ทางที่ต้องปฏิเสธ', () => {
  it('คนอื่นในกลุ่มเซฟทับการ์ดของคนอื่นไม่ได้ และต้องไม่เขียนอะไรเลย', async () => {
    const { result, saved } = await save(BILL, {
      verifyIdToken: async () => ({ ok: true, lineUserId: 'U-test-9999' }),
    })
    expect(result).toEqual({ ok: false, reason: 'not-owner' })
    expect(saved.input).toBeUndefined()
  })

  it.each([
    ['ไม่ใช่ object', 'บิล'],
    ['ไม่มีรายการเลย', { ...BILL, items: [] }],
    ['ไม่มีคนในบิล', { ...BILL, people: [], items: [] }],
    // คนจ่ายหลุดออกจากบิล = ไม่มีแถวไหนรับ `payerMemberId` ตอนยืนยัน (D55)
    ['คนจ่ายถูกเอาออกจากบิล', { ...BILL, people: ['dear'], items: [{ name: 'x', amountSatang: 44000, eaterNames: ['dear'] }] }],
    ['ชื่อคนซ้ำในบิล', { ...BILL, people: ['คุณ', 'คุณ'] }],
    ['คนกินที่ไม่ได้อยู่ในบิล', { ...BILL, items: [{ name: 'x', amountSatang: 44000, eaterNames: ['ผี'] }] }],
    ['ยอดที่จ่ายจริงเป็นศูนย์', { ...BILL, paidSatang: 0 }],
    ['ยอดที่จ่ายจริงไม่ใช่ integer', { ...BILL, paidSatang: 48700.5 }],
    ['ราคารายการติดลบ', { ...BILL, items: [{ name: 'x', amountSatang: -1, eaterNames: [] }] }],
    // `assertItems` ต้องการ `> 0` — ปล่อยผ่านที่นี่แปลว่า 500 ตอนกดยืนยัน
    [
      'รายการราคาศูนย์ปนอยู่กับรายการที่มีราคา',
      {
        ...BILL,
        paidSatang: 44000,
        items: [
          { name: 'บิงซู', amountSatang: 44000, eaterNames: ['คุณ'] },
          { name: 'น้ำเปล่า', amountSatang: 0, eaterNames: ['dear'] },
        ],
      },
    ],
    ['ผลรวมรายชิ้นเป็นศูนย์', { ...BILL, paidSatang: 100, items: [{ name: 'x', amountSatang: 0, eaterNames: [] }] }],
  ])('%s → bad-request และไม่เขียนอะไรเลย', async (_label, bill) => {
    const { result, saved } = await save(bill)
    expect(result).toEqual({ ok: false, reason: 'bad-request' })
    expect(saved.input).toBeUndefined()
  })

  /**
   * ราคาติดลบที่ **ผลรวมยังเป็นบวก** — ด่าน `totalSatang <= 0` ไม่ช่วยตรงนี้ ·
   * ส่วนลดเป็นของทั้งบิล (`adjustmentSatang`) ไม่ใช่ของชิ้นใดชิ้นหนึ่ง
   */
  it('รายการติดลบที่ซ่อนอยู่ในบิลที่ผลรวมยังบวก → bad-request', async () => {
    const { result, saved } = await save({
      ...BILL,
      paidSatang: 44000,
      items: [
        { name: 'บิงซู', amountSatang: 48000, eaterNames: ['คุณ'] },
        { name: 'คูปอง', amountSatang: -4000, eaterNames: ['คุณ'] },
      ],
    })
    expect(result).toEqual({ ok: false, reason: 'bad-request' })
    expect(saved.input).toBeUndefined()
  })

  it('การ์ดหมดอายุระหว่างที่หน้าจอเปิดค้าง → draft-gone', async () => {
    const { result } = await save(BILL, { findDraft: async () => null })
    expect(result).toEqual({ ok: false, reason: 'draft-gone' })
  })

  it('การ์ดถูกกดยืนยันไปแล้วระหว่างเซฟ → draft-gone ไม่ใช่เขียนสำเร็จ', async () => {
    const { result } = await save(BILL, { updateDraft: async () => null })
    expect(result).toEqual({ ok: false, reason: 'draft-gone' })
  })

  it('เขียนไม่ลง → upstream', async () => {
    const { result } = await save(BILL, {
      updateDraft: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    expect(result).toEqual({ ok: false, reason: 'upstream' })
  })
})
