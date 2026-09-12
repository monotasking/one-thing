/**
 * `BrowserService` —— tab 表的**真源**,以及它的落盘(方案 §9-5)。
 *
 * ## 表的家在主进程,不在渲染进程的 localStorage
 *
 * v2 初稿写「url 记在本地小账本(壳侧)」——那是把真源的一半搬回壳里:同一件事
 * 两个产地,而其中一个还会被清缓存清掉。表落在 `<store>/browser/tabs.json`,于是
 * ①tab id 跨重启稳定(拼贴树上的 `browser:<id>` 重启后照常指着东西);②会话恢复
 * 白拿;③`opened` 这条事实的产地只有一个 —— 视图真的建起来那一刻。
 *
 * 终端那条「本地小账本」不改,理由相反:PTY 真的死了,壳记 cwd 只是为了「再开
 * 一个」那颗钮。
 *
 * ## 惰性重建
 *
 * 启动时按表建 `BrowserTab`(**有记录、无视图**),壳报来第一个 `visible` /
 * `activate` 才 `materialize()`。见 `tab.ts` 的文件头。
 *
 * ## 落盘:节流 + 原子写
 *
 * 一次导航会连着改几格状态(loading / url / title / 图标),每格都写盘是拿磁盘换
 * 一份随时可以重建的派生数据。所以攒 `PERSIST_DELAY_MS` 再写一次,并且走
 * `writeJsonFile`(tmp + rename)—— 半截文件会在下次启动时被 `parseTabTable`
 * 当成空账本吞掉,那是一次静默的数据丢失。
 *
 * 零 electron import:视图工厂、session 策略、时钟全是注入的(DIP)。
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { readJsonFile, writeJsonFile } from '@onething/core/storage'
import { getOnethingStorePath } from '@onething/runtime/storage'
import type { BrowserTabPatch, BrowserTabState, PersistedTabTable } from './tab-state.js'
import { EMPTY_TAB_TABLE, parseTabTable, persistTab } from './tab-state.js'
import type { BrowserViewFactory } from './tab.js'
import { BrowserTab } from './tab.js'
import type { BrowserFindReadout } from './find.js'
import type { WindowOpenDecision } from './session-policy.js'
import { BrowserSessionPolicy, DEFAULT_BROWSER_PROFILE } from './session-policy.js'

/** 攒够这么久再写一次盘。与 sessions 仓库的 300ms 节流同一个量级、同一条理由。 */
export const PERSIST_DELAY_MS = 300

export function getBrowserTabsPath(storePath?: string): string {
  return path.join(getOnethingStorePath(storePath ? { storePath } : {}), 'browser', 'tabs.json')
}

/** service 向外说的四句话。`index.ts` 把它们转手给 provider 发成资源事件。 */
export interface BrowserServiceObserver {
  onOpened(tab: BrowserTab): void
  onClosed(tabId: string): void
  onNavigated(tab: BrowserTab): void
  onLoading(tab: BrowserTab): void
  /** 视图刚建出来,交给 layout / keymap-bridge 登记。 */
  onMaterialized(tab: BrowserTab): void
  /** 视图要摘了,登记方先撤。 */
  onDematerialized(tabId: string): void
  /**
   * 一次页内查找的读数(B3-a)。**它与上面五条不同族,而那是有意的**:前五条是
   * 数据面 / 生命周期的事实,这一条是**视图状态**(查找不进 `browser:` 的自述,
   * 判词在 `native-view-protocol.ts` 的 `verb: 'find'` 上)。它经这条链只是因为
   * 持有 webContents 的是 tab,而 service 是 tab 的唯一持有者 —— 与
   * `onMaterialized` / `onDematerialized` 同一个理由、同一条路。
   */
  onFind(tab: BrowserTab, readout: BrowserFindReadout): void
}

export interface BrowserServiceOptions {
  readonly sessionPolicy: BrowserSessionPolicy
  readonly createView: BrowserViewFactory
  readonly observer: BrowserServiceObserver
  /** 落盘路径。缺席 = 按当前 store 解析。测试传临时目录。 */
  readonly tabsPath?: string
  /**
   * 新 tab 缺省用哪一格身份(B3-b)。**是一只函数不是一个值**:名册与缺省
   * 住在设置里,人在设置页改完那一刻起就该生效 —— 缓存一个值等于「改了要重启」,
   * 而这一格没有任何需要重启的理由(与 CDP 那一格刚好相反)。
   * 缺席 = 出厂那一格(单测与老装配点照旧)。
   */
  readonly defaultProfile?: () => string
  /** 测试缝:把节流写盘换成同步。 */
  readonly persistDelayMs?: number
}

export class BrowserService {
  private readonly options: BrowserServiceOptions
  private readonly tabs = new Map<string, BrowserTab>()
  private order: string[] = []
  private active: string | null = null
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private readonly tabsPath: string
  private disposed = false

  constructor(options: BrowserServiceOptions) {
    this.options = options
    this.tabsPath = options.tabsPath ?? getBrowserTabsPath()
  }

  /**
   * 按账本重建。**不建任何视图**(见文件头)。只在构造之后调一次。
   *
   * 读坏了 = 空账本,不是一次崩溃(`parseTabTable` 的判据)。
   */
  restore(): void {
    const table = parseTabTable(readJsonFile<unknown>(this.tabsPath, EMPTY_TAB_TABLE))
    for (const row of table.tabs) {
      const tab = this.construct({ id: row.id, profile: row.profile, url: row.url, title: row.title })
      this.tabs.set(tab.id, tab)
      this.order.push(tab.id)
    }
    this.active = table.activeId
  }

  get activeId(): string | null { return this.active }

