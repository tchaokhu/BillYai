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
| D26 | ยืนยัน Draft | **เฉพาะคนพิมพ์**กดได้ · คนอื่นกดแล้วเงียบ | การ์ดอยู่ในกลุ่มที่ทุกคนเห็น แต่การกดยืนยันสร้างหนี้ทันที ต่างจาก claim ที่ D10 ยอมให้โปร่งใสแทน ACL เพราะความเสียหายจำกัด · คนพิมพ์อยู่ในกลุ่มและเพิ่งพิมพ์เสร็จเมื่อไม่กี่วินาทีก่อน จึงไม่มีสถานการณ์จริงที่ต้องกดแทนกัน · ที่เงียบไม่ตอบว่า "ไม่มีสิทธิ์" เพราะการประกาศแบบนั้นในกลุ่มเพื่อนคือการทำให้เสียหน้าโดยไม่จำเป็น |
| D27 | Draft เก็บที่ไหน | ตาราง `expense_draft` แยก ไม่ยัด postback data | postback `data` จำกัด 300 ตัวอักษร ซึ่งจะชนตอนบิลคนเยอะ — ดู `docs/adr/0001-expense-draft-table.md` |
| D28 | Roster โตตอนไหน | **อ่านตอน draft เขียนตอนยืนยัน** · ชื่อที่ยังไม่มีในวงติดป้าย `(ใหม่)` บนการ์ด · เทียบชื่อแบบ exact ไม่ใช่ fuzzy | `unique (group_id, display_name)` + D18 ที่ห้ามลบ Member แปลว่าพิมพ์ผิดหนึ่งครั้งคือคนใหม่ถาวร · สร้างตอน draft แล้วไม่กดยืนยันก็สายไปแล้ว และทำให้คำว่า "draft คือขยะที่ลบทิ้งได้เสมอ" ใน ADR 0001 ไม่จริง · การโชว์ชื่อเฉยๆ ตาม D16 ไม่พอ เพราะ `กอล์ฟ` กับ `กอล์ป` ตาคนอ่านผ่านได้ ป้าย `(ใหม่)` ข้างคนที่หารกันมา 5 บิลแล้วสะดุดตากว่ามาก · fuzzy ไม่เอาเพราะเดาผิดแล้วบิลไปลงหัวคนผิดแบบเงียบ ซึ่งแย่กว่าพิมพ์ผิดแล้วเห็นป้าย |
| D29 | คนพิมพ์คือ Member ตัวไหน | **ถามบนการ์ด Draft ใบแรกของคนนั้นในวงนั้น** — ปุ่มเลือกชื่อจาก Roster หรือ "ฉันเป็นคนใหม่" · กดแล้ว claim + ยืนยันบิลในจังหวะเดียว · ครั้งต่อไปไม่ถามอีก | ดู `docs/adr/0002-who-is-typing.md` |
| D30 | เขียนลง DB ตอนไหน | **ตอนกดยืนยันเท่านั้น** — Member วงส่วนตัว และ `app_user` เกิดพร้อมบิลใบแรกใน transaction เดียว | ระบบนี้ไม่มี hard delete ที่ไหนเลย (D18 ห้ามลบ Member · วงมีแค่ soft-delete) แถวที่เกิดจากคนที่แค่ทักมาแล้วหายไปจึงอยู่ตลอดกาล · กฎเดียวใช้ทั้งระบบดีกว่าตัดสินทีละที่ |
| D31 | `ยอด` หน้าตา | **Flex card ตอบในแชท · ทั้งวง · จัดกลุ่มตามเจ้าหนี้ · ไม่ตัด** | LIFF อยู่ Phase 2 ทั้งก้อน ลากเข้ามาเพื่อคำสั่งเดียวไม่คุ้ม และของที่ต้องกดเข้าไปดูทีละคนทิ้งแรงกดดันทางสังคมซึ่งเป็นสิ่งเดียวที่เรามีแทน push (C2/C3) · ทั้งวงเพราะ §3 เขียนไว้แบบนั้นและตอบได้โดยไม่ต้องรู้ว่าใครถาม ซึ่งสำคัญเพราะ D29 ถามตัวตนบนการ์ด Draft เท่านั้น คนที่ยังไม่เคยจดบิลจึงยังไม่มี Member · จัดกลุ่มตามเจ้าหนี้เพราะคนพิมพ์ `ยอด` คือคนที่ควักเงินไปก่อน เขาหาชื่อตัวเองในหัวบล็อกแล้วอ่านจบในที่เดียว · ไม่ตัดเพราะ Phase 1 ไม่มี LIFF ให้ไปดูส่วนที่ถูกตัด และ ledger ที่ซ่อนยอดโดยไม่มีทางเปิดดูรับไม่ได้ — เพดาน Flex ไม่ใช่ตัวบังคับ (bubble ละ 10 KB, 28 แถวราว 3 KB) |
| D32 | Passive Nag บนการ์ด `ยอด` | **ไม่ต่อท้าย** — โทน Escalation แปะในแถวของคู่ที่มันพูดถึงแทน | `CONTEXT.md` เดิมสั่งให้ต่อท้ายผลของ `ยอด` ทั้งที่ `ยอด` ทั้งใบคือยอดค้างอยู่แล้ว = พูดซ้ำสองรอบในข้อความเดียว · Escalation คือ**โทนของยอด** ตามนิยามของมันเอง ไม่ใช่ยอดชุดที่สอง แปะข้างแถวจึงชี้ตัวคนได้ตรง ส่วน footer แยกบังคับให้คนอ่านจับคู่ชื่อจากสองที่ · Nag ยังต่อท้ายผลยืนยันบิลและไกด์เหมือนเดิม |
| D33 | อายุหนี้ของคู่ | **บิลเก่าสุดที่ยังเหลือยอดเมื่อไล่หักแบบเข้าก่อนออกก่อน** · ฟิลด์วันที่ใน `lib/types.ts` เติมตอน Phase 2 | `settlement` ไม่ได้ชี้ `expense` ใบไหน คำว่า "บิลใบนี้ยังไม่ถูกจ่าย" จึงไม่มีอยู่ในระบบ ต้องนิยามขึ้นมา · ใช้บิลล่าสุดไม่ได้เพราะคนค้างสองเดือนจะรีเซ็ตทุกครั้งที่โดนหารบิลใหม่ ซึ่งกลับหัวเจตนาของ Escalation · ใช้บิลเก่าสุดเฉยๆ ไม่ได้เพราะคู่ที่จ่ายของเก่าครบแล้วจะแก่ค้างตลอดไป · อยู่ใน `lib/debt.ts` ที่เดียวตาม D25 · **ไม่เติมฟิลด์วันที่ตอนนี้** เพราะ Phase 1 ไม่มีใครอ่าน และฟิลด์ที่ยังไม่มีคนอ่านคือฟิลด์ที่ไม่มีเทสต์คุมความหมาย |
| D34 | `ยอด` ที่มีอะไรต่อท้าย | ตอบว่า**ยังไม่เปิดใช้** ไม่แสดงยอด | `ยอด #เชียงใหม่` ตกเป็น `unparsed` แล้วเงียบตามโค้ดปัจจุบัน ซึ่งขัดกับเกณฑ์เดียวกับที่ใช้ตัดสิน `@บิลใหญ่` เดี่ยวๆ — เจตนาชัด 100% ไม่ใช่อุบัติเหตุ · แต่จะตอบยอดทั้งวงเฉยๆ ก็ไม่ได้ เพราะนั่นคือตอบผิดคำถามแบบเงียบ ซึ่งใน ledger เท่ากับยอดผิด · ตอบยอดพร้อม disclaimer ก็ไม่เอา เพราะการ์ดจะมีสองความหมายในใบเดียวและคนที่กวาดตาผ่านจำแค่ตัวเลข · ใช้รายชื่อคำสั่งที่ยังไม่พร้อมที่เก็บไว้ที่เดียว พอ Phase 3 ลงของจริงชื่อออกจากรายการแล้วข้อความหายเอง · **แคบลงตอนลงมือ (M4): นับเป็นคำสั่งเฉพาะเมื่อส่วนต่อท้ายเป็น `#tag` ล้วน** — `ยอด` เป็นชื่อคนได้ และ `ยอด มาไหม` คือประโยคที่คนในกลุ่มคุยกันเอง การตอบ "ยังไม่เปิดใช้" ใส่บทสนทนาแบบนั้นคือสิ่งเดียวกับที่กฎเงียบมีไว้กัน ส่วน `#` ไม่มีใครพิมพ์โดยบังเอิญ |
| D35 | `spentAt` มาจากไหน | **`timestamp` ของ message event แปลงเป็นวันที่ `Asia/Bangkok` แช่ไว้ตั้งแต่ตอนสร้าง draft** · ไม่มีไวยากรณ์ให้พิมพ์วันที่เอง | ไวยากรณ์ในแชทไม่มีที่ให้ใส่วันที่ และเพิ่มให้กับสิ่งที่ถูกอยู่แล้วเกือบทุกครั้งชนกับ D19 · ใช้ `now()` ตอนกดยืนยันไม่ได้ เพราะบิลมื้อดึกที่กดข้ามเที่ยงคืนจะได้วันถัดไป และเพราะ ADR 0001 กังวลเคสการ์ดค้างไว้เองแล้ว — แช่ตั้งแต่ draft แก้ที่ต้นทาง (กฎหมดอายุ 24 ชม. ยังต้องอยู่ ด้วยเหตุผลอื่นคือ Roster เปลี่ยนและเจตนาเก่า) · ใช้ timestamp ของ event ไม่ใช่ `now()` ของเรา เพราะ LINE retry ทีหลังหรือ function ช้าต้องไม่ทำให้วันที่ขยับ · แปลงด้วย `Intl.DateTimeFormat` + `timeZone: 'Asia/Bangkok'` ให้ชื่อโซนสะกดเหมือน `lib/repo/llm.ts` ฝั่ง SQL — grep คำเดียวเจอทุกที่ที่ระบบตัดสินขอบวัน · **ผลต่อ migration: `expense_draft` ต้องมีคอลัมน์ `spent_at`** |
| D36 | reply ยิงไม่ออก | **ตอบ 200 เมื่อเขียน DB ไปแล้ว** · 500 เมื่อยังไม่ได้เขียนอะไรและ retry แล้วผลอาจต่าง (env หาย, DB ล่มก่อนเขียน) | postback ที่ `commitExpense` สำเร็จแล้วแต่ reply พัง ถ้าตอบ 500 LINE จะ retry แล้วเจอว่า draft ถูกลบไปตอน commit → ตอบ "การ์ดเก่าแล้ว พิมพ์ใหม่" ทั้งที่บิลลงเรียบร้อย → คนพิมพ์ซ้ำ = บิลซ้ำจริง · retry มีประโยชน์เฉพาะกับความล้มเหลวที่ retry แล้วผลต่าง ส่วนความล้มเหลวหลังเขียน DB ไปแล้ว retry ทำได้แค่ทำให้เละกว่าเดิม · ฝั่ง draft ที่เขียน draft ลงไปแล้วแต่ reply ไม่ออกก็เหมือนกัน — ไม่มีการ์ด คนพิมพ์ใหม่เอง ของเก่าหมดอายุใน 24 ชม. · **เกณฑ์คือ "เขียนลงไปแล้วหรือยัง" ไม่ใช่ "เข้า handler แล้วหรือยัง"** — `lib/line/webhook.ts` ตอบ 500 ตอน DB ล่มมาตั้งแต่ M3 ซึ่งถูกและต้องคงไว้ เพราะตอนนั้นยังไม่มีอะไรถูกเขียน การ retry จึงยังกู้บิลที่คนพิมพ์กลับมาได้ · log ต้องแยกให้ออกว่า reply พังกี่ครั้ง เพราะเป็นอาการเดียวที่บอกว่า access token หมดอายุหรือโดน rate limit |
| D37 | แตก Phase 1 ยังไง | **สี่ก้อน M4–M7** — พูดกลับได้ / draft เกิดและแสดงได้ / ยืนยันแล้วลง ledger / `ยอด` | รอยต่อ M5–M6 ไม่ใช่การแบ่งตามความสะดวก มันคือรอยต่อที่ D28 ขีดไว้แล้ว ("อ่านตอน draft เขียนตอนยืนยัน") — M5 ไม่เขียนอะไรลง ledger เลย M6 คือเส้นทางเขียนทั้งหมด ทบทวนโค้ดที่แตะเงินได้เป็นก้อนเดียวโดยไม่มี rendering ปน · M4 แยกออกมาเพราะเป็นรอบแรกที่ยิง reply API ของจริง ถ้า access token หรือ scope ผิดจะรู้ตั้งแต่ก่อนมี draft ให้เสีย · ยุบ M5+M6 เข้าด้วยกันจะกลายเป็นก้อนที่ใหญ่ที่สุดในโปรเจกต์ และเป็นก้อนที่ผิดแล้วแพงที่สุดด้วย |
| D38 | `expense_draft` หน้าตา | payload เป็น **`jsonb` ก้อนเดียว** · **`line_user_id` ของคนพิมพ์ `not null` ทุกใบ** · `group_id` nullable | ดู `docs/adr/0001-expense-draft-table.md` |
| D39 | ตัด mention ของใครบ้าง | **ตัดเฉพาะ mention ที่เรียกบอท (`isSelf`) ของคนอื่นไม่แตะเลย** | เขียนครั้งแรกให้ตัดทุกอันโดยให้เหตุผลว่า mention เป็นเครื่องหมายว่าพูดกับใคร ไม่ใช่เนื้อความ — **ผิดและอันตราย**: `@กอล์ฟ เลิก` เหลือคำว่า `เลิก` ซึ่งตรงกับคำสั่งพอดี แล้วบอทจะโพล่งเข้าไปในบทสนทนาที่ไม่ได้พูดกับมัน ซึ่งเป็นสิ่งเดียวที่กฎเงียบมีไว้กัน · ผลข้างเคียงที่ต้องรู้ตัว: `@All ยอด` **เงียบ** เพราะ `@All` ยังอยู่ในข้อความแล้วทำให้ไม่ตรงคำสั่ง ซึ่งตรงกับที่ตัดสินไว้แล้วว่า `@All` ไม่เข้า Trigger · และ `@กอล์ฟ` ที่ถูกเอ่ยในบิลรอดไปถึง parser แทนที่จะหายเงียบ (ดูของค้างของ M5 ท้าย `docs/PLAN-M4.md`) |
| D40 | ถูก mention แล้วแปลไม่ออก | **ตอบไกด์ ไม่เงียบ** | กฎเงียบมีเหตุผลข้อเดียวคือ "อย่าพูดแทรกบทสนทนาของคนอื่น" · คนที่พิมพ์ `@บิลใหญ่ ช่วยหน่อย` กำลังพูดกับบอทตรงๆ ไม่ได้คุยกับใครอยู่ เหตุผลจึงหายไปแบบเดียวกับในแชท 1:1 · เงียบใส่คนที่เพิ่งเรียกชื่อเรา อ่านออกมาได้อย่างเดียวว่าบอทเสีย |

