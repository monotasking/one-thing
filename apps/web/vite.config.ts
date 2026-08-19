import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { onethingPackageAliases } from '../../onething.aliases'
import { onethingDevApiProxy } from './dev-api-proxy'

const projectRoot = resolve(__dirname, '../..')
// 两个 vite dev server(日常泳道 + scripts/dev-self.mjs 的 B 实例)共用一份
// 依赖预构建缓存会互相作废,dev-self 用 env 换成自己的一份。
const cacheDir = process.env.ONETHING_WEB_CACHE_DIR || 'node_modules/.vite/web'

export default defineConfig({
  root: projectRoot,
  cacheDir: resolve(projectRoot, cacheDir),
  // /api 走发现文件动态定位 core 服务(A 期):端口是动态的,还要补 Bearer token,
  // 两件事 vite 内置 proxy 都做不了 —— 见 apps/web/dev-api-proxy.ts。
  plugins: [vue(), onethingDevApiProxy()],
  resolve: {
    alias: [
      { find: '@', replacement: resolve(projectRoot, 'packages/renderer') },
      { find: '@renderer', replacement: resolve(projectRoot, 'packages/renderer') },
      { find: '@shared', replacement: resolve(projectRoot, 'packages/shared') },
      ...onethingPackageAliases(projectRoot),
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
  },
  build: {
    outDir: resolve(projectRoot, 'dist/web'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(projectRoot, 'index.html'),
    },
  },
})
