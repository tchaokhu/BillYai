/**
 * S4 — วัด cold start ของ webhook บน Vercel + Supabase free
 *
 *   npm run spike:s4 -- https://<โดเมน>/api/line/webhook [จำนวนครั้ง]
 *
 * ต้องตั้ง `LINE_CHANNEL_SECRET` ในเทอร์มินัลก่อนรัน — สคริปต์อ่านจาก env
 * และ **ไม่พิมพ์ค่านั้นออกมาไม่ว่ากรณีใด** ตัวลายเซ็นก็ไม่พิมพ์
 *
 * ทำไมต้องเซ็นจริง: route ปฏิเสธลายเซ็นผิดตั้งแต่ก่อนแตะ DB (ตั้งใจ — ไม่งั้นใครก็
 * ปลุก Supabase free ให้หมดโควตาได้) ยิงด้วยลายเซ็นมั่วจึงวัดได้แค่ cold start ของ
 * function ไม่รวมเวลาปลุก DB ซึ่งเป็นครึ่งหนึ่งของคำถามที่ S4 ถาม
 *
 * ก่อนรันชุดวัดจริง **ต้องปล่อยระบบทิ้งไว้อย่างน้อย 30 นาที** ให้ทั้ง Vercel function
 * และ Supabase free เย็นจริง มิฉะนั้นครั้งแรกก็เป็น warm ไปแล้ว
 */

import { createHmac } from 'node:crypto'

const SECRET_ENV = 'LINE_CHANNEL_SECRET'

/** body ที่ LINE ส่งมาตอน webhook ว่าง — เล็กที่สุดที่ route ยังเดินครบเส้น */
const BODY = '{"events":[]}'

const url = process.argv[2]
const rounds = Number(process.argv[3] ?? 5)

/**
 * https เท่านั้น ยกเว้น server ในเครื่อง — ยิง http ข้ามเน็ตแปลว่าลายเซ็นกับ body
 * เดินทางเป็น plaintext ซึ่งไม่มีเหตุผลให้ทำ ส่วน localhost ต้องอนุญาตไว้เพราะ
 * ตัวสคริปต์นี้เองต้องถูกทดสอบกับ `next start` ก่อนเอาไปยิงของจริง
 */
function isAllowed(target: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    return false
  }
  if (parsed.protocol === 'https:') return true
  return parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
}

if (url === undefined || !isAllowed(url)) {
  console.error('ใช้: npm run spike:s4 -- https://<โดเมน>/api/line/webhook [จำนวนครั้ง]')
  console.error('(http ใช้ได้เฉพาะ localhost ตอนทดสอบตัวสคริปต์เอง)')
  process.exit(1)
}
if (!Number.isInteger(rounds) || rounds < 1) {
  console.error(`จำนวนครั้งต้องเป็นจำนวนเต็มบวก ได้มา: ${process.argv[3]}`)
  process.exit(1)
}

const secret = (process.env[SECRET_ENV] ?? '').trim()
if (secret.length === 0) {
  console.error(
    `ไม่ได้ตั้ง ${SECRET_ENV}\n` +
      `  PowerShell:  $env:${SECRET_ENV} = "<channel secret>"\n` +
      `รันในเทอร์มินัลของตัวเอง อย่ารันผ่าน ! ในแชท — ค่าจะไปโผล่ในบทสนทนา`,
  )
  process.exit(1)
}

const bodyBytes = Buffer.from(BODY, 'utf8')
const signature = createHmac('sha256', secret).update(bodyBytes).digest('base64')

interface Sample {
  round: number
  status: number
  wallMs: number
  dbMs: number | null
  serverMs: number | null
}

