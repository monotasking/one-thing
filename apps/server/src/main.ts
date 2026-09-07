/**
 * `server:start` 的进程壳。
 *
 * A 期(docs/design/one-core-2026-08.md §3)之后 HTTP/SSE 面与 server runtime 的
 * **实现**都在 `@onething/backend/server/*`,这个文件只剩三件事:读环境、决定要不要
 * 让位给桌面 core 服务、以及进程生命周期(监听 / 发现文件 / 退出刷盘)。
 */
import { createOnethingHttpServer } from '@onething/backend/server/http.js'
import { createDevelopmentOnethingServerRuntime } from '@onething/backend/server/runtime.js'
import {
  httpDiscoveryUrl,
  isHttpDiscoveryAlive,
  readHttpDiscovery,
  removeHttpDiscovery,
  writeHttpDiscovery,
} from '@onething/backend/server/discovery.js'
import { configureHostLocalTrust } from '@onething/backend/server/host-trust.js'
import { getAppLogPath, getLogger } from '@onething/backend/wiring/logging/index.js'
import { warnOnForeignCoreForEventsRead } from '@onething/backend/session/read-mode.js'
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
    // 启动期 FATAL:`configureLogging()` 还没接线(它必须排在 runtime 之后,见下),
    // 这一条必须现在就出现在 stderr 上。§8.4 白名单。
    // eslint-disable-next-line no-console
    console.error(
      `[onething-server] FATAL: refusing to listen on ${host} without ONETHING_SERVER_TOKEN — `
      + 'the API would be reachable from other machines without authentication.\n'
      + '  Set ONETHING_SERVER_TOKEN to a shared secret, or start with '
      + 'ONETHING_SERVER_ALLOW_INSECURE=1 to bypass this check (not recommended).',
    )
    process.exit(1)
  }
  // 同上:接线之前的启动期告警,必须直写 stderr。
  // eslint-disable-next-line no-console
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
if (existing && existing.owner !== 'server') {
  if (await isHttpDiscoveryAlive(existing)) {
    if (!forced) {
      // 启动期 FATAL(让位给桌面 core):日志尚未接线,直写 stderr。
      // eslint-disable-next-line no-console
      console.error(
        `[onething-server] this store is already served by the ${existing.owner} core at `
        + `${httpDiscoveryUrl(existing)} — connect to it instead (pass --force to start anyway)`,
      )
      process.exit(1)
    }
    // R-c(2026-08-20 裁定,§13.6):`--force` 不是"自负后果"这么轻。
    // 两个 core 同时开着 = 两个写者往同一份 `events.jsonl` 追加,而 seq 是各自
    // 内存里数出来的 —— 撞号之后 `surfaceOp: replace` 遮蔽的是**别人的**区间,
    // 而校验会照样放行(surface 上确实有那个 seq)。这不是"可能不一致",
    // 是会把事件账本写坏,而且坏得看不出来。
    // eslint-disable-next-line no-console
    console.error(
      `[onething-server] --force: starting a SECOND core on a store already served by the `
      + `${existing.owner} core at ${httpDiscoveryUrl(existing)}.\n`
      + '[onething-server] WARNING: two writers mint the same event seq in sessions/*/events.jsonl — '
      + 'replace ops will shadow the wrong range and validation will not catch it. '
      + 'The event ledger can be silently corrupted. Stop the other core instead.',
    )
  }
}

