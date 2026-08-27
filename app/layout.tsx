import type { ReactNode } from 'react'

export const metadata = {
  title: 'BillYai',
  description: 'หารบิลในแชทกลุ่ม',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="th">
      <body
        style={{
          margin: 0,
          padding: '1.5rem',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          lineHeight: 1.6,
        }}
      >
        {children}
      </body>
    </html>
  )
}
