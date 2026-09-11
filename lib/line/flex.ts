/**
 * การ์ด Draft — Flex message ใบเดียวที่คนต้องอ่านก่อนกดยืนยัน
 *
 * **การโชว์ชื่อทุกคนคือสิ่งที่ทำให้ Roster ที่โตเองไม่กลายเป็นบั๊กเงียบ** (D16)
 * และป้าย `(ใหม่)` คือสิ่งที่ทำให้ชื่อที่พิมพ์ผิดสะดุดตา — `กอล์ฟ` กับ `กอล์ป`
 * ตาคนอ่านผ่านได้ แต่ป้ายข้างคนที่หารกันมาห้าบิลแล้วสะดุดตากว่ามาก (D28)
 *
 * **ไม่มี Passive Nag ต่อท้าย** (D32) — การ์ดนี้มีงานเดียวคือให้คนตรวจแล้วกด
 * **ไม่โชว์วันที่** — คนเพิ่งพิมพ์ไปเมื่อกี้ ไม่มีใครตรวจบรรทัดนั้น
 *
 * ชนิดของ Flex ในไฟล์นี้ประกาศเองเท่าที่ใช้ ไม่ได้ลอกมาทั้งสเปก — เราเป็นคนสร้าง
 * โครงนี้เองทั้งก้อน ชนิดที่กว้างกว่าที่ใช้จริงมีแต่จะกลายเป็นที่ให้พิมพ์ผิดโดยไม่โดนจับ
 */

import { formatSatang } from '../money'
import type { BalanceBlock } from '../flow/balance'
import type { Surface } from '../flow/dispatch'
import type { LineMessage, LineTextMessage } from './messages'
import type { DraftCard } from '../flow/draft'
import type { BillRow } from '../flow/bills'

type FlexText = {
  type: 'text'
  text: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  weight?: 'bold'
  color?: string
  align?: 'end'
  flex?: number
  wrap?: boolean
  margin?: 'sm' | 'md' | 'lg'
}

type FlexPostbackAction = {
  type: 'postback'
  label: string
  data: string
  displayText?: string
}

type FlexBox = {
  type: 'box'
  layout: 'vertical' | 'horizontal' | 'baseline'
  contents: FlexComponent[]
  spacing?: 'sm' | 'md'
  margin?: 'sm' | 'md' | 'lg'
  /** สัดส่วนความกว้างเมื่อกล่องนี้เป็นลูกของกล่องแนวนอน — เกณฑ์เดียวกับ `FlexText` */
  flex?: number
  /** ทั้งกล่องกดได้ — ใช้กับแถวในรายการ `บิล` ซึ่งเป็นทางเดียวไปหารายละเอียด */
  action?: FlexPostbackAction
}

type FlexSeparator = { type: 'separator'; margin?: 'sm' | 'md' | 'lg' }

/**
 * ปุ่มเปิดลิงก์ — LIFF URL เท่านั้นในวันนี้
 *
 * แยกจาก `FlexPostbackAction` เพราะสองอย่างนี้เดินคนละทาง: postback กลับมาที่
 * webhook ของเรา ส่วน uri พา LINE ไปเปิดหน้าเว็บ · และ **เอกสาร LINE ระบุว่า
 * ข้อความที่ผู้ใช้ส่งเองด้วย `liff.sendMessages()` ตั้งได้เฉพาะ uri action**
 * ซึ่งเป็นข้อจำกัดที่จะสำคัญเมื่อถึง Phase 2
 */
type FlexUriAction = {
  type: 'uri'
  label: string
  uri: string
}

type FlexButton = {
  type: 'button'
  style: 'primary' | 'secondary'
  height: 'sm'
  action: FlexPostbackAction | FlexUriAction
}

type FlexComponent = FlexText | FlexBox | FlexSeparator | FlexButton

export type QuickReplyItem = {
  type: 'action'
  action: { type: 'postback'; label: string; data: string; displayText: string }
}

/**
 * การ์ด `ยอด` — สรุปว่าใครติดใครทั้งวง (D31)
 *
 * **จัดกลุ่มตามเจ้าหนี้** เพราะคนที่พิมพ์ `ยอด` คือคนที่ควักเงินไปก่อน · หัวบล็อก
 * มียอดรวมที่เขาได้คืน ซึ่งเป็นตัวเลขที่เขาอยากรู้ก่อนตัวเลขรายคน
 *
 * **ไม่ตัดใครทิ้ง** — Phase 1 ไม่มี LIFF ให้ไปดูส่วนที่ถูกตัด และ ledger ที่ซ่อนยอด
 * โดยไม่มีทางเปิดดูรับไม่ได้ · วงใหญ่จนใส่ไม่ไหวไปโผล่เป็นข้อความแทน ดู
 * `balanceCardMessage`
 *
 * **ไม่มี Passive Nag ต่อท้าย** (D32) — ทั้งใบเป็นยอดค้างอยู่แล้ว · โทน Escalation
 * (D33) เป็นของ Phase 2 พร้อม Passive Nag
 */
/** บล็อกของเจ้าหนี้หนึ่งคน — หัวบล็อกกับแถวลูกหนี้ · ใช้ทั้งใน bubble เดี่ยวและ carousel */
/**
 * @param verb คำที่ต่อท้ายชื่อเจ้าหนี้ — `ได้คืน` สำหรับยอดค้างจริง ส่วนการ์ดสรุป
 *   ตามแท็กใช้ `ออกไปก่อน` เพราะมันตอบไม่ได้ว่าเงินถูกจ่ายคืนไปแล้วหรือยัง (D60)
 */
function creditorBlock(block: BalanceBlock, verb: string): FlexBox {
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    margin: 'md',
    contents: [
      {
        type: 'box',
        layout: 'horizontal',
        contents: [
          {
            type: 'text',
            text: `${shorten(block.creditorName, MAX_NAME)} ${verb}`,
            size: 'sm',
            weight: 'bold',
            wrap: true,
            flex: 3,
          },
          {
            type: 'text',
            text: baht(block.totalSatang),
            size: 'sm',
            weight: 'bold',
            align: 'end',
            flex: 2,
          },
        ],
      },
      ...block.rows.map((row) => row2(shorten(row.debtorName, MAX_NAME), row.amountSatang)),
    ],
  }
}

/**
 * คำบนการ์ด `ยอด` — **ต่างกันทั้งชุดเมื่อกรองตามแท็ก ไม่ใช่เติม disclaimer**
 *
 * D34 ปฏิเสธ "ตอบยอดพร้อมคำเตือน" ไว้แล้วเพราะการ์ดจะมีสองความหมายในใบเดียว
 * และคนที่กวาดตาผ่านจำแค่ตัวเลข · การ์ดสรุปตามแท็กจึงเปลี่ยนหัว เปลี่ยนคำกริยา
 * ของหัวบล็อก และ**ไม่มีคำว่า "ค้าง" อยู่บนใบนั้นเลย** — บรรทัดเตือนเป็นของแถม
 * ไม่ใช่สิ่งเดียวที่กันความเข้าใจผิด
 */
