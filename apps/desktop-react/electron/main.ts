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
import { initializeUserSchedulerTasks } from '@onething/backend/wiring/scheduler/user-tasks.js'
import { createOpenAudienceFactory } from '@onething/backend/server/audience.js'
import { configureLogging, getLogger } from '@onething/backend/wiring/logging/index.js'
import { applyShellNetworkProxySettings, createShellHostPorts } from './host-ports.js'

/**
 * ── 同店同钥:app 名字就是 safeStorage 的钥匙名 ─────────────────────────────
 * macOS 上 safeStorage 的 Keychain 条目叫「<app 名> Safe Storage」。凭证文件
 * (`workspaces/<id>/credentials.json`)是旧桌面以「onething Safe Storage」加密的;
 * 壳的包名 `@onething/desktop-react` 生不出有效条目,Chromium 退到
 * 「Electron Safe Storage」—— 另一把钥匙,解出来永远是垃圾 → 被当空表 →
 * 引擎静默不开 run(08-31 真机:user/message 后无 run/start,正是这一格)。
 * 文件头说的「子进程是另一个 app 身份」对壳本体同样成立:装配进壳里只补了
 * 「谁来解」,名字不同则「用哪把钥匙」仍是错的。必须在 ready 之前设,
 * safeStorage 的 OSCrypt 服务名在浏览器进程初始化时定死。
 *
 * 名字还决定默认 `userData`(appData/<名>)—— 那一半**不能**跟着改:改了就与
 * 旧桌面共用同一个 Chromium profile 目录,两个进程并开会互踩(LevelDB 锁、
 * GPU 缓存)。所以先记下按旧名算出的 userData,改名后原样设回去:
 * 钥匙跟名字走,数据目录留原地,壳此前的 localStorage(阅读档、布局偏好)也不搬家。
 */
const shellUserData = app.getPath('userData')
app.setName('onething')
app.setPath('userData', shellUserData)

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
 *   createOnethingBackend —— 唯一的装配配方,顺序约束都在它里面。宿主能力经
 *                        `host:` 一次交清(A1),由它的第一步 `applyHostPorts`
 *                        接线 —— 壳这边不再有"记得在装配前调"这件事。
 */
