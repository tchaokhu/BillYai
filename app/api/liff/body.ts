/**
 * อ่าน JSON body ของ route ใต้ `/api/liff` — **ไม่ใช่ route เอง** (ไม่มี `route.ts`
 * ในโฟลเดอร์นี้ ไฟล์นี้จึงไม่กลายเป็น endpoint)
 *
 * body ที่ไม่ใช่ JSON = คำขอที่เราไม่ได้ออกแบบไว้ ไม่ใช่เหตุขัดข้องของเรา ·
 * `{}` เดินต่อไปตกด่านใน `authorizeDraft` เอง จึงไม่ต้องมีสองทางแยกในทุก route
 */
export async function readLiffBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json()
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // ตั้งใจกลืน — ผลลัพธ์คือ bad-request ซึ่งถูกแล้ว
  }
  return {}
}
