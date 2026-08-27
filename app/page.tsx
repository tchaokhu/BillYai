/**
 * หน้าแรก — ตอนนี้มีไว้ยืนยันว่า deploy ขึ้นแล้วเท่านั้น
 *
 * โดเมนนี้เป็น public และ repo ก็ public — ห้ามใส่อะไรที่บอกโครงสร้างภายใน
 * ชื่อ endpoint หรือสถานะของระบบลงหน้านี้
 */
export default function Home() {
  return (
    <main>
      <h1>BillYai</h1>
      <p>หารบิลในแชทกลุ่ม — กำลังพัฒนา</p>
    </main>
  )
}
