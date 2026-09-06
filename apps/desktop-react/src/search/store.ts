import { create } from 'zustand'
import type { SearchContinuation } from './continuations'
import type { SearchFilterState } from './filters'
import type { SearchItem } from './sequence'
import type { SearchScope } from './types'
import * as T from './state'
import type { SearchSelectionBy, SearchState } from './state'

/**
 * 检索面的 store —— **`state.ts` 的一层壳**,与 `src/expose/store.ts` /
 * `src/stage/store.ts` 逐字同一个体例:每个 action 一句 `set(T.f)`,判据一行都不写在
 * 这里(写在这里就测不到了 —— 纯函数那一头有 `state.test.ts` 的 22 例)。
 *
 * ── 三层各持一种事实(检索面终稿 附录 B §0 ②)──────────────────────────────
 * kernel 的格持行集 / 每块 cursor / 忙态;**这里**持词 / 档 / 片 / 历史 / 活动项 /
 * 多选 / 滚动记忆;组件只持组件寿命的瞬态(右键菜单锚点)。
 *
 * ── 本步(第 ⑥ 步)它**只建不接** ────────────────────────────────────────
 * `SearchPanel.tsx` 那八格 `useState` 要到第 ⑦ 步才退役,所以今天这只 store 没有
 * 产品消费者 —— 与第 ④ 步的 `search-listing-source.ts`、第 ⑤ 步的 `state.ts` /
 * `sequence.ts` / `items/` 同一个处境:先并存,再替换,再删除(§7 迁移次序)。
 * 现在就把它立起来,是因为第 ⑦ 步「换心」那一批只该做**接线**这一件事。
 *
 * ── 为什么是模块级单例 ──────────────────────────────────────────────────
 * 检索瓦是 `singleton: true`(`content/kinds/panel.tsx:29`),一台上只有一块检索面;
 * 而它**换宿主就是真重挂**(舞台 → 浮窗 / 钉边),组件寿命的状态那一刻全没。词 /
 * 档 / 片 / 滚动位不该因为把面板拖到别处就归零,所以它们的寿命必须比组件长。
 * (风险 15:哪天真要多开,照 `FocusScope owner` 的先例按 owner 分族。)
 */

export interface SearchStore extends SearchState {
  /* ── 主语三格 ──────────────────────────────────────────────────────── */
  setQuery(query: string): void
  setScope(scope: SearchScope): void
  setFilters(filters: SearchFilterState): void

  /* ── 订阅键 ────────────────────────────────────────────────────────── */
  /** 换订阅键(同一把键是恒等变换)。去抖到点、或者「确定的一步」当场调它。 */
  commitKey(key: string): void
  /** 换一张列表:换键 + 活动项归零 + 清多选。 */
  resetForListing(key: string): void

  /* ── 活动项与多选 ──────────────────────────────────────────────────── */
  setActive(id: string | null, by: SearchSelectionBy, at?: number): void
  pick(id: string): void
  clearPicks(): void
  /** 新序列到了,活动项落在哪(**不产生任何滚动指令**)。 */
  reconcile(sequence: readonly SearchItem[]): void

  /* ── 滚动记忆 ──────────────────────────────────────────────────────── */
  /** 记下某把键此刻滚到哪儿(`ui/scroll-memory` 的 `write` 口)。 */
  setScroll(key: string, top: number): void

  /* ── 历史 ──────────────────────────────────────────────────────────── */
  pushCommit(): void
  stepHistory(direction: 'back' | 'forward'): void
  runContinuation(continuation: SearchContinuation): void

  /* ── 出厂 ──────────────────────────────────────────────────────────── */
  /** 回到出厂(收回 Dock 时;拍点 G 保旧)。 */
  reset(): void
}

export const useSearchStore = create<SearchStore>()(set => ({
  ...T.initialSearchState,

  setQuery: query => set(s => T.setQuery(s, query)),
  setScope: scope => set(s => T.setScope(s, scope)),
  setFilters: filters => set(s => T.setFilters(s, filters)),

  commitKey: key => set(s => T.commitKey(s, key)),
  resetForListing: key => set(s => T.resetForListing(s, key)),

  setActive: (id, by, at) => set(s => T.setActive(s, id, by, at)),
  pick: id => set(s => T.pick(s, id)),
  clearPicks: () => set(T.clearPicks),
  reconcile: sequence => set(s => T.reconcile(s, sequence)),

  setScroll: (key, top) => set(s => T.setScroll(s, key, top)),

  pushCommit: () => set(T.pushCommit),
  stepHistory: direction => set(s => T.stepHistory(s, direction)),
  runContinuation: continuation => set(s => T.runContinuation(s, continuation)),

  /*
   * `T.reset()` 交出的就是 `initialSearchState` 那一份**恒等引用**,所以这一句
   * 既清状态又不换那几格的引用 —— 与 `expose` / `stage` 两只 store 的 `reset` 同法。
   */
  reset: () => set(T.reset()),
}))

/** 某把键的滚动位(`ui/scroll-memory` 的 `read` 口;非响应式,读的是此刻)。 */
export function searchScrollOf(key: string): number {
  return T.scrollOf(useSearchStore.getState(), key)
}

/**
 * 模块级副作用的退役口(09-01 立法)。store 是模块级单例,寿命就是「这个模块实例」——
 * 热更之后新模块会建一只新 store,旧那只若不归零,订阅它的旧组件树会留着上一份词 /
 * 档 / 选中继续画。**退役复用它自己那一口 `reset()`**,不写第二套。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    useSearchStore.getState().reset()
  })
}
