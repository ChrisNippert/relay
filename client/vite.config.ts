import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        secure: false,
        ws: true,
      },
      '/uploads': {
        target: 'http://localhost:8080',
        secure: false,
      },
    },
  },
})
