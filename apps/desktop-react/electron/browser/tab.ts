/**
 * 一格 tab = **一份状态 + 一片惰性的 `WebContentsView`**(方案 §9-5)。
 *
 * ## 惰性的理由
 *
 * tab 表落在 `<store>/browser/tabs.json`,重启时按表重建。如果重建 = 立刻建八片
 * `WebContentsView` 并各自 `loadURL`,那么开机就是八个渲染进程 + 八次出网,而用户
 * 也许一格都不会看。所以「有记录、无视图」是一个**正常状态**:壳报来第一个
 * `visible` 或 `activate` 才建视图并加载。
 *
 * 这也把 `opened` 这条事件的产地钉死了:它由「视图真的建起来了」那一刻发,而不是
 * 由「表里多了一行」—— 后者是账本的事实,前者才是「这一格开着」。
 *
 * ## 藏起来的那一格被节流到 1Hz,这是**接受的形**
 *
 * B0-② 实测:`setVisible(false)` 的视图 `visibilityState` 变 `hidden`,Chromium 把它的
 * 渲染节流到每秒一帧(网络与定时器照走)。所以切走的那一格页面上的动画会变慢 ——
 * 这与真 Chrome 的后台标签页是同一个形,**不要**为此调 `setBackgroundThrottling(false)`:
 * 那等于让八格看不见的 tab 每格 60fps 地烧 CPU,换来的是没人在看的那几帧。
 * 遮挡快照那一侧照着这个上限走(`layout.ts` 的 1Hz 重拍)。
 *
 * ## 零 electron import(DIP)
 *
 * 视图由注入的 `BrowserViewFactory` 造。真工厂在 `index.ts` 里 `new WebContentsView(...)`,
 * 测试里是一只记调用的替身 —— 于是「事件怎么折进状态」「惰性有没有真的惰」这两件
 * 事在 vitest 里量得到。
 */

import type { BrowserTabPatch, BrowserTabState, BrowserZoomDirection } from './tab-state.js'
import { createTabState, nextZoomLevel, reduceTabState } from './tab-state.js'
import type { BrowserViewPreferences, WindowOpenDecision } from './session-policy.js'
import { decideWindowOpen, isAllowedNavigation } from './session-policy.js'
import type { BrowserFindReadout } from './find.js'
import { beginsNewFindSession, foldFoundInPage } from './find.js'

/** `webContents.navigationHistory` 上用到的那几口。 */
export interface NativeNavigationHistory {
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
}

/** `capturePage()` 交回来的那只 NativeImage 上用到的两口。 */
export interface NativeImageLike {
  isEmpty(): boolean
  toDataURL(): string
}

/** `WebContents` 上这只文件用到的那一片。 */
export interface NativeWebContents {
  on(event: string, listener: (...args: never[]) => void): unknown
  setWindowOpenHandler(handler: (details: { url: string; disposition?: string }) => { action: 'deny' }): void
  loadURL(url: string): Promise<void>
  reload(): void
  stop(): void
  focus(): void
  close(): void
  isDestroyed(): boolean
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  capturePage(): Promise<NativeImageLike>
  /** 页内查找(B3-a)。`findNext` 的判据在 `find.ts` 的 `beginsNewFindSession` 上。 */
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean }): number
  /** `'clearSelection'` = 收起高亮并把选区也清掉(壳那一行关掉时要的正是这一档)。 */
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void
  /**
   * 页面缩放级(K3)。**读也在这里**:真源是 Chromium 自己那一格,
   * 状态里那份是它的投影 —— 拿投影当被加的数会在任何一条我们没经手的路上
   * (页面自己 ⌘滚轮、以后的百分比丸)悄悄分叉。
   */
  getZoomLevel(): number
  setZoomLevel(level: number): void
  /** 页面当前是否在播放声音。测试替身可以不实现。 */
  isCurrentlyAudible?(): boolean
  readonly navigationHistory: NativeNavigationHistory
}

/** `WebContentsView` 上这只文件用到的那一片。 */
export interface NativeView {
  readonly webContents: NativeWebContents
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void
  setVisible(visible: boolean): void
}

export type BrowserViewFactory = (preferences: BrowserViewPreferences) => NativeView

