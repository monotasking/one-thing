import { defineConfig } from 'vitest/config'
import path from 'path'

/**
 * 根级 vitest 在 Node 环境运行后端、脚本和不依赖浏览器的宿主测试。
 * React 页面由 apps/desktop-react 的 jsdom 配置运行；CI 分别执行两套入口。
 * Vue 宿主 / renderer 于 2026-09-04 退役(运行时统一第四步),vue 插件与 @main / @preload / @
 * 别名随之删除;`@shared` 不是包,是 packages/shared 这棵树,所以仍要一条别名。
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [path.resolve(__dirname, 'vitest.setup.ts')],
    // `scripts/**/*.test.mjs`(检索重建 S0 加):脚本自己的纯函数也该有用例。仓里
    // 从前没有「脚本测试」这一形,所以这里是第一条 —— 只收 `.mjs`,因为 scripts/
    // 下的可执行文件本来就是 `.mjs`(`headless-boundary-check.ts` 那几个 `.ts` 由
    // bun 直接跑,不进 vitest)。
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'scripts/**/*.test.mjs'],
    exclude: ['apps/desktop-react/src/**', '**/node_modules/**'],
    alias: {
      '@shared': path.resolve(__dirname, 'packages/shared'),
    },
  },
})
