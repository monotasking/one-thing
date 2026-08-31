/**
 * React 壳的 main 进程。
 *
 * ── A1(2026-08-31):从「薄壳 + 子进程 core」换成「壳自己就是 core」 ────────
 * D0 那版是薄壳:没有活的 core 就 spawn `dist/server/main.js`。那条路有一个**结构性
 * 的**缺陷,不是配置问题 —— 子进程是另一个 app 身份,safeStorage 的密文它解不开,
 * 于是用户明明登录过的 provider 在新壳里一个都读不出来。凭证解密只有一个口
 * (`configureAuthHost`),而那个口必须由**拿着 Electron app 身份的进程**注入。
 * 所以壳自己装配 backend:与旧 Vue 桌面同一份 `createOnethingBackend` 配方。
 *
 * 它现在做五件事:
 *
 *  1. **发现**这个 store 正在跑的 core(`<store>/run/http.json`)。有活的就挂它 ——
 *     旧 Vue 桌面(owner `desktop`)、别人起的 `server:start`(owner `server`)、
 *     另一个壳(owner `shell`)都一样。这正是 A 期「一个 core 任何 UI」的目标:
 *     两个 UI 订同一条事件流,而不是两台引擎各写各的。
 *  2. 没有活的 core 时**自己当 core**:configureLogging → 宿主端口注入 →
 *     `createOnethingBackend` → 开窗 → 非阻塞挂 HTTP/SSE 面(发现文件 owner=`shell`)。
 *  3. 开窗口。
 *  4. 一条 IPC:`host:connection` → `{ baseUrl, token }`。发现文件是 0600 的秘密,
 *     渲染层不许自己读盘 —— 挂别人的面和挂自己的面,渲染层看到的形状逐字相同。
 *  5. 退出时按 引擎 → HTTP 面 → 发现文件 的顺序收尾。
 *
 * 它**仍然不**做的事(边界,别越):不取 StoreLock、不注册第二张 IPC 表。
 * 不取锁是 08-24 的拍板(「store 不要锁」),与 apps/server 同口径:单写者靠发现
 * 文件让位,不靠互斥量。
 * ──────────────────────────────────────────────────────────────────────
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  createOnethingBackend,
  type OnethingBackend,
} from '@onething/backend/backend.js'
import {
  startEmbeddedOnethingHttpServer,
  stopEmbeddedOnethingHttpServer,
} from '@onething/backend/server/embed.js'
import { removeHttpDiscovery } from '@onething/backend/server/discovery.js'
import { configureLogging, getLogger } from '@onething/backend/wiring/logging/index.js'
import { applyShellNetworkProxySettings, configureShellHostPorts } from './host-ports.js'

type HttpDiscoveryRecord = {
  port: number
  host: string
  token?: string
  pid: number
  startedAt?: number
  owner: 'desktop' | 'server' | 'shell'
}

/** `host:connection` 的回执:成功给基址与 token,失败给一句人话(启发式⑨)。 */
type HostConnectionResult =
  | { ok: true; baseUrl: string; token?: string }
  | { ok: false; error: string }

/** 打包后是 `.../dist-electron/main.cjs`,dev 时同路径 —— 两跳到 apps/。 */
const appRoot = path.resolve(__dirname, '..')

/**
 * store 根。与 `packages/onething-runtime/src/storage/paths.ts` 的
 * `getOnethingStorePath()` **同语义**(env 优先,否则 `~/.onething`)。这一段发生在
 * `configureLogging` 之前(要先知道 store 才知道日志落哪),所以自己 resolve 一次。
 */
function resolveStoreRoot(): string {
  return process.env.ONETHING_STORE_PATH || path.join(os.homedir(), '.onething')
}

function discoveryPath(): string {
  return path.join(resolveStoreRoot(), 'run', 'http.json')
}

/** 读发现文件。不存在 / 坏了 / 形状不对 → undefined(永不抛)。 */
function readDiscovery(): HttpDiscoveryRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(discoveryPath(), 'utf-8'))
    if (!parsed || typeof parsed !== 'object') return undefined
    const record = parsed as Partial<HttpDiscoveryRecord>
    if (typeof record.port !== 'number' || !Number.isFinite(record.port) || record.port <= 0) return undefined
    if (typeof record.host !== 'string' || !record.host) return undefined
    if (typeof record.pid !== 'number' || !Number.isFinite(record.pid)) return undefined
    if (record.owner !== 'desktop' && record.owner !== 'server' && record.owner !== 'shell') return undefined
    return {
      port: record.port,
      host: record.host,
      token: typeof record.token === 'string' && record.token ? record.token : undefined,
      pid: record.pid,
      startedAt: typeof record.startedAt === 'number' ? record.startedAt : 0,
      owner: record.owner,
    }
  } catch {
    return undefined
  }
}

function portConnects(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host, port })
    const settle = (value: boolean) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

/**
 * 「文件存在 ≠ 活着」。判定两段:pid 还在 **且** 端口真能连上 —— 只看 pid 会被
 * pid 复用骗,只看端口会被别的程序占用同一端口骗。与 `backend/server/discovery.ts`
 * 的 `isHttpDiscoveryAlive` 同一条口径。
 */
