import type { SearchContinuation } from './continuations'
import { INITIAL_FILTERS, type SearchFilterState } from './filters'
import {
  EMPTY_HISTORY,
  goBack,
  goForward,
  pushHistory,
  type SearchHistory,
  type SearchHistoryEntry,
} from './history'
import { ALL_TAB } from './capabilities'
import { indexOfItem, type SearchItem } from './sequence'
import type { SearchScope } from './types'

/**
 * 检索面的**状态机** —— 纯函数,不认识 React、不发请求、不认识数据源。
 *
 * 体例照 `src/expose/transitions.ts`:store 每个 action 一句 `set(T.f)`,逻辑写在
 * 这里才测得到。第 ⑥ 步的 `search/store.ts`(zustand)是它的一层壳,今天它还没有
 * 消费者 —— 面板那八格 `useState` 要到第 ⑦ 步才退役。
 *
 * ── 三层各持一种事实(§0 ②)──────────────────────────────────────────────
 * kernel 的格持行集 / 每块 cursor / 忙态;**这里**持词 / 档 / 片 / 历史 / 活动项 /
 * 多选;组件只持组件寿命的瞬态(右键菜单锚点)。所以这个文件里没有一行
 * `rows` —— 它连一张列表长什么样都不知道,只知道「活动项是哪个 id」。
 */

/* ── 活动项 ────────────────────────────────────────────────────────────── */

/**
 * 活动项**是怎么变成活动项的**。
 *
 * 它不是装饰:**滚动只有一条产地**,而那条 effect 的判据就是这一格 ——
 * `reconcile` 落位时不滚(行集增长绝不触发滚动,§5.4 ③),键盘 / 指针 / 历史
 * 三种才滚。把「谁改的」记在状态里,而不是在改的那一处顺手滚一下,是因为后者
 * 会长出第二个、第三个滚动产地(今天 `SearchPanel.tsx:396-401` 那条 effect 依赖
 * `visibleRows`,列表一长就滚 —— 那正是「点了加载更多跳回顶部」的另一半)。
 */
export type SearchSelectionBy = 'keyboard' | 'pointer' | 'history' | 'reconcile'

export interface SearchSelection {
  /** 活动项的 id(`sequence.ts` 那套)。`null` = 没有活动项。 */
  readonly id: string | null
  readonly by: SearchSelectionBy
  /**
   * 上一次对账时它在序列里的第几位。**不是「谁是活动项」的产地**(那是 `id`),
   * 是「它没了的话该落到哪」的**记号**:more 项消失 → 同一位置正是本次追加的
   * 第一行;行消失 → 同一位置就是最近的幸存项(§5.4 ③ 的两条落位规则)。
   * `-1` = 还没对过账。
   */
  readonly at: number
}

const INITIAL_SELECTION: SearchSelection = { id: null, by: 'reconcile', at: -1 }

/* ── 状态 ──────────────────────────────────────────────────────────────── */

export interface SearchState {
  /** 输入框里那串字。**去抖到点之前它不进键** —— 打字期间列表一格不动。 */
  readonly query: string
  /** 此刻这一档(能力 id 或 `all`)。「这一档还在不在」由面板用自述表解析。 */
  readonly scope: SearchScope
  readonly filters: SearchFilterState
  /**
   * **订阅的那把键**。它与「主语此刻是什么」是两件事:打字期间主语一直在变,
   * 而这一格只在去抖到点(或者「确定的一步」当场)才换 —— 于是列表订的还是旧键,
   * 屏上一格不动(§3 表「打字去抖中」那一行)。
   */
  readonly committedKey: string
  readonly selection: SearchSelection
  /**
   * 多选。**按 id 记,不按下标** —— 翻一页下标就全变了。次序有意义:
   * compare 的左右两格照它排。
   */
  readonly picked: readonly string[]
  readonly history: SearchHistory
  /**
   * **每把键各自的滚动位**(第 ⑤ 步的留账,第 ⑥ 步补上)。
   *
   * 键是 `held.shownKey`(屏上这份是哪把键的),不是「请求键」—— 换词在飞的那几帧
   * 屏上还是上一把键的行,这一格必须跟着**看得见的那份**走,否则一换词就把新键的
   * 记忆写成旧列表的位置。
   *
   * 为什么它在 store 而不在组件:换宿主(舞台 → 浮窗 / 钉边)是**真重挂**,
   * 组件寿命的状态那一刻就没了;而「我滚到哪儿了」不该因为把面板拖到别处就归零。
   * 读写两口由 `ui/scroll-memory` 的 `{ read, write }` 接上(第 ⑦ 步)。
   */
  readonly scrollByKey: Readonly<Record<string, number>>
}

