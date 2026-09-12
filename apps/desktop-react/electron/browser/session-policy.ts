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
 * ## 权限:一族问、其余拒(B3-a 起)
 *
 * B1-a 一律 `false`,理由是那时候壳里没有询问面 ——「今天壳里没有那张询问面,
 * `callback(true)` 会是一次谁都没看见的授权」。B3-a 把那张面建起来了
 * (`content/permission/WebPermissionCard.tsx`),于是「问」这条路第一次成立:
 * 哪一族能问、其余为什么一律拒、超时为什么按拒算,整段判词在 `permission.ts` 上。
 *
 * **没有注入 `ask` 的时候仍然全拒** —— 那是同一句话的另一半:没人能答的时候,
 * 唯一诚实的答案就是不。既有的每一份替身 session(单测)因此行为逐字不变。
 *
 * ## `setPermissionCheckHandler` 仍然一律 `false`(留账)
 *
 * 那一口是**同步**的检查面(`navigator.permissions.query()` 之类),它只答得出
 * 真 / 假两档,答不出「会问你一下」。答真 = 在没问任何人之前先说已经准了(那正是
 * 上面那句话禁的);答假 = 页面 `query()` 读到 `denied`,而它真去要的时候我们照样
 * 会弹一问。两害相权取后者:一次对页面保守的说法,好过一次对用户的静默授权。
 * 真解是 Electron 那一口能答三档,今天不能 —— 记在这里,不在这里将就。
 *
 * ## 零 electron import(DIP)
 *
 * `session.fromPartition` 由调用方注入 —— 于是这只文件在 vitest 里测得动
 * (`createShellHostPorts` 的前车之鉴:一旦顶层 `import { … } from 'electron'`,
 * 整棵测试树就只能靠 mock 电梯)。
 */

import { userAgentPolicy } from './user-agent.js'
import { decideWebPermission } from './permission.js'

/** 一格 profile 的持久分区名。P0 只有一个 `default`;多 profile 的设置面归 B3。 */
export const DEFAULT_BROWSER_PROFILE = 'default'

export function browserPartitionFor(profile: string): string {
  return `persist:browser-${profile}`
}

/** Electron 交给权限处理器的那第四格(它才知道是**谁**在问)。 */
export interface BrowserPermissionDetails {
  readonly requestingUrl?: string
  readonly securityOrigin?: string
}

/** Electron `Session` 上这只文件用到的那几口。 */
export interface BrowserSessionLike {
  getUserAgent(): string
  setUserAgent(userAgent: string): void
  setPermissionRequestHandler(
    handler:
      | ((
          webContents: unknown,
          permission: string,
          callback: (granted: boolean) => void,
          details?: BrowserPermissionDetails,
        ) => void)
      | null,
  ): void
  setPermissionCheckHandler(handler: (() => boolean) | null): void
}

export type BrowserSessionFactory = (partition: string) => BrowserSessionLike

/**
 * 问一次网页权限,答一个准不准。缺席 = 这台宿主答不出 = 一律拒(判词在文件头)。
 *
 * `webContents` 原样带出去:policy 不认识 tab,把它折成 tabId 是装配点的活
 * (它手上才有那张「哪片视图属于哪一格」的表)。
 */
export type BrowserPermissionAsk = (request: {
  readonly webContents: unknown
  readonly permission: string
  readonly origin: string
}) => Promise<boolean>

export interface BrowserSessionPolicyOptions {
  /** 可询问的那一族走它。缺席 = 全拒。 */
  readonly ask?: BrowserPermissionAsk
  /**
   * 一格分区第一次建出来那一刻。装配点拿它挂 `will-download` ——
   * **每个 profile 各挂一次**(多 profile 是 B3 的账,这条缝先留对)。
   */
  readonly onSession?: (session: BrowserSessionLike, partition: string) => void
}

/**
 * 请求来自哪儿。`details` 缺席 / 拼不出主机名时答空串 —— 卡上那句话据它分档
 * (空 = 只说「这个网页」,不编一个来源出来)。
 */
export function originOfPermissionRequest(details: BrowserPermissionDetails | undefined): string {
  const raw = details?.securityOrigin || details?.requestingUrl || ''
  if (!raw) return ''
  try {
    return new URL(raw).origin
  } catch {
    return raw
  }
}

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
  private readonly options: BrowserSessionPolicyOptions
  private readonly sessions = new Map<string, BrowserSessionLike>()

  constructor(fromPartition: BrowserSessionFactory, options: BrowserSessionPolicyOptions = {}) {
    this.fromPartition = fromPartition
    this.options = options
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
    created.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const ask = this.options.ask
      if (!ask || decideWebPermission(permission) !== 'ask') {
        callback(false)
        return
      }
      /*
       * 问出去的那一发**必须有一个答案落回 `callback`**:不调它,页面那边就永远
       * 悬着(`getCurrentPosition` 的两个回调一个都不来)。所以连 `ask` 自己炸了
       * 都要兜一句拒 —— 一次拒是一个说得出口的结局,一次永远不回不是。
       */
      void ask({ webContents, permission, origin: originOfPermissionRequest(details) })
        .then(allow => { callback(allow) })
        .catch(() => { callback(false) })
    })
    created.setPermissionCheckHandler(() => false)
    this.sessions.set(partition, created)
    this.options.onSession?.(created, partition)
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
