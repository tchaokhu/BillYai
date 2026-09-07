'use client'

/**
 * `/liff` — หน้าจอจดรายชิ้น เปิดจากปุ่มบนการ์ด Draft (D56)
 *
 * `draftId` มาทาง query string ของ LIFF URL · **token ไปทาง body ไม่ใช่ URL** —
 * ค่าใน URL เดินทางไปโผล่ใน referer และ log ของทุกชั้นที่คั่นกลาง
 *
 * **ห้ามแสดง `groupId`/`userId` บนหน้านี้** ด้วยเหตุผลเดียวกับหน้า spike: มันอยู่บน
 * โดเมน public และผู้ใช้จะถ่ายจอมาแปะในบทสนทนา
 *
 * เลขทั้งหมดอยู่ใน `lib/liff/bill.ts` ซึ่งเทสต์ได้โดยไม่ต้อง render · ไฟล์นี้มีแต่
 * การวาดกับการรับอินพุต · **ตัวเลขบนจอเป็นภาพตัวอย่าง** ของจริงคือสิ่งที่
 * `POST /api/liff/draft` คำนวณแล้วส่งกลับมา (D57)
 */

import { useEffect, useMemo, useState } from 'react'
import { eatersOf, parseSatang, similarName, totalsOf } from '@/lib/liff/bill'
import type { AdjustmentMode, BillState } from '@/lib/liff/bill'
import type { LiffSession } from '@/lib/liff/session'
import { formatSatang } from '@/lib/money'
import type { DraftItem } from '@/lib/types'

/**
 * `failed` **แทนที่ทั้งหน้าจอ จึงใช้ได้เฉพาะตอนที่ไม่มีอะไรให้กู้** — เปิดบิลไม่ได้
 * ตั้งแต่แรก · เซสชันหมดอายุ · การ์ดถูกกดยืนยันไปแล้ว
 *
 * ความล้มเหลวตอนเซฟ (เน็ตหลุด · 503) **ห้ามใช้ `failed`** — บิลที่กรอกมาทั้งใบจะ
 * หายไปกับหน้าจอ แล้วเขาต้องพิมพ์ใหม่หมดทั้งที่ปัญหาคือ Wi-Fi ร้านอาหาร · ทางนั้น
 * ใช้ `saveError` ซึ่งเป็นแถบเตือนเหนือปุ่ม ส่วนฟอร์มยังอยู่ครบให้กดใหม่
 */
type Phase =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'saved' }
  | { kind: 'failed'; message: string }

/** รูปเดียวกับการ์ดในแชท — `formatSatang` ใส่คอมมาหลักพันให้ด้วย (`฿1,200`) */
function baht(satang: number): string {
  return `฿${formatSatang(satang)}`
}

/** ช่องกรอกเงินเก็บเป็นข้อความระหว่างพิมพ์ — ลบทิ้งจนว่างต้องไม่เด้งเป็น 0 */
interface Draftable {
  text: string
  satang: number | null
}

function money(satang: number): Draftable {
  return { text: formatSatang(satang), satang }
}

/**
 * หนึ่งบรรทัดบนหน้าจอ — **มี `id` ของตัวเอง ไม่ใช้ index เป็นคีย์**
 *
 * ลบบรรทัดกลางๆ ทิ้งแล้ว index ของบรรทัดที่เหลือเลื่อน · React จะใช้ DOM node เดิม
 * ต่อ แล้วช่องที่พิมพ์ไว้จะแสดงค่าของบรรทัดที่เพิ่งถูกลบ — ราคาผิดบรรทัดคือความ
 * ผิดพลาดที่มองไม่ออกจนกว่าจะลง ledger ไปแล้ว
 *
 * `amountText` แยกจาก `amountSatang` เพราะระหว่างพิมพ์ค่ายังอ่านไม่ออกได้ (`12.` ·
 * ว่าง) และการเด้งกลับเป็น `0` ใต้นิ้วทำให้พิมพ์ต่อไม่ได้
 */
interface ItemRow {
  id: string
  name: string
  amountText: string
  amountSatang: number
  eaterNames: string[]
}

