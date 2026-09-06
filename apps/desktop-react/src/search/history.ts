import type { SearchFilterState } from './filters'

/**
 * **查询历史**(设计 `docs/design/search-index-2026-09.md` §4.6 结论最后一段)。
 *
 * 续搜的返回路**不是面包屑帧栈**,是「检索框本来就该有的查询历史」——
 * ↑ 回上一条、⌘[ 后退、⌘] 前进,与浏览器地址栏同形。范围片与枢轴都只是
 * 「替换当前查询状态」,退回去靠这条线性历史,不靠一摞帧。
 *
 * 与 `transitions.ts` / `filters.ts` 同一体例:纯函数,没有 React、没有 store。
 * 面板拿着一份 `SearchHistory` 的值,每一次「确定的一步」调一次这里的函数换一份新的。
 *
 * ── 一条历史是四格,不是一个字符串(§4.6 原话)────────────────────────────
 * `{ query, capability, filters, selected }`。回去要**原样** —— 只记词的话,
 * 「在此会话内搜 foo」退回去会变成「不限范围搜 foo」,那不是用户按下去的那一步。
 *
 * ── 只在内存里(本批)────────────────────────────────────────────────────
 * 面板卸载 = 这段历史没了。落盘是另一件事(要定「多久算过期」「换空间要不要串」
 * 「几条封顶」三件),本批不做 —— 派工单原话「历史只存内存」。
 */

/** 历史上的一格。四格照 §4.6 的原文。 */
export interface SearchHistoryEntry {
  /** 那一刻检索框里的词。 */
  query: string
  /** 那一刻选中的档(能力 id 或 `all`)。 */
  capability: string
  /** 那一刻的过滤片(含范围片)。 */
  filters: SearchFilterState
  /**
   * 那一刻停在**哪一项**上。**回去要连它一起还原** —— 「深入一步再退回来」退到的
   * 应该是刚才那一行上,而不是列表顶。
   *
   * ── 为什么是 id 不是下标(检索面终稿 落差 #18)──────────────────────────
   * 从前这一格是 `selected: number`。翻一页下标就全变了,而「我刚才停在这一条上」
   * 这件事不该跟着页码漂;更要命的是回去那一刻列表**还没落地**(格可能已经被 LRU
   * 丢掉),一个下标指不到任何东西,而一个 id 至少能诚实地答「它不在了」——
   * 那时 `reconcile` 落到序列首项。`null` = 那一刻没有活动项。
   */
  activeId: string | null
}

/**
 * 线性历史 + 一根指针(与地址栏逐字同形)。
 *
 * `at` 指着**此刻这一格**。`push` 会把 `at` 后面那一段砍掉再追加 —— 后退到中间
 * 再走一条新路,前进那一段就不该还在(浏览器就是这么做的,用户对这件事有预期)。
 */
export interface SearchHistory {
  entries: readonly SearchHistoryEntry[]
  at: number
}

export const EMPTY_HISTORY: SearchHistory = { entries: [], at: -1 }

/**
 * 几条封顶。历史只在内存里,但一场检索里按几十次枢轴是可能的,留一个上限
 * 免得它无声地长下去(与两个数据源的键面封顶同一条纪律)。
 */
export const HISTORY_LIMIT = 50

/** 两格历史是不是同一步(避免同一个状态被连着按两次记两遍)。 */
function sameEntry(a: SearchHistoryEntry, b: SearchHistoryEntry): boolean {
  return a.query === b.query
    && a.capability === b.capability
    && JSON.stringify(a.filters) === JSON.stringify(b.filters)
}

/**
 * 记一步。
 *
 * **只有「确定的一步」才进来**:按了范围片 / 按了枢轴 / 按了「查看全部」 ——
 * 不是每敲一个字母记一格(那样 ↑ 一下只退一个字母,历史就没有意义了)。
 * 判据落在调用方,这里只负责「同一步不记两遍」与「砍掉前进段」。
 */
export function pushHistory(history: SearchHistory, entry: SearchHistoryEntry): SearchHistory {
  const current = history.entries[history.at]
  if (current !== undefined && sameEntry(current, entry)) {
    // 同一步再按一次:只更新「停在第几行」,不多记一格。
    const entries = [...history.entries]
    entries[history.at] = entry
    return { entries, at: history.at }
  }
  const kept = history.entries.slice(0, history.at + 1)
  const entries = [...kept, entry]
  // 封顶从**头上**砍(最老的先走),指针跟着挪。
  const overflow = Math.max(0, entries.length - HISTORY_LIMIT)
  return { entries: entries.slice(overflow), at: entries.length - overflow - 1 }
}

/** 能不能后退 / 前进(按钮与快捷键的可用态读它)。 */
export function canGoBack(history: SearchHistory): boolean {
  return history.at > 0
}

export function canGoForward(history: SearchHistory): boolean {
  return history.at >= 0 && history.at < history.entries.length - 1
}

/**
 * 后退一步。**答的是「新的历史 + 要还原成什么」**,不是只答一个下标 ——
 * 调用方需要那一格的四件内容去还原,两个返回值分开取会多一处「按下标再取一次」
 * 的接缝。
 *
 * 退不动时答 `undefined`(不是原样返回)—— 让调用方能一眼判「这一下什么都没发生」,
 * 从而不去多跑一遍重置。
 */
export function goBack(history: SearchHistory): { history: SearchHistory; entry: SearchHistoryEntry } | undefined {
  if (!canGoBack(history)) return undefined
  const at = history.at - 1
  return { history: { ...history, at }, entry: history.entries[at] }
}

export function goForward(history: SearchHistory): { history: SearchHistory; entry: SearchHistoryEntry } | undefined {
  if (!canGoForward(history)) return undefined
  const at = history.at + 1
  return { history: { ...history, at }, entry: history.entries[at] }
}

/**
 * ↑ 那一下:**回上一条查询**(终端里 ↑ 的那个手感)。
 *
 * 它与 `goBack` 的区别只有一处:⌘[ 是「在历史里走」(指针挪,能再 ⌘] 回来),
 * ↑ 是「把上一条词捞回输入框」—— 用户的心智里那是「我刚才搜的是什么来着」,
 * 不是导航。所以它同样挪指针(不然连按两下 ↑ 会停在同一条上),
 * 落点是同一格历史。
 *
 * **什么时候轮得到它**由面板判(输入框为空且选中在第一行),不在这里 ——
 * 那是一句关于键盘的话,不是关于历史的话。
 */
export const recallPrevious = goBack
