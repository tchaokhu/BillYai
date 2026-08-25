# Plan — M2: Persistence

ขอบเขตรอบนี้: **schema จริง + repository layer + integration test บน Docker postgres**
ยังไม่มี LINE ไม่มี Next.js ไม่มี HTTP — `lib/` ยังคงเป็นก้อนที่ไม่รู้จัก LINE เลย

ทำไมทำต่อจาก M1: domain core เขียว 175 เทสต์แต่ยังไม่มีที่เก็บ. M2 คือชั้นที่แปลง
row เป็น type ของ M1 และกลับกัน ไม่ใช่ชั้นที่คิดเลขใหม่ — **สูตรทุกสูตรอยู่ที่เดิม**

รอบนี้ทำได้เลยโดยไม่ต้องมี LINE OA (ต่างจาก M3/Phase 0)

---

## กติกาที่บังคับทุกโมดูล

- **TDD จริง** — เขียนเทสต์ให้แดงก่อน แล้วค่อยเขียนโค้ดให้เขียว ห้ามสลับ
- **ห้ามคิดเลขเงินใน SQL** — repository โหลด row ดิบมาแล้วส่งให้ `lib/debt.ts`
  `lib/split.ts` คิด. ถ้ามีสูตร Debt โผล่ใน SQL แปลว่าเรามีสูตรสองชุดที่ต้อง
  ดูแลให้ตรงกัน ซึ่งคือบั๊กที่รอเกิด
- **สตางค์เป็น integer เท่านั้น** — `bigint` ใน DB, `number` ใน TS, มี guard
  `Number.isSafeInteger` ที่ขอบ. ห้ามให้ `bigint` ไหลออกจาก mapper เป็น string
- ห้ามแก้ไฟล์นอกโมดูลตัวเอง. `lib/types.ts`, `supabase/migrations/*.sql`,
  `lib/db/client.ts`, `lib/db/rows.ts`, `lib/db/fixtures.ts` เป็นสัญญากลาง
  **agent แก้ไม่ได้** ถ้าสัญญาไม่พอให้รายงานกลับ orchestrator
- ห้าม `any` ห้าม `as` ที่ไม่จำเป็น ห้าม `console.log` ค้าง ห้าม `.skip`
- **เทสต์ยูนิตของ M1 ต้องรันได้โดยไม่ต้องมี Docker** — ห้ามทำให้ `npm test` พึ่ง DB

---

## การตัดสินใจใหม่ที่รอบนี้บังคับให้ตัด

ทั้งสองข้อไม่ขัดกับ D1–D23 แต่ไม่เคยถูกตัดไว้ ต้องบันทึกก่อนเขียนโค้ด

**D24 — ต่อ Postgres ตรงด้วย `pg` ไม่ใช่ `@supabase/supabase-js`**

เหตุผลหลักคือ **integration test**: `supabase-js` คุยผ่าน PostgREST ซึ่ง Docker
postgres เปล่าๆ ไม่มี → ถ้าเลือกทางนั้น เทสต์ local จะทดสอบของคนละตัวกับที่รันจริง
หรือไม่ก็ต้องยก Supabase stack ทั้งก้อนขึ้นมาใน CI

เหตุผลรอง: D15 ตัด RLS ทิ้งแล้ว — authz อยู่ที่ server ที่เดียว ซึ่งแปลว่า
ประโยชน์หลักของ `supabase-js` (ส่ง JWT ให้ RLS บังคับใช้) ไม่มีให้ใช้ตั้งแต่แรก
เหลือแค่ query builder ที่แพ้ SQL ดิบตอนเขียน query แบบ Debt

ราคาที่จ่าย: ตอน deploy บน Vercel ต้องต่อผ่าน **Supavisor pooler** (พอร์ต 6543,
transaction mode) ไม่ใช่ direct connection พอร์ต 5432 เพราะ serverless เปิด
connection รัวจนเต็ม pool. ต้องตั้ง `max` ของ Pool ให้เล็ก (1–2 ต่อ instance)
Supabase ยังใช้เป็น managed Postgres + hosting เหมือนเดิมตาม D14

