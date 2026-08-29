#!/usr/bin/env node
/**
 * React 壳 D0 的验收门 —— **脚本级,拒人肉 QA**(方案 §4 P0 那一行门)。
 *
 * 两条路径各验一次,全绿才算过:
 *
 *  路径一(没有 core 在跑):临时 store → 拉起应用 → 断言
 *    ① 应用**自己** spawn 了 core(发现文件出现,owner=server,pid ≠ 我们起的任何进程)
 *    ② `window.__d0.rpcOk === true`(一次真 `POST /api/rpc` 往返)
 *    ③ 脚本侧拿发现文件里的 token 造一个事件(`sessions.create`)→
 *       `window.__d0.sseEvents > 0`(SSE 真的到了渲染层)
 *    ④ 应用退出后那个子进程被收尸
 *
 *  路径二(core 已在跑):脚本先自己起 `dist/server/main.js` 写出发现文件 → 拉起应用 →
 *    断言应用**没有**再 spawn 第二个 core(发现文件里的 pid 还是脚本那个),rpc/SSE 同样通过,
 *    应用退出后那台 server **还活着**(不属于它的不杀)。
 *
 * 跑法:`node scripts/gate-connect.mjs`(仓根先 `bun run server:build`)。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
/**
 * **Electron 本体不在这个应用里重装一份**(D0 裁量,2026-08-29)。
 *
 * 仓根已经装着这个壳要用的那一份 —— 而且不是 npm 上的 `electron`,是
 * `github:castlabs/electron-releases#v41.1.1+wvcus`(带 Widevine 的定制 build)。
 * 在这里再声明一个 `electron` devDep 会得到:第二份 ~250MB 二进制、和旧壳漂开的
 * 版本、以及一次必然要联网的 postinstall。`import 'electron'` 从这里出发按 node
 * 解析往上走,命中的就是仓根那一份 —— 两个壳同一个运行时,正是并行过渡期要的。
 * 打包链(electron-builder / 签名)归 P4/退役期,谁持有 Electron 那时一起拍。
 */
import electronBinary from 'electron'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function discoveryPathFor(store) {
  return path.join(store, 'run', 'http.json')
}

function readDiscovery(store) {
  try {
    return JSON.parse(readFileSync(discoveryPathFor(store), 'utf-8'))
  } catch {
    return undefined
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function portConnects(host, port) {
  return new Promise(resolve => {
    const socket = connect({ host, port })
    const settle = value => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(500)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

async function waitFor(label, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await delay(150)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败:${message}`)
  console.log(`  ✓ ${message}`)
}

/** 用发现文件里的 token 打一条真 RPC —— 这是脚本侧「造一个事件」的手。 */
async function rpc(record, domain, method, payload = {}) {
  const response = await fetch(`http://${record.host}:${record.port}/api/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(record.token ? { authorization: `Bearer ${record.token}` } : {}),
    },
    body: JSON.stringify({ domain, method, payload }),
  })
  if (!response.ok) throw new Error(`rpc ${domain}.${method} HTTP ${response.status}`)
  return response.json()
}

async function launchApp(store) {
  const app = await electron.launch({
    executablePath: electronBinary,
    args: [mainEntry],
    env: {
      ...process.env,
      ONETHING_STORE_PATH: store,
      // 渲染层从构建产物加载(不需要 dev server)。
      ONETHING_REACT_DEV_SERVER_URL: '',
    },
  })
  const page = await app.firstWindow()
  return { app, page }
}

async function probeOf(page) {
  return page.evaluate(() => window.__d0 ?? null)
}

async function runPathOne() {
  console.log('\n[路径一] 没有 core 在跑 —— 应用自己拉起、退出时收尸')
  const store = await mkdtemp(path.join(tmpdir(), 'd0-gate-solo-'))
  let app
  try {
    const launched = await launchApp(store)
    app = launched.app
    const page = launched.page

    const record = await waitFor('应用自己 spawn 的 core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.owner === 'server' ? found : undefined
    })
    assert(record.owner === 'server', `应用自己拉起了 core(owner=server, pid=${record.pid})`)
    assert(await portConnects(record.host, record.port), `core 端口 ${record.port} 可连`)

    const probe = await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await probeOf(page)
      return value && value.rpcOk ? value : undefined
    })
    assert(probe.hosted === true, '渲染层认出宿主在场(走的是注入的 baseUrl)')
    assert(probe.rpcOk === true, `window.__d0.rpcOk === true(baseUrl=${probe.baseUrl})`)

    // 脚本侧造一个事件:建一个会话 → 引擎发 session:event → SSE → 渲染层。
    const created = await rpc(record, 'sessions', 'create', { name: 'd0-gate' })
    assert(created.ok !== false, `sessions.create 经 POST /api/rpc 成功 ${JSON.stringify(created).slice(0, 300)}`)

    const withEvents = await waitFor('SSE 事件到达渲染层', async () => {
      const value = await probeOf(page)
      return value && value.sseEvents > 0 ? value : undefined
    })
    assert(withEvents.sseEvents > 0, `window.__d0.sseEvents === ${withEvents.sseEvents} > 0`)

    const corePid = record.pid
    await app.close()
    app = undefined
    await waitFor('应用自己拉起的 core 子进程被收尸', () => !pidAlive(corePid), 10_000)
    assert(!pidAlive(corePid), `退出时 SIGTERM 收尸(pid ${corePid} 已不在)`)
  } finally {
    if (app) await app.close().catch(() => {})
    await rm(store, { recursive: true, force: true })
  }
}

