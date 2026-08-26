# ตั้ง LINE OA + LIFF สำหรับ BillYai

เอกสารนี้คือขั้นตอนที่ **ผู้ใช้ต้องกดเอง** — agent ทำแทนไม่ได้เลยสักขั้น เพราะทุกอย่าง
ผูกกับบัญชี LINE ส่วนตัวและต้องยืนยันตัวตน

ทำจบแล้วจะได้ของสามอย่างที่ spike S1/S2 ต้องใช้ (`docs/SPIKE-PHASE0.md`):
`channelSecret` · `channelAccessToken` · `liffId`

**ข้อมูลนี้ตรวจกับเอกสาร LINE เมื่อ 2026-08-26** — LINE ย้ายเมนูบ่อย ถ้าหน้าจอไม่ตรง
ให้เชื่อหน้าจอแล้วมาแก้เอกสารนี้

---

## สิ่งที่เปลี่ยนไปจากบทความเก่าๆ ในเน็ต

บทความส่วนใหญ่บอกให้ "เข้า LINE Developers Console แล้วสร้าง Messaging API channel"
**วิธีนั้นถูกยกเลิกแล้ว** ตอนนี้ลำดับกลับด้าน:

```
สร้าง LINE Official Account ก่อน  →  เปิด Messaging API จากฝั่ง OA Manager
                                   →  channel ค่อยไปโผล่ใน Developers Console
```

ถ้าเปิด Developers Console แล้วหาปุ่มสร้าง Messaging API channel ไม่เจอ — ไม่ได้หาไม่เจอ
มันไม่มีแล้วจริงๆ

---

## ขั้นที่ 1 — สมัคร Business ID + สร้าง LINE Official Account

**Business ID ไม่ใช่ขั้นตอนแยก** — สมัครตอน login ครั้งแรกในหน้าเดียวกัน

เข้าทางใดทางหนึ่ง (ยืนยันแล้วว่าใช้ได้ทั้งคู่ 2026-08-26):

| ทาง | URL | ได้อะไร |
|---|---|---|
| เว็บ LINE for Business ไทย | https://lineforbusiness.com/th/ | มีปุ่ม `สร้างบัญชีทางการฟรี` / `Create a LINE Official Account for free` |
| เข้า OA Manager ตรงๆ | https://manager.line.biz/ | เด้งไปหน้า login Business ID แล้วสร้างบัญชีต่อจากตรงนั้น |

> `https://account.line.biz/login` **ใช้ไม่ได้** — อย่าเสียเวลากับ URL นี้

1. กด `Create a LINE Official Account for free`
2. **Log in to Business ID** — เลือก `Log in with LINE account` (ใช้บัญชี LINE ส่วนตัว
   สะดวกกว่า เพราะ S1/S2 ต้องเชิญบอทเข้ากลุ่มที่ตัวเองอยู่) หรือสมัครด้วยอีเมล
3. กรอกฟอร์มสร้างบัญชี แล้วกด `Continue`
4. หน้า `Check application` → กด `Submit`

| ช่อง | ใส่อะไร |
|---|---|
| ชื่อบัญชี | `บิลใหญ่` หรือ `BillYai (dev)` — เปลี่ยนทีหลังได้ แต่ชื่อนี้จะโผล่ในกลุ่มตอนทดสอบ |
| ประเภทธุรกิจ | อะไรก็ได้ ไม่มีผลกับ API |
| ประเทศ/ภูมิภาค | **ไทย** — มีผลกับโควตาข้อความและเรื่องพร้อมเพย์ |

ได้ **บัญชีฟรี (Unverified)** มา — แผนฟรีให้ส่งข้อความ 500 ข้อความ/เดือน
ยังไม่มีโล่ ยังไม่ต้องสมัคร verified ตอนนี้ (ดูขั้นที่ 8 ว่าโล่มีผลกับอะไร)

---

