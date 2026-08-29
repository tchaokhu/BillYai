# บิลใหญ่ (BillYai) — Design

สรุปผลการ grill 23 ข้อ (2026-08-23). คำศัพท์โดเมนอยู่ใน `../CONTEXT.md`
เอกสารนี้เก็บ **ข้อจำกัดที่บังคับรูปร่างระบบ**, การตัดสินใจพร้อมเหตุผล, schema,
และลำดับงาน

---

## 1. ข้อจำกัดที่ตัดสินทุกอย่าง

ข้อจำกัดพวกนี้มาจากแพลตฟอร์ม ไม่ใช่จากรสนิยม. ทุกการตัดสินใจในเอกสารนี้เป็น
ผลพวงของสามข้อนี้

**C1 — bot ดึงรายชื่อสมาชิกกลุ่มไม่ได้**
`getGroupMemberIds` เปิดเฉพาะ OA ที่ verified/premium. เราเป็น public + free =
unverified. webhook ให้ `source.userId` เฉพาะ**คนที่พิมพ์**
→ บังคับให้เกิด Placeholder + Roster ที่โตเอง (D3, D16)

**C2 — push หาคนที่ไม่ได้ add OA เป็นเพื่อน ทำไม่ได้เลย**
ไม่ใช่เรื่องโควตา แต่ LINE บล็อคตรงๆ. push เข้ากลุ่มก็นับโควตาตามจำนวนคนในกลุ่ม
(กลุ่ม 8 คน = 8 ข้อความ) และ free plan มี **300 ข้อความ/เดือน รวมทั้งระบบ**
= ทวงได้ ~37 ครั้ง/เดือนทั้งหมด. LINE Notify ปิดไปแล้ว (มี.ค. 2025)
→ บังคับ zero-push architecture (D7)

ตัวเลข 300 มาจากการยิง `GET /v2/bot/message/quota` กับ OA ตัวจริงตอนทำ S2 (2026-08-29)
ได้ `{"type":"limited","value":300}` — **เอกสารฉบับก่อนเขียนไว้ 500 ซึ่งผิด** ข้อจำกัดจึงแคบกว่า
ที่ประเมินไว้ราวหนึ่งในสาม ไม่มีการตัดสินใจข้อไหนต้องกลับ เพราะทุกข้อถอยออกจาก push อยู่แล้ว

**C3 — reply message ฟรีไม่จำกัด และ `liff.sendMessages()` ส่งในนามผู้ใช้**
สองช่องนี้ไม่กินโควตา OA เลย
→ กลายเป็นช่องทางออกทุกช่องของระบบ (D7, Passive Nag, Nudge)

ครึ่งหลังของ C3 **วัดแล้วใน S2**: กดปุ่มส่งจาก LIFF ในกลุ่มจริง `totalUsage` อยู่ที่ `0` ทั้งก่อนและหลัง
และข้อความขึ้นในนามผู้ใช้ ไม่ใช่ในนาม OA (`docs/SPIKE-PHASE0.md` §S2)

---

## 2. การตัดสินใจ

