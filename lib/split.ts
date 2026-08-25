/**
 * split — แตกบิลหนึ่งใบเป็น Share รายคน ทั้ง 4 โหมด พร้อมกระจาย surcharge
 *
 * invariant: Σ share.amountSatang === grandTotal เป๊ะเสมอ ทุกโหมด ทุกอินพุต
 */
import { distribute } from './money.js'
import type { Item, MemberId, Participant, Share, SplitInput } from './types.js'

/**
 * ขอบเขตของ `surchargePct` — ตรงกับคอลัมน์ `surcharge_pct numeric(5,2)`
 * และ check constraint `surcharge_pct >= 0 and <= 100`
 *
 * ด่านนี้อยู่ที่นี่ ไม่ใช่ที่ชั้น persistence อย่างเดียว เพราะ `addSurcharge` คือ
 * สูตรร่วมของทั้งระบบ ถ้าค่าที่ DB เก็บไม่ได้ผ่านมาถึงการคำนวณ ผู้ใช้จะเห็น
 * ผลหารที่ดูสมบูรณ์บนจอก่อน แล้วบิลค่อยไปตายตอนกดบันทึก ซึ่งสายเกินจะแก้แล้ว
 */
const MAX_PCT = 100
const MAX_PCT_DECIMALS = 2

/**
 * จำนวนทศนิยมของเปอร์เซ็นต์ — อ่านจากสตริงด้วยเหตุผลเดียวกับ `weightDecimals`
 * ใน money.ts: เป็นวิธีเดียวที่บอกได้ว่า float ตัวนั้น "แทน" ทศนิยมกี่ตำแหน่งจริงๆ
 */
function pctDecimals(pct: number): number {
  if (!Number.isFinite(pct)) throw new Error(`surchargePct ไม่ถูกต้อง: ${pct}`)
  if (pct < 0) throw new Error(`surchargePct ติดลบไม่ได้: ${pct}`)
  if (pct > MAX_PCT) throw new Error(`surchargePct เกิน ${MAX_PCT} ไม่ได้: ${pct}`)
  const text = String(pct)
  if (text.includes('e') || text.includes('E')) {
    throw new Error(`surchargePct อยู่นอกช่วงที่รองรับ: ${pct}`)
  }
  const decimals = (text.split('.')[1] ?? '').length
  // VAT 7 + service charge 10.5 บวกกันเป็น float ได้ 17.500000000000002 มาเอง
  // โดยไม่มีใครพิมพ์ — numeric(5,2) จะปัดทิ้งเงียบๆ แล้ว Σ share ที่เขียนลงไป
  // จะไม่ตรงกับยอดที่คำนวณใหม่จากแถวที่อ่านกลับมา
  if (decimals > MAX_PCT_DECIMALS) {
    throw new Error(`surchargePct มีทศนิยมได้ไม่เกิน ${MAX_PCT_DECIMALS} ตำแหน่ง: ${pct}`)
  }
  return decimals
}

/** ขยายเปอร์เซ็นต์เป็น integer เพื่อคำนวณด้วย BigInt ล้วน */
function scalePct(pct: number, decimals: number): bigint {
  const [intPart = '', fracPart = ''] = String(pct).split('.')
  return BigInt(intPart + fracPart.padEnd(decimals, '0'))
}

/**
 * ยอดรวมหลังบวก surcharge ปัดครึ่งขึ้นเป็นสตางค์
 *
 * คำนวณด้วย BigInt ล้วน เพราะ `10 * 1.05` ใน IEEE754 ไม่ใช่ 10.5 เป๊ะ —
 * `total × pct / 100` แบบ float สะสม error จนเคสครึ่งพอดีปัดผิดทาง
 *
 * ปัดครึ่งขึ้น = floor((2n + d) / 2d) เมื่อ n/d คือค่าจริง
 *
 * export ออกมาเพราะชั้น persistence ต้องตรวจ invariant
 * `Σ share = total + surcharge` ซ้ำอีกชั้นก่อนเขียนลง DB (shares อาจมาจาก LLM
 * หรือ LIFF ที่ไม่ได้ผ่าน `splitExpense`) — ถ้าที่นั่นเขียนสูตรเอง จะมีสองสูตร
 * ที่ต้องปัดตรงกันตลอดไป ซึ่งคือบั๊กที่รอเกิด
 */
