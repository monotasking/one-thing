import type { SessionChapter, SessionMarker } from '../expose/types'
import type { TocChapter, TocKey, TocState } from './types'

/**
 * 钢琴键 TOC 的状态机 —— 纯函数,不碰 DOM、不认识 React。
 * 组件里只许调这里的函数,不许自己拼条件(和 stage/expose 同一条约定)。
 *
 * D1(接真数据)之后素材一律从参数进来:章节是 `sessions.getSegments`,
 * 键是 `sessions.getUserMarkers`。mock 默认值全部退役 —— 那条路接真数据之后
 * 就是「第二份事实」的入口。
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
export function tocKeys(chapters: TocChapter[], turnCount: number): TocKey[] {
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
export function chapterOfTurn(index: number, chapters: TocChapter[]): number {
  let chapterIdx = 0
  for (let c = 0; c < chapters.length; c += 1) {
    if (chapters[c].startIndex <= index) chapterIdx = c
  }
  return chapterIdx
}

/**
 * 后端章节 → 目录章节。
 *
 * 落位靠 `startMessageId`:它就是这一段**第一条用户消息**的 id
 * (`runtime/src/toc/segment.ts` 的 `segmentFromTurns`:
 * `startMessageId: first.userMessage.id`),所以它一定能在用户锚点列里找到位置。
 *
 * 找不到的段(旧账本没记 startMessageId,或那条消息已被删)**整段丢掉**,
 * 不按 turnCount 累加去猜一个位置 —— 一个猜出来的落点会让点击跳到别处,
 * 而那比少一章更糟。两套落位机制并存也必然漂移。
 *
 * 出参按 startIndex 升序:章节隙是靠相邻键的 chapterIdx 变化画出来的,
 * 章序乱了隙就画在错的地方。
 */
export function tocChapters(chapters: SessionChapter[], markers: SessionMarker[]): TocChapter[] {
  const at = new Map(markers.map((marker, index) => [marker.id, index]))
  return chapters
    .map((chapter) => {
      const startIndex = chapter.startMessageId ? at.get(chapter.startMessageId) : undefined
      return startIndex === undefined
        ? undefined
        : { title: chapter.title, kind: chapter.kind, startIndex }
    })
    .filter((chapter): chapter is TocChapter => chapter !== undefined)
    .sort((a, b) => a.startIndex - b.startIndex)
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
