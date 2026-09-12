import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { nativeViewBridge } from './browser-port'
import type { NativeViewPush } from './browser-port'

/**
 * **内嵌浏览器的页内查找**(B3-a · 壳半边)。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ① 生命周期(这一格状态的寿命)
 * ══════════════════════════════════════════════════════════════════════════
 * | 事件 | 这里发生什么 |
 * | --- | --- |
 * | import 这只文件 | 一张空表。**零往返、零订阅** |
 * | 第一片浏览器叶挂载 | `useBrowserFind` 引用计数 1 → 订上那条推送(整壳一条) |
 * | 换宿主(拖去别的叶 / 撕浮窗 / 铺满) | **一格都不动**:状态按 tabId 存在模块里,不在组件里 |
 * | 叶卸载 | 计数减一;归零才退订。**这一格 tab 的查找状态留着** |
 * | 这一格 tab 关掉 | `closed` 事实到了 → `forgetBrowserFind`(见 `browser-source.ts` 的表) |
 * | HMR | `resetBrowserFind` —— 复用同一口拆卸,不写第二套 |
 *
 * ## 它为什么**不是**组件的 `useState`
 *
 * 判据与终端那一格逐字同一条(`content/terminal/session.ts` 的 `TerminalFindState`):
 * **这件事的寿命是那片视图,不是这次挂载**。查找的高亮与选区活在
 * `WebContentsView` 那块页面里,而那片视图跨换宿主、跨重挂都不掉
 * (§2.2-1 的那一格正是这么赚回来的)。放进组件 state 会让它们在一次重挂之后当场
 * 分叉:页面上还亮着十七处高亮,查找行却空了。
 *
 * ## 它为什么**不是**一条读数(query)
 *
 * 因为查找不进 `browser:` 的自述 —— 它是视图状态不是资源事实(判词整段在
 * `electron/browser/resource-spec.ts` 的「哪些东西不进这份自述」那一段)。所以这
 * 一路走的是窗口系统那条通道:发 `find` / `findStop` 两个动词,收 `find` 推送。
 *
 * ## 读数三档:不画 /「0」/「3/17」
 *
 * 与终端那一格**逐字同形**。没有抽成一处共用,理由是那一份今天住在
 * `content/terminal/TerminalLeaf.tsx` 里(`findReadout`),而那只模块 import 了
 * `./screen` —— 一条会把整个 xterm 拖进来的边。为一个四行纯函数让浏览器叶背上
 * xterm 不划算,而把它抬进一处共用文件要动 T2 那只**正在提交**的文件。
 * **留账**:T2 落库之后把两份合成 `content/find-readout.ts` 一处。
 */

/** 一格 tab 的查找状态。`active` 从 **1** 起(Chromium 口径);`0` = 没有当前命中。 */
export interface BrowserFindState {
  open: boolean
  query: string
  active: number
  total: number
}

export const CLOSED_FIND: BrowserFindState = { open: false, query: '', active: 0, total: 0 }

const states = new Map<string, BrowserFindState>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function browserFindOf(tabId: string): BrowserFindState {
  return states.get(tabId) ?? CLOSED_FIND
}

function patch(tabId: string, next: Partial<BrowserFindState>): void {
  const now = browserFindOf(tabId)
  const merged = { ...now, ...next }
  if (
    merged.open === now.open
    && merged.query === now.query
    && merged.active === now.active
    && merged.total === now.total
  ) return
  states.set(tabId, merged)
  emit()
}

/**
 * 读数那一格的字面。**纯函数** —— 三档只有一个产地。
 *
 * `active === 0` 那一档只报总数,不编一个序号出来:Chromium 在中间结果里偶尔
 * 只给总数(判词在 `electron/browser/find.ts` 上)。
 */
export function browserFindReadout(find: BrowserFindState): string | null {
  if (!find.query) return null
  if (find.total <= 0) return '0'
  return find.active <= 0 ? String(find.total) : `${find.active}/${find.total}`
}

/* ── 动作(每一条都只做一件事,而且发出去的那一句就是它的全部)──────────── */

function send(tabId: string, text: string, forward: boolean): void {
  nativeViewBridge()?.send({ verb: 'find', viewId: tabId, text, forward })
}

/**
 * 开查找行。**已经开着就是重申** —— ⌘F 再按一下要做的事(把光标送回输入框并
 * 全选)是叶那边「落点」的活,不是这一层的。与终端 `openFind` 逐字同一条。
 */
export function openBrowserFind(tabId: string): void {
  patch(tabId, { open: true })
}

/**
 * 收起:清掉页面上的高亮,**词留着**(下次开还是它,与浏览器、编辑器一族的手感
 * 一致),读数归零 —— 高亮都没了,再报一个数就是撒谎。
 */
export function closeBrowserFind(tabId: string): void {
  nativeViewBridge()?.send({ verb: 'findStop', viewId: tabId })
  patch(tabId, { open: false, active: 0, total: 0 })
}

/**
 * 人在输入框里打字。空词 = 清高亮(**不是**「找一个空串」),非空 = 就地往下找
 * 一次(增量:选区随着打字长出去)。
 */
export function setBrowserFindQuery(tabId: string, query: string): void {
  patch(tabId, { query })
  if (!query) {
    nativeViewBridge()?.send({ verb: 'findStop', viewId: tabId })
    patch(tabId, { active: 0, total: 0 })
    return
  }
  send(tabId, query, true)
}

/** 下一处 / 上一处。词空着时一格都不动(那两颗钮在叶那边也是禁着的)。 */
export function browserFindNext(tabId: string): void {
  const { query } = browserFindOf(tabId)
  if (query) send(tabId, query, true)
}

export function browserFindPrevious(tabId: string): void {
  const { query } = browserFindOf(tabId)
  if (query) send(tabId, query, false)
}

/** 这一格 tab 没了。由 `browser-source.ts` 的事实表在 `closed` 上调。 */
export function forgetBrowserFind(tabId: string): void {
  if (!states.delete(tabId)) return
  emit()
}

/* ── 那条推送 ────────────────────────────────────────────────────────────── */

let openCount = 0
let unsubscribe: (() => void) | undefined

/**
 * 收一发读数。**只认开着的那一格** —— 一条 `find` 推送在查找行关掉之后才到
 * (关与推之间隔着一次 IPC 往返)不该让读数又亮起来。
 */
export function onBrowserFindPush(message: NativeViewPush): void {
  if (message.kind !== 'find') return
  if (!browserFindOf(message.viewId).open) return
  patch(message.viewId, { active: message.active, total: message.total })
}

export function useBrowserFind(tabId: string): BrowserFindState {
  useEffect(() => {
    openCount += 1
    if (openCount === 1) {
      const bridge = nativeViewBridge()
      unsubscribe = bridge?.on(onBrowserFindPush)
    }
    return () => {
      openCount -= 1
      if (openCount > 0) return
      unsubscribe?.()
      unsubscribe = undefined
    }
  }, [])
  return useSyncExternalStore(
    useCallback((listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }, []),
    useCallback(() => browserFindOf(tabId), [tabId]),
  )
}

/** 回到出厂。测试与 HMR 用;幂等。 */
export function resetBrowserFind(): void {
  openCount = 0
  unsubscribe?.()
  unsubscribe = undefined
  states.clear()
  listeners.clear()
}

/*
 * 模块级副作用 = 这个模块实例的寿命(09-01 立法)。复用已有的那一口拆卸,
 * 不写第二套。生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(resetBrowserFind)
}