const runtimeCreateStart = Date.now()
// 装配失败要给一句人话,而不是把 top-level await 的 unhandled rejection
// 连栈一起糊在终端上。
const serverRuntime = await createDevelopmentOnethingServerRuntime({
  workspaceRoot,
  dataRoot,
  settingsRoot,
  logging: { fileBaseName: 'server', src: 'server', consoleEcho: 'pretty' },
}).catch((error: unknown) => {
  // 装配失败也可能发生在日志配置前，启动错误直接保留到 stderr。
  // eslint-disable-next-line no-console
  console.error(`[onething-server] FATAL: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
// Backend 在取得目录 lease 后配置日志，并在最终解锁前关闭日志句柄。
const log = getLogger('server')
// R-c(§13.6):切读之后还有别的 core 拿着这个 store,喊一声(不崩)。
// 拦是迁移脚本的事;这里只让"两个写者"这件事在日志里留下一行。
warnOnForeignCoreForEventsRead(
  log,
  existing && existing.owner !== 'server'
    ? { owner: existing.owner, pid: existing.pid, port: existing.port }
    : undefined,
)
log.info('runtime created', { ms: Date.now() - runtimeCreateStart })
log.info('logging to file', { path: getAppLogPath() })
// 本机宿主可信(2026-08-30 拍板,`@onething/backend/server/host-trust.ts`):
// **只有回环绑定才声明可信**。回环 = 服务的是本机同一个用户的同一个 store,那时
// `POST /api/rpc` 的 files 面与桌面 IPC 同权;绑到别的地址上就是"别人也够得着"的
// 独立部署,护栏原样不动。`ONETHING_SERVER_FILES_SANDBOX=1` 压得住这条声明。
// 端口自己会按现状打一行日志(可信 / 强制收紧 / 保持夹紧)。
configureHostLocalTrust(isLoopback ? { origin: 'loopback-server', host } : null)
// 先拿到 Backend,再造服务器(工单 4 C11):`runRequest` 那条闭包引用它,而它
// 从前是在下面几行才声明的 —— 只要有一个请求赶在那之前进来就是 TDZ 崩。
const ownedBackend = serverRuntime.backend ?? (() => { throw new Error('Standalone server requires an owned Backend') })()
const server = createOnethingHttpServer({
  runRequest: run => ownedBackend.runTask('http request', run),
  runtime: serverRuntime.runtime,
  corsOrigin,
  authToken,
  // Taken from the runtime rather than from `workspaceRoot` above: the runtime
  // is where the env var + tmpdir fallback are resolved, and a second
  // resolution here could drift into a *different* root — which for the
  // sandbox-scoped RPC domains would mean clamping against the wrong tree.
  workspaceRoot: serverRuntime.workspaceRoot,
})
const storeLease = ownedBackend.storeLease
ownedBackend.own(() => server.stopAccepting(), 'httpIngress', 'quiesce')
ownedBackend.own(() => server.whenClosed(), 'httpConnections')
ownedBackend.own(() => removeHttpDiscovery({ lease: storeLease }), 'httpDiscovery', 'endpoints')

// 固定端口被占 = 明确报错,绝不静默换一个:换了的话客户端(和发现文件的读者)
// 会连到一个它没打算连的实例上。
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    log.fatal('port already in use', {
      port,
      explicitPort,
      hint: 'free it, or unset ONETHING_SERVER_PORT to let the core pick a free port',
    })
  } else {
    log.fatal('listen failed', { port, host }, error)
  }
  void ownedBackend.requestShutdown('listen failed').then(() => process.exit(1), () => process.exit(1))
})

server.listen(port, host, () => {
  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  log.info('listening', { url: `http://${host}:${actualPort}` })
  // 发现文件:客户端(web dev 代理 / CLI / B 期 renderer)一律靠它找到这个进程。
  if (ownedBackend.isShuttingDown) return
  try {
    writeHttpDiscovery({
      port: actualPort,
      host,
      token: authToken,
      pid: process.pid,
      startedAt: Date.now(),
      owner: 'server',
    }, { lease: storeLease })
  } catch (error) {
    log.error('discovery publication failed', {}, error)
    void ownedBackend.requestShutdown('discovery publication failed').then(
      () => process.exit(1),
      () => process.exit(1),
    )
    return
  }
  // Pairing line for mobile clients: scan/encode this JSON as a QR code.
  const pairing: Record<string, unknown> = { host, port: actualPort }
  if (authToken) pairing.token = authToken
  log.info('pairing', pairing)
  log.info('http listening', { sinceProcessStartMs: Math.round(process.uptime() * 1000) })
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
let shuttingDown = false

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    log.warn('signal received again while shutting down, exiting now', { signal })
    process.exit(1)
  }
  shuttingDown = true
  log.info('signal received, shutting down', { signal })
  try {
    await ownedBackend.requestShutdown(signal)
  } catch (error) {
    log.error('shutdown failed', {}, error)
    process.exit(1)
  }
  process.exit(0)
}

process.on('SIGINT', signal => void shutdown(signal))
process.on('SIGTERM', signal => void shutdown(signal))
