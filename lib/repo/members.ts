/**
 * Roster — สมาชิกของวงหนึ่งวง (โมดูล B)
 *
 * Member เป็นของวง ไม่ใช่ของคน: กอล์ฟใน 3 วง = 3 แถว (D9) และคนที่ยังไม่มีใคร
 * claim คือ Placeholder ที่จดหนี้ให้ได้ทันทีโดยไม่ต้องรอเจ้าตัวทำอะไร (D4)
 *
 * ไฟล์นี้ไม่คิดเลขเงิน ไม่รู้จัก LINE และไม่รู้จัก HTTP — แปลง row เป็น record
 * ผ่าน mapper ใน `lib/db/rows.ts` อย่างเดียว
 */

import { getPool, type Queryable } from '@/lib/db/client'
import { toMember, type Member, type MemberRow } from '@/lib/db/rows'

/** ทุกฟังก์ชันรับ `db` เข้ามาได้ เพื่อให้ผู้เรียกลากเข้า transaction เดียวกันได้ */
function q(db?: Queryable): Queryable {
  return db ?? getPool()
}

/** คอลัมน์ที่ mapper ต้องการ — เขียนไว้ที่เดียวกัน query จะได้ไม่หลุดคอลัมน์ */
const COLUMNS = `id, group_id, display_name, app_user_id, claimed_at,
                 left_group_at, link_token_hash, link_token_at, created_at`

function firstOrNull(rows: readonly MemberRow[]): Member | null {
  const row = rows[0]
  return row ? toMember(row) : null
}

/** ฟังก์ชันที่แก้ข้อมูลต้องพังดังๆ เมื่อไม่เจอแถว ไม่ใช่คืน null เงียบๆ */
function requireRow(rows: readonly MemberRow[], memberId: string): Member {
  const row = rows[0]
  if (!row) throw new Error(`members: ไม่พบ member ${memberId}`)
  return toMember(row)
}

// ─── อ่าน ─────────────────────────────────────────────────────────────

export async function findMemberById(id: string, db?: Queryable): Promise<Member | null> {
  const { rows } = await q(db).query<MemberRow>(
    `select ${COLUMNS} from member where id = $1`,
    [id],
  )
  return firstOrNull(rows)
}

/**
 * เทียบชื่อแบบตรงเป๊ะภายในวงเดียว
 *
 * รวมคนที่ออกจากกลุ่มไปแล้วด้วย — `unique (group_id, display_name)` ไม่สนใจ
 * `left_group_at` ถ้าฟังก์ชันนี้กรองคนที่ออกไปแล้วทิ้ง ผู้เรียกจะสรุปว่า
 * "ชื่อนี้ว่าง" แล้วไป insert ชนกับแถวที่ยังอยู่
 */
export async function findMemberByName(
  groupId: string,
  displayName: string,
  db?: Queryable,
): Promise<Member | null> {
  const { rows } = await q(db).query<MemberRow>(
    `select ${COLUMNS} from member where group_id = $1 and display_name = $2`,
    [groupId, displayName],
  )
  return firstOrNull(rows)
}

/**
 * หา Member ของคนคนหนึ่งในวงหนึ่ง — `unique (group_id, app_user_id)` การันตีว่ามีได้แถวเดียว
 *
 * รวมคนที่ออกจากกลุ่มไปแล้วเช่นกัน: เขากลับมาพิมพ์ในกลุ่มเมื่อไหร่ต้องเจอตัวเดิม
 * พร้อมหนี้เดิม ไม่ใช่ถูกสร้างใหม่เป็นคนที่สอง
 */
/**
 * คนพิมพ์คือ Member ตัวไหนในวงนี้ — join ผ่าน `app_user.line_user_id`
 *
 * `null` แปลว่า **เขายังไม่เคยยืนยันตัวตนในวงนี้** ซึ่งเป็นสัญญาณที่ D29 ใช้ตัดสิน
 * ว่าการ์ด Draft ใบนี้ต้องมีแถวเลือกตัวตนหรือไม่
 *
 * ถามด้วย `line_user_id` ไม่ใช่ `app_user_id` เพราะ webhook ให้มาแค่ตัวแรก และ
 * การให้ผู้เรียกไปหา `app_user` เองก่อนจะทำให้ต้องสร้างแถว `app_user` ทิ้งไว้
 * สำหรับคนที่ยังไม่ได้ยืนยันอะไรเลย ซึ่งขัด D30
 */
