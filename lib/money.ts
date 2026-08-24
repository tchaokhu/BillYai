/**
 * money — แปลงบาท↔สตางค์, จัดรูปแบบ, กระจายเศษ
 *
 * สตางค์เป็น integer เสมอ ไม่มี float ในเส้นทางคำนวณเงิน
 */

/** รูปแบบเงินบาทที่ยอมรับ — คอมมาต้องคั่นหลักพันให้ถูก และทศนิยมไม่เกิน 2 ตำแหน่ง */
const BAHT_PATTERN = /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/

/**
 * แปลงบาทเป็นสตางค์
 *
 * ทำงานบน "ข้อความ" ของตัวเลขแทนการคูณ float เพราะ `1200.15 * 100` ได้
 * 120014.999... แล้ว Math.round ช่วยได้บางเคสแต่ไม่ทุกเคส — การตัดสตริงแม่นเสมอ
 */
export function bahtToSatang(input: number | string): number {
  let text: string

  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error(`จำนวนเงินไม่ถูกต้อง: ${input}`)
    if (input < 0) throw new Error(`จำนวนเงินติดลบไม่ได้: ${input}`)
    text = String(input)
    // เลขที่ใหญ่/เล็กเกินจนกลายเป็น exponential อยู่นอกช่วงเงินที่ใช้จริง
    if (text.includes('e') || text.includes('E')) {
      throw new Error(`จำนวนเงินอยู่นอกช่วงที่รองรับ: ${input}`)
    }
  } else {
    text = input.trim()
  }

  if (!BAHT_PATTERN.test(text)) {
    throw new Error(`จำนวนเงินไม่ถูกต้อง: ${JSON.stringify(input)}`)
  }

  const [intPart = '', fracPart = ''] = text.replace(/,/g, '').split('.')
  const satang = Number(intPart) * 100 + Number(fracPart.padEnd(2, '0'))

  if (!Number.isSafeInteger(satang)) {
    throw new Error(`จำนวนเงินอยู่นอกช่วงที่รองรับ: ${JSON.stringify(input)}`)
  }
  return satang
}

function assertSatang(satang: number): void {
  if (!Number.isSafeInteger(satang)) {
    throw new Error(`สตางค์ต้องเป็น integer: ${satang}`)
  }
  if (satang < 0) {
    throw new Error(`สตางค์ติดลบไม่ได้: ${satang}`)
  }
}

/** แยกสตางค์เป็นส่วนบาทกับส่วนเศษสองหลัก — ทำงานบน integer ล้วน */
function splitParts(satang: number): { baht: string; frac: string } {
  return {
    baht: String(Math.floor(satang / 100)),
    frac: String(satang % 100).padStart(2, '0'),
  }
}

export function satangToBaht(satang: number): number {
  assertSatang(satang)
  const { baht, frac } = splitParts(satang)
  // สร้างจากสตริงแทน satang/100 เพื่อไม่ให้ผลหารพา error สะสมมาด้วย
  return Number(`${baht}.${frac}`)
}

export function formatSatang(satang: number): string {
  assertSatang(satang)
  const { baht, frac } = splitParts(satang)
  const grouped = baht.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return frac === '00' ? grouped : `${grouped}.${frac}`
}

/**
 * จำนวนทศนิยมของน้ำหนัก — อ่านจากสตริงเพราะเป็นวิธีเดียวที่บอกได้ว่า
 * float ตัวนั้น "แทน" ทศนิยมกี่ตำแหน่งจริงๆ
 */
function weightDecimals(weight: number): number {
  if (!Number.isFinite(weight)) throw new Error(`น้ำหนักไม่ถูกต้อง: ${weight}`)
  if (weight <= 0) throw new Error(`น้ำหนักต้องมากกว่า 0: ${weight}`)
  const text = String(weight)
  if (text.includes('e') || text.includes('E')) {
    throw new Error(`น้ำหนักอยู่นอกช่วงที่รองรับ: ${weight}`)
  }
  return (text.split('.')[1] ?? '').length
}

/** ขยายน้ำหนักเป็น integer ด้วยตัวคูณเดียวกันทั้งชุด เพื่อคำนวณด้วย BigInt ล้วน */
function scaleWeight(weight: number, decimals: number): bigint {
  const [intPart = '', fracPart = ''] = String(weight).split('.')
  return BigInt(intPart + fracPart.padEnd(decimals, '0'))
}

/**
 * กระจาย `totalSatang` ตาม `weights` แบบ largest-remainder
 *
 * invariant: ผลรวมของค่าที่คืนเท่ากับ `totalSatang` เป๊ะเสมอ
 *
 * คำนวณด้วย BigInt ทั้งเส้น เพราะการเทียบ "เศษ" ด้วย float ทำให้ลำดับผู้รับเศษ
 * ไม่แน่นอน — คนสองคนที่ควรเสมอกันอาจต่างกันที่หลักที่ 16 แล้วผลลัพธ์เปลี่ยน
 *
 * เศษเท่ากัน → `tieBreakIndex` (คนจ่ายบิล) ได้ก่อน แล้วไล่ตาม index จากน้อยไปมาก
 */
export function distribute(
  totalSatang: number,
  weights: number[],
  tieBreakIndex?: number,
): number[] {
  if (!Number.isSafeInteger(totalSatang)) {
    throw new Error(`ยอดรวมต้องเป็น integer: ${totalSatang}`)
  }
  if (totalSatang < 0) throw new Error(`ยอดรวมติดลบไม่ได้: ${totalSatang}`)
  if (weights.length === 0) throw new Error('ต้องมีน้ำหนักอย่างน้อยหนึ่งตัว')

  const decimals = weights.reduce((max, w) => Math.max(max, weightDecimals(w)), 0)
  const scaled = weights.map((w) => scaleWeight(w, decimals))
  const totalWeight = scaled.reduce((a, b) => a + b, 0n)
  if (totalWeight === 0n) throw new Error('ผลรวมน้ำหนักต้องมากกว่า 0')

  const total = BigInt(totalSatang)
  const entries = scaled.map((weight, index) => {
    const numerator = total * weight
    return {
      index,
      base: Number(numerator / totalWeight),
      remainder: numerator % totalWeight,
    }
  })

  const leftover = totalSatang - entries.reduce((s, e) => s + e.base, 0)

  const tieFirst =
    tieBreakIndex !== undefined &&
    Number.isInteger(tieBreakIndex) &&
    tieBreakIndex >= 0 &&
    tieBreakIndex < weights.length
      ? tieBreakIndex
      : -1

  const order = [...entries].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1
    if (a.index === tieFirst) return -1
    if (b.index === tieFirst) return 1
    return a.index - b.index
  })

  const rank = new Map(order.map((e, position) => [e.index, position]))
  return entries.map((e) => e.base + ((rank.get(e.index) ?? entries.length) < leftover ? 1 : 0))
}
