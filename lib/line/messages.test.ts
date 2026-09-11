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
  const ALL: readonly BotCommand[] = ['balance', 'bills', 'nudge', 'edit', 'undo']
  const KEYWORDS: Readonly<Record<string, string>> = {
    balance: 'ยอด',
    bills: 'บิล',
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

describe('renderReply — บิลที่กดแล้วเปิดไม่ได้', () => {
  it('บิลที่ถูกยกเลิกกับบิลที่หาไม่เจอ พูดคนละอย่าง', () => {
    // การ์ดเก่าลอยอยู่ในแชทตลอดกาล (D30 ไม่มี hard delete) — กดแล้วเงียบอ่านออกว่า
    // บอทพัง ส่วนโชว์ยอดของบิลที่ยกเลิกไปแล้วคือตัวเลขผิดใน ledger
    const voided = renderReply({ kind: 'bill-voided' }, 'group')
    const missing = renderReply({ kind: 'bill-not-found' }, 'group')
    expect(voided[0]?.text).not.toBe(missing[0]?.text)
    expect(voided).toHaveLength(1)
    expect(missing).toHaveLength(1)
  })

  it('บิลที่ยกเลิกบอกว่ายกเลิก ไม่ใช่บอกว่าหาไม่เจอ', () => {
    expect(renderReply({ kind: 'bill-voided' }, 'group')[0]?.text).toContain('ยกเลิก')
  })

  it('บิลคนละวงตอบว่าหาไม่เจอ — ไม่บอกว่ามีอยู่จริงที่อื่น', () => {
    const text = renderReply({ kind: 'bill-not-found' }, 'group')[0]?.text ?? ''
    expect(text).toContain('ไม่เจอ')
    expect(text).not.toContain('วงอื่น')
  })
})

/**
 * คำสั่งที่บอกให้เขาพิมพ์ ต้องพิมพ์ได้จริงในที่ที่เขาอ่านอยู่
 *
 * ในกลุ่มคีย์เวิร์ดเปล่าๆ ตกเป็นความเงียบตาม D47 — บอกให้พิมพ์ `บิล` เฉยๆ จึงส่งคน
 * ไปเจอความเงียบ ซึ่งอ่านออกได้อย่างเดียวว่าบอทพัง
 */
describe('renderReply — คำสั่งที่แนะนำต้องพิมพ์ได้จริงตาม surface', () => {
  it('`no-bills-for-tag` ในกลุ่มใส่ `@บิลใหญ่` ให้', () => {
    const [message] = renderReply({ kind: 'no-bills-for-tag', tag: 'ปีใหม่' }, 'group')
    expect(message?.text).toContain('#ปีใหม่')
    expect(message?.text).toContain('@บิลใหญ่ บิล')
  })

  it('ใน 1:1 ไม่มี `@บิลใหญ่` — LINE ไม่มี mention ที่นั่น', () => {
    const [message] = renderReply({ kind: 'no-bills-for-tag', tag: 'ปีใหม่' }, 'direct')
    expect(message?.text).toContain('พิมพ์ บิล')
    expect(message?.text).not.toContain('@บิลใหญ่')
  })

  it('`bill-not-found` ใช้กฎเดียวกัน', () => {
    expect(renderReply({ kind: 'bill-not-found' }, 'group')[0]?.text).toContain('@บิลใหญ่ บิล')
    expect(renderReply({ kind: 'bill-not-found' }, 'direct')[0]?.text).not.toContain('@บิลใหญ่')
  })

  /**
   * `parseCommand` รับ `#` ตามด้วยอะไรก็ได้ยาวเท่าไหร่ก็ได้ และ `event_tag` เป็น
   * `text` ไม่มีเพดาน · แท็กยาวๆ ดันข้อความทะลุ 5000 ตัวอักษรแล้ว LINE ปฏิเสธทั้ง
   * reply — คนถามจะไม่ได้คำตอบอะไรเลย ซึ่งแย่กว่าเห็นชื่อแท็กถูกตัด
   */
  it('แท็กยาวถูกตัด ไม่ปล่อยให้ข้อความทะลุเพดานของ LINE', () => {
    const absurd = 'ก'.repeat(6000)
    for (const plan of [
      { kind: 'no-bills-for-tag' as const, tag: absurd },
      { kind: 'settled-for-tag' as const, tag: absurd },
    ]) {
      const [message] = renderReply(plan, 'group')
      expect(message?.text.length).toBeLessThanOrEqual(5000)
      expect(message?.text).toContain('…')
    }
  })

  it('`settled-for-tag` พูดถึงแท็ก และไม่พูดว่าค้าง', () => {
    const [message] = renderReply({ kind: 'settled-for-tag', tag: 'เชียงใหม่' }, 'group')
    expect(message?.text).toContain('#เชียงใหม่')
    expect(message?.text).not.toContain('ค้าง')
  })
})

/**
 * ข้อความที่ผู้ใช้อ่าน **ห้ามอ้างรหัสการตัดสินใจ** — `D11` `D26` เป็นของในเอกสาร
 *
 * รหัสพวกนี้หลุดง่ายมากเวลาเขียนคอมเมนต์กับข้อความในบรรทัดติดกัน · เทสต์นี้กวาด
 * ทุก plan ทีเดียวเพื่อให้ตัวที่เพิ่มเข้ามาทีหลังถูกคุมไปด้วยโดยไม่ต้องจำ
 */
describe('renderReply — ไม่มีรหัสการตัดสินใจหลุดออกไปในแชท', () => {
  const PLANS = [
    { kind: 'guide' as const },
    { kind: 'need-names' as const },
    { kind: 'unknown-sender' as const },
    { kind: 'committed' as const, description: 'ข้าว', totalSatang: 120000 },
    { kind: 'draft-gone' as const },
    { kind: 'name-taken' as const, name: 'กอล์ฟ' },
    { kind: 'name-in-bill' as const, name: 'กอล์ฟ' },
    { kind: 'needs-identity' as const },
    { kind: 'no-display-name' as const },
    { kind: 'settled' as const },
    { kind: 'no-bills-for-tag' as const, tag: 'เชียงใหม่' },
    { kind: 'settled-for-tag' as const, tag: 'เชียงใหม่' },
    { kind: 'bill-not-found' as const },
    { kind: 'bill-voided' as const },
    { kind: 'confirm-void' as const, expenseId: 'e1', description: 'ข้าว', totalSatang: 120000 },
    { kind: 'bill-void-done' as const, description: 'ข้าว', totalSatang: 120000 },
    { kind: 'bill-void-not-allowed' as const },
    { kind: 'bill-void-needs-identity' as const },
    { kind: 'not-available' as const, what: 'command' as const },
  ]

  it.each(['group', 'direct'] as const)('ใน %s', (surface) => {
    for (const plan of PLANS) {
      for (const message of renderReply(plan, surface)) {
        // `D` ตามด้วยตัวเลข เช่น `D11` `D26` · `ADR 0002` ก็ไม่ควรหลุดเหมือนกัน
        expect(message.text).not.toMatch(/\bD\d+\b/)
        expect(message.text).not.toContain('ADR ')
      }
    }
  })
})

/**
 * ยกเลิกบิล (D61) — คำตอบของแต่ละเหตุต้องบอกทางออกคนละทาง
 */
describe('renderReply — ยกเลิกบิล (D61)', () => {
  it('คำถามจังหวะแรกถือ postback ของจังหวะสอง', () => {
    const [message] = renderReply(
      { kind: 'confirm-void', expenseId: 'e1', description: 'ข้าว', totalSatang: 120000 },
      'group',
    )
    expect(message?.text).toContain('ข้าว')
    expect(message?.text).toContain('฿1,200')
    expect(message?.quickReply?.items[0]?.action.data).toBe('void=e1&yes=1')
  })

  it('ประกาศตอนยกเลิกสำเร็จบอกชื่อกับยอด — audit อยู่ในสายตาคนทั้งวง', () => {
    const [message] = renderReply(
      { kind: 'bill-void-done', description: 'ข้าว', totalSatang: 120000 },
      'group',
    )
    expect(message?.text).toContain('ยกเลิกแล้ว')
    expect(message?.text).toContain('ข้าว')
    expect(message?.text).toContain('฿1,200')
  })

  it('คนที่ไม่มีสิทธิ์ได้คำตอบ ไม่ใช่ความเงียบ', () => {
    const [message] = renderReply({ kind: 'bill-void-not-allowed' }, 'group')
    expect(message?.text).toContain('คนจด')
    expect(message?.text).toContain('คนจ่าย')
  })

  it('คนที่ยังไม่ยืนยันตัวตนได้ทางออก ไม่ใช่แค่คำปฏิเสธ', () => {
    const [message] = renderReply({ kind: 'bill-void-needs-identity' }, 'group')
    expect(message?.text).toContain('ยังไม่รู้ว่าคุณเป็นใคร')
    expect(message?.text).toContain('ยืนยัน')
  })
})
