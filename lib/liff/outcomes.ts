/**
 * เหตุผลจาก domain → HTTP + ข้อความที่ผู้ใช้อ่าน
 *
 * อยู่ที่เดียวเพราะทั้ง `/api/liff/session` และ `/api/liff/draft` ต้องตอบเหมือนกัน
 * เป๊ะ — คนที่เปิดหน้าจอค้างไว้แล้วกดเซฟจะเจอเหตุเดียวกันทุกข้อ และคำตอบที่ต่างกัน
 * สองเส้นแปลว่าเขาได้คำแนะนำคนละอย่างสำหรับปัญหาเดียวกัน
 */

import type { LiffFailure } from './authorize'

export interface LiffOutcome {
  status: number
  /** ข้อความที่หน้าจอเอาไปแสดงตรงๆ — บอกทางออก ไม่ใช่บอกว่าอะไรพัง */
  message: string
}

export const LIFF_OUTCOMES: Record<LiffFailure, LiffOutcome> = {
  misconfigured: { status: 500, message: 'ระบบยังตั้งค่าไม่ครบ ลองใหม่อีกครั้งภายหลัง' },
  'bad-request': { status: 400, message: 'ข้อมูลไม่สมบูรณ์ — กลับไปกดปุ่มบนการ์ดในแชทอีกครั้ง' },
  unauthenticated: { status: 401, message: 'เซสชันหมดอายุ — ปิดหน้านี้แล้วกดจากการ์ดใหม่' },
  'draft-gone': { status: 404, message: 'บิลใบนี้ใช้ไม่ได้แล้ว — พิมพ์ใหม่ในแชทได้เลย' },
  /**
   * **403 ไม่ใช่ 404** — การ์ด Draft ลอยอยู่ในกลุ่มให้ทุกคนเห็น คนที่ไม่ได้พิมพ์
   * กดเข้ามาจึงเป็นกรณีปกติ ไม่ใช่การสอดแนม · ตอบ 404 เหมือนกันหมดจะได้ความลับที่
   * ไม่มีอยู่จริง (เขาเพิ่งเห็นการ์ดใบนั้นมากับตา) แลกกับข้อความที่บอกไม่ได้ว่าให้
   * ทำยังไงต่อ
   */
  'not-owner': { status: 403, message: 'บิลใบนี้เป็นของคนที่พิมพ์ ให้เขาเป็นคนแก้' },
  /**
   * **503 ไม่ใช่ 500** — ของเราไม่ได้พัง ปลายทางที่เราพึ่งอยู่ตอบไม่ได้ชั่วคราว
   * และข้อความต้องบอกให้ลองใหม่ ไม่ใช่ให้ไปกดการ์ดใหม่ซึ่งไม่ช่วยอะไร
   */
  upstream: { status: 503, message: 'ตอนนี้เชื่อมต่อไม่ได้ รอสักครู่แล้วลองใหม่' },
}

/**
 * log เฉพาะเหตุผลซึ่งเป็นค่าคงที่ล้วน — **ไม่ log `draftId` `sub` หรือ body**
 * repo เป็น public และ log ไม่ควรสะสมของที่ยิงซ้ำได้ (กติกาเดียวกับ webhook)
 */
export function logLiffFailure(route: string, reason: LiffFailure): void {
  if (reason === 'upstream') {
    console.error(`[liff/${route}] ต่อ LINE หรือ Postgres ไม่ได้ — ไม่ใช่ความผิดของคนที่กด`)
    return
  }
  if (reason === 'misconfigured') {
    console.error(
      `[liff/${route}] LINE_LOGIN_CHANNEL_ID ไม่ได้ตั้ง หรือไม่ใช่ตัวเลขล้วน — ดู SETUP-DEPLOY.md §4`,
    )
    return
  }
  console.warn(`[liff/${route}] ปฏิเสธ reason=${reason}`)
}

export function liffJson(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // คำตอบผูกกับตัวคนขอ ห้ามมี proxy ไหนเก็บไว้แจกต่อ
      'cache-control': 'no-store',
    },
  })
}
