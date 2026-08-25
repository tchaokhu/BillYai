/**
 * ตัวจับ schema drift — ไล่ตรวจว่า DB ที่ migration สร้าง ตรงกับ
 * `docs/DESIGN.md` §4 บวกส่วนที่ `docs/PLAN-M2.md` ระบุว่าเติม
 *
 * เทสต์ชุดนี้ไม่ผ่าน repository เลย ถามจาก `information_schema`/`pg_catalog` ตรงๆ
 * ถ้ามันแดงแปลว่า **migration กับเอกสารไม่ตรงกันแล้ว** ไม่ใช่เทสต์พัง —
 * ตัดสินว่าอันไหนถูกก่อน แล้วแก้อีกอันให้ตาม ห้ามผ่อนเกณฑ์ที่นี่
 */

import { afterAll, describe, expect, it } from 'vitest'
import { closePool, getPool } from '@/lib/db/client'

afterAll(async () => {
  await closePool()
})

async function rows<T extends Record<string, unknown>>(
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(sql, values)
  return result.rows
}

describe('ตาราง', () => {
  it('มีครบทุกตารางที่ design ระบุ และไม่มีตารางส่วนเกิน', async () => {
    const found = await rows<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'
       order by table_name`,
    )
    expect(found.map(r => r.table_name)).toEqual([
      'app_user',
      'audit_log',
      'expense',
      'expense_item',
      'expense_item_share',
      'expense_share',
      'ledger_group',
      'llm_usage',
      'member',
      'settlement',
    ])
  })
})

/** ชนิดตาม `information_schema.columns.data_type` และ `is_nullable` */
type ColumnSpec = readonly [name: string, dataType: string, nullable: boolean]

const COLUMNS: Record<string, readonly ColumnSpec[]> = {
  app_user: [
    ['created_at', 'timestamp with time zone', false],
    ['id', 'uuid', false],
    ['is_oa_friend', 'boolean', false],
    ['line_user_id', 'text', true],
    ['policy_accepted_at', 'timestamp with time zone', true],
    ['promptpay_cipher', 'bytea', true],
    ['promptpay_last4', 'text', true],
  ],
  ledger_group: [
    ['created_at', 'timestamp with time zone', false],
    ['deleted_at', 'timestamp with time zone', true],
    ['id', 'uuid', false],
    ['kind', 'text', false],
    ['line_group_id', 'text', true],
    ['owner_id', 'uuid', true],
    ['owner_token_at', 'timestamp with time zone', true],
    ['owner_token_hash', 'bytea', true],
    ['status', 'text', false],
  ],
  member: [
    ['app_user_id', 'uuid', true],
    ['claimed_at', 'timestamp with time zone', true],
    ['created_at', 'timestamp with time zone', false],
    ['display_name', 'text', false],
    ['group_id', 'uuid', false],
    ['id', 'uuid', false],
    ['left_group_at', 'timestamp with time zone', true],
    ['link_token_at', 'timestamp with time zone', true],
    ['link_token_hash', 'bytea', true],
  ],
  expense: [
    ['created_at', 'timestamp with time zone', false],
    ['created_by', 'uuid', false],
    ['description', 'text', false],
    ['event_tag', 'text', true],
    ['group_id', 'uuid', false],
    ['id', 'uuid', false],
    ['payer_member_id', 'uuid', false],
    ['source', 'text', false],
    ['spent_at', 'date', false],
    ['split_mode', 'text', false],
    ['status', 'text', false],
    ['surcharge_pct', 'numeric', false],
    // เงินเป็น bigint สตางค์ ไม่ใช่ numeric ไม่ใช่ integer
    ['total_satang', 'bigint', false],
    // ไม่มี `voided_by` — ตรวจว่าคนยกเลิกอยู่วงเดียวกับบิลไม่ได้จาก FK ของ
    // `member(id)` (มันการันตีแค่ว่ามีตัวตน) และ audit ตาม D11 คือข้อความที่บอท
    // ประกาศกลับเข้ากลุ่มตอนยกเลิก ไม่ใช่คอลัมน์นี้
    ['voided_at', 'timestamp with time zone', true],
  ],
  expense_share: [
    ['amount_satang', 'bigint', false],
    ['expense_id', 'uuid', false],
    ['id', 'uuid', false],
    ['member_id', 'uuid', false],
    ['weight', 'numeric', true],
  ],
  expense_item: [
    ['amount_satang', 'bigint', false],
    ['expense_id', 'uuid', false],
    ['id', 'uuid', false],
    ['name', 'text', false],
  ],
  expense_item_share: [
    ['item_id', 'uuid', false],
    ['member_id', 'uuid', false],
    ['weight', 'numeric', false],
  ],
  settlement: [
    ['amount_satang', 'bigint', false],
    ['claimed_at', 'timestamp with time zone', false],
    ['claimed_by', 'uuid', true],
    ['claimed_via', 'text', false],
    ['confirmed_at', 'timestamp with time zone', true],
    ['confirmed_by', 'uuid', true],
    ['confirmed_via', 'text', true],
    ['from_member_id', 'uuid', false],
    ['group_id', 'uuid', false],
    ['id', 'uuid', false],
    ['note', 'text', true],
    ['status', 'text', false],
    ['to_member_id', 'uuid', false],
  ],
  audit_log: [
    ['action', 'text', false],
    ['actor', 'uuid', true],
    ['actor_via', 'text', false],
    ['after', 'jsonb', true],
    ['before', 'jsonb', true],
    ['created_at', 'timestamp with time zone', false],
    ['group_id', 'uuid', true],
    ['id', 'bigint', false],
    ['target_id', 'uuid', true],
    ['target_type', 'text', false],
  ],
  llm_usage: [
    ['app_user_id', 'uuid', true],
    ['created_at', 'timestamp with time zone', false],
    ['group_id', 'uuid', true],
    ['id', 'bigint', false],
    ['input_tokens', 'integer', false],
    ['output_tokens', 'integer', false],
  ],
}

describe('คอลัมน์', () => {
  for (const [table, expected] of Object.entries(COLUMNS)) {
    it(`${table} มีคอลัมน์ ชนิด และ nullability ตรงตาม design`, async () => {
      const found = await rows<{
        column_name: string
        data_type: string
        is_nullable: string
      }>(
        `select column_name, data_type, is_nullable
         from information_schema.columns
         where table_schema = 'public' and table_name = $1
         order by column_name`,
        [table],
      )
      const actual: ColumnSpec[] = found.map(r => [
        r.column_name,
        r.data_type,
        r.is_nullable === 'YES',
      ])
      expect(actual).toEqual([...expected])
    })
  }
})

describe('ความละเอียดของ numeric', () => {
  it('surcharge_pct เป็น numeric(5,2) และ weight เป็น numeric(8,3)', async () => {
    const found = await rows<{
      table_name: string
      column_name: string
      numeric_precision: number
      numeric_scale: number
    }>(
      `select table_name, column_name, numeric_precision, numeric_scale
       from information_schema.columns
       where table_schema = 'public' and data_type = 'numeric'
       order by table_name, column_name`,
    )
    expect(found).toEqual([
      { table_name: 'expense', column_name: 'surcharge_pct', numeric_precision: 5, numeric_scale: 2 },
      { table_name: 'expense_item_share', column_name: 'weight', numeric_precision: 8, numeric_scale: 3 },
      { table_name: 'expense_share', column_name: 'weight', numeric_precision: 8, numeric_scale: 3 },
    ])
  })
})

describe('check constraint', () => {
  it('มีครบทุกตัวที่ design และแผนระบุ', async () => {
    const found = await rows<{ conname: string }>(
      `select c.conname
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
       join pg_namespace n on n.oid = t.relnamespace
       where n.nspname = 'public' and c.contype = 'c'
       order by c.conname`,
    )
    const names = found.map(r => r.conname)

    // enum ทุกตัวถูกบังคับที่ DB ไม่ใช่แค่ในโค้ด
    expect(names).toContain('member_display_name_check')
    expect(names).toContain('ledger_group_kind_check')
    expect(names).toContain('ledger_group_status_check')
    expect(names).toContain('expense_split_mode_check')
    expect(names).toContain('expense_source_check')
    expect(names).toContain('expense_status_check')
    expect(names).toContain('settlement_status_check')
    expect(names).toContain('settlement_claimed_via_check')
    expect(names).toContain('settlement_confirmed_via_check')
    expect(names).toContain('audit_log_actor_via_check')

    // วงส่วนตัวต้องมีทางเข้าอย่างน้อยหนึ่งทาง (D21/D22)
    expect(names).toContain('ledger_group_identity_check')

    // ช่วงค่า
    expect(names).toContain('expense_surcharge_pct_check')
    expect(names).toContain('expense_share_weight_check')
  })

  it('บังคับใช้จริง ไม่ใช่แค่ประกาศไว้', async () => {
    const group = await rows<{ id: string }>(
      `insert into ledger_group (kind, line_group_id)
       values ('line_group', 'C-schema-check-' || gen_random_uuid())
       returning id`,
    )
    const groupId = group[0]?.id
    expect(groupId).toBeDefined()

    // kind นอกรายการ
    await expect(
      rows(`insert into ledger_group (kind, line_group_id) values ('slack', 'x')`),
    ).rejects.toThrow()

    // วงส่วนตัวที่ไม่มีทั้ง owner_id และ owner_token_hash = เข้าไม่ถึงตลอดกาล
    await expect(
      rows(`insert into ledger_group (kind) values ('personal')`),
    ).rejects.toThrow()

    // surcharge เกิน 100%
    const member = await rows<{ id: string }>(
      `insert into member (group_id, display_name) values ($1, 'ก') returning id`,
      [groupId],
    )
    const memberId = member[0]?.id
    await expect(
      rows(
        `insert into expense (group_id, description, total_satang, surcharge_pct,
                              payer_member_id, split_mode, spent_at, created_by, source)
         values ($1, 'x', 100, 101, $2, 'equal', '2026-01-01', $2, 'rule')`,
        [groupId, memberId],
      ),
    ).rejects.toThrow()

    // settlement ที่ชี้หาตัวเอง
    await expect(
      rows(
        `insert into settlement (group_id, from_member_id, to_member_id, amount_satang)
         values ($1, $2, $2, 100)`,
        [groupId, memberId],
      ),
    ).rejects.toThrow()
  })
})

describe('unique', () => {
  it('มี unique ทุกตัวที่ design ระบุ', async () => {
    const found = await rows<{ indexname: string }>(
      `select indexname from pg_indexes
       where schemaname = 'public' order by indexname`,
    )
    const names = found.map(r => r.indexname)

    expect(names).toContain('ledger_group_line_group_id_key')
    expect(names).toContain('app_user_line_user_id_key')
    expect(names).toContain('member_group_id_display_name_key')
    expect(names).toContain('member_group_id_app_user_id_key')
    expect(names).toContain('expense_share_expense_id_member_id_key')
    // token ชนกันต้องพังตอน insert ไม่ใช่ตอนใช้
    expect(names).toContain('ledger_group_owner_token_hash_key')
    expect(names).toContain('member_link_token_hash_key')
  })

  it('ยอมให้ Placeholder หลายคนอยู่ในวงเดียวกันได้ แม้ app_user_id เป็น null ทั้งคู่', async () => {
    const group = await rows<{ id: string }>(
      `insert into ledger_group (kind, line_group_id)
       values ('line_group', 'C-null-uniq-' || gen_random_uuid())
       returning id`,
    )
    const groupId = group[0]?.id
    await rows(`insert into member (group_id, display_name) values ($1, 'กอล์ฟ')`, [groupId])
    await rows(`insert into member (group_id, display_name) values ($1, 'เบียร์')`, [groupId])

    const count = await rows<{ n: number }>(
      `select count(*)::int as n from member where group_id = $1`,
      [groupId],
    )
    expect(count[0]?.n).toBe(2)
  })
})

describe('index ที่แผนระบุว่าต้องมีเพื่อไม่ให้ query โตแล้วช้า', () => {
  it('ครบ', async () => {
    const found = await rows<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public'`,
    )
    const names = found.map(r => r.indexname)
    expect(names).toContain('expense_group_status_spent_at_idx')
    expect(names).toContain('expense_payer_member_id_idx')
    expect(names).toContain('expense_share_member_id_idx')
    expect(names).toContain('member_app_user_id_idx')
    expect(names).toContain('settlement_group_status_idx')
    expect(names).toContain('llm_usage_created_at_idx')
  })
})