| # | หัวข้อ | เลือก | เหตุผลสั้น |
|---|---|---|---|
| D1 | กลุ่มผู้ใช้ | public, ฟรี | ทำให้ C2 กลายเป็นข้อจำกัดจริง |
| D2 | เงิน | ledger-only + gen PromptPay QR | ไม่ต้องขอ license, ไม่มี PCI, ไม่มีความเสี่ยงเงินหาย |
| D3 | Surface | hybrid: กลุ่มจด / LIFF จัดการ / DM ส่วนตัว | จดที่ที่วงคุยกันอยู่แล้ว, งานหนักไปหน้าเว็บ |
| D4 | Identity | Placeholder แล้วค่อย claim | ผลตรงจาก C1 — จดหนี้ได้โดยไม่ต้องรอใคร |
| D5 | Ledger | multi-payer, หักกลบเฉพาะรายคู่ | ตรงกับความจริง; ไม่ยุบข้ามคนแบบ Splitwise เพราะทำให้เถียงกัน |
| D6 | Split modes | equal + exact + share + itemized | ครอบเคสจริงเกือบหมด |
| D7 | ทวง | zero-push | ผลตรงจาก C2+C3; v1 ไม่ต้องมี cron เลย |
| D8 | Settle | 2 ขั้น (ลูกหนี้แจ้ง → เจ้าหนี้ยืนยัน) | เจ้าหนี้เป็นคนเดียวที่รู้ว่าเงินเข้าจริง |
| D9 | Scope | ledger แยกตามวง + event tag | privacy ชัด, placeholder ชื่อซ้ำข้ามวงไม่ชน |
| D10 | Claim auth | auto-suggest + กดเอง + ประกาศในกลุ่ม | โปร่งใสแทน ACL; ledger-only ทำให้ความเสียหายจำกัด |
| D11 | Edit auth | คนจด + Payer แก้ได้ ก่อน settle | audit กลับเข้ากลุ่ม = สังคมคุมแทน permission |
| D12 | PromptPay | เก็บเบอร์มือถืออย่างเดียว encrypt at rest | เลี่ยงเลขบัตรประชาชน = เลี่ยง PDPA ม.26 ทั้งมาตรา |
| D13 | สลิป | ไม่เก็บ | ค่า storage 0, ภาระ PDPA 0, หลักฐานอยู่ในแชทอยู่แล้ว |
| D14 | Stack | Next.js + TS + Supabase + Vercel | เหมือน sala / the-cozy-keys |
| D15 | Auth | verify LIFF ID token ฝั่ง server ทุก request, ไม่ใช้ RLS | authz อยู่ที่เดียว, webhook ไม่ต้อง bypass |
| D16 | Roster | โตเอง + Draft card โชว์ชื่อทุกครั้ง | ผลตรงจาก C1; การโชว์ชื่อกัน silent bug |
| D17 | LLM | Haiku 4.5 fallback + rate limit + global ceiling | ~280฿/เดือนที่ 1,000 บิล/วัน |
| D18 | PDPA | privacy policy + ลบตัวเองได้ + soft-delete 30 วัน | สัดส่วนพอดีกับ side project |
| D19 | Done | วงจริงใช้จบ 1 ทริปโดยไม่ต้องสอน | เกณฑ์เดียวที่โกงไม่ได้ |
| D20 | คนนอกกลุ่ม | Nudge Link — หน้าเว็บ token เห็นเฉพาะยอดตัวเอง | ไปถึงคนที่ไม่มี LINE ด้วยซ้ำ โดยไม่กินโควตา |
| D21 | ไม่มีกลุ่ม LINE | วงส่วนตัว (`kind='personal'`) เข้า v1 | มื้อเดียวจบเจอบ่อยกว่าทริป และเป็นประตูทางเข้าที่เบาที่สุด |
| D22 | เว็บ | token-based ไม่มีล็อกอิน — owner สร้างวง/จดบิล/ส่งลิงก์ได้ครบ | เลี่ยงระบบ auth ที่สองซึ่งเป็นหลุมจริง; ไม่มีใครสมัครสมาชิกเพื่อหารค่าหมูกระทะ |
| D23 | ลิงก์หาย | เตือนดังๆ ตอนสร้าง + ชวนผูก LINE ทีหลัง ไม่เก็บ email | ผูก LINE = กู้คืนได้ตลอดไป โดยไม่เพิ่มขอบเขต PDPA |
| D24 | DB client | `pg` ต่อ Postgres ตรง ไม่ใช่ `supabase-js` | integration test รันบน Docker postgres เปล่าได้; D15 ตัด RLS ไปแล้ว ประโยชน์หลักของ supabase-js จึงไม่มี |
| D25 | Debt | คิดใน `lib/debt.ts` ไม่ใช่ SQL | สูตร SQL ในเอกสารนี้เป็นนิยาม ไม่ใช่ implementation — มีสูตรสองชุด = บั๊กรอเกิด |

### การตัดสินใจที่ตกลงระหว่างทาง (ไม่ได้อยู่ใน 19 ข้อ)

