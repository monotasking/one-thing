#!/usr/bin/env node
/**
 * `npm run app:dev` —— 起 vite dev server(5175),再把 Electron 壳指过去。
 *
 * 两件事各一个进程,谁先死另一个跟着走。渲染层的 HMR 归 vite,main 侧改了就重跑。
 *
 * ── 起手顺序是有账的,别随手换回去(2026-09-15)────────────────────────
 * **vite 先起,esbuild 与它并排跑**。这条泳道每次都是一份**新**的 dev server,
 * 转换缓存冷着;而首屏那张静态 import 图有 873 个模块,冷转 2.4–2.7s(满载 10s)。
 * `vite.config.ts` 里的 `server.warmup.clientFiles = ['./src/main.tsx']` 让 vite
 * 在 `listen()` 之后**立刻**开始转那张图(判词写在那一格上),所以这里要做的只有
 * 一件事:尽早 `listen()`,把 warmup 的头拉长。
 *
 * 头有两段,都是 vite 本来就在闲着的时间:①下面这次 `build-electron`(~0.42s,
 * 纯 esbuild 子进程,与 vite 无关,所以不 `await` 就先开工);②Electron 从
 * spawn 到 `loadURL` 的 ~0.8s 再加后端装配的 ~1.7s。两段加起来 ≈2.9s,而实测
 * warmup 转完整张图用 3.0s —— 页面到的时候基本已经全在缓存里了。
 *
 * 实测(隔离 vite,同一棵树、同一份 deps 缓存,取两次的小值):页面**立刻**来
 * DCL 2732→2292ms;页面晚 3s 来(=这条泳道的真实情形)DCL **412ms**。
 * Electron 仍在两者都完成之后才 spawn —— 并行的只是「打包」与「预热」,不是
 * 「打包」与「起壳」。停机顺序一个字没动:先停 Electron,再 `server.close()`。
 * ──────────────────────────────────────────────────────────────────────
 *
 * ── A1 之后多了一条要记住的 ────────────────────────────────────────────
 * main 侧现在**把整棵 core/runtime/backend inline 进 bundle**(壳自己装配 backend)。
 * 于是 `packages/{core,onething-runtime,backend}` 里的任何改动,在这条泳道上都要
 * **重跑一次 `npm run app:dev`**(或单跑 `npm run electron:build`)才会生效 ——
 * 那些包不在 vite 的依赖图里,HMR 管不到它们。改了 core 却看不到变化,先想这一条。
 * ──────────────────────────────────────────────────────────────────────
 */
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
/**
 * **Electron 本体不在这个应用里重装一份**(D0 裁量,2026-08-29)。
 *
 * 仓根已经装着这个壳要用的那一份 —— 官方 npm 包 `electron@41.1.1`(2026-09-03 从
 * castlabs 的 `41.1.1+wvcus` 定制 build 换回来,内嵌 Node 24.14 / ABI 145 不变;
 * 代价是 Widevine 不再就绪,内嵌浏览器的 DRM 播放没了,登录配方本身不依赖它)。
 * 在这里再声明一个 `electron` devDep 会得到:第二份 ~250MB 二进制、和旧壳漂开的
 * 版本、以及一次必然要联网的 postinstall。`import 'electron'` 从这里出发按 node
 * 解析往上走,命中的就是仓根那一份 —— 两个壳同一个运行时,正是并行过渡期要的。
 * 打包链(electron-builder / 签名)归 P4/退役期,谁持有 Electron 那时一起拍。
 */
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createChildShutdown, observeChildClose, shutdownFailed } from '../../../scripts/lib/dev-process-shutdown.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// main/preload 每次都重打:它们不参与 vite 的依赖图。
// **不 await**:让这只 esbuild 子进程与下面 vite 的 createServer/listen(以及 listen
// 之后立刻开跑的 warmup)并排走。真正要等它的地方是 spawn Electron 之前那一行。
const electronBuild = (async () => {
  const build = spawn(process.execPath, [path.join(appRoot, 'scripts/build-electron.mjs')], {
    cwd: appRoot,
    stdio: 'inherit',
  })
  const result = await observeChildClose(build).promise
  if (result.error) throw result.error
  if (result.code !== 0) throw new Error(`electron:build 退出码 ${result.code}, signal ${result.signal}`)
})()
// 先挂一只空 catch:它若在下面 await vite 期间就失败,不许变成 unhandledRejection ——
// 真正的抛出点是后面那句 `await electronBuild`。
electronBuild.catch(() => {})

const server = await createServer({ configFile: path.join(appRoot, 'vite.config.ts') })
await server.listen()
const url = server.resolvedUrls?.local?.[0]
if (!url) throw new Error('vite dev server 没给出本地地址')
server.printUrls()

// 打包这一半没成,壳就没得起:把刚起的 server 收掉再把错抛出去(此刻还没有 Electron
// 进程,所以这里不需要走下面那条完整的 shutdown)。
try { await electronBuild }
catch (error) { await server.close().catch(() => {}); throw error }

const electron = spawn(electronPath, [path.join(appRoot, 'dist-electron/main.cjs')], {
  cwd: appRoot,
  stdio: 'inherit',
  env: { ...process.env, ONETHING_REACT_DEV_SERVER_URL: url },
})

const electronShutdown = createChildShutdown({
  child: electron,
  onTimeout: () => console.error('[electron:dev] Electron did not close within 10 s; forcing its owned process to stop. Shutdown failed; the store lock may be retained.'),
})
let shuttingDown

function shutdown(signal = 'SIGTERM') {
  if (shuttingDown) return shuttingDown
  shuttingDown = Promise.resolve().then(async () => {
    const result = await electronShutdown.stop(signal)
    let exitCode = shutdownFailed(result) || process.exitCode ? 1 : 0
    try { await server.close() }
    catch (error) {
      console.error('[electron:dev] Vite shutdown failed:', error)
      exitCode = 1
    }
    for (const error of result.signalErrors) console.error('[electron:dev] Could not signal Electron:', error)
    if (result.error) console.error('[electron:dev] Electron process failed:', result.error)
    process.exit(exitCode)
  })
  return shuttingDown
}

void electronShutdown.closed.then(result => {
  // An unexpected signal is a failed child, not a successful application exit.
  if (!shuttingDown && result.signal) process.exitCode = 1
  return shutdown()
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { void shutdown(signal) })
}
