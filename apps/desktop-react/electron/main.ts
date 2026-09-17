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
 * ── 启动次序(2026-09-15 改过一次,这里写的是**今天**的真话)──────────────
 * 顺序就是下面这个顺序,而它的要点是**开窗排在装配之前**:
 *
 *  1. `app.whenReady()` → 装应用菜单(必须在第一扇窗之前)。
 *  2. **开窗**。页面从这一刻开始加载(dev 下 873 个模块过 vite,冷 2.4–5s)。
 *  3. **发现**这个 store 正在跑的 core(`<store>/run/http.json`,探活最多 500ms)。
 *     有活的就挂它 —— 别人起的 `server:start`(owner `server`)、另一个壳
 *     (owner `shell`)都一样。这正是 A 期「一个 core 任何 UI」的目标:两个 UI 订
 *     同一条事件流,而不是两台引擎各写各的。
 *  4. 没有活的 core 时**自己当 core**:`createOnethingBackend`(真店 ≈1.7s:498 会话、
 *     72 skills、3 个 MCP)→ 非阻塞挂 HTTP/SSE 面(发现文件 owner=`shell`)+ 调度器
 *     + MCP + 内嵌浏览器。**这一段与第 2 步的页面加载是并行的** —— 它们本来就互不
 *     依赖(见下一条),从前排成一条队纯粹是代码次序造成的。
 *  5. 一条 IPC:`host:connection` → `{ baseUrl, token }`。发现文件是 0600 的秘密,
 *     渲染层不许自己读盘 —— 挂别人的面和挂自己的面,渲染层看到的形状逐字相同。
 *     **它是一个承诺,不是一个值**:窗比答案先出现,所以这条口在模块求值那一刻就
 *     持有一个待定的 promise(`./host-connection.ts`),渲染层
 *     `await host.getConnection()` 等的是答案、不是开窗的次序。
 *  6. 退出由 Backend 的资源阶段协调:停止接入 → 排空 → 保存 → 摘发现文件。
 *     装配途中被 Cmd+Q 截住时,收尾先等 `ownCoreAssembly` 落地再 dispose。
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
  getEmbeddedOnethingHttpServer,
} from '@onething/backend/server/embed.js'
import { removeHttpDiscovery } from '@onething/backend/server/discovery.js'
import { initializeUserSchedulerTasks } from '@onething/backend/wiring/scheduler/user-tasks.js'
import { getLogger } from '@onething/backend/wiring/logging/index.js'
import { installAppMenu } from './app-menu-install.js'
import { applyShellNetworkProxySettings, createShellHostPorts } from './host-ports.js'
import { createDesktopShutdownRequest } from './shutdown.js'
// 「连接」是开窗之前就存在的承诺(整段判词在那只文件的文件头)。
import { HostConnectionGate, type HostConnectionResult } from './host-connection.js'
// T2:页面重载时把「消费者走了」当场说给终端服务听(判词在那只文件的文件头)。
import { installTerminalReloadDetach } from './terminal-reload.js'
/*
 * ── 内嵌浏览器(B2 接线;整块的判词在 `electron/browser/index.ts` 的文件头)──
 * 三段,次序是硬的:①两句旗子必须在 app `ready` 之前(`appendSwitch` 之后
 * Chromium 才读命令行);①′ 挂 HTTP 面那一行把真开着的 CDP 口补进发现文件;
 * ②窗口 + 装配之后才装得起 `installBrowserHost`(要 `window` 挂视图、要装配完
 * 的 `backend.resources`)。
 */
import { installBrowserHost } from './browser/index.js'
import { applyChromiumFlags } from './browser/user-agent.js'
import { applyCdpFlag, readCdpLaunchFlag } from './browser/cdp-flag.js'
import { cdpDiscoveryExtras } from './browser/cdp-settings.js'

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

/*
 * **内嵌浏览器的两句启动旗**(B2 ①,`electron/browser/index.ts` 文件头逐字照做)。
 *
 * 它们必须在 app `ready` **之前** —— `appendSwitch` 之后 Chromium 才读命令行。
 * `applyChromiumFlags` 关掉 FedCm(登谷歌那条配方的四件之一);`applyCdpFlag` 按
 * `<store>/run/cdp.json` 那张旗文件决定开不开 `--remote-debugging-port`
 * (**判据是旗文件 + argv,不是设置** —— 设置改了要重启才生效,按设置写等于说谎;
 * argv 里已经带着口时不再 append,否则真机门的口会被产品旗子顶掉,判词在
 * `browser/cdp-flag.ts` 的文件头)。
 */
