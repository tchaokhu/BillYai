import { describe, expect, it } from 'vitest'
import { parseDraftPayload } from './draft-payload'
import type { ExpenseDraft } from '@/lib/types'

const VALID: ExpenseDraft = {
  description: 'ข้าว',
  totalSatang: 120000,
  mode: 'equal',
  participants: [
    { name: 'กอล์ฟ', weight: 2 },
    { name: 'ตูน', weight: 1 },
  ],
  includesPayer: false,
  surchargePct: 0,
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
    ['surcharge ติดลบ', 'surchargePct', -1],
    ['surcharge เกินร้อย', 'surchargePct', 101],
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
