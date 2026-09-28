import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    // API 는 Hono 서버(8787)가 담당한다. 클라이언트는 상대 경로 /api 만 안다.
    proxy: { '/api': 'http://localhost:8787' },
  },
})
