import { CURRENT_SESSION_ID, DEFAULT_COLLAPSED_GROUP_IDS, GROUPS, SESSIONS } from './data'
import type {
  ExposeState,
  FocusDir,
  GroupMock,
  HighlightPart,
  SearchHit,
  SessionMock,
} from './types'

/** 卡网格列数。↑↓ 走一整行 = 走 CARD_COLS 步,和 CSS 的 repeat(3,…) 是同一个事实。 */
export const CARD_COLS = 3

export const initialExposeState: ExposeState = {
  view: { mode: 'overview' },
  focusId: null,
  focusVisible: false,
  collapsedGroups: DEFAULT_COLLAPSED_GROUP_IDS,
  query: '',
  currentSessionId: CURRENT_SESSION_ID,
}

export function isCollapsed(state: ExposeState, groupId: string): boolean {
  return state.collapsedGroups.includes(groupId)
}

/**
 * 焦点序列 = 展开组的卡顺序拼接。折叠一个组,序列立刻变短 ——
 * 所以 moveFocus / quickLookPrev-Next 都只认这一个函数,不各算各的。
 */
export function visibleCardIds(state: ExposeState, groups: GroupMock[] = GROUPS): string[] {
  return groups
    .filter((g) => !isCollapsed(state, g.id))
    .flatMap((g) => g.sessions.map((s) => s.id))
}

function clampIndex(i: number, len: number): number {
  return Math.min(Math.max(i, 0), Math.max(len - 1, 0))
}

/* ── 开场 ──────────────────────────────────────────────────────────────── */

/**
 * 开场归位:这块面一在场,内容就从总览起步,搜索词清空,焦点**锚点**落在当前会话上
 * (方向键第一下有起点),但环不点亮 —— 焦点环只属于键盘会话,打开这块面本身不算。
 *
 * 它是**无条件**的:上次退出时停在 quicklook / list 不该在下次打开时还原,
 * 「打开总览」的意思就是重新看一眼全部。至于这块面在不在场,那是 Placement 的事,
 * 状态机不问也答不出 —— 所以这里没有与之配对的 close()。
 */
export function open(state: ExposeState, groups: GroupMock[] = GROUPS): ExposeState {
  const seq = visibleCardIds(state, groups)
  const focusId = seq.includes(state.currentSessionId) ? state.currentSessionId : (seq[0] ?? null)
  return { ...state, view: { mode: 'overview' }, focusId, focusVisible: false, query: '' }
}

/**
 * Esc 逐层:quicklook → overview、list → overview。层级写在这一个函数里,组件不许自己排序。
 *
 * 到了总览这一层就**没有下一层**了:这一下不归内容管,由宿主(舞台 / 浮窗 / 架子)
 * 去关这块面 —— 所以这里是恒等变换,而不是「自己把自己关掉」。
 * 内容消费不了,宿主才轮得到,这条让位契约的另一半写在 ExposeView 与 StageOverlay 里。
 */
export function escape(state: ExposeState): ExposeState {
  switch (state.view.mode) {
    case 'quicklook':
    case 'list':
      return backToOverview(state)
    case 'overview':
      return state
  }
}

/* ── 层内迁移 ──────────────────────────────────────────────────────────── */

export function enterList(state: ExposeState, groupId: string): ExposeState {
  return { ...state, view: { mode: 'list', groupId } }
}

export function backToOverview(state: ExposeState): ExposeState {
  if (state.view.mode === 'overview') return state
  return { ...state, view: { mode: 'overview' } }
}

export function openQuickLook(state: ExposeState, sessionId: string): ExposeState {
  return { ...state, view: { mode: 'quicklook', sessionId }, focusId: sessionId }
}

export function closeQuickLook(state: ExposeState): ExposeState {
  if (state.view.mode !== 'quicklook') return state
  return backToOverview(state)
}

/* ── 焦点 ──────────────────────────────────────────────────────────────── */

export function moveFocus(
  state: ExposeState,
  dir: FocusDir,
  groups: GroupMock[] = GROUPS,
): ExposeState {
  const seq = visibleCardIds(state, groups)
  if (seq.length === 0) return state
  const cur = state.focusId ? seq.indexOf(state.focusId) : -1
  // 还没落焦(或焦点已被折叠藏起来)时,任何方向键都先把焦点放到序列首。
  if (cur < 0) return { ...state, focusId: seq[0], focusVisible: true }
  const step = dir === 'left' ? -1 : dir === 'right' ? 1 : dir === 'up' ? -CARD_COLS : CARD_COLS
  const next = clampIndex(cur + step, seq.length)
  // 撞边不动位置也要点亮环:用户按了方向键,就该看得见焦点在哪。
  if (next === cur) return state.focusVisible ? state : { ...state, focusVisible: true }
  return { ...state, focusId: seq[next], focusVisible: true }
}

