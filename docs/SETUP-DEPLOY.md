# Deploy — Supabase + Vercel + LIFF (ทำครั้งเดียว)

เอกสารนี้พาไปถึงจุดที่ **S2 กับ S4 ยิงของจริงได้** ต่อจาก `docs/SETUP-LINE-OA.md`
ซึ่งจบที่ "มี OA แล้ว บอทเข้ากลุ่มได้แล้ว webhook เห็น event แล้ว"

> **secret ทุกตัวอยู่กับผู้ใช้เท่านั้น** ทุกคำสั่งในไฟล์นี้อ่านค่าจาก `$env:` — รันใน
> เทอร์มินัลของตัวเอง **อย่ารันผ่าน `!` ในแชท** เพราะค่าจะไปโผล่ในบทสนทนา

---

## 1. Supabase — ฐานข้อมูล

1. `https://supabase.com/dashboard` → **New project**
2. **Region: `Southeast Asia (Singapore) ap-southeast-1`** — ต้องอยู่ที่เดียวกับ Vercel
   ไม่งั้นทุก query เดินทางข้ามทวีปก่อนตอบ ซึ่ง S4 เตือนไว้เองว่ากินเวลากว่า cold start
3. ตั้ง database password แล้ว**เก็บไว้** จะเห็นครั้งเดียว
4. รอโปรเจกต์ขึ้น แล้วไป **Connect** → เลือกแบบ **Transaction pooler**
   (โฮสต์จะมี `pooler.supabase.com` และพอร์ต **6543**)

   ห้ามใช้ direct connection พอร์ต 5432 — serverless หนึ่ง instance ต่อหนึ่ง request
   ถ้าต่อตรงจะกิน connection ของ Postgres จนเต็มตั้งแต่ทราฟฟิกยังน้อย
   (`lib/db/client.ts` เขียนเหตุผลไว้แล้ว)

5. สร้าง schema — รันไฟล์ migration ที่มีอยู่:

   ```powershell
   # รหัสผ่านอยู่ใน env ไม่ใช่ใน URI — password ที่ Supabase สุ่มมามี @ / ? # ได้
   # ถ้าฝังลง URI ตัว @ จะทำให้ libpq ตัด host ผิดที่ แล้ว error ที่ได้จะพูดเรื่อง
   # host resolve ไม่ได้ ซึ่งไม่มีอะไรบอกเลยว่าต้นเหตุคือรหัสผ่านต้อง URL-encode
   $env:PGPASSWORD = "<database password>"
   psql "postgres://postgres.<ref>@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres" -f supabase/migrations/0001_init.sql
   ```

   ไม่มี `psql` ก็วางเนื้อไฟล์ลง **SQL Editor** ในหน้าเว็บ Supabase ได้เหมือนกัน

   **ห้ามรัน `npm run db:reset` ใส่ Supabase** — สคริปต์นั้น drop schema ทิ้ง
   มันมีไว้ล้าง Postgres ใน Docker บนเครื่องเท่านั้น

---

## 2. Vercel — ที่ deploy

1. `https://vercel.com/new` → import repo `tchaokhu/BillYai`
2. Framework จะถูกตรวจเป็น Next.js เอง ไม่ต้องแก้ build command
3. **Environment Variables** ใส่ก่อนกด Deploy:

   | ชื่อ | ค่า | ใส่ที่ environment ไหน |
   |---|---|---|
   | `DATABASE_URL` | connection string แบบ pooler พอร์ต 6543 | Production |
   | `DB_POOL_MAX` | `2` | Production |
   | `LINE_CHANNEL_SECRET` | channel secret — แท็บ **Basic settings** | Production |
   | `LINE_CHANNEL_ACCESS_TOKEN` | long-lived channel access token — แท็บ **Messaging API** คนละตัวกับ secret | Production |
   | `PROMPTPAY_KEY` | 32 ไบต์สุ่ม base64 (คนละค่ากับที่ใช้บนเครื่อง) | Production |
   | `NEXT_PUBLIC_LIFF_ID` | ได้จากข้อ 4 — กลับมาใส่ทีหลังแล้ว redeploy | Production |

   `NEXT_PUBLIC_*` ถูกฝังลง bundle ฝั่ง client ตอน build — **ห้ามเอา secret ใส่ชื่อขึ้นต้นแบบนี้เด็ดขาด**
   และแก้ค่าแล้วต้อง redeploy ถึงจะมีผล (ต่างจาก env ฝั่ง server ที่อ่านตอน runtime)

