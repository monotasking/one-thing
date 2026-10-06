/**
 * 不带界面的后端进程入口:整个仓库里唯一一个「只有后端、没有窗口」的进程从这里起。
 *
 * 它做什么:读环境变量(端口、绑定地址、token、几个根目录),判断这个 store 是不是已经被桌面服务着
 * (是就让位,`--force` 越过),装配一份后端并把 `@onething/backend/http-server` 的 HTTP/SSE 面挂上去,
 * 监听端口、写 `<store>/run/http.json` 发现文件,收到 SIGINT / SIGTERM 时等后端拆除跑完(会话落盘)再退出。
 * HTTP 面与 server runtime 的实现都不在这里,这个文件只管进程的生命周期。
 *
 * 谁用它:`bun run server:build` 把它打成 `dist/server/main.js`(构建配方在 `scripts/build-server.mjs`),
 * `bun run server:start`、`bun run dev:web` 的 server 泳道与 `gate:acp` / `gate:search-index` / `gate:web-shell`
 * 这些真机门跑的都是那份产物。第④步批 2a 起桌面构建(`apps/desktop-react/scripts/build-electron.mjs`)
 * 也把它打成 `dist-electron/backend.cjs`,批 2b 起由桌面用 Electron 二进制 + `ELECTRON_RUN_AS_NODE=1` 拉起;
 * 今天还没人拉起那份,只有 `gate:backend-process` 跑它。
 *
 * **档位**:`ONETHING_BACKEND_LAUNCHER=desktop|cli|none` 说是谁拉起了它,决定多起哪几件(用户定时任务、
 * 真的 MCP 客户端、电台、首启模型拉取、登录 shell 的 PATH)、装配开关、日志与发现文件的 owner。
 * 不设 = 缺省档,与批 2a 之前逐字相同。档位表与每一格的取值在 `backend-launcher.ts`。
 *
 * 依赖:`http-server`(HTTP 面、server runtime、发现文件、本机信任)、`logging` 与它的装配入口、`session`
 * (外来写者告警)、包根的 `backend-launcher.ts`(档位)。
 *
 * 它是进程入口,不许被任何文件 import(`entry:gate` 按 `*-standalone-main.ts` 的名字认它)。
 */
import { createOnethingHttpServer } from '@onething/backend/http-server'
import { createDevelopmentOnethingServerRuntime } from '@onething/backend/http-server'
import {
  httpDiscoveryUrl,
  isHttpDiscoveryAlive,
  readHttpDiscovery,
  removeHttpDiscovery,
  writeHttpDiscovery,
} from '@onething/backend/http-server'
import { configureHostLocalTrust } from '@onething/backend/http-server'
import { getLogger } from '@onething/backend/logging'
import { getAppLogPath } from '@onething/backend/logging/logging-configure'
import { warnOnForeignCoreForEventsRead } from '@onething/backend/session'
import {
  backendLaunchProfile,
  prepareProcessEnv,
  readBackendLauncher,
  startLaunchServices,
} from '@onething/backend/backend-launcher.js'
import { randomBytes } from 'node:crypto'

/*
 * 整段包在一个 async 函数里,不用顶层 await:桌面那份产物是 esbuild 打的 CJS(`dist-electron/backend.cjs`),
 * CJS 里没有顶层 await。函数体就是从前的模块体、次序没动,只多了档位那几行(读档位、改进程名、登录 shell、
 * 装配之后起的几件、发现文件的 owner);缺省档下它们一件都不做。
 */
