import { defineConfig } from 'vite'

export default defineConfig({
  resolve: {
    alias: {
      '@': './src'
    }
  },
  server: {
    proxy: {
      '/dev-prefix': {
        target: 'http://localhost:8080',
        rewrite: (p: string) => p.replace(/^\/dev-prefix/, '')
      }
    }
  }
})