4. หลัง deploy ครั้งแรก → **Settings → Functions → Region** ต้องเป็น **Singapore (sin1)**
   `vercel.json` ตั้งไว้ให้แล้ว แต่ยืนยันด้วยตาอีกที เพราะค่านี้ตัดสินตัวเลขของ S4 ทั้งหมด

5. โครง branch ตรงกับที่วางไว้: `main` → production, `dev` → preview URL ของตัวเอง

---

## 2.5 Preview environment — ต่อ DB คนละก้อนกับ production

**อย่าเอา `DATABASE_URL` ของ production ใส่ Preview** repo นี้เป็น public · Vercel ฉีด
Preview env เข้า deployment ที่ build จาก PR ทุกอัน ดังนั้น PR ที่แก้โค้ดให้พิมพ์
`process.env` ออกมา หรือให้ SELECT ทั้งตาราง ก็ได้ทั้งคีย์และข้อมูลจริงไปฟรีๆ
โดยที่ไม่ต้องได้สิทธิ์เขียน repo เลยสักนิด

### 0) ทำไมไม่ใช้ Supabase Branching

Supabase มีฟีเจอร์ Branching ที่สร้าง instance แยกต่อ PR แล้วรัน `supabase/migrations/`
ให้เอง ซึ่งตรงกับปัญหานี้กว่าการสร้าง project ที่สองมือเปล่าทุกประการ — **แต่มันเป็น
ฟีเจอร์ของแผน Pro** ($25/เดือน) บวก **$0.01344 ต่อ branch ต่อชั่วโมง** (Micro compute
≈ $0.32/วัน) · Free plan ใช้ไม่ได้ แต่ให้ **2 active project** ซึ่งพอดีกับที่ต้องการ

ที่ไม่เอาตอนนี้เพราะข้อได้เปรียบของมันทั้งสามข้อยังไม่มีข้อไหนออกฤทธิ์: dev คนเดียว
PR ทีละอัน branch เดียว และ migration ยังมีไฟล์เดียว — รันมือครั้งเดียวจบ

**ให้กลับมาดูใหม่เมื่อ** migration เริ่มหลายไฟล์จนการรันมือมีโอกาสทำ schema ของสอง
project เพี้ยนกัน (ซึ่งเป็นความเสี่ยงข้อเดียวของทางที่เลือกไว้ข้างล่างนี้) หรือเมื่อมี
หลาย PR พร้อมกัน หรือเมื่อขึ้น Pro ด้วยเหตุผลอื่นอยู่แล้ว

### 1) Supabase project ที่สอง

`New project` ชื่ออะไรก็ได้ที่แยกออก (เช่น `billyai-dev`) · **region ต้อง
`Southeast Asia (Singapore) ap-southeast-1` เหมือนตัว production** ไม่ใช่เพราะความเร็ว
แต่เพราะถ้า preview วิ่งบน latency คนละชุด ตัวเลขที่วัดได้จาก preview จะเอามาเทียบกับ
S4 ไม่ได้ แล้ว preview ก็หมดประโยชน์ในฐานะที่ซ้อมก่อนขึ้นจริง

รัน migration ตัวเดียวกัน — schema ต้องตรงกัน ไม่งั้น preview ผ่านแล้ว production พัง
ซึ่งเป็นสิ่งเดียวที่ preview มีไว้กัน:

**ตั้งรหัสผ่านเองเป็น hex ล้วน** ตอนสร้าง project — รหัสที่ Supabase สุ่มมามี `@ / ? # "` ได้
ซึ่งพังสองที่: `@` ทำให้ libpq ตัด host ผิดตำแหน่งแล้ว error พูดเรื่อง host resolve ไม่ได้
โดยไม่มีอะไรบอกว่าต้นเหตุคือรหัสผ่าน · `"` โดน PowerShell 5.1 กลืนตอนส่งต่อให้ .exe

