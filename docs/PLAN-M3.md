# Plan — M3: Next.js scaffold ที่ deploy ได้ เพื่อปลดล็อก S2 + S4

ขอบเขตรอบนี้: **โครง Next.js (D14) + webhook route ที่ verify signature จริง + หน้า LIFF
สำหรับ spike + deploy ขึ้น Vercel** — ทำแค่พอให้ S2 กับ S4 ยิงของจริงได้ ไม่ใช่ Phase 1

ทำไมทำตอนนี้: S2 กับ S4 ติดของชิ้นเดียวกันคือ **ยังไม่มีที่ deploy** ทั้งคู่ต้องการ
endpoint https ที่มีอยู่จริงบนอินเทอร์เน็ต ทำโครงรอบเดียวปลดล็อกทั้งสองข้อ

`lib/` ที่เป็น domain core (`money` `split` `debt` `parser`) **ไม่ถูกแตะเลยรอบนี้**

---

## กติกาที่บังคับ (ต่อจาก M1/M2)

- **TDD จริง** — เขียนเทสต์ให้แดงก่อน แล้วค่อยเขียนโค้ดให้เขียว ห้ามสลับ
- ห้าม `any` ห้าม `as` ที่ไม่จำเป็น ห้าม `console.log` ค้าง ห้าม `.skip`
- **`npm test` ต้องรันได้โดยไม่ต้องมี Docker และไม่ต้องมี env จริง** — ของใหม่ทุกชิ้น
  ที่เทสต์ได้ต้องรับค่าเป็นพารามิเตอร์ ไม่ใช่ไปอ่าน `process.env` เอง
- `lib/db/client.ts` `lib/types.ts` `lib/db/rows.ts` `supabase/migrations/*.sql`
  ยังเป็นสัญญากลาง **ห้ามแก้**
- **repo เป็น public** — ห้ามมี secret, เบอร์จริง, `groupId`/`userId` จริงในโค้ดหรือเอกสาร

---

## สิ่งที่ทำ

### 1. โครง Next.js (D14)

`next` + `react` + `react-dom` (App Router) · ไม่ลง Tailwind/ESLint/UI kit รอบนี้ —
หน้าตาไม่ใช่คำถามของ S2 และทุกอย่างที่ลงตอนนี้คือของที่ต้องดูแลต่อ

tsconfig ต้องคงธงเข้มไว้ครบหลัง Next patch: `strict` `noUncheckedIndexedAccess`
`noImplicitOverride` `exactOptionalPropertyTypes`

### 2. `lib/line/signature.ts` — verify `X-Line-Signature` (TDD)

ฟังก์ชันบริสุทธิ์ รับ raw body + header + channel secret คืน boolean
**ไม่อ่าน `process.env` เอง** ผู้เรียกเป็นคนหามาให้ → เทสต์ยูนิตไม่ต้องมี env

- HMAC-SHA256 ของ **raw body** ด้วย channel secret แล้ว base64 (ตามสเปก LINE)
- เทียบแบบ **timing-safe** (`crypto.timingSafeEqual`) หลังเช็คความยาวเท่ากันก่อน
- header ที่ไม่ใช่ base64 / ยาวผิด / ว่าง → `false` ไม่ throw

เทสต์ที่ต้องมี: signature ถูก → true · แก้ body ทีละไบต์ → false · secret ผิด → false ·
body ภาษาไทย (multi-byte) ต้องแฮชจาก **bytes** ไม่ใช่ code point · header ขยะ → false
ไม่ throw · **ชุดตรวจอิสระ** คำนวณ HMAC ด้วยเส้นทางคนละแบบในเทสต์แล้วเทียบ

### 3. `app/api/line/webhook/route.ts`

เส้นทางตามที่ `docs/SPIKE-PHASE0.md` S4 ข้อ 1 สั่งไว้เป๊ะ:
**verify signature → query Supabase หนึ่งครั้ง → ตอบ 200**

- `runtime = 'nodejs'` (ต้องใช้ `pg` — edge รันไม่ได้) · `dynamic = 'force-dynamic'`
- `preferredRegion = 'sin1'` — S4 บันทึกไว้เองว่า default ของ Vercel ไม่ใช่สิงคโปร์
  และระยะทางอาจกินเวลามากกว่า cold start