### การตัดสินใจที่ตกลงระหว่างทาง (ไม่ได้อยู่ใน 19 ข้อ)

- **เก็บทุกจำนวนเป็นสตางค์ (integer)** — ไม่มี float ที่ไหน. เศษจากการหารใช้
  largest-remainder แล้ว Payer รับเศษ. invariant: `Σ share = total + surcharge`
- **`surcharge_pct` หนึ่งตัวต่อบิล** — บิลร้านไทยคือ `รายการ → +10% → +7%`
  ถ้า itemized ไม่มีตัวนี้ ระบบพังทันทีในวันแรก · **ใช้เฉพาะฝั่ง LIFF ที่หารรายชิ้น
  ไม่ใช่ฝั่งไวยากรณ์ในแชท ซึ่งรับยอดสุดท้ายรวมทุกอย่างแล้ว** (ดู §3)
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

Trigger มีสามทางและเป็นทางเลือกกันทั้งหมด: `+` นำหน้า · คีย์เวิร์ดคำเดียว · **@mention bot**
ทางที่สามยังไม่มีในโค้ด (`lib/parser/rules.ts` ทำแค่สองทางแรก) ทั้งที่ `CONTEXT.md` นิยามไว้
ตั้งแต่ต้น — **ปิดช่องว่างนี้ใน Phase 1** · ตรวจด้วย `mention.mentionees[].isSelf` ของ message
event ซึ่งเอกสาร LINE นิยามว่า "whether the mention is to the bot (`destination`) that received
the webhook event" ไม่ใช่การเทียบชื่อในข้อความ

