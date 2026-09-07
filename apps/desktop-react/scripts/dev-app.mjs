#!/usr/bin/env node
/**
 * `npm run app:dev` —— 起 vite dev server(5175),再把 Electron 壳指过去。
 *
 * 两件事各一个进程,谁先死另一个跟着走。渲染层的 HMR 归 vite,main 侧改了就重跑。
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
await (async () => {
  const build = spawn(process.execPath, [path.join(appRoot, 'scripts/build-electron.mjs')], {
    cwd: appRoot,
    stdio: 'inherit',
  })
  const result = await observeChildClose(build).promise
  if (result.error) throw result.error
  if (result.code !== 0) throw new Error(`electron:build 退出码 ${result.code}, signal ${result.signal}`)
})()

const server = await createServer({ configFile: path.join(appRoot, 'vite.config.ts') })
await server.listen()
const url = server.resolvedUrls?.local?.[0]
if (!url) throw new Error('vite dev server 没给出本地地址')
server.printUrls()

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