/** 一格 tab 向外说的话。service 收着,转手给 provider 发成资源事件。 */
export interface BrowserTabObserver {
  /** 状态折过一次,而且**真的变了**(reducer 答的身份不等)。 */
  onState(tab: BrowserTab, patch: BrowserTabPatch): void
  /**
   * 视图已创建。`reopened: true` 表示标签页被释放后重新创建:需要重新注册视图,
   * 但不应再次发送「已打开」事件。
   */
  onOpened(tab: BrowserTab, info?: { reopened: boolean }): void
  /** 页面要开一扇新窗。service 把它折成一格新 tab(或者拒掉)。 */
  onWindowOpen(tab: BrowserTab, decision: WindowOpenDecision): void
  /**
   * 一次页内查找的读数(B3-a)。
   *
   * **它经的是观察者链,而不是资源事件**:查找是视图状态,`browser:` 的自述里
   * 一个字都没有它(判词在 `native-view-protocol.ts` 的 `verb: 'find'` 上)。
   * 走这条链的先例是 `onMaterialized` / `onDematerialized` —— 那两条同样是窗口
   * 系统的事实,同样由 service 转手给装配点,装配点再经 `host:native-view` 推回壳。
   */
  onFind(tab: BrowserTab, readout: BrowserFindReadout): void
}

/** 读页面正文的字数上限(P0)。超出截断,并在正文末尾说明截断了。 */
export const PAGE_TEXT_MAX_CHARS = 20_000

const READ_TEXT_SCRIPT = `(() => {
  const root = document.body || document.documentElement
  return root ? root.innerText || '' : ''
})()`

export interface BrowserTabInit {
  readonly id: string
  readonly profile: string
  readonly url?: string
  readonly title?: string
}

export interface BrowserTabDeps {
  readonly createView: BrowserViewFactory
  readonly preferencesFor: (profile: string) => BrowserViewPreferences
  readonly observer: BrowserTabObserver
  /**
   * 这一格身份的网络策略落地了没有(2026-09-12)。**每一发 `loadURL` 之前等它**。
   *
   * 判词整段在 `electron/network-proxy.ts` 的文件头:`setProxy` 是异步的,分区
   * 又是懒建的,回放还没落地就把第一发请求打出去 = **直连一发** —— 在只有代理
   * 能出网的网络上那一发不是慢,是失败,而且泄露直连 IP。旧壳
   * (`whenBrowserPartitionReady`)立的这条判例,原样搬过来。
   *
   * 缺席 = 这台宿主没有这件事,行为与从前逐字相同。
   */
  readonly ready?: (profile: string) => Promise<void>
}

export class BrowserTab {
  private current: BrowserTabState
  private view: NativeView | undefined
  private readonly deps: BrowserTabDeps
  /**
   * 还没建视图时攒下的那一发导航(`navigate` 先于第一次 `activate` 到)。
   *
   * **它不是「这一格的地址」** —— 地址那一句已经进状态了(判词在 `navigate` 上)。
   * 这里攒的只是「视图建起来那一刻要打出去的那一发」,寿命到 `materialize` 为止。
   */
  private pendingUrl: string | undefined
  /**
   * 上一次找的那个词(B3-a)。**只为算 `findNext` 而存在** —— 它不是状态,
   * 不发事件、不落盘、不进 `BrowserTabState`:查找是视图状态,而视图状态的寿命
   * 是这片视图。视图一摘(`dispose`)它就没了,与那块查找高亮一起。
   */
  private findText: string | undefined
  private disposed = false
  /** 视图是否创建过;释放后再次创建时据此标记 `reopened`。 */
  private openedOnce = false
  /** 被释放的次数,用于内存报告。 */
  private hibernations = 0

  constructor(init: BrowserTabInit, deps: BrowserTabDeps) {
    this.current = createTabState(init)
    this.deps = deps
    this.pendingUrl = init.url && init.url.length > 0 ? init.url : undefined
  }

  get id(): string { return this.current.id }
  get state(): BrowserTabState { return this.current }
  /** 视图建起来了没有。`false` = 账上有这一格,但它还没花过一个渲染进程。 */
  get materialized(): boolean { return this.view !== undefined }
  /** 只给 layout 用:把这一格的视图交出去登记。没建就是 `undefined`。 */
  get nativeView(): NativeView | undefined { return this.view }

