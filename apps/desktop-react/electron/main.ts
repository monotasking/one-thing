/**
 * React 壳的 main 进程。
 *
 * ── 第④步批 2b(2026-10-07):从「壳自己就是 core」换成「壳拉起后端子进程」 ──────────
 * A1(2026-08-31)那一版让壳自己装配后端,理由是一条结构性的缺陷:子进程是另一个 app 身份,`safeStorage`
 * 的密文它解不开。第④步批 0 把凭证换成后端自己的主密钥(不靠 Electron),批 2a 把后端进程入口补齐到
 * 「桌面明天拉起它就能完全顶上」(MCP / 定时任务 / 电台 / 首启模型拉取 / 登录 shell 的 PATH),那条理由
 * 于是不在了。现在这个进程**不装配后端**:它用同一只 Electron 二进制 + `ELECTRON_RUN_AS_NODE=1` 拉起
 * `dist-electron/backend.cjs`(`./backend-process.ts`),自己只剩窗口、内置浏览器和几件只在用户屏幕上
 * 发生的事。对后端的一切都走 HTTP:`./core-client.ts` 那台客户端,与渲染层同一条 `POST /api/rpc` +
 * `GET /api/events`。`apps/desktop-react/electron/**` 对 `@onething/backend` 只许 `import type`
 * (日志那一族除外,判词在 `boundary:gate` 那条断言上)。
 *
 * ── 启动次序(这里写的是**今天**的真话)────────────────────────────────────
 *  1. `app.whenReady()` → 开日志(`shell.jsonl`,只记窗口的事;后端自己写 `app.jsonl`)→ 装应用菜单
 *     (必须在第一扇窗之前)。
 *  2. **开窗**。页面从这一刻开始加载,与后端起步并行 —— 渲染层 `await host.getConnection()` 等的是答案,
 *     不是开窗的次序。
 *  3. **先读后交**的前一半:还有 `encryption: 'safeStorage'` 的旧凭证就在拉起后端**之前**读出、用
 *     `safeStorage` 解开(`./legacy-credentials.ts`;大多数机器上什么都找不到)。
 *  4. **发现文件活着就连它**(上一次「退出后继续运行」留下的、或者别人起的 `server:start`);否则拉起
 *     子进程,轮询发现文件直到活着(`./backend-process.ts`)。
 *  5. 一条 IPC:`host:connection` → `{ baseUrl, token }`。发现文件是 0600 的秘密,渲染层不许自己读盘。
 *     **它是一个承诺,不是一个值**(`./host-connection.ts`)。后端崩了重拉时地址与 token 不变,所以这个
 *     承诺只答一次就够。反过来,首启就没起来(承诺已经答了 `ok: false`)之后用户点「重启」,原地重拉救不回
 *     渲染层 —— 那一下改成整个 app 重开(`restartBackend` 那一口)。
 *  6. 连上之后:主进程那台客户端订设置(代理重套、CDP 旗文件、浏览器身份名册三处),把第 3 步解开的旧凭证
 *     交给 `spaces.handOverLegacyCredentials`,装内置浏览器并以一扇壳的身份认领 `browser:`。
 *
 * ── 窗口与后端分家 ──────────────────────────────────────────────────────────
 *  · 关掉最后一扇窗:macOS 上 app 留在 Dock、后端照跑,点 Dock 重开窗(连的还是同一台);别的平台照旧退出。
 *  · Quit(⌘Q / SIGTERM):缺省 SIGTERM 后端、等它把会话落完盘(5 秒期限 + 2 秒)再退;设置里开了
 *    「退出 onething 后让后端继续运行」就不发信号,后端留着,命令行与浏览器壳照样连得上,下次启动走第 4 步。
 *  · 后端非预期退出:删掉 pid 对得上的发现文件、自动重拉(60 秒内最多 3 次,决策 D11),再崩就推「后端已停止」
 *    给渲染层亮横幅;重拉期间渲染层自己按连接状态显示「正在重新连接后端。」。
 *
 * 它**仍然不**做的事(边界,别越):不取 StoreLock(08-24「store 不要锁」,单写者靠发现文件让位)、
 * 不注册第四条 IPC 表(`host:connection` / `host:native-view` / `host:client-action` 三条)。
 * ──────────────────────────────────────────────────────────────────────
 */
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { getLogger } from '@onething/backend/logging'
import { configureLogging } from '@onething/backend/logging/logging-configure'
import { spacesRouter } from '@shared/ipc/spaces'
import { terminalRouter } from '@shared/ipc/terminal'
import {
  BACKEND_STATE_CHANNEL,
  CLIENT_ACTION_CHANNEL,
  type BackendHostState,
} from '@shared/contracts/client-action'
import { installAppMenu } from './app-menu-install.js'
import { BackendProcess, type BackendProcessSnapshot } from './backend-process.js'
import { resolveStoreRoot } from './discovery.js'
import { installProxySettingsWatcher } from './proxy-settings.js'
import { runClientAction } from './client-action.js'
import { createCoreClientGetter, createSettingsFeed } from './core-client.js'
import { readLegacySafeStorageForHandOver, type LegacyHandOverEntry } from './legacy-credentials.js'
import { MainShellResources } from './shell-resources.js'
import { createDesktopShutdownRequest } from './shutdown.js'
// 「连接」是开窗之前就存在的承诺(整段判词在那只文件的文件头)。
import { HostConnectionGate, type HostConnectionResult } from './host-connection.js'
// T2:页面重载时把「消费者走了」当场说给终端服务听(判词在那只文件的文件头)。
import { installTerminalReloadDetach } from './terminal-reload.js'
/*
 * ── 内嵌浏览器(整块的判词在 `electron/browser/index.ts` 的文件头)──
 * 两段,次序是硬的:①两句旗子必须在 app `ready` 之前(`appendSwitch` 之后 Chromium 才读命令行);
 * ②窗口建成、后端连上之后才装得起 `installBrowserHost`(要 `window` 挂视图、要那台客户端认领 `browser:`)。
 */
