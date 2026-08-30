-- BillYai — the draft table (D27, D38, docs/adr/0001-expense-draft-table.md)
--
-- A draft is what the parser produced, waiting for someone to press ยืนยัน.
-- It is deliberately disposable: nothing references it, and a row nobody
-- confirms is garbage that can always be deleted. That is what makes the
-- table safe to write to before any intent has been confirmed.
--
-- The state has to live somewhere between the card and the press, and it
-- cannot live in the postback: LINE caps postback data at 300 characters,
-- and Thai names cost several bytes each, so the bills that would blow the
-- cap are exactly the big ones this product exists for. The postback now
-- carries only this row's id, which is short and a fixed length.
--
-- This table also makes confirming idempotent on its own. Committing is
-- `delete draft` + `insert expense` in one transaction, so a second press
-- finds no draft and does nothing — whether that press came from LINE
-- retrying the postback or from someone tapping twice on a slow connection.

create table expense_draft (
  id             uuid primary key default gen_random_uuid(),

  -- Identity as LINE gives it to us, and nothing else. There is no group_id
  -- and no foreign key to ledger_group on purpose (D30): the group is created
  -- when the bill is confirmed, for LINE groups and personal ledgers alike.
  -- Creating it earlier would leave an empty row behind for every group where
  -- somebody typed a bill and never pressed the button, and groups only ever
  -- get soft-deleted. null here means the draft came from a 1:1 chat.
  line_group_id  text,

  -- Who typed it. Present on every row, not only the 1:1 ones, because D26
  -- says only the person who typed may confirm — which has to be checked in
  -- group chats too. One column, one check, both surfaces.
  line_user_id   text not null,

  -- The parsed ExpenseDraft. One jsonb blob rather than child tables: a draft
  -- is never queried by its contents, never joined and never aggregated — it
  -- is read whole by id and thrown away. The price is that reads must validate
  -- rather than cast, since a payload written by the previous deploy can sit
  -- here for 24 hours after a release.
  payload        jsonb not null,

  -- Frozen when the draft is created, never read at commit time (D35). A card
  -- confirmed just after midnight belongs to the meal, not to the new day.
  spent_at       date not null,

  created_at     timestamptz not null default now(),

  constraint expense_draft_line_user_id_check check (btrim(line_user_id) <> ''),
  constraint expense_draft_line_group_id_check check (line_group_id is null or btrim(line_group_id) <> '')
);

-- Expired rows are swept when a draft is written, not by cron: v1 has no cron
-- at all (D7), and a handful of stale rows in an abandoned group is not worth
-- breaking that. Both indexes serve that sweep — per group on the common path,
-- and across the table for anything that ever needs a global tidy.
create index expense_draft_line_group_id_created_at_idx
  on expense_draft (line_group_id, created_at);
create index expense_draft_created_at_idx
  on expense_draft (created_at);
