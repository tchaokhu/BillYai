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
import type { LineMessage } from './messages'
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
  /** ทั้งกล่องกดได้ — ใช้กับแถวในรายการ `บิล` ซึ่งเป็นทางเดียวไปหารายละเอียด */
  action?: FlexPostbackAction
}

type FlexSeparator = { type: 'separator'; margin?: 'sm' | 'md' | 'lg' }

type FlexButton = {
  type: 'button'
  style: 'primary'
  height: 'sm'
  action: FlexPostbackAction
}

type FlexComponent = FlexText | FlexBox | FlexSeparator | FlexButton

type QuickReplyItem = {
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
function balanceBubble(blocks: readonly BalanceBlock[]): LineFlexMessage {
  const total = blocks.reduce((sum, block) => sum + block.totalSatang, 0)

  const contents: FlexComponent[] = [
    {
      type: 'box',
      layout: 'horizontal',
      contents: [
        { type: 'text', text: 'ยอดค้าง', size: 'lg', weight: 'bold', flex: 3 },
        { type: 'text', text: baht(total), size: 'lg', weight: 'bold', align: 'end', flex: 2 },
      ],
    },
  ]

  for (const block of blocks) {
    contents.push({ type: 'separator', margin: 'md' })
    contents.push({
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
              text: `${shorten(block.creditorName, MAX_NAME)} ได้คืน`,
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
        ...block.rows.map((row) =>
          row2(shorten(row.debtorName, MAX_NAME), row.amountSatang),
        ),
      ],
    })
  }

  return {
    type: 'flex',
    altText: `ยอดค้างทั้งวง ${baht(total)} · ${blocks.length} คนรอรับคืน`,
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
export function balanceCardMessage(blocks: readonly BalanceBlock[]): LineMessage[] {
  const bubble = balanceBubble(blocks)
  if (Buffer.byteLength(JSON.stringify(bubble), 'utf8') <= MAX_BUBBLE_BYTES) return [bubble]

  const total = blocks.reduce((sum, block) => sum + block.totalSatang, 0)
  const chunks: string[] = []
  let current = `ยอดค้างทั้งวง ${baht(total)}`

  const push = (line: string): void => {
    // +1 สำหรับตัวขึ้นบรรทัดที่จะต่อเข้าไป
    if (current.length + line.length + 1 > MAX_TEXT) {
      chunks.push(current)
      current = line
    } else {
      current = current + LF + line
    }
  }

  for (const block of blocks) {
    push('')
    push(`${shorten(block.creditorName, MAX_NAME)} ได้คืน ${baht(block.totalSatang)}`)
    for (const row of block.rows) {
      push(`  ${shorten(row.debtorName, MAX_NAME)} ${baht(row.amountSatang)}`)
    }
  }
  chunks.push(current)

  // เกินห้าก้อนแปลว่าวงใหญ่กว่าที่ระบบนี้ออกแบบมารับไหว — **บอกตรงๆ ว่าตัด**
  // ไม่ใช่เงียบๆ ตัดทิ้ง ซึ่งใน ledger คือยอดหาย
  if (chunks.length > MAX_MESSAGES) {
    const kept = chunks.slice(0, MAX_MESSAGES - 1)
    kept.push(`ยังมีต่ออีก ${chunks.length - kept.length} ส่วนที่ยาวเกินกว่าจะส่งในครั้งเดียว`)
    return kept.map((text) => ({ type: 'text', text }))
  }
  return chunks.map((text) => ({ type: 'text', text }))
}

export interface LineFlexMessage {
  type: 'flex'
  /** ข้อความที่ขึ้นใน notification และในไคลเอนต์ที่แสดง Flex ไม่ได้ */
  altText: string
  contents: {
    type: 'bubble'
    body: FlexBox
    /**
     * ไม่ใส่เลยเมื่อไม่มีปุ่ม — **box ที่ `contents` ว่างถูก LINE ปฏิเสธทั้งข้อความ**
     * ซึ่งจะทำให้คนพิมพ์ `ยอด` ไม่เห็นอะไรเลย
     */
    footer?: FlexBox
  }
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
export function draftCardMessage(
  card: DraftCard,
  draftId: string,
  unclaimed: readonly IdentityChoice[] | null = null,
): LineFlexMessage {
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
          ],
        }
      : {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: 'เลือกชื่อของคุณด้านล่างเพื่อยืนยัน',
              size: 'sm',
              color: '#8c8c8c',
              wrap: true,
            },
          ],
        }

  return {
    type: 'flex',
    // ยอดกับจำนวนคนอยู่ในบรรทัดเดียว เพราะนี่คือทั้งหมดที่คนเห็นตอนเด้งเตือน
    altText: `ตรวจบิล ${description} ${baht(card.totalSatang)} · ${card.lines.length} คน`,
    ...(unclaimed === null
      ? {}
      : { quickReply: { items: identityQuickReply(draftId, unclaimed) } }),
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          ...header,
          { type: 'separator', margin: 'md' },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            margin: 'md',
            contents: card.lines.map((line) =>
              row(line.isNew ? `${line.name} (ใหม่)` : line.name, line.amountSatang),
            ),
          },
        ],
      },
      footer,
    },
  }
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
        displayText: bill.description,
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
  chunks.push(current)

  if (chunks.length > MAX_MESSAGES) {
    const kept = chunks.slice(0, MAX_MESSAGES - 1)
    kept.push(`ยังมีต่ออีก ${chunks.length - kept.length} ส่วนที่ยาวเกินกว่าจะส่งในครั้งเดียว`)
    return kept.map((text) => ({ type: 'text', text }))
  }
  return chunks.map((text) => ({ type: 'text', text }))
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
  description: string
  date: string
  totalSatang: number
  lines: readonly { name: string; amountSatang: number; isPayer: boolean }[]
}): LineMessage[] {
  const contents: FlexComponent[] = [
    { type: 'text', text: shorten(detail.description, MAX_DESCRIPTION), size: 'lg', weight: 'bold', wrap: true },
    { type: 'text', text: detail.date, size: 'sm', color: '#555555' },
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
    {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      margin: 'md',
      // ป้ายคนจ่ายอยู่ในชื่อ ไม่ใช่คอลัมน์แยก — ยอดรายคนอ่านไม่รู้เรื่องถ้าไม่รู้
      // ว่าใครออกเงินไปก่อน และคอลัมน์ที่ว่างเกือบทุกแถวคือน้ำหนักที่ไม่ได้ใช้
      contents: detail.lines.map((line) =>
        row(`${shorten(line.name, MAX_NAME)}${line.isPayer ? ' (จ่าย)' : ''}`, line.amountSatang),
      ),
    },
  ]

  return [
    {
      type: 'flex',
      altText: `${shorten(detail.description, MAX_NAME)} · ${detail.date} · ${baht(detail.totalSatang)}`,
      contents: {
        type: 'bubble',
        body: { type: 'box', layout: 'vertical', contents },
      },
    },
  ]
}