```powershell
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

**ทางที่สั้นที่สุด: วางเนื้อ `supabase/migrations/0001_init.sql` (213 บรรทัด) ลง SQL Editor
แล้วกด Run** — ไม่ต้องลง `psql` ไม่ต้องเอารหัสผ่านผ่านเทอร์มินัล ไม่มีปัญหา encoding

ถ้าอยากได้แบบทำซ้ำได้ `billyai-db` (`postgres:17-alpine`) มี `psql` ติดมาอยู่แล้ว:

```powershell
docker cp supabase/migrations/0001_init.sql billyai-db:/tmp/0001_init.sql
docker exec -e PGPASSWORD='<รหัสผ่าน>' billyai-db psql "<connection string>" -f /tmp/0001_init.sql
```

ใช้ `docker cp` + `-f` ไม่ใช่ pipe เพราะ **PowerShell 5.1 ไม่รองรับ `<` redirect** (ขึ้น
`The '<' operator is reserved for future use.`) และ `Get-Content |` ทำ UTF-8 เพี้ยนตอนส่งให้ .exe

ตรวจว่าครบด้วย SQL Editor — ต้องได้ **10**:

```sql
select count(*) from information_schema.tables where table_schema = 'public';
```

ไฟล์นี้ไม่มี `if not exists` — รันซ้ำได้ `already exists` แปลว่าของขึ้นแล้ว ไม่ใช่พัง

connection string เอาจาก **Connect → Shared Pooler → Transaction → พอร์ต 6543**
**copy จากหน้าเว็บ อย่าพิมพ์เอง** — prefix host เป็น `aws-0-` หรือ `aws-1-` แล้วแต่ project

> **กฎที่ต้องถือตั้งแต่วันนี้:** migration ใหม่ทุกไฟล์ต้องรันใส่ **ทั้งสอง project ตามลำดับเดียวกัน**
> `lib/db/schema.db.test.ts` เฝ้า schema ให้เฉพาะ Postgres ใน Docker ที่ CI รัน — **มันไม่เคยเห็น
> Supabase ทั้งสองตัว** ถ้าสอง project เพี้ยนกัน จะไม่มีเทสต์ไหนจับได้ อาการที่ได้คือ preview ผ่าน
> แล้ว production พัง ซึ่งเป็นสิ่งเดียวที่ preview มีไว้กัน

### 2) `PROMPTPAY_KEY` คนละตัว

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

คีย์คนละตัวได้**ก็เพราะ**ใช้ DB คนละก้อน — `promptpay_cipher` เป็น AES-256-GCM
(`lib/crypto/promptpay.ts`) ถ้าวันไหนย้อนกลับไปใช้ DB ร่วมกันเมื่อไหร่ คีย์ต้องกลับมา
เป็นตัวเดียวกันทันที ไม่งั้น `decryptPromptPay` โยน
`ถอดรหัสเบอร์ PromptPay ไม่สำเร็จ — ข้อมูลถูกแก้ไข หรือคีย์ไม่ตรงกับตอนเข้ารหัส`
ซึ่งเป็นข้อความเดียวกับตอนข้อมูลถูกแก้ แยกไม่ออกว่าอันไหน

### 3) ใส่ลง Vercel — Environment = **Preview** และ **จำกัด branch เป็น `dev`**

Vercel ให้ผูก env var กับ branch ได้ ตั้งเป็น `dev` แล้ว deployment ของ branch อื่น
รวมถึง PR จากคนนอก จะไม่ได้ค่าพวกนี้ติดไปเลย · เป็นด่านที่สอง ไม่ใช่ด่านเดียว
(ด่านแรกคือ DB คนละก้อนตามข้อ 1)

| ชื่อ | ค่าสำหรับ Preview |
|---|---|
| `DATABASE_URL` | pooler ของ project **ที่สอง** พอร์ต 6543 |
| `DB_POOL_MAX` | `2` |
| `PROMPTPAY_KEY` | คีย์ใหม่จากข้อ 2 |
| `NEXT_PUBLIC_LIFF_ID` | ค่าเดียวกับ production ได้ (ไม่ใช่ secret) · visibility ต้องเป็น `config` |
| `LINE_CHANNEL_SECRET` | ของ **dev OA** ไม่ใช่ของ production — ดูข้อ 4 |
| `LINE_CHANNEL_ACCESS_TOKEN` | ของ **dev OA** ผูกกับ channel เดียวกับ secret ข้างบน |

### 4) dev OA — Messaging API channel ตัวที่สอง (ทำแล้ว 4 ก.ย. 2026)

**secret ของ production ห้ามใส่ Preview เด็ดขาด** ด้วยเหตุผลข้อบนสุด: repo เป็น public
และ Preview env ถูกฉีดเข้า deployment ที่ build จาก PR ทุกอัน · ใส่ค่ามั่วก็ไม่ได้อะไร
เพราะ `X-Line-Signature` จะไม่ตรงแล้ว `POST /api/line/webhook` ตอบ 401 ทุกครั้ง

ทางที่ถูกคือ **OA ตัวที่สองสำหรับ dev** ซึ่งตอนนี้มีแล้ว:

| | production | dev |
|---|---|---|
| OA | `บิลใหญ่` | `BillYai(Dev)` |
| Vercel env | Production | **Preview + branch `dev`** |
| DB | Supabase project หลัก | project ที่สอง (ข้อ 1) |
| webhook | โดเมน production | `https://bill-yai-git-dev-<scope>.vercel.app/api/line/webhook` |