import { installBrowserHost } from './browser/index.js'
import { applyChromiumFlags } from './browser/user-agent.js'
import { applyCdpFlag, readCdpLaunchFlag } from './browser/cdp-flag.js'

/** 进程起来那一刻(量「从进程起到 `host:connection` 落定」用,对照批 2a 的 416ms 基线)。 */
const processStartedAt = performance.now()

/**
 * ── 同店同钥:app 名字就是 safeStorage 的钥匙名 ─────────────────────────────
 * macOS 上 safeStorage 的 Keychain 条目叫「<app 名> Safe Storage」。旧凭证文件
 * (`workspaces/<id>/credentials.json` 还是 `encryption: 'safeStorage'` 的那些)是以
 * 「onething Safe Storage」加密的;壳的包名 `@onething/desktop-react` 生不出有效条目,Chromium 退到
 * 「Electron Safe Storage」—— 另一把钥匙,解出来永远是垃圾。第④步批 0 起凭证用后端自己的主密钥,
 * safeStorage 只剩「先读后交」那一步(还没迁完的机器)要它,所以这一句**保留**。必须在 ready 之前设,
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
 * **内嵌浏览器的两句启动旗**(`electron/browser/index.ts` 文件头逐字照做)。
 *
 * 它们必须在 app `ready` **之前** —— `appendSwitch` 之后 Chromium 才读命令行。
 * `applyChromiumFlags` 关掉 FedCm(登谷歌那条配方的四件之一);`applyCdpFlag` 按
 * `<store>/run/cdp.json` 那张旗文件决定开不开 `--remote-debugging-port`
 * (**判据是旗文件 + argv,不是设置** —— 设置改了要重启才生效,按设置写等于说谎;
 * argv 里已经带着口时不再 append,否则真机门的口会被产品旗子顶掉,判词在
 * `browser/cdp-flag.ts` 的文件头)。
 */
const storeRoot = resolveStoreRoot()
applyChromiumFlags(app)
applyCdpFlag(app, readCdpLaunchFlag(storeRoot))

/** 打包后是 `.../dist-electron/main.cjs`,dev 时同路径 —— 两跳到 apps/。 */
const appRoot = path.resolve(__dirname, '..')

/**
 * 后端进程入口的真路径。打包态 `__dirname` 在 `app.asar` 里,而子进程入口、它旁边的检索 Worker 与原生模块都要
 * 真路径,所以 `backend.cjs` 在 `asarUnpack` 里(`electron-builder.yml`),这里把路径换到 `app.asar.unpacked`。
 * 能不能这样起由 `gate:packaged` 跑出来,不写在注释里。
 */
