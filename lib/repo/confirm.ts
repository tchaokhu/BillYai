/**
 * กดยืนยัน — **transaction เดียวที่แตะเงินจริงทั้งเส้น** (M6)
 *
 * ทุกอย่างเกิดตรงนี้ ไม่ใช่ตอนสร้าง draft (D30): วง, `app_user`, Member ของคนจ่าย,
 * Member ของทุกคนที่หารด้วย, บิล, และ share รายคน · ก่อนหน้านี้ตารางว่างเปล่า
 * สำหรับกลุ่มที่ยังไม่มีใครกดยืนยันอะไรเลย
 *
 * **`deleteDraft` เป็นด่านแรกใน transaction โดยตั้งใจ** — มันคือกลไกกันบิลลงซ้ำ
 * ทั้งหมด (ADR 0001): แถวเดียวกันถูกล็อกไว้ คนที่กดรัวหรือ retry ของ LINE จะลบ
 * ไม่โดนแล้วจบตรงนั้น ไม่ต้องมีโค้ดจำอะไรเพิ่ม
 *
 * **ยอดมาจาก `lines` ที่แช่ไว้ใน draft ไม่ได้คำนวณใหม่** — Roster โตได้ระหว่างที่
 * การ์ดค้างอยู่ในแชท คำนวณใหม่แปลว่าคนกดจากตัวเลขหนึ่งแล้วได้อีกตัวเลขลง ledger
 */

import type { PoolClient } from 'pg'
import { withTransaction } from '@/lib/db/client'
import { deleteDraft, findDraft } from './drafts'
import { commitExpense } from './expenses'
import {
  createPersonalGroup,
  ensureLineGroup,
  findActiveGroupByLineGroupId,
  findPersonalGroupByOwner,
} from './groups'
import {
  claimMember,
  ensureMember,
  ensureMembers,
  findMemberById,
  findMemberByLineUserId,
  findMemberByName,
} from './members'
import { ensureAppUserByLineUserId, findAppUserByLineUserId } from './users'
import type { MemberId } from '@/lib/types'

export interface ConfirmDraftInput {
  draftId: string
  /** คนที่กดปุ่ม — ต้องเป็นคนเดียวกับคนพิมพ์ (D26) */
  lineUserId: string
  /**
   * ตัวตนที่คนพิมพ์เลือกให้ตัวเอง — ใช้เฉพาะตอนเขายังไม่เคยยืนยันตัวตนในวงนี้
   * ถ้าเคยแล้ว Member ที่ claim ไว้ชนะเสมอ (ADR 0002)
   *
   * `member` = กดเลือกชื่อที่มีอยู่แล้วใน Roster · `new` = กด "ฉันเป็นคนใหม่"
   * แล้วใช้ชื่อจาก LINE
   */
  payer?: { kind: 'member'; memberId: string } | { kind: 'new'; displayName: string }
}

export type ConfirmDraftResult =
  /** ไม่เจอ draft, หมดอายุ, หรือมีคนกดไปแล้ว — ทั้งสามจบเหมือนกัน */
  | { kind: 'gone' }
  /** คนกดไม่ใช่คนพิมพ์ (D26) */
  | { kind: 'not-yours' }
  /** ชื่อที่เลือกเป็นของคนอื่นในวงนี้ไปแล้ว — เกิดได้เมื่อมีคนกดตัดหน้าใน 24 ชม. */
  | { kind: 'name-taken'; name: string }
  /** ยังไม่รู้ว่าเขาคือใครในวงนี้ และไม่ได้เลือกมาด้วย (D29) */
  | { kind: 'needs-identity' }
  | { kind: 'committed'; expenseId: string; description: string; totalSatang: number }