**สร้างจาก OA Manager ไม่ใช่จาก Developers Console** — LINE ยกเลิกปุ่มสร้าง Messaging API
channel ในคอนโซลไปแล้ว ลำดับคือสร้าง OA ก่อนแล้วกด `ใช้งาน Messaging API` จากฝั่ง OA
(`SETUP-LINE-OA.md` ขั้น 1–6) · **ต้องเลือก provider เดิม** (`billyai-provider`) ไม่งั้น
LIFF ของ Phase 2 ใช้ใบเดิมไม่ได้ตาม D46 และย้าย channel ข้าม provider ทีหลังไม่ได้

**branch URL อยู่กับที่ ไม่ใช่ URL ต่อ deployment ที่เปลี่ยนทุกครั้ง** — ตั้ง webhook ครั้งเดียว
แล้วทุก push ขึ้น `dev` มีผลทันทีโดยไม่ต้องแก้ LINE อีก

env ทุกตัวถูกอ่านตอน runtime ไม่ใช่ตอน import (`getPool()` ใน `lib/db/client.ts`,
`loadKey()` ใน `lib/crypto/promptpay.ts`) จงใจเขียนไว้แบบนั้น — preview จึง build ผ่าน
แม้ env ยังไม่ครบ **และแปลว่าเพิ่ม env แล้วต้อง Redeploy เสมอ** ค่าผูกกับ deployment
ตอน deploy ไม่ได้อ่านสดทุก request

> **Deployment Protection ต้องปิดตลอดช่วงที่ dev OA ใช้งาน** — preview ถูกคุ้มอยู่ตั้งแต่ต้น
> ทุก request ที่ไม่ได้ล็อกอินได้ `302` ไป `https://vercel.com/sso-api?url=…` ไม่ใช่คำตอบของ route
> (ยืนยันกับ deployment จริงของ `fa0d9fd` แล้ว) · LINE ยิง webhook เข้าไปแล้วได้หน้า login
> ไม่ใช่ 200 · ปิดที่ Settings → Deployment Protection → `Vercel Authentication`
>
> **นี่คือราคาถาวรของทาง dev OA ไม่ใช่ของชั่วคราวระหว่างทดสอบ** — เปิดกลับเมื่อไหร่ dev OA
> ตายทันที · สิ่งที่ยังกันอยู่หลังปิด: ลายเซ็น `X-Line-Signature` (`401` ถ้าไม่ตรง) และ
> DB คนละก้อนกับ production · สิ่งที่หายไป: ใครก็เปิด preview URL ในเบราว์เซอร์ได้
>
> ผลพลอยได้: ตรวจ preview ด้วย `curl` จากข้างนอกได้แล้ว — สามบรรทัดนี้แยกสาเหตุได้ก่อน
> ไปแตะ LINE เลย
>
> ```
> GET  /                  → 200   protection ปิดจริง deployment มีชีวิต
> GET  /api/line/webhook  → 405   route อยู่ตรงนั้น (โค้ดตอบ 405 เฉพาะ GET)
> POST /api/line/webhook  → 401   secret ถึง deployment แล้ว (ค่าว่างได้ 500)
>      + ลายเซ็นมั่ว
> ```