**ตัดสิน 2026-08-29: mention เป็นทางที่ "เพิ่ม" ไม่ใช่ทางที่ "แทนที่"** `+` ยังทำงานเหมือนเดิม
เหตุผลที่ไม่บังคับ mention: การจดบิลคือสิ่งที่ทำบ่อยที่สุดในระบบ บังคับ mention = เพิ่มขั้นตอน
(พิมพ์ `@` → รอ list → แตะชื่อ) ให้กับการกระทำที่ถี่ที่สุด ซึ่งชนกับ D19 โดยตรง · ส่วน false
positive อย่างเบอร์โทร `+66812345678` ไม่ได้สร้างเสียงรบกวนอีกแล้วเพราะ `unparsed` ถูกตัดสิน
ให้เงียบ

**ที่ยกไปตัดสินตอน Phase 4:** ตอนมี LLM แล้ว `unparsed` จะถูกส่งออกไปนอกระบบ เบอร์โทรที่หลุด
เข้ามาทาง `+` จะเดินทางไปด้วย — เกณฑ์ "ส่งเข้า LLM เฉพาะข้อความที่ mention bot" มีเหตุผลเต็มตัว
ตรงนั้น และทำได้โดยไม่ต้องแตะ Trigger ของการจดบิลเลย

การตัดมี mention ออกจากข้อความเป็นงานของชั้น adapter (`lib/line/`) เพราะ `index`/`length` เป็น
ของ LINE ล้วน — `lib/parser/` ไม่ควรรู้จักคำว่า mentionee เลย · ชั้น parser เปิดทางเข้าที่สอง
รับข้อความที่ตัด mention ออกแล้ว **โดยไม่แตะ `parseMessage` เดิม** ซึ่ง `lib/contract.test.ts`
ล็อกไว้ทั้งชุด