interface BalanceWording {
  title: string
  /**
   * หัวของทางลงที่เป็นข้อความ — ยาวกว่าหัวการ์ดได้เพราะไม่ต้องแย่งที่กับยอดในบรรทัด
   * เดียวกัน · `ยอดค้าง` บนการ์ดมียอดอยู่ข้างๆ ส่วนในข้อความมันคือคำแรกของก้อน
   */
  textTitle: string
  verb: string
  altText: (total: number, count: number) => string
  /** `null` = ไม่มีบรรทัดเตือน (ยอดค้างจริงไม่ต้องอธิบายอะไร) */
  note: string | null
}

/**
 * @param surface ในกลุ่ม `ยอด` เปล่าๆ ตกเป็นความเงียบตาม D47 — บรรทัดที่บอกให้พิมพ์
 *   `ยอด` เฉยๆ จึงส่งคนไปเจอความเงียบ ซึ่งอ่านออกได้อย่างเดียวว่าบอทพัง ·
 *   เกณฑ์เดียวกับที่ `buildGuide` ใส่ `@บิลใหญ่` ให้ตามที่ที่ข้อความไปโผล่
 */
function wordingOf(eventTag: string | null, surface: Surface): BalanceWording {
  if (eventTag === null) {
    return {
      title: 'ยอดค้าง',
      textTitle: 'ยอดค้างทั้งวง',
      verb: 'ได้คืน',
      altText: (total, count) => `ยอดค้างทั้งวง ${baht(total)} · ${count} คนรอรับคืน`,
      note: null,
    }
  }
  const tag = `#${shorten(eventTag, MAX_NAME)}`
  return {
    title: `สรุป ${tag}`,
    textTitle: `สรุป ${tag}`,
    verb: 'ออกไปก่อน',
    altText: (total, count) => `สรุป ${tag} ${baht(total)} · ${count} คนออกเงินไปก่อน`,
    note: `ยอดของบิลที่ติดแท็กนี้ ไม่ได้หักเงินที่จ่ายคืนกันแล้ว — ยอดจริงพิมพ์ ${
      surface === 'group' ? '@บิลใหญ่ ยอด' : 'ยอด'
    }`,
  }
}

/** หัวการ์ดพร้อมบรรทัดเตือน — `paginate` ซ้ำก้อนนี้ทุกใบของ carousel */
function balanceHeader(wording: BalanceWording, total: number): FlexComponent[] {
  const header: FlexComponent[] = [
    {
      type: 'box',
      layout: 'horizontal',
      contents: [
        { type: 'text', text: wording.title, size: 'lg', weight: 'bold', flex: 3 },
        { type: 'text', text: baht(total), size: 'lg', weight: 'bold', align: 'end', flex: 2 },
      ],
    },
  ]
  if (wording.note !== null) {
    header.push({ type: 'text', text: wording.note, size: 'sm', color: '#8c8c8c', wrap: true })
  }
  return header
}

function balanceBubble(blocks: readonly BalanceBlock[], wording: BalanceWording): LineFlexMessage {
  const total = blocks.reduce((sum, block) => sum + block.totalSatang, 0)

  const contents: FlexComponent[] = balanceHeader(wording, total)

  for (const block of blocks) {
    contents.push({ type: 'separator', margin: 'md' })
    contents.push(creditorBlock(block, wording.verb))
  }

  return {
    type: 'flex',
    altText: wording.altText(total, blocks.length),
    // การ์ดนี้อ่านอย่างเดียว ไม่มี footer
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', contents },
    },
  }
}

/**
 * การ์ด `ยอด` — Flex ถ้าใส่ได้ ไม่งั้นเป็นข้อความที่มีเนื้อหาเท่ากันเป๊ะ
 *
 * **แถว Flex หนึ่งแถวหนักราว 250 ไบต์** เพราะเป็น box ที่มี text สองก้อน · วง 8 คน
 * ที่ทุกคนเคยจ่ายมีได้ถึง 28 คู่ ซึ่งทะลุเพดาน 10 KB ของ bubble ไปแล้ว · ทะลุเมื่อไหร่
 * LINE ปฏิเสธทั้งข้อความ แล้วคนพิมพ์ `ยอด` จะไม่เห็นอะไรเลย
 *
 * D31 ห้ามตัดคนออกเพราะ Phase 1 ไม่มีที่ให้ไปดูส่วนที่ถูกตัด — **ทางลงจึงเป็นการ
 * ลดรูป ไม่ใช่ตัดเนื้อหา** · reply ส่งได้ 5 ก้อนต่อครั้ง ก้อนละ 5000 ตัวอักษร ซึ่ง
 * รับได้ราว 800 แถว มากกว่าวงจริงทุกขนาด
 */
/**
 * @param eventTag `null` = ยอดค้างทั้งวงตามเดิม · มีค่า = **สรุปของบิลที่ติดแท็ก
 *   นั้น ซึ่งไม่ใช่ยอดค้าง** (D60) — `settlement` ไม่มีแท็กให้หักออก คำบนการ์ด
 *   จึงเปลี่ยนทั้งชุด ไม่ใช่เติมบรรทัดเตือนท้ายการ์ดยอดค้างใบเดิม
 */