function backendEntryPath(): string {
  const entry = path.join(__dirname, 'backend.cjs')
  return app.isPackaged ? entry.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`) : entry
}

/**
 * `host:connection` 的答案。**模块级 `const`,不是 `let`** —— 一个进程只服务一个
 * store、只连一台后端,那是这个宿主的结构性事实;而且 `ipcMain.handle` 在模块求值
 * 那一刻就注册了,handler 闭包必须现在就抓得到它。整段判词在 `./host-connection.ts`。
 */
const connection = new HostConnectionGate()

/** 主进程自己那台客户端(决策 D284):与渲染层同一份 `{ baseUrl, token }`、同一条 `POST /api/rpc`。 */
const coreClient = createCoreClientGetter(connection.promise)

/** 设置订阅源:代理重套、CDP 旗文件、浏览器身份名册三处订它(判词在 `./core-client.ts`)。 */
const settingsFeed = createSettingsFeed(coreClient, getLogger('shell.settings'))

const backendLog = getLogger('shell.backend')

/** 推给每一扇窗(设置页的状态行、横幅、重拉提示读它)。 */
function hostStateOf(snapshot: BackendProcessSnapshot): BackendHostState {
  return {
    phase: snapshot.phase,
    ...(snapshot.pid !== undefined ? { pid: snapshot.pid } : {}),
    ...(snapshot.port !== undefined ? { port: snapshot.port } : {}),
    ...(snapshot.startedAt !== undefined ? { startedAt: snapshot.startedAt } : {}),
    ...(snapshot.launchedHere !== undefined ? { launchedHere: snapshot.launchedHere } : {}),
    ownedByDesktop: backendProcess.ownsBackend,
    ...(snapshot.error !== undefined ? { error: snapshot.error } : {}),
  }
}

/**
 * 这一程的后端子进程。token 由它铸(或沿用借来那台的),重拉时端口与 token 不变 —— 判词在那只文件头。
 * `ONETHING_RESOURCES_PATH` 只在打包态递(dev 下递了反而让后端去错的地方找内建 skills)。
 */
const backendProcess: BackendProcess = new BackendProcess({
  execPath: process.execPath,
  entry: backendEntryPath(),
  storeRoot,
  env: process.env,
  ...(app.isPackaged ? { resourcesPath: process.resourcesPath } : {}),
  log: {
    info: (msg, fields) => backendLog.info(msg, fields),
    warn: (msg, fields, error) => backendLog.warn(msg, fields, error),
    error: (msg, fields, error) => backendLog.error(msg, fields, error),
  },
  onChange: snapshot => {
    const state = hostStateOf(snapshot)
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(BACKEND_STATE_CHANNEL, state)
    }
  },
})

let shellWindow: BrowserWindow | undefined
let quitting = false

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
 * ── 这扇窗**开在后端连上之前**(2026-09-15 启动次序,第④步批 2b 照旧)──────────────────
 * 这个函数里每一件事都可能在「后端还没起来」时被触发。逐件过了一遍,一件都不需要后端:
 *
 *  · `new BrowserWindow` / `preload.cjs` / `loadFile` / `loadURL` —— 纯 Electron。
 *    preload 只有 `contextBridge` + `ipcRenderer`,连 `@onething/*` 都不 import。
 *  · `ready-to-show` → `show()` / `showInactive()` —— 纯窗口。
 *  · `pushFullScreen`(`enter/leave-full-screen` + `did-finish-load`)—— 一条单向推送。
 *  · `installTerminalReloadDetach` —— 只在**第二次**主框架导航才响,而且发的是一条 RPC
 *    (`terminal.detachAll`,经主进程那台客户端;后端没连上时那台客户端答 `undefined`,这一句做不成就算了)。
 *  · `loadDevServer` 的 `session.clearCache()` —— 窗口自己的 session,与后端无关。
 *
 * 内置浏览器那一块(要这扇窗挂视图、要后端连上才认领得了 `browser:`)由 `startWindowServices` 在连上之后装,
 * 窗关掉时一起拆:macOS 上关窗不退出,点 Dock 重开窗会再装一份新的(新窗、新的壳坐标)。
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
   * 非首次)与整段病历在 `electron/terminal-reload.ts` 上;**关窗那条不接**。
   */
  installTerminalReloadDetach(window.webContents, detachTerminalsOverRpc)

  // 后端状态:页面每次加载完都对齐一次(推送可能早于页面订上)。
  window.webContents.on('did-finish-load', () => {
    if (!window.isDestroyed()) window.webContents.send(BACKEND_STATE_CHANNEL, hostStateOf(backendProcess.state))
  })

  const devServerUrl = process.env.ONETHING_REACT_DEV_SERVER_URL
  if (devServerUrl) void loadDevServer(window, devServerUrl)
  else void window.loadFile(path.resolve(appRoot, GATE_DIST, 'index.html'))
  shellWindow = window
  let stopServices: (() => Promise<void>) | undefined
  let closed = false
  // 连上之后才装内置浏览器那一块;窗先关了就不装。
  void connection.promise.then(result => {
    if (!result.ok || closed || quitting || window.isDestroyed()) return
    const stop = startWindowServices(window)
    stopServices = stop
    windowServiceStops.add(stop)
  })
  window.on('closed', () => {
    closed = true
    if (shellWindow === window) shellWindow = undefined
    if (stopServices) {
      windowServiceStops.delete(stopServices)
      void stopServices()
    }
  })
  return window
}