สามเคสของ mention ที่ตัดสินแล้ว (2026-08-29):

| ข้อความ | ผล | ทำไม |
|---|---|---|
| `@All` | **ไม่เข้า Trigger** | `type: "all"` `isSelf: false` — เรียกทุกคน ไม่ได้เรียกบอท · ถ้านับ mention ทุกชนิด bot จะโผล่ทุกครั้งที่ใครประกาศอะไร |
| `@บิลใหญ่ ยอด` | คำสั่ง `balance` | adapter ตัด mention แล้ว trim ก่อนเทียบ `COMMANDS` |
| `@บิลใหญ่` เดี่ยวๆ | **ทักทาย + ไกด์วิธีใช้** | เจตนาชัดว่าเรียกบอท ไม่ใช่ false positive — เป็นข้อยกเว้นเดียวของกฎ "เงียบ" และเป็นที่เดียวที่คนใหม่ในกลุ่มจะได้เห็นไวยากรณ์โดยไม่มีใครสอน (D19) |

ข้อสุดท้ายเพิ่มค่าใหม่ให้ `BotCommand` ใน `lib/types.ts` · ไฟล์นั้นถูกประกาศว่า "สัญญากลาง
ห้ามแก้" ใน `docs/PLAN-M1/M2/M3.md` — **ข้อห้ามนั้นมีขอบเขตแค่ M1–M3** ซึ่งเขียนไว้กัน agent
หลายตัวแก้ไฟล์เดียวกันพร้อมกัน ไม่ใช่กฎถาวร · Phase 1 เพิ่มค่าได้ แต่ต้องเป็นการเพิ่มแบบตั้งใจ
และ TypeScript จะบังคับให้ทุก `switch` ที่แตะ `BotCommand` อัปเดตตาม ซึ่งเป็นสิ่งที่ต้องการ

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