export function balanceCardMessage(
  blocks: readonly BalanceBlock[],
  /**
   * **บังคับส่ง ไม่มีค่าเริ่มต้น** — เกณฑ์เดียวกับ `renderReply`: ค่าเริ่มต้นทำให้
   * จุดเรียกที่ลืมส่งกลายเป็นคำแนะนำที่ผิดที่แบบเงียบๆ
   */
  surface: Surface,
  eventTag: string | null = null,
): LineMessage[] {
  const wording = wordingOf(eventTag, surface)
  const bubble = balanceBubble(blocks, wording)
  if (Buffer.byteLength(JSON.stringify(bubble), 'utf8') <= MAX_BUBBLE_BYTES) return [bubble]

  /**
   * **เลื่อนข้างก่อน แล้วค่อยลดรูป** (D52)
   *
   * D31 ห้ามตัดใครทิ้งเพราะ Phase 1 ไม่มีที่ให้ไปดูส่วนที่ถูกตัด · carousel เก็บ
   * ทุกคนไว้ครบเหมือน text แต่ยังเป็นการ์ดที่อ่านง่ายกว่ากองข้อความ · หัวการ์ดที่มี
   * ยอดรวมซ้ำทุกใบ เพราะคนเลื่อนไปใบที่สามต้องยังรู้ว่ากำลังดูอะไรอยู่
   */
  const total = blocks.reduce((sum, block) => sum + block.totalSatang, 0)
  const pages = paginate(
    balanceHeader(wording, total),
    blocks.map((block) => creditorBlock(block, wording.verb)),
  )
  if (pages !== null) {
    const carousel: LineFlexMessage = {
      type: 'flex',
      altText: bubble.altText,
      contents: { type: 'carousel', contents: pages },
    }
    if (Buffer.byteLength(JSON.stringify(carousel), 'utf8') <= MAX_CAROUSEL_BYTES) {
      return [carousel]
    }
  }

  const chunks: string[] = []
  /**
   * หัวกับบรรทัดเตือนต้องรอดมาถึงข้อความด้วย — ทางลงนี้เปลี่ยนรูป ไม่ใช่เปลี่ยน
   * ความหมาย · การ์ดสรุปตามแท็กที่กลายเป็นข้อความแล้วพูดว่า "ยอดค้าง" คือคำตอบ
   * ที่ผิดคำถาม ซึ่ง D34 ปฏิเสธไว้ตั้งแต่ต้น
   */
  /**
   * **หัวซ้ำทุกก้อน ไม่ใช่เฉพาะก้อนแรก** — เกณฑ์เดียวกับที่ D52 ให้หัวการ์ดซ้ำทุกใบ
   * ของ carousel · ก้อนที่สองเป็นต้นไปที่ไม่มีหัวคือรายชื่อกับตัวเลขลอยๆ ที่ไม่บอก
   * ว่าเป็นสรุปของทริปหรือยอดค้าง ซึ่งเป็นความต่างทั้งหมดของการ์ดสองใบนี้
   */
  const heading =
    wording.note === null
      ? `${wording.textTitle} ${baht(total)}`
      : `${wording.textTitle} ${baht(total)}${LF}${wording.note}`
  let current = heading

  const push = (line: string): void => {
    // +1 สำหรับตัวขึ้นบรรทัดที่จะต่อเข้าไป
    if (current.length + line.length + 1 > MAX_TEXT) {
      chunks.push(current)
      current = heading + LF + line
    } else {
      current = current + LF + line
    }
  }

  for (const block of blocks) {
    push('')
    push(`${shorten(block.creditorName, MAX_NAME)} ${wording.verb} ${baht(block.totalSatang)}`)
    for (const row of block.rows) {
      push(`  ${shorten(row.debtorName, MAX_NAME)} ${baht(row.amountSatang)}`)
    }
  }
  chunks.push(current)

  // เกินห้าก้อนแปลว่าวงใหญ่กว่าที่ระบบนี้ออกแบบมารับไหว — **บอกตรงๆ ว่าตัด**
  // ไม่ใช่เงียบๆ ตัดทิ้ง ซึ่งใน ledger คือยอดหาย
  if (chunks.length > MAX_MESSAGES) {
    const kept = chunks.slice(0, MAX_MESSAGES - 1)
    // ก้อนบอกว่าตัดก็ยังต้องมีหัว — มันคือก้อนสุดท้ายที่คนอ่าน และหัวคือสิ่งที่บอกว่า
    // กำลังอ่านสรุปของทริปอยู่ ไม่ใช่ยอดค้าง
    kept.push(
      `${heading}${LF}${LF}ยังมีต่ออีก ${chunks.length - kept.length} ส่วนที่ยาวเกินกว่าจะส่งในครั้งเดียว`,
    )
    return kept.map((text) => ({ type: 'text', text }))
  }
  return chunks.map((text) => ({ type: 'text', text }))
}

export type FlexBubble = {
  type: 'bubble'
  body: FlexBox
  /**
   * ไม่ใส่เลยเมื่อไม่มีปุ่ม — **box ที่ `contents` ว่างถูก LINE ปฏิเสธทั้งข้อความ**
   * ซึ่งจะทำให้คนพิมพ์ `ยอด` ไม่เห็นอะไรเลย
   */
  footer?: FlexBox
}

export interface LineFlexMessage {
  type: 'flex'
  /** ข้อความที่ขึ้นใน notification และในไคลเอนต์ที่แสดง Flex ไม่ได้ */
  altText: string
  contents: FlexBubble | { type: 'carousel'; contents: FlexBubble[] }
  quickReply?: { items: QuickReplyItem[] }
}

/**
 * LINE รับ quick reply ได้ 13 ปุ่มต่อข้อความ — กันไว้หนึ่งช่องให้ `ฉันเป็นคนใหม่`
 * ซึ่งต้องมีเสมอ ไม่งั้นคนในวงใหญ่ที่ยังไม่มีชื่อตัวเองจะไปต่อไม่ได้เลย
 */
const MAX_IDENTITY_CHOICES = 12

/** ปุ่มที่ยาวเกินจะถูกตัดให้พอดีจอ — ไม่ใช่เพดานที่เอกสารระบุ แต่กันไว้ */
const MAX_LABEL = 20

/**
 * คำอธิบายบิลคือทุก token ก่อนยอด ซึ่งยาวได้ถึงเพดานข้อความของ LINE — และยาวง่าย
 * ที่สุดทางเส้น @mention ที่ไม่ต้องมี `+` นำหน้า
 *
 * ปล่อยยาวไม่ได้เพราะ `altText` มีเพดานของมันเอง · ถ้าทะลุ LINE จะปฏิเสธ reply
 * ทั้งก้อน แล้วผลคือ **แถว draft ถูกเขียนไปแล้วแต่ไม่มีการ์ดให้ใครกด** ซึ่งกู้ไม่ได้
 * เลยจนกว่าจะหมดอายุ
 */
const MAX_DESCRIPTION = 60

function shorten(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/** `฿1,200` — `formatSatang` ตัด `.00` ทิ้งให้แล้วเมื่อไม่มีเศษสตางค์ */
function baht(satang: number): string {
  return `฿${formatSatang(satang)}`
}

/** ชื่อยาวเกินจอถูกตัด — การ์ดนี้ไม่มีปุ่ม ตัวเลขจึงสำคัญกว่าชื่อเต็ม */
const MAX_NAME = 24

/**
 * เพดานของ carousel — **ตั้งให้ปลอดภัยใต้ตัวเลขที่เข้มที่สุดที่หาเจอ** (D52)
 *
 * เอกสาร LINE ที่ยิงดูห้าหน้าไม่ยอมบอกตัวเลขตรงๆ · ที่ค้นเจอคือ 10 bubble ต่อ
 * carousel และ JSON ทั้งข้อความ 50 KB ซึ่ง **ยังไม่ได้ยิงของจริงยืนยัน** · เลือก
 * ค่าที่ปลอดภัยกว่าทั้งสองข้ออ้าง: เกินเมื่อไหร่ก็ตกลงไปเป็น text ซึ่งเป็นพฤติกรรม
 * เดิมอยู่แล้ว การเดาต่ำจึงไม่มีทางทำให้แย่ลงกว่าวันนี้
 */
const MAX_CAROUSEL_BUBBLES = 10
const MAX_CAROUSEL_BYTES = 45_000

/**
 * ชื่อคนกินต่อหนึ่งรายการ — ยาวกว่าชื่อคนเดี่ยวเพราะเป็นหลายชื่อต่อกัน
 *
 * บิลที่ทุกคนกินร่วมกันจะมีชื่อครบวงในบรรทัดเดียว การ์ดจึงต้องมีเพดานของมันเอง
 */
const MAX_EATERS = 60

/**
 * เพดาน JSON ของ bubble หนึ่งใบตามเอกสาร LINE คือ 10 KB — เผื่อไว้หน่อย
 *
 * ทะลุเมื่อไหร่ LINE ปฏิเสธทั้งข้อความ แล้วคนพิมพ์ `ยอด` จะไม่เห็นอะไรเลย ซึ่ง
 * **แย่กว่าการ์ดที่หน้าตาไม่สวย** · D31 ห้ามตัดคนออกเพราะ Phase 1 ไม่มีที่ให้ไปดู
 * ส่วนที่ถูกตัด — ทางลงจึงเป็นการเปลี่ยนรูปแบบ ไม่ใช่ตัดเนื้อหา
 */
const MAX_BUBBLE_BYTES = 9_000

/** เพดานของ text message และจำนวนก้อนต่อ reply ตามเอกสาร LINE */
const MAX_TEXT = 5_000
const MAX_MESSAGES = 5

/** ตัวขึ้นบรรทัด — แยกออกมาเพื่อไม่ให้ต้องมี template literal คร่อมสองบรรทัด */
const LF = String.fromCharCode(10)

/** แถวลูกหนี้ในการ์ด `ยอด` — เยื้องเข้าไปให้เห็นว่าอยู่ใต้เจ้าหนี้คนไหน */
function row2(name: string, amountSatang: number): FlexBox {
  return {
    type: 'box',
    layout: 'horizontal',
    contents: [
      { type: 'text', text: `  ${name}`, size: 'sm', color: '#555555', wrap: true, flex: 3 },
      { type: 'text', text: baht(amountSatang), size: 'sm', align: 'end', flex: 2 },
    ],
  }
}

function row(name: string, amountSatang: number): FlexBox {
  return {
    type: 'box',
    layout: 'horizontal',
    contents: [
      { type: 'text', text: name, size: 'sm', wrap: true, flex: 3 },
      { type: 'text', text: baht(amountSatang), size: 'sm', align: 'end', flex: 2 },
    ],
  }
}

/**
 * แถวของรายการรายชิ้น — ชื่อรายการ ชื่อคนกิน แล้วราคา
 *
 * **ชื่อคนกินอยู่ในแถวเดียวกัน ไม่ใช่บรรทัดใหม่** เพราะจำนวนแถวคือสิ่งที่ผลัก
 * การ์ดเข้าหาเพดาน bubble และใบเสร็จร้านอาหารมีรายการได้หลายสิบชิ้น
 *
 * ยาวเกินก็ตัด — `wrap` ทำให้แถวสูงขึ้นแทนที่จะดันราคาตกขอบ
 */
function itemRow(name: string, eaterNames: readonly string[], amountSatang: number): FlexBox {
  return {
    type: 'box',
    layout: 'horizontal',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        flex: 3,
        contents: [
          { type: 'text', text: name, size: 'sm', wrap: true },
          {
            type: 'text',
            text: shorten(eaterNames.join(', '), MAX_EATERS),
            size: 'sm',
            color: '#8c8c8c',
            wrap: true,
          },
        ],
      },
      { type: 'text', text: baht(amountSatang), size: 'sm', align: 'end', flex: 2 },
    ],
  }
}

