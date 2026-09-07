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
 * 前两条泳道不开窗,只验证构建链。后面的desktop生命周期泳道构建真实main.ts,
 * 使用隔离profile与隐藏空窗口,分别走OS信号和原生关窗路线。
 *
 * ## 第三条泳道:`mcp-early-exit`(C1,方案
 * `docs/design/backend-principal-and-mcp-lifecycle-2026-09.md` §3 的 C1 行)
 *
 * 前两条量的是构建链,这一条量的是**生命周期**:临时 store 里配一台 stdio MCP
 * (探针自带的 `fake-mcp-server.mjs`,命令行带一个本次专属的 marker),探针装配完
 * 不 await 地 `backend.mcp.start()` 紧接着 `dispose()`,然后**看进程表** ——
 * `pgrep -f <marker>` 必须是 0。审查第 2 条那只孤儿 stdio 子进程的现场就在这里。
 *
 * 只在 node 泳道跑一次:判据是"谁杀子进程",与运行时的 net stack 无关,而它要真
 * spawn 一台服务器,跑两遍只是把时间翻倍。
 */
import { execFile, spawn } from 'node:child_process'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electronBinary from 'electron'
import { shellEsbuildOptions } from './build-electron.mjs'
import { runDesktopLifecycleLanes } from './smoke/desktop-lifecycle.mjs'

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
    const env = { ...process.env, ONETHING_STORE_PATH: store, ...extraEnv }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(executable, args, {
      cwd: appRoot,
      env,
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
    const isolatedArgs = executable === electronBinary ? [...args, `--user-data-dir=${path.join(store, 'chromium')}`] : args
    const result = await runProbe(executable, isolatedArgs, store, extraEnv)
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

/** `pgrep -f <pattern>` 的命中条数(没命中时 pgrep 退 1,不是错误)。 */
function countProcesses(pattern) {
  return new Promise(resolve => {
    execFile('pgrep', ['-f', pattern], (error, stdout) => {
      if (error && error.code === 1) return resolve(0)
      if (error) return resolve(`pgrep 失败:${error.message}`)
      resolve(stdout.split('\n').filter(line => line.trim()).length)
    })
  })
}

/**
 * C1 的生命周期泳道:配一台真 stdio MCP,起了就立刻关,数残留。
 *
 * marker 里带 pid + 时间戳:同一台机器上并行跑两趟(或者上一趟留了尸体)也不会
 * 互相冤枉 —— `pgrep -f` 只数这一次的。
 *
 * 反证(实跑过):把 `packages/backend/backend.ts` 那两句
 * `own(() => mcp.dispose(), 'mcp')` / `'acp'` 挪回 `if (options.mcpAcp)` 里(= C1 之前
 * 「起完了才登记」的形状)→ 这条泳道红在第一句:「残留 0 个(读到 1)」。
 *
 * **它抓的是"登记"那一半,不是"等在途 start"那一半**:后者在真机上被
 * `HeadlessMCPManager` 自己的串行队列兜住了(`shutdown()` 是 enqueue 的,排在
 * 在途的 `initialize` 后面),所以拆掉子系统 `dispose()` 里的 `await inFlight`
 * 这道门仍然绿 —— 那一半的判据在 `wiring/mcp/__tests__/subsystem.test.ts`
 * (注入的替身没有那条队列,拆掉即红)。两半各有各的判据,不互相冒充。
 */
async function runMcpEarlyExitLane() {
  const label = 'mcp-early-exit'
  process.stdout.write(`\n[${label}] 起一台真 stdio MCP,不等它连完就关\n`)
  const marker = `onething-smoke-mcp-${process.pid}-${Date.now()}`
  const fakeServer = path.join(appRoot, 'scripts/smoke/fake-mcp-server.mjs')
  const store = await mkdtemp(path.join(tmpdir(), `a1-smoke-${label}-`))
  try {
    await writeFile(
      path.join(store, 'settings.json'),
      `${JSON.stringify({
        mcp: {
          enabled: true,
          servers: [{
            id: 'smoke-fake',
            name: 'smoke fake',
            transport: 'stdio',
            enabled: true,
            command: process.execPath,
            args: [fakeServer, '--marker', marker],
          }],
        },
      }, null, 2)}\n`,
      'utf8',
    )

    const result = await runProbe(process.execPath, [probeBundle], store, {
      ONETHING_SMOKE_SCENARIO: 'mcp-early-exit',
    })
    const readings = readingsOf(result.stdout)
    const context = `\nexit=${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr.slice(-4000)}`
    assert(result.code === 0, `探针退出码 0${result.code === 0 ? '' : context}`)
    assert('DONE' in readings, `探针跑到底${'DONE' in readings ? '' : context}`)
    // 头一条就是这道门的正题:看进程表。
    const survivors = await countProcesses(marker)
    assert(survivors === 0, `探针退出后 MCP 子进程残留 0 个(读到 ${survivors})${survivors === 0 ? '' : context}`)
    // 关门那一刻 start 还在途 —— 这两条读数说的是"我们量的确实是在途那一段"。
    assert(readings.MCP_STATE === 'starting', `dispose 之前子系统在 starting(读到 ${readings.MCP_STATE})`)
    assert(readings.MCP_STATE_AFTER === 'disposed', `dispose 之后子系统 disposed(读到 ${readings.MCP_STATE_AFTER})`)
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
  await runMcpEarlyExitLane()
  await runDesktopLifecycleLanes({ appRoot, outDir, assert })

  process.stdout.write(`\n[smoke:core] ok —— node ${nodeMs}ms / electron-main ${electronMs}ms\n`)
}

main().catch(error => {
  process.stderr.write(`\n[smoke:core] FAILED: ${error?.stack || error}\n`)
  process.exit(1)
})