let rowSeq = 0
function newRow(item?: DraftItem): ItemRow {
  rowSeq += 1
  return {
    id: `row-${rowSeq}`,
    name: item?.name ?? '',
    amountText: item === undefined || item.amountSatang === 0 ? '' : formatSatang(item.amountSatang),
    amountSatang: item?.amountSatang ?? 0,
    eaterNames: item === undefined ? [] : [...item.eaterNames],
  }
}

export default function LiffPage() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [session, setSession] = useState<LiffSession | null>(null)
  const [bill, setBill] = useState<Omit<BillState, 'items'> | null>(null)
  const [rows, setRows] = useState<ItemRow[]>([])
  const [paid, setPaid] = useState<Draftable>({ text: '', satang: null })
  const [idToken, setIdToken] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [newName, setNewName] = useState('')
  const [pendingRemove, setPendingRemove] = useState<{ name: string; items: string[] } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const draftId = useMemo(
    () => (typeof window === 'undefined' ? '' : new URLSearchParams(location.search).get('draftId') ?? ''),
    [],
  )

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

      let token: string | null
      try {
        const { default: liff } = await import('@line/liff')
        await liff.init({ liffId })
        if (cancelled) return
        if (!liff.isLoggedIn()) {
          // เปิดนอกแอป LINE — พาไปล็อกอินแล้วกลับมาที่ URL เดิมพร้อม query เดิม
          liff.login({ redirectUri: location.href })
          return
        }
        token = liff.getIDToken()
      } catch {
        fail('เปิดจากในแอป LINE ไม่ได้ ลองกดจากการ์ดในแชทอีกครั้ง')
        return
      }
      if (cancelled) return
      if (token === null || token === '') {
        fail('เซสชันหมดอายุ — ปิดหน้านี้แล้วกดจากการ์ดใหม่')
        return
      }
      setIdToken(token)

      const loaded = await post('/api/liff/session', { idToken: token, draftId })
      if (cancelled) return
      if (!loaded.ok) {
        fail(loaded.message)
        return
      }
      adopt(loaded.session)
      setPhase({ kind: 'ready' })
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId])

  /** เอา session จาก server มาเป็นสถานะบนจอ — ใช้ทั้งตอนเปิดและตอนเซฟเสร็จ */
  function adopt(next: LiffSession): void {
    setSession(next)
    const people = next.lines.map((line) => line.name)
    const payer = next.lines.find((line) => line.isPayer)?.name ?? people[0] ?? ''
    const paidSatang = next.draft.totalSatang + next.draft.adjustmentSatang
    setPaid(money(paidSatang))
    setBill({
      paidSatang,
      people,
      payerName: payer,
      mode: 'auto',
      svcOn: false,
      vatOn: false,
      svcPct: 1000,
      vatPct: 700,
      typedAdjustmentSatang: next.draft.adjustmentSatang,
    })
    /**
     * บิลที่ยังไม่เคยจดรายชิ้นเปิดมาเป็นบรรทัดเปล่าหนึ่งบรรทัด — หน้าจอที่ว่าง
     * สนิทไม่บอกว่าต้องทำอะไรต่อ ส่วนบรรทัดว่างบรรทัดเดียวบอกด้วยตัวมันเอง
     */
    setRows(
      next.draft.items !== undefined && next.draft.items.length > 0
        ? next.draft.items.map((item) => newRow(item))
        : [newRow()],
    )
  }

  if (phase.kind === 'loading') return <main className="msg">กำลังเปิดบิล…</main>
  if (phase.kind === 'failed') return <main className="msg">{phase.message}</main>
  if (session === null || bill === null) return <main className="msg">กำลังเปิดบิล…</main>

  const items: DraftItem[] = rows.map((row) => ({
    name: row.name.trim(),
    amountSatang: row.amountSatang,
    eaterNames: row.eaterNames,
  }))
  const totals = totalsOf({ ...bill, items })

  /**
   * แก้อะไรก็ตามหลังเซฟ = **กลับไปยังไม่ได้เซฟ** — ไม่งั้นปุ่มบันทึกหายไปตลอดกาล
   * หลังเซฟครั้งแรก แล้วตัวเลขบนจอจะขยับตามที่เขาแก้โดยที่ไม่มีทางเก็บมันได้เลย
   * และการ์ดในแชทก็ยังยืนยันของเวอร์ชันก่อนหน้า
   */
  const touched = () => {
    setSaveError(null)
    if (phase.kind === 'saved') setPhase({ kind: 'ready' })
  }

  const patch = (next: Partial<Omit<BillState, 'items'>>) => {
    touched()
    setBill({ ...bill, ...next })
  }

  const patchRow = (id: string, next: Partial<ItemRow>) => {
    touched()
    setRows(rows.map((row) => (row.id === id ? { ...row, ...next } : row)))
  }

  const replaceRows = (next: ItemRow[]) => {
    touched()
    setRows(next)
  }

  const toggleEater = (row: ItemRow, name: string) =>
    patchRow(row.id, {
      eaterNames: row.eaterNames.includes(name)
        ? row.eaterNames.filter((eater) => eater !== name)
        : [...row.eaterNames, name],
    })

  /**
   * เอาคนออกที่เป็นคนกินคนเดียวของรายการไหน **ถามก่อน พร้อมบอกชื่อรายการ** (D55)
   * — รายการที่เหลือคนกินศูนย์กลายเป็นของกลางตาม D53 ซึ่งขยับยอดของทุกคนเงียบๆ
   */
  const askRemove = (name: string) => {
    const orphaned = rows
      .filter((row) => row.eaterNames.length === 1 && row.eaterNames[0] === name)
      .map((row) => (row.name.trim() === '' ? '(รายการที่ยังไม่ได้ตั้งชื่อ)' : row.name))
    if (orphaned.length === 0) removePerson(name)
    else setPendingRemove({ name, items: orphaned })
  }

  const removePerson = (name: string) => {
    setPendingRemove(null)
    patch({ people: bill.people.filter((person) => person !== name) })
    replaceRows(
      rows.map((row) => ({ ...row, eaterNames: row.eaterNames.filter((eater) => eater !== name) })),
    )
  }

  const addPerson = (name: string) => {
    const trimmed = name.trim()
    if (trimmed === '' || bill.people.includes(trimmed)) return
    patch({ people: [...bill.people, trimmed] })
    setNewName('')
  }

  const warnAbout = similarName(newName, [...bill.people, ...session.roster])

  async function save(): Promise<void> {
    if (bill === null || idToken === null || saving) return
    setSaving(true)
    const result = await post('/api/liff/draft', {
      idToken,
      draftId,
      bill: {
        paidSatang: bill.paidSatang,
        people: bill.people,
        payerName: bill.payerName,
        items: rows.map((row) => ({
          name: row.name.trim(),
          amountSatang: row.amountSatang,
          eaterNames: row.eaterNames,
        })),
      },
    })
    setSaving(false)
    if (!result.ok) {
      /**
       * **แถบเตือน ไม่ใช่หน้าจอใหม่** — เน็ตหลุดกลางร้านอาหารต้องไม่กินบิลที่กรอก
       * มาทั้งใบ · ฟอร์มยังอยู่ครบ กดใหม่ได้ทันที
       */
      setSaveError(result.message)
      return
    }
    adopt(result.session)
    setPhase({ kind: 'saved' })
  }

  const unnamed = rows.filter((row) => row.name.trim() === '').length
  const ready = !totals.blocked && unnamed === 0

  /**
   * ทำไมถึงยังเซฟไม่ได้ — **บอกเหตุ ไม่ใช่บอกว่าปุ่มกดไม่ได้**
   *
   * เรียงจากเหตุที่ต้องแก้ก่อนไปหลัง · `null` = เซฟได้แล้ว
   */
  const blocked: string | null = !totals.blocked
    ? unnamed > 0
      ? 'ยังมีรายการที่ไม่มีชื่อ'
      : null
    : rows.length === 0
      ? 'ยังไม่มีรายการสักบรรทัด'
      : totals.sumItemsSatang <= 0
        ? 'รายการทุกบรรทัดยังเป็นศูนย์'
        : items.some((item) => item.amountSatang <= 0)
          ? 'มีรายการที่ราคายังเป็นศูนย์ — ของฟรีให้ลบบรรทัดทิ้ง ไม่ต้องจด'
          : bill.paidSatang <= 0
            ? 'ยังไม่ได้ใส่ยอดที่จ่ายจริง'
            : totals.driftSatang !== 0
              ? `ยอดไม่ตรงอยู่ ${baht(Math.abs(totals.driftSatang))} — มีรายการที่ยังไม่ได้จด หรือยอดหัวพิมพ์ผิด`
              : 'ยอดที่จ่ายจริงน้อยกว่าผลรวมรายชิ้น — ถ้าเป็นส่วนลดให้พิมพ์เป็นบาทเอง'

  return (
    <main>
      <style>{CSS}</style>

      <header className="head">
        <div className="name">{session.draft.description}</div>
        <label className="paid">
          <span>
            ยอดที่จ่ายจริง<small>ตัวเลขบนใบเสร็จ รวมค่าบริการแล้ว</small>
          </span>
          <input
            inputMode="decimal"
            value={paid.text}
            onChange={(event) => {
              const text = event.target.value
              /**
               * **ลบจนว่าง = ศูนย์ ไม่ใช่ค่าเดิม** — `parseSatang('')` คืน `null`
               * ซึ่งถ้าปล่อยผ่านจะได้ช่องที่ดูว่างแต่ยอดเดิมยังอยู่ในสถานะ แล้ว
               * กดบันทึกไปด้วยตัวเลขที่เขาเชื่อว่าลบทิ้งแล้ว · ระหว่างพิมพ์ค่าที่
               * ยังอ่านไม่ออก (`12.`) ยังคงยอดเดิมไว้ตามเดิม
               */
              const satang = text.trim() === '' ? 0 : parseSatang(text)
              setPaid({ text, satang })
              if (satang !== null) patch({ paidSatang: satang })
            }}
          />
        </label>
      </header>

      <section>
        <div className="rowhead">
          <h2>คนในบิลนี้</h2>
          <button type="button" className="link" onClick={() => setPicking(!picking)}>
            + เพิ่มคน
          </button>
        </div>
        <div className="chips">
          {bill.people.map((name) => (
            <span key={name} className="chip on">
              {name}
              {name === bill.payerName ? (
                // คนจ่ายเอาออกไม่ได้ (D55) — บิลที่ไม่มีคนจ่ายคือบิลที่ไม่มีเจ้าหนี้
                <em> จ่าย</em>
              ) : (
                <button type="button" aria-label={`เอา ${name} ออก`} onClick={() => askRemove(name)}>
                  ✕
                </button>
              )}
            </span>
          ))}
        </div>

        {picking && (
          <div className="picker">
            <div className="label">คนในวงที่ยังไม่อยู่ในบิล</div>
            <div className="chips">
              {session.roster.filter((name) => !bill.people.includes(name)).length === 0 ? (
                <span className="quiet">ไม่มี — พิมพ์ชื่อใหม่ด้านล่างได้เลย</span>
              ) : (
                session.roster
                  .filter((name) => !bill.people.includes(name))
                  .map((name) => (
                    <button key={name} type="button" className="chip" onClick={() => addPerson(name)}>
                      {name}
                    </button>
                  ))
              )}
            </div>
            <div className="label">หรือพิมพ์ชื่อใหม่</div>
            <div className="add">
              <input
                value={newName}
                placeholder="ชื่อที่วงเรียกเขา"
                onChange={(event) => setNewName(event.target.value)}
              />
              <button type="button" onClick={() => addPerson(newName)}>
                เพิ่ม
              </button>
            </div>
            {warnAbout !== null && (
              // เตือน ไม่ห้าม — `โจ้` กับ `โจ` เป็นคนละคนได้จริง (D55)
              <p className="warn">
                วงนี้มี <b>{warnAbout}</b> อยู่แล้ว — คนละคนกันใช่ไหม
              </p>
            )}
          </div>
        )}

        {pendingRemove !== null && (
          <div className="confirm">
            เอา <b>{pendingRemove.name}</b> ออก แล้ว {pendingRemove.items.join(' · ')}{' '}
            จะกลายเป็นของกลาง หารกับทุกคนในบิล
            <div>
              <button type="button" onClick={() => removePerson(pendingRemove.name)}>
                เอาออก
              </button>
              <button type="button" className="link" onClick={() => setPendingRemove(null)}>
                ไม่เอาออก
              </button>
            </div>
          </div>
        )}
      </section>

      <section>
        <h2>รายการ</h2>
        {rows.map((row) => (
          <div key={row.id} className="item">
            <div className="itemtop">
              <input
                value={row.name}
                placeholder="ชื่อรายการ"
                onChange={(event) => patchRow(row.id, { name: event.target.value })}
              />
              <input
                className="amt"
                inputMode="decimal"
                value={row.amountText}
                placeholder="0.00"
                onChange={(event) => {
                  const text = event.target.value
                  const satang = text.trim() === '' ? 0 : parseSatang(text)
                  /**
                   * อ่านไม่ออกก็เก็บข้อความไว้ให้พิมพ์ต่อ แต่ยอดค้างที่ค่าเดิม —
                   * การเด้งเป็น 0 ใต้นิ้วทำให้แก้ตัวเลขกลางคำไม่ได้ · ลบจนว่าง
                   * เป็นเจตนาที่ชัด จึงกลับเป็น 0 ได้
                   */
                  patchRow(row.id, {
                    amountText: text,
                    ...(satang === null ? {} : { amountSatang: satang }),
                  })
                }}
              />
              <button
                type="button"
                aria-label="ลบรายการ"
                onClick={() => replaceRows(rows.filter((other) => other.id !== row.id))}
              >
                ✕
              </button>
            </div>
            <div className="chips">
              {bill.people.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={`chip${row.eaterNames.includes(name) ? ' on' : ''}`}
                  onClick={() => toggleEater(row, name)}
                >
                  {name}
                </button>
              ))}
              {row.eaterNames.length === 0 && <span className="quiet">ของกลาง — หารทุกคน</span>}
            </div>
          </div>
        ))}
        <button type="button" className="add-item" onClick={() => replaceRows([...rows, newRow()])}>
          + เพิ่มรายการ
        </button>
      </section>

      <section className="ledger">
        <div className="line">
          <span>รวมรายชิ้น</span>
          <b>{baht(totals.sumItemsSatang)}</b>
        </div>

        <div className="adj">
          <div className="line">
            <span>{totals.adjustmentSatang < 0 ? 'ส่วนลด' : 'ค่าบริการ/VAT'}</span>
            <b>{baht(totals.adjustmentSatang)}</b>
          </div>

          <label className="rate">
            <input
              type="checkbox"
              checked={bill.mode === 'rates' && bill.svcOn}
              onChange={(event) => setRate({ svcOn: event.target.checked })}
            />
            <span>service charge</span>
            <input
              className="pct"
              inputMode="decimal"
              defaultValue="10"
              disabled={!(bill.mode === 'rates' && bill.svcOn)}
              onChange={(event) => setPct('svcPct', event.target.value)}
            />
            <span>%</span>
            <b>{totals.serviceSatang === 0 ? '—' : baht(totals.serviceSatang)}</b>
          </label>

          <label className="rate">
            <input
              type="checkbox"
              checked={bill.mode === 'rates' && bill.vatOn}
              onChange={(event) => setRate({ vatOn: event.target.checked })}
            />
            <span>
              VAT{' '}
              {bill.mode === 'rates' && bill.svcOn && (
                // ทบบน `รวมรายชิ้น + service` ไม่ใช่บน subtotal เปล่าๆ (D54)
                <em>ทบบน {baht(totals.sumItemsSatang + totals.serviceSatang)}</em>
              )}
            </span>
            <input
              className="pct"
              inputMode="decimal"
              defaultValue="7"
              disabled={!(bill.mode === 'rates' && bill.vatOn)}
              onChange={(event) => setPct('vatPct', event.target.value)}
            />
            <span>%</span>
            <b>{totals.vatSatang === 0 ? '—' : baht(totals.vatSatang)}</b>
          </label>

          <div className="typed">
            <label>
              พิมพ์เป็นบาทเอง{' '}
              <input
                inputMode="text"
                placeholder={formatSatang(totals.adjustmentSatang)}
                onChange={(event) => {
                  const satang = parseSatang(event.target.value, true)
                  if (satang !== null) patch({ mode: 'amount', typedAdjustmentSatang: satang })
                }}
              />
            </label>
            {bill.mode !== 'auto' && (
              <button type="button" className="link" onClick={() => patch({ mode: 'auto' })}>
                คำนวณให้เอง
              </button>
            )}
          </div>
        </div>
      </section>

      {blocked !== null && <p className="alarm">{blocked}</p>}

      <section>
        <h2>ใครติดเท่าไหร่</h2>
        {totals.shares.length === 0 ? (
          <p className="quiet">แก้ให้ยอดตรงก่อน แล้วตัวเลขจะขึ้นตรงนี้</p>
        ) : (
          totals.shares.map((share) => (
            <div key={share.memberId} className="line">
              <span>
                {share.memberId}
                {session.roster.includes(share.memberId) ? '' : ' (ใหม่)'}
              </span>
              <b>{baht(share.amountSatang)}</b>
            </div>
          ))
        )}
      </section>

      {saveError !== null && <p className="alarm">{saveError}</p>}

      {phase.kind === 'saved' ? (
        <p className="saved">
          บันทึกแล้ว — <b>กลับไปกดยืนยันบนการ์ดในแชท</b> บิลจะลง ledger ตอนนั้น
        </p>
      ) : (
        <button type="button" className="save" disabled={!ready || saving} onClick={() => void save()}>
          {saving ? 'กำลังบันทึก…' : 'บันทึกรายการ'}
        </button>
      )}
    </main>
  )

  /** ติ๊กช่องไหนก็เข้าโหมด `rates` · ติ๊กออกหมด = กลับ `auto` ไม่มีสถานะที่สี่ (D54) */
  function setRate(next: { svcOn?: boolean; vatOn?: boolean }): void {
    if (bill === null) return
    const svcOn = next.svcOn ?? (bill.mode === 'rates' && bill.svcOn)
    const vatOn = next.vatOn ?? (bill.mode === 'rates' && bill.vatOn)
    patch({ svcOn, vatOn, mode: svcOn || vatOn ? 'rates' : 'auto' })
  }

  function setPct(key: 'svcPct' | 'vatPct', text: string): void {
    const pct = parseSatang(text)
    if (pct !== null) patch({ [key]: pct })
  }
}

