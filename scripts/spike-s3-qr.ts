/**
 * spike S3 — สร้าง QR พร้อมเพย์จริงให้เอาไปสแกนด้วยแอปธนาคาร
 *
 *   npm run spike:s3 -- 0812345678 0.01 12.34 100 1250.50
 *
 * อาร์กิวเมนต์แรกคือเบอร์พร้อมเพย์ ที่เหลือคือยอดเป็น "บาท" (ใส่กี่ยอดก็ได้
 * ไม่ใส่เลยก็ได้ = ทดสอบเฉพาะ QR แบบไม่ระบุยอด)
 *
 * ทุกยอดออก QR สองใบ ลำดับ tag ต่างกัน — คำถามหลักของ S3 คือแอปธนาคารไทย
 * อ่านได้ทั้งสองแบบไหม และยอดที่ขึ้นบนจอตรงกับที่สั่งไหม
 *
 * ไม่ยิงเน็ต ไม่แตะ DB · ไฟล์ลง `spike-out/` ซึ่ง gitignore ไว้แล้วเพราะ QR
 * มีเบอร์พร้อมเพย์จริงฝังอยู่
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as QRCode from 'qrcode'
import { bahtToSatang, formatSatang } from '@/lib/money'
import { normalizeThaiMobile } from '@/lib/crypto/promptpay'
import { buildPromptPayPayload, type TagOrder } from '@/lib/promptpay/emv'

const OUT_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)), 'spike-out')
const ORDERS: TagOrder[] = ['ascending', 'countryFirst']

const args = process.argv.slice(2)
/**
 * ต้องขอ flag ถึงจะพิมพ์ payload เต็ม เพราะ payload มีเบอร์พร้อมเพย์ครบทุกหลัก
 * อยู่ในนั้น และ `docs/SPIKE-PHASE0.md` (ไฟล์ที่ commit) คือที่ที่คนรัน spike
 * ถูกสั่งให้เอาผลไปแปะ — ถ้าพิมพ์เต็มโดย default เบอร์จริงจะลง git ในที่สุด
 * เหตุผลเดียวกับที่ `normalizeThaiMobile` ไม่ใส่เบอร์ลง error ตาม D12
 */
const showFullPayload = args.includes('--show-payload')
const [mobile, ...bahtArgs] = args.filter((arg) => arg !== '--show-payload')

if (mobile === undefined) {
  console.error('ใช้: npm run spike:s3 -- <เบอร์พร้อมเพย์> [ยอดบาท ...] [--show-payload]')
  process.exit(1)
}

const local = normalizeThaiMobile(mobile)
const account = `0066${local.slice(1)}`
const maskedAccount = `0066${'*'.repeat(5)}${local.slice(-4)}`

/** ปิดเบอร์ในสตริงที่จะพิมพ์ออกจอ เหลือสี่ตัวท้ายตามที่ D12 ยอมให้โชว์ */
function mask(payload: string): string {
  return payload.replaceAll(account, maskedAccount)
}

/** `undefined` ใบแรกเสมอ = เคส "ให้ผู้จ่ายกรอกยอดเอง" ซึ่งต้องสแกนผ่านด้วย */
const amounts: (number | undefined)[] = [
  undefined,
  ...bahtArgs.map((arg) => bahtToSatangArg(arg)),
]

function bahtToSatangArg(arg: string): number {
  // import แบบ lazy ไม่ได้ช่วยอะไร แยกเป็นฟังก์ชันเพื่อให้ error บอกว่ายอดไหนพัง
  try {
    return bahtToSatang(arg)
  } catch (error) {
    throw new Error(`ยอด "${arg}" ไม่ถูกต้อง: ${(error as Error).message}`)
  }
}

await mkdir(OUT_DIR, { recursive: true })

const rows: { ยอด: string; ลำดับ: string; ไฟล์: string; payload: string }[] = []
for (const amountSatang of amounts) {
  for (const order of ORDERS) {
    const payload = buildPromptPayPayload(
      amountSatang === undefined ? { mobile, order } : { mobile, amountSatang, order },
    )
    const stem = amountSatang === undefined ? 'noamount' : String(amountSatang)
    const file = path.join(OUT_DIR, `s3-${stem}-${order}.png`)
    // margin 4 module + level M คือค่าที่อ่านติดง่ายเมื่อสแกนจากจออีกเครื่อง
    await QRCode.toFile(file, payload, { errorCorrectionLevel: 'M', margin: 4, width: 512 })
    rows.push({
      // ใช้ `formatSatang` ไม่คำนวณเอง — คอลัมน์นี้คือค่าที่คนเอาไปเทียบกับจอ
      // ธนาคาร มันต้องมาจากเส้น integer เดียวกับที่สร้าง payload
      ยอด: amountSatang === undefined ? 'ไม่ระบุ' : `${formatSatang(amountSatang)} บาท`,
      ลำดับ: order,
      ไฟล์: path.basename(file),
      payload,
    })
  }
}

console.table(rows.map(({ payload: _payload, ...rest }) => rest))

if (showFullPayload) {
  console.log('\npayload เต็ม — มีเบอร์พร้อมเพย์ครบทุกหลัก อย่าแปะลงไฟล์ที่ commit:')
  for (const row of rows) console.log(`  ${row.ไฟล์}\n    ${row.payload}`)
} else {
  console.log('\npayload (ปิดเบอร์ไว้ — แปะลง docs/SPIKE-PHASE0.md ได้):')
  for (const row of rows) console.log(`  ${row.ไฟล์}\n    ${mask(row.payload)}`)
  console.log('\nอยากได้ตัวเต็มไปเทียบกับ generator เจ้าอื่น: เติม --show-payload')
}

console.log(`\nไฟล์อยู่ที่ ${OUT_DIR}`)
console.log('บันทึกผลสแกนลงตาราง S3 ใน docs/SPIKE-PHASE0.md')
