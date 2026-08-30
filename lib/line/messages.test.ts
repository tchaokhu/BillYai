import { describe, expect, it } from 'vitest'
import { renderReply } from './messages'
import { IMPLEMENTED_COMMANDS } from '../flow/dispatch'
import type { BotCommand } from '../types'

describe('renderReply — เจตนาเดียวได้ข้อความเดียว', () => {
  it('เงียบแปลว่าไม่ส่งอะไรเลย ไม่ใช่ส่งข้อความว่าง', () => {
    expect(renderReply({ kind: 'silent' })).toEqual([])
  })

  it('ไกด์เป็น text message หนึ่งก้อน', () => {
    const messages = renderReply({ kind: 'guide' })
    expect(messages).toHaveLength(1)
    expect(messages[0]?.type).toBe('text')
    expect(messages[0]?.text.trim().length).toBeGreaterThan(0)
  })

  it('คำสั่งที่ยังไม่เปิด กับวงที่ยังไม่รู้จักใคร พูดคนละอย่าง', () => {
    const command = renderReply({ kind: 'not-available', what: 'command' })
    const needNames = renderReply({ kind: 'need-names' })
    expect(command[0]?.text).not.toBe(needNames[0]?.text)
    expect(command).toHaveLength(1)
    expect(needNames).toHaveLength(1)
  })

  it('ตอนขอชื่อ ต้องยกตัวอย่างไวยากรณ์ให้ด้วย ไม่ใช่บอกว่าไม่รู้จักแล้วจบ', () => {
    expect(renderReply({ kind: 'need-names' })[0]?.text).toContain('+ ข้าว 1200')
  })

  it('ทุกข้อความอยู่ในเพดาน 5000 ตัวอักษรของ text message', () => {
    for (const plan of [
      { kind: 'guide' },
      { kind: 'not-available', what: 'command' },
      { kind: 'need-names' },
    ] as const) {
      for (const message of renderReply(plan)) {
        expect(message.text.length).toBeLessThanOrEqual(5000)
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
  const guideText = renderReply({ kind: 'guide' })[0]?.text ?? ''

  // บรรทัดคำสั่งในไกด์เขียนเป็น `<คีย์เวิร์ด> — คำอธิบาย` เสมอ · เทียบทั้งรูปแบบ
  // ไม่ใช่แค่คำ เพราะคำว่า "ยอด" โผล่ในประโยคอธิบายยอดบิลด้วยโดยไม่ได้โฆษณาคำสั่ง
  const helpLine = (command: BotCommand) => `${KEYWORDS[command]} —`

  it.each(ALL)('%s ที่ยังไม่เปิดใช้ต้องไม่โผล่ในไกด์', (command) => {
    if (IMPLEMENTED_COMMANDS.has(command)) return
    expect(guideText).not.toContain(helpLine(command))
  })

  it.each(ALL)('%s ที่เปิดใช้แล้วต้องโผล่ในไกด์', (command) => {
    if (!IMPLEMENTED_COMMANDS.has(command)) return
    expect(guideText).toContain(helpLine(command))
  })

  it('ไกด์สอนไวยากรณ์จดบิล เพราะ M5 จดได้แล้ว', () => {
    expect(guideText).toContain('+ ข้าว 1200')
    expect(guideText).toContain('รวมฉัน')
    expect(guideText).toContain('#เชียงใหม่')
  })

  it('ไกด์บอกว่ายอดที่พิมพ์รวม VAT แล้ว — ไวยากรณ์ไม่มีที่ให้ใส่ค่าบริการ', () => {
    expect(guideText).toContain('รวมค่าบริการและ VAT แล้ว')
  })
})
