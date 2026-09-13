/**
 * `installBrowserHost()` —— 内嵌浏览器这一整块的**唯一装配点**,也是整个
 * `electron/browser/` 里**唯一** `import … from 'electron'` 的地方。
 *
 * 别的每一只文件都收结构化端口(视图工厂、session 工厂、`app.commandLine`、
 * `ipcMain`、`contentView`),于是它们在 vitest 里跑得起来 —— `createShellHostPorts`
 * 那次的前车之鉴:一旦有一只文件顶层 import 了 electron,整棵依赖它的测试树就只能
 * 靠 mock 电梯,而那份 mock 会慢慢长成第二个 Electron。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ## 接线的那一行不在本单里
 *
 * `electron/main.ts` 是别批的脏文件,B1-a 一个字都不碰。**接线留给后续那一单**,
 * 它要做的事逐条写在这里:
 *
 *   ① **app `ready` 之前**(`main.ts` 顶层,与 `resolveStoreRoot()` 同一段):
 *
 *          import { applyChromiumFlags } from './browser/user-agent.js'
 *          import { applyCdpFlag, readCdpLaunchFlag } from './browser/cdp-flag.js'
 *          applyChromiumFlags(app)
 *          applyCdpFlag(app, readCdpLaunchFlag(resolveStoreRoot()))
 *
 *      两句都**必须**在 ready 之前 —— `appendSwitch` 之后 Chromium 才读命令行
 *      (`cdp-flag.ts` 的文件头写着为什么 CDP 那一格是旗文件而不是读设置)。
 *
 *   ①′ **挂内嵌 HTTP 面那一行**(B2′):把这个进程真的开着的 CDP 口补进
 *      `run/http.json`,别的客户端(chrome-devtools-mcp 的配置、脚本)就不必猜口:
 *
 *          import { cdpDiscoveryExtras } from './browser/cdp-settings.js'
 *          startEmbeddedOnethingHttpServer(b, {
 *            owner: 'shell',
 *            discoveryExtras: cdpDiscoveryExtras(app.commandLine),
 *          })
 *
 *      判据是**命令行**不是设置:设置改了要重启才生效,按设置写等于说谎。
 *      没开 → `undefined` → `cdp` 那个键根本不出现在文件里。
 *
 *   ② **窗口建成 + 装配完成之后**(`startPostWindowServices()` 里,与
 *      `b.mcp.start()` 同一段):
 *
 *          const browserHost = installBrowserHost({ window, backend: b, storePath: resolveStoreRoot() })
 *          b.own(() => browserHost.dispose(), 'browserHost')
 *
 *      次序是硬的:要 `window`(视图得挂进 `win.contentView`)、要装配完的 backend
 *      (`backend.resources` 在装配之前抛 `BackendNotAssembledError`)。
 *      **不要**放进 `hooks.afterTools` —— 那一拍窗口还没有。
 *
 *   ③ `installBrowserHost` 自己**不** `own()`:它返回一个 disposer,由调用方
 *      `own()`。「谁起的谁 own」那条纪律的落点是起它的那一行,不是被起的那只模块
 *      (方案 §2.4;`main.ts` 里 `embeddedHttpSurface` / `userSchedulerTasks`
 *      都是这个形)。
 *
 *   ④ `--mode web` 没有主进程,这一整块根本不加载;`browser:` 不 mount,于是网页壳
 *      那一侧 `do(browser:…)` 诚实答 `ResourceSchemeUnknownError`(§3.2 的「未挂」
 *      那一行)。**唯一的例外**是网页壳连着**桌面** core 的时候:那是同一台 core 的
 *      另一扇窗,`describe` 列得出、AI 在网页壳里说「开个页」会开在桌面窗里(§9-12)。
 *      那是「一个 core」的形,不是 bug。
 * ────────────────────────────────────────────────────────────────────────────
 */

