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

import { WebContentsView, ipcMain, session, type BrowserWindow } from 'electron'
import type { OnethingBackend } from '@onething/backend'
import { getLogger } from '@onething/backend/wiring/logging/index.js'
import {
  configureSettingsEventBroadcaster,
  getSettingsEventBroadcaster,
} from '@onething/backend/wiring/settings/events.js'
import { getSettings } from '@onething/backend/stores/settings.js'
import { NATIVE_VIEW_CHANNEL, type NativeViewPush } from '../native-view-protocol.js'
import { KeymapBridge } from './keymap-bridge.js'
import { installCdpSettingsWatcher } from './cdp-settings.js'
import { NativeViewLayout, type NativeViewHost } from './layout.js'
import { installNativeViewIpc } from './native-view-ipc.js'
import { BrowserResourceProvider, type BrowserOps, type BrowserTabView } from './resource-provider.js'
import { BrowserSessionPolicy } from './session-policy.js'
import { BrowserService, getBrowserTabsPath } from './service.js'
import type { BrowserTab, NativeView } from './tab.js'

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
  const sessionPolicy = new BrowserSessionPolicy(partition => session.fromPartition(partition))
  /** 每格 tab 一份「摘 keymap 监听」的退订。 */
  const keymapOff = new Map<string, () => void>()

  let provider: BrowserResourceProvider | undefined

  const viewOf = (tab: BrowserTab): BrowserTabView => ({
    ...tab.state,
    active: service.activeId === tab.id,
  })

  const service = new BrowserService({
    sessionPolicy,
    createView: preferences =>
      new WebContentsView({ webPreferences: preferences as never }) as unknown as NativeView,
    ...(options.storePath ? { tabsPath: getBrowserTabsPath(options.storePath) } : {}),
    observer: {
      onMaterialized: tab => {
        const view = tab.nativeView
        if (!view) return
        layout.register(tab.id, view)
        keymapOff.set(tab.id, keymap.attach(tab.id, view.webContents))
      },
      onDematerialized: tabId => {
        keymapOff.get(tabId)?.()
        keymapOff.delete(tabId)
        layout.release(tabId)
      },
      onOpened: tab => { provider?.emitOpened(viewOf(tab)) },
      onClosed: tabId => { provider?.emitClosed(tabId) },
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
    has: tabId => service.get(tabId) !== undefined,
    readText: (tabId, maxChars) => service.get(tabId)?.readText(maxChars) ?? Promise.resolve(''),
    capture: tabId => service.get(tabId)?.capture() ?? Promise.resolve(undefined),
    get: tabId => {
      const tab = service.get(tabId)
      return tab ? viewOf(tab) : undefined
    },
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
    keymap: chords => { keymap.setBoundChords(chords) },
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
  const offCdpSettings = installCdpSettingsWatcher({
    ...(options.storePath ? { storePath: options.storePath } : {}),
    readSettings: () => getSettings(),
    getBroadcaster: () => getSettingsEventBroadcaster(),
    setBroadcaster: next => { configureSettingsEventBroadcaster(next) },
    onError: error => { log.error('cdp launch flag write failed', undefined, error) },
  })

  log.info('browser host installed', { tabs: service.list().length })

  let disposed = false
  return {
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      offCdpSettings()
      offIpc()
      // 先摘 provider(内核那只注销会先掐在飞、等它们收场),再拆视图 —— 反过来的话
      // 一次在飞的 `read page` 会打在一片已经销毁的 webContents 上。
      await unmount()
      provider?.dispose()
      provider = undefined
      for (const off of keymapOff.values()) off()
      keymapOff.clear()
      layout.clear()
      service.dispose()
      log.info('browser host disposed')
    },
  }
}
