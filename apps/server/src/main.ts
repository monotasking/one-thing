/**
 * `server:start` 的进程壳。
 *
 * A 期(docs/design/one-core-2026-08.md §3)之后 HTTP/SSE 面与 server runtime 的
 * **实现**都在 `@onething/app/server/*`,这个文件只剩三件事:读环境、决定要不要
 * 让位给桌面 core 服务、以及进程生命周期(监听 / 发现文件 / 退出刷盘)。
 */
import { createOnethingHttpServer } from '@onething/app/server/http.js'
import { createDevelopmentOnethingServerRuntime } from '@onething/app/server/runtime.js'
import {
  httpDiscoveryUrl,
  isHttpDiscoveryAlive,
  readHttpDiscovery,
  removeHttpDiscovery,
  writeHttpDiscovery,
} from '@onething/app/server/discovery.js'
import { configureLogging } from '@onething/app/logging/index.js'
import { randomBytes } from 'node:crypto'

const forced = process.argv.includes('--force')
// 端口:显式给了就固定(被占直接报错,不静默换),没给就 listen(0) 动态分配。
// 用户 2026-08-19 的裁定 —— 8787 这个固定值一直在撞。
const explicitPort = process.env.ONETHING_SERVER_PORT
const port = explicitPort ? Number.parseInt(explicitPort, 10) : 0
const host = process.env.ONETHING_SERVER_HOST || '127.0.0.1'
const corsOrigin = process.env.ONETHING_CORS_ORIGIN || 'http://127.0.0.1:5174'
const workspaceRoot = process.env.ONETHING_SERVER_WORKSPACE_ROOT
const dataRoot = process.env.ONETHING_SERVER_DATA_ROOT
const settingsRoot = process.env.ONETHING_SERVER_SETTINGS_ROOT

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1'])
const allowInsecure = ['1', 'true', 'yes'].includes(
  (process.env.ONETHING_SERVER_ALLOW_INSECURE || '').toLowerCase(),
)
// 回环 + token(§3 鉴权):env 给了就用 env,否则每次启动随机生成一把,写进
// 发现文件让本机的客户端读走。非回环仍然要求显式 token —— 随机 token 只在
// 「谁能读 <store>/run/http.json 谁就能连」这个前提下才是安全的。
const isLoopback = loopbackHosts.has(host)
const envToken = process.env.ONETHING_SERVER_TOKEN
if (!envToken && !isLoopback) {
  if (!allowInsecure) {
    console.error(
      `[onething-server] FATAL: refusing to listen on ${host} without ONETHING_SERVER_TOKEN — `
      + 'the API would be reachable from other machines without authentication.\n'
      + '  Set ONETHING_SERVER_TOKEN to a shared secret, or start with '
      + 'ONETHING_SERVER_ALLOW_INSECURE=1 to bypass this check (not recommended).',
    )
    process.exit(1)
  }
  console.warn(
    `[onething-server] WARNING: listening on ${host} without ONETHING_SERVER_TOKEN — `
    + 'the API is reachable from other machines without authentication.',
  )
}
const authToken = envToken || (isLoopback ? randomBytes(24).toString('base64url') : undefined)

/**
 * 「一个 store 一个 core」的直接体现(§3):这不是锁,是让位。
 *
 * 桌面开着时它就是这个 store 的 core 进程,并且已经暴露了 HTTP/SSE 面 ——
 * 再起一个 server 就又回到"两个引擎两份内存真相"。所以启动前读发现文件,
 * 活着且不是自己人就拒绝启动,`--force` 可以绕过(自负后果)。
 */
const existing = readHttpDiscovery()
if (existing && existing.owner !== 'server' && !forced) {
  if (await isHttpDiscoveryAlive(existing)) {
    console.error(
      `[onething-server] this store is already served by the ${existing.owner} core at `
      + `${httpDiscoveryUrl(existing)} — connect to it instead (pass --force to start anyway)`,
    )
    process.exit(1)
  }
}

