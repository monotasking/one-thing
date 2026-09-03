#!/usr/bin/env node
/**
 * React 壳的连接门 —— **脚本级,拒人肉 QA**(方案 §4 P0 那一行门)。
 *
 * 两条路径各验一次,全绿才算过:
 *
 *  路径一(没有 core 在跑,A1 换心之后):临时 store → 拉起应用 → 断言
 *    ① 应用**自己就是** core:发现文件 owner=`shell`,而且 pid **就是壳主进程自己的**
 *       —— 这一条是 A1 的分水岭。D0 那版这里断言的是「spawn 了一个子进程」;
 *       现在断言的是「没有第二个进程」。pid 从 playwright 的 `app.evaluate`
 *       (跑在主进程里)现问,不靠猜。
 *    ② `window.__d0.rpcOk === true`(一次真 `POST /api/rpc` 往返)
 *    ③ 脚本侧拿发现文件里的 token 造一个事件(`sessions.create`)→
 *       `window.__d0.sseEvents > 0`(SSE 真的到了渲染层)
 *    ④ 应用退出后:那个 pid 没了、发现文件被删、**没有**任何遗留 core 进程
 *
 *  路径三(C1 新增,`docs/design/client-sdk-2026-09.md` §5.1):**断了再回来**。
 *    脚本把 core 钉在固定端口 + 固定 token 上起,拉起应用,收到过事件之后
 *    SIGKILL 掉它 → 断言渲染层那一格状态走到 `reconnecting`;把同端口同 token 的
 *    core 起回来 → 断言那一格回到 `live`、新造的事件照样到得了渲染层,而且**重连
 *    那一次请求带着 `?after=<最后一个 SSE id>`**(续播语义;C0 之前的 EventSource
 *    从来没带过这个参数)。
 *
 *  路径二(core 已在跑):脚本先自己起 `dist/server/main.js` 写出发现文件 → 拉起应用 →
 *    断言应用**没有**再装配第二只 core(发现文件里的 pid 还是脚本那个),rpc/SSE 同样通过,
 *    应用退出后那台 server **还活着**(不属于它的不杀)。这条是 D0 的原样保留:
 *    换心不许改变「有人在当家就让位」这条行为。
 *
 * 三条路径都额外钉一条 **C1 的传输事实**:渲染层拉 `GET /api/events` 时
 * **token 在 `Authorization: Bearer` 头里、URL 里一个字都没有**。server 侧那条
 * `?token=` 的口今天还认(它是给 Vue 的 `EventSource` 留的),所以「没走那条口」
 * 只能由门看着 —— 它是本批唯一一处用户可感知的传输变化。
 *
 * 跑法:`node scripts/gate-connect.mjs`(仓根先 `bun run server:build` —— 路径二三要它)。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
/**
 * **Electron 本体不在这个应用里重装一份**(D0 裁量,2026-08-29)。
 *
 * 仓根已经装着这个壳要用的那一份 —— 官方 npm 包 `electron@41.1.1`(2026-09-03 从
 * castlabs 的 `41.1.1+wvcus` 定制 build 换回来,内嵌 Node 24.14 / ABI 145 不变)。
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

/** 要一个当下空着的端口号 —— 路径三要「同一个端口再起一次」。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
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
  // 推送流的每一次请求都记下来 —— 监听在 firstWindow 之后**立刻**挂,
  // 渲染层的 JS 这时还没跑到订阅那一步。
  const eventRequests = []
  page.on('request', request => {
    const url = request.url()
    if (url.includes('/api/events')) eventRequests.push({ url, headers: request.headers() })
  })
  return { app, page, eventRequests }
}

/**
 * C1 的传输断言:token 只在头里,URL 里一个字都没有。
 *
 * 拆掉传输那一侧的 Bearer 头(改回 `?token=`)这条当场红 —— 它是本批可感知的那处
 * 变化的看守。
 */
async function assertEventsRideTheBearerHeader(eventRequests, label = '') {
  const first = await waitFor(`渲染层拉起 GET /api/events${label}`, () => eventRequests[0])
  assert(
    !/[?&]token=/i.test(first.url),
    `/api/events 的 URL 里没有 token${label}(${first.url.replace(/^https?:\/\/[^/]+/, '')})`,
  )
  assert(
    typeof first.headers.authorization === 'string'
      && first.headers.authorization.startsWith('Bearer '),
    `/api/events 带着 Authorization: Bearer 头${label}`,
  )
}

