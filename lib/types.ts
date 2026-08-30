/**
 * สัญญากลางของ domain core — โมดูลทุกตัวคอมไพล์กับไฟล์นี้
 *
 * ข้อห้าม "ห้ามแก้ไฟล์นี้" มีขอบเขตแค่ M1–M3 ซึ่งเขียนไว้กัน agent หลายตัวแก้ไฟล์
 * เดียวกันพร้อมกัน ไม่ใช่กฎถาวร — ตั้งแต่ Phase 1 เพิ่มของได้ แต่ต้องตั้งใจและบันทึก
 * ไว้ใน `docs/DESIGN.md` เสมอ
 *
 * จำนวนเงินทั้งหมดในไฟล์นี้เป็น **สตางค์ (integer)** เสมอ — ไม่มี float
 * ที่ไหนในเส้นทางคำนวณเงิน ดู CONTEXT.md หัวข้อ Share
 */

export type MemberId = string

// ─── การหารบิล ────────────────────────────────────────────────────────

export type SplitMode = 'equal' | 'exact' | 'share' | 'itemized'

/** ผู้ร่วมหารหนึ่งคนในบิลหนึ่งใบ */
export interface Participant {
  memberId: MemberId
  /** โหมด `share` เท่านั้น — ค่าเริ่มต้น 1 ต้อง > 0 */
  weight?: number
  /** โหมด `exact` เท่านั้น — ยอดที่ระบุตรงๆ ต้อง >= 0 */
  exactSatang?: number
}

/** รายการหนึ่งชิ้นในบิลแบบ itemized */
export interface Item {
  name: string
  amountSatang: number
  /** ใครกินชิ้นนี้บ้าง — หารเท่ากันภายในชิ้น */
  memberIds: MemberId[]
}

export interface SplitInput {
  /** ยอดก่อนบวก surcharge */
  totalSatang: number
  /** 0–100 เช่น 17 = VAT 7% + service charge 10% */
  surchargePct: number
  /** คนที่ควักเงิน — ใช้เป็นตัวตัดสินเมื่อเศษเท่ากัน (tie-break) */
  payerId: MemberId
  mode: SplitMode
  participants: Participant[]
  /** โหมด `itemized` เท่านั้น */
  items?: Item[]
}

/** ส่วนที่ตกกับคนหนึ่งคน — คำนวณเสร็จแล้ว รวม surcharge แล้ว */
export interface Share {
  memberId: MemberId
  amountSatang: number
}

// ─── หนี้ ─────────────────────────────────────────────────────────────

export interface ExpenseForDebt {
  payerId: MemberId
  shares: Share[]
  /** บิลที่ถูกยกเลิกไม่นับ */
  voided?: boolean
}

export interface SettlementForDebt {
  fromId: MemberId
  toId: MemberId
  amountSatang: number
  /** นับเฉพาะ `confirmed` — `claimed` ยังไม่นับ */
  status: 'claimed' | 'confirmed' | 'rejected' | 'cancelled'
}

/** หนี้หนึ่งคู่ — `amountSatang` เป็นบวกเสมอ */
export interface PairDebt {
  debtorId: MemberId
  creditorId: MemberId
  amountSatang: number
}

// ─── ผลการแปลข้อความ ──────────────────────────────────────────────────

/** ชื่อที่ผู้ใช้พิมพ์ ยังไม่ resolve เป็น MemberId — เป็นงานของชั้นถัดไป */
export interface DraftParticipant {
  name: string
  /** จาก `กอล์ฟx2` — ค่าเริ่มต้น 1 */
  weight: number
}

export interface ExpenseDraft {
  description: string
  totalSatang: number
  eventTag?: string
  mode: SplitMode
  participants: DraftParticipant[]
  /** `รวมฉัน` หรือไม่ระบุชื่อใครเลย → true */
  includesPayer: boolean
  surchargePct: number
}

/**
 * หนึ่งแถวบนการ์ด Draft — ยอดคำนวณเสร็จแล้ว
 *
 * **เก็บลง payload ของ draft ด้วย ไม่ใช่แค่ใช้วาดการ์ด** เพราะ Roster โตได้ระหว่าง
 * ที่การ์ดค้างอยู่ในแชท ถ้าตอนกดยืนยันคำนวณใหม่ คนจะกดจากตัวเลขหนึ่งแล้วได้อีก
 * ตัวเลขลง ledger · `splitExpense` จึงรันครั้งเดียวตอนสร้าง draft
 */
export interface DraftLine {
  name: string
  amountSatang: number
  /** ชื่อนี้วงยังไม่รู้จัก — ป้าย `(ใหม่)` บนการ์ด (D28) */
  isNew: boolean
  /**
   * แถวนี้คือคนพิมพ์เอง
   *
   * ตอนยืนยันต้องรู้ว่าแถวไหนเป็นของเขา เพราะ `name` ของแถวนั้นอาจเป็นคำว่า `คุณ`
   * ซึ่งไม่ใช่ชื่อ Member จริง — ชื่อจริงเพิ่งถูกเลือกตอนกด (ADR 0002)
   */
  isPayer: boolean
}

/**
 * `guide` ไม่ใช่คำที่ผู้ใช้พิมพ์ — เกิดจากการ @mention บอทเปล่าๆ ซึ่งเจตนาชัดว่า
 * เรียกบอท และเป็นที่เดียวที่คนใหม่ในกลุ่มจะได้เห็นไวยากรณ์โดยไม่มีใครสอน (D19)
 */
export type BotCommand = 'balance' | 'nudge' | 'edit' | 'undo' | 'guide'

/**
 * `null` = ข้อความไม่เข้า Trigger — bot ไม่สนใจ ไม่เก็บ ไม่ส่ง LLM
 * `unparsed` = เข้า Trigger แต่แปลไม่ออก — ส่งต่อให้ LLM
 */
export type ParseResult =
  | { kind: 'expense'; draft: ExpenseDraft }
  /**
   * `args` = ส่วนที่ตามหลังคำสั่ง เช่น `ยอด #เชียงใหม่` — ชั้นนี้แค่อ่านออกมา
   * ไม่ตัดสินว่ารองรับไหม เพราะ parser ไม่รู้ว่าเฟสไหนลงของอะไรไปแล้ว (D34)
   */
  | { kind: 'command'; command: BotCommand; args?: string }
  | { kind: 'unparsed'; text: string }
