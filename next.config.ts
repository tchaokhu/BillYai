import type { NextConfig } from 'next'

const config: NextConfig = {
  /**
   * `pg` โหลด native/optional module ตอน runtime — ให้ bundler ปล่อยผ่านไปใช้
   * ของใน `node_modules` ตรงๆ ไม่งั้นจะพังตอน build บน Vercel
   */
  serverExternalPackages: ['pg'],

  typescript: {
    // ค่า default อยู่แล้ว เขียนไว้ให้ชัดว่าห้ามใครมาปิดเพื่อให้ build ผ่าน
    ignoreBuildErrors: false,
  },
}

export default config