**D25 — Debt คิดใน TypeScript ไม่ใช่ SQL**

`docs/DESIGN.md` หัวข้อ "สูตรที่ derive" เขียนสูตร Debt เป็น SQL ไว้ อ่านเป็น
**นิยาม** ไม่ใช่ **implementation**. `lib/debt.ts` implement สูตรนี้แล้วและมี
19 เทสต์คุม. repository มีหน้าที่โหลด `ExpenseForDebt[]` + `SettlementForDebt[]`
ของวงหนึ่งมาให้ครบเท่านั้น

ราคาที่จ่าย: วงที่มีบิลเป็นหมื่นใบจะโหลดทั้งวงมาคิด. ยอมรับได้ในระดับที่วงจริงเป็น
(หลักสิบถึงหลักร้อยบิลต่อวง) และแก้ทีหลังได้ด้วย materialized balance โดยไม่ต้อง
แก้ที่เรียก. ถ้าแก้วันหนึ่ง สูตรใน `lib/debt.ts` ยังเป็นตัวตัดสินถูกผิดอยู่ดี

---

## สิ่งที่เพิ่มจาก schema ใน DESIGN.md §4

schema ใน DESIGN.md ถูกแก้หลายรอบตอน grill (D20–D23) — **ใช้เวอร์ชันในไฟล์**
สิ่งที่ต้องเติมตอนเขียน migration จริง มีเท่านี้ ไม่มีอย่างอื่น:

| เติมอะไร | ทำไม |
|---|---|
| `expense_share.amount_satang check (amount_satang >= 0)` | โหมด `exact` ยอม 0 ได้ (คนไม่ได้กิน) แต่ติดลบไม่มีความหมาย |
| `index on expense_share (member_id)` | ทุก query ของ Debt/Float ไล่จากฝั่ง member |
| `index on member (app_user_id) where app_user_id is not null` | Float ข้ามวงไล่จาก `app_user_id` |
| `index on expense (payer_member_id)` | ขาที่สองของสูตร Debt |
| `member.link_token_hash` unique index | token ชนกันต้องพังตอน insert ไม่ใช่ตอนใช้ |
| `ledger_group.owner_token_hash` unique index | เหตุผลเดียวกัน |
| `check` ครอบทุกคอลัมน์ text ที่เป็น enum (`kind` `status` `split_mode` `source` `*_via`) + ช่วงของ `surcharge_pct` และ `weight` | เกณฑ์ผ่านโมดูล D บังคับให้ `claimed_via` รับแค่ `liff\|link\|web` อยู่แล้ว — ถ้าไม่ทำที่ DB ก็ต้องเชื่อว่าโค้ดทุกเส้นทางกรองครบ |

**ช่องว่างที่รู้ตัวแล้วและตั้งใจเลื่อน:** D22 ต้องจำกัดจำนวนวงใหม่ต่อ IP ต่อวัน
แต่ DESIGN.md §4 ไม่มีตารางรองรับ. เป็นของ Phase 2.5 — ไม่ทำใน M2 แต่บันทึกไว้
ว่า schema ยังไม่ครบข้อนี้

---

## โมดูล

