-- BillYai — initial schema.
--
-- Mirrors docs/DESIGN.md §4. That document is the source of truth for shape;
-- this file adds only the constraints and indexes listed under "สิ่งที่เพิ่มจาก
-- schema ใน DESIGN.md §4" in docs/PLAN-M2.md. If the two ever disagree,
-- lib/db/schema.db.test.ts is what catches it.
--
-- Money is always satang as bigint. Never numeric, never float — see CONTEXT.md.
-- There are no RLS policies here on purpose (D15): authorization lives in one
-- place on the server, so the database grants nothing to anon.

-- ─── people ──────────────────────────────────────────────────────────

-- Cross-group identity. Used for Float, personal spending summaries and
-- PromptPay only. The primary key is a uuid rather than the LINE user id
-- because someone who arrives through the web has no LINE account at all (D22).
create table app_user (
  id                 uuid primary key default gen_random_uuid(),
  line_user_id       text unique,                  -- null = arrived via the web
  promptpay_cipher   bytea,                        -- mobile number, encrypted (D12)
  promptpay_last4    text,                         -- shown without decrypting
  is_oa_friend       boolean not null default false,
  policy_accepted_at timestamptz,
  created_at         timestamptz not null default now()
);

-- ─── groups ──────────────────────────────────────────────────────────

create table ledger_group (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null default 'line_group',
  line_group_id    text unique,                    -- null when kind='personal'
  owner_id         uuid references app_user(id),   -- owner of a personal group
  owner_token_hash bytea,                          -- D22: sha256 of the Owner Link token
  owner_token_at   timestamptz,
  status           text not null default 'active',
  deleted_at       timestamptz,
  created_at       timestamptz not null default now(),
  constraint ledger_group_kind_check
    check (kind in ('line_group', 'personal')),
  constraint ledger_group_status_check
    check (status in ('active', 'soft_deleted')),
  -- A LINE group is identified by its LINE id; a personal group is reachable
  -- only through its owner, so it must have at least one way in.
  constraint ledger_group_identity_check
    check ((kind = 'line_group' and line_group_id is not null)
        or (kind = 'personal'   and (owner_id is not null
                                  or owner_token_hash is not null)))
);

-- Linking a personal group to a LINE group later = set line_group_id and
-- kind='line_group'. One way only; the repository enforces the direction.

-- A token collision must fail on insert, not silently hand two groups the
-- same key.
create unique index ledger_group_owner_token_hash_key
  on ledger_group (owner_token_hash)
  where owner_token_hash is not null;

create table member (
  id              uuid primary key default gen_random_uuid(),
  group_id        uuid not null references ledger_group(id) on delete cascade,
  display_name    text not null,
  app_user_id     uuid references app_user(id),    -- null = Placeholder
  claimed_at      timestamptz,
  left_group_at   timestamptz,                     -- D18: mark, never delete
  link_token_hash bytea,                           -- D20: sha256 of the Nudge Link token
  link_token_at   timestamptz,                     -- revoke = issue a new one
  created_at      timestamptz not null default now(),
  unique (group_id, display_name),
  -- Nulls do not collide in a unique index, so any number of Placeholders can
  -- coexist while a claimed person still gets exactly one member per group.
  unique (group_id, app_user_id)
);

create unique index member_link_token_hash_key
  on member (link_token_hash)
  where link_token_hash is not null;

-- Float walks the ledger from the app_user side, across every group.
create index member_app_user_id_idx
  on member (app_user_id)
  where app_user_id is not null;

-- ─── expenses ────────────────────────────────────────────────────────

create table expense (
  id               uuid primary key default gen_random_uuid(),
  group_id         uuid not null references ledger_group(id) on delete cascade,
  event_tag        text,
  description      text not null,
  total_satang     bigint not null check (total_satang > 0),
  surcharge_pct    numeric(5,2) not null default 0,
  payer_member_id  uuid not null references member(id),
  split_mode       text not null,
  spent_at         date not null,
  created_by       uuid not null references member(id),   -- a member, not a line_user_id (D22)
  source           text not null,
  status           text not null default 'active',
  voided_at        timestamptz,
  voided_by        uuid references member(id),
  created_at       timestamptz not null default now(),
  constraint expense_surcharge_pct_check
    check (surcharge_pct >= 0 and surcharge_pct <= 100),
  constraint expense_split_mode_check
    check (split_mode in ('equal', 'exact', 'share', 'itemized')),
  constraint expense_source_check
    check (source in ('rule', 'llm', 'liff', 'web')),
  constraint expense_status_check
    check (status in ('active', 'voided'))
);