## ขั้นที่ 2 — เข้า LINE Official Account Manager

https://manager.line.biz/ → เลือกบัญชีที่เพิ่งสร้าง

หน้านี้คือที่ตั้งค่าทุกอย่างในขั้น 3–5

---

## ขั้นที่ 3 — เปิด Messaging API

ยังอยู่ใน https://manager.line.biz/ บัญชีที่เพิ่งสร้าง

1. `Settings` (มุมขวาบน) → `Messaging API`
2. กด `Enable Messaging API`
3. เลือก **Provider** — ยังไม่มีก็สร้างใหม่ ตั้งชื่อเป็นชื่อตัวเองหรือชื่อทีมได้
   (Provider คือกล่องรวม channel ไม่ใช่ของที่ผู้ใช้ปลายทางเห็น)
4. ยืนยัน

หลังขั้นนี้จะเห็น **Channel secret** โผล่ในหน้านี้ — จดไว้ ใช้ในขั้นที่ 6

---

## ขั้นที่ 4 — ปิด auto-reply และ greeting

**ข้อนี้ห้ามข้าม** ถ้าไม่ปิด บอทจะตอบข้อความอัตโนมัติทับสิ่งที่เราต้องสังเกตใน spike
และกินโควตาข้อความตามข้อจำกัด C2 ที่ design ทั้งชุดวางอยู่บน

ใน OA Manager → `Settings` → `Response settings`

| รายการ | ตั้งเป็น |
|---|---|
| `Greeting messages` | **ปิด** |
| `Auto-reply messages` | **ปิด** |
| `Webhooks` | เปิด — **แต่ยังเปิดไม่ได้ตอนนี้** ดูด้านล่าง |

ค่าเริ่มต้นของ LINE คือเปิด greeting/auto-reply ไว้ทั้งคู่ ต้องไปปิดเอง

> **`Webhooks` จะยังเลือกไม่ได้จนกว่าจะใส่ Webhook URL ก่อน** — LINE ไม่ยอมให้เปิด
> สวิตช์ที่ไม่มีปลายทาง ข้ามข้อนี้ไปก่อน แล้วกลับมาเปิดหลังทำขั้นที่ 9 (ซึ่งเป็นขั้นที่
> ใส่ URL จริง) · ปิด greeting/auto-reply ให้เรียบร้อยตอนนี้ได้เลย ไม่ต้องรอ

---

## ขั้นที่ 5 — อนุญาตให้บอทเข้ากลุ่ม

ถ้าไม่เปิดข้อนี้ **S1 กับ S2 ทำไม่ได้เลย** เพราะเชิญบอทเข้ากลุ่มไม่ได้ตั้งแต่แรก

ทางที่สั้นที่สุด: LINE Developers Console → channel ของเรา → แท็บ `Messaging API`
→ `Allow bot to join group chats` → เปิด

ถ้าหาไม่เจอ ไปทาง OA Manager แทน:
`Settings` → `Account settings` → `Toggle features` → `Group and multi-person chats`
→ `Allow account to join groups and multi-person chats`

---

## ขั้นที่ 6 — เอา secret กับ token ออกมา

เข้า https://developers.line.biz/console/ → เลือก provider → เลือก channel ที่เพิ่งสร้าง

| ของ | อยู่ที่ | หมายเหตุ |
|---|---|---|
| `channelSecret` | แท็บ `Basic settings` | ใช้ verify signature ของ webhook |
| `channelAccessToken` | แท็บ `Messaging API` → ล่างสุด `Channel access token` → `Issue` | ได้แบบ **long-lived** — พอสำหรับ spike |

**อย่าไปงมหา v2.1 ในคอนโซล** — token v2.1 (กำหนดวันหมดอายุเอง) ออกจากปุ่มในคอนโซลไม่ได้
ต้องยิง API ด้วย JWT + Assertion Signing Key ปุ่มในคอนโซลออกให้ได้แค่ long-lived เท่านั้น
เก็บ v2.1 ไว้ตอนขึ้น production ซึ่งการกำหนดอายุและ revoke รายตัวคุ้มกับความยุ่งยาก