**ยอดที่พิมพ์คือยอดที่จ่ายจริง รวมค่าบริการและ VAT แล้ว** — ไวยากรณ์ไม่มีสัญลักษณ์ใส่
surcharge และไม่ควรมี · คนที่ถือใบเสร็จอยู่เห็นยอดสุดท้ายชัดที่สุด (ตัวใหญ่ล่างสุด)
การให้เขาแปลงกลับเป็นยอดก่อน VAT เพื่อมาพิมพ์เปอร์เซ็นต์คือการสั่งให้ทำเลขโดยไม่จำเป็น
`lib/parser/rules.ts` จึงคืน `surchargePct: 0` เสมอ **โดยตั้งใจ ไม่ใช่ของค้าง** และ
`lib/parser/rules.test.ts` ล็อกไว้แล้ว

`surcharge_pct` ในตาราง `expense` ยังจำเป็นจริง แต่เป็นของ **โหมด itemized ซึ่งเป็นงานของ
LIFF (Phase 2)** — ตอนหารรายชิ้น ค่าบริการต้องกระจายตามสัดส่วนของแต่ละชิ้น จะกดรวมไว้ใน
ยอดเดียวไม่ได้ · **สองอย่างนี้อยู่คนละ surface** ซึ่งเอกสารไม่เคยเขียนไว้ และเป็นสาเหตุที่
มันดูเหมือนบั๊กทั้งที่ไม่ใช่ (ชี้แจง 2026-08-30)

