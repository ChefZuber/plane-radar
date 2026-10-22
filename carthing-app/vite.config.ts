import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The Car Thing runs an older Chromium, so compile down to syntax it understands.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { target: ['chrome69'] },
})