| # | ไฟล์ | หน้าที่ | ขึ้นกับ |
|---|---|---|---|
| — | `docker-compose.yml`, `supabase/migrations/0001_init.sql`, `scripts/db-reset.mjs` | ยก DB local + schema | — |
| — | `lib/db/client.ts` | Pool + type parser + `withTransaction` | — |
| — | `lib/db/rows.ts` | row type + mapper กลาง (สัญญา) | — |
| — | `lib/db/fixtures.ts` | สร้างวง/สมาชิกด้วย SQL ดิบ สำหรับเทสต์ | — |
| A | `lib/repo/groups.ts` | สร้าง/หาวง (line_group + personal), soft-delete/restore, Owner token | infra |
| B | `lib/repo/members.ts` | Roster ที่โตเอง, claim, Nudge token, left_group | infra |
| C | `lib/repo/expenses.ts` | commit บิล + shares + items ใน tx เดียว, void, list | infra |
| D | `lib/repo/settlements.ts` | claim → confirm/reject/cancel (D8) | infra |
| E | `lib/repo/ledger.ts` | โหลดวงทั้งวงให้ `computeDebts` | A B C D |
| F | `lib/repo/audit.ts`, `lib/repo/llm.ts` | `audit_log`, `llm_usage` + query Ceiling | infra |
| G | `lib/crypto/promptpay.ts` | encrypt/decrypt เบอร์มือถือ (D12) + `last4` | — |

**คลื่นที่ 0 (orchestrator ทำเอง):** infra ทั้งแถบ — docker-compose, migration,
client, rows, fixtures, แยก vitest project, ลง `pg`

**คลื่นที่ 1 (ขนานกัน):** A, B, C, D, G
ขนานกันได้เพราะทุกตัวสร้างข้อมูลตั้งต้นจาก `lib/db/fixtures.ts` ไม่ใช่จาก repo
ของกันและกัน — นี่คือเหตุผลที่ fixtures ต้องเสร็จตั้งแต่คลื่น 0

**คลื่นที่ 2:** E, F — หลังคลื่น 1 เขียวหมด

**คลื่นที่ 3 (orchestrator):** `lib/db/contract.db.test.ts` ชุดกันถอยหลัง
คำนวณค่าคาดหวังแยกจาก repo เหมือน `lib/contract.test.ts` ของ M1

---

## infra — รายละเอียดที่พลาดไม่ได้

**Docker**: `postgres:17-alpine`, container `billyai-db`, user/pass/db `billyai`,
พอร์ต **`54331`** (sala จอง `54329` อยู่ อย่าชน)

**`npm run db:reset`**: ลอกแบบ `D:\agent_hub\sala\scripts\db-reset.mjs` รวมทั้ง
**guard ที่ปฏิเสธ host ที่ไม่ใช่ localhost** — สคริปต์นี้ `drop schema public cascade`
ชี้ผิดที่คือกู้ไม่ได้. ต่างจาก sala ตรงไม่มี `shims.sql` เพราะ D15 ไม่ใช้ RLS
จึงไม่ต้องปลอม `auth.uid()`

**type parser** — สี่ข้อนี้คือที่ที่ `pg` ทำให้เจ็บโดยเงียบ ตั้งไว้ที่เดียวใน
`lib/db/client.ts`:

- `int8` (bigint, oid 20) → `number` พร้อม assert `Number.isSafeInteger`
  ถ้าเกินให้ throw ไม่ใช่ปัดเงียบ. ค่า default ของ `pg` คือ **string**
  ซึ่งถ้าปล่อยไว้ `share.amountSatang` จะเป็น `"120000"` แล้ว `+` กลายเป็นต่อสตริง
- `date` (oid 1082) → คงเป็น string `'YYYY-MM-DD'` **ห้ามให้เป็น `Date`**
  default ของ `pg` แปลงเป็น `Date` ที่เที่ยงคืน local time — `spent_at` จะเลื่อนวัน
  เมื่อ server อยู่คนละ timezone
- `numeric` (oid 1700) → **ไม่ตั้ง parser ทั่วระบบ** ปล่อยเป็น string แล้วให้
  mapper ของแต่ละตารางแปลงเอง (`surcharge_pct`, `weight` เท่านั้นที่เป็น numeric
  และทั้งคู่ไม่ใช่เงิน)
- `timestamptz` ปล่อยตาม default (`Date`) ถูกอยู่แล้ว

**`withTransaction`**: `BEGIN`/`COMMIT`/`ROLLBACK` บน client ตัวเดียวจาก pool
คืน client เข้า pool ใน `finally` เสมอ. repo ทุกตัวที่เขียนหลายตารางต้องรับ
client ที่ส่งเข้ามาได้ ไม่ใช่ไปหยิบจาก pool เอง มิฉะนั้นจะได้คนละ transaction

