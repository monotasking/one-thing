#!/usr/bin/env node
/**
 * `npm run build:cli` —— 把 CLI 入口打成 `dist/cli/main.cjs`。
 *
 * ── 为什么它从 electron-vite 里搬出来(运行时统一第三步,2026-09-03)────────────
 * 从前 CLI 是 Vue 宿主 `electron.vite.config.ts` 的第二个入口,顺带打进 `out/main/cli.js`。
 * Vue 宿主退役(第四步)之后 electron-vite 整个不在了,CLI 不能再靠它活。这里用的是
 * React 壳主进程同一套 esbuild 配方(`apps/desktop-react/scripts/build-electron.mjs`
 * 导出的 `shellEsbuildOptions`:node 平台、原生模块 external、`import.meta.url` 垫片、
 * `.md?raw` 装载器、`@shared` 别名)—— 一份配方两份产物,CLI 与桌面主进程在同一个
 * 打包纪律下。
 *
 * CLI 源码住在 `apps/cli/src/`(第四步 4a,2026-09-03 从 `apps/electron/src/main/cli/`
 * 整目录 `git mv` 过来 —— 它一个字节都不吃 Vue 宿主,只吃 `@onething/backend` 与
 * `@shared`,所以 Vue 宿主退役时它不必跟着死)。`bin/onething.mjs` 指向这里的产物。
 *
 * CLI 跑在**系统 Node** 上(不是 Electron),所以 `electron` 被 external 掉也永远不会被
 * require 到 —— cli 目录里没有一处 import electron(2026-09-03 rg 核过)。
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  searchWorkerEsbuildOptions,
  shellEsbuildOptions,
} from '../apps/desktop-react/scripts/build-electron.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outdir = path.join(repoRoot, 'dist/cli')

await build(shellEsbuildOptions({
  entryPoints: { main: path.join(repoRoot, 'apps/cli/src/index.ts') },
  outdir,
}))

// 第二个入口:检索索引 Worker(检索重建 S3b,§3 末行)。产物 `dist/cli/search-worker.cjs`
// 与 `main.cjs` 同目录 —— 装配层按宿主 bundle 的位置往旁边找,三个宿主同一条纪律。
await build(searchWorkerEsbuildOptions({ outdir, repoRoot }))