  /**
   * 把视图**真的建出来**并把攒着的那发导航打出去。幂等。
   *
   * 由 service 在收到这一格的第一个 `visible` / `activate` 时调。没有 URL 的一格
   * (起始页)照样建视图 —— 壳那边画的是自己的 DOM 起始页,视图在它底下,
   * `setVisible(false)` 由 layout 说了算,不是这里。
   */
  materialize(): void {
    if (this.disposed || this.view) return
    const view = this.deps.createView(this.deps.preferencesFor(this.current.profile))
    this.view = view
    this.wire(view.webContents)
    const reopened = this.openedOnce
    this.openedOnce = true
    this.deps.observer.onOpened(this, { reopened })
    const pending = this.pendingUrl
    this.pendingUrl = undefined
    if (pending) void this.load(pending)
  }

  /**
   * 去一个地址。
   *
   * ── 判词:**`url` 是这一格的地址(要去哪儿),到没到看 `loading`** ─────────
   *
   * `navigate` 与 `open` 从此同一口径 —— `createTabState(init)` 那一刻 `url` 就
   * 已经是目标地址了(`BrowserLeaf` 起始页那段注释写着「不必等 `did-navigate`」),
   * 所以走这条路的一格没有理由是另一种说法。于是这里**先**把状态改成「这一格
   * 现在的地址是它、而且在路上」,**再**去打那一发。
   *
   * 从前它一个字都不改状态,代价是 2026-09-17 逐帧量到的那一闪:壳的乐观补丁在
   * 8ms 把 `row.url` 写成目标地址、起始页摘掉;18ms 后端推来 `loading` 事实、壳
   * 重拉 tabs 表,读到的 `url` **仍是空串**(它要等到 1238ms 的 `did-navigate`
   * 才进状态)→ 23ms 起始页又装了回来。判词一句话:**一个会说谎半秒的读数,
   * 上游每个人都要替它写一段兜底**。
   *
   * 视图还没建 = 把那一发记下来,等 `materialize` 那一刻再打 —— 而不是「为了导航
   * 顺手把视图建出来」:那会让 AI 的一次 `navigate` 悄悄花掉一个渲染进程,而屏幕
   * 上什么都没有。**状态那一句两支都走**:账上这一格的地址就是它,只是还没有一片
   * 视图去兑现。
   *
   * 被拒的地址(`isAllowedNavigation` 假)**行为不变**:只留一句错话,`url` 一个
   * 字不动 —— 那一格没有去、也不会去,不该顶着一个它永远到不了的地址。
   *
   * 重复的那一发不会多发事件:`did-navigate` 之后 patch 同一个 url,
   * `reduceTabState` 逐格比完答的是**同一个对象**,`patch()` 见身份相等就返回。
   */
  navigate(url: string): void {
    if (this.disposed) return
    if (!isAllowedNavigation(url)) {
      this.patch({ error: `Blocked navigation to ${url}`, loading: false })
      return
    }
    this.patch({ url, loading: true, error: undefined })
    if (!this.view) {
      this.pendingUrl = url
      return
    }
    void this.load(url)
  }

  back(): void { const h = this.history(); if (h?.canGoBack()) h.goBack() }
  forward(): void { const h = this.history(); if (h?.canGoForward()) h.goForward() }
  reload(): void { this.alive()?.reload() }
  stop(): void { this.alive()?.stop() }
  focus(): void { this.alive()?.focus() }

  /**
   * 把这一页放大 / 缩小 / 回到实际大小(K3)。
   *
   * **没有视图 = 什么都不做**,与 `findInPage` / `readText` 逐字同一条判据:
   * 一次缩放不该把一片惰性的视图建出来(那会让一下按键悄悄花掉一个渲染进程,
   * 而屏幕上什么都没有)。同一条判据的另一半是**状态也不动** —— 记下一个没有
   * 视图去兑现的级数,就是让 `zoomLevel` 这一格开始说谎。
   */
  zoom(direction: BrowserZoomDirection): void {
    const wc = this.alive()
    if (!wc) return
    const next = nextZoomLevel(wc.getZoomLevel(), direction)
    wc.setZoomLevel(next)
    this.patch({ zoomLevel: next })
  }