export async function findMemberByLineUserId(
  groupId: string,
  lineUserId: string,
  db?: Queryable,
): Promise<Member | null> {
  const { rows } = await q(db).query<MemberRow>(
    `select ${COLUMNS.split(',').map((c) => `m.${c.trim()}`).join(', ')}
       from member m
       join app_user u on u.id = m.app_user_id
      where m.group_id = $1 and u.line_user_id = $2`,
    [groupId, lineUserId],
  )
  return firstOrNull(rows)
}

export async function findMemberByAppUser(
  groupId: string,
  appUserId: string,
  db?: Queryable,
): Promise<Member | null> {
  const { rows } = await q(db).query<MemberRow>(
    `select ${COLUMNS} from member where group_id = $1 and app_user_id = $2`,
    [groupId, appUserId],
  )
  return firstOrNull(rows)
}

/**
 * Roster ปัจจุบันของวง — คำว่า "ทุกคน" ในทุกคำสั่งหมายถึงผลของฟังก์ชันนี้
 *
 * เรียง `created_at asc` แล้ว `id asc`: ลำดับตามการโตของ Roster ซึ่งเป็นลำดับ
 * ที่คนในวงเห็นชื่อโผล่มาจริงๆ. tie-break ด้วย `id` ไม่ใช่ของประดับ —
 * `ensureMembers` insert ทั้งก้อนใน statement เดียว ทุกแถวจึงได้ `now()`
 * ค่าเดียวกันเป๊ะ ถ้าไม่มีเกณฑ์ที่สอง การ์ดในกลุ่มจะสลับชื่อเองระหว่าง refresh
 *
 * ไม่เรียงตามชื่อเพราะลำดับจะขึ้นกับ collation ของ DB ที่ deploy จริง
 */
export async function listMembers(
  groupId: string,
  options?: { includeLeft?: boolean },
  db?: Queryable,
): Promise<Member[]> {
  const { rows } = await q(db).query<MemberRow>(
    `select ${COLUMNS} from member
     where group_id = $1
       and ($2::boolean or left_group_at is null)
     order by created_at asc, id asc`,
    [groupId, options?.includeLeft ?? false],
  )
  return rows.map(toMember)
}

/** หาเจ้าของ Nudge Link — token ตัวจริงไม่เคยถูกเก็บ เทียบกันที่ hash เท่านั้น (D20) */
export async function findMemberByLinkTokenHash(
  hash: Buffer,
  db?: Queryable,
): Promise<Member | null> {
  const { rows } = await q(db).query<MemberRow>(
    `select ${COLUMNS} from member where link_token_hash = $1`,
    [hash],
  )
  return firstOrNull(rows)
}

// ─── Roster ที่โตเอง (D16) ────────────────────────────────────────────

/**
 * ชื่อว่างหรือช่องว่างล้วนสร้างไม่ได้
 *
 * member แบบนั้นเป็นผู้จ่ายได้ ถือหนี้ได้ แต่เรียกชื่อในแชทไม่ได้ และมันจอง
 * สล็อต `unique (group_id, display_name)` ของสตริงนั้นไว้ถาวร — คนถัดไปที่พิมพ์
 * ผิดแบบเดียวกันจะได้ member ตัวเดิมที่ไม่มีใครรู้ว่าเป็นใคร
 *
 * ไม่ `trim` ให้เอง: ` กอล์ฟ ` กับ `กอล์ฟ` เป็นคนละแถวมาแต่ต้นตาม unique index
 * การเริ่ม trim ตอนนี้จะทำให้ชื่อที่มีอยู่แล้วชนกันเงียบๆ — เป็นการย้าย Roster
 * ที่ต้องมี migration ไม่ใช่ผลข้างเคียงของการกันชื่อว่าง
 */
function assertDisplayName(displayName: string): void {
  if (displayName.trim() === '') {
    throw new Error('ชื่อสมาชิกว่างไม่ได้')
  }
}