- **เก็บทุกจำนวนเป็นสตางค์ (integer)** — ไม่มี float ที่ไหน. เศษจากการหารใช้
  largest-remainder แล้ว Payer รับเศษ. invariant: `Σ share = total + surcharge`
- **`surcharge_pct` หนึ่งตัวต่อบิล** — บิลร้านไทยคือ `รายการ → +10% → +7%`
  ถ้า itemized ไม่มีตัวนี้ ระบบพังทันทีในวันแรก
- **Global daily LLM ceiling + kill switch** — rate limit ต่อคนกัน 1 คนสแปม
  แต่ไม่กัน 1,000 กลุ่มมาพร้อมกัน ซึ่งคือสิ่งที่เกิดถ้าไวรัล และเราเป็นคนจ่ายบิล
- **เตะ bot ออก = soft-delete 30 วัน กู้คืนได้** — `line_group_id` คงที่
  เชิญ bot กลับกลุ่มเดิม = ข้อมูลกลับมาครบ. ป้องกันลูกหนี้เตะ bot ทิ้งเพื่อลบหนี้
  ตัวเอง ซึ่งเป็นช่องโหว่ที่เกิดจาก D18 + zero-push ชนกัน

### สิ่งที่เลื่อนไป v2 โดยตั้งใจ

บิลซ้ำ (recurring, ต้องมี cron ซึ่งขัด zero-infra ของ v1) · คะแนนเครดิตคนจ่าย
(ไวรัลสูงแต่ประจานเพื่อน ต้อง opt-in ระดับกลุ่ม) · OCR สลิป/บิล · หลายสกุลเงิน ·
slip verify API (SlipOK/EasySlip — ฆ่า pain สลิปปลอมได้จริง แต่มีค่าใช้จ่ายต่อครั้ง
ซึ่งขัดกับ public+free)

---

## 3. ไวยากรณ์คำสั่ง

bot อ่านเฉพาะข้อความที่เข้า Trigger — ข้อความอื่น**ทิ้ง ไม่เก็บ ไม่ส่งเข้า LLM**

```
+ ข้าว 1200                       หารเท่าทุกคนใน Roster, คนพิมพ์เป็น Payer
+ ข้าว 1200 กอล์ฟ เบียร์ ตูน       หาร 3 คน ไม่รวมคนจ่าย
+ เหล้า 900 กอล์ฟ ตูน รวมฉัน       หาร 3 คน รวมคนจ่าย
+ คอนโด 8000 กอล์ฟx2 เบียร์ ตูน    กอล์ฟ 2 ส่วน ที่เหลือคนละ 1
+ ข้าว 1200 #เชียงใหม่             ติด event tag

ยอด      สรุปหนี้ทั้งกลุ่ม
ทวง      การ์ด Nudge + QR
แก้      เปิด LIFF
เลิก     undo คำสั่งล่าสุดของตัวเอง
```

ทุกคำสั่งที่สร้างบิลตอบกลับเป็น **Draft card** ที่โชว์ชื่อทุกคนที่จะโดนหารและยอด
รายคน กด "ยืนยัน" ถึงลง ledger. rule parser จับรูปแบบข้างบน; อะไรที่ไม่เข้าไป
Haiku 4.5 แปลงเป็น JSON เดียวกัน

---

## 4. Schema

