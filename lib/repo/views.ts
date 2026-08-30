/**
 * มุมมองที่ webhook ต้องใช้ — ประกอบจาก repo หลายตัวให้จบใน call เดียว
 *
 * อยู่ที่นี่ไม่ใช่ใน route เพราะ route เป็น**สายไฟอย่างเดียว** และของที่อยู่ในนั้น
 * เทสต์ไม่ได้โดยไม่ยก Next.js ขึ้นมาทั้งตัว
 *
 * **ไม่มีสูตรหนี้ในไฟล์นี้และห้ามมี** (D25) — `computeDebts` คิดให้แล้ว ที่นี่แค่
 * โหลดแถวกับแปลง id เป็นชื่อ
 */

import { computeDebts } from '@/lib/debt'
import { buildBalance, type BalanceView } from '@/lib/flow/balance'
import type { GroupView } from '@/lib/line/webhook'
import { findActiveGroupByLineGroupId, findPersonalGroupByOwner } from './groups'
import { loadLedger } from './ledger'
import { findMemberByLineUserId, listMembers } from './members'
import { findAppUserByLineUserId } from './users'
import type { LedgerGroup } from '@/lib/db/rows'

/**
 * วงที่ข้อความนี้อยู่ — `null` เมื่อยังไม่มี
 *
 * แชท 1:1 มีวงของมันเหมือนกัน: วงส่วนตัวของคนที่คุยอยู่ (D21) · ลืมข้อนี้แปลว่า
 * คนที่จดบิลใน 1:1 มาสิบใบแล้วยังถูกถามตัวตนใหม่ทุกครั้ง
 *
 * ไม่มีวง = ยังไม่มีใครกดยืนยันบิลสักใบ (D30) ซึ่งเป็นกรณีที่พบบ่อยที่สุด
 */
async function resolveGroup(
  lineGroupId: string | null,
  lineUserId: string,
): Promise<LedgerGroup | null> {
  if (lineGroupId !== null) return findActiveGroupByLineGroupId(lineGroupId)
  const owner = await findAppUserByLineUserId(lineUserId)
  return owner === null ? null : findPersonalGroupByOwner(owner.id)
}

/** ทุกอย่างที่ต้องรู้เพื่อวาดการ์ด Draft หนึ่งใบ — **อ่านอย่างเดียว** (D28) */
export async function loadGroupView(
  lineGroupId: string | null,
  lineUserId: string,
): Promise<GroupView> {
  const empty: GroupView = { roster: [], payerName: null, unclaimed: [] }
  const group = await resolveGroup(lineGroupId, lineUserId)
  if (group === null) return empty

  const members = await listMembers(group.id)
  const payer = await findMemberByLineUserId(group.id, lineUserId)
  return {
    roster: members.map((member) => member.displayName),
    payerName: payer?.displayName ?? null,
    /**
     * คนที่ถูก claim ไปแล้วไม่ใช่ตัวเลือก — เขามีเจ้าของอยู่แล้ว
     *
     * เรียง**ใหม่ก่อน** เพราะ quick reply ใส่ได้ 12 ชื่อ · คนที่กำลังจะเลือกชื่อ
     * ตัวเองมักเป็นคนที่เพิ่งถูกพิมพ์ชื่อเข้ามาในบิลไม่กี่ใบก่อนหน้า ไม่ใช่คนที่อยู่
     * ในวงมาตั้งแต่แรก · **ยังไม่แก้กรณีวงที่มีคนยังไม่ claim เกิน 12 คนได้ทั้งหมด**
     * — ดูของค้างท้าย `docs/PLAN-M6.md`
     */
    unclaimed: members
      .filter((member) => member.appUserId === null)
      .reverse()
      .map((member) => ({ id: member.id, name: member.displayName })),
  }
}

/**
 * ยอดค้างทั้งวง — `'no-bills'` เมื่อวงยังไม่มีบิลสักใบ
 *
 * แยก `'no-bills'` ออกจาก "ไม่มีใครติดใคร" เพราะสองอย่างนี้ตอบคนละแบบ: วงที่ยังไม่
 * เคยจดบิลตอบไกด์ (`DESIGN.md` §3) ส่วนวงที่เคลียร์กันหมดแล้วต้องบอกตรงๆ
 */
export async function loadBalance(
  lineGroupId: string | null,
  lineUserId: string,
): Promise<BalanceView | 'no-bills'> {
  const group = await resolveGroup(lineGroupId, lineUserId)
  if (group === null) return 'no-bills'

  const ledger = await loadLedger(group.id)
  if (ledger.expenses.length === 0) return 'no-bills'

  /**
   * **`includeLeft: true`** — คนที่ออกจากกลุ่มไปแล้วต้องยังมีชื่ออยู่ในยอด
   *
   * `member` ไม่เคยถูกลบ (D18) และ `computeDebts` ก็ยังคืนหนี้ของเขามาด้วย · ถ้า
   * name map ไม่มีชื่อเขา `buildBalance` จะข้ามแถวนั้นทิ้ง แล้วยอดจะขาดหายไปเงียบๆ
   * — ถ้าเป็นหนี้ก้อนสุดท้ายบอทจะตอบว่า "ไม่มีใครติดใครแล้ว" ทั้งที่เงินยังค้างอยู่
   */
  const members = await listMembers(group.id, { includeLeft: true })
  const names = new Map(members.map((member) => [member.id, member.displayName]))
  return buildBalance(computeDebts(ledger.expenses, ledger.settlements), names)
}