/**
 * ขอ Member ด้วยชื่อ — ไม่มีก็สร้าง Placeholder ให้ มีแล้วคืนตัวเดิม
 *
 * **ทำไมเป็น `on conflict` ไม่ใช่ select-then-insert:** ชื่อเดียวกันมาถึงพร้อมกัน
 * ได้จริง — บิลใบเดียวมีชื่อซ้ำ, webhook ยิงซ้ำ, สองคนพิมพ์ชื่อเพื่อนคนเดียวกัน
 * คนละข้อความ. ระหว่าง select กับ insert มีช่องให้ transaction อื่นแทรกได้เสมอ
 * ผลคือ unique violation หลุดขึ้นไปถึงผู้ใช้ในจังหวะที่สุ่มมาก
 *
 * ใช้ `do update` แทน `do nothing` เพราะ `do nothing` ไม่คืนแถวที่ชน — จะต้อง
 * select ตามอีกรอบ ซึ่งพาช่องแข่งกันกลับมาที่เดิม. การ set ทับด้วยค่าเดิม
 * ทำให้ `returning` คืนแถวจริงเสมอไม่ว่าจะชนะการแข่งหรือแพ้
 */
export async function ensureMember(
  groupId: string,
  displayName: string,
  db?: Queryable,
): Promise<Member> {
  assertDisplayName(displayName)
  const { rows } = await q(db).query<MemberRow>(
    `insert into member (group_id, display_name)
     values ($1, $2)
     on conflict (group_id, display_name)
       do update set display_name = excluded.display_name
     returning ${COLUMNS}`,
    [groupId, displayName],
  )
  const row = rows[0]
  if (!row) throw new Error(`members: ensureMember ไม่คืนแถวสำหรับ "${displayName}"`)
  return toMember(row)
}

/**
 * ขอหลายชื่อพร้อมกัน — ผลเรียงตาม input เสมอ เพราะผู้เรียกใช้ index จับคู่กับ
 * รายชื่อที่ผู้ใช้พิมพ์ (`+ ข้าว 1200 กอล์ฟ บาส เมย์`)
 *
 * ต้อง dedupe ก่อน: `on conflict do update` แตะแถวเดิมสองครั้งใน statement เดียว
 * ไม่ได้ Postgres จะโยน "cannot affect row a second time" ทันที. ชื่อซ้ำใน input
 * จึงคืน Member ตัวเดียวกันซ้ำตำแหน่ง ไม่ใช่สร้างสองแถว
 */
export async function ensureMembers(
  groupId: string,
  displayNames: readonly string[],
  db?: Queryable,
): Promise<Member[]> {
  if (displayNames.length === 0) return []
  // ตรวจให้ครบทั้งชุดก่อนยิง — ชื่อเสียตัวเดียวต้องไม่ทิ้งคนอื่นที่สร้างไปแล้วไว้
  for (const name of displayNames) assertDisplayName(name)

  // เรียงก่อนยิงเพื่อกัน deadlock: `on conflict do update` ล็อกแถวที่ชนตามลำดับ
  // ใน array — สองสายที่ส่งชื่อชุดเดียวกันมาคนละลำดับจะล็อกไขว้กันแล้วโดน 40P01
  // ทิ้งไปหนึ่งสาย. เรียงด้วย code unit ไม่ใช่ `localeCompare` เพราะสิ่งที่ต้องการ
  // คือทุกสายเรียงเหมือนกันเป๊ะ ไม่ใช่เรียงถูกตามภาษา
  const unique = [...new Set(displayNames)].sort()
  const { rows } = await q(db).query<MemberRow>(
    `insert into member (group_id, display_name)
     select $1, name from unnest($2::text[]) as name
     on conflict (group_id, display_name)
       do update set display_name = excluded.display_name
     returning ${COLUMNS}`,
    [groupId, unique],
  )

  const byName = new Map(rows.map((row) => [row.display_name, toMember(row)]))
  return displayNames.map((name) => {
    const member = byName.get(name)
    if (!member) throw new Error(`members: ensureMembers ไม่คืนแถวสำหรับ "${name}"`)
    return member
  })
}