export async function confirmDraft(
  input: ConfirmDraftInput,
  tx?: PoolClient,
): Promise<ConfirmDraftResult> {
  if (tx === undefined) return withTransaction((client) => confirmDraft(input, client))

  const draft = await findDraft(input.draftId, tx)
  if (draft === null) return { kind: 'gone' }

  // ด่านนี้อยู่ที่นี่ด้วย ไม่ใช่แค่ที่ webhook — เส้นทางที่แตะเงินไม่ควรเชื่อว่า
  // ผู้เรียกตรวจมาแล้ว
  if (draft.lineUserId !== input.lineUserId) return { kind: 'not-yours' }

  /**
   * ตรวจชื่อ**ก่อนเขียนอะไรทั้งสิ้น**
   *
   * ถ้าปล่อยให้ไปเจอตอนหลัง การ `return` จะทำให้ transaction commit การลบ draft
   * ที่เกิดไปแล้ว = การ์ดหายทั้งที่บิลไม่ได้ลง · ด่านนี้อ่านอย่างเดียว วงที่ยังไม่มี
   * ก็ไม่มีชื่อให้ชนอยู่แล้ว
   */
  /**
   * หาวงแบบ**อ่านอย่างเดียว** — รวมวงส่วนตัวของแชท 1:1 ด้วย
   *
   * ตอนแรกเขียนไว้เฉพาะวงกลุ่ม ทำให้ด่านตรวจชื่อข้างล่างไม่ทำงานเลยใน 1:1
   *
   * **ใน Phase 1 ยังไม่มีทางที่ชื่อจะชนในวงส่วนตัว** เพราะเจ้าของถูก claim ตั้งแต่
   * บิลใบแรกที่สร้างวง และคนอื่นที่ทักมาใน 1:1 ก็ได้วงของตัวเอง · แต่ Phase 2.5
   * (D22) สร้างวงส่วนตัวผ่าน Owner Link ได้โดยยังไม่มี Member เลย ซึ่งเปิดช่องนั้น
   * ทันที · ด่านนี้จึงอยู่ตรงนี้ก่อน ไม่ใช่รอให้เจอตอนมีเงินอยู่ในวงแล้ว
   */
  const existingGroup = await (async () => {
    if (draft.lineGroupId !== null) {
      return findActiveGroupByLineGroupId(draft.lineGroupId, tx)
    }
    const owner = await findAppUserByLineUserId(input.lineUserId, tx)
    return owner === null ? null : findPersonalGroupByOwner(owner.id, tx)
  })()
  const alreadyMine =
    existingGroup === null
      ? null
      : await findMemberByLineUserId(existingGroup.id, input.lineUserId, tx)

  if (alreadyMine === null) {
    // ยังไม่รู้ว่าเขาคือใคร และไม่ได้เลือกมาด้วย — ไม่มีทางรู้ว่าใครเป็นคนจ่าย
    if (input.payer === undefined) return { kind: 'needs-identity' }

    if (existingGroup !== null) {
      const target =
        input.payer.kind === 'member'
          ? await findMemberById(input.payer.memberId, tx)
          : await findMemberByName(existingGroup.id, input.payer.displayName, tx)
      if (target !== null && (target.appUserId !== null || target.groupId !== existingGroup.id)) {
        return { kind: 'name-taken', name: target.displayName }
      }
    }
  }

  // ลบก่อนเขียนอย่างอื่น — แถวนี้คือตัวกันบิลลงซ้ำ
  if (!(await deleteDraft(input.draftId, tx))) return { kind: 'gone' }

  const appUser = await ensureAppUserByLineUserId(input.lineUserId, tx)

  const group =
    existingGroup ??
    (draft.lineGroupId === null
      ? await createPersonalGroup({ ownerId: appUser.id }, tx)
      : await ensureLineGroup(draft.lineGroupId, tx))

  const claimed = await findMemberByLineUserId(group.id, input.lineUserId, tx)
  let payerMemberId: MemberId
  if (claimed !== null) {
    payerMemberId = claimed.id
  } else {
    // ด่านข้างบนกันไว้แล้ว — ถ้ามาถึงตรงนี้โดยไม่มี payer แปลว่าโค้ดข้างบนเปลี่ยน
    if (input.payer === undefined) throw new Error('confirm: ไม่มีตัวตนของคนจ่าย')
    const member =
      input.payer.kind === 'member'
        ? await findMemberById(input.payer.memberId, tx)
        : await ensureMember(group.id, input.payer.displayName, tx)
    if (member === null || member.groupId !== group.id) {
      // id ที่ชี้ไปนอกวงนี้มาจากการ์ดของวงอื่นหรือจากค่าที่ค้างข้ามวง · **คืน `gone`
      // ไม่ใช่ throw** — throw จะกลายเป็น 500 แล้ว LINE ส่ง postback เดิมกลับมาให้
      // พังซ้ำไม่รู้จบ โดยที่คนกดไม่ได้รับข้อความอะไรเลยสักครั้ง
      return { kind: 'gone' }
    }
    if (member.appUserId !== null && member.appUserId !== appUser.id) {
      // `unique (group_id, display_name)` ทำให้ชื่อถูกจองไว้ตลอดไป (D18 ห้ามลบ
      // Member) — ต้องบอกให้ชัดว่าชื่อนี้มีเจ้าของแล้ว ไม่ใช่เขียนทับของคนอื่น
      return { kind: 'name-taken', name: member.displayName }
    }
    payerMemberId =
      member.appUserId === null ? (await claimMember(member.id, appUser.id, tx)).id : member.id
  }

  const otherNames = draft.lines.filter((line) => !line.isPayer).map((line) => line.name.trim())
  const others = await ensureMembers(group.id, otherNames, tx)
  const idOf = new Map(others.map((member) => [member.displayName, member.id]))

  /**
   * รวมแถวที่ตกกับคนเดียวกัน — `+ ข้าว 1200 กอล์ฟ รวมฉัน` ที่คนพิมพ์ก็ชื่อกอล์ฟ
   * จะได้สองแถวของคนเดียวกัน ซึ่ง `unique (expense_id, member_id)` ไม่ยอม
   *
   * บวกกันแทนที่จะทิ้งแถวหนึ่ง เพราะยอดรวมต้องเท่าเดิมเป๊ะ — invariant ของ
   * `expense_share` คิดจากยอดบิล ไม่ใช่จากจำนวนแถว
   */
  const amountOf = new Map<MemberId, number>()
  for (const line of draft.lines) {
    const memberId = line.isPayer ? payerMemberId : idOf.get(line.name.trim())
    if (memberId === undefined) {
      // เกิดได้เมื่อ payload เก่ามีชื่อที่ `ensureMembers` normalize ไปแล้ว — ตอบว่า
      // การ์ดใช้ไม่ได้ ดีกว่า 500 ที่ LINE จะยิงซ้ำไม่รู้จบ
      return { kind: 'gone' }
    }
    amountOf.set(memberId, (amountOf.get(memberId) ?? 0) + line.amountSatang)
  }

  const expense = await commitExpense(
    {
      groupId: group.id,
      description: draft.draft.description,
      totalSatang: draft.draft.totalSatang,
      surchargePct: draft.draft.surchargePct,
      payerMemberId,
      splitMode: draft.draft.mode,
      spentAt: draft.spentAt,
      createdBy: payerMemberId,
      source: 'rule',
      ...(draft.draft.eventTag === undefined ? {} : { eventTag: draft.draft.eventTag }),
      shares: [...amountOf].map(([memberId, amountSatang]) => ({ memberId, amountSatang })),
    },
    tx,
  )

  return {
    kind: 'committed',
    expenseId: expense.id,
    description: expense.description,
    totalSatang: expense.totalSatang,
  }
}