```sql
-- ─── วง ────────────────────────────────────────────────────────────
create table ledger_group (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null default 'line_group', -- line_group | personal (D21)
  line_group_id    text unique,                    -- null เมื่อ kind='personal'
  owner_id         uuid references app_user(id),   -- เจ้าของวงส่วนตัว
  owner_token_hash bytea,                          -- D22: sha256 ของ Owner Link token
  owner_token_at   timestamptz,
  status           text not null default 'active', -- active | soft_deleted
  deleted_at       timestamptz,
  created_at       timestamptz not null default now(),
  check ((kind = 'line_group' and line_group_id is not null)
      or (kind = 'personal'   and (owner_id is not null
                                or owner_token_hash is not null)))
);
-- ผูกวงส่วนตัวเข้ากลุ่มภายหลัง = set line_group_id + kind='line_group' (ทางเดียว)

-- ตัวตนข้ามวง ใช้เฉพาะ Float + สรุปรายจ่ายส่วนตัว + PromptPay
-- PK เป็น uuid ไม่ใช่ line_user_id เพราะคนที่มาทางเว็บไม่มี LINE (D22)
create table app_user (
  id                 uuid primary key default gen_random_uuid(),
  line_user_id       text unique,                  -- null = มาทางเว็บ
  promptpay_cipher   bytea,                        -- เบอร์มือถือ encrypted (D12)
  promptpay_last4    text,                         -- โชว์โดยไม่ decrypt
  is_oa_friend       boolean not null default false,
  policy_accepted_at timestamptz,
  created_at         timestamptz not null default now()
);

create table member (
  id              uuid primary key default gen_random_uuid(),
  group_id        uuid not null references ledger_group(id) on delete cascade,
  display_name    text not null,
  app_user_id     uuid references app_user(id),    -- null = Placeholder
  claimed_at      timestamptz,
  left_group_at   timestamptz,                     -- D18: มาร์ก ไม่ลบ
  link_token_hash bytea,                           -- D20: sha256 ของ Nudge Link token
  link_token_at   timestamptz,                     -- revoke = ออกใหม่
  created_at      timestamptz not null default now(),
  constraint member_display_name_check check (btrim(display_name) <> ''),
  unique (group_id, display_name),
  unique (group_id, app_user_id)                   -- 1 คน ต่อ 1 member/วง
);

-- ─── บิล ───────────────────────────────────────────────────────────
create table expense (
  id               uuid primary key default gen_random_uuid(),
  group_id         uuid not null references ledger_group(id) on delete cascade,
  event_tag        text,
  description      text not null,
  total_satang     bigint not null check (total_satang > 0),
  surcharge_pct    numeric(5,2) not null default 0,
  payer_member_id  uuid not null references member(id),
  split_mode       text not null,                  -- equal|exact|share|itemized
  spent_at         date not null,
  created_by       uuid not null references member(id),   -- ไม่ใช่ line_user_id (D22)
  source           text not null,                  -- rule | llm | liff | web
  status           text not null default 'active', -- active | voided
  voided_at        timestamptz,
  -- ไม่มี voided_by: FK ชี้ member(id) การันตีแค่ว่ามีตัวตน ไม่ได้การันตีว่าอยู่วงเดียวกับบิล
  -- audit ของ D11 คือข้อความที่บอทประกาศกลับเข้ากลุ่มตอนยกเลิก ไม่ใช่คอลัมน์นี้
  created_at       timestamptz not null default now()
);
create index on expense (group_id, status, spent_at desc);

create table expense_share (
  id             uuid primary key default gen_random_uuid(),
  expense_id     uuid not null references expense(id) on delete cascade,
  member_id      uuid not null references member(id),
  weight         numeric(8,3),                     -- ใช้เมื่อ split_mode='share'
  amount_satang  bigint not null,                  -- ยอดสุดท้าย รวม surcharge แล้ว
  unique (expense_id, member_id)
);
-- invariant (ต้องมีเทสต์คุม):
--   Σ amount_satang = round(total_satang * (1 + surcharge_pct/100))

create table expense_item (                        -- itemized เท่านั้น
  id             uuid primary key default gen_random_uuid(),
  expense_id     uuid not null references expense(id) on delete cascade,
  name           text not null,
  amount_satang  bigint not null check (amount_satang > 0)
);

create table expense_item_share (
  item_id    uuid not null references expense_item(id) on delete cascade,
  member_id  uuid not null references member(id),
  weight     numeric(8,3) not null default 1,
  primary key (item_id, member_id)
);

-- ─── การเคลียร์หนี้ ────────────────────────────────────────────────
create table settlement (
  id               uuid primary key default gen_random_uuid(),
  group_id         uuid not null references ledger_group(id) on delete cascade,
  from_member_id   uuid not null references member(id),   -- ลูกหนี้
  to_member_id     uuid not null references member(id),   -- เจ้าหนี้
  amount_satang    bigint not null check (amount_satang > 0),
  status           text not null default 'claimed',       -- claimed|confirmed|rejected|cancelled
  claimed_at       timestamptz not null default now(),
  claimed_by       uuid references member(id),
  claimed_via      text not null default 'liff',          -- liff | link | web
  confirmed_at     timestamptz,
  confirmed_by     uuid references member(id),
  confirmed_via    text,                                  -- liff | link | web
  note             text,
  check (from_member_id <> to_member_id)
);
create index on settlement (group_id, status);

-- ─── ระบบ ─────────────────────────────────────────────────────────
create table audit_log (
  id          bigserial primary key,
  group_id    uuid references ledger_group(id) on delete cascade,
  actor       uuid references member(id),
  actor_via   text not null,                       -- line | liff | link | web
  action      text not null,
  target_type text not null,
  target_id   uuid,
  before      jsonb,
  after       jsonb,
  created_at  timestamptz not null default now()
);

create table llm_usage (
  id            bigserial primary key,
  app_user_id   uuid,
  group_id      uuid,
  input_tokens  int not null,
  output_tokens int not null,
  created_at    timestamptz not null default now()
);
create index on llm_usage (created_at);           -- ใช้บังคับ Ceiling
```

