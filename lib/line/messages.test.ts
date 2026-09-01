import { describe, expect, it } from 'vitest'
import { renderReply } from './messages'
import { IMPLEMENTED_COMMANDS } from '../flow/dispatch'
import type { BotCommand } from '../types'

describe('renderReply — เจตนาเดียวได้ข้อความเดียว', () => {
  it('เงียบแปลว่าไม่ส่งอะไรเลย ไม่ใช่ส่งข้อความว่าง', () => {
    expect(renderReply({ kind: 'silent' }, 'direct')).toEqual([])
  })

  it('ไกด์เป็น text message หนึ่งก้อน', () => {
    const messages = renderReply({ kind: 'guide' }, 'direct')
    expect(messages).toHaveLength(1)
    expect(messages[0]?.type).toBe('text')
    expect(messages[0]?.text.trim().length).toBeGreaterThan(0)
  })

  it('คำสั่งที่ยังไม่เปิด กับวงที่ยังไม่รู้จักใคร พูดคนละอย่าง', () => {
    const command = renderReply({ kind: 'not-available', what: 'command' }, 'direct')
    const needNames = renderReply({ kind: 'need-names' }, 'direct')
    expect(command[0]?.text).not.toBe(needNames[0]?.text)
    expect(command).toHaveLength(1)
    expect(needNames).toHaveLength(1)
  })

  it('ตอนขอชื่อ ต้องยกตัวอย่างไวยากรณ์ให้ด้วย ไม่ใช่บอกว่าไม่รู้จักแล้วจบ', () => {
    expect(renderReply({ kind: 'need-names' }, 'direct')[0]?.text).toContain('+ ข้าว 1200')
  })

  it('ทุกข้อความอยู่ในเพดาน 5000 ตัวอักษรของ text message', () => {
    for (const plan of [
      { kind: 'guide' },
      { kind: 'not-available', what: 'command' },
      { kind: 'need-names' },
    ] as const) {
      // ไกด์ในกลุ่มยาวกว่าเพราะมี `@บิลใหญ่` ต่อหน้าทุกบรรทัดคำสั่ง — เพดาน
      // ต้องคุมตัวที่ยาวกว่าด้วย ไม่ใช่คุมแค่ตัวที่บังเอิญถูกหยิบมาเทสต์
      for (const surface of ['group', 'direct'] as const) {
        for (const message of renderReply(plan, surface)) {
          expect(message.text.length).toBeLessThanOrEqual(5000)
        }
      }
    }
  })
})

describe('ไกด์ต้องไม่โฆษณาคำสั่งที่ยังไม่มี', () => {
  const ALL: readonly BotCommand[] = ['balance', 'nudge', 'edit', 'undo']
  const KEYWORDS: Readonly<Record<string, string>> = {
    balance: 'ยอด',
    nudge: 'ทวง',
    edit: 'แก้',
    undo: 'เลิก',
  }
  // เกณฑ์ "ห้ามโฆษณาของที่ยังไม่เปิด" ต้องจริงทั้งสอง surface — ไกด์คนละใบกันตั้งแต่ D47
  const guides = (['group', 'direct'] as const).map(
    (surface) => renderReply({ kind: 'guide' }, surface)[0]?.text ?? '',
  )
  // บรรทัดคำสั่งในไกด์เขียนเป็น `<คีย์เวิร์ด> — คำอธิบาย` เสมอ · เทียบทั้งรูปแบบ
  // ไม่ใช่แค่คำ เพราะคำว่า "ยอด" โผล่ในประโยคอธิบายยอดบิลด้วยโดยไม่ได้โฆษณาคำสั่ง
  const helpLine = (command: BotCommand) => `${KEYWORDS[command]} —`

  it.each(ALL)('%s ที่ยังไม่เปิดใช้ต้องไม่โผล่ในไกด์', (command) => {
    if (IMPLEMENTED_COMMANDS.has(command)) return
    for (const guide of guides) expect(guide).not.toContain(helpLine(command))
  })

  it.each(ALL)('%s ที่เปิดใช้แล้วต้องโผล่ในไกด์', (command) => {
    if (!IMPLEMENTED_COMMANDS.has(command)) return
    for (const guide of guides) expect(guide).toContain(helpLine(command))
  })

  it('ไกด์สอนไวยากรณ์จดบิล เพราะ M5 จดได้แล้ว', () => {
    for (const guide of guides) {
      expect(guide).toContain('+ ข้าว 1200')
      expect(guide).toContain('รวมฉัน')
      expect(guide).toContain('#เชียงใหม่')
    }
  })

  it('ไกด์บอกว่ายอดที่พิมพ์รวม VAT แล้ว — ไวยากรณ์ไม่มีที่ให้ใส่ค่าบริการ', () => {
    for (const guide of guides) expect(guide).toContain('รวมค่าบริการและ VAT แล้ว')
  })
})

describe('ไกด์ — D47: สอนไวยากรณ์ของที่ที่คนอ่านอยู่จริง', () => {
  const inGroup = renderReply({ kind: 'guide' }, 'group')[0]?.text ?? ''
  const inDirect = renderReply({ kind: 'guide' }, 'direct')[0]?.text ?? ''

  it('ในกลุ่มต้องสอนให้ใส่ `@บิลใหญ่` นำหน้าคำสั่ง', () => {
    // ไกด์ที่สอนคำสั่งซึ่งพิมพ์ตามแล้วเงียบ คือการหลอกให้คนคิดว่าบอทพัง
    expect(inGroup).toContain('@บิลใหญ่ ยอด —')
  })

  it('ใน 1:1 ต้องไม่มี `@บิลใหญ่` เพราะพิมพ์ตามแล้วจะแปลไม่ออก', () => {
    // LINE ไม่มี mention ในแชท 1:1 — ข้อความจะไม่ถูกตัด แล้วตกเป็น `unparsed`
    // ซึ่งใน 1:1 ตอบไกด์ = วนกลับมาที่เดิมไม่รู้จบ
    expect(inDirect).not.toContain('@บิลใหญ่')
    expect(inDirect).toContain('ยอด —')
  })

  it('ไวยากรณ์จดบิลไม่มี `@บิลใหญ่` ทั้งสองที่ — `+` ไม่ถูกแตะ (D19)', () => {
    for (const guide of [inGroup, inDirect]) {
      expect(guide).toContain('  + ข้าว 1200 กอล์ฟ ตูน')
      expect(guide).not.toContain('@บิลใหญ่ +')
    }
  })
})