/**
 * แถวเลือกตัวตนของคนพิมพ์ (D29 / ADR 0002)
 *
 * เป็น quick reply ไม่ใช่ปุ่มบนการ์ด เพราะจำนวนตัวเลือกโตตามจำนวนคนในวง — การ์ด
 * จะสูงขึ้นเรื่อยๆ ส่วน quick reply เลื่อนข้างได้และไม่กินพื้นที่การ์ดเลย
 *
 * ทุกปุ่มพา `draftId` ไปด้วย เพราะการกดคือ **claim + ยืนยันบิลในจังหวะเดียว**
 */
function identityQuickReply(
  draftId: string,
  unclaimed: readonly IdentityChoice[],
): QuickReplyItem[] {
  const items: QuickReplyItem[] = []
  for (const choice of unclaimed.slice(0, MAX_IDENTITY_CHOICES)) {
    // ส่ง **id ไม่ใช่ชื่อ** — ชื่อไทยที่ผ่าน `encodeURIComponent` ยาวขึ้นเก้าเท่า
    // แล้วทะลุเพดาน 300 ตัวอักษรตั้งแต่ชื่อยาวราว 27 ตัว · id ยาวคงที่เสมอ
    items.push({
      type: 'action',
      action: {
        type: 'postback',
        label: shorten(choice.name, MAX_LABEL),
        data: `confirm=${draftId}&as=${choice.id}`,
        displayText: choice.name,
      },
    })
  }
  items.push({
    type: 'action',
    action: {
      type: 'postback',
      label: 'ฉันเป็นคนใหม่',
      data: `confirm=${draftId}&as=new`,
      displayText: 'ฉันเป็นคนใหม่',
    },
  })
  return items
}

/** Member ที่ยังไม่มีเจ้าของ — ตัวเลือกหนึ่งอันในแถวเลือกตัวตน */
export interface IdentityChoice {
  id: string
  name: string
}

/**
 * @param unclaimed Member ที่ยังไม่มีเจ้าของ · `null` = คนพิมพ์ยืนยันตัวตนไปแล้ว
 *   จึงไม่ต้องถาม และการ์ดมีปุ่ม `ยืนยัน` ตามปกติ
 */
/**
 * @param liffUrl `https://liff.line.me/<liffId>` · `null` = ยังไม่ได้ตั้ง
 *   `NEXT_PUBLIC_LIFF_ID` แล้วการ์ดจะไม่มีปุ่มจดรายชิ้นเลย ซึ่งดีกว่าปุ่มที่กด
 *   แล้วพา LINE ไปเปิดลิงก์เสีย
 */