  /**
   * 在这一页里找一个词(B3-a)。
   *
   * **没有视图 = 什么都不做**,与 `readText` 那一句同一条判据:一次查找不该把
   * 一片惰性的视图建出来(那会让壳上一行输入框悄悄花掉一个渲染进程,而屏幕上
   * 什么都没有)。空词走 `stopFindInPage` —— 「找一个空串」在 Chromium 那儿是
   * 一次抛,而人删光输入框时要的本来就是「别找了」。
   */
  findInPage(text: string, options: { forward?: boolean } = {}): void {
    const wc = this.alive()
    if (!wc) return
    if (!text) {
      this.stopFindInPage()
      return
    }
    // `findNext` 的意思与它的名字是反的(true = 开一段新会话)—— 整段判词在
    // `find.ts` 的 `beginsNewFindSession` 上,那是 `gate:browser` ⑫ 判红挖出来的。
    const findNext = beginsNewFindSession(this.findText, text)
    this.findText = text
    try {
      wc.findInPage(text, { forward: options.forward !== false, findNext })
    } catch {
      // 页面在这中间导航走了 / 上下文没了。一次找不成不是一次崩溃。
    }
  }

  /** 收起查找:清高亮、清选区、忘掉上一个词(下一次一定是「从头重找」)。 */
  stopFindInPage(): void {
    this.findText = undefined
    const wc = this.alive()
    if (!wc) return
    try {
      wc.stopFindInPage('clearSelection')
    } catch {
      // 同上。
    }
  }

  /**
   * 页面正文(P0 = `innerText`)。**没有视图 = 没有正文**,答空串而不是去把视图
   * 建出来:一次读不该有副作用(§2 不变量 1「读无效果」是结构性的)。
   *
   * 可读性抽取(去导航栏 / 去广告)住在 runtime,壳不该 import runtime —— 留账,
   * B3 走 core 侧 `web_open` 同一个函数。
   */
  async readText(maxChars = PAGE_TEXT_MAX_CHARS): Promise<string> {
    const wc = this.alive()
    if (!wc) return ''
    let raw = ''
    try {
      raw = String(await wc.executeJavaScript(READ_TEXT_SCRIPT, false) ?? '')
    } catch {
      // 页面在读的中途导航走了 / 上下文没了。空串是事实,不是一次失败。
      return ''
    }
    if (raw.length <= maxChars) return raw
    return `${raw.slice(0, maxChars)}\n…[truncated at ${maxChars} characters]`
  }

  /** 一张 PNG dataURL。没有视图 / 拍空 = `undefined`(不编一张白图)。 */
  async capture(): Promise<string | undefined> {
    const wc = this.alive()
    if (!wc) return undefined
    try {
      const image = await wc.capturePage()
      return image.isEmpty() ? undefined : image.toDataURL()
    } catch {
      return undefined
    }
  }

  /** 摘掉视图。幂等。状态留着 —— 关不关这一格是 service 的事。 */
  dispose(): void {
    this.disposed = true
    this.releaseView()
  }

  /** 页面当前是否在播放声音;没有视图时为 `false`。 */
  get audible(): boolean {
    try { return this.alive()?.isCurrentlyAudible?.() === true } catch { return false }
  }

  get hibernationCount(): number { return this.hibernations }

  /**
   * 释放渲染进程,保留标签页。
   *
   * 地址和标题保留在状态中;下次可见或被激活时重新创建视图并加载当前地址。
   * 页面状态(滚动位置、未提交的表单内容、前进 / 后退历史)会丢失。
   * 没有视图或已关闭时返回 `false`。
   */
  hibernate(): boolean {
    if (this.disposed || !this.view) return false
    const url = this.current.url
    this.pendingUrl = url && isAllowedNavigation(url) ? url : undefined
    this.releaseView()
    this.hibernations++
    // 进程已关闭,加载状态与前进 / 后退状态清空,重新创建后由页面重新报告。
    this.patch({ loading: false, canGoBack: false, canGoForward: false })
    return true
  }

  private releaseView(): void {
    this.findText = undefined
    const wc = this.view?.webContents
    this.view = undefined
    if (wc && !wc.isDestroyed()) {
      try { wc.close() } catch { /* 窗已经没了 */ }
    }
  }

  private history(): NativeNavigationHistory | undefined {
    return this.alive()?.navigationHistory
  }