### สูตรที่ derive จากตารางข้างบน

**Debt(A→B)** — A ติด B เท่าไหร่ในกลุ่มหนึ่ง:

```
  Σ share.amount ที่ share.member = A และ expense.payer = B และ status='active'
− Σ share.amount ที่ share.member = B และ expense.payer = A และ status='active'
− Σ settlement.amount ที่ from=A to=B status='confirmed'
+ Σ settlement.amount ที่ from=B to=A status='confirmed'
```

ค่าบวก = A ติด B, ค่าลบ = B ติด A. **ไม่ยุบข้ามคู่**

**Float(U)** — เงินจมของคนหนึ่งคน = ผลรวม Debt ที่เป็นบวกซึ่งชี้มาที่ member rows
ทุกอันที่ `app_user_id = U` ข้ามทุกวงที่ `status='active'`. ใช้ `app_user_id`
ไม่ใช่ `line_user_id` — คนที่มาทางเว็บก็มี Float ได้

---

## 5. คนนอกกลุ่ม และวงที่ไม่มีกลุ่ม

สองเคสที่ design เดิม (1 LINE group = 1 ledger) ตอบไม่ได้

**เคส A — มีกลุ่ม แต่คนที่หารด้วยไม่ได้อยู่ในกลุ่ม** (แฟนของเพื่อน, คนมาสมทบ)
ฝั่งคำนวณรองรับอยู่แล้วด้วย Placeholder — จด `+ ข้าว 1200 กอล์ฟ แฟนกอล์ฟ` ได้ทันที
ที่ขาดคือขาปลาย: เขาไม่เห็นการ์ด ไม่เห็นยอด และ zero-push ยิงหาไม่ได้
→ แก้ด้วย **Nudge Link** (D20)

**เคส B — ไม่มีกลุ่ม LINE เลย** (นานๆ ทีเจอกัน กินมื้อเดียวแล้วแยกย้าย)
เคสนี้เจอบ่อยกว่าทริป และไม่มีใครตั้งกลุ่ม LINE เพื่อกินข้าวมื้อเดียว
→ แก้ด้วย **วงส่วนตัว** (D21) — เจ้าของวงพิมพ์ `+ ปิ้งย่าง 2400 โอ๋ บาส เมย์`
ในแชท 1:1 ทุกคนเป็น Placeholder ทวงด้วย Nudge Link