applyChromiumFlags(app)
applyCdpFlag(app, readCdpLaunchFlag(resolveStoreRoot()))

type HttpDiscoveryRecord = {
  port: number
  host: string
  token?: string
  pid: number
  startedAt?: number
  owner: 'desktop' | 'server' | 'shell'
}

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
let ownCoreAssembly: Promise<OnethingBackend> | undefined
/**
 * 这扇窗(B2 ②)。**内嵌浏览器的视图要挂进它的 `contentView`**,推送也发给它的
 * `webContents` —— 而 `startPostWindowServices()` 今天不收参数(它跑在
 * `createWindow()` 之后),所以窗子由 `createWindow` 记在这一格上。
 *
 * 单窗:`window-all-closed` 就退,`activate` 重开时会重新写它。多窗是 P4 窗口系
 * 那一批的事(`NativeViewLayout` 按窗 id 分账的口子已经留着,方案 §8 留账)。
 */
let shellWindow: BrowserWindow | undefined
let quitting = false
/**
 * `host:connection` 的答案。**模块级 `const`,不是 `let`** —— 一个进程只服务一个
 * store、只连一台 core,那是这个宿主的结构性事实(与 `installAppMenu` 那张进程级
 * 单槽同一条判据),不是一格会被重新赋值的状态;而且 `ipcMain.handle` 在模块求值
 * 那一刻就注册了,handler 闭包必须现在就抓得到它。
 *
 * 为什么非得是一个**先于窗口存在**的承诺:启动次序(2026-09-15)把开窗提到了装配
 * 之前,于是渲染层会赶在装配落地之前问这条。整段判词在 `./host-connection.ts`。
 */
const connection = new HostConnectionGate()

function connectionOf(record: { host: string; port: number; token?: string }): HostConnectionResult {
  return { ok: true, baseUrl: `http://${record.host}:${record.port}`, token: record.token }
}

/**
 * 自己当 core。顺序不是随手排的:
 *   createOnethingBackend —— 唯一的装配配方,顺序约束都在它里面。宿主能力经
 *                        `host:` 一次交清(A1),由它的第一步 `applyHostPorts`
 *                        接线 —— 壳这边不再有"记得在装配前调"这件事。
 *                        **不给 `owner`** = 这个宿主不取 store 锁(见文件头)。
 */