describe('foreign key', () => {
  it('cascade เฉพาะที่ตั้งใจ — ข้อมูลของวงตายพร้อมวง แต่ member ลบไม่ได้ถ้ายังมีหนี้อ้างอยู่', async () => {
    const found = await rows<{ table_name: string; column_name: string; delete_rule: string }>(
      `select tc.table_name, kcu.column_name, rc.delete_rule
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on kcu.constraint_name = tc.constraint_name
        and kcu.table_schema = tc.table_schema
       join information_schema.referential_constraints rc
         on rc.constraint_name = tc.constraint_name
        and rc.constraint_schema = tc.table_schema
       where tc.table_schema = 'public' and tc.constraint_type = 'FOREIGN KEY'
       order by tc.table_name, kcu.column_name`,
    )
    const rule = (table: string, column: string): string | undefined =>
      found.find(r => r.table_name === table && r.column_name === column)?.delete_rule

    expect(rule('member', 'group_id')).toBe('CASCADE')
    expect(rule('expense', 'group_id')).toBe('CASCADE')
    expect(rule('expense_share', 'expense_id')).toBe('CASCADE')
    expect(rule('expense_item', 'expense_id')).toBe('CASCADE')
    expect(rule('expense_item_share', 'item_id')).toBe('CASCADE')
    expect(rule('settlement', 'group_id')).toBe('CASCADE')
    expect(rule('audit_log', 'group_id')).toBe('CASCADE')

    // D18: คนที่ออกจากกลุ่มถูกมาร์ก ไม่ถูกลบ — ถ้าตรงนี้เป็น CASCADE
    // การลบ member จะลบหนี้ของคนอื่นที่ผูกอยู่ไปด้วยเงียบๆ
    expect(rule('expense', 'payer_member_id')).toBe('NO ACTION')
    expect(rule('expense_share', 'member_id')).toBe('NO ACTION')
    expect(rule('settlement', 'from_member_id')).toBe('NO ACTION')
    expect(rule('settlement', 'to_member_id')).toBe('NO ACTION')
    expect(rule('member', 'app_user_id')).toBe('NO ACTION')
  })
})

describe('D15 — ไม่มี RLS', () => {
  it('ไม่มีตารางไหนเปิด row level security และไม่มี policy', async () => {
    const enabled = await rows<{ relname: string }>(
      `select c.relname from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity`,
    )
    expect(enabled).toEqual([])

    const policies = await rows<{ policyname: string }>(
      `select policyname from pg_policies where schemaname = 'public'`,
    )
    expect(policies).toEqual([])
  })
})