**ราคาที่จ่ายในวงส่วนตัว — ต้องรู้ตัว:** ไม่มีกลุ่มให้ reply แปลว่า
**ไม่มี Passive Nag และไม่มีแรงกดดันจากสังคม** ซึ่งคือกลไกที่เราออกแบบมาแทน push
(C2, C3). เหลือ Nudge Link อย่างเดียว = ทวงเงียบๆ ทีละคน ได้ผลน้อยกว่ามาก
วงส่วนตัวจึงเก่งเรื่อง**คำนวณ** แต่อ่อนเรื่อง**ตามเก็บ**. ถ้าวัดแล้วคนใช้วงส่วนตัว
แต่เก็บเงินไม่ได้จริง ทางแก้คือดันให้ผูกเข้ากลุ่ม ไม่ใช่เพิ่ม push

### เว็บแบบไม่มีล็อกอิน (D22)

เรามีเว็บอยู่แล้ว — LIFF คือ Next.js app, Nudge Link คือหน้า public. คำถามจริง
ไม่เคยเป็น "ทำเว็บไหม" แต่เป็น **"เพิ่มระบบล็อกอินที่สองไหม"** ซึ่งคำตอบคือไม่

**ไม่ทำ email/password auth** เพราะจะได้ identity สองสาย (LINE vs account) →
ต้องมี account linking → เป็นแหล่งบั๊กและช่องโหว่อันดับหนึ่งของแอปประเภทนี้
และ Supabase Auth ไม่มี LINE provider ในตัวอยู่แล้ว

แทนที่ด้วย **token สองชนิด** ไม่มีสมัครสมาชิก ไม่มีรหัสผ่าน ไม่มีลืมรหัสผ่าน:

| token | ถือโดย | ทำอะไรได้ |
|---|---|---|
| **Owner Link** `/g/<token>` | เจ้าของวง | สร้างวง จดบิล แก้ ดูยอดทั้งวง ออก/เพิกถอน Nudge Link ยืนยันการจ่าย |
| **Nudge Link** `/n/<token>` | ลูกหนี้รายคน | เห็นยอดตัวเอง + QR + แจ้งว่าจ่ายแล้ว เท่านั้น (D20) |

**ผลที่ตามมาต่อ schema:** ทุกคอลัมน์ "ใครทำ" เคยเก็บ `line_user_id` ซึ่งใช้กับคนที่
ไม่มี LINE ไม่ได้ → เปลี่ยนเป็น `member(id)` ทั้งหมด และเพิ่ม `*_via`
(`line|liff|link|web`) บอกช่องทาง. `app_user` เปลี่ยน PK เป็น uuid โดย
`line_user_id` เป็น nullable unique. ผลพลอยได้: **ledger เป็นกลางต่อ LINE ทั้งก้อน**
ซึ่งควรเป็นแบบนี้ตั้งแต่แรก

**ราคาที่จ่าย — ทำลิงก์หาย = ข้อมูลหายถาวร** ไม่มี email ให้กดลืมรหัสผ่าน (D23)
บรรเทาด้วย: หน้าสร้างวงบอกตรงๆ ว่าลิงก์นี้คือกุญแจเดียว · ปุ่มก๊อป · แนะนำให้
Keep ไว้ในแชทตัวเอง · **มี LINE เมื่อไหร่กดผูกได้ทันที แล้วกู้คืนได้ตลอดไป**

**abuse surface ใหม่:** สร้างวงได้โดยไม่ต้องมีตัวตนใดๆ = สแปมสร้างวงไม่จำกัด
Ceiling เดิมคุมแค่ LLM ไม่คุมจำนวน row → ต้องจำกัดจำนวนวงใหม่ต่อ IP ต่อวัน

### Nudge Link — ข้อกำหนดความปลอดภัย

ลิงก์นี้เปิดได้โดยไม่ต้องล็อกอิน ใครถือลิงก์ก็เปิดได้ จึงต้องคุมขอบเขตให้แคบที่สุด

- token สุ่ม 32 ไบต์ เก็บใน DB เป็น **sha256 hash เท่านั้น** ไม่เก็บตัวจริง
- หนึ่ง token = หนึ่ง Member ในหนึ่งวง. เพิกถอน = ออก token ใหม่ อันเก่าตายทันที
- เห็นได้เฉพาะ: ยอดที่ **ตัวเองติด**, รายการบิลที่ตัวเองโดนหาร, QR, ปุ่มแจ้งจ่าย
- **ไม่เห็น**: ยอดคนอื่น, Roster, ledger ทั้งวง, เบอร์พร้อมเพย์เต็มของเจ้าหนี้
  (โชว์ QR กับ last4 พอ)