ทุกคำสั่งที่สร้างบิลตอบกลับเป็น **Draft card** ที่โชว์ชื่อทุกคนที่จะโดนหารและยอด
รายคน กด "ยืนยัน" ถึงลง ledger. rule parser จับรูปแบบข้างบน; อะไรที่ไม่เข้าไป
Haiku 4.5 แปลงเป็น JSON เดียวกัน

**คำสั่งที่ยังไม่มีของ (`ทวง` `แก้` `เลิก` ในช่วง Phase 1) ตอบว่ายังไม่เปิดใช้ ไม่เงียบ**
(ตัดสิน 2026-08-30) — พิมพ์คำสั่งคำเดียวไม่มีทางเป็นอุบัติเหตุ เจตนาชัด 100% ต่างจาก `unparsed`
โดยสิ้นเชิง และเป็นเกณฑ์เดียวกับที่ใช้ตัดสินว่า `@บิลใหญ่` เดี่ยวๆ ต้องได้คำตอบ · **ไกด์ต้องไม่
โฆษณาคำสั่งที่ยังไม่มี** ไกด์โตตามเฟส · เก็บรายชื่อคำสั่งที่ยังไม่พร้อมไว้**ที่เดียว** พอเฟสถัดไป
ลงของจริงก็เอาชื่อออกจากรายการนั้นแล้วข้อความหายไปเอง ไม่ใช่ `if` กระจายอยู่หลายที่ที่ต้องไล่จำ

**`ยอด` ในวงที่ยังไม่มีบิลเลยตอบไกด์ ไม่ตอบว่า "ยอดเป็น 0"** — ใช้เกณฑ์เดียวกับไกด์ใน 1:1

