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

  it('คำสั่งที่ยังไม่เปิด กับบิลที่ยังจดไม่ได้ พูดคนละอย่าง', () => {
    const command = renderReply({ kind: 'not-available', what: 'command' })
    const expense = renderReply({ kind: 'not-available', what: 'expense' })
    expect(command[0]?.text).not.toBe(expense[0]?.text)
    expect(command).toHaveLength(1)
    expect(expense).toHaveLength(1)
  })

  it('ทุกข้อความอยู่ในเพดาน 5000 ตัวอักษรของ text message', () => {
    for (const plan of [
      { kind: 'guide' },
      { kind: 'not-available', what: 'command' },
      { kind: 'not-available', what: 'expense' },
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

  it.each(ALL)('%s ที่ยังไม่เปิดใช้ต้องไม่โผล่ในไกด์', (command) => {
    if (IMPLEMENTED_COMMANDS.has(command)) return
    expect(guideText).not.toContain(KEYWORDS[command])
  })

  it.each(ALL)('%s ที่เปิดใช้แล้วต้องโผล่ในไกด์', (command) => {
    if (!IMPLEMENTED_COMMANDS.has(command)) return
    expect(guideText).toContain(KEYWORDS[command])
  })

  it('ไกด์ไม่สอนไวยากรณ์จดบิลตราบใดที่ยังจดไม่ได้', () => {
    // M4 ยังไม่มีที่เก็บ draft — สอนให้พิมพ์แล้วตอบว่าใช้ไม่ได้คือการหลอกให้เสียเวลา
    expect(guideText).not.toContain('+ ข้าว')
  })
})