- response header `X-Robots-Tag: noindex` + `Referrer-Policy: no-referrer`
- rate limit ต่อ token — ป้องกันการเดา token และการกดปุ่มรัว
- ปุ่มแจ้งจ่ายสร้าง Settlement `status='claimed'`, `claimed_via='link'`
  → **เจ้าหนี้ยังต้องยืนยันเหมือนเดิม** (D8 ไม่เปลี่ยน)

Owner Link ใช้กติกาเดียวกันทุกข้อ ต่างแค่ขอบเขตที่เห็น (ทั้งวง) — และเพราะมัน
แก้ข้อมูลได้ จึงต้อง rate limit เข้มกว่า และทุกการกระทำลง `audit_log`
พร้อม `actor_via='web'`

## 6. สถาปัตยกรรม

```
LINE group ──webhook──▶ /api/line/webhook  (verify X-Line-Signature)
                            │
                    Trigger filter  ─── ไม่เข้า → ทิ้ง ไม่เก็บ ไม่ส่ง LLM
                            │
                    rule parser (regex)
                            │ ไม่เข้า
                    Ceiling check → Haiku 4.5 → JSON
                            │
                    Draft card ──reply (ฟรี)──▶ กลุ่ม + Passive Nag ต่อท้าย
                            │ postback "ยืนยัน"
                    commit expense + shares  ──reply──▶ กลุ่ม

แชท 1:1 ──webhook──▶ เส้นทางเดียวกัน แต่ resolve เป็นวงส่วนตัวของคนพิมพ์ (D21)

LIFF (เปิดจากในกลุ่ม) ──ID token──▶ /api/liff/*  ──▶ Supabase
   └── ปุ่มทวง → liff.sendMessages() → Nudge card ลงกลุ่มในนามเจ้าหนี้ (ฟรี)

/n/<token>  ──▶ Nudge Link: หน้า public read-only ต่อลูกหนี้ 1 คน (D20)
   └── ไม่ต้องล็อกอิน ไม่ต้องมี LINE — ปุ่มแจ้งจ่าย → settlement claimed

/g/<token>  ──▶ Owner Link: เว็บเต็มของวงส่วนตัว (D22)
   └── สร้างวง จดบิล แก้ ดูยอด ออก Nudge Link ยืนยันการจ่าย — ไม่ต้องมี LINE
```

สาม surface ใช้ core เดียวกันหมด — parser, การหาร, Debt, Settlement อยู่ใน
`lib/` ที่ไม่รู้จัก LINE เลย. webhook / LIFF / เว็บ token เป็นแค่ adapter
สามอันที่ resolve ว่า "วงไหน ใครทำ ผ่านช่องทางไหน" แล้วเรียกของเดียวกัน

**หมายเหตุที่พลาดไม่ได้:** `liff.sendMessages()` ใช้ได้เฉพาะตอน LIFF ถูกเปิดจาก
ในแชทกลุ่มนั้น (`liff.getContext().type === 'group'`) และต้องมี scope
`chat_message.write`. เส้นทางไปปุ่มทวงจึงต้องเริ่มจากในกลุ่มเสมอ ไม่ใช่จากแชท 1:1

---

## 7. Spike ที่ต้องทำก่อนเขียนโค้ดจริง

สี่ข้อนี้คือสมมติฐานที่ design ทั้งชุดวางอยู่บน ถ้าข้อไหนผิดต้องกลับมาแก้ design
ไม่ใช่แก้โค้ด — **ทำก่อน commit อะไรทั้งนั้น**

ขั้นตอนลงมือและที่บันทึกผลอยู่ที่ `docs/SPIKE-PHASE0.md`

