import { describe, expect, it } from 'vitest'
import { parseDraftPayload, parseStoredDraft } from './draft-payload'
import type { DraftLine, ExpenseDraft } from '@/lib/types'

const VALID: ExpenseDraft = {
  description: 'ข้าว',
  totalSatang: 120000,
  mode: 'equal',
  participants: [
    { name: 'กอล์ฟ', weight: 2 },
    { name: 'ตูน', weight: 1 },
  ],
  includesPayer: false,
  adjustmentSatang: 0,
}

/** payload ที่แก้ทีละฟิลด์ — ของจริงเดินทางผ่าน `JSON.stringify` เสมอ */
function withField(key: string, value: unknown): unknown {
  return JSON.parse(JSON.stringify({ ...VALID, [key]: value }))
}

describe('parseDraftPayload — payload ที่ถูกต้อง', () => {
  it('ผ่าน `JSON.stringify` แล้วกลับมาเหมือนเดิมเป๊ะ', () => {
    expect(parseDraftPayload(JSON.parse(JSON.stringify(VALID)))).toEqual(VALID)
  })

  it('`eventTag` ที่มีก็เก็บไว้', () => {
    const withTag = { ...VALID, eventTag: 'เชียงใหม่' }
    expect(parseDraftPayload(JSON.parse(JSON.stringify(withTag)))).toEqual(withTag)
  })

  it('ไม่มี `eventTag` ต้องไม่มีคีย์นั้นเลย ไม่ใช่ undefined', () => {
    // `exactOptionalPropertyTypes` เปิดอยู่ — และ `commitExpense` แยกสองกรณีนี้
    const parsed = parseDraftPayload(JSON.parse(JSON.stringify(VALID)))
    expect(parsed).not.toBeNull()
    expect(parsed !== null && 'eventTag' in parsed).toBe(false)
  })

  it('ไม่มีผู้ร่วมหารสักคน = ยังใช้ได้ (หารทุกคนใน Roster)', () => {
    const everyone = { ...VALID, participants: [], includesPayer: true }
    expect(parseDraftPayload(JSON.parse(JSON.stringify(everyone)))).toEqual(everyone)
  })

  it('ทิ้งฟิลด์แปลกปลอมที่ไม่ได้อยู่ในสัญญา', () => {
    const parsed = parseDraftPayload({ ...VALID, ของแปลก: 1, __proto__: { evil: true } })
    expect(parsed).toEqual(VALID)
  })
})

describe('parseDraftPayload — payload ที่เชื่อไม่ได้คืน null ไม่ throw', () => {
  it.each([null, undefined, 'ข้อความ', 42, [], true])('%j', (value) => {
    expect(parseDraftPayload(value)).toBeNull()
  })

  it.each([
    ['description ว่าง', 'description', '   '],
    ['description ไม่ใช่สตริง', 'description', 7],
    ['ยอดเป็นศูนย์', 'totalSatang', 0],
    ['ยอดติดลบ', 'totalSatang', -1],
    ['ยอดมีทศนิยม', 'totalSatang', 1200.5],
    ['ยอดเป็นสตริง', 'totalSatang', '120000'],
    ['โหมดที่ไม่รู้จัก', 'mode', 'weighted'],
    ['includesPayer ไม่ใช่ boolean', 'includesPayer', 'true'],
    ['ส่วนปรับไม่ใช่ integer', 'adjustmentSatang', 47.5],
    ['ส่วนลดใหญ่กว่ายอดบิล', 'adjustmentSatang', -999_999],
    ['participants ไม่ใช่ array', 'participants', {}],
    ['ชื่อว่าง', 'participants', [{ name: '  ', weight: 1 }]],
    ['น้ำหนักเป็นศูนย์', 'participants', [{ name: 'กอล์ฟ', weight: 0 }]],
    ['น้ำหนักติดลบ', 'participants', [{ name: 'กอล์ฟ', weight: -2 }]],
    ['น้ำหนักหาย', 'participants', [{ name: 'กอล์ฟ' }]],
    ['eventTag ว่าง', 'eventTag', ''],
    ['eventTag ไม่ใช่สตริง', 'eventTag', 5],
  ])('%s', (_label, key, value) => {
    expect(parseDraftPayload(withField(key, value))).toBeNull()
  })

  it('ฟิลด์ที่หายไปทั้งอัน', () => {
    for (const key of Object.keys(VALID)) {
      const partial: Record<string, unknown> = { ...VALID }
      delete partial[key]
      expect(parseDraftPayload(JSON.parse(JSON.stringify(partial)))).toBeNull()
    }
  })
})