**แยก vitest เป็นสองชุด**:

```
npm test        →  lib/**/*.test.ts     ยูนิต ไม่แตะ DB   (175 เทสต์ของ M1 ต้องเขียวเหมือนเดิม)
npm run test:db →  lib/**/*.db.test.ts  integration ต้องมี Docker
npm run test:all → ทั้งสองชุด
```

ตั้งชื่อไฟล์ integration ว่า `x.db.test.ts` และ **ต้อง exclude ออกจาก
`include` ของชุดยูนิต** ไม่งั้น `npm test` จะพังบนเครื่องที่ไม่ได้เปิด Docker

**การแยกกันของเทสต์**: ทุกเทสต์สร้าง **วงของตัวเอง** ผ่าน `fixtures.ts` แล้ว
assert เฉพาะในวงนั้น. **ห้าม `TRUNCATE` ห้าม `db:reset` ระหว่างเทสต์** —
vitest รันหลายไฟล์ขนานกัน ตัวที่ล้างตารางจะฆ่าเทสต์ของไฟล์อื่นแบบสุ่ม
(อาการคือแดงไม่ซ้ำที่ ซึ่งเสียเวลาหามาก)

**ตัวแปรแวดล้อม**: `DATABASE_URL` (default local), `PROMPTPAY_KEY` (32 ไบต์ base64
สำหรับโมดูล G). เขียน `.env.local.example` ให้ครบ — `.gitignore` กัน `.env*` แล้ว
**ยังไม่มี secret จริงในโปรเจกต์ และ M2 ก็ไม่ควรมี**

---

## เกณฑ์ผ่านของแต่ละโมดูล

**A — groups**
- สร้างวง `kind='line_group'` จาก `line_group_id`; เรียกซ้ำด้วย id เดิมต้องได้วงเดิม
  ไม่ใช่วงใหม่ (webhook ยิงซ้ำได้)
- สร้างวง `kind='personal'` ที่มีแต่ `owner_token_hash` ต้องผ่าน check constraint
- วง `personal` ที่ไม่มีทั้ง `owner_id` และ `owner_token_hash` ต้อง**พังที่ DB**
  — เทสต์ต้องยืนยันว่า constraint ทำงาน ไม่ใช่แค่โค้ดกันไว้
- soft-delete → `status='soft_deleted'` + `deleted_at`; หาวงด้วย `line_group_id`
  เดิมต้องยัง**เจอ** (เชิญ bot กลับ = ข้อมูลกลับ) แต่ query ปกติต้องกรองออก
- ผูกวงส่วนตัวเข้ากลุ่ม = set `line_group_id` + `kind='line_group'` **ทางเดียว**
  ย้อนกลับต้อง error
- token เก็บเป็น sha256 เท่านั้น — เทสต์ยืนยันว่า **ไม่มีคอลัมน์ไหนเก็บ token ดิบ**

**B — members**
- Roster โตเอง: ขอ member ด้วยชื่อที่ยังไม่มี → สร้าง Placeholder ให้
  (`app_user_id` null); ชื่อเดิมในวงเดิม → คืนตัวเดิม; ชื่อเดิม**คนละวง** → คนละตัว (D9)
- claim: ผูก `app_user_id` + `claimed_at`; claim ตัวที่ถูก claim แล้วต้อง error
- `unique (group_id, app_user_id)` ต้องกัน 1 คนถือ 2 member ในวงเดียว —
  และต้องยอมให้ Placeholder หลายตัว (null หลายแถว) อยู่ร่วมกันได้
- `left_group_at` มาร์กไม่ลบ (D18) — คนที่ออกแล้วยังมีหนี้ค้างต้องยังโผล่ในยอด
- Nudge token: ออกใหม่ = อันเก่าใช้ไม่ได้ทันที (revoke by rotation, D20)
- หา member จาก token hash ต้องได้ member เดียวและรู้ว่าอยู่วงไหน

