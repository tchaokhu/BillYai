import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Integration test — ต้องมี Postgres จริง
//
//   docker compose up -d
//   npm run db:reset
//   npm run test:db
//
// ไม่ล้างตารางระหว่างรัน ทุกเทสต์สร้างวงของตัวเองผ่าน lib/db/fixtures.ts
// แล้ว assert เฉพาะในวงนั้น จึงรันขนานกันได้
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.db.test.ts'],
    // เทสต์ที่สุ่มบิลหลักร้อยใบใช้เวลาหลายวินาทีตอน DB โดนหลายไฟล์พร้อมกัน ซึ่ง
    // เป็นเรื่องของทรัพยากร ไม่ใช่ของโค้ด · ปล่อยไว้ที่ 5 วินาทีแล้วชุดเทสต์จะแดง
    // สลับไปมาตามจำนวนไฟล์ที่รันขนาน ซึ่งทำให้ "แดง" หมดความหมาย
    testTimeout: 30_000,
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://billyai:billyai@localhost:54331/billyai',
    },
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
})
