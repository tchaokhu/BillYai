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
import type { DraftCard } from '../flow/draft'

type FlexText = {
  type: 'text'
  text: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  weight?: 'bold'
  color?: string
  align?: 'end'
  flex?: number
  wrap?: boolean
}

type FlexBox = {
  type: 'box'
  layout: 'vertical' | 'horizontal' | 'baseline'
  contents: FlexComponent[]
  spacing?: 'sm' | 'md'
  margin?: 'sm' | 'md' | 'lg'
}

type FlexSeparator = { type: 'separator'; margin?: 'sm' | 'md' | 'lg' }

type FlexButton = {
  type: 'button'
  style: 'primary'
  height: 'sm'
  action: { type: 'postback'; label: string; data: string; displayText?: string }
}

type FlexComponent = FlexText | FlexBox | FlexSeparator | FlexButton

type QuickReplyItem = {
  type: 'action'
  action: { type: 'postback'; label: string; data: string; displayText: string }
}

export interface LineFlexMessage {
  type: 'flex'
  /** ข้อความที่ขึ้นใน notification และในไคลเอนต์ที่แสดง Flex ไม่ได้ */
  altText: string
  contents: {
    type: 'bubble'
    body: FlexBox
    footer: FlexBox
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
