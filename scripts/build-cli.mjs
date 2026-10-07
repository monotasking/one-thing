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
 *
 * 第④步批 3 起 CLI 是后端的 HTTP 客户端,`main.cjs` 里不再有整棵装配;还带着的后端代码只剩离线那几条命令
 * (`store` 备份 / 校验 / 锁、`trace`、`plugin`)直接读盘用的那部分,以及 `onething mcp` 用的资源纯函数。
 */
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { shellEsbuildOptions } from '../apps/desktop-react/scripts/build-electron.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outdir = path.join(repoRoot, 'dist/cli')

await build(shellEsbuildOptions({
  entryPoints: { main: path.join(repoRoot, 'apps/cli/src/index.ts') },
  outdir,
}))

/*
 * 第④步批 3:CLI 不再装配后端,所以从前跟着 `main.cjs` 出的两份副产物(检索 Worker `search-worker.cjs`、ACP 宿主
 * 工具桥 `acp-mcp-bridge.cjs`)不再出 —— 它们是「装配了后端的那个宿主入口」旁边的件,CLI 不再是那样的宿主。
 * 上一次构建留下的旧文件一并删掉,免得有人以为它们还在被用。
 */
for (const stale of ['search-worker.cjs', 'search-worker.cjs.map', 'acp-mcp-bridge.cjs', 'acp-mcp-bridge.cjs.map']) {
  rmSync(path.join(outdir, stale), { force: true })
}

/*
 * CLI 自己拉起后端、而本机没有装 onething.app 时,拉起的是 `dist/server/main.js`(决策 D12 的 (b) 档),
 * 所以「CLI 包」= `dist/cli` + `dist/server`:这里顺手把后者也构建一次(同一份配方,`server:build`)。
 */
const server = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/build-server.mjs')], { cwd: repoRoot, stdio: 'inherit' })
if (server.status !== 0) process.exit(server.status ?? 1)
