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
   | `DATABASE_URL` | connection string แบบ pooler พอร์ต 6543 | Production + Preview |
   | `DB_POOL_MAX` | `2` | Production + Preview |
   | `LINE_CHANNEL_SECRET` | channel secret จาก LINE Developers Console | Production + Preview |
   | `PROMPTPAY_KEY` | 32 ไบต์สุ่ม base64 (คนละค่ากับที่ใช้บนเครื่อง) | Production + Preview |
   | `NEXT_PUBLIC_LIFF_ID` | ได้จากข้อ 4 — กลับมาใส่ทีหลังแล้ว redeploy | Production + Preview |

   `NEXT_PUBLIC_*` ถูกฝังลง bundle ฝั่ง client ตอน build — **ห้ามเอา secret ใส่ชื่อขึ้นต้นแบบนี้เด็ดขาด**
   และแก้ค่าแล้วต้อง redeploy ถึงจะมีผล (ต่างจาก env ฝั่ง server ที่อ่านตอน runtime)

4. หลัง deploy ครั้งแรก → **Settings → Functions → Region** ต้องเป็น **Singapore (sin1)**
   `vercel.json` ตั้งไว้ให้แล้ว แต่ยืนยันด้วยตาอีกที เพราะค่านี้ตัดสินตัวเลขของ S4 ทั้งหมด

5. โครง branch ตรงกับที่วางไว้: `main` → production, `dev` → preview URL ของตัวเอง

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
# ตั้งค่าครั้งเดียวต่อเทอร์มินัล — ห้ามพิมพ์ secret ลงบทสนทนา
$env:LINE_CHANNEL_SECRET = "<channel secret>"
$url = "https://<โดเมน>/api/line/webhook"

# เขียน body ลงไฟล์แล้วเซ็น "ไบต์ชุดเดียวกับที่ curl จะส่ง" — ห้ามส่ง body เป็น
# อาร์กิวเมนต์ เพราะ Windows PowerShell 5.1 **กลืนเครื่องหมาย " ตอนส่งต่อให้ .exe**
# ค่าที่ curl ส่งจริงจะกลายเป็น {events:[]} ซึ่งไม่ตรงกับที่เซ็นไว้ แล้วได้ 401 ทุกครั้ง
$bodyPath  = Join-Path $env:TEMP "billyai-s4-body.json"
$bodyBytes = [Text.Encoding]::UTF8.GetBytes('{"events":[]}')
[IO.File]::WriteAllBytes($bodyPath, $bodyBytes)

$hmac = [System.Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($env:LINE_CHANNEL_SECRET))
$sig  = [Convert]::ToBase64String($hmac.ComputeHash($bodyBytes))

# ยิงครั้งเดียวก่อนเพื่อ "พิสูจน์ว่าลายเซ็นผ่าน" — ต้องได้ 200 ไม่ใช่ 401
# ถ้าได้ 401 ตรงนี้ อย่าเพิ่งวัดเวลา ตัวเลขจะไม่รวมเวลาปลุก DB
curl.exe -s -D - -o NUL -X POST $url `
  -H "x-line-signature: $sig" -H "content-type: application/json" --data-binary "@$bodyPath"

# ครั้งแรก = cold ที่เหลือ = warm
1..5 | ForEach-Object {
  curl.exe -s -o NUL -w "%{time_total}s  http=%{http_code}`n" -X POST $url `
    -H "x-line-signature: $sig" -H "content-type: application/json" --data-binary "@$bodyPath"
}
```

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