export function addSurcharge(totalSatang: number, surchargePct: number): number {
  const decimals = pctDecimals(surchargePct)
  const scale = 10n ** BigInt(decimals)
  const pct = scalePct(surchargePct, decimals)
  const denominator = 100n * scale
  const numerator = BigInt(totalSatang) * (denominator + pct)
  const grandTotal = Number((2n * numerator + denominator) / (2n * denominator))

  if (!Number.isSafeInteger(grandTotal)) {
    throw new Error(`ยอดรวมหลังบวก surcharge อยู่นอกช่วงที่รองรับ: ${grandTotal}`)
  }
  return grandTotal
}

/**
 * กระจาย `total` ตามสัดส่วน `weights` โดยข้ามคนที่น้ำหนักเป็น 0
 *
 * `distribute` ไม่รับน้ำหนัก 0 (โหมด exact/itemized มีคนที่ subtotal เป็น 0 ได้)
 * คนกลุ่มนั้นได้ 0 อยู่แล้วตามสัดส่วน จึงคัดออกก่อนเรียกแล้วเติมกลับตามลำดับเดิม
 */
function distributeByWeight(
  total: number,
  weights: number[],
  tieBreakIndex: number | undefined,
): number[] {
  const activeIndexes: number[] = []
  const activeWeights: number[] = []
  weights.forEach((weight, index) => {
    if (weight > 0) {
      activeIndexes.push(index)
      activeWeights.push(weight)
    }
  })
  if (activeWeights.length === 0) throw new Error('ผลรวมน้ำหนักต้องมากกว่า 0')

  const tiePosition = tieBreakIndex === undefined ? -1 : activeIndexes.indexOf(tieBreakIndex)
  const parts = distribute(total, activeWeights, tiePosition >= 0 ? tiePosition : undefined)

  const result = weights.map(() => 0)
  activeIndexes.forEach((original, position) => {
    result[original] = parts[position] ?? 0
  })
  return result
}

/** subtotal รายคนจาก `exactSatang` — ผลรวมต้องเท่ากับยอดบิลเป๊ะ ไม่เดาให้ */
function exactSubtotals(participants: Participant[], totalSatang: number): number[] {
  const subtotals = participants.map((p) => {
    const value = p.exactSatang
    if (value === undefined) {
      throw new Error(`โหมด exact ต้องระบุ exactSatang ของทุกคน — ขาด: ${p.memberId}`)
    }
    if (!Number.isSafeInteger(value)) throw new Error(`exactSatang ต้องเป็น integer: ${value}`)
    if (value < 0) throw new Error(`exactSatang ติดลบไม่ได้: ${value}`)
    return value
  })

  const stated = subtotals.reduce((a, b) => a + b, 0)
  if (stated !== totalSatang) {
    throw new Error(`ผลรวม exactSatang (${stated}) ไม่เท่ากับยอดบิล (${totalSatang})`)
  }
  return subtotals
}

/**
 * subtotal รายคนจากรายการอาหาร — แต่ละชิ้นหารเท่ากันเฉพาะในกลุ่มคนที่ถูก tag
 *
 * เศษของแต่ละชิ้นตกกับคนจ่ายบิลถ้าเขากินชิ้นนั้น ตามกฎ "Payer รับเศษเอง"
 */