| # | ทดสอบอะไร | ถ้าผลออกมาผิดคาด |
|---|---|---|
| S1 | `getGroupMemberProfile` เรียกได้ไหมบน OA ที่ยัง**ไม่** verified (ดึง display name ของคนที่พิมพ์ในกลุ่ม) | auto-suggest ของ D10 ใช้ไม่ได้ → ต้องให้คนพิมพ์ชื่อตัวเองตอน claim |
| S2 | `liff.sendMessages()` จาก group context จริง — flow ขออนุญาต scope หน้าตายังไง เด้งกี่ครั้ง | friction สูงเกิน → ถอยไปใช้ Nudge Link (D20) เป็นช่องทางหลักแทน ไม่ถึงกับพังทั้ง D7 |
| S3 | PromptPay EMVCo payload + amount — สแกนผ่านแอปธนาคารจริงอย่างน้อย 3 เจ้า ยอดขึ้นถูกไหม | ถ้าไม่ขึ้นยอด value หลักของ Nudge หายไปครึ่ง |
| S4 | Vercel cold start + Supabase free — ตอบ webhook ทันเวลาที่ LINE รอไหม | ต้องย้าย host หรือทำ warm ping |

จำนวนข้อความจริงที่ LINE นับตอน push เข้ากลุ่ม (ตาม C2) ไม่ต้อง spike เพราะ
zero-push ทำให้เราไม่ push อยู่แล้ว — แต่ถ้าวันหนึ่งจะเพิ่ม push ต้องวัดก่อน

---

## 8. ลำดับงาน

**Phase 0 — spike** (S1–S4 ข้างบน) สร้าง LINE OA จริง + LIFF app + ยิงของจริง

**Phase 1 — จดได้ หารถูก**
schema + webhook + signature verify + Trigger filter + rule parser + Draft card +
commit + `ยอด` + Placeholder/Roster ที่โตเอง + **วงส่วนตัวในแชท 1:1** (D21 —
resolve วงจาก `source.type` เท่านั้น ทางที่เหลือใช้โค้ดร่วมกันทั้งหมด)
เทสต์ที่ต้องมี: invariant `Σ share = total + surcharge` ทุก split mode, เศษ
largest-remainder, Debt รายคู่

**Phase 2 — ทวงได้ เคลียร์ได้**
LIFF + ID token verify + PromptPay QR + Nudge ผ่าน `liff.sendMessages()` +
**Nudge Link `/n/<token>`** (D20 — จำเป็น ไม่ใช่ของแถม: เป็นช่องทางเดียวของ
คนนอกกลุ่มและของวงส่วนตัวทั้งหมด) + Settlement 2 ขั้น + Passive Nag + Escalation

**Phase 2.5 — เว็บ token** (D22/D23)
Owner Link `/g/<token>` — สร้างวง จดบิล แก้ ดูยอด ออก Nudge Link ยืนยันการจ่าย ·
หน้าเตือนเรื่องลิงก์หาย + ปุ่มก๊อป · ปุ่มผูก LINE เพื่อกู้คืน · จำกัดจำนวนวงใหม่
ต่อ IP ต่อวัน
ทำหลัง Phase 2 เพราะ UI ใช้ component ชุดเดียวกับ LIFF — ทำสลับกันคือเขียนสองรอบ

**Phase 3 — เอาไว้ใช้จริง**
Undo · แก้บิล + audit กลับเข้ากลุ่ม · claim/auto-suggest · Float ข้ามวง ·
สรุป Event แชร์ได้ · สรุปรายจ่ายส่วนตัว · ผูกวงส่วนตัวเข้ากลุ่ม LINE

**Phase 4 — ปล่อย**
Haiku fallback + Ceiling + kill switch · privacy policy + ลบข้อมูลตัวเอง ·
soft-delete/restore ตอนโดนเตะ · แล้วค่อยพาวงจริงใช้จบ 1 ทริป (D19)

Phase 1 กับ 2 คือของจริง. Phase 3 คือสิ่งที่ทำให้คนไม่เลิกใช้. Phase 4 คือสิ่งที่
ทำให้ปล่อย public แล้วไม่เจ็บตัว
