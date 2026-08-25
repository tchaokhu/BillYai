/**
 * ตัวสร้างข้อมูลตั้งต้นสำหรับ integration test — SQL ดิบล้วน
 *
 * ห้าม agent แก้ไฟล์นี้
 *
 * **ทำไมต้องเป็น SQL ดิบ ไม่เรียก repository:** ถ้าเทสต์ของ `expenses` ต้อง
 * สร้างสมาชิกด้วย `members.ts` เทสต์นั้นจะแดงเมื่อ `members.ts` พัง ทั้งที่
 * `expenses.ts` ไม่ผิด และโมดูลสองตัวจะทำขนานกันไม่ได้
 *
 * **fixtures ไม่ตรวจ invariant ใดๆ** เพราะเทสต์ต้องสร้างสภาพที่ผิดปกติได้
 * (shares ที่รวมไม่ตรง total, settlement ที่ยังไม่ confirm) เพื่อพิสูจน์ว่า
 * โค้ดจริงจับได้
 *
 * **ห้าม TRUNCATE ห้าม db:reset ในเทสต์** — vitest รันหลายไฟล์ขนานกัน
 * ทุกเทสต์สร้างวงของตัวเองแล้ว assert เฉพาะในวงนั้น
 */

import { randomUUID } from 'node:crypto'
import { getPool, type Queryable } from '@/lib/db/client'
import {
  toExpense,
  toLedgerGroup,
  toMember,
  toSettlement,
  type Expense,
  type ExpenseRow,
  type ExpenseSource,
  type LedgerGroup,
  type LedgerGroupRow,
  type Member,
  type MemberRow,
  type Settlement,
  type SettlementRow,
  type SettlementStatus,
  type SettlementVia,
} from '@/lib/db/rows'
import type { MemberId, SplitMode } from '@/lib/types'

/** ค่าที่ไม่เกี่ยวกับสิ่งที่เทสต์กำลังพิสูจน์ ใช้ค่านี้เพื่อให้ diff อ่านง่าย */
const DEFAULT_SPENT_AT = '2026-01-15'

function db(explicit?: Queryable): Queryable {
  return explicit ?? getPool()
}

/** ชื่อที่ไม่ชนกับเทสต์ไฟล์อื่นที่รันขนานกันอยู่ */
export function uniqueName(prefix = 'คน'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}

// ─── วง ───────────────────────────────────────────────────────────────

export async function makeGroup(
  tx?: Queryable,
  overrides: { lineGroupId?: string } = {},
): Promise<LedgerGroup> {
  const lineGroupId = overrides.lineGroupId ?? `C${randomUUID().replace(/-/g, '')}`
  const { rows } = await db(tx).query<LedgerGroupRow>(
    `insert into ledger_group (kind, line_group_id)
     values ('line_group', $1)
     returning *`,
    [lineGroupId],
  )
  const row = rows[0]
  if (!row) throw new Error('makeGroup: insert ไม่คืนแถว')
  return toLedgerGroup(row)
}

export async function makePersonalGroup(
  tx?: Queryable,
  overrides: { ownerId?: string; ownerTokenHash?: Buffer } = {},
): Promise<LedgerGroup> {
  const ownerTokenHash =
    overrides.ownerId === undefined
      ? (overrides.ownerTokenHash ?? randomBytes32())
      : (overrides.ownerTokenHash ?? null)
  const { rows } = await db(tx).query<LedgerGroupRow>(
    `insert into ledger_group (kind, owner_id, owner_token_hash, owner_token_at)
     values ('personal', $1, $2::bytea, case when $2::bytea is null then null else now() end)
     returning *`,
    [overrides.ownerId ?? null, ownerTokenHash],
  )
  const row = rows[0]
  if (!row) throw new Error('makePersonalGroup: insert ไม่คืนแถว')
  return toLedgerGroup(row)
}

// ─── คน ───────────────────────────────────────────────────────────────

export async function makeAppUser(
  tx?: Queryable,
  overrides: { lineUserId?: string | null } = {},
): Promise<{ id: string; lineUserId: string | null }> {
  const lineUserId =
    overrides.lineUserId === undefined
      ? `U${randomUUID().replace(/-/g, '')}`
      : overrides.lineUserId
  const { rows } = await db(tx).query<{ id: string; line_user_id: string | null }>(
    `insert into app_user (line_user_id) values ($1) returning id, line_user_id`,
    [lineUserId],
  )
  const row = rows[0]
  if (!row) throw new Error('makeAppUser: insert ไม่คืนแถว')
  return { id: row.id, lineUserId: row.line_user_id }
}