**กฎ "เงียบ" นี้เป็นของแชทกลุ่มเท่านั้น** เหตุผลของมันคือ "อย่าพูดแทรกบทสนทนาของคนอื่น" —
ในแชท 1:1 ไม่มีบทสนทนาของคนอื่นให้แทรก เหตุผลหายไป กฎจึงไม่ตามไปด้วย: **1:1 ตอบไกด์**
และตั้ง **greeting message** ใน OA Manager ให้ยิงตอนคนแอดบอทเป็นเพื่อน (ฟรี ไม่กินโควตา
ไม่ต้องเขียนโค้ด) · หมายเหตุ: `docs/SETUP-LINE-OA.md` สั่งให้ **ปิด** greeting/auto-reply
ตอนทำ spike เพื่อไม่ให้ตอบทับข้อความที่ต้องสังเกต — **Phase 1 ต้องกลับไปเปิดและเขียนข้อความจริง**

**ตั้งแต่ Phase 1 ถึงก่อน Phase 4 ยังไม่มี Haiku — `unparsed` ในกลุ่มให้ bot เงียบ ไม่ตอบอะไรเลย**
(ตัดสิน 2026-08-29) ค่าผิดพลาดสองข้างไม่เท่ากัน: ตอบผิดใส่บทสนทนาที่ไม่เกี่ยวกับบิล
= โดนเตะออกจากกลุ่ม = จบเกม · ส่วนคนที่พิมพ์ผิดจริงแล้วไม่มีอะไรตอบ เขาพิมพ์ใหม่เอง
ซึ่งเป็นสิ่งที่คนทำอยู่แล้วโดยธรรมชาติ · เก็บเป็น**ตัวนับความถี่ ไม่เก็บตัวข้อความ** —
พอถึง Phase 4 ตัวเลขนั้นคือสิ่งที่บอกว่า LLM ต้องรับเคสแบบไหน และการจะเก็บข้อความจริง
หรือไม่เป็นการตัดสินใจเรื่อง PDPA ที่ต้องคุยแยก ไม่ใช่ผลพลอยได้จากการทำ logging

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
                    Draft card ──reply (ฟรี)──▶ กลุ่ม   (ไม่มี Passive Nag ต่อท้าย)
                            │ postback "ยืนยัน"
                    commit expense + shares  ──reply──▶ กลุ่ม + Passive Nag ต่อท้าย

แชท 1:1 ──webhook──▶ เส้นทางเดียวกัน แต่ resolve เป็นวงส่วนตัวของคนพิมพ์ (D21)
   └── ข้อความที่ไม่เข้า Trigger **ตอบไกด์** ไม่เงียบแบบในกลุ่ม — เฉพาะตอนวงนั้นยังไม่มี
       Expense สักใบ (ตัดสิน 2026-08-29) · เกณฑ์นี้ถามคำถามที่ถูกกว่า "เคยเห็นไกด์หรือยัง"
       คือ "ยังจดบิลไม่สำเร็จสักใบใช่ไหม" — คนที่เห็นไกด์แล้วยังจดไม่เป็นควรได้เห็นอีก
       และมันหยุดเองเมื่อจดใบแรกได้ **ไม่ต้องเพิ่มคอลัมน์ ไม่ต้องมี migration ใหม่**

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

**ผลจริง: ผ่านทั้งสี่ข้อ** — S1 กับ S3 เมื่อ 2026-08-26 · S4 เมื่อ 2026-08-27 · S2 เมื่อ 2026-08-29
ไม่มีข้อไหนบังคับให้กลับมาแก้การตัดสินใจข้อไหนเลย · ตัวเลขและเงื่อนไขเต็มอยู่ที่ `docs/SPIKE-PHASE0.md`
สิ่งที่เปลี่ยนจาก spike คือเพดานโควตาใน C2 (500 → 300) ซึ่งเป็นการแก้ข้อเท็จจริง ไม่ใช่แก้การตัดสินใจ

---

## 8. ลำดับงาน

**Phase 0 — spike** (S1–S4 ข้างบน) สร้าง LINE OA จริง + LIFF app + ยิงของจริง