create index expense_group_status_spent_at_idx
  on expense (group_id, status, spent_at desc);

-- The other leg of the Debt formula: everything this member paid for.
create index expense_payer_member_id_idx on expense (payer_member_id);

create table expense_share (
  id             uuid primary key default gen_random_uuid(),
  expense_id     uuid not null references expense(id) on delete cascade,
  member_id      uuid not null references member(id),
  weight         numeric(8,3),                     -- used when split_mode='share'
  -- Final amount, surcharge already included. Zero is legal in exact mode:
  -- someone present who ate nothing. Negative never is.
  amount_satang  bigint not null check (amount_satang >= 0),
  unique (expense_id, member_id),
  constraint expense_share_weight_check
    check (weight is null or weight > 0)
);
-- Invariant, enforced in lib/repo/expenses.ts inside the write transaction:
--   Σ amount_satang = round(total_satang * (1 + surcharge_pct/100))

-- Every Debt and Float query starts from a member and asks what they owe.
create index expense_share_member_id_idx on expense_share (member_id);

create table expense_item (                        -- itemized mode only
  id             uuid primary key default gen_random_uuid(),
  expense_id     uuid not null references expense(id) on delete cascade,
  name           text not null,
  amount_satang  bigint not null check (amount_satang > 0)
);

create table expense_item_share (
  item_id    uuid not null references expense_item(id) on delete cascade,
  member_id  uuid not null references member(id),
  weight     numeric(8,3) not null default 1 check (weight > 0),
  primary key (item_id, member_id)
);

-- ─── settling up ─────────────────────────────────────────────────────

create table settlement (
  id               uuid primary key default gen_random_uuid(),
  group_id         uuid not null references ledger_group(id) on delete cascade,
  from_member_id   uuid not null references member(id),   -- debtor
  to_member_id     uuid not null references member(id),   -- creditor
  amount_satang    bigint not null check (amount_satang > 0),
  status           text not null default 'claimed',
  claimed_at       timestamptz not null default now(),
  claimed_by       uuid references member(id),
  -- No 'line' here: a settlement cannot be confirmed from a group chat, so
  -- the LINE surface is never the channel for one.
  claimed_via      text not null default 'liff',
  confirmed_at     timestamptz,
  confirmed_by     uuid references member(id),
  confirmed_via    text,
  note             text,
  check (from_member_id <> to_member_id),
  constraint settlement_status_check
    check (status in ('claimed', 'confirmed', 'rejected', 'cancelled')),
  constraint settlement_claimed_via_check
    check (claimed_via in ('liff', 'link', 'web')),
  constraint settlement_confirmed_via_check
    check (confirmed_via is null or confirmed_via in ('liff', 'link', 'web'))
);

create index settlement_group_status_idx on settlement (group_id, status);

-- ─── system ──────────────────────────────────────────────────────────

create table audit_log (
  id          bigserial primary key,
  group_id    uuid references ledger_group(id) on delete cascade,
  actor       uuid references member(id),
  actor_via   text not null,
  action      text not null,
  target_type text not null,
  target_id   uuid,
  before      jsonb,
  after       jsonb,
  created_at  timestamptz not null default now(),
  constraint audit_log_actor_via_check
    check (actor_via in ('line', 'liff', 'link', 'web'))
);

create table llm_usage (
  id            bigserial primary key,
  app_user_id   uuid,
  group_id      uuid,
  input_tokens  int not null,
  output_tokens int not null,
  created_at    timestamptz not null default now()
);

-- Drives the global daily Ceiling, which is a range scan over recent rows.
create index llm_usage_created_at_idx on llm_usage (created_at);
