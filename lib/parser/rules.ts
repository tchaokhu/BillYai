import { isSupportedWeight } from '../money'
import type { BotCommand, DraftParticipant, ParseResult } from '../types'

/** คำสั่งคำเดียว — ต้องตรงทั้งข้อความ (หลัง trim) ไม่งั้นถือว่าไม่เข้า Trigger */
const COMMANDS: ReadonlyMap<string, BotCommand> = new Map([
  ['ยอด', 'balance'],
  ['ทวง', 'nudge'],
  ['แก้', 'edit'],
  ['เลิก', 'undo'],
])

/** คำที่บอกว่าคนจ่ายร่วมหารด้วย — ไม่นับเป็นชื่อคน */
const INCLUDE_PAYER = 'รวมฉัน'

/**
 * คำสั่งคำเดียว หรือคำสั่งที่ตามด้วย `#tag` เท่านั้น (D34)
 *
 * ที่ไม่รับคำธรรมดาต่อท้าย เพราะ `ยอด` เป็นชื่อคนได้ และ `ยอด มาไหม` คือประโยค
 * ที่คนในกลุ่มคุยกันเอง — ตอบว่า "ยังไม่เปิดใช้" ใส่บทสนทนาแบบนั้นคือสิ่งเดียวกับ
 * ที่กฎเงียบมีไว้กัน · `#tag` ต่างออกไปเพราะไม่มีใครพิมพ์โดยบังเอิญ
 */
function parseCommand(trimmed: string): ParseResult | null {
  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0)
  const head = tokens[0]
  if (head === undefined) return null

  const command = COMMANDS.get(head)
  if (command === undefined) return null

  const rest = tokens.slice(1)
  if (rest.length === 0) return { kind: 'command', command }
  if (!rest.every((t) => t.startsWith('#') && t.length > 1)) return null

  // `exactOptionalPropertyTypes` เปิดอยู่ — ห้ามใส่ `args: undefined`
  return { kind: 'command', command, args: rest.join(' ') }
}

/** คืน null = ข้อความไม่เข้า Trigger, bot ไม่สนใจ */
export function parseMessage(text: string): ParseResult | null {
  const trimmed = text.trim()

  const command = parseCommand(trimmed)
  if (command !== null) return command

  if (trimmed.startsWith('+')) {
    return parseExpense(trimmed.slice(1), text)
  }

  return null
}

/**
 * ข้อความที่ @mention บอทแล้ว **ตัดชื่อออกไปแล้ว** (`lib/line/mention.ts`)
 *
 * ทางเข้าที่สองของ parser — mention คือ Trigger ไปแล้ว จึงไม่ต้องมี `+` นำหน้า
 * และ **ไม่มีทางคืน `null`**: ถูกเรียกแล้วต้องมีคำตอบเสมอ ต่างจาก `parseMessage`
 * ที่ `null` แปลว่าไม่ได้พูดกับเรา
 *
 * แยกเป็นคนละฟังก์ชันโดยตั้งใจ — `parseMessage` ถูก `lib/contract.test.ts` ล็อกไว้
 * ทั้งชุด และการยัดโหมดที่สองเข้าไปในตัวเดิมคือการเปลี่ยนความหมายของ `null`
 */
export function parseAddressedMessage(text: string): ParseResult {
  const trimmed = text.trim()

  // เรียกบอทเปล่าๆ — เจตนาชัดว่าเรียก ไม่ใช่ false positive
  if (trimmed.length === 0) return { kind: 'command', command: 'guide' }

  const command = parseCommand(trimmed)
  if (command !== null) return command

  const body = trimmed.startsWith('+') ? trimmed.slice(1) : trimmed
  return parseExpense(body, trimmed)
}

/**
 * `body` = ข้อความหลังเครื่องหมาย `+`
 * รูปแบบ: `<คำอธิบาย> <ยอด> [ชื่อคน...] [รวมฉัน] [#tag]`
 */