/**
 * 一扇窗连上后端之后要的那几件:内置浏览器(挂这扇窗的 `contentView`),以及主进程以一扇壳的身份认领
 * `browser:`(`./shell-resources.ts`)。返回拆掉它们的那一手(把 tab 表写下来、注销、摘 IPC)。
 * 装不起来不阻塞窗口:没有内嵌浏览器不该让窗口起不来 —— `browser:` 没人认领,壳与 AI 两侧都诚实地答「不在」。
 */
function startWindowServices(window: BrowserWindow): () => Promise<void> {
  const log = getLogger('shell.boot')
  let browserHost: ReturnType<typeof installBrowserHost> | undefined
  let shellResources: MainShellResources | undefined
  try {
    browserHost = installBrowserHost({ window, storePath: storeRoot, settings: settingsFeed })
    const provider = browserHost.provider
    const resources = new MainShellResources([{
      scheme: provider.spec.scheme,
      spec: provider.spec,
      read: (name, refPath, params) => provider.read(name, refPath, params),
      run: (op, refPath, params) => provider.run(op, refPath, params),
    }], {
      info: (msg, fields) => log.info(msg, fields),
      warn: (msg, fields, error) => log.warn(msg, fields, error),
    })
    shellResources = resources
    provider.attach((refPath, event, payload) => { resources.emit(provider.spec.scheme, refPath, event, payload) })
    void coreClient().then(client => client ? resources.start(client) : undefined).catch((error: unknown) => {
      log.error('subsystem startup failed', { subsystem: 'browser-shell', blocking: false }, error)
    })
  } catch (error: unknown) {
    log.error('subsystem startup failed', { subsystem: 'browser', blocking: false }, error)
  }
  let stopped = false
  return async () => {
    if (stopped) return
    stopped = true
    await shellResources?.stop().catch(() => undefined)
    await browserHost?.dispose().catch((error: unknown) => { log.warn('browser host dispose failed', undefined, error) })
  }
}

/** 窗口那几件的收尾(退出时用;关窗时由各自那扇窗的 `closed` 收)。 */
const windowServiceStops = new Set<() => Promise<void>>()

/*
 * 渲染层唯一的宿主口。发现文件是 0600 的秘密,渲染层不许自己读盘。
 *
 * **永远交回同一个承诺**,不做「有就给、没有就编一句」的三元(判词在 `./host-connection.ts` 文件头,
 * 反证钉在 `__tests__/host-connection.test.ts`)。
 */
ipcMain.handle('host:connection', (): Promise<HostConnectionResult> => connection.promise)

/** `<store>/log/app.jsonl`:后端子进程的日志(桌面档写它)。 */
function backendLogPath(): string {
  return path.join(storeRoot, 'log', 'app.jsonl')
}