  list(): BrowserTabState[] {
    return this.order.map(id => this.tabs.get(id)!.state)
  }

  get(tabId: string): BrowserTab | undefined { return this.tabs.get(tabId) }

  /**
   * 开一格。
   *
   * `background: true` 不抢活动 tab —— `window.open` 的 background-tab
   * disposition 与 AI 的「先开着别打扰我」走的是同一格。**开一格不等于建视图**:
   * 前台那一格顺手 `materialize`(用户 / AI 马上就要看它),后台那一格等壳报可见。
   */
  open(init: { url?: string; background?: boolean; profile?: string } = {}): BrowserTabState {
    const tab = this.construct({
      id: randomUUID(),
      // **点名 > 缺省 > 出厂**(B3-b)。缺省那一格现问(见 `defaultProfile` 的注),
      // 所以「在设置页把缺省身份改掉,下一格新 tab 就跟着变」不需要重启。
      profile: init.profile ?? this.options.defaultProfile?.() ?? DEFAULT_BROWSER_PROFILE,
      url: init.url,
    })
    this.tabs.set(tab.id, tab)
    this.order.push(tab.id)
    if (!init.background || this.active === null) {
      this.active = tab.id
      tab.materialize()
    }
    this.schedulePersist()
    return tab.state
  }

  /** 激活一格(顺手把它的视图建出来)。不存在的 id 静默忽略。 */
  activate(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    this.active = tabId
    tab.materialize()
    this.schedulePersist()
  }

  /** 壳报来第一个 `visible` 时调:惰性视图在这一刻落地。 */
  materialize(tabId: string): void {
    this.tabs.get(tabId)?.materialize()
  }

  /**
   * 关一格。**不自动补一格新的** —— 旧壳会在关掉最后一格时 respawn 一个起始页,
   * 那是因为它的面板没有「没有 tab」这个状态;拼贴树里一格 `browser:<id>` 就是一片
   * 叶,关掉 = 那片叶没了,壳自己会收拾。凭空补一格等于替用户开了一片他没要的叶。
   */
  close(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    this.tabs.delete(tabId)
    this.order = this.order.filter(id => id !== tabId)
    if (tab.materialized) this.options.observer.onDematerialized(tabId)
    tab.dispose()
    if (this.active === tabId) this.active = this.order[this.order.length - 1] ?? null
    this.options.observer.onClosed(tabId)
    this.schedulePersist()
  }

  /**
   * 关掉某一格身份下的**全部** tab(B3-b 删身份的第一步)。答关掉了几格。
   *
   * 它与 `close` 不是两条路:逐格走同一只 `close`(于是 `closed` 事件、
   * 视图摘除、活动位回落、落盘全部照旧发生)。这里多的只有「挑出哪几格」。
   */
  closeProfileTabs(profile: string): number {
    const doomed = this.order.filter(id => this.tabs.get(id)?.state.profile === profile)
    for (const id of doomed) this.close(id)
    return doomed.length
  }

  /** 全关 + 把攒着的那一发写出去。`dispose()` 用,幂等。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    // 先把表写下来**再**摘视图:摘的过程不改表,但一次退出该留下退出那一刻的账。
    this.persistNow()
    for (const [tabId, tab] of this.tabs) {
      if (tab.materialized) this.options.observer.onDematerialized(tabId)
      tab.dispose()
    }
    this.tabs.clear()
    this.order = []
    this.active = null
  }

  private construct(init: { id: string; profile: string; url?: string; title?: string }): BrowserTab {
    return new BrowserTab(init, {
      createView: this.options.createView,
      preferencesFor: profile => this.options.sessionPolicy.webPreferencesFor(profile),
      // 代理回放这一格的门(2026-09-12)。判词在 `BrowserTabDeps.ready` 上。
      ready: profile => this.options.sessionPolicy.ready(profile),
      observer: {
        onState: (tab, patch) => { this.onTabState(tab, patch) },
        onOpened: tab => {
          this.options.observer.onMaterialized(tab)
          this.options.observer.onOpened(tab)
        },
        onWindowOpen: (tab, decision) => { this.onWindowOpen(tab, decision) },
        onFind: (tab, readout) => { this.options.observer.onFind(tab, readout) },
      },
    })
  }

  private onTabState(tab: BrowserTab, patch: BrowserTabPatch): void {
    // 「地址变了」与「转圈变了」是两条不同的事实,读到它们的人要做的事不同
    // (前者重拉正文 / 换标题,后者只改进度条),所以分两条发而不是一条「变了」。
    if ('url' in patch || 'title' in patch || 'error' in patch) this.options.observer.onNavigated(tab)
    if ('loading' in patch) this.options.observer.onLoading(tab)
    if ('url' in patch || 'title' in patch) this.schedulePersist()
  }

  private onWindowOpen(tab: BrowserTab, decision: WindowOpenDecision): void {
    if (decision.kind !== 'tab') return
    this.open({ url: decision.url, background: decision.background, profile: tab.state.profile })
  }

  private schedulePersist(): void {
    if (this.disposed || this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persistNow()
    }, this.options.persistDelayMs ?? PERSIST_DELAY_MS)
    this.persistTimer.unref?.()
  }

  private persistNow(): void {
    const table: PersistedTabTable = {
      version: 1,
      tabs: this.order.map(id => persistTab(this.tabs.get(id)!.state)),
      activeId: this.active,
    }
    try {
      writeJsonFile(this.tabsPath, table)
    } catch {
      // 写不下去(盘满 / 只读)不该让浏览器停摆:这是一份可以重建的派生数据。
      // 代价是下次启动少几格 tab,而那远好过一次关不掉的错误。
    }
  }
}
