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
    // 全局缺省就是 node。**`packages/client` 必须是 node,而且不许靠这一行**
    // (C0,`docs/design/client-sdk-2026-09.md` §7):那个包的卖点是"浏览器与
    // Node 同一份代码",证词就是它的测试跑在没有 `window` 的环境里。vitest 4
    // 删掉了 `environmentMatchGlobs`,所以钉子打在文件上 —— 每个
    // `packages/client/__tests__/*.test.ts` 开头都有 `// @vitest-environment node`,
    // 缺一个由 `bun run boundary` 判红(`checkClientPackageBoundary`)。
    // 有人哪天把这里改成 jsdom,那个包依旧是 node。
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