/*
 * 渲染层的第三条口:**只在用户屏幕上发生的事**(第④步批 1,决策 D5 / D278;契约
 * `@shared/contracts/client-action`),第④步批 2b 起再加三个只有拉起后端的宿主答得出的动词
 * (后端状态 / 重启后端 / 在访达中显示后端日志)。它与 `host:connection` 同性质,不是数据通道;
 * 载荷来自渲染进程,逐格校验在 `./client-action.ts`(不信发件人)。对话框挂在发起的那扇窗上(`event.sender`)。
 */
ipcMain.handle(CLIENT_ACTION_CHANNEL, (event, action: unknown) => runClientAction(action, {
  async showOpenDialog(request) {
    const options = {
      properties: request.properties ?? ['openFile' as const],
      ...(request.title !== undefined ? { title: request.title } : {}),
      ...(request.defaultPath !== undefined ? { defaultPath: request.defaultPath } : {}),
      ...(request.filters !== undefined ? { filters: request.filters } : {}),
    }
    const parent = BrowserWindow.fromWebContents(event.sender)
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    return { canceled: result.canceled, filePaths: result.filePaths }
  },
  openExternal: url => shell.openExternal(url),
  openPath: filePath => shell.openPath(filePath),
  revealPath: filePath => shell.showItemInFolder(filePath),
  backendStatus: () => hostStateOf(backendProcess.state),
  async restartBackend() {
    /*
     * 首启就没连上(三次都没起来、`host:connection` 已经答了 `ok: false`):那是一个**一次性的承诺**,渲染层不会
     * 再问第二次,主进程那台客户端也永远是 `undefined` —— 这时只重拉后端,横幅收掉了而会话列表永远空着。
     * 诚实的修法是换一个进程:整个 app 重开一次(`app.relaunch()` + 照常收尾)。连上过的那一程才走原地重拉
     * (地址与 token 不变,渲染层只是 SSE 重连)。
     */
    const prior = connection.settled ? await connection.promise : undefined
    if (prior && !prior.ok) {
      backendLog.info('restart requested after a failed first start; relaunching the app')
      app.relaunch()
      void requestShutdown('relaunch-after-failed-start')
      return { ok: true }
    }
    const result = await backendProcess.restart()
    return result.ok ? { ok: true } : { ok: false, error: result.error }
  },
  revealBackendLog() {
    // 文件在就在访达里选中它;还没有(后端一行都没写过)就打开它所在的目录。
    const file = backendLogPath()
    if (existsSync(file)) shell.showItemInFolder(file)
    else void shell.openPath(path.dirname(file))
  },
}))

/** 页面整个重载了:让每格终端勾销欠着的流控账。发出去不等回执(判词在 `./terminal-reload.ts`)。 */
function detachTerminalsOverRpc(): void {
  void coreClient()
    .then(client => client?.api(terminalRouter).detachAll({}))
    .catch((error: unknown) => {
      getLogger('shell.terminal-reload').warn('terminal.detachAll failed', undefined, error)
    })
}

/**
 * **先读后交**的后一半:把拉起后端之前解开的旧凭证交给 `spaces.handOverLegacyCredentials`(只给本机信任的
 * 来访者;后端按批 0 同一套判据封进主密钥信封、逐条校验、旧文件改名备份)。交不进去只记一行:旧文件原样
 * 在盘上,下次启动再读再交。
 */
async function handOverLegacyCredentials(entries: readonly LegacyHandOverEntry[]): Promise<void> {
  const log = getLogger('shell.credentials')
  try {
    const client = await coreClient()
    if (!client) return
    const answer = await client.api(spacesRouter).handOverLegacyCredentials({ entries: [...entries] })
    if (answer.success) log.info('legacy safeStorage credentials handed over', { accepted: answer.accepted, migratedSpaces: answer.migratedSpaces, state: answer.status?.state })
    else log.warn('legacy safeStorage credentials were not accepted', { code: answer.code })
  } catch (error) {
    log.warn('handing over legacy safeStorage credentials failed', undefined, error)
  }
}

