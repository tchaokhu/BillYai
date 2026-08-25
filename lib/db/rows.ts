/**
 * สัญญาระหว่างตารางกับ TypeScript — row ดิบ, record ที่โค้ดใช้, และ mapper
 *
 * ห้าม agent แก้ไฟล์นี้ repository ทุกตัวคอมไพล์กับมัน
 *
 * กติกา:
 * - row type ใช้ `type` ไม่ใช่ `interface` เพราะ `pg` ต้องการ implicit index
 *   signature (`QueryResultRow`) ซึ่ง interface ไม่มีให้
 * - คอลัมน์ที่เป็น null ได้ ใช้ `| null` **ไม่ใช่** `?:` — `exactOptionalPropertyTypes`
 *   เปิดอยู่ การปนกันสองแบบทำให้ประกอบ object ไม่ผ่าน
 * - เงินเป็น `number` สตางค์เสมอ (parser ใน client.ts แปลง bigint ให้แล้ว)
 * - `numeric` มาเป็น string ต้องผ่าน `numericToNumber` — ตั้งใจไม่แปลงทั่วระบบ
 */

import type { MemberId, SplitMode } from '@/lib/types'

// ─── enum ที่ DB บังคับด้วย check constraint ──────────────────────────

export type GroupKind = 'line_group' | 'personal'
export type GroupStatus = 'active' | 'soft_deleted'
export type ExpenseStatus = 'active' | 'voided'
export type ExpenseSource = 'rule' | 'llm' | 'liff' | 'web'
export type SettlementStatus = 'claimed' | 'confirmed' | 'rejected' | 'cancelled'
/** settlement ยืนยันในแชทกลุ่มไม่ได้ `line` จึงไม่ใช่ช่องทางของมัน */
export type SettlementVia = 'liff' | 'link' | 'web'
export type ActorVia = 'line' | 'liff' | 'link' | 'web'

// ─── ตัวช่วยแปลงค่า ───────────────────────────────────────────────────

/** `numeric` จาก `pg` เป็น string เสมอ — ใช้กับ `surcharge_pct` และ `weight` เท่านั้น */
export function numericToNumber(value: string): number {
  const n = Number(value)
  if (!Number.isFinite(n)) {
    throw new TypeError(`numeric "${value}" แปลงเป็นตัวเลขไม่ได้`)
  }
  return n
}

export function numericToNumberOrNull(value: string | null): number | null {
  return value === null ? null : numericToNumber(value)
}

/**
 * ด่านสุดท้ายก่อนให้ยอดเงินหลุดเข้าโค้ดคำนวณ
 *
 * parser ของ int8 จับกรณีเกินช่วงไปแล้ว ตัวนี้จับกรณีที่ค่ามาจากทางอื่น
 * (LLM, LIFF, เว็บ) ซึ่งเป็นทางที่ไม่ได้ผ่าน Postgres
 */
