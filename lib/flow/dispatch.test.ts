import { describe, expect, it } from 'vitest'
import { decideReply } from './dispatch'
import type { ExpenseDraft, ParseResult } from '../types'

const DRAFT: ExpenseDraft = {
  description: 'ข้าว',
  totalSatang: 120000,
  mode: 'equal',
  participants: [{ name: 'กอล์ฟ', weight: 1 }],
  includesPayer: false,
  surchargePct: 0,
}

const expense: ParseResult = { kind: 'expense', draft: DRAFT }
const balance: ParseResult = { kind: 'command', command: 'balance' }
const guide: ParseResult = { kind: 'command', command: 'guide' }
const unparsed: ParseResult = { kind: 'unparsed', text: 'อะไรก็ไม่รู้' }

describe('decideReply — ในกลุ่ม กฎเงียบมาก่อน', () => {
  it('ไม่เข้า Trigger = เงียบ', () => {
    expect(decideReply({ surface: 'group', addressed: false }, null)).toEqual({ kind: 'silent' })
  })

  it('เรียกบอทแล้วพิมพ์อะไรที่แปลไม่ออก ต้องได้ไกด์ ไม่ใช่ความเงียบ', () => {
    // เงียบใส่คนที่เพิ่งพิมพ์ `@บิลใหญ่ ช่วยหน่อย` อ่านออกมาได้อย่างเดียวว่าบอทเสีย
    expect(decideReply({ surface: 'group', addressed: true }, unparsed)).toEqual({ kind: 'guide' })
    expect(decideReply({ surface: 'group', addressed: true }, null)).toEqual({ kind: 'guide' })
  })

  it('เข้า Trigger แต่แปลไม่ออก = เงียบ จนกว่าจะมี Haiku ใน Phase 4', () => {
    expect(decideReply({ surface: 'group', addressed: false }, unparsed)).toEqual({ kind: 'silent' })
  })

  it('เรียกบอทเปล่าๆ ได้ไกด์ — ข้อยกเว้นเดียวของกฎเงียบ', () => {
    expect(decideReply({ surface: 'group', addressed: true }, guide)).toEqual({ kind: 'guide' })
  })
})

describe('decideReply — ใน 1:1 ไม่มีบทสนทนาของคนอื่นให้แทรก', () => {
  it('อะไรที่ไม่เข้า Trigger ตอบไกด์ ไม่เงียบ', () => {
    expect(decideReply({ surface: 'direct', addressed: false }, null)).toEqual({ kind: 'guide' })
  })

  it('แปลไม่ออกก็ตอบไกด์', () => {
    expect(decideReply({ surface: 'direct', addressed: false }, unparsed)).toEqual({ kind: 'guide' })
  })
})

/**
 * `addressed` ของแต่ละ surface ต่างกันตั้งแต่ D47 — ในกลุ่มคีย์เวิร์ดต้องมาพร้อม
 * mention ถึงจะนับเป็นคำสั่ง ส่วน 1:1 ไม่บังคับเพราะ LINE ไม่มี mention ที่นั่น
 */
const SURFACES = [
  ['group', true],
  ['direct', false],
] as const