async function isAlive(record: HttpDiscoveryRecord): Promise<boolean> {
  try {
    process.kill(record.pid, 0)
  } catch {
    return false
  }
  return portConnects(record.host, record.port)
}

/**
 * SSE / 命令的投递目标。EventBus 观察者(HTTP 面)自己盯总线,所以这里是个空壳 ——
 * 但**必须有**:引擎没有 commandTarget 时 `SEND_MESSAGE` 等四条命令直接 return
 * (core-stream-engine.ts:540-566),表现是「发消息毫无反应、也不报错」。
 * 形状照 `backend/server/runtime.ts` 的 `ServerNoopSender` 抄:EventEmitter +
 * `isDestroyed()` + `send()`,少一件 `engine.bind()` 就抛。
 */
class ShellNoopSender extends EventEmitter {
  isDestroyed(): boolean {
    return false
  }
  send(): void {
    /* HTTP/SSE 订阅方直接观察总线与 stream channel。 */
  }
}

let backend: OnethingBackend | undefined
/**
 * `host:connection` 的答案。是 Promise 而不是值:内嵌那条路上 HTTP 面是**开窗之后**
 * 才起来的(非阻塞,不让一次 listen 拖住第一帧),而渲染层第一件事就是问这条。
 * 让 handler await 这个 Promise,渲染层的契约(返回一个 Promise)一个字不用改。
 */
let connectionReady: Promise<HostConnectionResult> | undefined

function connectionOf(record: { host: string; port: number; token?: string }): HostConnectionResult {
  return { ok: true, baseUrl: `http://${record.host}:${record.port}`, token: record.token }
}

/**
 * 自己当 core。顺序不是随手排的:
 *   configureLogging  —— 必须最早。它之后的每一条记录才落进 `<store>/log/shell.jsonl`;
 *                        在它之前抛的错只留在内存环里。
 *   configureShellHostPorts —— 必须在装配之前。sandbox / store-path 两个端口在装配
 *                        过程中就会被读到。
 *   createOnethingBackend —— 唯一的装配配方,顺序约束都在它里面。
 */
async function assembleOwnCore(): Promise<OnethingBackend> {
  // 日志单开一本 `shell.jsonl`:过渡期两个壳可能先后服务同一个 store,混进 app.jsonl
  // 会让那本账在「谁在当家」这件事上说谎。代价见文件末尾的留账①。
  configureLogging({ fileBaseName: 'shell', src: 'main' })
  configureShellHostPorts()

  return createOnethingBackend({
    toolRegistry: 'full',
    promptVersion: true,
    // 四颗必落件之二:agent-dm(协作房间)的开关。不开 = 房间入口闸拒流,
    // 表现是协作会话发不出话。
    collab: true,
    sessionSkills: true,
    sender: new ShellNoopSender() as never,
    hooks: {
      afterSettings: async () => {
        await applyShellNetworkProxySettings()
      },
    },
  })
}

/**
 * 开窗之后才跑的几件事,全部**非阻塞**:任何一件失败都不该让壳起不来。
 * 与 `apps/electron/src/app/main-process.ts:294-329` 同一张单子,减去这个壳还没有的
 * 那几件(插件 / 网关 / ACP / 语音托盘)。skills 由 `sessionSkills: true` 顶掉。
 */
function startPostWindowServices(): void {
  const log = getLogger('shell.boot')

  const b = backend
  if (b) {
    // HTTP/SSE 面:owner=`shell` 写进发现文件(A1 拍板)。挂不上不阻塞壳 ——
    // 但渲染层的数据面就是这条,所以失败要如实反映到 `host:connection`。
    connectionReady = startEmbeddedOnethingHttpServer(b, { owner: 'shell' })
      .then(embedded => {
        log.info('embedded core http surface listening', { url: embedded.url })
        return connectionOf(embedded)
      })
      .catch((error: unknown) => {
        log.error('embedded HTTP surface mount failed', { subsystem: 'core-http' }, error)
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        }
      })
  }

  void import('@onething/backend/wiring/scheduler/user-tasks.js')
    .then(({ initializeUserSchedulerTasks }) => initializeUserSchedulerTasks())
    .catch((error: unknown) => {
      log.error('subsystem startup failed', { subsystem: 'scheduler', blocking: false }, error)
    })

  void initializeShellMCP().catch((error: unknown) => {
    log.error('subsystem startup failed', { subsystem: 'mcp', blocking: false }, error)
  })

  void refreshModelsOnFirstStartup().catch((error: unknown) => {
    log.error('subsystem startup failed', { subsystem: 'model-registry', blocking: false }, error)
  })
}

/**
 * MCP 生命周期。形状照 `apps/electron/src/main/ipc/mcp.ts` 抄(那是 `@main` 的内部
 * 路径,跨 app import 不到)。传输面早已是 `mcpRouter`,这里只有「起一台 manager
 * 并把工具目录建出来」这一件进程内单例的事。
 */