export function draftCardMessage(
  card: DraftCard,
  draftId: string,
  unclaimed: readonly IdentityChoice[] | null = null,
  liffUrl: string | null = null,
): LineMessage[] {
  const description = shorten(card.description, MAX_DESCRIPTION)
  const header: FlexComponent[] = [
    {
      type: 'box',
      layout: 'horizontal',
      contents: [
        { type: 'text', text: description, size: 'lg', weight: 'bold', wrap: true, flex: 3 },
        {
          type: 'text',
          text: baht(card.totalSatang),
          size: 'lg',
          weight: 'bold',
          align: 'end',
          flex: 2,
        },
      ],
    },
  ]

  if (card.eventTag !== undefined) {
    header.push({ type: 'text', text: `#${card.eventTag}`, size: 'sm', color: '#8c8c8c' })
  }

  /**
   * ยังไม่รู้ว่าเขาคือใคร = **ไม่มีปุ่มยืนยันบนการ์ด**
   *
   * ปล่อยให้มีจะกลายเป็นทางตัน: กดแล้วเราไม่รู้ว่าจะบันทึกว่าใครจ่าย แล้วต้องตอบ
   * ให้ไปกดปุ่มอื่นแทน ซึ่งเป็นการเพิ่มรอบให้กับสิ่งที่ ADR 0002 ตั้งใจให้จบในกดเดียว
   */
  /**
   * ปุ่มเปิดหน้าจอจดรายชิ้น (D56) — **URI action ไม่ใช่ postback** เพราะมันคือ
   * ลิงก์ LIFF ธรรมดา · อยู่ทั้งบนการ์ดที่มีปุ่มยืนยันและการ์ดที่ยังไม่มี เพราะ
   * ตัวตนถูกถามตอนกดยืนยัน ไม่ใช่ตอนแก้รายการ (ADR 0002)
   *
   * สิทธิ์ไม่ได้อยู่ที่ปุ่ม — ใครกดก็เปิดได้ แล้ว `/api/liff/session` ตอบ 403 ให้
   * คนที่ไม่ใช่คนพิมพ์ (D26) · ซ่อนปุ่มตามคนดูทำไม่ได้อยู่แล้ว การ์ดใบเดียวถูก
   * ส่งเข้ากลุ่มให้ทุกคนเห็นเหมือนกันหมด
   */
  const itemizeButton: FlexComponent[] =
    liffUrl === null
      ? []
      : [
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'uri',
              label: 'จดรายชิ้น',
              uri: `${liffUrl}?draftId=${draftId}`,
            },
          },
        ]

  const footer: FlexBox =
    unclaimed === null
      ? {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'button',
              style: 'primary',
              height: 'sm',
              action: {
                type: 'postback',
                label: 'ยืนยัน',
                // **id ของ draft เท่านั้น** — สั้นและยาวคงที่ ไม่โตตามจำนวนคนในบิล
                // จึงไม่มีวันชนเพดาน 300 ตัวอักษรของ postback data (ADR 0001)
                data: `confirm=${draftId}`,
                // ข้อความที่ขึ้นในแชทในนามคนกด — ทำให้กลุ่มเห็นว่าใครเป็นคนยืนยัน
                displayText: 'ยืนยัน',
              },
            },
            ...itemizeButton,
          ],
        }
      : {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            {
              type: 'text',
              text: 'เลือกชื่อของคุณด้านล่างเพื่อยืนยัน',
              size: 'sm',
              color: '#8c8c8c',
              wrap: true,
            },
            ...itemizeButton,
          ],
        }

  const rows = card.lines.map((line) =>
    row(line.isNew ? `${line.name} (ใหม่)` : line.name, line.amountSatang),
  )
  const body: FlexBox = {
    type: 'box',
    layout: 'vertical',
    contents: [
      ...header,
      { type: 'separator', margin: 'md' },
      { type: 'box', layout: 'vertical', spacing: 'sm', margin: 'md', contents: rows },
    ],
  }

  const message: LineFlexMessage = {
    type: 'flex',
    // ยอดกับจำนวนคนอยู่ในบรรทัดเดียว เพราะนี่คือทั้งหมดที่คนเห็นตอนเด้งเตือน
    altText: `ตรวจบิล ${description} ${baht(card.totalSatang)} · ${card.lines.length} คน`,
    ...(unclaimed === null
      ? {}
      : { quickReply: { items: identityQuickReply(draftId, unclaimed) } }),
    contents: { type: 'bubble', body, footer },
  }
  if (Buffer.byteLength(JSON.stringify(message), 'utf8') <= MAX_BUBBLE_BYTES) return [message]

  /**
   * **วงใหญ่จนใส่ bubble เดียวไม่ไหว — เลื่อนข้างแทนที่จะไม่มีการ์ดเลย** (D52)
   *
   * ก่อนหน้านี้การ์ด Draft ไม่มีทางลงเลยสักทาง · ทะลุเพดานเมื่อไหร่ LINE ปฏิเสธ
   * ทั้ง reply แล้วผลคือ **แถว draft ถูกเขียนไปแล้วแต่ไม่มีการ์ดให้ใครกด** ซึ่งกู้
   * ไม่ได้จนกว่าจะหมดอายุ 24 ชั่วโมง
   *
   * **ปุ่มยืนยันอยู่ทุกใบ** — ปุ่มที่อยู่ใบเดียวคือปุ่มที่คนเลื่อนผ่านแล้วหาไม่เจอ ·
   * กดซ้ำไม่เป็นไรเพราะ commit คือ `delete draft` + `insert expense` ใน transaction
   * เดียว ครั้งที่สองจึงลบไม่โดนแล้วไม่ทำอะไรต่อ (ADR 0001)
   */
  const pages = paginate(header, rows)
  if (pages !== null) {
    const withFooter = pages.map((bubble) => ({ ...bubble, footer }))
    const carousel: LineFlexMessage = {
      ...message,
      contents: { type: 'carousel', contents: withFooter },
    }
    if (Buffer.byteLength(JSON.stringify(carousel), 'utf8') <= MAX_CAROUSEL_BYTES) {
      return [carousel]
    }
  }

  /**
   * **ทางลงสุดท้าย — ลดรูปเป็นข้อความ ไม่ใช่คืน bubble ที่ LINE ปฏิเสธ** (D59)
   *
   * ก่อนหน้านี้บรรทัดนี้คือ `return message` ซึ่งเป็น bubble ใบเกินเพดาน · LINE
   * ปฏิเสธ reply ทั้งก้อน แล้วผลคือ **แถว draft ถูกเขียนไปแล้วแต่ไม่มีการ์ดให้ใครกด**
   * กู้ไม่ได้จนกว่าจะหมดอายุ 24 ชั่วโมง และพิมพ์ใหม่ก็ได้ผลเดิมเพราะบิลใบเดิม
   *
   * เกณฑ์เดียวกับ `balanceCardMessage`: **ลดรูป ไม่ใช่ตัดเนื้อหา** (D16 ห้ามให้ชื่อ
   * ใครหายจากบิลเงียบๆ)
   *
   * **quick reply คือสิ่งเดียวที่ทำให้ข้อความนี้ยังเป็นการ์ดได้** — postback ติดกับ
   * text message ได้ทางนี้ · ข้อความที่กดยืนยันไม่ได้เท่ากับไม่มีการ์ดเลย
   */
  const chunks: string[] = []
  /**
   * **ป้าย event อยู่บนหัวด้วย** — มันอยู่บนหัวของทั้ง bubble และทุกใบของ carousel ·
   * ตกหล่นตรงนี้แปลว่าคนตรวจก่อนกดยืนยันไม่เห็นว่าบิลถูกจดเข้าทริปไหน แล้วแท็กที่
   * พิมพ์ผิดจะลง ledger โดยไม่มีใครทัน ซึ่งคือการตัดเนื้อหา ไม่ใช่การลดรูป
   */
  const tag = card.eventTag === undefined ? '' : ` #${card.eventTag}`
  let current = `ตรวจบิล ${description}${tag} ${baht(card.totalSatang)} · ${card.lines.length} คน`

  const push = (line: string): void => {
    // +1 สำหรับตัวขึ้นบรรทัดที่จะต่อเข้าไป
    if (current.length + line.length + 1 > MAX_TEXT) {
      chunks.push(current)
      current = line
    } else {
      current = current + LF + line
    }
  }

  push('')
  for (const line of card.lines) {
    const name = shorten(line.name, MAX_NAME)
    push(`${line.isNew ? `${name} (ใหม่)` : name} ${baht(line.amountSatang)}`)
  }
  push('')
  push(
    unclaimed === null
      ? 'บิลนี้ใหญ่เกินกว่าจะแสดงเป็นการ์ด กดยืนยันจากปุ่มด้านล่าง'
      : 'บิลนี้ใหญ่เกินกว่าจะแสดงเป็นการ์ด เลือกชื่อของคุณจากปุ่มด้านล่างเพื่อยืนยัน',
  )
  // ปุ่มจดรายชิ้นเป็น URI ซึ่ง quick reply ของเราไม่รับ — ลิงก์จึงอยู่ในเนื้อข้อความ
  if (liffUrl !== null) push(`จดรายชิ้น: ${liffUrl}?draftId=${draftId}`)
  chunks.push(current)

  /**
   * ใหญ่กว่าที่ระบบนี้ออกแบบมารับไหว — **บอกตรงๆ ว่าตัด** ไม่ใช่เงียบๆ ตัดทิ้ง
   * ซึ่งในบิลคือคนหายไปจากการหารโดยไม่มีอะไรส่งเสียง · ก้อนสุดท้ายต้องเป็นก้อนที่
   * บอกว่าตัด เพราะ quick reply ไปเกาะก้อนสุดท้ายเสมอ
   */
  const kept =
    chunks.length > MAX_MESSAGES
      ? [
          ...chunks.slice(0, MAX_MESSAGES - 1),
          `ยังมีอีก ${chunks.length - (MAX_MESSAGES - 1)} ส่วนที่ยาวเกินกว่าจะส่งในครั้งเดียว` +
            LF +
            (unclaimed === null
              ? 'กดยืนยันจากปุ่มด้านล่างได้เลย ยอดที่ลงบิลคิดจากทุกคนครบ'
              : 'เลือกชื่อของคุณจากปุ่มด้านล่างได้เลย ยอดที่ลงบิลคิดจากทุกคนครบ') +
            /**
             * **ลิงก์ต้องมาอยู่ก้อนนี้ด้วย** — มันถูก push ไว้ท้ายสุด จึงตกอยู่ใน
             * ส่วนที่เพิ่งถูกตัดทิ้งเสมอ · บิลที่ใหญ่จนต้องตัดคือบิลที่คนอยากเปิด
             * หน้าจอไปแก้มากที่สุด และข้อความนี้เป็นทางเดียวที่เหลือ (quick reply
             * ของเราไม่รับ URI action)
             */
            (liffUrl === null ? '' : `${LF}จดรายชิ้น: ${liffUrl}?draftId=${draftId}`),
        ]
      : chunks

  return kept.map((text, index) => {
    const message: LineTextMessage = { type: 'text', text }
    // LINE แสดง quick reply ของก้อนสุดท้าย — ติดไว้ก้อนอื่นแล้วมันหายไปกับก้อนถัดมา
    if (index < kept.length - 1) return message
    return {
      ...message,
      quickReply: {
        items:
          unclaimed === null
            ? [
                {
                  type: 'action' as const,
                  action: {
                    type: 'postback' as const,
                    label: 'ยืนยัน',
                    data: `confirm=${draftId}`,
                    displayText: 'ยืนยัน',
                  },
                },
              ]
            : identityQuickReply(draftId, unclaimed),
      },
    }
  })
}