### 5) ปิดทางที่เหลือ

Vercel → Settings → Git → **ห้ามเปิด deploy อัตโนมัติให้ PR จาก fork ของคนนอก**
ค่า default ของ Vercel ต้องกด authorize ก่อนอยู่แล้ว **อย่าปิดของกันนี้**

---

## 3. ชี้ webhook ของ LINE มาที่ของจริง

LINE Developers Console → channel → **Messaging API** → Webhook URL:

```
https://<โดเมนที่ Vercel ให้>/api/line/webhook
```

แล้วกด **Verify** — ต้องได้ `Success` (ปุ่มนี้ยิง request ที่**เซ็นถูกต้อง**มาให้ ถ้าได้
`401` แปลว่า `LINE_CHANNEL_SECRET` บน Vercel ไม่ตรงกับ channel นี้)

**ถอด `webhook.site` ออกตอนนี้** — URL นั้นใครเปิดก็เห็น `groupId`/`userId` จริงของกลุ่มที่ทดสอบ

---

## 4. สร้าง LIFF app (ต้องมีก่อนทำ S2)

**Messaging API channel เพิ่ม LIFF ไม่ได้แล้ว** — LINE ปิดทางนี้ไป ต้องสร้าง **LINE Login
channel** ขึ้นมาต่างหากแล้วเพิ่ม LIFF ที่นั่น (`https://developers.line.biz/en/docs/liff/registering-liff-apps/`)

> **Login channel ต้องอยู่ใน provider เดียวกับ Messaging API channel**
>
> เอกสาร LINE ระบุว่า `userId` ไม่ซ้ำกันในระดับ **provider** ไม่ใช่ระดับ channel
> ("the user ID is only unique to an individual provider") ถ้าสร้างคนละ provider
> คนคนเดียวกันจะได้ `userId` คนละตัวจาก LIFF กับจาก webhook แล้ว D4 (claim ตัวตน)
> กับ D10 (auto-suggest ชื่อ) พังทั้งคู่ — พังแบบเงียบ ไม่มี error อะไรฟ้อง
> มันจะแค่หาคนไม่เจอ

```
Console → Providers → เข้า provider เดิม (ตัวที่มี channel ของ OA)
  → Create a new channel → LINE Login → App types ติ๊ก Web app
  → channel ที่เพิ่งสร้าง → แท็บ LIFF → Add
```

| ช่อง | ค่า |
|---|---|
| LIFF app name | `billyai-spike` |
| Size | `Tall` |
| Endpoint URL | `https://<โดเมน>/liff/spike` |
| Scopes | ติ๊ก `profile`, `openid`, **`chat_message.write`** |
| Module mode | ปิด |

LIFF กำลังถูก rebrand เป็น LINE MINI App แต่ **LINE MINI App channel สร้างได้เฉพาะ
service area ญี่ปุ่น/ไต้หวัน** — ไทยยังต้องใช้ LIFF ตามเดิม และของที่สร้างไว้ใช้ต่อได้

**กระทบ Phase 2:** D15 ให้ verify LIFF ID token ฝั่ง server ทุก request · token นั้นออกโดย
**Login channel** ไม่ใช่ Messaging API channel ดังนั้น `aud` ที่ต้องตรวจคือ channel ID ของ
Login channel — ต้องเพิ่ม env อีกตัวตอนทำจริง

`chat_message.write` คือตัวที่ทำให้ `liff.sendMessages()` ทำงานได้ — **ไม่ติ๊ก = S2 ตกทันที**

ได้ **LIFF ID** มาแล้ว → เอาไปใส่ `NEXT_PUBLIC_LIFF_ID` บน Vercel → **redeploy**

---

## 5. รัน S4 — cold start

