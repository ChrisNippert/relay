import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    https: {
      key: fs.readFileSync('../certs/key.pem'),
      cert: fs.readFileSync('../certs/cert.pem'),
    },
    proxy: {
      '/api': {
        target: 'https://localhost:8080',
        secure: false,
        ws: true,
      },
      '/uploads': {
        target: 'https://localhost:8080',
        secure: false,
      },
    },
  },
})