describe('น้ำหนักต้องอยู่ในช่วงที่ `distribute` รองรับจริง', () => {
  // ไม่ใช่แค่ "มากกว่าศูนย์" — payload ที่เขียนลงตารางได้วันนี้ต้องคำนวณได้ตอน commit
  it.each([1e-7, 1e21, 0.0001, 100000])('น้ำหนัก %s ไม่ผ่าน', (weight) => {
    expect(parseDraftPayload(withField('participants', [{ name: 'กอล์ฟ', weight }]))).toBeNull()
  })

  it.each([1, 2, 1.5, 0.001, 99999.999])('น้ำหนัก %s ผ่าน', (weight) => {
    expect(parseDraftPayload(withField('participants', [{ name: 'กอล์ฟ', weight }]))).not.toBeNull()
  })
})

const ITEMIZED: ExpenseDraft = {
  description: 'soul bingsu',
  // **ผลรวมรายชิ้น ไม่ใช่ยอดที่จ่ายจริง** — ส่วนต่างอยู่ใน `adjustmentSatang`
  totalSatang: 44000,
  mode: 'itemized',
  participants: [
    { name: 'aek', weight: 1 },
    { name: 'dear', weight: 1 },
  ],
  includesPayer: true,
  adjustmentSatang: 4700,
  items: [
    { name: 'บิงซู', amountSatang: 22000, eaterNames: ['aek', 'dear'] },
    { name: 'ฮันนี่โทสต์', amountSatang: 18000, eaterNames: ['aek'] },
    // ไม่ติ๊กใครเลย = ของกลาง หารทุกคนในบิล (D53)
    { name: 'ชาเขียว', amountSatang: 4000, eaterNames: [] },
  ],
}

function itemized(items: unknown, over: Record<string, unknown> = {}): unknown {
  return JSON.parse(JSON.stringify({ ...ITEMIZED, items, ...over }))
}