void app.whenReady().then(async () => {
  /*
   * 日志第一句(结 2026-09-15 留账③):从前 `configureLogging` 住在装配第一步里,开窗提前之后落在装配之前的
   * 那几条只进内存环。现在这个进程不装配了,由它自己在 ready 第一句开 `shell.jsonl`。管家(`LogDirJanitor`)
   * 不在这里起:`log/` 只有一个管家,它住在后端进程里。
   */
  configureLogging({ fileBaseName: 'shell', src: 'main', janitor: false })
  const log = getLogger('shell.boot')
  // 离屏档连 Dock 图标都不冒(macOS 上 `app.dock` 才有;别的平台是 undefined)。
  if (GATE_HEADLESS) app.dock?.hide()
  // K1:壳自己设菜单,把 Electron 默认那张没人审过的键表拿掉(判词在 `app-menu.ts`
  // 的文件头)。**必须在第一扇窗之前**,否则窗已经在那张默认表底下站了一会儿。
  installAppMenu()

  if (quitting) return
  createWindow()
  // 关掉最后一扇窗之后点 Dock 重开窗。注册在拉起后端**之前**:后端起不来时窗也得能重开(横幅在窗里)。
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // 先读后交的前一半:拉起后端之前读(此刻没有写者)。大多数机器上什么都找不到。
  const legacy = readLegacySafeStorageForHandOver(storeRoot, safeStorage)
  if (legacy.found > 0) log.info('legacy safeStorage credentials found before starting the backend', { found: legacy.found, undecryptable: legacy.undecryptable })

  const started = await backendProcess.start()
  if (started.ok) {
    connection.resolve({ ok: true, baseUrl: started.connection.baseUrl, ...(started.connection.token ? { token: started.connection.token } : {}) })
    log.info('host connection settled', {
      ms: Math.round(performance.now() - processStartedAt),
      adopted: started.adopted,
    })
  } else {
    // 起不来:窗已经在那儿了,错误交给渲染层显示,比静默白屏强(启发式⑨)。尾巴带上,看得出为什么。
    const tail = started.tail.slice(-8).join('\n')
    connection.resolve({ ok: false, error: tail ? `${started.error}\n${tail}` : started.error })
    // 退出途中那一趟被收掉不是「没起来」,不记错误。
    if (!quitting) log.error('backend did not start', { error: started.error })
    return
  }
  if (quitting) return

  installProxySettingsWatcher(settingsFeed)
  if (legacy.entries.length > 0) void handOverLegacyCredentials(legacy.entries)
})

/**
 * 收尾。缺省档:SIGTERM 后端、等它落完盘(`backendProcess.stop()`,最多 `BACKEND_STOP_GRACE_MS` = 8 + 1 + 2 秒,超时 SIGKILL 并记日志)。
 * 「退出 onething 后让后端继续运行」开着:不发信号(`leave()`),后端留着,下次启动走「发现文件活着就连」。
 * 设置值读主进程那台客户端最近一次拿到的那一份 —— 从没读到过(后端压根没起来)就当关着。
 */
async function shutdownBackend(reason: string): Promise<void> {
  const keepRunning = settingsFeed.current()?.general?.backendKeepRunningAfterQuit === true
  for (const stop of [...windowServiceStops]) await stop().catch(() => undefined)
  settingsFeed.dispose()
  if (keepRunning) {
    backendProcess.leave()
    backendLog.info('quit: backend keeps running', { reason })
    return
  }
  await backendProcess.stop()
  backendLog.info('quit: backend stopped', { reason })
}

const shutdownRequest = createDesktopShutdownRequest({
  shutdown: shutdownBackend,
  exit: code => app.exit(code),
  onFailure: (reason, error) => {
    getLogger('shell.shutdown').error('shutdown failed', { reason }, error)
  },
})

function requestShutdown(reason: string): Promise<void> {
  quitting = true
  return shutdownRequest(reason)
}

/*
 * 关掉最后一扇窗:macOS 上 app 留在 Dock(后端照跑,点 Dock 由 `activate` 重开窗),别的平台照旧退出
 * (那两个平台上「没有窗的 app」没有 Dock 可留)。
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/* `will-quit` 不等 Promise,所以先拦一次、收完尾(停后端或放它走)再真退。 */
app.on('will-quit', event => {
  event.preventDefault()
  void requestShutdown('quit')
})

/* OS 信号和窗口退出走同一条收尾链。 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void requestShutdown(signal)
  })
}