async function main(): Promise<void> {
  const launcherReading = readBackendLauncher()
  if (!launcherReading.ok) {
    // 启动期 FATAL:日志还没接线,直写 stderr。认不出的档位不许静默退回缺省档(拼错一个字母就少了 MCP 与定时任务)。
    process.stderr.write(
      `[onething-server] FATAL: unknown ONETHING_BACKEND_LAUNCHER=${JSON.stringify(launcherReading.value)} `
      + '— expected desktop, cli or none (or leave it unset)\n',
    )
    process.exit(1)
  }
  const profile = backendLaunchProfile(launcherReading.launcher)
  if (profile.processTitle) process.title = profile.processTitle

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
   * **活着就拒绝启动,不看 owner**(第④步批 2a,决策 D6):从前只对 `owner !== 'server'` 让位,
   * 两台 `server:start` 于是互不拒绝;拆进程之后桌面拉起的后端(owner `backend`)与 `server:start`
   * 是同一种进程,这条洞会落在主路上。`--force` 可以绕过(自负后果)。
   */
  const existing = readHttpDiscovery()
  const foreignCoreAlive = existing ? await isHttpDiscoveryAlive(existing) : false
  if (existing && foreignCoreAlive) {
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

  // 登录 shell 的 PATH(桌面档):让位判定之后才起,与装配并行跑,装配完、ACP 起名册之前等它;缺省档不跑,立即落定。
  const processEnvReady = prepareProcessEnv(profile)
  const runtimeCreateStart = Date.now()
  // 装配失败要给一句人话,而不是把 top-level await 的 unhandled rejection
  // 连栈一起糊在终端上。
  const serverRuntime = await createDevelopmentOnethingServerRuntime({
    workspaceRoot,
    dataRoot,
    settingsRoot,
    // 缺省档 `server.jsonl` + 终端 pretty 回显;桌面档 `app.jsonl`、不回显(理由在档案那一格上)。
    logging: profile.logging,
    launchProfile: profile,
    beforeFirstSpawn: processEnvReady,
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
  // 判据随 D6 改成「启动时那份记录活着」(只有 `--force` 才走得到这里)。
  warnOnForeignCoreForEventsRead(
    log,
    existing && foreignCoreAlive
      ? { owner: existing.owner, pid: existing.pid, port: existing.port }
      : undefined,
  )
  log.info('runtime created', { ms: Date.now() - runtimeCreateStart, launcher: profile.launcher ?? null })
  log.info('logging to file', { path: getAppLogPath() })
  // 本机宿主可信(2026-08-30 拍板,`packages/backend/http-server/http-server-host-trust.ts`):
  // **只有回环绑定才声明可信**。回环 = 服务的是本机同一个用户的同一个 store,那时
  // `POST /api/rpc` 的 files 面与桌面 IPC 同权;绑到别的地址上就是"别人也够得着"的
  // 独立部署,护栏原样不动。`ONETHING_SERVER_FILES_SANDBOX=1` 压得住这条声明。
  // 端口自己会按现状打一行日志(可信 / 强制收紧 / 保持夹紧)。
  configureHostLocalTrust(isLoopback ? { origin: 'loopback-server', host } : null)
  // 先拿到 Backend,再造服务器(工单 4 C11):`runRequest` 那条闭包引用它,而它
  // 从前是在下面几行才声明的 —— 只要有一个请求赶在那之前进来就是 TDZ 崩。
  const ownedBackend = serverRuntime.backend ?? (() => { throw new Error('Standalone server requires an owned Backend') })()
  /*
   * 笔记库要在**声明可信之后**重问一遍(P1,2026-09-18 review ③)。
   *
   * 时序:装配时这台宿主的 `OnethingHostPorts.localTrust` 是 `null`(回环与否要到
   * 上面那一行才知道),所以装配里那次 `refresh` 看到的是「不可信」→ 空表。这一句
   * 是那之后唯一能说「现在可信了」的地方 —— 少了它,`server:start` 上笔记库**永远**
   * 是空的,而且是静默的。
   *
   * 不 await:读 `obsidian.json` 是一次文件读,没人等着它才能开始服务;失败只记一行。
   */
  void ownedBackend.notes.refresh().catch((error: unknown) => {
    log.warn('refreshing note vaults after declaring local trust failed', {}, error)
  })
  // 档位要的那几件(定时任务、电台、首启模型拉取);每一件都在起它的那一行 `own()`。缺省档一件不起。
  const launchServices = startLaunchServices(ownedBackend, profile)
  if (launchServices.length > 0) log.info('launch services started', { launcher: profile.launcher, services: launchServices })
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
        // 缺省档 `server`;桌面档 `backend`(决策 D6:拉起它的人要分得清「我拉的」与别人起的 `server:start`)。
        owner: profile.discoveryOwner,
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
}

void main()