/**
 * การ์ด `บิล` — รายการบิลที่กดดูรายละเอียดรายใบได้ (D45)
 *
 * **แถวมีแค่ชื่อ วันที่ ยอด ไม่มีรายชื่อคน** — นี่คือทั้งหมดของ D45 · แถวที่กาง
 * รายคนจะหนักตามขนาดวง วง 4 คนแค่ 8 ใบก็ทะลุเพดาน bubble ส่วนแถวแบบนี้หนักคงที่
 * ราว 250 ไบต์ ใส่ได้ราว 35 ใบไม่ว่าวงจะใหญ่แค่ไหน · รายละเอียดไปอยู่หลังการกด
 *
 * **การ์ดนี้ไม่พูดว่าใครยังค้างในใบไหน** — `settlement` ไม่ได้ชี้ `expense` คำว่า
 * "บิลใบนี้ยังไม่ถูกจ่าย" ไม่มีอยู่ในระบบ (D33) · การ์ดที่อ้างแบบนั้นคือตัวเลขผิด
 * ใน ledger ซึ่งแย่กว่าดูยาก · อยากรู้ว่าใครติดใครให้พิมพ์ `ยอด`
 */
function billListBubble(rows: readonly BillRow[], omitted: number): LineFlexMessage {
  const contents: FlexComponent[] = [
    {
      type: 'box',
      layout: 'horizontal',
      contents: [
        { type: 'text', text: 'บิลที่จดไว้', size: 'lg', weight: 'bold', flex: 3 },
        {
          type: 'text',
          text: `${rows.length + omitted} ใบ`,
          size: 'lg',
          weight: 'bold',
          align: 'end',
          flex: 2,
        },
      ],
    },
    { type: 'separator', margin: 'md' },
  ]

  for (const bill of rows) {
    contents.push({
      type: 'box',
      layout: 'horizontal',
      margin: 'md',
      // **`expense.id` เท่านั้น ห้ามพาชื่อ** — ชื่อไทยผ่าน `encodeURIComponent`
      // ยาวขึ้นเก้าเท่าแล้วทะลุเพดาน 300 ตัวอักษรตั้งแต่ชื่อยาวราว 27 ตัว (ADR 0002)
      action: {
        type: 'postback',
        label: shorten(bill.description, MAX_LABEL),
        data: `bill=${bill.id}`,
        // **ต้องตัดเหมือน `label`** — เพดาน `displayText` คือ 300 ตัวอักษร และ
        // คำอธิบายบิลยาวได้ถึงเพดานข้อความของ LINE (ดู `MAX_DESCRIPTION`) ·
        // ทะลุเมื่อไหร่ LINE ปฏิเสธ reply ทั้งก้อน แล้วคนพิมพ์ `บิล` ไม่เห็นอะไรเลย
        displayText: shorten(bill.description, MAX_NAME),
      },
      contents: [
        { type: 'text', text: shorten(bill.description, MAX_NAME), size: 'sm', flex: 4 },
        { type: 'text', text: bill.date, size: 'sm', color: '#555555', flex: 3 },
        // `›` อยู่ในก้อนเดียวกับยอด — คนต้องเห็นว่าแถวกดได้ แต่ component ที่เพิ่ม
        // มาอีกก้อนคือน้ำหนักที่คูณด้วยจำนวนบิลทุกใบ
        { type: 'text', text: `${baht(bill.totalSatang)}  ›`, size: 'sm', align: 'end', flex: 4 },
      ],
    })
  }

  // ตัดได้ แต่ต้องบอกว่าตัดไปเท่าไหร่ (D31/D44) · Phase 2 เปลี่ยนบรรทัดนี้เป็นปุ่ม
  // เปิด LIFF ตาม D46 ซึ่งเป็นเงื่อนไขที่ D31 ระบุไว้เองว่าทำให้การตัดยอมรับได้
  if (omitted > 0) {
    contents.push({ type: 'separator', margin: 'md' })
    contents.push({
      type: 'text',
      text: `ยังมีอีก ${omitted} ใบที่ไม่ได้แสดง`,
      size: 'sm',
      color: '#555555',
      margin: 'md',
      wrap: true,
    })
  }

  return {
    type: 'flex',
    altText: `บิลที่จดไว้ ${rows.length + omitted} ใบ`,
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', contents },
    },
  }
}

/**
 * การ์ด `บิล` — Flex ถ้าใส่ได้ ไม่งั้นเป็นข้อความที่มีเนื้อหาเท่ากัน
 *
 * ทางลงเดียวกับ `balanceCardMessage` · **ราคาที่ต่างคือแถวที่ลดรูปแล้วกดไม่ได้**
 * จึงต้องบอกวิธีไปต่อ ไม่ใช่ปล่อยให้เขาเดาว่าทำไมกดไม่ติด
 */
