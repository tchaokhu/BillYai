import { describe, expect, it } from 'vitest'
import { buildBillDetail, buildBillList, type BillSummary } from './bills'

function bill(id: string, description: string, spentAt: string, totalSatang: number): BillSummary {
  return { id, description, spentAt, totalSatang }
}

describe('buildBillList — รายการบิล (D45)', () => {
  it('วงที่ยังไม่เคยจดบิลเป็นคนละเรื่องกับวงที่มีบิล', () => {
    // ตอบไกด์ ไม่ใช่ตอบรายการว่าง — เกณฑ์เดียวกับ `ยอด` ในวงที่ยังไม่เคยจด
    expect(buildBillList({ bills: [], totalCount: 0 })).toEqual({ kind: 'no-bills' })
  })

  it('แปลงวันที่เป็นรูปที่คนอ่านออก และคงลำดับที่ repo ส่งมา', () => {
    const view = buildBillList({
      bills: [
        bill('b1', 'ตี๋น้อย', '2026-09-01', 90000),
        bill('b2', 'ข้าว', '2026-08-31', 30000),
      ],
      totalCount: 2,
    })

    expect(view).toEqual({
      kind: 'bills',
      rows: [
        { id: 'b1', description: 'ตี๋น้อย', date: '1 ก.ย. 69', totalSatang: 90000 },
        { id: 'b2', description: 'ข้าว', date: '31 ส.ค. 69', totalSatang: 30000 },
      ],
      omitted: 0,
    })
  })

  it('ไม่เรียงใหม่เอง — ลำดับเป็นของ SQL ที่ผูก tie-break ไว้แล้ว', () => {
    // เรียงซ้ำที่นี่คือมีสองแหล่งความจริงเรื่องลำดับ ซึ่งจะเพี้ยนกันวันใดวันหนึ่ง
    const rows = buildBillList({
      bills: [bill('a', 'ค', '2026-01-01', 100), bill('b', 'ก', '2026-12-31', 200)],
      totalCount: 2,
    })
    expect(rows.kind === 'bills' && rows.rows.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('บอกจำนวนที่ไม่ได้แสดง — ห้ามตัดเงียบ (D31/D44)', () => {
    const view = buildBillList({
      bills: [bill('b1', 'ตี๋น้อย', '2026-09-01', 90000)],
      totalCount: 23,
    })
    expect(view).toMatchObject({ omitted: 22 })
  })

  it('`totalCount` ที่น้อยกว่าจำนวนแถวไม่ทำให้ได้ค่าติดลบ', () => {
    // เกิดได้จริงถ้ามีคนจดบิลใหม่ระหว่างสอง query — ตัวเลขติดลบบนการ์ดอ่านไม่รู้เรื่อง
    const view = buildBillList({
      bills: [bill('b1', 'ตี๋น้อย', '2026-09-01', 90000), bill('b2', 'ข้าว', '2026-08-31', 30000)],
      totalCount: 1,
    })
    expect(view).toMatchObject({ omitted: 0 })
  })
})

describe('buildBillDetail — บิลใบเดียว', () => {
  it('ชื่อ วันที่ ยอดรวม และรายคนพร้อมป้ายคนจ่าย', () => {
    expect(
      buildBillDetail({
        description: 'ตี๋น้อย',
        spentAt: '2026-09-01',
        totalSatang: 90000,
        lines: [
          { name: 'นัท', amountSatang: 30000, isPayer: true },
          { name: 'เดียร์', amountSatang: 30000, isPayer: false },
          { name: 'เกม', amountSatang: 30000, isPayer: false },
        ],
      }),
    ).toEqual({
      description: 'ตี๋น้อย',
      date: '1 ก.ย. 69',
      totalSatang: 90000,
      lines: [
        { name: 'นัท', amountSatang: 30000, isPayer: true },
        { name: 'เดียร์', amountSatang: 30000, isPayer: false },
        { name: 'เกม', amountSatang: 30000, isPayer: false },
      ],
    })
  })

  it('ไม่คิดยอดใหม่ — ตัวเลขบนการ์ดต้องเป็นตัวเดียวกับที่ลง ledger', () => {
    // การ์ดที่คำนวณเองจะเริ่มเพี้ยนจาก ledger วันที่สูตรสองฝั่งไม่ตรงกัน (D25)
    const detail = buildBillDetail({
      description: 'ข้าว',
      spentAt: '2026-08-31',
      totalSatang: 30001,
      lines: [
        { name: 'นัท', amountSatang: 15001, isPayer: true },
        { name: 'กอล์ฟ', amountSatang: 15000, isPayer: false },
      ],
    })
    expect(detail.totalSatang).toBe(30001)
    expect(detail.lines.reduce((sum, line) => sum + line.amountSatang, 0)).toBe(30001)
  })
})