describe('decideReply — ของที่ยังไม่มีต้องบอก ไม่ใช่เงียบ', () => {
  it.each(SURFACES)('`ยอด` เปิดใช้แล้ว — กลายเป็นเจตนาอ่านยอดใน %s', (surface, addressed) => {
    // ตัว `decideReply` ไม่แตะ I/O — ledger ต้องอ่านที่ชั้นถัดไป
    expect(decideReply({ surface, addressed }, balance)).toEqual({ kind: 'balance' })
  })

  it.each(SURFACES)('คำสั่งที่ยังไม่เปิดใช้ใน %s', (surface, addressed) => {
    expect(decideReply({ surface, addressed }, { kind: 'command', command: 'nudge' })).toEqual({
      kind: 'not-available',
      what: 'command',
    })
    expect(decideReply({ surface, addressed }, { kind: 'command', command: 'edit' })).toEqual({
      kind: 'not-available',
      what: 'command',
    })
    expect(decideReply({ surface, addressed }, { kind: 'command', command: 'undo' })).toEqual({
      kind: 'not-available',
      what: 'command',
    })
  })

  it.each(['group', 'direct'] as const)('บิลกลายเป็นเจตนาสร้างการ์ดใน %s', (surface) => {
    // ตัว `decideReply` ไม่แตะ I/O — ยอดกับป้าย `(ใหม่)` ต้องรอ Roster
    expect(decideReply({ surface, addressed: false }, expense)).toEqual({
      kind: 'draft',
      draft: DRAFT,
    })
  })

  it('คำสั่งที่มี args ยังไม่เปิดใช้ ต่อให้ตัวคำสั่งจะเปิดแล้ว (D34)', () => {
    // ไม่มีคำสั่งไหนรับ args ได้ในเฟสนี้ · ตอบยอดทั้งวงแทนยอดที่ขอกรอง
    // คือการตอบผิดคำถามแบบเงียบ ซึ่งใน ledger เท่ากับยอดผิด
    expect(decideReply({ surface: 'group', addressed: true }, { kind: 'command', command: 'balance', args: '#เชียงใหม่' })).toEqual(
      { kind: 'not-available', what: 'command' },
    )
    expect(decideReply({ surface: 'group', addressed: true }, { kind: 'command', command: 'guide', args: '#x' })).toEqual({
      kind: 'not-available',
      what: 'command',
    })
  })
})

describe('decideReply — D47: คำสั่งคีย์เวิร์ดในกลุ่มต้องเรียกบอทตรงๆ', () => {
  it('`ยอด` เปล่าๆ ในกลุ่มต้องเงียบ ไม่ใช่ตอบยอด', () => {
    // `ยอด` เป็นชื่อคนได้ และ `ยอด มาไหม` คือบทสนทนาของกลุ่ม — เกณฑ์เดียวกับ
    // ที่กฎเงียบมีไว้กัน · บังคับ mention แล้วไม่ต้องมีกฎรายคำสั่งอีก (D34 หดลง)
    expect(decideReply({ surface: 'group', addressed: false }, balance)).toEqual({ kind: 'silent' })
  })

  it('คีย์เวิร์ดเปล่าๆ ในกลุ่มเงียบ ต่อให้เป็นคำสั่งที่ยังไม่เปิดใช้', () => {
    // เงียบมาก่อน "ยังไม่เปิดใช้" — คนพิมพ์ `ทวง` กลางบทสนทนาไม่ได้เรียกบอท
    // การตอบว่ายังไม่เปิดใช้จึงเป็นเสียงรบกวนชนิดเดียวกับที่ D47 มาแก้
    expect(decideReply({ surface: 'group', addressed: false }, { kind: 'command', command: 'nudge' })).toEqual({
      kind: 'silent',
    })
  })

  it('คีย์เวิร์ดที่มี args เปล่าๆ ในกลุ่มก็เงียบ', () => {
    expect(
      decideReply({ surface: 'group', addressed: false }, { kind: 'command', command: 'balance', args: '#เชียงใหม่' }),
    ).toEqual({ kind: 'silent' })
  })

  it('จดบิลไม่ต้องเรียกบอท — `+` ไม่ถูกแตะ', () => {
    // เหตุผลเดิมของ §3 ยังยืน: จดบิลคือสิ่งที่ทำบ่อยที่สุดในระบบ บังคับ mention
    // ตรงนั้นชนกับ D19 โดยตรง · D47 แคบกว่านั้น ไม่ได้ล้มมัน
    expect(decideReply({ surface: 'group', addressed: false }, expense)).toEqual({
      kind: 'draft',
      draft: DRAFT,
    })
  })

  it.each(['balance', 'guide'] as const)('ใน 1:1 ไม่บังคับ — `%s` เปล่าๆ ยังทำงาน', (command) => {
    // LINE ไม่มี mention ในแชท 1:1 บังคับแล้วคำสั่งจะเข้าไม่ถึงเลยสักตัว
    expect(decideReply({ surface: 'direct', addressed: false }, { kind: 'command', command })).not.toEqual({
      kind: 'silent',
    })
  })
})