export function billListCardMessage(view: {
  kind: 'bills'
  rows: readonly BillRow[]
  omitted: number
}): LineMessage[] {
  const bubble = billListBubble(view.rows, view.omitted)
  if (Buffer.byteLength(JSON.stringify(bubble), 'utf8') <= MAX_BUBBLE_BYTES) return [bubble]

  const chunks: string[] = []
  let current = `บิลที่จดไว้ ${view.rows.length + view.omitted} ใบ`

  const push = (line: string): void => {
    if (current.length + line.length + 1 > MAX_TEXT) {
      chunks.push(current)
      current = line
    } else {
      current = current + LF + line
    }
  }

  push('')
  for (const bill of view.rows) {
    push(`${shorten(bill.description, MAX_NAME)} · ${bill.date} · ${baht(bill.totalSatang)}`)
  }
  if (view.omitted > 0) {
    push('')
    push(`ยังมีอีก ${view.omitted} ใบที่ไม่ได้แสดง`)
  }
  // ข้อความไม่มี action — คนที่เคยกดแถวได้จะกดแล้วไม่เกิดอะไรโดยไม่รู้สาเหตุ
  push('')
  push('รายการยาวเกินกว่าจะทำเป็นการ์ด แถวนี้จึงกดไม่ได้')
  chunks.push(current)

  if (chunks.length > MAX_MESSAGES) {
    const kept = chunks.slice(0, MAX_MESSAGES - 1)
    kept.push(`ยังมีต่ออีก ${chunks.length - kept.length} ส่วนที่ยาวเกินกว่าจะส่งในครั้งเดียว`)
    return kept.map((text) => ({ type: 'text', text }))
  }
  return chunks.map((text) => ({ type: 'text', text }))
}

/**
 * แบ่งแถวลง bubble หลายใบ — **ทางลงชั้นแรกก่อนลดรูปเป็น text** (D52)
 *
 * ตัดตามขนาดจริงของ JSON ไม่ใช่ตามจำนวนแถว เพราะแถวหนักไม่เท่ากัน: แถวรายการ
 * มีสองบรรทัดในตัวมันเอง ส่วนแถวรายคนมีบรรทัดเดียว
 *
 * คืน `null` เมื่อใส่ไม่ลง — ผู้เรียกไปต่อทางเดิม (text) ซึ่งไม่ตัดใครทิ้งเหมือนกัน
 * · **ห้ามคืน carousel ที่ไม่ครบ** เพราะการ์ดที่ดูสมบูรณ์แต่ขาดคนไปคือยอดหายเงียบ
 */
function paginate(header: FlexComponent[], rows: FlexComponent[]): FlexBubble[] | null {
  const bubbles: FlexBubble[] = []
  let current: FlexComponent[] = [...header]
  let hasRow = false

  const bubbleOf = (contents: FlexComponent[]): FlexBubble => ({
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents },
  })

  for (const row of rows) {
    const candidate = [...current, row]
    const fits =
      Buffer.byteLength(JSON.stringify(bubbleOf(candidate)), 'utf8') <= MAX_BUBBLE_BYTES
    if (fits) {
      current = candidate
      hasRow = true
      continue
    }
    // แถวเดียวยังไม่ลง bubble เปล่าๆ = ไม่มีทางแบ่งให้ลงได้เลย
    if (!hasRow) return null
    bubbles.push(bubbleOf(current))
    if (bubbles.length >= MAX_CAROUSEL_BUBBLES) return null
    /**
     * **หัวการ์ดขึ้นใบใหม่ด้วยเสมอ** — ทุก call site เขียนไว้ตรงกันว่าหัวการ์ดซ้ำ
     * ทุกใบโดยตั้งใจ · ใบที่ไม่มีหัวคือรายชื่อกับตัวเลขลอยๆ ที่ไม่บอกว่าของบิลไหน
     */
    current = [...header, row]
    // หัวการ์ดกินที่ไปด้วย — แถวที่ใส่ใบเดิมไม่ลง อาจใส่ใบใหม่ไม่ลงเหมือนกัน
    if (Buffer.byteLength(JSON.stringify(bubbleOf(current)), 'utf8') > MAX_BUBBLE_BYTES) {
      return null
    }
    hasRow = true
  }
  if (hasRow) bubbles.push(bubbleOf(current))
  if (bubbles.length === 0 || bubbles.length > MAX_CAROUSEL_BUBBLES) return null
  return bubbles
}

/**
 * การ์ดรายละเอียดของบิลใบเดียว — โครงเดียวกับการ์ด Draft **แต่ไม่มีปุ่ม**
 *
 * บิลลง ledger ไปแล้ว ไม่มีอะไรให้กดยืนยันอีก · ปุ่มที่กดแล้วไม่เกิดอะไรคือของที่
 * คนจะกดแล้วสงสัยว่าบอทพัง
 *
 * **โชว์วันที่** ต่างจากการ์ด Draft ที่จงใจไม่โชว์ — ที่นั่นคนเพิ่งพิมพ์ไปเมื่อกี้
 * ส่วนที่นี่คือของเก่าที่ถูกเปิดขึ้นมาดู วันที่คือครึ่งหนึ่งของคำตอบ
 */