function itemizedSubtotals(
  participants: Participant[],
  items: Item[],
  totalSatang: number,
  payerId: MemberId,
): number[] {
  if (items.length === 0) throw new Error('โหมด itemized ต้องมีรายการอย่างน้อยหนึ่งชิ้น')

  const indexOf = new Map(participants.map((p, i) => [p.memberId, i]))
  const subtotals = participants.map(() => 0)
  let stated = 0

  for (const item of items) {
    if (!Number.isSafeInteger(item.amountSatang)) {
      throw new Error(`ราคาของ "${item.name}" ต้องเป็น integer: ${item.amountSatang}`)
    }
    if (item.amountSatang < 0) {
      throw new Error(`ราคาของ "${item.name}" ติดลบไม่ได้: ${item.amountSatang}`)
    }
    if (item.memberIds.length === 0) throw new Error(`รายการ "${item.name}" ไม่มีคนกิน`)

    const targets: number[] = []
    const seen = new Set<MemberId>()
    for (const memberId of item.memberIds) {
      const index = indexOf.get(memberId)
      if (index === undefined) {
        throw new Error(`รายการ "${item.name}" อ้างถึงคนที่ไม่ได้ร่วมหาร: ${memberId}`)
      }
      if (seen.has(memberId)) {
        throw new Error(`รายการ "${item.name}" มีชื่อซ้ำ: ${memberId}`)
      }
      seen.add(memberId)
      targets.push(index)
    }

    stated += item.amountSatang
    const tieBreak = item.memberIds.indexOf(payerId)
    const parts = distribute(
      item.amountSatang,
      targets.map(() => 1),
      tieBreak >= 0 ? tieBreak : undefined,
    )
    targets.forEach((index, position) => {
      subtotals[index] = (subtotals[index] ?? 0) + (parts[position] ?? 0)
    })
  }

  if (stated !== totalSatang) {
    throw new Error(`ผลรวมราคารายการ (${stated}) ไม่เท่ากับยอดบิล (${totalSatang})`)
  }
  return subtotals
}

/** น้ำหนักรายคนที่ใช้กระจาย grandTotal — สัดส่วนเดียวกับ subtotal ของแต่ละคน */
function weightsFor(input: SplitInput): number[] {
  const { participants } = input

  switch (input.mode) {
    case 'equal':
      return participants.map(() => 1)
    case 'share':
      return participants.map((p) => {
        const weight = p.weight ?? 1
        if (!Number.isFinite(weight) || weight <= 0) {
          throw new Error(`น้ำหนักต้องมากกว่า 0: ${weight}`)
        }
        return weight
      })
    case 'exact':
      return exactSubtotals(participants, input.totalSatang)
    case 'itemized':
      if (input.items === undefined) throw new Error('โหมด itemized ต้องมี items')
      return itemizedSubtotals(participants, input.items, input.totalSatang, input.payerId)
  }
}

/** ตรวจอินพุตส่วนที่ทุกโหมดใช้ร่วมกัน — ต้องผ่านก่อนแตะเลขใดๆ */
function assertInput(input: SplitInput): void {
  const { participants, totalSatang } = input

  if (participants.length === 0) throw new Error('ต้องมีผู้ร่วมหารอย่างน้อยหนึ่งคน')

  const seen = new Set<MemberId>()
  for (const p of participants) {
    if (seen.has(p.memberId)) throw new Error(`ผู้ร่วมหารซ้ำ: ${p.memberId}`)
    seen.add(p.memberId)
  }

  if (!Number.isSafeInteger(totalSatang)) {
    throw new Error(`ยอดบิลต้องเป็น integer: ${totalSatang}`)
  }
  if (totalSatang <= 0) throw new Error(`ยอดบิลต้องมากกว่า 0: ${totalSatang}`)

  // `items` ผูกกับโหมด itemized เท่านั้น — ส่งมาผิดโหมดแปลว่าคนเรียกเข้าใจผิด
  if (input.mode !== 'itemized' && input.items !== undefined) {
    throw new Error(`โหมด ${input.mode} ต้องไม่ส่ง items มา`)
  }
}

export function splitExpense(input: SplitInput): Share[] {
  const { participants, payerId } = input
  assertInput(input)

  const grandTotal = addSurcharge(input.totalSatang, input.surchargePct)
  const weights = weightsFor(input)

  const payerIndex = participants.findIndex((p) => p.memberId === payerId)
  // payer ที่ไม่ได้ร่วมหาร (จ่ายแทนคนอื่นล้วน) ไม่ผิด — แค่ไม่มีตัวตัดสินเศษ
  const tieBreak = payerIndex >= 0 ? payerIndex : undefined

  const parts = distributeByWeight(grandTotal, weights, tieBreak)

  return participants.map((p: Participant, i) => ({
    memberId: p.memberId,
    amountSatang: parts[i] ?? 0,
  }))
}