/* ── Quick Look 内换会话 ───────────────────────────────────────────────── */

function quickLookStep(state: ExposeState, delta: number, groups: GroupMock[]): ExposeState {
  if (state.view.mode !== 'quicklook') return state
  const seq = visibleCardIds(state, groups)
  const i = seq.indexOf(state.view.sessionId)
  if (i < 0) return state
  const j = clampIndex(i + delta, seq.length)
  if (j === i) return state
  return { ...state, view: { mode: 'quicklook', sessionId: seq[j] }, focusId: seq[j], focusVisible: true }
}

/** 到头就停(不回绕):和 moveFocus 同一个边界口径,免得两种键有两种直觉。 */
export function quickLookPrev(state: ExposeState, groups: GroupMock[] = GROUPS): ExposeState {
  return quickLookStep(state, -1, groups)
}

export function quickLookNext(state: ExposeState, groups: GroupMock[] = GROUPS): ExposeState {
  return quickLookStep(state, 1, groups)
}

/* ── 折叠 ──────────────────────────────────────────────────────────────── */

/** 折叠一个组时,如果焦点正好在被藏起来的卡上,焦点退到新序列首。 */
export function toggleGroupCollapsed(
  state: ExposeState,
  groupId: string,
  groups: GroupMock[] = GROUPS,
): ExposeState {
  const collapsedGroups = isCollapsed(state, groupId)
    ? state.collapsedGroups.filter((g) => g !== groupId)
    : [...state.collapsedGroups, groupId]
  const next: ExposeState = { ...state, collapsedGroups }
  const seq = visibleCardIds(next, groups)
  if (next.focusId && !seq.includes(next.focusId)) {
    return { ...next, focusId: seq[0] ?? null }
  }
  return next
}

/* ── 搜索 / 进入 ───────────────────────────────────────────────────────── */

export function setQuery(state: ExposeState, query: string): ExposeState {
  return { ...state, query }
}

/**
 * 「进入」= 换当前会话 + 内容回到起点(退出 quicklook / list、清掉搜索词)。
 * L2 到此为止,不真的切聊天内容。
 * 「顺手把这块面收回 Dock」是 Placement 的事,纯函数不认识落点 —— 那一步在 store 壳里。
 */
export function enterSession(state: ExposeState, sessionId: string): ExposeState {
  return { ...state, currentSessionId: sessionId, view: { mode: 'overview' }, query: '' }
}

/* ── 派生:搜索与时间分桶 ──────────────────────────────────────────────── */

function has(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle)
}

/**
 * 全量子串过滤,三层一次算完:会话行 / 命中章节 / 命中消息。
 * 视图只负责画,不再自己 filter —— 否则三层会各自漂移。
 */
export function searchSessions(query: string, sessions: SessionMock[] = SESSIONS): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits: SearchHit[] = []
  for (const session of sessions) {
    const segments = session.segments.filter((seg) => has(seg.title, q) || has(seg.detail, q))
    const turns = session.userTurns
      .map((text, index) => ({ text, index }))
      .filter((t) => has(t.text, q))
    const head = has(session.title, q) || has(session.summary, q)
    if (head || segments.length > 0 || turns.length > 0) {
      hits.push({ session, segments, turns })
    }
  }
  return hits
}

/** 把一段文本按命中切片,视图给 hit=true 的片包 <mark>。 */
export function splitHighlight(text: string, query: string): HighlightPart[] {
  const q = query.trim()
  if (!q) return [{ text, hit: false }]
  const lower = text.toLowerCase()
  const needle = q.toLowerCase()
  const parts: HighlightPart[] = []
  let from = 0
  for (;;) {
    const at = lower.indexOf(needle, from)
    if (at < 0) break
    if (at > from) parts.push({ text: text.slice(from, at), hit: false })
    parts.push({ text: text.slice(at, at + needle.length), hit: true })
    from = at + needle.length
  }
  if (from < text.length) parts.push({ text: text.slice(from), hit: false })
  return parts.length > 0 ? parts : [{ text, hit: false }]
}

/**
 * 时间桶是**标识**,不是文案:纯函数不许产出界面字符串,
 * 否则换一门语言就得改状态机。小标题由 ListView 拿这个标识去查字典。
 */
export type TimeBucket = 'thisWeek' | 'earlier'

/** list 视图的时间分组。mock 的时间是文字,所以判据也只能是文字形状。 */
export function timeBucket(time: string): TimeBucket {
  if (time === '刚刚' || time === '昨天') return 'thisWeek'
  if (/^\d{1,2}:\d{2}$/.test(time)) return 'thisWeek'
  if (/^周[一二三四五六日]$/.test(time)) return 'thisWeek'
  return 'earlier'
}