export function billDetailCardMessage(detail: {
  /**
   * id ของบิล — ปุ่ม `ยกเลิกบิล` ถือค่านี้กลับมา (D61)
   *
   * **สิทธิ์ไม่ได้อยู่ที่ปุ่ม** การ์ดใบเดียวถูกส่งเข้ากลุ่มให้ทุกคนเห็นเหมือนกันหมด
   * ซ่อนตามคนดูทำไม่ได้อยู่แล้ว · ด่าน D11 อยู่ที่ `voidBill` — เกณฑ์เดียวกับ D56
   */
  expenseId: string
  description: string
  date: string
  payerName: string
  totalSatang: number
  lines: readonly { name: string; amountSatang: number; isPayer: boolean }[]
  /**
   * รายการรายชิ้น — **ว่างแปลว่าบิลนี้ไม่มี ไม่ใช่ว่าข้อมูลหาย** (D51)
   *
   * บิลที่หารเท่าไม่มี Item เลย และบิลที่จดแบบยุบตามชุดคนกินก็จะไม่มีวันมี ·
   * ส่วนนี้จึงหายไปทั้งก้อนเมื่อว่าง ไม่มีบรรทัดไหนบอกว่า "ไม่มีรายการ"
   */
  items?: readonly { name: string; amountSatang: number; eaterNames: readonly string[] }[]
}): LineMessage[] {
  const contents: FlexComponent[] = [
    { type: 'text', text: shorten(detail.description, MAX_DESCRIPTION), size: 'lg', weight: 'bold', wrap: true },
    { type: 'text', text: detail.date, size: 'sm', color: '#555555' },
    /**
     * **บรรทัดคนจ่ายอยู่ตรงนี้เสมอ ไม่ใช่ป้ายท้ายชื่อในแถว**
     *
     * `+ ข้าว 1200 กอล์ฟ ตูน` ระบุชื่อแล้วคนจ่ายไม่ร่วมหาร (D43) เขาจึงไม่มีแถว
     * ในบิลเลย · ป้ายท้ายชื่อจึงหายทั้งใบพอดีในรูปแบบที่คนใช้บ่อยที่สุด แล้วยอด
     * รายคนกลายเป็นตัวเลขที่ไม่มีใครรู้ว่าติดใคร
     */
    {
      type: 'text',
      text: `จ่ายโดย ${shorten(detail.payerName, MAX_NAME)}`,
      size: 'sm',
      color: '#555555',
    },
    {
      type: 'box',
      layout: 'horizontal',
      margin: 'md',
      contents: [
        { type: 'text', text: 'ยอดรวม', size: 'md', weight: 'bold', flex: 3 },
        { type: 'text', text: baht(detail.totalSatang), size: 'md', weight: 'bold', align: 'end', flex: 2 },
      ],
    },
    { type: 'separator', margin: 'md' },
  ]
  /** หัวการ์ดที่ต้องซ้ำทุก bubble ตอนกลายเป็น carousel */
  const header = [...contents]

  /**
   * **ปุ่มอยู่ทุกใบ** — ปุ่มที่อยู่ใบเดียวคือปุ่มที่คนเลื่อนผ่านแล้วหาไม่เจอ (D52) ·
   * `secondary` เพราะนี่ไม่ใช่สิ่งที่คนเปิดการ์ดนี้ตั้งใจมาทำ
   */
  const voidFooter: FlexBox = {
    type: 'box',
    layout: 'vertical',
    contents: [
      {
        type: 'button',
        style: 'secondary',
        height: 'sm',
        action: {
          type: 'postback',
          label: 'ยกเลิกบิล',
          // **id เท่านั้น** สั้นและยาวคงที่ ไม่โตตามขนาดบิล (ADR 0001)
          data: `void=${detail.expenseId}`,
          displayText: 'ยกเลิกบิล',
        },
      },
    ],
  }
  const itemRows: FlexComponent[] = []

  /**
   * รายการมาก่อนรายคน — **สองส่วนตอบคนละคำถาม** (D51)
   *
   * รายการตอบ "ใครกินอะไร" ซึ่งเป็นสิ่งที่คนเปิดบิลเก่าขึ้นมาดูอยากรู้ · รายคน
   * ตอบ "ฉันติดเท่าไหร่" ซึ่งเป็นตัวเลขที่เอาไปจ่ายจริง · ตัดอันไหนทิ้งก็เหลือ
   * การ์ดที่ตอบได้ครึ่งเดียว
   */
  if (detail.items !== undefined && detail.items.length > 0) {
    for (const item of detail.items) {
      itemRows.push(itemRow(shorten(item.name, MAX_NAME), item.eaterNames, item.amountSatang))
    }
    contents.push({
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      margin: 'md',
      contents: itemRows,
    })
    contents.push({ type: 'separator', margin: 'md' })
  }

  contents.push({
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    margin: 'md',
    contents: detail.lines.map((line) => row(shorten(line.name, MAX_NAME), line.amountSatang)),
  })

  const bubble: LineFlexMessage = {
    type: 'flex',
    altText: `${shorten(detail.description, MAX_NAME)} · ${detail.date} · ${baht(detail.totalSatang)}`,
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', contents },
      footer: voidFooter,
    },
  }
  if (Buffer.byteLength(JSON.stringify(bubble), 'utf8') <= MAX_BUBBLE_BYTES) return [bubble]

  /**
   * **เลื่อนข้างก่อน แล้วค่อยลดรูป** (D52)
   *
   * หัวการ์ด (ชื่อ วันที่ คนจ่าย ยอดรวม) ซ้ำอยู่ทุกใบโดยตั้งใจ — คนเลื่อนไปใบที่สาม
   * แล้วเจอตัวเลขลอยๆ ที่ไม่รู้ว่าของบิลไหนคือการ์ดที่อ่านไม่ได้
   */
  const pages = paginate(header, [
    ...itemRows,
    // ทาง bubble เดี่ยวคั่นสองส่วนไว้ — ทางนี้ต้องคั่นด้วย ไม่งั้นแถวรายการกับ
    // แถวรายคนไหลติดกันเป็นกองเดียว (D51 ให้สองส่วนตอบคนละคำถาม)
    ...(itemRows.length > 0 ? [{ type: 'separator', margin: 'md' } as FlexComponent] : []),
    ...detail.lines.map((line) => row(shorten(line.name, MAX_NAME), line.amountSatang)),
  ])
  if (pages !== null) {
    const carousel: LineFlexMessage = {
      type: 'flex',
      altText: bubble.altText,
      contents: {
        type: 'carousel',
        // ปุ่มยกเลิกอยู่ทุกใบด้วยเกณฑ์เดียวกับหัวการ์ด (D52)
        contents: pages.map((page) => ({ ...page, footer: voidFooter })),
      },
    }
    if (Buffer.byteLength(JSON.stringify(carousel), 'utf8') <= MAX_CAROUSEL_BYTES) {
      return [carousel]
    }
  }

  /**
   * บิลที่หารกันทั้งวงใหญ่ทะลุแม้แต่ carousel — ทางลงเดียวกับการ์ด `ยอด` (D44)
   *
   * ไม่มีทางลงแปลว่า LINE ปฏิเสธทั้งก้อน แล้วการกดแถวจะดูเหมือนไม่เกิดอะไรขึ้นเลย
   * ซึ่งอ่านออกได้อย่างเดียวว่าบอทพัง
   */
  const chunks: string[] = []
  let current = `${shorten(detail.description, MAX_NAME)} · ${detail.date} · ${baht(detail.totalSatang)}`

  const push = (line: string): void => {
    if (current.length + line.length + 1 > MAX_TEXT) {
      chunks.push(current)
      current = line
    } else {
      current = current + LF + line
    }
  }

  push(`จ่ายโดย ${shorten(detail.payerName, MAX_NAME)}`)
  push('')
  // รายการมาก่อนรายคนเหมือนบนการ์ด — ลดรูปแล้วต้องอ่านได้เรื่องเดียวกัน
  for (const item of detail.items ?? []) {
    push(
      `  ${shorten(item.name, MAX_NAME)} ${baht(item.amountSatang)}` +
        `  (${shorten(item.eaterNames.join(', '), MAX_EATERS)})`,
    )
  }
  if (detail.items !== undefined && detail.items.length > 0) push('')
  for (const line of detail.lines) {
    push(`  ${shorten(line.name, MAX_NAME)} ${baht(line.amountSatang)}`)
  }
  chunks.push(current)

  const kept =
    chunks.length > MAX_MESSAGES
      ? [
          ...chunks.slice(0, MAX_MESSAGES - 1),
          `ยังมีต่ออีก ${chunks.length - (MAX_MESSAGES - 1)} ส่วนที่ยาวเกินกว่าจะส่งในครั้งเดียว`,
        ]
      : chunks

  /**
   * **postback ติดกับข้อความได้ทาง quick reply** — ทางลงที่กดยกเลิกไม่ได้แปลว่า
   * บิลใหญ่พอจะอ่านไม่ไหวก็ยกเลิกไม่ได้ไปด้วย ทั้งที่นั่นคือใบที่อยากยกเลิกที่สุด ·
   * เกาะก้อนสุดท้ายเพราะ LINE แสดง quick reply ของก้อนสุดท้าย
   */
  return kept.map((text, index) => {
    const message: LineTextMessage = { type: 'text', text }
    if (index < kept.length - 1) return message
    return {
      ...message,
      quickReply: {
        items: [
          {
            type: 'action' as const,
            action: {
              type: 'postback' as const,
              label: 'ยกเลิกบิล',
              data: `void=${detail.expenseId}`,
              displayText: 'ยกเลิกบิล',
            },
          },
        ],
      },
    }
  })
}