import fs from 'node:fs'
import nodePath from 'node:path'
import { WebContentsView, app, ipcMain, session, type BrowserWindow } from 'electron'
import type { OnethingBackend } from '@onething/backend'
import { getLogger } from '@onething/backend/wiring/logging/index.js'
import {
  configureSettingsEventBroadcaster,
  getSettingsEventBroadcaster,
} from '@onething/backend/wiring/settings/events.js'
import { getSettings } from '@onething/backend/stores/settings.js'
import { NATIVE_VIEW_CHANNEL, type NativeViewPush } from '../native-view-protocol.js'
import { shellProxyPolicy } from '../host-ports.js'
import type { ElectronProxySessionLike } from '../network-proxy.js'
import { KeymapBridge } from './keymap-bridge.js'
import { installCdpSettingsWatcher } from './cdp-settings.js'
import {
  installBrowserProfilesWatcher,
  profileTableFromSettings,
  type BrowserProfileTable,
} from './profiles.js'
import { NativeViewLayout, type NativeViewHost } from './layout.js'
import { installNativeViewIpc } from './native-view-ipc.js'
import { applyAppMenuSpec, configureAppMenuCommandSender } from '../app-menu-install.js'
import { BrowserResourceProvider, type BrowserOps, type BrowserTabView } from './resource-provider.js'
import { BrowserSessionPolicy, type BrowserSessionLike } from './session-policy.js'
import { BrowserService, getBrowserTabsPath } from './service.js'
import type { BrowserTab, NativeView } from './tab.js'
import { WebPermissionBroker } from './permission.js'
import { installBrowserDownloads, resolveDownloadDirectory } from './download.js'

const log = getLogger('shell.browser')

export interface InstallBrowserHostOptions {
  /** 视图挂进它的 `contentView`,推送也发给它的 `webContents`。 */
  readonly window: BrowserWindow
  /** 已经装配完的 backend —— `resources` 在装配之前会抛。 */
  readonly backend: OnethingBackend
  /** tab 表落在 `<storePath>/browser/tabs.json`。缺席 = 按当前 store 解析。 */
  readonly storePath?: string
}

export interface BrowserHost {
  /** 摘掉 IPC、摘掉全部视图、摘掉 provider、把 tab 表写下来。幂等。 */
  dispose(): Promise<void>
}