async function runPathTwo() {
  console.log('\n[路径二] core 已在跑 —— 应用连它,不起第二个,也不杀不属于它的')
  const store = await mkdtemp(path.join(tmpdir(), 'd0-gate-shared-'))
  let server
  let app
  try {
    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: { ...process.env, ONETHING_STORE_PATH: store },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const serverErr = []
    server.stderr.on('data', chunk => serverErr.push(chunk.toString()))

    const record = await waitFor('脚本起的 core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.pid === server.pid ? found : undefined
    }).catch(error => {
      throw new Error(`${error.message}\nserver stderr:\n${serverErr.join('')}`)
    })
    assert(record.pid === server.pid, `脚本自己起的 core 在跑(pid ${record.pid})`)

    const launched = await launchApp(store)
    app = launched.app
    const page = launched.page

    const probe = await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await probeOf(page)
      return value && value.rpcOk ? value : undefined
    })
    assert(probe.rpcOk === true, `window.__d0.rpcOk === true(baseUrl=${probe.baseUrl})`)

    const after = readDiscovery(store)
    assert(after.pid === server.pid, '发现文件里还是脚本那个 pid —— 应用没有 spawn 第二个 core')
    assert(after.port === record.port, `连的是同一个端口 ${record.port}`)

    const created = await rpc(record, 'sessions', 'create', { name: 'd0-gate-shared' })
    assert(created.ok !== false, `sessions.create 经 POST /api/rpc 成功 ${JSON.stringify(created).slice(0, 300)}`)

    const withEvents = await waitFor('SSE 事件到达渲染层', async () => {
      const value = await probeOf(page)
      return value && value.sseEvents > 0 ? value : undefined
    })
    assert(withEvents.sseEvents > 0, `window.__d0.sseEvents === ${withEvents.sseEvents} > 0`)

    await app.close()
    app = undefined
    await delay(1500)
    assert(pidAlive(server.pid), `应用退出后那台 server 还活着(pid ${server.pid})—— 不属于它的不杀`)
  } finally {
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await delay(500)
    await rm(store, { recursive: true, force: true })
  }
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(`[d0-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``)
    process.exit(1)
  }
  if (!existsSync(mainEntry)) {
    console.error(`[d0-gate] 找不到 ${path.relative(appRoot, mainEntry)} —— 先跑 \`npm run app:build\``)
    process.exit(1)
  }
  if (!existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[d0-gate] 找不到 dist/index.html —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  await runPathOne()
  await runPathTwo()
  console.log('\n[d0-gate] ok —— 两条路径全绿')
}

main().catch(error => {
  console.error('\n[d0-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