**Phase 1 — จดได้ หารถูก**
schema + webhook + signature verify + Trigger filter + rule parser + Draft card +
commit + `ยอด` + Placeholder/Roster ที่โตเอง + **วงส่วนตัวในแชท 1:1** (D21 —
resolve วงจาก `source.type` เท่านั้น ทางที่เหลือใช้โค้ดร่วมกันทั้งหมด)
เทสต์ที่ต้องมี: invariant `Σ share = total + surcharge` ทุก split mode, เศษ
largest-remainder, Debt รายคู่

แตกเป็นสี่ก้อนตาม D37 — รอยต่อ M5/M6 คือรอยต่อของ D28 ("อ่านตอน draft เขียนตอนยืนยัน"):

| ก้อน | ได้อะไรตอนจบ |
|---|---|
| **M4 พูดกลับได้** | event adapter · ตัด mention · reply client + `LINE_CHANNEL_ACCESS_TOKEN` · ไกด์ · รายชื่อคำสั่งที่ยังไม่เปิด (D34) · `@บิลใหญ่` เดี่ยวๆ · ไกด์ใน 1:1 — **ไม่แตะ DB เลย** |
| **M5 draft เกิดและแสดงได้** | migration `0002` (D38) · repo `expense_draft` · resolve วง · อ่าน Roster · ป้าย `(ใหม่)` (D28) · `spentAt` (D35) · Flex draft card — **ปุ่มยังไม่ทำงาน ไม่เขียน ledger** |
| **M6 กดยืนยันแล้วลง ledger** | postback → โหลด draft → `commitExpense` + `delete draft` ใน transaction เดียว · หมดอายุ 24 ชม. · D29 ถามตัวตน · D26 เฉพาะคนพิมพ์ · วงส่วนตัวเกิดตอนยืนยัน (D30) |
| **M7 `ยอด`** | `loadLedger` + `computeDebts` → Flex ตาม D31 · ปิด Phase 1 |

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

**ยืนยัน 2026-08-29: LLM เข้าเป็นชิ้นสุดท้ายจริงๆ ไม่ขยับขึ้นมา Phase 1**
เหตุผลไม่ใช่ราคา (~280฿/เดือนที่ 1,000 บิล/วัน ซึ่งยังไม่มีทางถึง) แต่เป็นเพราะ **LLM เป็นตัวเดียว
ที่ทำให้ต้องตัดสินเรื่อง async webhook** — เอกสาร LINE แนะนำให้ประมวลผล webhook แบบ asynchronous
และระบุว่า reply token **หมดอายุได้และใช้ได้ครั้งเดียว** (error `Invalid reply token` เกิดจาก
"expired reply token" หรือ "used reply token") โดย**ไม่ประกาศตัวเลข TTL** ส่วน retry ก็
"ไม่เปิดเผยจำนวนและช่วงเวลา และเปลี่ยนได้โดยไม่แจ้ง"

แปลว่าถ้าวางงานที่กินเวลาระดับวินาทีไว้ก่อนตอบ reply เรากำลังเดิมพันกับตัวเลขที่ LINE ไม่บอก
และถ้าเดิมพันแพ้ ทางออกเดียวคือ push ซึ่งกินโควตา 300/เดือน (C2) — กลุ่ม 8 คนครั้งละ 8
เส้นทางของ Phase 1–3 ไม่มีอะไรกินเวลาเกินมิลลิวินาที (S4: warm 3.6–4.4 ms) จึงไม่ต้องตัดสิน
เรื่องนี้เลยจนกว่าจะถึง Phase 4 และตอนนั้นจะมีข้อความจริงให้ดูแล้วว่า `unparsed` หน้าตายังไง

Phase 1 กับ 2 คือของจริง. Phase 3 คือสิ่งที่ทำให้คนไม่เลิกใช้. Phase 4 คือสิ่งที่
ทำให้ปล่อย public แล้วไม่เจ็บตัว