long-lived token โชว์เต็มในหน้านั้นตลอด กลับมาก๊อปใหม่ได้ ไม่ต้องกลัวทำหาย ·
กด `Reissue` เมื่อไหร่ตัวเก่าตายทันที ใช้ตอนสงสัยว่าหลุด

> **ของสองอย่างนี้เป็นความลับ** ใครถือ `channelAccessToken` ก็ส่งข้อความในนามบัญชีเราได้
> และใครถือ `channelSecret` ก็ปลอม webhook เข้าระบบเราได้
>
> - ใส่ลง `.env.local` เท่านั้น — ไฟล์นี้ `.gitignore` กันไว้แล้ว
> - **ห้ามแปะลง `docs/SPIKE-PHASE0.md`** หรือไฟล์อื่นที่ commit — repo นี้เป็น public
> - ห้ามส่งให้ agent ตัวไหนทั้งนั้น รวมถึงตัวนี้ ไม่มีขั้นตอนไหนในโปรเจกต์ที่ agent ต้องเห็นค่าจริง
> - ถ้าหลุดไปแล้ว: กด `Issue` ใหม่เพื่อ revoke ตัวเก่า และกด reissue channel secret

เพิ่มลง `.env.local` (สร้างจาก `.env.local.example`):

```
LINE_CHANNEL_SECRET=
LINE_CHANNEL_ACCESS_TOKEN=
```

---

## ขั้นที่ 7 — LIFF app (ต้องมีก่อนทำ S2)

LIFF ต้องมี endpoint เป็น **https** จริง ยังไม่ได้ deploy ก็ใช้ ngrok หรือ Vercel preview ไปก่อน

Developers Console → channel เดิม → แท็บ `LIFF` → `Add`

| ช่อง | ใส่อะไร |
|---|---|
| LIFF app name | `billyai-spike` |
| Size | `Tall` |
| Endpoint URL | URL https ของหน้าทดสอบ |
| Scopes | ติ๊ก `profile`, `openid`, และ **`chat_message.write`** |
| Scan QR | เปิดไว้ก็ได้ |

`chat_message.write` คือ scope ที่ทำให้ `liff.sendMessages()` ทำงาน — **S2 ทั้งข้อวัดเรื่องนี้**
ถ้าลืมติ๊ก S2 จะได้ผลลบปลอม

ได้ `liffId` มา → URL สำหรับเปิดคือ `https://liff.line.me/<liffId>`

---

## ขั้นที่ 8 — verified badge (ยังไม่ต้องทำตอนนี้ แต่ต้องรู้)

เอกสาร LINE ระบุว่า endpoint ที่ดึง **user ID ของสมาชิกทั้งกลุ่ม**
(`GET /v2/bot/group/{groupId}/members/ids`) ใช้ได้เฉพาะบัญชี **verified หรือ premium**

แปลว่าบัญชีฟรีที่เพิ่งสร้างจะยิง endpoint นั้นไม่ผ่าน — **ข้อนี้รู้จากเอกสารแล้ว ไม่ต้องเสียเวลา spike**

แต่ endpoint ที่ดึง **โปรไฟล์ของสมาชิกทีละคน** (`GET /v2/bot/group/{groupId}/member/{userId}`)
เอกสารไม่ได้ระบุข้อจำกัดเดียวกันไว้ — **นี่คือคำถามจริงของ S1** ต้องยิงจริงถึงจะรู้

ผลของ S1 ตัดสิน D10 (auto-suggest ชื่อตอน claim ตัวตน):

- ยิงผ่าน → D10 เดินตามแผนเดิม
- ยิงไม่ผ่าน → ต้องให้คนพิมพ์ชื่อตัวเองตอน claim แล้วกลับไปแก้ D10 ใน `docs/DESIGN.md`

