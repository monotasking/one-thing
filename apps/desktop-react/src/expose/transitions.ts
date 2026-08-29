import type {
  ExposeState,
  FocusDir,
  HighlightPart,
  SearchHit,
  SessionChapter,
  SessionGroup,
  SessionSummary,
} from './types'

/**
 * 会话总览的状态机 —— 纯函数,不认识 React、不发请求、**不认识数据源**。
 *
 * D1(接真数据)只改了一件事:凡是要看「有哪些组 / 哪些会话」的函数,
 * 那份数据一律**从参数进来**,不再有 mock 表当默认值。默认值那条路是
 * mock 时代的便利,接真数据之后它就是「第二份事实」的入口 ——
 * 组件调 store、store 从数据源取一次交进来,只此一条路。
 */

/** 卡网格列数。↑↓ 走一整行 = 走 CARD_COLS 步,和 CSS 的 repeat(3,…) 是同一个事实。 */
export const CARD_COLS = 3

export const initialExposeState: ExposeState = {
  view: { mode: 'overview' },
  focusId: null,
  focusVisible: false,
  // 没有「默认折叠」:旧 mock 的 active 标记在 SessionMeta 上没有产地(见 types.ts)。
  collapsedGroups: [],
  query: '',
  // 空串 = 还没有当前会话。开场归位时它会落到序列首。
  currentSessionId: '',
}

export function isCollapsed(state: ExposeState, groupId: string): boolean {
  return state.collapsedGroups.includes(groupId)
}

/**
 * 焦点序列 = 展开组的卡顺序拼接。折叠一个组,序列立刻变短 ——
 * 所以 moveFocus / quickLookPrev-Next 都只认这一个函数,不各算各的。
 */
export function visibleCardIds(state: ExposeState, groups: SessionGroup[]): string[] {
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
export function open(state: ExposeState, groups: SessionGroup[]): ExposeState {
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
  groups: SessionGroup[],
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

function quickLookStep(state: ExposeState, delta: number, groups: SessionGroup[]): ExposeState {
  if (state.view.mode !== 'quicklook') return state
  const seq = visibleCardIds(state, groups)
  const i = seq.indexOf(state.view.sessionId)
  if (i < 0) return state
  const j = clampIndex(i + delta, seq.length)
  if (j === i) return state
  return { ...state, view: { mode: 'quicklook', sessionId: seq[j] }, focusId: seq[j], focusVisible: true }
}

/** 到头就停(不回绕):和 moveFocus 同一个边界口径,免得两种键有两种直觉。 */
export function quickLookPrev(state: ExposeState, groups: SessionGroup[]): ExposeState {
  return quickLookStep(state, -1, groups)
}

export function quickLookNext(state: ExposeState, groups: SessionGroup[]): ExposeState {
  return quickLookStep(state, 1, groups)
}

/* ── 折叠 ──────────────────────────────────────────────────────────────── */

/** 折叠一个组时,如果焦点正好在被藏起来的卡上,焦点退到新序列首。 */
export function toggleGroupCollapsed(
  state: ExposeState,
  groupId: string,
  groups: SessionGroup[],
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
 * 「顺手把这块面收回 Dock」是 Placement 的事,纯函数不认识落点 —— 那一步在 store 壳里。
 */
export function enterSession(state: ExposeState, sessionId: string): ExposeState {
  return { ...state, currentSessionId: sessionId, view: { mode: 'overview' }, query: '' }
}

/* ── 派生:搜索与时间 ──────────────────────────────────────────────────── */

function has(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle)
}

/**
 * 两层一次算完:会话行(标题 / 预览)+ 命中章节。视图只负责画,不再自己 filter。
 *
 * `chapters` 是**已经拉到手**的那份按会话缓存(数据源的 chapters 表)——
 * 没拉过的会话在这一轮就只按标题与预览命中,拉到之后下一轮渲染自然带上章节。
 * 搜索不该反过来去驱动一场全量取数。
 *
 * ── 诚实缺口:消息正文搜不到 ─────────────────────────────────────────────
 * D1 到此为止。后端**没有**跨会话的内容检索面(`sessions.*` 二十六条里没有一条
 * 是「在所有会话里搜正文」,`search` 域是网页搜索不是会话搜索),前端唯一的替代
 * 是把每条会话的每一页消息都拉下来在内存里扫 —— 那是把缺口伪装成功能。
 * 所以第三层现在不存在,留待后批(需要后端先有一个真检索面)。
 */
export function searchSessions(
  query: string,
  sessions: SessionSummary[],
  chapters: Record<string, SessionChapter[]> = {},
): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits: SearchHit[] = []
  for (const session of sessions) {
    const matched = (chapters[session.id] ?? []).filter(
      (chapter) => has(chapter.title, q) || has(chapter.detail, q),
    )
    const head = has(session.title, q) || has(session.preview, q)
    if (head || matched.length > 0) hits.push({ session, chapters: matched })
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

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** list 视图的时间分组。D1 起判据是**真时间戳**,不再是猜一个中文字符串的形状。 */
export function timeBucket(updatedAt: number, now: number): TimeBucket {
  return now - updatedAt < WEEK_MS ? 'thisWeek' : 'earlier'
}

/**
 * 卡面右下角那一小行时间的**标识**。同 timeBucket:纯函数只产出「这是哪一类
 * 时间」加上组成它的数,成品字符串由渲染层查字典拼(见 components/session-time.ts)。
 */
export type RelativeTimeLabel =
  | { kind: 'clock'; hh: string; mm: string }
  | { kind: 'yesterday' }
  | { kind: 'weekday'; weekday: number }
  | { kind: 'date'; month: number; day: number }

function startOfDay(ts: number): number {
  const date = new Date(ts)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

const DAY_MS = 24 * 60 * 60 * 1000

export function relativeTime(updatedAt: number, now: number): RelativeTimeLabel {
  const at = new Date(updatedAt)
  const days = Math.round((startOfDay(now) - startOfDay(updatedAt)) / DAY_MS)
  if (days <= 0) {
    return {
      kind: 'clock',
      hh: String(at.getHours()).padStart(2, '0'),
      mm: String(at.getMinutes()).padStart(2, '0'),
    }
  }
  if (days === 1) return { kind: 'yesterday' }
  if (days < 7) return { kind: 'weekday', weekday: at.getDay() }
  return { kind: 'date', month: at.getMonth() + 1, day: at.getDate() }
}
