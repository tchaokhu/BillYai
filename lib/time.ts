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