/** ดึงตัวเลขจาก `Server-Timing: db;dur=12.3, total;dur=15.1` */
function parseServerTiming(header: string | null, metric: string): number | null {
  if (header === null) return null
  const match = new RegExp(`(?:^|,)\\s*${metric};dur=([0-9.]+)`).exec(header)
  if (match === null) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

async function fire(round: number): Promise<Sample> {
  const startedAt = performance.now()
  const res = await fetch(url as string, {
    method: 'POST',
    headers: {
      'x-line-signature': signature,
      'content-type': 'application/json',
      // แต่ละครั้งต้องจ่ายค่า TCP + TLS ใหม่เหมือนที่ LINE ยิงมาจริง
      // ถ้าใช้ connection เดิมซ้ำ ครั้งที่ 2 เป็นต้นไปจะเร็วกว่าความจริง
      connection: 'close',
    },
    body: bodyBytes,
  })
  const wallMs = performance.now() - startedAt
  const timing = res.headers.get('server-timing')
  await res.arrayBuffer()

  return {
    round,
    status: res.status,
    wallMs,
    dbMs: parseServerTiming(timing, 'db'),
    serverMs: parseServerTiming(timing, 'total'),
  }
}

const ms = (value: number | null): string => (value === null ? '   -  ' : value.toFixed(1).padStart(6))

console.log(`ยิง ${rounds} ครั้งไปที่ ${url}`)
console.log('ครั้งที่ 1 = cold ที่เหลือ = warm · เวลาเป็น ms\n')
console.log('  #  status    wall    server      db     เน็ต+cold')
console.log('  ───────────────────────────────────────────────────')

const samples: Sample[] = []
for (let round = 1; round <= rounds; round++) {
  const sample = await fire(round)
  samples.push(sample)

  // เวลาที่หายไประหว่าง wall กับ server = เดินทางไปกลับ + เวลาปลุก function
  // ซึ่งเป็นส่วนที่ Vercel กินไปก่อนโค้ดเราได้เริ่มทำงาน
  const overhead = sample.serverMs === null ? null : sample.wallMs - sample.serverMs

  console.log(
    `  ${String(sample.round).padStart(2)}  ${String(sample.status).padStart(5)}` +
      `  ${ms(sample.wallMs)}  ${ms(sample.serverMs)}  ${ms(sample.dbMs)}  ${ms(overhead)}`,
  )
}

const bad = samples.filter((s) => s.status !== 200)
if (bad.length > 0) {
  console.error(`\n${bad.length}/${rounds} ครั้งไม่ได้ 200 — ตัวเลขข้างบนใช้สรุป S4 ไม่ได้`)
  if (bad.some((s) => s.status === 401)) {
    console.error(`  401 = ${SECRET_ENV} ในเทอร์มินัลนี้ไม่ตรงกับที่ตั้งไว้บน Vercel`)
  }
  if (bad.some((s) => s.status === 500)) {
    console.error('  500 = ลายเซ็นผ่านแล้วแต่ DB พัง — ดู log ของ Vercel บรรทัด [webhook] status=500')
  }
  // ตั้ง exit code แล้วปล่อยให้จบเอง ไม่ใช่ `process.exit()` — บน Windows การฆ่า
  // process ทั้งที่ socket ของ undici ยังไม่ปิด ทำให้ libuv assert แล้วพ่น
  // `UV_HANDLE_CLOSING` ทับข้อความวินิจฉัยที่เพิ่งพิมพ์ไป และ exit code ก็เพี้ยนเป็น 0
  process.exitCode = 1
} else {
  // สรุปเฉพาะตอนที่ทุกครั้งได้ 200 — พิมพ์ "cold = 2.5 วินาที" ต่อท้ายชุดที่ 401
  // ทั้งชุด คือการยื่นตัวเลขที่ไม่ได้วัดอะไรเลยให้คนเอาไปกรอกลงเอกสาร
  const cold = samples[0]
  const warm = samples.slice(1)
  if (cold !== undefined) {
    console.log(`\ncold (ครั้งที่ 1)  wall ${cold.wallMs.toFixed(0)} ms`)
  }
  if (warm.length > 0) {
    const sorted = warm.map((s) => s.wallMs).sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0
    const worst = sorted[sorted.length - 1] ?? 0
    console.log(`warm (มัธยฐาน)    wall ${median.toFixed(0)} ms · ช้าสุด ${worst.toFixed(0)} ms`)
  }

  console.log('\nเอาตัวเลขไปกรอกตาราง S4 ใน docs/SPIKE-PHASE0.md')
  console.log('ทำซ้ำอีกรอบหลังทิ้งไว้อีก 30 นาที เพื่อยืนยันว่าครั้งแรกไม่ใช่ฟลุ๊ก')
}