  private alive(): NativeWebContents | undefined {
    const wc = this.view?.webContents
    return wc && !wc.isDestroyed() ? wc : undefined
  }

  private async load(url: string): Promise<void> {
    /*
     * **先等网络策略落地,再取 webContents**(不是反过来):这一等可能跨好几拍,
     * 这中间这一格可能已经被关掉了,所以 `alive()` 要在等完之后问。
     */
    const ready = this.deps.ready?.(this.current.profile)
    if (ready) await ready
    const wc = this.alive()
    if (!wc) return
    try {
      await wc.loadURL(url)
    } catch {
      // `did-fail-load` 会把人话带过来;这里吞掉 promise 的那一份,免得
      // 一次取消的导航变成 unhandledRejection。
    }
  }

  private patch(patch: BrowserTabPatch): void {
    const next = reduceTabState(this.current, patch)
    if (next === this.current) return
    this.current = next
    this.deps.observer.onState(this, patch)
  }

  /** 导航旗标每次都从 webContents 现问 —— 它是唯一知道自己走过哪儿的人。 */
  private navFlags(): BrowserTabPatch {
    const h = this.history()
    if (!h) return {}
    return { canGoBack: h.canGoBack(), canGoForward: h.canGoForward() }
  }

  private wire(wc: NativeWebContents): void {
    wc.setWindowOpenHandler(details => {
      this.deps.observer.onWindowOpen(this, decideWindowOpen(details.url, details.disposition))
      // 永远 deny:tab 由 service 自己建,`allow` 会开一扇我们管不着的窗。
      return { action: 'deny' }
    })

    // 只处理当前视图的事件:释放后,旧 webContents 在关闭过程中仍可能发出事件。
    const on = (event: string, listener: (...args: never[]) => void) => {
      wc.on(event, ((...args: never[]) => {
        if (this.view?.webContents !== wc) return
        listener(...args)
      }) as never)
    }

    on('did-start-loading', () => { this.patch({ loading: true }) })
    on('did-stop-loading', () => { this.patch({ loading: false, ...this.navFlags() }) })
    on('page-title-updated', ((_e: unknown, title: string) => {
      this.patch({ title })
    }) as never)
    on('page-favicon-updated', ((_e: unknown, favicons: string[]) => {
      // **只收 data URL**。旧壳会拿 `net.request` 去把远程图标抓成 data URL —— 那是
      // 一次由图标触发的出网,而图标这一格值不了那个代价(B3 接一条按分区抓的路)。
      const icon = favicons.find(url => url.startsWith('data:'))
      this.patch({ favicon: icon })
    }) as never)
    on('did-navigate', ((_e: unknown, url: string) => {
      /*
       * 换了一页 = 那块查找高亮没了(Chromium 自己清的)。忘掉上一个词,
       * 于是下一下 ↵ 是「在这一页从头找」而不是「接着上一页的第 7 处往下」——
       * 后者的接着处根本不存在。壳那一行照旧开着、词照旧留着(与浏览器一族
       * 的手感一致),它只是要重新按一次。
       */
      this.findText = undefined
      this.patch({ url, error: undefined, ...this.navFlags() })
    }) as never)
    /*
     * 查找读数(B3-a)。**一发不落地全推** —— Chromium 对一次查找通常先报一发
     * 中间结果再报一发定稿,两发都推让读数一路长上去正是「它还在数」的诚实形态
     * (判词整段在 `find.ts` 的文件头)。
     */
    on('found-in-page', ((_e: unknown, result: unknown) => {
      this.deps.observer.onFind(this, foldFoundInPage(result))
    }) as never)
    on('did-navigate-in-page', ((_e: unknown, url: string, isMainFrame: boolean) => {
      if (isMainFrame) this.patch({ url, ...this.navFlags() })
    }) as never)
    on('did-fail-load', ((_e: unknown, code: number, description: string, _url: string, isMainFrame: boolean) => {
      // `-3` = ERR_ABORTED,用户自己按了停 / 换了地址。那不是坏,是一次正常的取消。
      if (!isMainFrame || code === -3) return
      this.patch({ loading: false, error: description || `Load failed (${code})` })
    }) as never)
    on('render-process-gone', () => {
      this.patch({ loading: false, error: 'The page crashed' })
    })
  }
}
