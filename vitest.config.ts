import { defineConfig } from 'vitest/config'
import path from 'path'

/**
 * 根级 vitest:node 环境跑 packages/** 与 apps/**(React 壳与 mobile 各有自己的 jsdom 跑法,
 * 根 cwd 下它们的套件因无 window 而红,权威口径是各壳自己那一跑)。
 * Vue 宿主 / renderer 于 2026-09-04 退役(运行时统一第四步),vue 插件与 @main / @preload / @
 * 别名随之删除;`@shared` 不是包,是 packages/shared 这棵树,所以仍要一条别名。
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [path.resolve(__dirname, 'vitest.setup.ts')],
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    alias: {
      '@shared': path.resolve(__dirname, 'packages/shared'),
    },
  },
})