export const initialSearchState: SearchState = {
  query: '',
  scope: ALL_TAB,
  filters: INITIAL_FILTERS,
  committedKey: '',
  selection: INITIAL_SELECTION,
  picked: [],
  history: EMPTY_HISTORY,
  scrollByKey: {},
}

/* ── 主语三格 ──────────────────────────────────────────────────────────── */

/**
 * 打字。**只改词** —— 键不换、活动项不动、列表一格不动(换键由 `commitKey`
 * 在去抖到点时做,`resetForListing` 顺带清活动项)。
 */
export function setQuery(state: SearchState, query: string): SearchState {
  return state.query === query ? state : { ...state, query }
}

/** 换档。**「确定的一步」** —— 面板不等去抖,当场 commit(但不入历史,保旧)。 */
export function setScope(state: SearchState, scope: SearchScope): SearchState {
  return state.scope === scope ? state : { ...state, scope }
}

export function setFilters(state: SearchState, filters: SearchFilterState): SearchState {
  return state.filters === filters ? state : { ...state, filters }
}

/* ── 订阅键 ────────────────────────────────────────────────────────────── */

/** 换订阅键。**只换键**(同一把键是恒等变换,连引用都不换)。 */
export function commitKey(state: SearchState, key: string): SearchState {
  return state.committedKey === key ? state : { ...state, committedKey: key }
}

/**
 * 换一张列表:换键 + 活动项归零 + 清多选。
 *
 * 「归零」是 `id: null` 而不是「第一项」—— 此刻新格还没落地,序列是空的,
 * 猜一个 id 出来只会指向上一张列表。落到首项那一下由 `reconcile` 在答案到达时做
 * (`by: 'reconcile'`,所以**不滚**)。
 */
export function resetForListing(state: SearchState, key: string): SearchState {
  return {
    ...commitKey(state, key),
    selection: INITIAL_SELECTION,
    picked: state.picked.length === 0 ? state.picked : [],
  }
}

/* ── 活动项与多选 ──────────────────────────────────────────────────────── */

/**
 * 落一个活动项。`at` 给得出就带上(键盘那一路知道自己走到第几位),
 * 给不出就留旧记号 —— 下一次 `reconcile` 会把它校准。
 */
export function setActive(
  state: SearchState,
  id: string | null,
  by: SearchSelectionBy,
  at?: number,
): SearchState {
  const next: SearchSelection = { id, by, at: at ?? state.selection.at }
  const cur = state.selection
  if (cur.id === next.id && cur.by === next.by && cur.at === next.at) return state
  return { ...state, selection: next }
}

/** 挑 / 取消挑一条(⇧ / ⌘ 点行;拍点 C 保旧:单条 toggle,不是区间选)。 */
export function pick(state: SearchState, id: string): SearchState {
  const picked = state.picked.includes(id)
    ? state.picked.filter(one => one !== id)
    : [...state.picked, id]
  return { ...state, picked }
}

export function clearPicks(state: SearchState): SearchState {
  return state.picked.length === 0 ? state : { ...state, picked: [] }
}

/* ── 滚动记忆 ──────────────────────────────────────────────────────────── */

/**
 * 记下某把键此刻滚到哪儿。**同值恒等**(连引用都不换)—— 滚动是高频事件,
 * 每一像素换一次 store 引用会把每个订阅者都叫醒一遍。
 *
 * `top <= 0` 一律记 `0`:负的 `scrollTop` 是橡皮筋回弹的中间值,不是位置。
 * 「没记过」与「记着 0」是同一件事(`scrollOf` 对两者都答 0),所以把 0 写进一把
 * 从没记过的键也是恒等变换 —— 否则列表一挂上来就会为每把键长出一格空账。
 */
export function setScroll(state: SearchState, key: string, top: number): SearchState {
  const next = top > 0 ? top : 0
  if (scrollOf(state, key) === next) return state
  return { ...state, scrollByKey: { ...state.scrollByKey, [key]: next } }
}

/** 某把键的滚动位。没记过 = `0`(从顶上开始,不猜)。 */
export function scrollOf(state: SearchState, key: string): number {
  return state.scrollByKey[key] ?? 0
}

/* ── 对账 ──────────────────────────────────────────────────────────────── */

