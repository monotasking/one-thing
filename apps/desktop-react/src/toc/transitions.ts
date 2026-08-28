import { CHAT_CHAPTERS, CHAT_TURNS } from '../data/chat-mock'
import type { ChatChapter } from '../data/chat-mock'
import type { TocKey, TocState } from './types'

/**
 * 钢琴键 TOC 的状态机 —— 纯函数,不碰 DOM、不认识 React。
 * 组件里只许调这里的函数,不许自己拼条件(和 stage/expose 同一条约定)。
 */

export const initialTocState: TocState = { open: false, hoverIndex: null }

/* ── 开合 ──────────────────────────────────────────────────────────────── */

export function openToc(state: TocState): TocState {
  if (state.open) return state
  return { ...state, open: true }
}

/** 收起时一并清掉悬停 —— 否则下次展开会带着上次的明暗斑闪一下。 */
export function closeToc(state: TocState): TocState {
  if (!state.open && state.hoverIndex === null) return state
  return { open: false, hoverIndex: null }
}

export function toggleToc(state: TocState): TocState {
  return state.open ? closeToc(state) : openToc(state)
}

export function hoverKey(state: TocState, index: number | null): TocState {
  if (state.hoverIndex === index) return state
  return { ...state, hoverIndex: index }
}

/* ── 派生:键列 ────────────────────────────────────────────────────────── */

/**
 * 从章节表 + 轮次数推出键列。章节只存起点,这里把「谁属于哪一章」算出来:
 * 第 i 键的章 = 最后一个 startIndex ≤ i 的章。
 *
 * 章节表为空(或第一章不从 0 开始)时,前面那些键一律算第 0 章 ——
 * 不抛错、不丢键:键数**恒等于**轮次数,这是几何不变式的第一条
 * (键列渲染出来的行数只由这个数决定,和展开与否无关)。
 */
export function tocKeys(
  chapters: ChatChapter[] = CHAT_CHAPTERS,
  turnCount: number = CHAT_TURNS.length,
): TocKey[] {
  const keys: TocKey[] = []
  for (let index = 0; index < turnCount; index += 1) {
    let chapterIdx = 0
    for (let c = 0; c < chapters.length; c += 1) {
      if (chapters[c].startIndex <= index) chapterIdx = c
    }
    keys.push({ index, chapterIdx })
  }
  return keys
}

/** 一章里有哪些键。渲染层按章分组画行,靠的就是这个,不自己 filter。 */
export function keysOfChapter(keys: TocKey[], chapterIdx: number): TocKey[] {
  return keys.filter((k) => k.chapterIdx === chapterIdx)
}

/** 某一轮属于第几章。搜索 / 高亮之类的旁路要用,单独开一个口,免得各算各的。 */
export function chapterOfTurn(index: number, chapters: ChatChapter[] = CHAT_CHAPTERS): number {
  let chapterIdx = 0
  for (let c = 0; c < chapters.length; c += 1) {
    if (chapters[c].startIndex <= index) chapterIdx = c
  }
  return chapterIdx
}

/* ── 派生:当前键 ─────────────────────────────────────────────────────── */

/**
 * 「当前键」= 视口内最靠上的那条用户消息;一条都没进视口时,取视口上方最后一条
 * (= 正在读的那一段),都在上方够不着时退到第一条。
 *
 * 入参是**量出来的坐标**而不是 DOM:测量归渲染层(useChatToc),判定归这里。
 * tops[i] = 第 i 条用户消息相对滚动内容顶部的偏移。
 */
export function currentTurnIndex(tops: number[], scrollTop: number, viewportH: number): number {
  if (tops.length === 0) return -1
  const inView = tops.findIndex((top) => top >= scrollTop && top < scrollTop + viewportH)
  if (inView >= 0) return inView
  let above = 0
  for (let i = 0; i < tops.length; i += 1) {
    if (tops[i] <= scrollTop) above = i
  }
  return above
}