- อ่าน body ด้วย `req.text()` (raw) **ก่อน** `JSON.parse` — แฮชต้องคิดจากไบต์ที่มาจริง
- signature ไม่ผ่าน → `401` และ**ไม่แตะ DB** (กันคนนอกปลุก Supabase free เล่น)
- DB probe = `findGroupByLineGroupId` ตัวเดิมของ M2 (read-only) ไม่เขียนอะไรทั้งนั้น
- ตอบ `200` เสมอเมื่อ signature ผ่าน แม้ event จะไม่มีอะไรให้ทำ (LINE ถือว่า non-200 = ต้อง retry)
- ใส่ header `Server-Timing: db;dur=… total;dur=…` ให้ S4 วัดแยกได้ว่าช้าที่เน็ตหรือที่ DB
- log `x-line-retry-key` ที่ได้รับ (ตารางบันทึกผล S4 ถามข้อนี้) — ผ่าน `console.warn`
  ที่มีเหตุผลกำกับ ไม่ใช่ `console.log` ค้าง

**ยังไม่ทำในรอบนี้:** parse event, Trigger filter, Draft card, commit — นั่นคือ Phase 1

### 4. `app/liff/spike/page.tsx` — หน้าเดียวสำหรับ S2

`@line/liff` · client component · `NEXT_PUBLIC_LIFF_ID` จาก env

หน้าโชว์ `liff.getContext().type` / `liff.isInClient()` / `os` แล้วมีปุ่มเดียวเรียก
`liff.sendMessages()` ส่งข้อความสั้น · โชว์ error ที่ได้บนหน้าจอ (มือถือเปิด devtools ไม่ได้)

หน้านี้ไม่แตะ DB ไม่แตะ API ของเรา — **ยังไม่มี ID token verify** ตาม D15 เพราะยังไม่มี
request ที่ต้อง authorize; ตอนทำ Phase 2 จริงต้อง verify ทุก request

### 5. env + เอกสาร deploy

`.env.local.example` เพิ่ม `LINE_CHANNEL_SECRET` และ `NEXT_PUBLIC_LIFF_ID` (ค่าว่าง)
เอกสารขั้นตอน deploy + วิธียิง S4 ให้ถูก เขียนต่อท้าย `docs/SETUP-LINE-OA.md` หรือแยกไฟล์

**secret ทั้งหมดอยู่กับผู้ใช้** — คำสั่งที่ใช้ token ต้องเขียนให้อ่านจาก `$env:` แล้วผู้ใช้
รันในเทอร์มินัลตัวเอง ห้ามรันผ่าน `!` ในแชท

---

## การตัดสินใจใหม่ที่รอบนี้บังคับให้ตัด

| # | เรื่อง | เลือก | เพราะ |
|---|---|---|---|
| — | curl ของ S4 ในเอกสาร | **ต้องแก้** ให้เซ็น signature จริง | ของเดิมส่ง `x-line-signature: dummy` ซึ่งจะโดน 401 ตั้งแต่ก่อนแตะ DB → วัด cold start ของ Supabase ไม่ได้เลย |
| — | ที่อยู่ของ adapter LINE | `lib/line/` | DESIGN บอกว่า *core* (parser/split/debt/settlement) ต้องไม่รู้จัก LINE — ตัว adapter แยกโฟลเดอร์ชัดเจนไม่ขัดข้อนี้ |
| — | region | `sin1` ทั้ง function | S4 เขียนเองว่า region สำคัญกว่า cold start |

---

## เกณฑ์ว่าเสร็จ

```
npm test            236 + เทสต์ใหม่ เขียวหมด (ไม่ต้องมี Docker)
npm run test:db     295 เขียว (ต้องเปิด Docker)
npx tsc --noEmit    ผ่าน
npm run build       ผ่าน
grep -rn "any\|console.log\|\.skip" lib app   ไม่เจอของค้าง
```

แล้วจึง: deploy ขึ้น Vercel → ชี้ webhook ของ LINE มาที่ URL จริง → สร้าง LIFF app
(ติ๊ก scope `chat_message.write`) → **ผู้ใช้** เป็นคนยิง S2 กับ S4 แล้วเอาผลมาบันทึกลง
`docs/SPIKE-PHASE0.md`

`webhook.site` ที่ตั้งไว้ชั่วคราวต้องถอดตอนชี้มาที่ของจริง — URL นั้นใครเปิดก็เห็น
`groupId`/`userId` จริง
