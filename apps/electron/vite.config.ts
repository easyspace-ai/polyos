import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const rendererRoot = resolve(__dirname, 'src/renderer')

export default defineConfig({
  plugins: [react()],
  root: rendererRoot,
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyDirBeforeWrite: true,
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: resolve(rendererRoot, 'index.html'),
    },
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
