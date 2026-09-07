'use client'

/**
 * `/liff` — หน้าจอที่เปิดจากปุ่มบนการ์ด Draft
 *
 * ก้อนนี้ต่อสายให้ครบเส้นก่อน: `liff.init()` → ขอ ID token → `POST /api/liff/session`
 * → แสดง draft ที่ได้กลับมา · **หน้าตาจริงของการจดรายชิ้นเป็นก้อนถัดไป** ไฟล์นี้
 * จึงแสดงของที่ได้มาตรงๆ พอให้ยิงจริงแล้วรู้ว่าเส้นทางทั้งเส้นทำงาน
 *
 * `draftId` มาทาง query string ของ LIFF URL · **token ไปทาง body ไม่ใช่ URL** —
 * ค่าใน URL เดินทางไปโผล่ใน referer และ log ของทุกชั้นที่คั่นกลาง
 *
 * **ห้ามแสดง `groupId`/`userId` บนหน้านี้** ด้วยเหตุผลเดียวกับหน้า spike: มันอยู่บน
 * โดเมน public และผู้ใช้จะถ่ายจอมาแปะในบทสนทนา
 */

import { useEffect, useState } from 'react'
import type { LiffSession } from '@/lib/liff/session'
import { formatSatang } from '@/lib/money'

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; session: LiffSession }
  | { kind: 'failed'; message: string }

export default function LiffPage() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    const fail = (message: string) => {
      if (!cancelled) setPhase({ kind: 'failed', message })
    }

    void (async () => {
      const liffId = process.env.NEXT_PUBLIC_LIFF_ID
      if (liffId === undefined || liffId === '') {
        // ตั้ง env แล้วต้อง Redeploy — ค่านี้ถูกฝังตอน build ไม่ได้อ่านตอนรัน
        fail('หน้านี้ยังตั้งค่าไม่ครบ')
        return
      }

      const draftId = new URLSearchParams(window.location.search).get('draftId') ?? ''

      let idToken: string | null
      try {
        const { default: liff } = await import('@line/liff')
        await liff.init({ liffId })
        if (cancelled) return
        if (!liff.isLoggedIn()) {
          // เปิดนอกแอป LINE — พาไปล็อกอินแล้วกลับมาที่ URL เดิมพร้อม query เดิม
          liff.login({ redirectUri: window.location.href })
          return
        }
        idToken = liff.getIDToken()
      } catch {
        fail('เปิดจากในแอป LINE ไม่ได้ ลองกดจากการ์ดในแชทอีกครั้ง')
        return
      }
      if (cancelled) return
      if (idToken === null || idToken === '') {
        fail('เซสชันหมดอายุ — ปิดหน้านี้แล้วกดจากการ์ดใหม่')
        return
      }

      let response: Response
      try {
        response = await fetch('/api/liff/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ idToken, draftId }),
        })
      } catch {
        fail('เน็ตขัดข้อง ลองใหม่อีกครั้ง')
        return
      }
      if (cancelled) return

      /**
       * อ่าน body ก่อนดู `response.ok` — ฝั่ง server ใส่ข้อความไทยที่บอกทางออกไว้
       * ในทุกคำตอบที่ไม่ผ่านแล้ว การทิ้งมันไปเขียนข้อความรวมๆ เองคือการทิ้งของที่ดี
       * กว่า · body ที่อ่านไม่ออกค่อยตกไปใช้ข้อความกลาง
       */
      let payload: { ok?: unknown; session?: unknown; message?: unknown } = {}
      try {
        payload = (await response.json()) as typeof payload
      } catch {
        // ปล่อยว่างไว้ — ตกไปใช้ข้อความกลางข้างล่าง
      }
      if (cancelled) return

      if (response.ok && payload.ok === true && payload.session !== undefined) {
        setPhase({ kind: 'ready', session: payload.session as LiffSession })
        return
      }
      fail(typeof payload.message === 'string' ? payload.message : 'เปิดบิลใบนี้ไม่ได้')
    })()

    return () => {
      cancelled = true
    }
  }, [])

  if (phase.kind === 'loading') return <main>กำลังเปิดบิล…</main>
  if (phase.kind === 'failed') return <main>{phase.message}</main>

  const { draft, lines, spentAt } = phase.session
  return (
    <main>
      <h1>{draft.description}</h1>
      <p>
        {baht(draft.totalSatang)} · {spentAt}
        {draft.eventTag === undefined ? '' : ` · #${draft.eventTag}`}
      </p>
      <ul>
        {lines.map((line) => (
          <li key={line.name}>
            {line.name} {baht(line.amountSatang)}
            {line.isNew ? ' (ใหม่)' : ''}
          </li>
        ))}
      </ul>
      <p>หน้าจดรายชิ้นกำลังทำอยู่ — ตอนนี้ยังต้องยืนยันจากการ์ดในแชท</p>
    </main>
  )
}

/** รูปเดียวกับการ์ดในแชท — `formatSatang` ใส่คอมมาหลักพันให้ด้วย (`฿1,200`) */
function baht(satang: number): string {
  return `฿${formatSatang(satang)}`
}
