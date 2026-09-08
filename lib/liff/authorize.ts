/**
 * ด่านสิทธิ์ร่วมของทุก route ใต้ `/api/liff` — **ใครกำลังขอ และการ์ดใบนี้ของเขาไหม**
 *
 * แยกออกมาเพราะทั้งการเปิดหน้าจอและการเซฟกลับต้องผ่านด่านเดียวกันเป๊ะ · เขียนสอง
 * ที่แปลว่าวันหนึ่งจะแก้ที่เดียว แล้วเส้นที่เหลือกลายเป็นทางเข้าที่ไม่มีใครเฝ้า
 *
 * ไม่รู้จัก Next, ไม่รู้จัก `process.env`, ไม่ต่อ DB — deps ฉีดเข้ามาหมด
 */

import { isUuid } from '@/lib/db/uuid'
import type { DraftRecord } from '@/lib/repo/drafts'
import type { VerifyLiffIdTokenResult } from '@/lib/line/liff'

/**
 * เหตุผลแยกละเอียดกว่าที่ HTTP ต้องใช้ **โดยตั้งใจ** — ชั้น route เป็นคนแปลงเป็น
 * status และเป็นคนตัดสินว่าจะบอกผู้ใช้แค่ไหน
 */
export type LiffFailure =
  | 'misconfigured'
  | 'bad-request'
  | 'unauthenticated'
  | 'draft-gone'
  | 'not-owner'
  /** ปลายทางที่เราพึ่งอยู่ตอบไม่ได้ — LINE หรือ Postgres ไม่ใช่คนที่กด */
  | 'upstream'

export interface AuthorizeDraftRequest {
  /** มาจาก JSON body ที่ client ส่ง — `unknown` เพราะยังไม่มีอะไรรับประกันรูป */
  idToken: unknown
  draftId: unknown
}

export interface AuthorizeDraftDeps {
  /** Channel ID ของ LINE Login channel · ว่าง = ยังไม่ได้ตั้ง env */
  channelId: string
  verifyIdToken: (idToken: string) => Promise<VerifyLiffIdTokenResult>
  findDraft: (id: string) => Promise<DraftRecord | null>
}

export type AuthorizeDraftResult =
  | { ok: true; record: DraftRecord }
  | { ok: false; reason: LiffFailure }

export async function authorizeDraft(
  request: AuthorizeDraftRequest,
  deps: AuthorizeDraftDeps,
): Promise<AuthorizeDraftResult> {
  /**
   * env ก่อนทุกอย่าง — ยิง verify ด้วย `client_id` ว่างจะได้ 400 กลับมา ซึ่งใน log
   * หน้าตาเหมือน token ปลอมเป๊ะ · แยกให้ออกตั้งแต่ที่นี่ ไม่ใช่ไปงมทีหลัง
   */
  if (deps.channelId === '') return { ok: false, reason: 'misconfigured' }

  const idToken = typeof request.idToken === 'string' ? request.idToken.trim() : ''
  if (idToken === '') return { ok: false, reason: 'bad-request' }

  /**
   * **ตรวจรูป `draftId` ก่อนถึง DB** — `findDraft` ยิง `where id = $1` ใส่คอลัมน์
   * uuid ตรงๆ ค่าที่ไม่ใช่ uuid จึงไม่ได้ "หาไม่เจอ" แต่ทำให้ Postgres โยน
   * `invalid input syntax for type uuid` ซึ่งกลายเป็น 500 ทุกครั้ง · endpoint
   * สาธารณะที่ 500 ได้ด้วยค่าที่ใครก็พิมพ์ได้คือเสียงรบกวนถาวรใน log
   */
  const draftId = typeof request.draftId === 'string' ? request.draftId.trim() : ''
  if (!isUuid(draftId)) return { ok: false, reason: 'bad-request' }

  /**
   * **`unreachable` ไม่ใช่ `unauthenticated`** — token อาจจะดีอยู่ก็ได้ เราแค่
   * ยังไม่รู้ · ตอบว่าเซสชันหมดอายุตอน LINE ล่มคือการส่งคนไปกดการ์ดใหม่วนเปล่าๆ
   */
  let verified: VerifyLiffIdTokenResult
  try {
    verified = await deps.verifyIdToken(idToken)
  } catch {
    // `verifyLiffIdToken` ไม่โยนอยู่แล้ว — ด่านนี้กันของที่ยังไม่มีในวันนี้
    return { ok: false, reason: 'upstream' }
  }
  if (!verified.ok) {
    return { ok: false, reason: verified.reason === 'unreachable' ? 'upstream' : 'unauthenticated' }
  }

  // แตะ DB **หลัง** รู้แล้วว่าเป็นใคร — คนที่ยังพิสูจน์ตัวไม่ได้ไม่ควรทำให้เรา query
  let record: DraftRecord | null
  try {
    record = await deps.findDraft(draftId)
  } catch {
    /**
     * Postgres ต่อไม่ได้ ≠ การ์ดหมดอายุ · ยุบเป็น `draft-gone` แปลว่าตอน DB ล่ม
     * เราจะบอกทุกคนว่าบิลของเขาหายไปแล้ว ซึ่งเป็นคำโกหกที่ทำให้เขาพิมพ์ใหม่ทั้งใบ
     */
    return { ok: false, reason: 'upstream' }
  }
  if (record === null) return { ok: false, reason: 'draft-gone' }

  /**
   * D26 — เจ้าของ draft คือคนที่พิมพ์ และเป็นคนเดียวที่แก้ได้ · เทียบ `line_user_id`
   * ตรงๆ ไม่ต้องแตะ `line_group_id` เลย: draft หนึ่งใบผูกกับคนพิมพ์อยู่แล้ว การ
   * ตรวจวงเพิ่มจึงไม่ได้กันอะไรที่ข้อนี้ยังไม่กัน และจะเปิดทางให้ต้องเชื่อ
   * `groupId` ที่ client ส่งมา ซึ่ง D46 ห้ามไว้
   */
  if (record.lineUserId !== verified.lineUserId) return { ok: false, reason: 'not-owner' }

  return { ok: true, record }
}
