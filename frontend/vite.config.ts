import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// During development the API runs separately (uvicorn on :8000). It also proxies PocketBase at /pb
// when accounts are configured (LAYERLIFT_POCKETBASE_URL).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://127.0.0.1:8000', '/pb': 'http://127.0.0.1:8000' },
  },
})