async function initializeShellMCP(): Promise<void> {
  const [{ DEFAULT_MCP_SETTINGS }, mcp, capabilities, settings] = await Promise.all([
    import('@onething/core/mcp'),
    import('@onething/runtime/mcp/index.wiring'),
    import('@onething/runtime/mcp/capabilities-changed'),
    import('@onething/backend/stores/settings.js'),
  ])
  capabilities.configureMCPCapabilitiesChangedHandler(() => {
    void mcp.registerMCPTools()
  })
  await mcp.MCPManager.initialize(settings.getSettings().mcp || DEFAULT_MCP_SETTINGS)
  await mcp.registerMCPTools()
}

/** 首次启动从 models.dev 拉一次模型目录(已有目录就跳过)。 */
async function refreshModelsOnFirstStartup(): Promise<void> {
  const { getSettings } = await import('@onething/backend/stores/settings.js')
  const providers = getSettings()?.ai?.providers
  if (!providers) return
  const hasModels = Object.values(providers).some(
    config => Object.keys((config as { models?: object })?.models ?? {}).length > 0,
  )
  if (hasModels) return
  const { refreshAllProviders } = await import('@onething/backend/wiring/providers/model-registry.js')
  await refreshAllProviders()
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#111111',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  window.once('ready-to-show', () => window.show())

  const devServerUrl = process.env.ONETHING_REACT_DEV_SERVER_URL
  if (devServerUrl) void window.loadURL(devServerUrl)
  else void window.loadFile(path.join(appRoot, 'dist/index.html'))
  return window
}

// 渲染层唯一的宿主口。发现文件是 0600 的秘密,渲染层不许自己读盘。
ipcMain.handle('host:connection', async (): Promise<HostConnectionResult> => (
  connectionReady ? connectionReady : { ok: false, error: 'core 尚未连接' }
))

void app.whenReady().then(async () => {
  const existing = readDiscovery()
  if (existing && (await isAlive(existing))) {
    /*
     * 有活的 core → 挂它,一个字节不动它(S3 拍板,2026-08-31)。
     *
     * **这里刻意没有做的事**:让位是单向的 —— 壳在当家时如果用户再启动旧 Vue 桌面,
     * 那个桌面**不会**读这份记录后退让(`apps/electron` 今天没有让位判定,而 S3 拍板
     * 这一批不动它)。已知后果:两个进程各自装配一份 backend 写同一个 store,
     * 就是 08-19 那条「两个 LRU + 两条节流写队列」的双写风险。
     * 记在这里而不是文档里,是因为修它的人第一眼会看的就是这一段。
     */
    connectionReady = Promise.resolve(connectionOf(existing))
    createWindow()
  } else {
    try {
      backend = await assembleOwnCore()
    } catch (error) {
      // 装配失败也要开窗:错误交给渲染层显示,比静默白屏强(启发式⑨)。
      connectionReady = Promise.resolve({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    createWindow()
    if (backend) startPostWindowServices()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/** 收尾。顺序:引擎(冲盘)→ HTTP 面 → 发现文件。 */
async function shutdownOwnCore(): Promise<void> {
  const b = backend
  backend = undefined
  if (!b) return
  try {
    await b.shutdown()
  } finally {
    await stopEmbeddedOnethingHttpServer().catch(() => {})
    removeHttpDiscovery()
  }
}

// D0 是单窗薄壳:窗关了就退(mac 上的常驻托盘行为留给 P4 的窗口系批)。
app.on('window-all-closed', () => app.quit())

let quitting = false
app.on('will-quit', event => {
  if (quitting || !backend) return
  quitting = true
  // `will-quit` 不等 Promise,所以先拦一次、收完尾再真退。
  event.preventDefault()
  void shutdownOwnCore().finally(() => app.exit(0))
})

/*
 * dev 重启走的是 SIGTERM/SIGINT,`will-quit` 那条链根本不触发。发现文件是
 * 「这个 store 由我在服务」的宣告 —— 留着它下一次启动就得靠探活才敢无视,
 * 所以同步段至少要把它删掉。形状照 main-process.ts:380-389。
 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (backend) removeHttpDiscovery()
    process.exit(signal === 'SIGINT' ? 130 : 143)
  })
}

/*
 * ── 本批留账 ────────────────────────────────────────────────────────────
 * ① `shell.jsonl` 不在 `LOG_DIR_POLICY.families` 里(那张表在
 *    packages/onething-runtime,本批边界外)。后果:归档只被 janitor 报成
 *    `unknown`,永不删。活账本本身照常轮转。加一行即可,留给下一批。
 * ② 内建 skills 目录按 cwd 解析成 `apps/desktop-react/resources/skills`(不存在),
 *    于是自演化那颗默认关闭的 builtin skill 在这个壳里加载不到。旧壳靠
 *    `configureSkillsEnvironmentHost` 指路;这个壳还没注入那个端口。
 * ③ 让位是单向的(见 whenReady 里那段注释)—— S3 拍板不动 apps/electron。
 * ──────────────────────────────────────────────────────────────────────
 */