async function assembleOwnCore(): Promise<OnethingBackend> {
  // 日志单开一本 `shell.jsonl`:过渡期两个壳可能先后服务同一个 store,混进 app.jsonl
  // 会让那本账在「谁在当家」这件事上说谎。代价见文件末尾的留账①。
  return createOnethingBackend({
    logging: { fileBaseName: 'shell', src: 'main' },
    host: createShellHostPorts(),
    toolRegistry: 'full',
    promptVersion: true,
    // 四颗必落件之二:agent-dm(协作房间)的开关。不开 = 房间入口闸拒流,
    // 表现是协作会话发不出话。
    collab: true,
    sessionSkills: true,
    // 宠物宿主(`docs/design/pet-system-2026-09.md` §9.1):登记 `pet:`、订资源事件里的时刻。
    pets: true,
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
      /*
       * B2′:把这个进程**真的开着**的 CDP 口补进 `run/http.json`,别的客户端
       * (chrome-devtools-mcp 的配置、门脚本)就不必猜口。判据是**命令行**不是
       * 设置;没开 → `undefined` → `cdp` 那个键根本不出现在文件里。
       */
      discoveryExtras: cdpDiscoveryExtras(app.commandLine),
    })
    /*
     * 挂面的结局有两种,**两种都要落到 gate 上**:listen 成功给基址,listen 抛了
     * 给那句原话。少了后者渲染层就永远停在 `await getConnection()` 上 —— 一扇画着
     * 空白的窗、日志里一条错、没有任何人把这两件事连起来。
     *
     * 为什么保留这一格 `mounted` 而不让收尾直接等 gate:下面那两条收尾等的是
     * **「listen 这件事有结果了没有」**(判词在它们自己那一段),而 gate 等的是
     * 「连接答案有没有」—— 今天这条路上两者同源,但 gate 是可以被别的分支先答掉的
     * (借用活 core / 装配失败),那时收尾就会提前放行。等哪一件,写哪一件。
     */
    const mounted: Promise<HostConnectionResult> = mounting
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
    void mounted.then(result => connection.resolve(result))

    /*
     * A3(方案 §2.4「谁起的,谁 `own()`」):这三件从前散在 `shutdownOwnCore`
     * 的 finally 里(HTTP 面)或者根本没有收尾(调度器、MCP)。
     *
     * 登记是**同步的**(就在 listen 那一行之后),而收尾里第一件事是
     * `await mounted` —— 挂面是非阻塞起的,dispose 可能比 listen 还早
     * 到(壳起来两秒内 Cmd+Q)。不等它起完就 stop,`stopEmbeddedOnethingHttpServer`
     * 看到的 `current` 还是 null,于是它一句 no-op 就返回,而随后 listen 成功
     * 的那台面留在进程里,连带一份指向它的发现文件。等一下就没这条竞速。
     * `mounted` 自带 catch,永不 reject,所以这一等不会翻车。
     */
    b.own(async () => {
      await mounted
      getEmbeddedOnethingHttpServer()?.stopAccepting()
    }, 'embeddedHttpIngress', 'quiesce')
    b.own(async () => {
      await mounted
      await stopEmbeddedOnethingHttpServer()
    }, 'embeddedHttpSurface')
    b.own(() => removeHttpDiscovery({ lease: b.storeLease }), 'httpDiscovery', 'endpoints')

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
    b.own(initializeUserSchedulerTasks(), 'userSchedulerTasks', 'quiesce')

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

    /*
     * **内嵌浏览器**(B2 ②;整块的判词在 `electron/browser/index.ts` 的文件头)。
     *
     * 次序是硬的:要 `window`(视图得挂进 `win.contentView`)、要**装配完**的
     * backend(`backend.resources` 在装配之前抛 `BackendNotAssembledError`)——
     * 所以它在这里,不在 `hooks.afterTools`(那一拍窗口还没有)。
     *
     * `installBrowserHost` 自己**不** `own()`:它交回一个 disposer,由起它的这一行
     * `own()`(「谁起的谁 own」那条纪律的落点是起它的那一行,与上面
     * `embeddedHttpSurface` / `userSchedulerTasks` 同形)。
     *
     * 装不起来不阻塞壳:没有内嵌浏览器不该让窗口起不来 —— `browser:` 不 mount,
     * 于是壳与 AI 两侧都诚实地答「这台上没有它」(§3.2「未挂」那一行)。
     */
    if (shellWindow) {
      try {
        const browserHost = installBrowserHost({
          window: shellWindow,
          backend: b,
          storePath: resolveStoreRoot(),
        })
        b.own(() => browserHost.dispose(), 'browserHost')
      } catch (error: unknown) {
        log.error('subsystem startup failed', { subsystem: 'browser', blocking: false }, error)
      }
    }
    const refreshController = new AbortController()
    b.own(() => refreshController.abort(), 'modelRegistryRefresh', 'quiesce')
    void b.runTask('desktop:model-registry', () => refreshModelsOnFirstStartup(refreshController.signal)).catch((error: unknown) => {
      if (refreshController.signal.aborted && (error === refreshController.signal.reason || (error as Error)?.name === 'AbortError')) {
        log.debug('model registry refresh cancelled during shutdown')
      } else log.error('subsystem startup failed', { subsystem: 'model-registry', blocking: false }, error)
    })
  }
}