ต้องส่งลายเซ็นที่ถูกต้อง ไม่งั้นจะโดน `401` ตั้งแต่ก่อนแตะ DB แล้วตัวเลขที่วัดได้จะ
ไม่รวมเวลาปลุก Supabase ซึ่งเป็นครึ่งหนึ่งของคำถาม

```powershell
# ตั้งครั้งเดียวต่อเทอร์มินัล — ห้ามพิมพ์ secret ลงบทสนทนา ห้ามรันผ่าน ! ในแชท
$env:LINE_CHANNEL_SECRET = "<channel secret>"

npm run spike:s4 -- https://<โดเมน>/api/line/webhook
```

สคริปต์เซ็น body เอง ยิง 5 ครั้ง แล้วแยกเวลาให้เป็น 4 ช่อง: `wall` (ที่เครื่องเราจับได้)
`server` (จาก `Server-Timing` ของ route) `db` (เฉพาะที่รอ Supabase) และส่วนต่างซึ่งคือ
เน็ต + เวลาที่ Vercel ปลุก function ก่อนโค้ดเราได้เริ่มทำงาน

ถ้าไม่ได้ 200 ครบทุกครั้ง มันจะไม่พิมพ์สรุป และคืน exit code 1 — ตัวเลขจากชุดที่ 401
ใช้สรุปอะไรไม่ได้เลย จึงไม่ควรมีให้หยิบไปกรอก

**อย่ายิง body เป็นอาร์กิวเมนต์ของ `curl.exe` เอง** Windows PowerShell 5.1 กลืน
เครื่องหมาย `"` ตอนส่งต่อให้โปรแกรมภายนอก `'{"events":[]}'` จะกลายเป็น `{events:[]}`
ซึ่งไม่ตรงกับไบต์ที่เซ็นไว้ แล้วได้ 401 ทุกครั้งโดยดูไม่ออกว่าเพราะอะไร

**ก่อนวัดต้องปล่อยทิ้งไว้อย่างน้อย 30 นาที** ให้ทั้ง Vercel function และ Supabase free
เย็นจริง แล้ววัดซ้ำอีกรอบหลังทิ้งไว้อีก 30 นาทีเพื่อยืนยันว่าไม่ใช่ฟลุ๊ก

`Server-Timing: db;dur=… total;dur=…` คือเวลาฝั่ง server ล้วน ส่วน `time_total` ของ curl
รวมเวลาเดินทางไปกลับด้วย — ผลต่างของสองค่านี้คือค่าเน็ต + cold start ของ function

จำนวน retry ดูได้จาก log ของ Vercel: บรรทัด `[webhook] … retryKey=…` ที่ค่าเดียวกันโผล่
มากกว่าหนึ่งครั้ง = LINE ยิงซ้ำชุดเดิม

เอาผลไปกรอก `docs/SPIKE-PHASE0.md` หัวข้อ S4

---

## 6. รัน S2 — `liff.sendMessages()`

1. เอา `https://liff.line.me/<LIFF ID>` ไปวางใน**แชทกลุ่ม**ที่บอทอยู่ แล้วกดจากในกลุ่ม
2. หน้าจะโชว์ `type` / `isInClient` / `os` — จดค่า `type` ไว้
3. กดปุ่ม **ส่งข้อความเข้าแชทนี้** แล้วดูว่าเด้งขออนุญาตกี่ครั้ง หน้าตาแบบไหน
4. กลับไปดูในกลุ่มว่าข้อความโผล่ไหม **ชื่อผู้ส่งขึ้นเป็นใคร** (ตัวเราหรือ OA)
5. เทียบ quota ของ OA ก่อน/หลังใน OA Manager — ถ้าตัวเลขขยับ แปลว่านับเป็น push
   ซึ่งกระทบ C2 โดยตรง (zero-push จะไม่ zero จริง)
6. เปิดลิงก์เดิมจากแชท 1:1 กับบอท แล้วดูว่าต่างกันไหม

เอาผลไปกรอก `docs/SPIKE-PHASE0.md` หัวข้อ S2

หน้า `/liff/spike` เป็นของชั่วคราวของ Phase 0 — ลบทิ้งได้เมื่อ S2 บันทึกผลแล้ว

---

## กับดักที่เจอตอน deploy Phase 1 จริง (1 ก.ย. 2026)

