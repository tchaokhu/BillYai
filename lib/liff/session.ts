/**
 * เปิด session ของหน้าจอ LIFF — อ่าน draft ใบหนึ่งมาวาดหน้าจอ
 *
 * ด่านสิทธิ์อยู่ใน `authorizeDraft` ซึ่งใช้ร่วมกับเส้นเซฟ · ไฟล์นี้เหลือแค่ "แล้ว
 * หน้าจอต้องได้อะไรกลับไปบ้าง"
 *
 * **อ่านอย่างเดียว** — D30 ให้เขียน ledger ตอนกดยืนยันในแชทเท่านั้น และการเซฟ
 * รายการรายชิ้นกลับลง draft เป็นเส้นทางแยก (`lib/liff/save.ts`)
 */

import { authorizeDraft } from './authorize'
import type { AuthorizeDraftDeps, AuthorizeDraftRequest, LiffFailure } from './authorize'
import type { DraftRecord } from '@/lib/repo/drafts'
import type { DraftLine, ExpenseDraft } from '@/lib/types'

export type OpenLiffSessionRequest = AuthorizeDraftRequest

export interface OpenLiffSessionDeps extends AuthorizeDraftDeps {
  /**
   * ชื่อทุกคนที่วงรู้จัก — ปุ่ม `+ เพิ่มคน` บนหน้าจอเลือกจากรายการนี้ (D55)
   *
   * ดึงรายชื่อสมาชิกกลุ่มจาก LINE ไม่ได้ (C1) DB ของเราจึงเป็นแหล่งเดียว · วงที่
   * ยังไม่มีใครกดยืนยันสักใบยังไม่มีวงในตารางเลย (D30) — ได้ list ว่าง ไม่ใช่ error
   */
  loadRoster: (draft: DraftRecord) => Promise<readonly string[]>
}

/** ของที่หน้าจอต้องใช้วาด — ไม่มี id ของ LINE อยู่ในนี้เลย (D15) */
export interface LiffSession {
  id: string
  draft: ExpenseDraft
  lines: DraftLine[]
  spentAt: string
  /** ชื่อที่วงรู้จักแล้ว — ตัวเลือกของปุ่ม `+ เพิ่มคน` (D55) */
  roster: readonly string[]
}

export type OpenLiffSessionResult =
  | { ok: true; session: LiffSession }
  | { ok: false; reason: LiffFailure }

export async function openLiffSession(
  request: OpenLiffSessionRequest,
  deps: OpenLiffSessionDeps,
): Promise<OpenLiffSessionResult> {
  const authorized = await authorizeDraft(request, deps)
  if (!authorized.ok) return authorized

  const record = authorized.record
  let roster: readonly string[]
  try {
    roster = await deps.loadRoster(record)
  } catch {
    return { ok: false, reason: 'upstream' }
  }

  return {
    ok: true,
    session: {
      id: record.id,
      draft: record.draft,
      lines: record.lines,
      spentAt: record.spentAt,
      roster,
    },
  }
}