const runtimeCreateStart = Date.now()
// 装配失败(最典型的是 P0.4 新加的 store 单实例锁被别人占着)要给一句人话,
// 而不是把 top-level await 的 unhandled rejection 连栈一起糊在终端上。
const serverRuntime = await createDevelopmentOnethingServerRuntime({
  workspaceRoot,
  dataRoot,
  settingsRoot,
}).catch((error: unknown) => {
  console.error(`[onething-server] FATAL: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
// 日志接线(L2 的 server 那半,L1 一起落):`<store>/log/server.jsonl` + 进程钩子
// + log/ 目录治理。位置在 runtime 之后是**故意的** —— store 根(`ONETHING_STORE_PATH`)
// 由 runtime 装配时钉死,提前接线会把日志写进另一个 store 的 log/ 目录。
// 桌面里那只**嵌入式** HTTP 面不会走到这里(它在主进程,`configureLogging` 幂等,
// 记录进 app.jsonl),所以不存在两个进程抢同一个 server.jsonl 的情况。
const logging = configureLogging({ fileBaseName: 'server', src: 'server' })
console.log(`[Perf][Startup] runtime-created in ${Date.now() - runtimeCreateStart}ms`)
console.log(`[onething-server] logging to ${logging.logPath}`)
const server = createOnethingHttpServer({
  runtime: serverRuntime.runtime,
  corsOrigin,
  authToken,
  // Taken from the runtime rather than from `workspaceRoot` above: the runtime
  // is where the env var + tmpdir fallback are resolved, and a second
  // resolution here could drift into a *different* root — which for the
  // sandbox-scoped RPC domains would mean clamping against the wrong tree.
  workspaceRoot: serverRuntime.workspaceRoot,
})

// 固定端口被占 = 明确报错,绝不静默换一个:换了的话客户端(和发现文件的读者)
// 会连到一个它没打算连的实例上。
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `[onething-server] FATAL: port ${port} is already in use (ONETHING_SERVER_PORT=${explicitPort}) — `
      + 'free it, or unset ONETHING_SERVER_PORT to let the core pick a free port.',
    )
  } else {
    console.error('[onething-server] FATAL: listen failed', error)
  }
  process.exit(1)
})

server.listen(port, host, () => {
  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  console.log(`[onething-server] listening on http://${host}:${actualPort}`)
  // 发现文件:客户端(web dev 代理 / CLI / B 期 renderer)一律靠它找到这个进程。
  writeHttpDiscovery({
    port: actualPort,
    host,
    token: authToken,
    pid: process.pid,
    startedAt: Date.now(),
    owner: 'server',
  })
  // Pairing line for mobile clients: scan/encode this JSON as a QR code.
  const pairing: Record<string, unknown> = { host, port: actualPort }
  if (authToken) pairing.token = authToken
  console.log(`[onething-server] pairing ${JSON.stringify(pairing)}`)
  console.log(`[Perf][Startup] http-listening +${Math.round(process.uptime() * 1000)}ms since process start`)
})

/**
 * 退出必须**等** `serverRuntime.shutdown()`(P0.4)。
 *
 * 会话落盘是 300ms 节流的:老写法在 `server.close()` 回调里 fire-and-forget 掉
 * `shutdown()`(里面才 `await sessionStore.flushAll()`),紧接着 `process.exit(0)`
 * —— 队列里那一批写就整批丢了。这是迁移前就有的病(老路的 `persistSession` 排的
 * 是同一个队列),P0.4 一并修。
 *
 * 兜底超时 5s:刷盘卡住也不能把进程钉在这里(SIGTERM 之后编排器很快就是 SIGKILL),
 * 超时就带非零码退出,把"没刷干净"这件事说出来而不是假装干净。
 * 重复信号直接硬退,不再排第二次队。
 */
const SHUTDOWN_FLUSH_TIMEOUT_MS = 5000
let shuttingDown = false

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    console.warn(`[onething-server] received ${signal} again while shutting down, exiting now`)
    removeHttpDiscovery()
    process.exit(1)
  }
  shuttingDown = true
  console.log(`[onething-server] received ${signal}, shutting down`)
  // 发现文件先删:它是"我还在服务"的宣告,关端口这一步开始就已经不成立了。
  removeHttpDiscovery()

  // 超时罩住整段(close 也算在内):挂着的 SSE 连接会让 `server.close()` 的回调
  // 迟迟不来,那种情况下也必须走到刷盘,不能被卡在关端口这一步。
  const drained = (async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await serverRuntime.shutdown()
  })()

  let timer: NodeJS.Timeout | undefined
  const timedOut = await Promise.race([
    drained.then(() => false),
    new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(true), SHUTDOWN_FLUSH_TIMEOUT_MS)
      timer.unref?.()
    }),
  ]).catch(error => {
    console.error('[onething-server] shutdown failed', error)
    return true
  })
  if (timer) clearTimeout(timer)

  if (timedOut) {
    console.error(
      `[onething-server] shutdown did not finish within ${SHUTDOWN_FLUSH_TIMEOUT_MS}ms — `
      + 'pending session writes may be lost',
    )
    process.exit(1)
  }
  process.exit(0)
}

process.on('SIGINT', signal => void shutdown(signal))
process.on('SIGTERM', signal => void shutdown(signal))