**C — expenses**
- `commitExpense` เขียน `expense` + `expense_share` (+ `expense_item`,
  `expense_item_share` เมื่อ itemized) ใน **transaction เดียว**
- ก่อน insert ต้องตรวจ invariant กลางซ้ำอีกชั้น:
  `Σ amount_satang === round(total_satang × (1 + surcharge_pct/100))`
  ไม่ตรง → throw + rollback. **ตรวจซ้ำแม้ `split.ts` ตรวจแล้ว** เพราะ shares
  อาจมาจาก LLM หรือ LIFF ที่ไม่ได้ผ่าน `splitExpense`
- rollback จริง: เทสต์ที่ยิง commit ที่พังกลางคัน ต้องไม่เหลือ `expense` แถวลอย
- void = `status='voided'` + `voided_at` ไม่ลบแถว (ไม่มี `voided_by` — ดูหมายเหตุใน schema); บิลที่ void แล้ว
  void ซ้ำต้อง error
- `on delete cascade` จาก `expense` → `expense_share`/`expense_item` ต้องทำงานจริง
- list บิลของวงเรียง `spent_at desc` deterministic เมื่อวันซ้ำ (tie-break ด้วย
  `created_at` แล้ว `id`) — ไม่งั้นหน้าจอสลับที่เองระหว่าง refresh

**D — settlements**
- สร้างได้เฉพาะ `status='claimed'` (D8 — ลูกหนี้แจ้งก่อนเสมอ)
- `confirm` เปลี่ยนเป็น `confirmed` + `confirmed_at` + `confirmed_by` + `confirmed_via`
- confirm/reject ตัวที่ไม่ใช่ `claimed` ต้อง error (กัน double-confirm)
- `from_member_id <> to_member_id` ต้องพังที่ DB — เทสต์ยืนยัน constraint
- `claimed_via`/`confirmed_via` รับเฉพาะ `liff|link|web` (`line` ไม่ใช่ช่องทาง
  ของ settlement เพราะยืนยันในกลุ่มไม่ได้)

**E — ledger**
- `loadLedger(groupId)` คืน `{ expenses: ExpenseForDebt[], settlements: SettlementForDebt[] }`
  ที่ป้อน `computeDebts` ได้ตรงๆ **โดยไม่ต้องแปลงอะไรอีก**
- เทสต์หลัก: เขียนบิล+settlement ลง DB → `loadLedger` → `computeDebts` →
  เทียบกับค่าที่**คำนวณด้วยมือในเทสต์** ไม่ใช่เรียก `computeDebts` มาเทียบกับตัวเอง
- บิล `voided` และ settlement ที่ไม่ `confirmed` ต้องมาถึง `computeDebts` ด้วย
  (มันกรองเอง) หรือกรองที่ SQL ก็ได้ — **แต่ต้องเลือกทางเดียวและมีเทสต์คุม**
  ทางที่แนะนำ: โหลดมาให้หมด ให้ `lib/debt.ts` เป็นคนตัดสินคนเดียว
- `floatOf` ข้ามวง: โหลดจากทุกวงที่ `status='active'` ของ `app_user_id` หนึ่งคน
  — วงที่ soft-deleted ต้องไม่นับ

**F — audit / llm**
- `audit_log` เก็บ `before`/`after` เป็น jsonb, `actor_via` ∈ `line|liff|link|web`
- ลบวง (cascade) แล้ว audit ของวงนั้นหายตาม — ยืนยันว่าตั้งใจ ไม่ใช่อุบัติเหตุ
- `llm_usage`: query "วันนี้ใช้ไปเท่าไหร่แล้ว" ต้องใช้ index `created_at`
  และคิดขอบวันตาม timezone ไทย (`Asia/Bangkok`) ไม่ใช่ UTC — Ceiling รายวัน
  ที่ตัดตอนตี 7 เช้าไทยคือของที่ผู้ใช้จะเจอโดยไม่เข้าใจ