export function assertSatang(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} ต้องเป็นสตางค์แบบ integer — ได้ ${value}`)
  }
  return value
}

// ─── app_user ─────────────────────────────────────────────────────────

export type AppUserRow = {
  id: string
  line_user_id: string | null
  promptpay_cipher: Buffer | null
  promptpay_last4: string | null
  is_oa_friend: boolean
  policy_accepted_at: Date | null
  created_at: Date
}

export interface AppUser {
  id: string
  lineUserId: string | null
  promptpayCipher: Buffer | null
  promptpayLast4: string | null
  isOaFriend: boolean
  policyAcceptedAt: Date | null
  createdAt: Date
}

export function toAppUser(row: AppUserRow): AppUser {
  return {
    id: row.id,
    lineUserId: row.line_user_id,
    promptpayCipher: row.promptpay_cipher,
    promptpayLast4: row.promptpay_last4,
    isOaFriend: row.is_oa_friend,
    policyAcceptedAt: row.policy_accepted_at,
    createdAt: row.created_at,
  }
}

// ─── ledger_group ─────────────────────────────────────────────────────

export type LedgerGroupRow = {
  id: string
  kind: GroupKind
  line_group_id: string | null
  owner_id: string | null
  owner_token_hash: Buffer | null
  owner_token_at: Date | null
  status: GroupStatus
  deleted_at: Date | null
  created_at: Date
}

export interface LedgerGroup {
  id: string
  kind: GroupKind
  lineGroupId: string | null
  ownerId: string | null
  /** sha256 ของ Owner Link token — token ตัวจริงไม่เคยถูกเก็บ (D22) */
  ownerTokenHash: Buffer | null
  ownerTokenAt: Date | null
  status: GroupStatus
  deletedAt: Date | null
  createdAt: Date
}

export function toLedgerGroup(row: LedgerGroupRow): LedgerGroup {
  return {
    id: row.id,
    kind: row.kind,
    lineGroupId: row.line_group_id,
    ownerId: row.owner_id,
    ownerTokenHash: row.owner_token_hash,
    ownerTokenAt: row.owner_token_at,
    status: row.status,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
  }
}

// ─── member ───────────────────────────────────────────────────────────

export type MemberRow = {
  id: string
  group_id: string
  display_name: string
  app_user_id: string | null
  claimed_at: Date | null
  left_group_at: Date | null
  link_token_hash: Buffer | null
  link_token_at: Date | null
  created_at: Date
}

export interface Member {
  id: MemberId
  groupId: string
  displayName: string
  /** null = ยังเป็น Placeholder ไม่มีใคร claim (D4) */
  appUserId: string | null
  claimedAt: Date | null
  /** มาร์กว่าออกจากกลุ่ม ไม่ลบ — หนี้ค้างต้องยังอยู่ (D18) */
  leftGroupAt: Date | null
  /** sha256 ของ Nudge Link token (D20) */
  linkTokenHash: Buffer | null
  linkTokenAt: Date | null
  createdAt: Date
}

export function toMember(row: MemberRow): Member {
  return {
    id: row.id,
    groupId: row.group_id,
    displayName: row.display_name,
    appUserId: row.app_user_id,
    claimedAt: row.claimed_at,
    leftGroupAt: row.left_group_at,
    linkTokenHash: row.link_token_hash,
    linkTokenAt: row.link_token_at,
    createdAt: row.created_at,
  }
}

// ─── expense ──────────────────────────────────────────────────────────

export type ExpenseRow = {
  id: string
  group_id: string
  event_tag: string | null
  description: string
  total_satang: number
  surcharge_pct: string
  payer_member_id: string
  split_mode: SplitMode
  /** `'YYYY-MM-DD'` — parser ใน client.ts กันไม่ให้กลายเป็น `Date` */
  spent_at: string
  created_by: string
  source: ExpenseSource
  status: ExpenseStatus
  voided_at: Date | null
  created_at: Date
}

export interface Expense {
  id: string
  groupId: string
  eventTag: string | null
  description: string
  /** ยอดก่อนบวก surcharge */
  totalSatang: number
  surchargePct: number
  payerMemberId: MemberId
  splitMode: SplitMode
  /** `'YYYY-MM-DD'` ตามเวลาที่คนจดกรอก ไม่ใช่ timestamp */
  spentAt: string
  createdBy: MemberId
  source: ExpenseSource
  status: ExpenseStatus
  voidedAt: Date | null
  createdAt: Date
}

export function toExpense(row: ExpenseRow): Expense {
  return {
    id: row.id,
    groupId: row.group_id,
    eventTag: row.event_tag,
    description: row.description,
    totalSatang: assertSatang(row.total_satang, 'expense.total_satang'),
    surchargePct: numericToNumber(row.surcharge_pct),
    payerMemberId: row.payer_member_id,
    splitMode: row.split_mode,
    spentAt: row.spent_at,
    createdBy: row.created_by,
    source: row.source,
    status: row.status,
    voidedAt: row.voided_at,
    createdAt: row.created_at,
  }
}

export type ExpenseShareRow = {
  id: string
  expense_id: string
  member_id: string
  weight: string | null
  amount_satang: number
}

export interface ExpenseShare {
  id: string
  expenseId: string
  memberId: MemberId
  /** ใช้เมื่อ `split_mode='share'` เท่านั้น */
  weight: number | null
  /** ยอดสุดท้าย รวม surcharge แล้ว */
  amountSatang: number
}

export function toExpenseShare(row: ExpenseShareRow): ExpenseShare {
  return {
    id: row.id,
    expenseId: row.expense_id,
    memberId: row.member_id,
    weight: numericToNumberOrNull(row.weight),
    amountSatang: assertSatang(row.amount_satang, 'expense_share.amount_satang'),
  }
}

export type ExpenseItemRow = {
  id: string
  expense_id: string
  name: string
  amount_satang: number
}

export interface ExpenseItem {
  id: string
  expenseId: string
  name: string
  amountSatang: number
}

export function toExpenseItem(row: ExpenseItemRow): ExpenseItem {
  return {
    id: row.id,
    expenseId: row.expense_id,
    name: row.name,
    amountSatang: assertSatang(row.amount_satang, 'expense_item.amount_satang'),
  }
}

export type ExpenseItemShareRow = {
  item_id: string
  member_id: string
  weight: string
}

export interface ExpenseItemShare {
  itemId: string
  memberId: MemberId
  weight: number
}

export function toExpenseItemShare(row: ExpenseItemShareRow): ExpenseItemShare {
  return {
    itemId: row.item_id,
    memberId: row.member_id,
    weight: numericToNumber(row.weight),
  }
}

// ─── settlement ───────────────────────────────────────────────────────

export type SettlementRow = {
  id: string
  group_id: string
  from_member_id: string
  to_member_id: string
  amount_satang: number
  status: SettlementStatus
  claimed_at: Date
  claimed_by: string | null
  claimed_via: SettlementVia
  confirmed_at: Date | null
  confirmed_by: string | null
  confirmed_via: SettlementVia | null
  note: string | null
}

export interface Settlement {
  id: string
  groupId: string
  /** ลูกหนี้ */
  fromMemberId: MemberId
  /** เจ้าหนี้ — คนเดียวที่ยืนยันได้ว่าเงินเข้าจริง (D8) */
  toMemberId: MemberId
  amountSatang: number
  status: SettlementStatus
  claimedAt: Date
  claimedBy: MemberId | null
  claimedVia: SettlementVia
  confirmedAt: Date | null
  confirmedBy: MemberId | null
  confirmedVia: SettlementVia | null
  note: string | null
}

export function toSettlement(row: SettlementRow): Settlement {
  return {
    id: row.id,
    groupId: row.group_id,
    fromMemberId: row.from_member_id,
    toMemberId: row.to_member_id,
    amountSatang: assertSatang(row.amount_satang, 'settlement.amount_satang'),
    status: row.status,
    claimedAt: row.claimed_at,
    claimedBy: row.claimed_by,
    claimedVia: row.claimed_via,
    confirmedAt: row.confirmed_at,
    confirmedBy: row.confirmed_by,
    confirmedVia: row.confirmed_via,
    note: row.note,
  }
}

// ─── audit_log / llm_usage ────────────────────────────────────────────

export type AuditLogRow = {
  id: number
  group_id: string | null
  actor: string | null
  actor_via: ActorVia
  action: string
  target_type: string
  target_id: string | null
  before: unknown
  after: unknown
  created_at: Date
}

export interface AuditLog {
  id: number
  groupId: string | null
  actor: MemberId | null
  actorVia: ActorVia
  action: string
  targetType: string
  targetId: string | null
  before: unknown
  after: unknown
  createdAt: Date
}

export function toAuditLog(row: AuditLogRow): AuditLog {
  return {
    id: row.id,
    groupId: row.group_id,
    actor: row.actor,
    actorVia: row.actor_via,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    before: row.before,
    after: row.after,
    createdAt: row.created_at,
  }
}

export type LlmUsageRow = {
  id: number
  app_user_id: string | null
  group_id: string | null
  input_tokens: number
  output_tokens: number
  created_at: Date
}

export interface LlmUsage {
  id: number
  appUserId: string | null
  groupId: string | null
  inputTokens: number
  outputTokens: number
  createdAt: Date
}

export function toLlmUsage(row: LlmUsageRow): LlmUsage {
  return {
    id: row.id,
    appUserId: row.app_user_id,
    groupId: row.group_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    createdAt: row.created_at,
  }
}
