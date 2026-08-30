import { describe, expect, it } from 'vitest'
import { stripMentions } from './mention'
import type { Mentionee } from './events'

const BOT = '@บิลใหญ่'

function self(index: number, length: number): Mentionee {
  return { index, length, isSelf: true }
}

function other(index: number, length: number): Mentionee {
  return { index, length, isSelf: false }
}

describe('stripMentions — ตำแหน่งเป็น UTF-16 code unit', () => {
  it('ไม่มี mention เลย คืนข้อความเดิม', () => {
    expect(stripMentions('+ ข้าว 1200', [])).toEqual({ text: '+ ข้าว 1200', mentionsBot: false })
  })

  it('เรียกบอทแล้วสั่ง — ตัดชื่อทิ้งเหลือแต่คำสั่ง', () => {
    const text = `${BOT} ยอด`
    expect(text.slice(0, 8)).toBe(BOT)
    expect(stripMentions(text, [self(0, 8)])).toEqual({ text: 'ยอด', mentionsBot: true })
  })

  it('เรียกบอทเปล่าๆ เหลือสตริงว่าง', () => {
    expect(stripMentions(BOT, [self(0, 8)])).toEqual({ text: '', mentionsBot: true })
  })

  it('mention อยู่กลางข้อความ', () => {
    const text = `ยอด ${BOT} หน่อย`
    expect(text.slice(4, 12)).toBe(BOT)
    expect(stripMentions(text, [self(4, 12 - 4)])).toEqual({
      text: 'ยอด  หน่อย',
      mentionsBot: true,
    })
  })

  it('emoji นับสองหน่วย — ตัดผิดตำแหน่งเมื่อไหร่จะเห็นทันที', () => {
    const text = `😀${BOT}`
    expect(text.slice(2, 10)).toBe(BOT)
    expect(stripMentions(text, [self(2, 8)])).toEqual({ text: '😀', mentionsBot: true })
  })

  it('ตัดทุก mention ไม่ว่าจะเรียกใคร แต่ `mentionsBot` ดูเฉพาะ isSelf', () => {
    // `@All` ไม่ทำให้บอทสนใจ แต่ชื่อที่ค้างในข้อความจะทำให้ parse ไม่ออกโดยไม่จำเป็น
    const text = '@All ปิ้งย่างเมื่อคืน'
    expect(text.slice(0, 4)).toBe('@All')
    expect(stripMentions(text, [other(0, 4)])).toEqual({
      text: 'ปิ้งย่างเมื่อคืน',
      mentionsBot: false,
    })
  })

  it('หลาย mention ในข้อความเดียว ลำดับใน array ไม่สำคัญ', () => {
    const text = `@All ${BOT} ยอด`
    expect(text.slice(0, 4)).toBe('@All')
    expect(text.slice(5, 13)).toBe(BOT)
    // ส่งกลับหัวเพื่อพิสูจน์ว่าโค้ดเรียงเอง ไม่ได้เชื่อลำดับที่ LINE ส่งมา
    expect(stripMentions(text, [self(5, 8), other(0, 4)])).toEqual({
      text: 'ยอด',
      mentionsBot: true,
    })
  })

  it('ตำแหน่งที่เกินความยาวข้อความถูกทิ้งทั้งอัน ไม่ตัดมั่ว', () => {
    const text = 'ยอด'
    expect(stripMentions(text, [self(0, 99)])).toEqual({ text: 'ยอด', mentionsBot: true })
    expect(stripMentions(text, [self(10, 2)])).toEqual({ text: 'ยอด', mentionsBot: true })
    expect(stripMentions(text, [self(3, 1)])).toEqual({ text: 'ยอด', mentionsBot: true })
  })

  it('ช่วงที่ทับกันตัดครั้งเดียว ไม่กินตัวอักษรข้างเคียง', () => {
    const text = `${BOT} ยอด`
    // LINE ไม่ส่งช่วงทับกันมา แต่ถ้าส่ง การตัดสองรอบจะกินคำว่า "ยอด" ไปด้วย
    expect(stripMentions(text, [self(0, 8), self(2, 4)])).toEqual({
      text: 'ยอด',
      mentionsBot: true,
    })
  })

  it('ตัดหัวท้ายให้ แต่ไม่ยุบช่องว่างกลางข้อความ', () => {
    // parser แยก token ด้วย `\\s+` อยู่แล้ว ช่องว่างซ้อนกลางข้อความจึงไม่ต้องยุ่ง
    const text = `  ${BOT}  ข้าว 1200  `
    expect(stripMentions(text, [self(2, 8)]).text).toBe('ข้าว 1200')
  })
})
