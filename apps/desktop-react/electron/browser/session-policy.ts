/**
 * 安全钳(方案 §2.2-7)—— 内嵌浏览器跑在**自己的**持久分区上,带自己的 UA、
 * 自己的权限策略、自己的导航白名单。
 *
 * ## 为什么不用 app UI 那个 defaultSession
 *
 * 三条,每条都是硬的:①持久 cookie / localStorage 要跨重启活着(登录才留得住),
 * 而 app 自己的 session 不该替一个陌生网站存东西;②app 的 CSP 会套在页面上;
 * ③UA / 权限 / 下载三样策略,浏览器与 app 要的是相反的两套 —— 浏览器要像 Chrome,
 * app 要什么都不许。
 *
 * ## 权限缺省全拒,而不是「问」
 *
 * P0 一律 `false`(摄像头 / 麦克风 / 地理位置 / 通知 / 剪贴板全拒)。改成按域询问是
 * B3。缺省拒不是保守,是**诚实**:今天壳里没有那张询问面,`callback(true)` 会是
 * 一次谁都没看见的授权。
 *
 * ## 零 electron import(DIP)
 *
 * `session.fromPartition` 由调用方注入 —— 于是这只文件在 vitest 里测得动
 * (`createShellHostPorts` 的前车之鉴:一旦顶层 `import { … } from 'electron'`,
 * 整棵测试树就只能靠 mock 电梯)。
 */

import { userAgentPolicy } from './user-agent.js'

/** 一格 profile 的持久分区名。P0 只有一个 `default`;多 profile 的设置面归 B3。 */
export const DEFAULT_BROWSER_PROFILE = 'default'

export function browserPartitionFor(profile: string): string {
  return `persist:browser-${profile}`
}

/** Electron `Session` 上这只文件用到的那几口。 */
export interface BrowserSessionLike {
  getUserAgent(): string
  setUserAgent(userAgent: string): void
  setPermissionRequestHandler(
    handler: ((webContents: unknown, permission: string, callback: (granted: boolean) => void) => void) | null,
  ): void
  setPermissionCheckHandler(handler: (() => boolean) | null): void
}

export type BrowserSessionFactory = (partition: string) => BrowserSessionLike

/**
 * 视图的 `webPreferences`。四格全是**关掉能力**:
 *
 *   · `sandbox: true` —— 渲染进程进 OS 沙箱;
 *   · `contextIsolation: true` —— 页面脚本与任何注入上下文隔离;
 *   · `nodeIntegration: false` —— 页面里没有 `require`;
 *   · **无 preload** —— 一个都不注入。B3 的元素拾取走 `executeJavaScript`
 *     的一次性注入(用完即走),不是常驻 preload:常驻的那一份是每一个页面
 *     永远带着的一把钥匙。
 */
export interface BrowserViewPreferences {
  readonly session: BrowserSessionLike
  readonly sandbox: true
  readonly contextIsolation: true
  readonly nodeIntegration: false
}

export class BrowserSessionPolicy {
  private readonly fromPartition: BrowserSessionFactory
  private readonly sessions = new Map<string, BrowserSessionLike>()

  constructor(fromPartition: BrowserSessionFactory) {
    this.fromPartition = fromPartition
  }

  /**
   * 取(必要时初始化)一格 profile 的 session。
   *
   * **UA 必须在这个分区上建出任何 `WebContentsView` 之前设好** —— `setUserAgent`
   * 对已经建好的 WebContents 不生效(Electron d.ts 上写着)。所以取 session 这一
   * 步就是设策略那一步,调用方拿到的永远是已经配好的那一个。
   */
  sessionFor(profile: string = DEFAULT_BROWSER_PROFILE): BrowserSessionLike {
    const partition = browserPartitionFor(profile)
    const existing = this.sessions.get(partition)
    if (existing) return existing

    const created = this.fromPartition(partition)
    // UA 那条判据只有 `user-agent.ts` 一份实现 —— 这里接上它,不重写一遍正则。
    created.setUserAgent(userAgentPolicy.apply(created.getUserAgent()))
    created.setPermissionRequestHandler((_webContents, _permission, callback) => { callback(false) })
    created.setPermissionCheckHandler(() => false)
    this.sessions.set(partition, created)
    return created
  }

  webPreferencesFor(profile: string = DEFAULT_BROWSER_PROFILE): BrowserViewPreferences {
    return {
      session: this.sessionFor(profile),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    }
  }
}

/**
 * `will-navigate` 的白名单:**只放 http(s) 与 `about:blank`**。
 *
 * 别的 scheme 一律拦下 —— `file://` 能读这台机器上的任何文件,`mailto:` /
 * 自定义 scheme 会把请求交给别的应用(旧壳那条 `shell.openExternal` 正是
 * 「误拖一个文件就被系统打开」那条判例的产地)。拦下 = 什么都不发生,不是
 * 「交给系统浏览器」:一个网页把用户悄悄踢出 app,是它自己就不该做到的事。
 */
export function isAllowedNavigation(url: string): boolean {
  if (url === 'about:blank') return true
  return /^https?:\/\//i.test(url)
}

/**
 * `setWindowOpenHandler` 的判决。
 *
 * `target=_blank` / `window.open` / ⌘-click 要的是**一格新 tab**,不是系统浏览器
 * ——一次搜索结果的点击逃出 app,内嵌浏览器就算坏了。所以 http(s) 交给 service
 * 开新 tab(前台还是后台由 disposition 说),其余 `deny` 并且**不外开**(理由同
 * `isAllowedNavigation`)。
 *
 * 返回给 Electron 的永远是 `{ action: 'deny' }`:tab 由我们自己建,`allow` 会让
 * Chromium 另开一扇我们管不着的窗。opener / postMessage 因此丢掉 —— OAuth 弹窗
 * 要它,那是 B3 的 `createWindow` 覆盖,本单不做。
 */
export type WindowOpenDecision =
  | { readonly kind: 'tab'; readonly url: string; readonly background: boolean }
  | { readonly kind: 'deny'; readonly url: string }

export function decideWindowOpen(url: string, disposition?: string): WindowOpenDecision {
  if (/^https?:\/\//i.test(url)) {
    return { kind: 'tab', url, background: disposition === 'background-tab' }
  }
  return { kind: 'deny', url }
}
