/**
 * time — ขอบวันของระบบ
 *
 * ระบบนี้ตัดวันด้วยเวลาไทยทุกที่ ไม่ใช่ UTC (UTC ตัดวันตอนตี 7 ของไทย) และไม่ใช่
 * เวลาท้องถิ่นของเครื่องที่รัน ซึ่งบน Vercel ไม่มีใครรับประกันว่าคืออะไร
 *
 * ชื่อโซนสะกดว่า `Asia/Bangkok` เหมือนที่ `lib/repo/llm.ts` เขียนไว้ฝั่ง SQL —
 * grep คำเดียวต้องเจอทุกที่ที่ระบบตัดสินขอบวัน
 */

/**
 * ตัวจัดรูปแบบสร้างครั้งเดียวระดับโมดูล — `Intl.DateTimeFormat` แพงพอที่จะไม่ควร
 * สร้างใหม่ทุกข้อความ
 *
 * ระบุ `calendar` กับ `numberingSystem` ตรงๆ ไม่ปล่อยตาม locale: `th-TH` ให้ปี
 * พุทธศักราชและเลขไทย ซึ่งจะกลายเป็น `2569-08-30` ลง `date` ของ Postgres เงียบๆ
 */
const BANGKOK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Bangkok',
  calendar: 'gregory',
  numberingSystem: 'latn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/**
 * วันที่ตามเวลาไทยของ epoch ms — คืน `'YYYY-MM-DD'` ตรงรูปแบบที่ `spent_at` รับ
 *
 * รับ epoch ms เพราะนั่นคือสิ่งที่ webhook ของ LINE ส่งมา (`event.timestamp`) และ
 * เป็นค่าที่ไม่มีทางตีความ timezone ผิด ต่างจากสตริงวันที่
 */
/**
 * ช่วงที่ `Date` รับได้ — ±100,000,000 วันรอบ epoch ตามสเปกของภาษา
 *
 * `Number.isSafeInteger` ผ่านถึง 9.007e15 ซึ่งกว้างกว่านี้ ค่าที่อยู่ระหว่างสองเพดาน
 * จะทำให้ `formatToParts` โยน `RangeError: Invalid time value` ออกมาแทน ซึ่งเป็น
 * throw ที่ไม่มีใครดักตลอดเส้นทาง webhook
 */
const MAX_TIME = 8_640_000_000_000_000

export function bangkokDate(epochMs: number): string {
  if (!Number.isSafeInteger(epochMs) || Math.abs(epochMs) > MAX_TIME) {
    throw new Error(`epoch ms ต้องเป็น integer ในช่วงที่ Date รับได้ — ได้ ${epochMs}`)
  }

  let year = ''
  let month = ''
  let day = ''
  for (const part of BANGKOK.formatToParts(new Date(epochMs))) {
    if (part.type === 'year') year = part.value
    else if (part.type === 'month') month = part.value
    else if (part.type === 'day') day = part.value
  }

  // ประกอบเองจาก parts ไม่ใช่ `format()` เพราะลำดับและตัวคั่นเป็นของ locale
  // ส่วนรูปแบบที่เราต้องการเป็นของ Postgres — สองอย่างนี้ไม่ควรผูกกัน
  // ไม่ต้อง pad เอง: `2-digit` เติมศูนย์ให้แล้ว และปีของระบบนี้เป็นสี่หลักเสมอ
  return `${year}-${month}-${day}`
}

/** ชื่อย่อเดือนไทย เรียงตามเลขเดือน 1–12 */
const THAI_MONTHS = [
  'ม.ค.',
  'ก.พ.',
  'มี.ค.',
  'เม.ย.',
  'พ.ค.',
  'มิ.ย.',
  'ก.ค.',
  'ส.ค.',
  'ก.ย.',
  'ต.ค.',
  'พ.ย.',
  'ธ.ค.',
] as const

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** ปีพุทธศักราชมากกว่าคริสต์ศักราช 543 ปี */
const BE_OFFSET = 543

/**
 * `'2026-09-01'` → `'1 ก.ย. 69'` — วันที่บนการ์ดที่คนไทยอ่านออกทันที
 *
 * **แปลงจากสตริงตรงๆ ไม่ผ่าน `Date`** — ค่าที่รับมาคือ `spent_at` ซึ่งเป็นวันที่
 * ตามเวลาไทยอยู่แล้ว ส่วน `new Date('2026-09-01')` อ่านเป็นเที่ยงคืน **UTC** แล้ว
 * ทุกการอ่านค่าถัดจากนั้นจะเลื่อนไปตามโซนของเครื่องที่รัน · บั๊กชนิดนั้นทำให้บิล
 * ย้ายวันเงียบๆ และจะโผล่เฉพาะตอน deploy ข้ามภูมิภาคเท่านั้น
 *
 * **มีปี พ.ศ. สองหลักเสมอ** — รายการบิลย้อนหลังข้ามปีได้ และวันที่ที่กำกวมใน
 * ledger คือวันที่ผิด · ตัดสินใจแบบนี้แทนการเทียบกับ "ปีนี้" เพราะการเทียบนั้น
 * ต้องรู้เวลาปัจจุบัน ซึ่งจะทำให้ฟังก์ชันนี้ไม่บริสุทธิ์และเทสต์ไม่ได้แบบตรงไปตรงมา
 */
export function thaiShortDate(isoDate: string): string {
  const match = ISO_DATE_RE.exec(isoDate)
  if (match === null) {
    throw new Error(`วันที่ต้องเป็น 'YYYY-MM-DD' — ได้ ${JSON.stringify(isoDate)}`)
  }

  const [, year, month, day] = match as unknown as [string, string, string, string]
  const monthIndex = Number(month) - 1
  const name = THAI_MONTHS[monthIndex]
  // เลขเดือนนอกช่วง 1–12 ผ่าน regex มาได้ แต่ไม่มีเดือนให้ตั้งชื่อ
  if (name === undefined) throw new Error(`เดือนไม่มีอยู่จริง: ${isoDate}`)

  const be = String(Number(year) + BE_OFFSET).slice(-2)
  return `${Number(day)} ${name} ${be}`
}
