import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// 仓根:alias 一律指**源码目录**(apps/web 同款做法,见 apps/web/vite.config.ts)。
const repoRoot = resolve(__dirname, '../..')

export default defineConfig({
  plugins: [react()],
  resolve: {
    // `@onething/*` 一条 alias 都没有:core / runtime / backend 都是真 workspace 包,
    // 走 node 解析 + 各自 package.json 的 exports(从仓根 node_modules 命中软链)。
    alias: [
      { find: '@shared', replacement: resolve(repoRoot, 'packages/shared') },
      { find: '@renderer', replacement: resolve(repoRoot, 'packages/renderer') },
      // `@/` 是 packages/renderer 内部的自指别名(platform/ 里的 `@/types`、
      // `@/services/log` 都走它);新壳自己的代码一律相对路径,不用 `@/`。
      { find: /^@\//, replacement: `${resolve(repoRoot, 'packages/renderer')}/` },
    ],
  },
  server: {
    host: '127.0.0.1',
    // 5173 是旧 Electron renderer、5174 是 apps/web;新壳占 5175,三条泳道互不打架。
    port: 5175,
    strictPort: true,
  },
  build: {
    // Electron 生产窗口用 loadFile 读本地文件,必须是相对路径。
    assetsDir: 'assets',
  },
  base: './',
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