async function probeOf(page) {
  return page.evaluate(() => window.__d0 ?? null)
}

async function runPathOne() {
  console.log('\n[路径一] 没有 core 在跑 —— 壳内嵌自当 core,退出时自己收干净')
  const store = await mkdtemp(path.join(tmpdir(), 'a1-gate-embed-'))
  let app
  try {
    const launched = await launchApp(store)
    app = launched.app
    const page = launched.page

    // 壳主进程自己的 pid。`app.evaluate` 跑在主进程里,所以这是**现问**来的,
    // 不是从发现文件反推的 —— 断言 ① 要的正是这两个数相等。
    const shellPid = await app.evaluate(() => process.pid)

    const record = await waitFor('壳内嵌的 core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.owner === 'shell' ? found : undefined
    })
    assert(record.owner === 'shell', `发现文件 owner === 'shell'(壳在当家)`)
    assert(
      record.pid === shellPid,
      `发现文件 pid ${record.pid} === 壳主进程 pid ${shellPid} —— core 就在壳进程里,没有第二个进程`,
    )
    assert(await portConnects(record.host, record.port), `core 端口 ${record.port} 可连`)

    const probe = await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await probeOf(page)
      return value && value.rpcOk ? value : undefined
    })
    assert(probe.hosted === true, '渲染层认出宿主在场(走的是注入的 baseUrl)')
    assert(probe.rpcOk === true, `window.__d0.rpcOk === true(baseUrl=${probe.baseUrl})`)

    // 脚本侧造一个事件:建一个会话 → 引擎发 session:event → SSE → 渲染层。
    const created = await rpc(record, 'sessions', 'create', { name: 'a1-gate' })
    assert(created.ok !== false, `sessions.create 经 POST /api/rpc 成功 ${JSON.stringify(created).slice(0, 300)}`)

    const withEvents = await waitFor('SSE 事件到达渲染层', async () => {
      const value = await probeOf(page)
      return value && value.sseEvents > 0 ? value : undefined
    })
    assert(withEvents.sseEvents > 0, `window.__d0.sseEvents === ${withEvents.sseEvents} > 0`)
    assert(withEvents.status === 'live', `window.__d0.status === 'live'(推送流那一格)`)
    await assertEventsRideTheBearerHeader(launched.eventRequests)

    await app.close()
    app = undefined
    await waitFor('壳主进程退出', () => !pidAlive(shellPid), 15_000)
    assert(!pidAlive(shellPid), `退出后壳主进程(pid ${shellPid})已不在 —— 没有遗留 core 进程`)
    // 发现文件是「这个 store 由我在服务」的宣告。留着它下一次启动就得靠探活才敢无视。
    assert(readDiscovery(store) === undefined, '退出后发现文件被删')
    assert(!(await portConnects(record.host, record.port)), `core 端口 ${record.port} 已不通`)
  } finally {
    if (app) await app.close().catch(() => {})
    await rm(store, { recursive: true, force: true })
  }
}