- rate limit รายคน: นับ usage ของ `app_user_id` ในหน้าต่างเวลาหนึ่ง

**G — crypto/promptpay**
- AES-256-GCM จาก `node:crypto`, key จาก `PROMPTPAY_KEY` (32 ไบต์)
- เก็บ `iv || tag || ciphertext` ใน `bytea` ก้อนเดียว
- `last4` เก็บแยกเป็น plaintext เพื่อโชว์โดยไม่ decrypt (D12)
- encrypt เบอร์เดิมสองครั้งต้องได้ ciphertext **คนละอัน** (iv สุ่ม) แต่ decrypt
  แล้วได้เบอร์เดิมทั้งคู่
- แก้ไบต์ใดไบต์หนึ่งใน ciphertext แล้ว decrypt ต้อง **throw** (GCM auth tag)
  ไม่ใช่คืนขยะ
- key ไม่ถูกตั้ง → throw ตอนเรียกใช้ ไม่ใช่ตอน import (จะทำให้เทสต์ยูนิตอื่นพัง)
- normalize เบอร์: `081-234-5678`, `0812345678`, `+66812345678` → รูปเดียวกัน

---

## ขั้นตอน

1. orchestrator: คลื่น 0 ทั้งก้อน (docker-compose, migration, client, rows,
   fixtures, vitest 2 ชุด, `npm i pg @types/pg`) แล้ว `npm run db:reset` ให้ผ่านจริง
2. orchestrator เขียน **schema-shape test** ก่อนแตกงาน — ไล่ตรวจว่าทุกตาราง
   ทุกคอลัมน์ ทุก constraint ใน DESIGN.md §4 มีจริงใน DB ที่ migration สร้าง
   (query `information_schema`) นี่คือตัวจับ schema drift
3. spawn agent A B C D G พร้อมกัน — แต่ละตัวแตะเฉพาะไฟล์ตัวเอง + ไฟล์เทสต์ตัวเอง
4. orchestrator ตรวจ: อ่านโค้ดจริง + รัน `npm run test:all` + `npx tsc --noEmit`
   เอง + grep หา `any`/`console.log`/`.skip`/tautology **ไม่เชื่อรายงาน agent**
5. spawn agent E, F หลังคลื่น 1 ผ่าน
6. orchestrator เขียน `lib/db/contract.db.test.ts` ชุดกันถอยหลัง
7. ตรวจรอบสุดท้าย: `npm test` เขียวโดยไม่ต้องมี Docker · `npm run test:db` เขียว
   บน DB ที่เพิ่ง reset · `tsc --noEmit` ผ่าน · 175 เทสต์เดิมไม่ถูกแตะ

---

## สิ่งที่ยังทำไม่ได้ในรอบนี้ (ต้องรอ)

LINE OA + channel secret → webhook, LIFF, Flex card, Phase 0 spike S1–S4
Next.js → หน้า `/n/<token>`, `/g/<token>`, API route
Supabase project จริง → `db:apply-remote`, ทดสอบ Supavisor pooler
ตารางจำกัดจำนวนวงต่อ IP (D22) → Phase 2.5

---

## คำถามที่ต้องตอบก่อนเริ่ม

1. **D24 (ใช้ `pg` ไม่ใช่ `supabase-js`) รับได้ไหม** — ถ้าไม่ integration test
   ต้องยก Supabase stack ขึ้นมาทั้งก้อน ซึ่งหนักกว่ามาก
2. **โมดูล G (encrypt PromptPay) เอาเข้ารอบนี้ไหม** — เข้า: คอลัมน์
   `promptpay_cipher` มีทางเขียนที่ถูกตั้งแต่วันแรก · ไม่เข้า: M2 เล็กลง
   แต่มีคอลัมน์ที่เขียนไม่ได้ค้างไว้จน Phase 2