ทั้งหมดนี้เจอเรียงกันในเซสชันเดียว แต่ละอันกินเวลาไล่หลายนาทีเพราะอาการที่เห็น
จากฝั่ง LINE เหมือนกันหมด: **บอทเงียบ**

### `405 Method Not Allowed` ตอนกด Verify = URL ขาด path

โค้ดเราตอบ `405` **เฉพาะ GET** (`app/api/line/webhook/route.ts`) ส่วน Verify ยิง POST
— ถ้าถึง handler จริงจะได้ 200/401/500 ไม่มีทางเป็น 405 · Next.js App Router ตอบ POST
ที่ยิงใส่ **page** ด้วย 405 พอดี เพราะฉะนั้น 405 แปลว่าช่อง Webhook URL ชี้ไปที่หน้าเว็บ
ไม่ใช่ `/api/line/webhook` · path ที่ไม่มีจริงจะได้ 404 ไม่ใช่ 405 — ตัวเลขสองตัวนี้
แยกกันได้

### รูปแบบบรรทัด log คือลายนิ้วมือของเวอร์ชันที่ deploy อยู่

log ของ M3 มี `db=` · ของ Phase 1 มี `replied=` แทน · เห็น `db=` ในกล่อง log เมื่อไหร่
แปลว่า request วิ่งเข้า deployment ที่ build จากคอมมิตเก่า ไม่ใช่ของที่เพิ่งเขียน —
ตรวจได้เร็วกว่าไล่ config ทีละช่อง (`git log -S` หาบรรทัดนั้นเจอคอมมิตทันที)

### แก้ env แล้วต้อง Redeploy เสมอ

Vercel ผูกค่า env เข้ากับ deployment **ตอน deploy** ไม่ได้อ่านสดทุก request · เพิ่ม
หรือแก้ค่าแล้วไม่ Redeploy = deployment เดิมยังถือค่าเก่าอยู่ · อาการที่ได้คือ "ใส่ค่า
ถูกแล้วแต่ยังพังเหมือนเดิม" ซึ่งชวนให้ไปสงสัยค่าที่เพิ่งใส่ว่าผิด

### `main` เท่านั้นที่ได้โดเมน production

branch อื่นได้ preview URL ของตัวเอง `https://<project>-git-<branch>-<scope>.vercel.app`
ซึ่ง**ใช้เป็น Webhook URL ได้ตามปกติ** LINE ไม่สนใจว่าเป็นโดเมนไหน ขอแค่ HTTPS สาธารณะ ·
นี่คือวิธีทดสอบโค้ดที่ยังไม่ merge โดยไม่ต้องเอาของที่ยังไม่เคยยิงจริงขึ้น `main`

**ต้องปิด Deployment Protection ก่อน** ไม่งั้น LINE ได้ `302` ไป `vercel.com/sso-api`
แล้ว Verify ไม่ผ่านโดยไม่มีอะไรบอกสาเหตุ · **เปิดกลับหลังย้าย webhook มา production**

`<scope>` ดูจาก URL ของ dashboard เอง (`vercel.com/<scope>/<project>`) แต่**ก๊อป host
จริงจากหน้า deployment** อย่าประกอบเอง — Vercel ตัดชื่อ project ให้สั้นลงได้ ทำให้
ชื่อที่เดาไว้กลายเป็น `DEPLOYMENT_NOT_FOUND`

### แยกสาเหตุจาก status กับ `total=`

| ที่เห็น | แปลว่า |
|---|---|
| ไม่มีบรรทัด `[webhook]` เลย | request ไม่ถึงโค้ดเรา — Deployment Protection, URL ผิด, หรือ `Use webhook` ปิด |
| `302` | Deployment Protection ยังเปิด |
| `405` | Webhook URL ชี้ไปที่ page ไม่ใช่ route |
| `401` | `LINE_CHANNEL_SECRET` ไม่ตรงกับ channel ที่กด Verify (ค่าว่างจะได้ `500` ไม่ใช่ `401`) |
| `500` + `total` ~1 ms | env หาย — throw ทันทีตอนอ่าน ไม่ได้ต่อเน็ตเลย |
| `500` + `total` หลักร้อย ms + `prepareFailed=` | ต่อ DB ได้แล้วแต่ query พัง — migration ไม่ครบ หรือรหัสผ่านผิด |
| `200` + `replied=0` | เข้ามาถึงแล้วโค้ดตัดสินใจไม่ตอบ (กฎเงียบ) ไม่ใช่ความผิดพลาด |