/** 首次启动从 models.dev 拉一次模型目录(已有目录就跳过)。 */
async function refreshModelsOnFirstStartup(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const { getSettings } = await import('@onething/backend/stores/settings.js')
  signal.throwIfAborted()
  const providers = getSettings()?.ai?.providers
  if (!providers) return
  const hasModels = Object.values(providers).some(
    config => Object.keys((config as { models?: object })?.models ?? {}).length > 0,
  )
  if (hasModels) return
  const { refreshAllProviders } = await import('@onething/backend/wiring/providers/model-registry.js')
  signal.throwIfAborted()
  await refreshAllProviders({ signal })
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

/**
 * ── 门专用的两个开关(09-04 S4)────────────────────────────────────────────────
 *
 * 两个都**只有真机门会传**,产品路径上一个字都读不到它们(未设 = 今天的行为逐字不变)。
 * 立它们的直接起因是一条纪律:真机门不许抢用户的机器 —— 用户正在这台机器上干活,
 * 而门每跑一趟就要拉起一扇窗、抢一次前台、在 Dock 里冒一个图标。
 *
 * · `ONETHING_GATE_HEADLESS=1` —— **窗子起在离屏**:不 `show()`、不进 Dock。
 *   页面照样渲染、照样跑 rAF 与布局(Electron 的隐藏窗只是不合成到屏幕上),
 *   焦点由门自己用 CDP `Emulation.setFocusEmulationEnabled(true)` 补 ——
 *   于是 `:focus-visible`、`document.activeElement`、`focusin/focusout` 全部照常,
 *   而**这正是响应链那几道门唯一要量的东西**。离屏档与前台档的读数一致性由
 *   `gate:focus` 自己证(S4 拿 HEAD 在两档各跑一趟,118 断言逐条对上)。
 *
 * · `ONETHING_GATE_DIST=<目录>` —— **换一份渲染层产物**(相对 appRoot 或绝对路径;
 *   缺省 `dist`)。两个门吃它:
 *
 *   ① `gate:focus --strict` 传 `dist-strict`。S3 结案时留了一笔账:「gate:focus 跑
 *      生产构建照不出此病,只有 dev 壳真机读数照得出,让门起 dev 壳待拍」。起 dev 壳
 *      是错的路(要多一台 vite、还要占 5175 这个用户自己在用的口)。**09-04 S4 施工时
 *      先走错过一次,记在这里**:第一版想在同一份 dist 上挂一个查询串开关,让
 *      `src/main.tsx` 据此决定包不包 `<StrictMode>`。它办不到 —— `<StrictMode>` 在
 *      **production 版的 react-dom 里是空操作**,模拟卸载→再挂载那一串检查整个长在
 *      development 版里。所以这件事不是「加一个开关」,是**换一份 react-dom**,而那
 *      只有构建产物这一条路:`npm run app:build:strict` 出一份 `dist-strict/`
 *      (`vite build --mode development`,**仍然是构建产物、不是 dev server**)。
 *      缺省那份 `dist/` 一个字节不动,所以 `gate:focus` 的 118 断言基线没有变。
 *
 *   ② **跨版本性能对照**:把某个历史提交的 `dist/` 指过来,用**今天这份主进程**
 *      (也就是带离屏开关的这一份)去装它。少了这一格,量历史基线就得起历史版本的
 *      主进程 —— 那些版本没有离屏开关,窗子会弹到用户脸上。
 */
const GATE_HEADLESS = process.env.ONETHING_GATE_HEADLESS === '1'
/**
 * · `ONETHING_GATE_OFFSCREEN=1` —— **窗子摆到屏外,不抢焦点地显示出来**
 *   (B2 新增;它是上面那一档的**细化**,两个开关一起传)。
 *
 *   立它的理由是 B0-④ 量出来的一条真账,不是口味:`show: false` 的窗整扇被
 *   Chromium 当成隐藏,**合成器按 1Hz 节流**(藏后心跳中位 1000ms,放出即恢复)。
 *   凡是与「页面上的时间」有关的量项 —— 一页网页加载完没有、标题落下来没有、
 *   遮挡快照刷没刷新 —— 在那一档下量到的都是节流之后的数,而那不是产品的行为。
 *
 *   所以 `gate:browser` 要一扇**真的在合成、但人看不见也抢不着焦点**的窗,
 *   两个开关各管一半:`HEADLESS` 管「别自己 `show()`」(上面那一行原样不动,
 *   顺带也不冒 Dock 图标),`OFFSCREEN` 管「摆到屏外,再 `showInactive()`」——
 *   显示但**不激活**,而那正是「真机门不许抢用户的机器」那条纪律要的。
 *   macOS 会把窗的 y 钳进可见区(实测钳到 33),x 不钳 —— 于是它落在主屏右侧
 *   之外,前台应用一格都不动。
 *
 *   只传 `OFFSCREEN` 不传 `HEADLESS` 也说得通(窗会先 `show()` 再挪到屏外,
 *   中间抢一下焦点),但那不是门该干的事,所以门两个一起传。
 */
const GATE_OFFSCREEN = process.env.ONETHING_GATE_OFFSCREEN === '1'
const GATE_DIST = process.env.ONETHING_GATE_DIST || 'dist'

/*
 * dev 档开页前先清这扇窗所在 session 的 HTTP 缓存(2026-09-13 真机病历:启动后一片空白)。
 *
 * vite 把 `node_modules/.vite/deps` 里的预构建 chunk 标成 immutable,靠 `?v=<browserHash>`
 * 换代;但那个哈希只算 lockfile + 配置 + 依赖名单,**不算 chunk 内容**。deps 目录同哈希下
 * 整套重建(chunk 名全换)时,Chromium 缓存照旧把旧 `react.js` 与旧 chunk 供出来、不问
 * 服务器,而被淘汰的那几份从网络拿到的是新 chunk —— 两份 React 并存,首屏就
 * `Cannot read properties of null (reading 'useCallback')`,错误边界渲空。缓存淘汰是随机的,
 * 所以重建后不一定当场炸。dev 下所有资源都来自本机 vite,清缓存零代价;**只清默认
 * session**,内嵌浏览器的 `persist:browser-*` 分区不碰(那边缓存着用户登录页,是产品数据)。
 * 清不掉也照开页 —— 缓存是加速件,不是前提。
 */
async function loadDevServer(window: BrowserWindow, devServerUrl: string): Promise<void> {
  try {
    await window.webContents.session.clearCache()
  } catch (error) {
    getLogger('shell.boot').warn('dev http cache clear failed; loading anyway', {}, error)
  }
  await window.loadURL(devServerUrl)
}

/**
 * ── 这扇窗现在**开在装配之前**(2026-09-15 启动次序)────────────────────────
 * 于是这个函数里每一件事都可能在「后端还不存在」时被触发,而装配层那 121 个
 * `getXxx()` 访问器在那之前一律抛 `BackendNotAssembledError`。逐件过了一遍,
 * 一件都不碰访问器 —— 结论写在这里,不靠 try/catch 兜:
 *
 *  · `new BrowserWindow` / `preload.cjs` / `loadFile` / `loadURL` —— 纯 Electron。
 *    preload 只有 `contextBridge` + `ipcRenderer`,连 `@onething/*` 都不 import。
 *  · `ready-to-show` → `show()` / `showInactive()` —— 纯窗口。
 *  · `pushFullScreen`(`enter/leave-full-screen` + `did-finish-load`)——
 *    `webContents.send`,一条单向推送,没有后端那一侧。
 *  · `installTerminalReloadDetach` —— 它缺省调的那只 detach 住在
 *    `@onething/runtime/terminal/service.wiring`,读的是**那只包自己的模块级
 *    单例**(`serviceInstance?.markAllDetached()`),不是 backend 访问器;没开过
 *    终端时是一句安全的空话。而且它只在**第二次**主框架导航才响(第一次是开窗
 *    那一发,判词在 `./terminal-reload.ts`),装配窗口期内根本不会被调到。
 *  · `loadDevServer` 的 `session.clearCache()` —— 窗口自己的 session,与后端无关;
 *    它失败时那句 `getLogger('shell.boot').warn` 也安全:根 logger 在模块求值时
 *    就存在(只挂内存环),`configureLogging` 之前的记录留在环里
 *    (`backend/wiring/logging/index.ts` 的判词)。**代价**:落在装配之前的那几条
 *    只进环、不进 `shell.jsonl`(文件 sink 是 `configureLogging` 才挂上的)——
 *    崩溃现场 `dumpRecentLogRecords()` 仍然捞得到,见文件末留账③。
 *  · `installAppMenu` / `FRAMELESS_ON_MAC` —— 本来就在装配之前(前者是
 *    `whenReady` 第一句,后者是模块级常量),这一批没有改变它们的处境。
 *
 * 唯一真的晚了一拍的是 `host:native-view` 那条 `ipcMain.on`(它在
 * `installBrowserHost` 里,属后窗服务)。它**接不漏**:渲染层是
 * `whenConnected().finally(() => createRoot(...))`,React 根挂载在连接落定之后,
 * 而连接落定要等 HTTP 面 listen —— `installBrowserHost` 与那次 listen 在同一拍
 * 同步跑完,必定更早。`AppShell` 的 `startKeymapDownlink()` 那一推因此仍有人收。
 */
function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 600,
    minHeight: 300,
    show: false,
    backgroundColor: '#111111',
    ...FRAMELESS_ON_MAC,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Keep streaming UI updates running while the app is covered or in the background.
      backgroundThrottling: false,
    },
  })
  // 离屏档**什么都不做**:窗子本来就是 `show: false` 起的,不接这一发就永远不上屏。
  if (!GATE_HEADLESS) window.once('ready-to-show', () => window.show())
  /*
   * 屏外档(B2):`showInactive()` 而不是 `show()` —— 后者会把这扇窗激活,
   * 而那正是「真机门不许抢用户的机器」那条纪律禁的。位置摆到主屏右侧之外;
   * macOS 会把 y 钳进可见区,那没关系:x 出了屏就看不见,而它仍然在合成
   * (于是页面不被 1Hz 节流,判词在 `GATE_OFFSCREEN` 上)。
   */
  if (GATE_OFFSCREEN) {
    window.once('ready-to-show', () => {
      window.setPosition(20_000, 0)
      window.showInactive()
    })
  }

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

  /*
   * 页面重载 = 终端那几份订阅证明性地没了(T2)。判据(主框架 / 非同文档 /
   * 非首次)与整段病历在 `electron/terminal-reload.ts` 上;**关窗那条不接** ——
   * 那条路上 `backend.dispose()` 会真的把 PTY 杀掉。
   */
  installTerminalReloadDetach(window.webContents)

  const devServerUrl = process.env.ONETHING_REACT_DEV_SERVER_URL
  if (devServerUrl) void loadDevServer(window, devServerUrl)
  else void window.loadFile(path.resolve(appRoot, GATE_DIST, 'index.html'))
  // B2 ②:内嵌浏览器那一块要这扇窗(判词在 `shellWindow` 上)。
  shellWindow = window
  window.on('closed', () => {
    if (shellWindow === window) shellWindow = undefined
  })
  return window
}

