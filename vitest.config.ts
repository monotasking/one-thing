import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import { electronHostAliases } from './onething.aliases'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    // @onething/{core,gateway,runtime,backend} 由 workspace symlink + 各自
    // package.json 的 exports 解析,这里不登记。electron-host 是 apps/electron 的
    // 内部路径族(不是包),单独 spread —— 测试里 apps/electron 和后端包的 mock
    // 都要解析它。
    alias: [...electronHostAliases(__dirname)],
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [path.resolve(__dirname, 'vitest.setup.ts')],
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    alias: {
      // Product assembly tree (prefix entry — covers every subpath).
      '@main': path.resolve(__dirname, 'apps/electron/src/main'),
      '@shared': path.resolve(__dirname, 'packages/shared'),
      '@preload': path.resolve(__dirname, 'apps/electron/src/preload'),
      '@': path.resolve(__dirname, 'packages/renderer'),
    },
  },
})