export function installBrowserHost(options: InstallBrowserHostOptions): BrowserHost {
  const { window, backend } = options

  const push = (message: NativeViewPush): void => {
    if (window.isDestroyed()) return
    window.webContents.send(NATIVE_VIEW_CHANNEL, message)
  }

  // `contentView` 就是 `NativeViewHost`(结构上逐格对上)—— 这一处 cast 是本模块里
  // 「结构化端口」与真 Electron 对接的那一道缝,全部五处 cast 都集中在这只文件里。
  const layout = new NativeViewLayout(window.contentView as unknown as NativeViewHost, push)
  const keymap = new KeymapBridge(push)
  /*
   * **菜单点击的回程**(K4)。菜单是 `app.whenReady()` 那一拍装上的(K1:第一扇窗
   * 之前),但「点了要交给谁」要等这扇窗 —— 所以它在这里填,与 `push` 同一只闭包。
   * 撤销进下面那张 `dispose` 的清单:窗口没了之后菜单上点一下只记一行 debug。
   */
  const offMenuSender = configureAppMenuCommandSender(id => {
    push({ kind: 'command', id })
  })
  /** 每格 tab 一份「摘 keymap 监听」的退订。 */
  const keymapOff = new Map<string, () => void>()

  let provider: BrowserResourceProvider | undefined

  /*
   * ── 「哪片 webContents 属于哪一格 tab」(B3-a)────────────────────────────
   *
   * 权限询问与下载这两件事,Electron 交来的身份都是**那片 webContents**,而壳那
   * 一侧要的是一格 tab 的地址(`browser:<id>`)。这张表在装配点,不在 policy、也
   * 不在 service:policy 不认识 tab(那正是它测得动的原因),而 service 手上有的是
   * `BrowserTab`,不是「谁的 webContents」这条反向问句。**登记与撤销各只有一处**
   * —— 视图落地那一刻记,视图摘掉那一刻删,与 `layout` / `keymapOff` 逐字同序。
   */
  const tabIdByContents = new Map<unknown, string>()

  /*
   * 一次询问结了就发一条事实 —— **三条收场共用这一句**(答了 / 超时 / tab 没了)。
   * 判词在 `resource-spec.ts` 的 `permissionResolved` 上:没有它,一张问过就没人
   * 管的卡会永远举在屏幕上。
   */
  const permissions = new WebPermissionBroker({
    onAsk: event => { provider?.emitPermissionRequested(event) },
    onResolved: event => { provider?.emitPermissionResolved(event) },
  })

  /*
   * 下载落哪儿。**每次下载现问**(`directory` 是个函数)—— 于是门那一格覆盖与
   * 将来设置里那一格「下到哪」都不必重挂监听。判词在 `download.ts` 上。
   */
  const downloads = resolveDownloadDirectory(app.getPath('downloads'), process.env)
  if (downloads.override) {
    /*
     * 覆盖生效时把宿主自己那一格也指过去 —— 沙箱的**读根**里有「下载目录」一条
     * (`getOnethingDownloadsDirectory` 走的正是 `app.getPath('downloads')`),两边
     * 不一致的话门里下出来的文件就落在读根之外,`dir:` 的 `reveal` 会说它越界。
     * 只在门那一档下发生;`setPath` 对不存在的目录会抛,所以兜一下。
     */
    try { app.setPath('downloads', downloads.dir) } catch { /* 目录不在:照旧用覆盖值落盘 */ }
  }
  /** 每格 profile 一份「摘 will-download」的退订。 */
  const downloadsOff: (() => void)[] = []
  /** 每格 profile 一份「不再跟着重套代理」的退订。 */
  const proxyOff: (() => void)[] = []

  const sessionPolicy = new BrowserSessionPolicy(partition => session.fromPartition(partition), {
    /*
     * ── 代理:**分区建出来那一拍就登记**(2026-09-12)─────────────────────────
     *
     * 报障的形状:用户设置里代理开着,而 `applyShellNetworkProxySettings()` 只对
     * `session.defaultSession` 一个人 `setProxy` —— 这里每一格身份是
     * `session.fromPartition('persist:browser-<id>')`,是**另一个** Session,于是
     * 标签直连出网,被墙的站在 TLS 握手那一步被关(日志里成串的 `net_error -100`)。
     *
     * 修法不是在这里补一句 `setProxy`,而是**把这一格网络面交给策略对象**:
     * `register` 当场回放当前配置(policy 把那个 promise 记成 `ready(profile)`,
     * 第一发 `loadURL` 等它),而且此后每一次「设置里改了代理」都由策略挨个重套。
     * 判词整段在 `electron/network-proxy.ts` 的文件头。
     *
     * 这里的 cast 与本文件另外五处同族:`BrowserSessionLike` 是分区策略认识的
     * 那一片(它不该认识代理的词汇),真 `Session` 两边的口都有。
     */
    proxy: {
      register: created => {
        const registration = shellProxyPolicy.register(created as unknown as ElectronProxySessionLike)
        proxyOff.push(() => { registration.unregister() })
        return registration.ready
      },
    },
    ask: request => {
      const tabId = tabIdByContents.get(request.webContents)
      // 认不出是哪一格 = 没有地方画那张卡 = 只能拒(「没人能答的时候唯一诚实的
      // 答案就是不」,与 policy 里 `ask` 缺席那一档逐字同一句)。
      if (!tabId) return Promise.resolve(false)
      return permissions.ask({ tabId, permission: request.permission, origin: request.origin })
    },
    onSession: (created: BrowserSessionLike) => {
      downloadsOff.push(
        installBrowserDownloads(created as never, {
          directory: () => downloads.dir,
          tabIdOf: webContents => tabIdByContents.get(webContents),
          exists: target => fs.existsSync(target),
          join: (dir, name) => nodePath.join(dir, name),
          onEvent: event => { provider?.emitDownload(event) },
        }),
      )
    },
  })

  const viewOf = (tab: BrowserTab): BrowserTabView => ({
    ...tab.state,
    active: service.activeId === tab.id,
  })

  /*
   * ── 身份名册此刻是什么样(B3-b)──────────────────────────────────────────
   * 名册的真源是**设置**;这一格是它在主进程这一侧的**投影**,由下面那只
   * watcher 每次 `settings:changed` 刷新。service 每开一格 tab 现问缺省身份,
   * 所以「在设置页把缺省改成工作号」下一格新 tab 就跟着变,不必重启。
   */
  let profiles: BrowserProfileTable = profileTableFromSettings(getSettings())

  const service = new BrowserService({
    sessionPolicy,
    createView: preferences =>
      new WebContentsView({ webPreferences: preferences as never }) as unknown as NativeView,
    ...(options.storePath ? { tabsPath: getBrowserTabsPath(options.storePath) } : {}),
    defaultProfile: () => profiles.defaultProfile,
    observer: {
      onMaterialized: tab => {
        const view = tab.nativeView
        if (!view) return
        layout.register(tab.id, view)
        keymapOff.set(tab.id, keymap.attach(tab.id, view.webContents))
        tabIdByContents.set(view.webContents, tab.id)
      },
      onDematerialized: tabId => {
        keymapOff.get(tabId)?.()
        keymapOff.delete(tabId)
        for (const [contents, id] of tabIdByContents) {
          if (id === tabId) tabIdByContents.delete(contents)
        }
        layout.release(tabId)
      },
      onOpened: tab => { provider?.emitOpened(viewOf(tab)) },
      /*
       * 页面自己开的那一格(2026-09-12)。**照 `viewOf` 那一份读数发**,与别的
       * 事实同一个产地;`openerId` 是 service 递过来的,装配点不去反查(它手上
       * 那张 `tabIdByContents` 答的是 webContents → tab,而这里问的是 tab → tab)。
       */
      onSpawned: (state, openerId) => {
        provider?.emitSpawned({ ...state, active: service.activeId === state.id }, openerId)
      },
      onSpawnBlocked: (openerId, url) => {
        // 一行日志 + 一条事实:拦下来的那一下页面那边什么都不会发生,而
        // 「什么都不会发生」正是这一单在治的病,所以这条路要说得出口。
        log.warn('browser spawn refused (rate)', { openerId, url })
        provider?.emitSpawnBlocked(openerId, url)
      },
      onClosed: tabId => {
        // 这一格没了:它身上还悬着的每一问当场按拒结掉 —— 页面那边在等一个
        // `callback`,而那个页面马上就要被销毁了,悬着只会留一条永不回的路。
        permissions.withdrawTab(tabId)
        provider?.emitClosed(tabId)
      },
      onFind: (tab, readout) => {
        push({ kind: 'find', viewId: tab.id, active: readout.active, total: readout.total })
      },
      onNavigated: tab => { provider?.emitNavigated(viewOf(tab)) },
      onLoading: tab => { provider?.emitLoading(viewOf(tab)) },
    },
  })
  service.restore()

  /**
   * provider 看得见的那一小片(见 `resource-provider.ts` 的 `BrowserOps`)。
   *
   * 一格不存在时 `has()` 答 false,provider 抛一句说得出口的话 —— 而不是在这里
   * 静默吞掉:模型说「关掉 browser:xyz」而那一格早没了,它该知道。
   */
  const ops: BrowserOps = {
    list: () => service.list().map(state => ({ ...state, active: service.activeId === state.id })),
    activeId: () => service.activeId,
    open: init => {
      const state = service.open(init)
      return { ...state, active: service.activeId === state.id }
    },
    navigate: (tabId, url) => { service.get(tabId)?.navigate(url) },
    back: tabId => { service.get(tabId)?.back() },
    forward: tabId => { service.get(tabId)?.forward() },
    reload: tabId => { service.get(tabId)?.reload() },
    activate: tabId => { service.activate(tabId) },
    close: tabId => { service.close(tabId) },
    zoom: (tabId, level) => { service.get(tabId)?.zoom(level) },
    has: tabId => service.get(tabId) !== undefined,
    readText: (tabId, maxChars) => service.get(tabId)?.readText(maxChars) ?? Promise.resolve(''),
    capture: tabId => service.get(tabId)?.capture() ?? Promise.resolve(undefined),
    get: tabId => {
      const tab = service.get(tabId)
      return tab ? viewOf(tab) : undefined
    },
    respondPermission: (requestId, allow) => permissions.respond(requestId, allow),
  }

  provider = new BrowserResourceProvider(ops)
  const unmount = backend.resources.mount(provider)

  const offIpc = installNativeViewIpc(ipcMain, {
    frame: frame => {
      // 壳说「这一格该看得见」= 惰性视图落地的那一刻(方案 §9-5)。
      if (frame.visible) service.materialize(frame.viewId)
      layout.applyFrame(frame)
    },
    occlude: viewId => { void layout.occlude(viewId) },
    unocclude: viewId => { layout.unocclude(viewId) },
    focus: viewId => { service.get(viewId)?.focus() },
    keymap: (chords, menu) => {
      keymap.setBoundChords(chords)
      /*
       * 菜单表(K4)。**同一条帧的另一半** —— 两张表都是命令表的投影,同源同时,
       * 所以它们共用一个动词而不是各占一条(判词在协议那条动词上)。
       * `undefined` = 这一帧没说菜单,主进程保留上一份。
       */
      applyAppMenuSpec(menu)
    },
    // 查找是视图状态,所以它走这条通道而不是资源面(判词在协议那两条上)。
    find: request => { service.get(request.viewId)?.findInPage(request.text, { forward: request.forward }) },
    findStop: viewId => { service.get(viewId)?.stopFindInPage() },
  })

  /*
   * 设置里那一格 CDP 开关 → `<store>/run/cdp.json`(B2′,§9-4)。
   *
   * **它挂在这里而不是设置域里**:`--remote-debugging-port` 只能在 app `ready`
   * 之前加,而设置是装配之后才读得到的 —— 折叠这件事因此是宿主的活,与
   * `applyCdpFlag` 同家(判据全文在 `cdp-settings.ts` 的文件头)。
   *
   * 写失败只记一行:这一格砸了的全部后果是「下次启动 CDP 口状态没跟上」,
   * 不该让它把一次保存设置炸掉。
   */
  /*
   * 名册变更 → 后果(B3-b)。**删一格身份**才有后果,而那两步的次序是判据本身:
   * 先关掉它的 tab、再清它的分区(反过来做等于清一半,判词整段在 `profiles.ts`)。
   * 与 CDP 那一格同一条判例:设置域只管存,「会让数据消失」这件事是宿主的活。
   */
  const offProfiles = installBrowserProfilesWatcher({
    readSettings: () => getSettings(),
    getBroadcaster: () => getSettingsEventBroadcaster(),
    setBroadcaster: next => { configureSettingsEventBroadcaster(next) },
    onTable: table => { profiles = table },
    closeTabs: profile => service.closeProfileTabs(profile),
    clearPartition: profile => sessionPolicy.clear(profile),
    onError: (profile, error) => { log.error('browser profile clear failed', { profile }, error) },
  })

  const offCdpSettings = installCdpSettingsWatcher({
    ...(options.storePath ? { storePath: options.storePath } : {}),
    readSettings: () => getSettings(),
    getBroadcaster: () => getSettingsEventBroadcaster(),
    setBroadcaster: next => { configureSettingsEventBroadcaster(next) },
    onError: error => { log.error('cdp launch flag write failed', undefined, error) },
  })

  log.info('browser host installed', {
    tabs: service.list().length,
    profiles: profiles.ids.length,
    defaultProfile: profiles.defaultProfile,
  })

  let disposed = false
  return {
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      offCdpSettings()
      offProfiles()
      offIpc()
      /*
       * 菜单的推送口(K4)。排在 `offIpc()` 之后、别的一切之前:这一刻起菜单上
       * 点一下只记一行 debug,而菜单本身**不拆** —— 它是 `app` 级的,比这块地长命。
       */
      offMenuSender()
      /*
       * 先把还悬着的每一问按拒结掉,**再**摘 provider:反过来的话那几条
       * `permissionResolved` 会打在一只已经 dispose 的 hub 上(它自己吞得掉,
       * 但页面那边等的 `callback` 就真的没人调了)。
       */
      permissions.dispose()
      for (const off of downloadsOff) off()
      downloadsOff.length = 0
      // 这几格分区不再跟着重套代理 —— 视图马上就要摘掉,而 `Session` 对象本身
      // 是 Electron 的(`fromPartition` 对同一个分区名永远交回同一个),留在策略
      // 的登记表里只会让下一次 `apply` 对着一批没人用的面空套。
      for (const off of proxyOff) off()
      proxyOff.length = 0
      // 先摘 provider(内核那只注销会先掐在飞、等它们收场),再拆视图 —— 反过来的话
      // 一次在飞的 `read page` 会打在一片已经销毁的 webContents 上。
      await unmount()
      provider?.dispose()
      provider = undefined
      for (const off of keymapOff.values()) off()
      keymapOff.clear()
      tabIdByContents.clear()
      layout.clear()
      service.dispose()
      log.info('browser host disposed')
    },
  }
}