เอกสาร LINE ยังระบุอีกข้อที่กระทบ D10 โดยตรง:
"If a user gave no consent to access their user profile information, the webhook contains no user ID"
— แปลว่าบางคนใน webhook จะไม่มี `userId` มาให้เลย ระบบต้องรับสภาพนั้นได้

---

## ขั้นที่ 9 — ทดสอบว่าใช้ได้จริง

ยังไม่ต้องมีโค้ดของโปรเจกต์ แค่ยืนยันว่า channel มีชีวิต

**ลำดับสำคัญ: ต้องมี Webhook URL ก่อน ถึงจะเปิดสวิตช์ webhook ได้**

1. เปิด https://webhook.site/ ในแท็บใหม่ — มันสร้าง URL ให้เอง กดคัดลอก
2. Developers Console → channel → แท็บ `Messaging API` → `Webhook URL` → `Edit`
   → วาง URL → `Update`
3. กด `Verify` → ต้องขึ้น `Success`
4. เปิดสวิตช์ `Use webhook`
5. กลับไป OA Manager → `Settings` → `Response settings` → ตอนนี้ `Webhooks` เลือกได้แล้ว
   → ยืนยันว่าเปิดอยู่ (สองที่นี้คือค่าตัวเดียวกัน มักเปลี่ยนตามกันให้เอง)
6. แท็บ `Messaging API` มี QR → สแกนเพิ่มบอทเป็นเพื่อน
7. พิมพ์อะไรก็ได้หาบอทในแชท 1:1 → ต้องเห็น request เด้งที่ webhook.site
8. เชิญบอทเข้ากลุ่มที่มีคนอื่นอย่างน้อย 2 คน → พิมพ์ในกลุ่ม → ต้องเห็น event ที่มี
   `source.type = "group"` พร้อม `groupId`

เห็นครบทั้งสองแบบ = พร้อมทำ S1 แล้ว → ไปต่อที่ `docs/SPIKE-PHASE0.md`

> `groupId` กับ `userId` ที่ได้จาก webhook.site เป็นข้อมูลส่วนบุคคลของคนในกลุ่มจริง
> ใช้ทดสอบแล้วอย่าแปะลงไฟล์ที่ commit และเปลี่ยน Webhook URL ออกจาก webhook.site
> ทันทีที่ทดสอบเสร็จ — URL นั้นใครเดาถูกก็เปิดดูได้

---

## เช็กลิสต์ก่อนเริ่ม spike

- [ ] Business ID + LINE OA สร้างแล้ว ประเทศ = ไทย
- [ ] Messaging API เปิดแล้ว มี provider
- [ ] Greeting + Auto-reply **ปิด** · Webhooks **เปิด** (เปิดได้หลังใส่ URL ในขั้นที่ 9)
- [ ] `Allow bot to join group chats` เปิด
- [ ] `channelSecret` + `channelAccessToken` อยู่ใน `.env.local` (ไม่ได้ commit)
- [ ] LIFF app สร้างแล้ว scope มี `chat_message.write` (เฉพาะตอนจะทำ S2)
- [ ] ทดสอบ webhook เห็น event ทั้งแชท 1:1 และในกลุ่ม

---

## แหล่งอ้างอิง

- [Getting started with the Messaging API](https://developers.line.biz/en/docs/messaging-api/getting-started/)
- [Building a bot](https://developers.line.biz/en/docs/messaging-api/building-bot/)
- [Group chats and multi-person chats](https://developers.line.biz/en/docs/messaging-api/group-chats/)
- [Get user IDs](https://developers.line.biz/en/docs/messaging-api/getting-user-ids/)
- [Creating new LINE official accounts](https://help.line.me/official_account/web/categoryId/20010172/pc?lang=en&contentId=20013134)
- [About Business ID](https://help2.line.me/business_id/web/pc?lang=en)