async function assembleOwnCore(): Promise<OnethingBackend> {
  // 日志单开一本 `shell.jsonl`:过渡期两个壳可能先后服务同一个 store,混进 app.jsonl
  // 会让那本账在「谁在当家」这件事上说谎。代价见文件末尾的留账①。
  configureLogging({ fileBaseName: 'shell', src: 'main' })

  return createOnethingBackend({
    host: createShellHostPorts(),
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
    // 受众:壳是**单用户宿主**,自装的这只 core 只服务本机这一个人 —— 归属判定
    // 恒真,所以把那句话说出口(批 A §3.1),而不是让过滤代码每条分片重新问一遍。
    const mounting = startEmbeddedOnethingHttpServer(b, {
      owner: 'shell',
      audienceFactory: createOpenAudienceFactory(),
    })
    connectionReady = mounting
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

    /*
     * A3(方案 §2.4「谁起的,谁 `own()`」):这三件从前散在 `shutdownOwnCore`
     * 的 finally 里(HTTP 面)或者根本没有收尾(调度器、MCP)。
     *
     * 登记是**同步的**(就在 listen 那一行之后),而收尾里第一件事是
     * `await connectionReady` —— 挂面是非阻塞起的,dispose 可能比 listen 还早
     * 到(壳起来两秒内 Cmd+Q)。不等它起完就 stop,`stopEmbeddedOnethingHttpServer`
     * 看到的 `current` 还是 null,于是它一句 no-op 就返回,而随后 listen 成功
     * 的那台面留在进程里,连带一份指向它的发现文件。等一下就没这条竞速。
     * `connectionReady` 自带 catch,永不 reject,所以这一等不会翻车。
     */
    b.own(async () => {
      await connectionReady
      await stopEmbeddedOnethingHttpServer().catch(() => {})
      // `close()` 里已经删过一次;这一发兜的是"根本没挂上"的那条路 —— 那时
      // 发现文件也没写过,`rmSync({force:true})` 是 no-op。
      removeHttpDiscovery()
    }, 'embeddedHttpSurface')

    /*
     * C0 R1(方案 `docs/design/backend-principal-and-mcp-lifecycle-2026-09.md` §2.2):
     * 从动态 import 的 `.then()` 里挪出来,改成**同步登记**。
     *
     * `initializeUserSchedulerTasks()` 本来就是同步的(它读一次盘、往调度器里注册,
     * 返回 stop);包在动态 import 里没有任何理由 —— 这个文件顶上已经静态 import 了
     * `@onething/backend/backend.js`,整棵装配层早就在包里了,晚一拍加载省不下东西,
     * 只多出一段"起完了但还没登记收尾"的窗口。壳起来两秒内 Cmd+Q 正好落在里面。
     *
     * `own()` 的守卫(同批)兜的是**兜不干净的那些**(MCP 那处是真异步);能同步的
     * 就别靠守卫兜 —— 守卫让漏登记变得安全,不代表漏登记本身该留着。
     */
    b.own(initializeUserSchedulerTasks(), 'userSchedulerTasks')

    /*
     * C1(方案 `docs/design/backend-principal-and-mcp-lifecycle-2026-09.md` §2.2):
     * 壳这边只剩"**何时** start"这一句。
     *
     * 从前这里是 `initializeShellMCP()`(自己 initialize manager、自己再配一遍
     * `configureMCPCapabilitiesChangedHandler`、自己 `registerMCPTools`),收尾登记排在
     * 它的 `.then()` 里 —— C0 的 `own()` 守卫让那条路不再丢 disposer,但"起完了才登记"
     * 这个形状本身还在。现在收尾在装配时就登记好了(`backend.mcp` 构造即 `own`),
     * 早退时 `dispose()` 会等这趟 start 落地再关,所以这里不再 `.then(own)`。
     *
     * 失败仍然不阻塞壳:MCP 起不来不该让窗口起不来。
     */
    void b.mcp.start().catch((error: unknown) => {
      log.error('subsystem startup failed', { subsystem: 'mcp', blocking: false }, error)
    })
  }

  void refreshModelsOnFirstStartup().catch((error: unknown) => {
    log.error('subsystem startup failed', { subsystem: 'model-registry', blocking: false }, error)
  })
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

/**
 * 无系统标题栏(09-01 用户拍板:「我们不要 macOS 自己的刘海,我们自己设计刘海,
 * 让我们的内容直接占满屏幕」)。
 *
 * `hiddenInset` 而不是 `hidden`:红绿灯**留在窗上**,只是往里挪了一档 —— 绿灯是
 * macOS 唯一的原生全屏入口,`hidden` 连它一起收掉,用户就再没有「真全屏」这条路。
 * `trafficLightPosition` 把那三颗灯摆进**顶栏那一行**(09-01 用户看真机后的裁定:
 * 「header 与红绿灯放同一行,红绿灯稍往下来点」—— 第一版给灯单开了一条 28px 空带):
 *   y = (--topbar-h 44 − 灯高 12) / 2 = 16   ← 「稍往下来点」就是这一记居中
 *   x = 16                                    ← 让位宽 80 的起点
 * **这两个数与 `--topbar-h` / `--titlebar-traffic-w` 是同一件事的两半**(算式写在
 * tokens.css 的「红绿灯让位」节),改一处必须改另一处 —— 而且歪了没有任何报错,
 * 只会看见标题压在灯上。
 *
 * 只在 macOS 上摘。Windows / Linux 上 `hiddenInset` 会退化成 `hidden` = 连
 * 最小化/关闭都没有的无边框窗 —— 那不是「自绘刘海」,那是把窗关不掉。
 * 那两个平台照旧用系统边框,壳里那条顶带在它们上面就是一条没人拖的空带
 * (无害;真要在那边自绘,得连窗控件一起画,属另一批)。
 */
/**
 * 全屏态推送的通道名。**主进程与 preload 共用这一处常量**(preload 从这里 import
 * 不到 —— 它是另一个打包目标,所以那边写的是同一个字面量并注明指认关系)。
 */
const HOST_FULLSCREEN_CHANNEL = 'host:fullscreen'

const FRAMELESS_ON_MAC =
  process.platform === 'darwin'
    ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 16 } }
    : {}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#111111',
    ...FRAMELESS_ON_MAC,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  window.once('ready-to-show', () => window.show())

  /*
   * ── 全屏态要推给渲染层(09-01 自查走查:全屏下红绿灯没了,顶栏左边那 80px
   *    让位空块还杵着)────────────────────────────────────────────────────
   * 为什么非得从主进程推:**渲染层自己看不见 macOS 的原生全屏**。真机实测三个
   * 候选信号在窗口态 / 全屏态下逐字相同 —— `matchMedia('(display-mode: fullscreen)')`
   * 恒 false(它一直报 `browser`)、`document.fullscreenElement` 恒 null;唯一变的
   * 是 `innerHeight` 860 → 1084,而那个数拿来当判据是错的(用户手动把窗口拉到
   * 屏幕可用高度一样会命中)。所以这条状态只有窗口自己知道,必须由它说。
   *
   * `did-finish-load` 那一发是**首帧对齐**:窗口可能在页面加载完成之前就已经是
   * 全屏(重新加载、dev 热更、从全屏态恢复),少了它渲染层会一直以为自己不在全屏。
   */
  const pushFullScreen = () => {
    if (window.isDestroyed()) return
    window.webContents.send(HOST_FULLSCREEN_CHANNEL, window.isFullScreen())
  }
  window.on('enter-full-screen', pushFullScreen)
  window.on('leave-full-screen', pushFullScreen)
  window.webContents.on('did-finish-load', pushFullScreen)

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

/**
 * 收尾 = **一行**。
 *
 * A3:HTTP 面与发现文件从这里的 `finally` 搬进了 `startPostWindowServices` 的
 * `b.own(...)`(方案 §2.4)。于是清单只有一份,住在起的那一行旁边;这里再也
 * 没有"壳自己记得关什么"这件事 —— 顺序(宿主起的三件 → 引擎 → 落盘)由登记
 * 逆序给出,不再由这个函数复述。
 */
async function shutdownOwnCore(): Promise<void> {
  const b = backend
  backend = undefined
  if (!b) return
  // 它跑的是装配途中与 post-window `own()` 登记下来的清单,逆序、每步单独 try/catch。
  await b.dispose()
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