describe('parseDraftPayload — รายการรายชิ้น (D48 · หน้าจอ LIFF)', () => {
  it('บิล itemized ผ่าน `JSON.stringify` แล้วกลับมาครบ รวมรายการของกลาง', () => {
    expect(parseDraftPayload(JSON.parse(JSON.stringify(ITEMIZED)))).toEqual(ITEMIZED)
  })

  it('โหมดอื่นต้องไม่มี `items` — ส่งมาแปลว่าคนเขียนเข้าใจผิด', () => {
    expect(parseDraftPayload(withField('items', ITEMIZED.items))).toBeNull()
  })

  it('โหมด itemized ที่ไม่มีรายการเลยใช้ไม่ได้', () => {
    expect(parseDraftPayload(itemized([]))).toBeNull()
    expect(parseDraftPayload(itemized(undefined))).toBeNull()
  })

  /**
   * **ด่านเดียวกับ `itemizedSubtotals`** — มันโยนเมื่อผลรวมรายการไม่เท่ายอดบิล
   * และ throw ตรงนั้นแปลว่า 500 ระหว่างกดยืนยัน · จับที่นี่ = การ์ดใช้ไม่ได้
   * ซึ่งเป็นคำตอบที่ผู้ใช้ทำอะไรต่อได้
   */
  it('ผลรวมรายการต้องเท่า `totalSatang` เป๊ะ', () => {
    expect(parseDraftPayload(itemized([{ ...ITEMIZED.items?.[0] }]))).toBeNull()
  })

  it('ราคารายการติดลบไม่ได้ ต่างจากส่วนปรับ', () => {
    expect(
      parseDraftPayload(
        itemized(
          [
            { name: 'บิงซู', amountSatang: 48000, eaterNames: ['aek'] },
            { name: 'ส่วนลด', amountSatang: -4000, eaterNames: ['aek'] },
          ],
          { totalSatang: 44000 },
        ),
      ),
    ).toBeNull()
  })

  it('ชื่อคนกินซ้ำในรายการเดียวใช้ไม่ได้', () => {
    expect(
      parseDraftPayload(
        itemized([{ name: 'บิงซู', amountSatang: 44000, eaterNames: ['aek', 'aek'] }]),
      ),
    ).toBeNull()
  })

  it.each([
    ['ชื่อรายการว่าง', [{ name: '  ', amountSatang: 44000, eaterNames: [] }]],
    ['ราคาไม่ใช่ integer', [{ name: 'บิงซู', amountSatang: 44000.5, eaterNames: [] }]],
    // `assertItems` ใน `expenses.ts` ต้องการ `> 0` — ต้องตรงกันทุกชั้น
    [
      'ราคาศูนย์',
      [
        { name: 'บิงซู', amountSatang: 44000, eaterNames: [] },
        { name: 'น้ำเปล่า', amountSatang: 0, eaterNames: [] },
      ],
    ],
    ['ไม่มี eaterNames', [{ name: 'บิงซู', amountSatang: 44000 }]],
    ['eaterNames ไม่ใช่ array', [{ name: 'บิงซู', amountSatang: 44000, eaterNames: 'aek' }]],
    ['ชื่อคนกินว่าง', [{ name: 'บิงซู', amountSatang: 44000, eaterNames: [''] }]],
    ['ไม่ใช่ object', ['บิงซู']],
  ])('%s → null', (_label, items) => {
    expect(parseDraftPayload(itemized(items))).toBeNull()
  })
})

/**
 * **ชื่อคนกินต้องอยู่ในแถวของการ์ด** — invariant ข้ามสองส่วนของ payload ซึ่งมีที่
 * ตรวจได้ที่เดียวคือตรงนี้ · ปล่อยผ่านแล้วมันจะไปโผล่ตอน `confirmDraft` **หลัง**
 * `deleteDraft` ไปแล้ว ซึ่งแปลว่าการ์ดหายทั้งที่บิลไม่ได้ลง — กับดักที่
 * `lib/repo/confirm.ts` เตือนไว้เองในหัวไฟล์
 */
describe('parseStoredDraft — รายการต้องอ้างคนที่อยู่บนการ์ดเท่านั้น', () => {
  const LINES: DraftLine[] = [
    { name: 'aek', amountSatang: 24350, isNew: false, isPayer: true },
    { name: 'dear', amountSatang: 24350, isNew: false, isPayer: false },
  ]

  function stored(items: unknown): unknown {
    return JSON.parse(JSON.stringify({ draft: { ...ITEMIZED, items }, lines: LINES }))
  }

  it('ชื่อคนกินที่อยู่ครบบนการ์ด → ผ่าน', () => {
    expect(parseStoredDraft(stored(ITEMIZED.items))).not.toBeNull()
  })

  it('ชื่อคนกินที่ไม่มีบนการ์ด → null ตั้งแต่ตอนอ่าน ไม่ใช่ตอน commit', () => {
    expect(
      parseStoredDraft(stored([{ name: 'บิงซู', amountSatang: 44000, eaterNames: ['ไม่มีคนนี้'] }])),
    ).toBeNull()
  })

  it('ของกลาง (ไม่ติ๊กใครเลย) ยังผ่าน — ไม่ได้อ้างใครจึงไม่มีอะไรให้ผิด', () => {
    expect(
      parseStoredDraft(stored([{ name: 'ชาเขียว', amountSatang: 44000, eaterNames: [] }])),
    ).not.toBeNull()
  })
})