`total=` แยก "env หาย" ออกจาก "DB พัง" ได้โดยไม่ต้องเดา — การต่อ Supabase จริงกิน
เวลาหลักร้อยมิลลิวินาที ส่วน `throw` ตอนอ่าน `process.env` จบใน 1–2 ms

---

## กับดักที่เจอตอนตั้ง dev OA (4 ก.ย. 2026)

ทั้งชุดนี้เจอตอนยิง M8 ใส่ preview ครั้งแรก · อาการที่เห็นจากฝั่ง LINE เหมือนกันหมดอีก
เช่นเคย — **บอทตอบผิดคน หรือไม่ตอบ**

### บอทสองตัวในกลุ่มเดียวกัน ทำให้ D47 ดูเหมือนพัง

กลุ่มทดสอบมี `บิลใหญ่` ตัว production ค้างอยู่ตอนเชิญ `BillYai(Dev)` เข้าไป · พิมพ์
`ยอด` เปล่าๆ แล้วมีคำตอบขึ้นมา ซึ่งอ่านได้ว่า D47 ไม่ทำงาน — **แต่คนตอบคือตัว production
ที่ยังเป็นโค้ดก่อน D47** ส่วน dev เงียบถูกต้องอยู่แล้ว

**คอลัมน์ `Host` ใน Vercel log แยกได้ในบรรทัดเดียว** — `bill-yai.vercel.app` คือ production
`bill-yai-git-dev-<scope>.vercel.app` คือ preview · ไล่ config ทั้งวันไม่เจอเพราะปัญหา
ไม่ได้อยู่ใน config

**กฎ: กลุ่มทดสอบของ dev ห้ามมี OA ตัวจริงอยู่** เตะออกก่อนเสมอ

### `Execution Duration` + `External APIs` แยก "เงียบเพราะกฎ" ออกจาก "ตอบไม่ออก"

กางรายละเอียด request ใน Vercel log แล้วดูสองบรรทัดนี้:

| ที่เห็น | แปลว่า |
|---|---|
| `~40ms` + `No outgoing requests` | `decideReply` ตัดสินว่าเงียบ **ก่อนแตะ I/O ใดๆ** — กฎเงียบทำงาน ไม่ใช่ความผิดพลาด |
| หลักร้อย ms + มี outgoing | ไปถึง DB แล้ว · ถ้ายังไม่ตอบให้สงสัย `LINE_CHANNEL_ACCESS_TOKEN` |

`replied=0` อย่างเดียวแยกสองอันนี้ไม่ได้ แต่สองบรรทัดนี้แยกได้โดยไม่ต้องเดาและไม่ต้อง
เพิ่ม log

### mention ที่พิมพ์เองไม่ใช่ mention

พิมพ์ `@BillYai(Dev) ยอด` ด้วยมือทีละตัวอักษร **LINE ไม่ส่ง `message.mention` มาให้เลย** ·
ตาเรามองเหมือนกันเป๊ะกับตอนเลือกจากรายการ แต่ `mentionsBot` เป็น `false` แล้วกฎเงียบ
ทำงานถูกต้องตาม D47 — ซึ่งอ่านจากในแชทได้ว่าบอทพัง

**ตอนทดสอบต้องกด `@` แล้วแตะชื่อจากรายการที่เด้งขึ้นมา** · ตัวเช็กก่อนส่ง: ชื่อในช่องพิมพ์
ต้องลบทีเดียวหายทั้งก้อน ถ้าหายทีละตัวอักษรแปลว่ายังเป็นข้อความธรรมดา

ผลข้างเคียงที่ตามมาจริง: `lib/line/messages.ts` ฝัง `@บิลใหญ่` ไว้คงที่ ไกด์ในกลุ่ม dev
จึงบอกชื่อที่ไม่ตรงกับบอทที่เห็น — **ไม่ใช่บั๊ก** บน production ชื่อตรง