/** สมาชิกหนึ่งคน — เป็น Placeholder เว้นแต่ส่ง `appUserId` มาด้วย */
export async function makeMember(
  groupId: string,
  displayName?: string,
  tx?: Queryable,
  overrides: { appUserId?: string } = {},
): Promise<Member> {
  const appUserId = overrides.appUserId ?? null
  const { rows } = await db(tx).query<MemberRow>(
    `insert into member (group_id, display_name, app_user_id, claimed_at)
     values ($1, $2, $3::uuid, case when $3::uuid is null then null else now() end)
     returning *`,
    [groupId, displayName ?? uniqueName(), appUserId],
  )
  const row = rows[0]
  if (!row) throw new Error('makeMember: insert ไม่คืนแถว')
  return toMember(row)
}

export async function makeMembers(
  groupId: string,
  names: readonly string[],
  tx?: Queryable,
): Promise<Member[]> {
  const out: Member[] = []
  for (const name of names) {
    out.push(await makeMember(groupId, name, tx))
  }
  return out
}

// ─── บิล ──────────────────────────────────────────────────────────────

export interface ExpenseFixture {
  groupId: string
  payerMemberId: MemberId
  totalSatang: number
  /** ยอดต่อคน **รวม surcharge แล้ว** — fixtures ไม่ตรวจว่ารวมกันตรง total ไหม */
  shares: ReadonlyArray<{ memberId: MemberId; amountSatang: number; weight?: number }>
  description?: string
  surchargePct?: number
  splitMode?: SplitMode
  spentAt?: string
  eventTag?: string | null
  createdBy?: MemberId
  source?: ExpenseSource
}

export async function makeExpense(
  fixture: ExpenseFixture,
  tx?: Queryable,
): Promise<Expense> {
  const q = db(tx)
  const { rows } = await q.query<ExpenseRow>(
    `insert into expense (
       group_id, event_tag, description, total_satang, surcharge_pct,
       payer_member_id, split_mode, spent_at, created_by, source
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning *`,
    [
      fixture.groupId,
      fixture.eventTag ?? null,
      fixture.description ?? 'ข้าว',
      fixture.totalSatang,
      fixture.surchargePct ?? 0,
      fixture.payerMemberId,
      fixture.splitMode ?? 'equal',
      fixture.spentAt ?? DEFAULT_SPENT_AT,
      fixture.createdBy ?? fixture.payerMemberId,
      fixture.source ?? 'rule',
    ],
  )
  const row = rows[0]
  if (!row) throw new Error('makeExpense: insert ไม่คืนแถว')
  const expense = toExpense(row)

  for (const share of fixture.shares) {
    await q.query(
      `insert into expense_share (expense_id, member_id, weight, amount_satang)
       values ($1, $2, $3, $4)`,
      [expense.id, share.memberId, share.weight ?? null, share.amountSatang],
    )
  }
  return expense
}

/** มาร์กบิลว่ายกเลิก โดยไม่ผ่าน repository */
export async function voidExpense(expenseId: string, tx?: Queryable): Promise<void> {
  await db(tx).query(
    `update expense set status = 'voided', voided_at = now() where id = $1`,
    [expenseId],
  )
}

// ─── การเคลียร์หนี้ ───────────────────────────────────────────────────

export interface SettlementFixture {
  groupId: string
  fromMemberId: MemberId
  toMemberId: MemberId
  amountSatang: number
  /** default `'claimed'` — D8 บังคับว่าทุกอันเกิดจากลูกหนี้แจ้งก่อน */
  status?: SettlementStatus
  claimedVia?: SettlementVia
  confirmedVia?: SettlementVia
  note?: string
}

export async function makeSettlement(
  fixture: SettlementFixture,
  tx?: Queryable,
): Promise<Settlement> {
  const status = fixture.status ?? 'claimed'
  const confirmed = status === 'confirmed'
  const { rows } = await db(tx).query<SettlementRow>(
    `insert into settlement (
       group_id, from_member_id, to_member_id, amount_satang, status,
       claimed_by, claimed_via, confirmed_at, confirmed_by, confirmed_via, note
     ) values (
       $1, $2, $3, $4, $5,
       $2, $6,
       case when $7::boolean then now() else null end,
       case when $7::boolean then $3::uuid else null end,
       case when $7::boolean then $8::text else null end,
       $9
     )
     returning *`,
    [
      fixture.groupId,
      fixture.fromMemberId,
      fixture.toMemberId,
      fixture.amountSatang,
      status,
      fixture.claimedVia ?? 'liff',
      confirmed,
      fixture.confirmedVia ?? 'liff',
      fixture.note ?? null,
    ],
  )
  const row = rows[0]
  if (!row) throw new Error('makeSettlement: insert ไม่คืนแถว')
  return toSettlement(row)
}

// ─── เบ็ดเตล็ด ────────────────────────────────────────────────────────

function randomBytes32(): Buffer {
  return Buffer.from(randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), 'hex')
}
