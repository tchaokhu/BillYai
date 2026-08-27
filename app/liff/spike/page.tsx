'use client'

/**
 * หน้าเดียวสำหรับ S2 — `liff.sendMessages()` จาก group context
 *
 * คำถามที่หน้านี้ต้องตอบ (ตาม `docs/SPIKE-PHASE0.md`):
 *   `getContext().type` ตอนเปิดจากกลุ่มได้อะไร · ขออนุญาตกี่ครั้ง ·
 *   ข้อความไปโผล่ในกลุ่มจริงไหม ชื่อผู้ส่งเป็นใคร · นับ quota ของ OA ไหม ·
 *   เปิดจากแชท 1:1 ต่างกันไหม
 *
 * ทุกอย่างพิมพ์ลงหน้าจอ ไม่ใช่ `console.log` เพราะ spike นี้รันบนมือถือที่เปิด
 * devtools ไม่ได้
 *
 * **จงใจไม่โชว์ `groupId`/`userId`** — หน้านี้อยู่บนโดเมน public และผู้ใช้จะถ่ายจอ
 * มาแปะในบทสนทนา ค่าที่ต้องรู้จริงๆ คือ `type` ไม่ใช่ตัว id
 *
 * ยังไม่มี ID token verify ตรงนี้ (D15) เพราะหน้านี้ไม่เรียก API ของเราเลย
 * ตอนทำ Phase 2 จริง ทุก request ที่เข้ามาต้อง verify ฝั่ง server ก่อนเสมอ
 */

import { useEffect, useState } from 'react'

interface ContextInfo {
  type: string
  isInClient: boolean
  isLoggedIn: boolean
  os: string
  language: string
  liffVersion: string
  lineVersion: string
}

type Phase = 'init' | 'ready' | 'failed'

export default function LiffSpikePage() {
  const [phase, setPhase] = useState<Phase>('init')
  const [info, setInfo] = useState<ContextInfo | null>(null)
  const [log, setLog] = useState<string[]>([])

  const say = (line: string) =>
    setLog((prev) => [...prev, `${new Date().toISOString().slice(11, 19)}  ${line}`])

  useEffect(() => {
    const liffId = process.env.NEXT_PUBLIC_LIFF_ID
    if (liffId === undefined || liffId.length === 0) {
      setPhase('failed')
      say('ไม่ได้ตั้ง NEXT_PUBLIC_LIFF_ID ตอน build')
      return
    }

    let cancelled = false
    // import แบบ dynamic — SDK แตะ `window` ตอนโหลด ถ้า import บนสุดจะพังตอน SSR
    void import('@line/liff')
      .then(async ({ default: liff }) => {
        await liff.init({ liffId })
        if (cancelled) return

        setInfo({
          type: liff.getContext()?.type ?? '(ไม่มี context)',
          isInClient: liff.isInClient(),
          isLoggedIn: liff.isLoggedIn(),
          os: liff.getOS() ?? '?',
          language: liff.getLanguage(),
          liffVersion: liff.getVersion(),
          lineVersion: liff.getLineVersion() ?? '(ไม่ได้เปิดในแอป LINE)',
        })
        setPhase('ready')
        say('liff.init() สำเร็จ')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setPhase('failed')
        say(`liff.init() พัง: ${describe(err)}`)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const send = async () => {
    say('กดปุ่มส่ง')
    try {
      const { default: liff } = await import('@line/liff')
      await liff.sendMessages([
        { type: 'text', text: 'ทดสอบ S2 จาก BillYai — ข้อความนี้ส่งผ่าน liff.sendMessages()' },
      ])
      say('sendMessages() ผ่าน ไม่ throw — ไปดูในแชทว่าข้อความโผล่ไหม ชื่อผู้ส่งเป็นใคร')
    } catch (err: unknown) {
      say(`sendMessages() พัง: ${describe(err)}`)
    }
  }

  return (
    <main>
      <h1>S2 — liff.sendMessages()</h1>

      {phase === 'init' && <p>กำลัง init…</p>}

      {info !== null && (
        <table style={{ borderCollapse: 'collapse' }}>
          <tbody>
            {Object.entries(info).map(([key, value]) => (
              <tr key={key}>
                <td style={cell}>{key}</td>
                <td style={{ ...cell, fontWeight: 600 }}>{String(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p>
        <button type="button" onClick={() => void send()} disabled={phase !== 'ready'} style={btn}>
          ส่งข้อความเข้าแชทนี้
        </button>
      </p>

      <pre style={pre}>{log.length === 0 ? '(ยังไม่มี log)' : log.join('\n')}</pre>

      <p style={{ fontSize: '0.85rem', opacity: 0.7 }}>
        หน้านี้เป็น spike ชั่วคราวของ Phase 0 — ลบทิ้งได้เมื่อ S2 บันทึกผลแล้ว
      </p>
    </main>
  )
}

/** ดึงข้อความจาก error รูปร่างไหนก็ได้ — LIFF โยน object ที่ไม่ใช่ `Error` ด้วย */
function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null) {
    const { code, message } = err as { code?: unknown; message?: unknown }
    if (typeof message === 'string') return typeof code === 'string' ? `${code} ${message}` : message
  }
  return String(err)
}

const cell = { border: '1px solid #ddd', padding: '0.35rem 0.6rem' } as const
const btn = { padding: '0.75rem 1.25rem', fontSize: '1rem' } as const
const pre = {
  background: '#f4f4f4',
  padding: '0.75rem',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
} as const