/*
 * 渲染层唯一的宿主口。发现文件是 0600 的秘密,渲染层不许自己读盘。
 *
 * **永远交回同一个承诺**,不做「有就给、没有就编一句」的三元。那句现编的
 * 「还没连上」曾经是一条走不到的路(旧次序里装配跑完才开窗),启动次序一改它
 * 就成了主路,而渲染层的 `whenConnected()` 是一次性的、不重试 —— 一次竞速会
 * 变成永久故障。判词整段在 `./host-connection.ts` 的文件头,反证钉在
 * `__tests__/host-connection.test.ts`(那句假话一回来就红)。
 */
ipcMain.handle('host:connection', (): Promise<HostConnectionResult> => connection.promise)

void app.whenReady().then(async () => {
  // 离屏档连 Dock 图标都不冒(macOS 上 `app.dock` 才有;别的平台是 undefined)。
  if (GATE_HEADLESS) app.dock?.hide()
  // K1:壳自己设菜单,把 Electron 默认那张没人审过的键表拿掉(判词在 `app-menu.ts`
  // 的文件头)。**必须在第一扇窗之前**,否则窗已经在那张默认表底下站了一会儿。
  installAppMenu()

  /*
   * ── 开窗在**一切之前**(2026-09-15 启动次序)────────────────────────────
   * 从前这一段是「探发现文件(最多 500ms)→ 没有活 core 就 `await
   * assembleOwnCore()`(真店 ≈1.7s)→ 才 `createWindow()`」。页面加载(dev 下
   * 873 个模块过 vite,冷 2.4–5s)只能从装配完那一刻才开始数 —— 两段本来互不相干
   * 的等待被排成了一条队。
   *
   * 它们互不相干是有依据的,不是猜的:渲染层拿连接走的就是
   * `await host.getConnection()`(`src/platform/connection.ts`),它等的是**答案**,
   * 不是开窗的次序。所以窗先开、页面先加载,装配在旁边跑,答案到了再喂进去。
   *
   * 代价与它的落点:这扇窗在装配完成之前就已经在加载页面了,于是
   * `createWindow()` 里那几件(重载 detach / 全屏推送 / 清缓存)都可能在后端
   * 还不存在时被触发 —— 逐件确认过它们一件都不碰 `getXxx()` 访问器,判词写在
   * 各自那一行上。
   */
  if (quitting) return
  createWindow()

  const existing = readDiscovery()
  if (existing && (await isAlive(existing))) {
    // 借用活的core只建立窗口连接;自有写者始终由Backend的store lease排他。
    connection.resolve(connectionOf(existing))
  } else {
    try {
      ownCoreAssembly = assembleOwnCore()
      backend = await ownCoreAssembly
    } catch (error) {
      // 装配失败:窗已经在那儿了,错误交给渲染层显示,比静默白屏强(启发式⑨)。
      getLogger('shell.boot').error('embedded backend assembly failed', { stage: 'backend-assembly' }, error)
      connection.resolve({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    /*
     * 装配途中被 Cmd+Q / SIGTERM 截住(`ownCoreAssembly` 那一格已经让收尾等到了
     * 实例)。从前这一句挡的是「别开窗了」,今天窗早就开了,它挡的是**别再起那
     * 一堆后窗服务**:HTTP 面 / 调度器 / MCP / 内嵌浏览器起到一半又被 dispose,
     * 是白费功夫,也是孤儿进程的产地。
     *
     * 连接照样要落定,而且落的是真话:这台壳不会再连 core 了。不落 = 渲染层
     * 永远停在 `await getConnection()` 上 —— 退出这条路上那是一扇画不出东西也
     * 说不出原因的窗,而永久待定正是 gate 这只文件要根治的病。
     */
    if (quitting) {
      connection.resolve({ ok: false, error: '壳正在退出,不再连接 core' })
      return
    }
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
async function shutdownOwnCore(reason = 'window closed'): Promise<void> {
  const b = backend ?? await ownCoreAssembly
  if (!b) return
  await b.requestShutdown(reason)
  backend = undefined
}

const shutdownRequest = createDesktopShutdownRequest({
  shutdown: shutdownOwnCore,
  exit: code => app.exit(code),
  onFailure: (reason, error) => {
    getLogger('shell.shutdown').error('shutdown failed; store lease retained', { reason }, error)
  },
})

function requestShutdown(reason: string): Promise<void> {
  quitting = true
  return shutdownRequest(reason)
}

// D0 是单窗薄壳:窗关了就退(mac 上的常驻托盘行为留给 P4 的窗口系批)。
app.on('window-all-closed', () => app.quit())

/*
 * 启动次序改了之后这条路**更容易走到**:窗子开在装配之前,所以「装配还在跑就被
 * Cmd+Q / 关窗」不再是两秒钟的窄缝,而是整整 1.7s 的常态。它仍然接得住 ——
 * `ownCoreAssembly` 那一格在 `assembleOwnCore()` 调用那一行**同步**就写上了
 * (不是等它 resolve 才写),于是这里的 `!backend && !ownCoreAssembly` 判不成真,
 * `shutdownOwnCore` 里那句 `backend ?? await ownCoreAssembly` 会等装配落地再
 * `requestShutdown` → dispose,窗随进程一起走,不留孤儿。
 *
 * 另一半在 `whenReady` 里:那边 `await` 醒来时先看 `quitting`,看见了就**不起**
 * 后窗服务(HTTP 面 / 调度器 / MCP / 内嵌浏览器)—— 起一半再 dispose 才是孤儿的产地。
 */
app.on('will-quit', event => {
  if (!backend && !ownCoreAssembly) return
  // `will-quit` 不等 Promise,所以先拦一次、收完尾再真退。
  event.preventDefault()
  void requestShutdown('window closed')
})

/* OS信号和窗口退出走同一条保存链;装配仍在途时先等到实例可收尾。 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void requestShutdown(signal)
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
 * ③(2026-09-15)开窗提前之后,落在装配之前的那几条日志(今天只有 `loadDevServer`
 *    清缓存失败那一句 warn)只进内存环、不进 `shell.jsonl` —— 文件 sink 是
 *    `configureLogging` 挂的,而它住在装配第一步里。要让它们也落盘,得把
 *    `configureLogging()` 从 `createOnethingBackend` 的 `logging:` 选项里提出来、
 *    由壳在 `whenReady` 第一句自己调(装配层允许:它是幂等的,而且宿主本来就该
 *    在装配**之前**调 —— CLAUDE.md 把 `configureLogging` 明写在宿主端口表之外)。
 *    本批不动,因为那会改掉 `shell.jsonl` 这本账的开账时刻,是另一单。
 * ──────────────────────────────────────────────────────────────────────
 */
