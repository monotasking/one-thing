#!/usr/bin/env node
/**
 * `npm run smoke:core` —— 构建链冒烟(A1-a,2026-08-31)。
 *
 * 它用**同一份** esbuild 配方(`shellEsbuildOptions`,从 build-electron.mjs 导出)
 * 打一枚探针,然后在两条泳道各跑一次:
 *
 *   node      —— 纯 node 跑 CJS 产物。最便宜的一条,配方里任何一处漏配都在这里炸。
 *   electron  —— 用仓根那只 Electron 二进制当**主进程**跑同一份产物。这是 A1 的
 *                首验项:A0 只在 node 下验过,而 Electron 主进程的网络栈
 *                (undici vs Chromium net)与原生模块加载路径都与 node 不同。
 *
 * 每条泳道用一个一次性 store,四条读数逐条断言(见探针文件头)。
 * 与 gate:connect 的分工:这里不开窗、不碰渲染层 —— 坏了要一眼看出是构建链坏了,
 * 而不是在一条要拉起 Electron 窗口的门里去猜。
 */
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electronBinary from 'electron'
import { shellEsbuildOptions } from './build-electron.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(appRoot, 'dist-electron/smoke')
const probeEntry = path.join(appRoot, 'scripts/smoke/core-boot-probe.ts')
const probeBundle = path.join(outDir, 'core-boot-probe.cjs')

/** ready 门线。A0 在 node 下量到 13-41ms,给两个数量级的余量。 */
const READY_BUDGET_MS = 1000

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败:${message}`)
  process.stdout.write(`  ✓ ${message}\n`)
}

/**
 * 探针的读数是 `KEY value` 的行(`DONE` 是唯一没有值的那条)。只认第一次出现 ——
 * 后面的都是噪音。判「有没有这条」一律用 `in`,不用真值:`COLLAB false` 也是一条读数。
 */
function readingsOf(stdout) {
  const readings = {}
  for (const line of stdout.split('\n')) {
    const match = /^([A-Z_]+)(?: (.*))?$/.exec(line.trim())
    if (match && !(match[1] in readings)) readings[match[1]] = match[2] ?? ''
  }
  return readings
}

function runProbe(executable, args, store, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: appRoot,
      env: { ...process.env, ONETHING_STORE_PATH: store, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out = []
    const err = []
    child.stdout.on('data', chunk => out.push(chunk.toString()))
    child.stderr.on('data', chunk => err.push(chunk.toString()))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`探针 60s 没退出\nstdout:\n${out.join('')}\nstderr:\n${err.join('')}`))
    }, 60_000)
    child.on('exit', code => {
      clearTimeout(timer)
      resolve({ code, stdout: out.join(''), stderr: err.join('') })
    })
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function runLane(label, executable, args, extraEnv) {
  process.stdout.write(`\n[${label}] 跑同一份产物\n`)
  const store = await mkdtemp(path.join(tmpdir(), `a1-smoke-${label}-`))
  try {
    const result = await runProbe(executable, args, store, extraEnv)
    const readings = readingsOf(result.stdout)
    const context = `\nexit=${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr.slice(-4000)}`
    assert(result.code === 0, `探针退出码 0${result.code === 0 ? '' : context}`)
    assert('DONE' in readings, `探针跑到底${'DONE' in readings ? '' : context}`)

    const readyMs = Number.parseInt(readings.READY_MS ?? '', 10)
    assert(
      Number.isFinite(readyMs) && readyMs < READY_BUDGET_MS,
      `backend ready ${readyMs}ms < ${READY_BUDGET_MS}ms`,
    )
    assert(readings.OWNER === 'shell', `发现文件 owner === 'shell'(读到 ${readings.OWNER})`)
    assert(readings.HTTP === '200', `真 fetch 打 /api/capabilities → HTTP ${readings.HTTP}`)
    assert(readings.COLLAB === 'true', `capabilities.collabRooms === true(collab:true 真落到装配上)`)
    // B3(`docs/design/backend-transport-forks-2026-09.md` §2.3):三位从后端事实
    // 推导出来的能力位。壳上的期望是 true / false / false —— 这台面是可信的本机
    // 面,终端广播器与插件管理器这个壳都还没接。
    // 反证(实跑过):把 `server/runtime.ts` 的 `terminal` 改回常量 `false`,单测
    // `server/__tests__/capabilities.test.ts` 的"判据同源"那条红。这条真机断言**测
    // 不出宿主表里的 `localTrust`**:探针是在内嵌 HTTP 面挂上来之后问的,而
    // `server/embed.ts` 会再声明一次同 origin —— 那一格的判据在 A0 第 ⑩ 条。
    assert(
      readings.CAPS === 'localFileSystem=true terminal=false pluginsManage=false',
      `capabilities 三位推导正确(读到 ${readings.CAPS})`,
    )
    assert(readings.PTY === 'ok', `require('node-pty') 拿到真模块(读到 ${readings.PTY})`)
    return readyMs
  } finally {
    await rm(store, { recursive: true, force: true })
  }
}

async function main() {
  const started = Date.now()
  await build(shellEsbuildOptions({
    entryPoints: { 'core-boot-probe': probeEntry },
    outdir: outDir,
  }))
  process.stdout.write(`\n[build] 探针打包 ${Date.now() - started}ms\n`)

  const nodeMs = await runLane('node', process.execPath, [probeBundle])
  // Electron 泳道走的是**主进程**(不带 ELECTRON_RUN_AS_NODE):要的就是 app 身份
  // 与 Chromium 那套 net stack 在场时的行为。
  const electronMs = await runLane('electron-main', electronBinary, [probeBundle])

  process.stdout.write(`\n[smoke:core] ok —— node ${nodeMs}ms / electron-main ${electronMs}ms\n`)
}

main().catch(error => {
  process.stderr.write(`\n[smoke:core] FAILED: ${error?.stack || error}\n`)
  process.exit(1)
})
