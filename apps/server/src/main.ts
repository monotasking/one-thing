import { createOnethingHttpServer } from './http.js'
import { createDevelopmentOnethingServerRuntime } from './runtime.js'

const port = Number.parseInt(process.env.ONETHING_SERVER_PORT || '8787', 10)
const host = process.env.ONETHING_SERVER_HOST || '127.0.0.1'
const corsOrigin = process.env.ONETHING_CORS_ORIGIN || 'http://127.0.0.1:5174'
const authToken = process.env.ONETHING_SERVER_TOKEN
const workspaceRoot = process.env.ONETHING_SERVER_WORKSPACE_ROOT
const dataRoot = process.env.ONETHING_SERVER_DATA_ROOT
const settingsRoot = process.env.ONETHING_SERVER_SETTINGS_ROOT

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1'])
const allowInsecure = ['1', 'true', 'yes'].includes(
  (process.env.ONETHING_SERVER_ALLOW_INSECURE || '').toLowerCase(),
)
// Fail fast before paying the runtime-creation cost: a non-loopback bind
// without a shared-secret token exposes the full API to the LAN.
if (!authToken && !loopbackHosts.has(host)) {
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
console.log(`[Perf][Startup] runtime-created in ${Date.now() - runtimeCreateStart}ms`)
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

server.listen(port, host, () => {
  console.log(`[onething-server] listening on http://${host}:${port}`)
  // Pairing line for mobile clients: scan/encode this JSON as a QR code.
  const pairing: Record<string, unknown> = { host, port }
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
    process.exit(1)
  }
  shuttingDown = true
  console.log(`[onething-server] received ${signal}, shutting down`)

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
