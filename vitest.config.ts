import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// ยูนิตเท่านั้น — ชุดนี้ต้องรันได้บนเครื่องที่ไม่ได้เปิด Docker
// integration test ตั้งชื่อ `*.db.test.ts` และอยู่ใน vitest.db.config.ts
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'lib/**/*.db.test.ts'],
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
})