function parseExpense(body: string, original: string): ParseResult {
  const unparsed: ParseResult = { kind: 'unparsed', text: original }

  const tokens = body.trim().split(/\s+/).filter((t) => t.length > 0)

  const amountIndex = tokens.findIndex((t) => parseAmountSatang(t) !== null)
  if (amountIndex < 1) return unparsed // ไม่มียอด หรือไม่มีคำอธิบายนำหน้ายอด

  const totalSatang = parseAmountSatang(tokens[amountIndex] ?? '')
  if (totalSatang === null) return unparsed

  const participants: DraftParticipant[] = []
  let eventTag: string | undefined
  let sawIncludeMe = false

  for (const token of tokens.slice(amountIndex + 1)) {
    if (token === INCLUDE_PAYER) {
      sawIncludeMe = true
      continue
    }

    if (token.startsWith('#')) {
      const tag = token.slice(1)
      // tag ว่าง หรือมีหลาย tag = กำกวม ปล่อยให้ LLM ตัดสิน
      if (tag.length === 0 || eventTag !== undefined) return unparsed
      eventTag = tag
      continue
    }

    const participant = parseParticipant(token)
    if (participant === null) return unparsed
    // ชื่อซ้ำในบิลเดียวกันเดาไม่ได้ว่าหมายถึงคนเดียวหรือคนละคน
    if (participants.some((p) => p.name === participant.name)) return unparsed
    participants.push(participant)
  }

  return {
    kind: 'expense',
    draft: {
      description: tokens.slice(0, amountIndex).join(' '),
      totalSatang,
      ...(eventTag !== undefined ? { eventTag } : {}),
      mode: 'share',
      participants,
      // ไม่ระบุชื่อใครเลย = หารทุกคนใน Roster ซึ่งรวมคนจ่ายด้วย
      includesPayer: sawIncludeMe || participants.length === 0,
      surchargePct: 0,
    },
  }
}

/** `กอล์ฟ` → weight 1 · `กอล์ฟx2` → weight 2 · คืน null ถ้าใช้เป็นชื่อคนไม่ได้ */
function parseParticipant(token: string): DraftParticipant | null {
  const weighted = WEIGHT_RE.exec(normalizeDigits(token))
  if (weighted === null) {
    // ตัวเลขล้วนไม่ใช่ชื่อคน — กันยอดที่สองกลายเป็นผู้ร่วมหารเงียบๆ
    if (isNumericLike(token)) return null
    return { name: token, weight: 1 }
  }

  const normalizedName = weighted[1] ?? ''
  const weight = Number(weighted[2])
  // ชื่อว่าง (`x2`), ชื่อเป็นตัวเลข, หรือน้ำหนักซ้อน (`กอล์ฟx2x3`) = เดาไม่ได้
  if (normalizedName.length === 0 || isNumericLike(normalizedName)) return null
  if (WEIGHT_RE.test(normalizedName)) return null
  // น้ำหนักนอกช่วงที่ `distribute` รองรับต้องตกที่นี่ ไม่ใช่ไปโผล่เป็น throw
  // กลางเส้นทาง webhook ซึ่งกลายเป็น 500 แล้ว LINE retry ซ้ำไม่รู้จบ
  if (!isSupportedWeight(weight)) return null

  // normalizeDigits ไม่เปลี่ยนความยาว จึงตัดชื่อจาก token ต้นฉบับได้ตรงตำแหน่ง
  return { name: token.slice(0, normalizedName.length), weight }
}

/** `<ชื่อ>x<น้ำหนัก>` — ต้อง normalize เลขไทยก่อนใช้ */
const WEIGHT_RE = /^(.*)[xX](-?\d+(?:\.\d+)?)$/

function isNumericLike(token: string): boolean {
  return /^[\d,.]+$/.test(normalizeDigits(token))
}

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙'

function normalizeDigits(token: string): string {
  return token.replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)))
}

/** `1,200` `1200.50` `๑๒๐๐` — คอมมาต้องคั่นหลักพันถูกต้อง ทศนิยมไม่เกิน 2 ตำแหน่ง */
const AMOUNT_RE = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/

/**
 * คืนสตางค์ (integer) หรือ null ถ้า token ไม่ใช่ยอดเงิน
 *
 * แปลงจากสตริงตรงๆ ไม่คูณ float — `1200.15 * 100` ได้ 120014.99999999999
 */
function parseAmountSatang(token: string): number | null {
  const matched = AMOUNT_RE.exec(normalizeDigits(token))
  if (matched === null) return null

  const baht = Number((matched[1] ?? '').replace(/,/g, ''))
  const satang = Number((matched[2] ?? '').padEnd(2, '0'))
  const total = baht * 100 + satang

  // ยอดต้องมากกว่า 0 และต้องแทนด้วย integer ได้จริง
  if (total <= 0 || !Number.isSafeInteger(total)) return null
  return total
}