/**
 * **新序列到了,活动项落在哪**(§5.4 ③ 的唯一落位规则)。
 *
 * 三条,按次序:
 *  1. 活动项还在 → **一个字不改**(只校准 `at` 那个记号);
 *  2. 它没了 → 按**旧下标**夹进新序列 —— 块尾那条项消失时,同一位置恰好就是
 *     本次追加的第一行(行排在块尾项前面);行消失时,同一位置就是最近的幸存项;
 *  3. 序列空了 → `id: null`。
 *
 * **它不产生任何滚动指令**:`by` 一律是 `'reconcile'`,而滚动那条 effect 只认
 * 键盘 / 指针 / 历史三种。这一条是「行集增长绝不触发滚动」四条不变量里的第三条,
 * 也是这只函数的全部理由 —— 把落位与滚动分开,而不是在落位那一处顺手滚一下。
 */
export function reconcile(state: SearchState, sequence: readonly SearchItem[]): SearchState {
  if (sequence.length === 0) {
    return state.selection.id === null && state.selection.at === -1
      ? state
      : { ...state, selection: INITIAL_SELECTION }
  }
  const at = indexOfItem(sequence, state.selection.id)
  if (at >= 0) {
    return state.selection.at === at
      ? state
      : { ...state, selection: { ...state.selection, at } }
  }
  const fallback = Math.max(0, Math.min(
    state.selection.at < 0 ? 0 : state.selection.at,
    sequence.length - 1,
  ))
  return { ...state, selection: { id: sequence[fallback].id, by: 'reconcile', at: fallback } }
}

/* ── 历史 ──────────────────────────────────────────────────────────────── */

/** 此刻这一步。历史记的就是它。 */
export function entryOf(state: SearchState): SearchHistoryEntry {
  return {
    query: state.query,
    capability: state.scope,
    filters: state.filters,
    activeId: state.selection.id,
  }
}

/**
 * 把此刻这一步记进历史。**只有「确定的一步」才调它** —— 按了范围片 / 按了枢轴 /
 * 按了「只看这一类」;不是每敲一个字母记一格(那样 ↑ 一下只退一个字母)。
 */
export function pushCommit(state: SearchState): SearchState {
  return { ...state, history: pushHistory(state.history, entryOf(state)) }
}

/** 把一步落成屏幕上的状态。**替换**,不是 push 一帧 —— 退回去靠历史。 */
function applyEntry(
  state: SearchState,
  entry: SearchHistoryEntry,
  by: SearchSelectionBy,
): SearchState {
  return {
    ...state,
    query: entry.query,
    scope: entry.capability,
    filters: entry.filters,
    // `at` 归零:那一刻的下标是**另一张列表**里的位置,带回来只会误导 `reconcile`。
    selection: { id: entry.activeId, by, at: -1 },
    picked: [],
  }
}

/**
 * ⌘[ / ⌘] / ↑(回上一条查询)。走不动就**原样返回**(调用方据此判「这一下什么
 * 都没发生」,从而不去多跑一遍重置)。
 */
export function stepHistory(state: SearchState, direction: 'back' | 'forward'): SearchState {
  const moved = direction === 'back' ? goBack(state.history) : goForward(state.history)
  if (moved === undefined) return state
  return applyEntry({ ...state, history: moved.history }, moved.entry, 'history')
}

/**
 * 走一条续搜(范围片 / 枢轴)。**先把当前这一步记进历史,再换状态** ——
 * 顺序反过来的话记下的就是新那一步,↑ / ⌘[ 回去会回到自己身上。
 *
 * 两格都 push:当前这一步一格,新的那一步一格(**入栈两格**,与今天
 * `SearchPanel.tsx:507-531` 的次序逐字相同)。
 */
export function runContinuation(
  state: SearchState,
  continuation: SearchContinuation,
): SearchState {
  const afterCurrent = pushCommit(state)
  if (continuation.kind === 'scope') {
    const filters = { ...state.filters, scope: continuation.chip }
    const next: SearchHistoryEntry = {
      query: state.query,
      capability: state.scope,
      filters,
      activeId: null,
    }
    return applyEntry(
      { ...afterCurrent, history: pushHistory(afterCurrent.history, next) },
      next,
      'reconcile',
    )
  }
  const filters: SearchFilterState = continuation.chip === undefined
    ? { ...state.filters, scope: undefined }
    : { ...state.filters, scope: continuation.chip }
  const next: SearchHistoryEntry = {
    query: continuation.query,
    capability: continuation.capability,
    filters,
    activeId: null,
  }
  return applyEntry(
    { ...afterCurrent, history: pushHistory(afterCurrent.history, next) },
    next,
    'reconcile',
  )
}

/* ── 出厂 ──────────────────────────────────────────────────────────────── */

/**
 * 回到出厂。收回 Dock 时调它(拍点 G 保旧:词 / 档 / 片 / 历史 / 选中全没了,
 * 与今天「卸载本地状态全没了」逐字相同)。
 */
export function reset(): SearchState {
  return initialSearchState
}