// ─── claim (D4, D10) ──────────────────────────────────────────────────

/**
 * ประกาศว่า App User คนนี้คือ Placeholder ตัวนี้
 *
 * `where app_user_id is null` คือด่านที่กันการแย่ง Placeholder ที่มีเจ้าของแล้ว
 * ส่วนกฎ "หนึ่งคนถือได้ member เดียวต่อวง" ปล่อยให้ `unique (group_id, app_user_id)`
 * เป็นคนกัน — **ตั้งใจไม่ select เช็คก่อน** เพราะการเช็คด้วยโค้ดคือ TOCTOU:
 * สองคำขอที่มาพร้อมกันผ่าน select ทั้งคู่แล้วไปชนกันที่ index อยู่ดี
 * error ที่หลุดขึ้นไปจึงเป็น DatabaseError code 23505 ตามจริง ไม่ถูกห่อทับ
 */
export async function claimMember(
  memberId: string,
  appUserId: string,
  db?: Queryable,
): Promise<Member> {
  const conn = q(db)
  const { rows } = await conn.query<MemberRow>(
    `update member
        set app_user_id = $2, claimed_at = now()
      where id = $1 and app_user_id is null
      returning ${COLUMNS}`,
    [memberId, appUserId],
  )
  const row = rows[0]
  if (row) return toMember(row)

  // ไม่มีแถวกลับมาได้สองสาเหตุ แยกให้ผู้เรียกรู้ว่าควรบอกผู้ใช้ว่าอะไร
  const existing = await findMemberById(memberId, conn)
  if (!existing) throw new Error(`members: ไม่พบ member ${memberId}`)
  throw new Error(
    `members: member ${memberId} ถูก claim ไปแล้วโดย app_user ${existing.appUserId}`,
  )
}

// ─── ออกจากกลุ่ม / กลับเข้ากลุ่ม (D18) ────────────────────────────────

/**
 * มาร์กว่าออกจากกลุ่ม — **ไม่ลบแถว** เพราะหนี้ค้างของเขาต้องยังโผล่ในยอด
 *
 * `coalesce` ทำให้มาร์กซ้ำไม่เลื่อนเวลา: webhook `leave`/`kick` ยิงซ้ำได้
 * และวันที่ออกเป็นข้อมูลที่ Escalation ใช้ ไม่ควรถูกรีเซ็ตโดยการยิงซ้ำ
 */
export async function markMemberLeft(memberId: string, db?: Queryable): Promise<Member> {
  const { rows } = await q(db).query<MemberRow>(
    `update member set left_group_at = coalesce(left_group_at, now())
      where id = $1
      returning ${COLUMNS}`,
    [memberId],
  )
  return requireRow(rows, memberId)
}

/** กลับเข้ากลุ่ม — ล้างมาร์กทิ้ง หนี้และประวัติทั้งหมดยังเป็นของแถวเดิม */
export async function markMemberRejoined(
  memberId: string,
  db?: Queryable,
): Promise<Member> {
  const { rows } = await q(db).query<MemberRow>(
    `update member set left_group_at = null
      where id = $1
      returning ${COLUMNS}`,
    [memberId],
  )
  return requireRow(rows, memberId)
}

// ─── Nudge token (D20) ────────────────────────────────────────────────

/**
 * ออก Nudge Link token ใหม่ให้ member หนึ่งคน — รับมาแต่ sha256 ไม่เคยเห็นตัวจริง
 *
 * การเขียนทับคือกลไก revoke ทั้งหมดของ D20: หนึ่ง member มี hash ได้อันเดียว
 * ออกใหม่แล้วอันเก่าหาไม่เจอทันทีโดยไม่ต้องมีตาราง blacklist ให้ดูแล
 */
export async function issueNudgeToken(
  memberId: string,
  tokenHash: Buffer,
  db?: Queryable,
): Promise<Member> {
  const { rows } = await q(db).query<MemberRow>(
    `update member set link_token_hash = $2, link_token_at = now()
      where id = $1
      returning ${COLUMNS}`,
    [memberId, tokenHash],
  )
  return requireRow(rows, memberId)
}