/**
 * ยิง API แล้วแปลงคำตอบให้เป็นรูปเดียวเสมอ
 *
 * **อ่าน body ก่อนดู `response.ok`** — ฝั่ง server ใส่ข้อความไทยที่บอกทางออกไว้ใน
 * ทุกคำตอบที่ไม่ผ่านแล้ว การทิ้งมันไปเขียนข้อความรวมๆ เองคือการทิ้งของที่ดีกว่า
 */
async function post(
  url: string,
  body: unknown,
): Promise<{ ok: true; session: LiffSession } | { ok: false; message: string }> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    return { ok: false, message: 'เน็ตขัดข้อง ลองใหม่อีกครั้ง' }
  }

  let payload: { ok?: unknown; session?: unknown; message?: unknown } = {}
  try {
    payload = (await response.json()) as typeof payload
  } catch {
    // ปล่อยว่างไว้ — ตกไปใช้ข้อความกลางข้างล่าง
  }

  if (response.ok && payload.ok === true && payload.session !== undefined) {
    return { ok: true, session: payload.session as LiffSession }
  }
  return {
    ok: false,
    message: typeof payload.message === 'string' ? payload.message : 'เปิดบิลใบนี้ไม่ได้',
  }
}

const CSS = `
main{max-width:34rem;margin:0 auto;padding:.75rem;font-size:1rem;line-height:1.5}
main.msg{padding:2rem .75rem;text-align:center;color:#555}
h2{font-size:.95rem;margin:0;font-weight:600}
section{margin:1rem 0}
.head .name{font-size:1.25rem;font-weight:700}
.paid{display:flex;align-items:center;gap:.5rem;justify-content:space-between;margin-top:.5rem}
.paid small{display:block;color:#777;font-size:.75rem;font-weight:400}
.paid input{width:7rem;text-align:right;font-size:1.25rem;font-weight:700;padding:.35rem .5rem;border:1px solid #ccc;border-radius:.4rem}
.rowhead{display:flex;justify-content:space-between;align-items:center;margin-bottom:.4rem}
.chips{display:flex;flex-wrap:wrap;gap:.35rem;margin:.35rem 0}
.chip{display:inline-flex;align-items:center;gap:.25rem;border:1px solid #ccc;background:#fff;color:#333;border-radius:999px;padding:.25rem .6rem;font-size:.85rem}
.chip.on{background:#111;color:#fff;border-color:#111}
.chip em{font-style:normal;opacity:.6;font-size:.75rem}
.chip button{background:none;border:0;color:inherit;padding:0 0 0 .15rem;font-size:.85rem}
.picker{border:1px solid #eee;border-radius:.5rem;padding:.6rem;margin-top:.4rem}
.label{font-size:.75rem;color:#777;margin-top:.35rem}
.add{display:flex;gap:.35rem;margin-top:.3rem}
.add input{flex:1;padding:.35rem .5rem;border:1px solid #ccc;border-radius:.4rem}
.warn{color:#a15c00;font-size:.8rem;margin:.4rem 0 0}
.confirm{border:1px solid #e5c07b;background:#fff8e6;border-radius:.5rem;padding:.6rem;margin-top:.4rem;font-size:.85rem}
.confirm div{display:flex;gap:.6rem;align-items:center;margin-top:.5rem}
.item{border-top:1px solid #eee;padding:.5rem 0}
.itemtop{display:flex;gap:.35rem}
.itemtop input{flex:1;min-width:0;padding:.35rem .5rem;border:1px solid #ccc;border-radius:.4rem}
.itemtop .amt{flex:0 0 5.5rem;text-align:right}
.itemtop button{background:none;border:0;color:#999;padding:0 .25rem}
.add-item{width:100%;margin-top:.5rem;padding:.5rem;border:1px dashed #bbb;background:#fff;border-radius:.5rem;color:#555}
.ledger{border-top:1px solid #eee;padding-top:.6rem}
.line{display:flex;justify-content:space-between;padding:.2rem 0}
.adj{border:1px solid #eee;border-radius:.5rem;padding:.5rem;margin-top:.4rem}
.rate{display:flex;align-items:center;gap:.4rem;font-size:.85rem;padding:.2rem 0}
.rate span:first-of-type{flex:1}
.rate em{font-style:normal;color:#777;font-size:.75rem}
.rate .pct{width:3rem;text-align:right;padding:.2rem .3rem;border:1px solid #ccc;border-radius:.3rem}
.rate b{min-width:4.5rem;text-align:right}
.typed{display:flex;justify-content:space-between;align-items:center;font-size:.85rem;margin-top:.35rem}
.typed input{width:6rem;text-align:right;padding:.2rem .4rem;border:1px solid #ccc;border-radius:.3rem}
.alarm{background:#fdecea;border:1px solid #f5c2bd;color:#8a2118;border-radius:.5rem;padding:.5rem .6rem;font-size:.85rem}
.quiet{color:#888;font-size:.8rem}
.link{background:none;border:0;color:#0b6bcb;font-size:.85rem;padding:0}
.save{width:100%;padding:.8rem;border:0;border-radius:.5rem;background:#111;color:#fff;font-size:1rem;font-weight:600}
.save:disabled{background:#ccc}
.saved{background:#e8f5e9;border:1px solid #b7dfb9;border-radius:.5rem;padding:.6rem;font-size:.9rem}
`