async function runPathTwo() {
  console.log('\n[路径二] core 已在跑 —— 应用连它,不起第二个,也不杀不属于它的')
  const store = await mkdtemp(path.join(tmpdir(), 'a1-gate-shared-'))
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

    const created = await rpc(record, 'sessions', 'create', { name: 'a1-gate-shared' })
    assert(created.ok !== false, `sessions.create 经 POST /api/rpc 成功 ${JSON.stringify(created).slice(0, 300)}`)

    const withEvents = await waitFor('SSE 事件到达渲染层', async () => {
      const value = await probeOf(page)
      return value && value.sseEvents > 0 ? value : undefined
    })
    assert(withEvents.sseEvents > 0, `window.__d0.sseEvents === ${withEvents.sseEvents} > 0`)
    await assertEventsRideTheBearerHeader(launched.eventRequests)

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

/**
 * 路径三(C1):断了再回来。
 *
 * core 钉死端口与 token 起一次 → 应用连上 → 打死它 → 那一格走到 `reconnecting`
 * → **同端口同 token** 把它起回来 → 那一格回 `live`、新事件照到、重连那一次
 * 带着 `?after=`。
 *
 * 为什么是 SIGKILL 而不是 SIGSTOP:SIGSTOP 不关 TCP 连接,客户端一时半会儿察觉
 * 不到 —— 那验的是超时不是断线。打死它,连接立刻 RST,传输当场进退避。
 */
async function runPathThree() {
  console.log('\n[路径三] 断了再回来 —— 状态走到 reconnecting,回来后带 ?after= 续播')
  const store = await mkdtemp(path.join(tmpdir(), 'a1-gate-reconnect-'))
  const port = await freePort()
  const token = 'gate-connect-reconnect-token'
  let server
  let app
  const startServer = () => spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ONETHING_STORE_PATH: store,
      ONETHING_SERVER_PORT: String(port),
      ONETHING_SERVER_TOKEN: token,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  try {
    server = startServer()
    const record = await waitFor('脚本起的 core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.pid === server.pid ? found : undefined
    })
    assert(record.port === port, `core 钉在端口 ${port} 上(重启要落回同一个)`)

    const launched = await launchApp(store)
    app = launched.app
    const page = launched.page

    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await probeOf(page)
      return value && value.rpcOk ? value : undefined
    })
    await rpc(record, 'sessions', 'create', { name: 'a1-gate-reconnect-1' })
    const before = await waitFor('第一批 SSE 事件到达渲染层', async () => {
      const value = await probeOf(page)
      return value && value.sseEvents > 0 && value.status === 'live' ? value : undefined
    })
    assert(before.status === 'live', `断线之前 window.__d0.status === 'live'`)
    await assertEventsRideTheBearerHeader(launched.eventRequests, '(断线之前)')

    // ── 断 ────────────────────────────────────────────────────────────────
    server.kill('SIGKILL')
    await waitFor('core 端口不通', async () => !(await portConnects('127.0.0.1', port)), 15_000)
    const broken = await waitFor(`window.__d0.status 走到 'reconnecting'`, async () => {
      const value = await probeOf(page)
      return value && value.status === 'reconnecting' ? value : undefined
    })
    assert(broken.status === 'reconnecting', `断线后 window.__d0.status === 'reconnecting'`)

    // ── 回 ────────────────────────────────────────────────────────────────
    server = startServer()
    const back = await waitFor('core 起回来并写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.pid === server.pid && found.port === port ? found : undefined
    })
    assert(back.port === port && back.token === token, `core 回到同一个端口与 token`)

    const live = await waitFor(`window.__d0.status 回到 'live'`, async () => {
      const value = await probeOf(page)
      if (!value || value.status === 'live') return value
      // 退避期间它自己会重试;这里顺手造事件,回来之后立刻有东西可收。
      await rpc(back, 'sessions', 'create', { name: 'a1-gate-reconnect-2' }).catch(() => {})
      return undefined
    }, 40_000)
    assert(live.status === 'live', `恢复后 window.__d0.status === 'live'`)
    assert(
      live.sseEvents > before.sseEvents,
      `恢复后事件继续到达渲染层(${before.sseEvents} → ${live.sseEvents})`,
    )

    const withAfter = launched.eventRequests.filter(request => /[?&]after=\d+/.test(request.url))
    assert(
      withAfter.length > 0,
      `重连那次 GET /api/events 带着 ?after=(${withAfter[0]?.url.replace(/^https?:\/\/[^/]+/, '') ?? '无'})`,
    )
    assert(
      launched.eventRequests.every(request => !/[?&]token=/i.test(request.url)),
      `${launched.eventRequests.length} 次 /api/events 请求里没有一次把 token 放进 URL`,
    )
  } finally {
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await delay(500)
    await rm(store, { recursive: true, force: true })
  }
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(`[gate:connect] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``)
    process.exit(1)
  }
  if (!existsSync(mainEntry)) {
    console.error(`[gate:connect] 找不到 ${path.relative(appRoot, mainEntry)} —— 先跑 \`npm run app:build\``)
    process.exit(1)
  }
  if (!existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[gate:connect] 找不到 dist/index.html —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  await runPathOne()
  await runPathTwo()
  await runPathThree()
  console.log('\n[gate:connect] ok —— 三条路径全绿')
}

main().catch(error => {
  console.error('\n[gate:connect] FAILED:', error?.stack || error)
  process.exit(1)
})
