import { buildListModel, rowIndexOf, type ListModel } from './list-model'
import { exposeIntentOf, stepRowIndex, type ExposeIntent } from './keys'
import { ALL_SCOPE, resolveScope } from './scopes'
import type { ExposeState, FocusDir, HighlightPart, ProjectScope, SessionSummary } from './types'

/**
 * 会话总览的状态机 —— 纯函数,不认识 React、不发请求、**不认识数据源**。
 *
 * D1(接真数据)只改了一件事:凡是要看「有哪些会话」的函数,那份数据一律
 * **从参数进来**,不再有 mock 表当默认值。
 *
 * ── 09-04 方向 A:参数从「分好组的事实」换成「原始名册 + 此刻」 ──────────────
 * 从前递进来的是 `SessionGroup[]`(已经分好组的事实),因为屏幕的形状就是那份
 * 分组。现在屏幕的形状是**按时间分的节 + 房间的子行**,而落哪一节要知道「此刻
 * 几点」、展哪一支要知道 state 自己的 `expandedRooms` —— 一份预先分好的表表达
 * 不了它。所以接缝改成 `ListFacts { sessions, now }`:**原始事实**进来,
 * 形状由 `list-model.buildListModel` 现算,而它是纯的。
 *
 * 焦点序列因此只有一个产地 —— `ListModel.rowIds`。`visibleCardIds` 那条与画面
 * 各算一遍的路(以及它背后的 `filterGroups` / `isCollapsed`)09-04 一并退役。
 */

/** 状态机要看屏幕时问的两件事。**原始事实**,不是算好的形状。 */
export interface ListFacts {
  /** 屏幕上那一份会话(数据源已按工作区过滤;形态一档不少)。 */
  sessions: readonly SessionSummary[]
  /** 「此刻」。分节要它 —— 纯函数不许自己去问 `Date.now()`。 */
  now: number
}

/**
 * 这一刻的列表模型。**唯一产地** —— 画面、方向键、Quick Look 邻居全从这里出,
 * 所以三者结构上不可能说不同的话。
 */
export function listModelOf(state: ExposeState, facts: ListFacts): ListModel {
  return buildListModel({
    sessions: facts.sessions,
    scope: state.scope,
    query: state.query,
    expandedRooms: state.expandedRooms,
    now: facts.now,
  })
}

/** 焦点序列(接替从前的 `visibleCardIds`)。 */
export function rowIdsOf(state: ExposeState, facts: ListFacts): string[] {
  return listModelOf(state, facts).rowIds
}

export const initialExposeState: ExposeState = {
  view: { mode: 'overview' },
  focusId: null,
  focusVisible: false,
  // 出厂即「全部」:打开就看见全部是这块面的语义,记住上次那一格是家具(store)。
  scope: ALL_SCOPE,
  // 房间缺省收起 —— 展开永远是一次用户动作(或搜索命中子行时的派生态)。
  expandedRooms: [],
  query: '',
  // 空串 = 还没有当前会话。开场归位时它会落到序列首。
  currentSessionId: '',
}

function clampIndex(i: number, len: number): number {
  return Math.min(Math.max(i, 0), Math.max(len - 1, 0))
}

/** 点亮焦点环。已经亮着就是**同一个引用**(不触发一次白重渲染)。 */
function lit(state: ExposeState): ExposeState {
  return state.focusVisible ? state : { ...state, focusVisible: true }
}

/**
 * 焦点夹持:焦点落在一行已经不在屏幕上的行上时,退到新序列首。
 * 改搜索词 / 换范围 / 收起房间 / 会话被删,四处逐字同一句话,所以只写一遍。
 */
function clampFocus(next: ExposeState, facts: ListFacts): ExposeState {
  if (!next.focusId) return next
  const rowIds = rowIdsOf(next, facts)
  if (rowIds.includes(next.focusId)) return next
  return { ...next, focusId: rowIds[0] ?? null }
}

/* ── 开场 ──────────────────────────────────────────────────────────────── */

/**
 * 开场归位:这块面一在场,内容就从总览起步,搜索词清空,焦点**锚点**落在当前
 * 会话上(方向键第一下有起点),但环不点亮 —— 焦点环只属于键盘会话。
 *
 * 它是**无条件**的:上次退出时停在 quicklook 不该在下次打开时还原。
 * 范围那一格例外地要**核一次**(`resolveScope`):它是持久化的家具,而项目会
 * 被删空、协作会清零 —— 指着一个不存在的入口开出来的是一张空表,那是说谎。
 */
export function open(state: ExposeState, facts: ListFacts): ExposeState {
  // 序列要按**清空搜索词、核过范围之后**的屏幕算:拿上一次的过滤结果去落焦点,
  // 会把焦点落到一行马上就要重新出现的邻居上。
  const next: ExposeState = {
    ...state,
    view: { mode: 'overview' },
    query: '',
    scope: resolveScope(state.scope, facts.sessions),
  }
  const rowIds = rowIdsOf(next, facts)
  const focusId = rowIds.includes(state.currentSessionId)
    ? state.currentSessionId
    : (rowIds[0] ?? null)
  return { ...next, focusId, focusVisible: false }
}

/**
 * Esc 逐层:quicklook → overview。层级写在这一个函数里,组件不许自己排序。
 *
 * 到了总览这一层就**没有下一层**了:这一下不归内容管,由宿主(舞台 / 浮窗 /
 * 架子)去关这块面 —— 所以这里是恒等变换,而不是「自己把自己关掉」。
 */
export function escape(state: ExposeState): ExposeState {
  return state.view.mode === 'quicklook' ? { ...state, view: { mode: 'overview' } } : state
}

/* ── 层内迁移 ──────────────────────────────────────────────────────────── */

export function openQuickLook(state: ExposeState, sessionId: string): ExposeState {
  return { ...state, view: { mode: 'quicklook', sessionId }, focusId: sessionId }
}

export function closeQuickLook(state: ExposeState): ExposeState {
  return escape(state)
}

/* ── 范围(侧栏) ──────────────────────────────────────────────────────── */

/**
 * 换一格范围。屏幕整批换掉,所以焦点要夹持一次(与改搜索词同一句话);
 * 搜索词**留着** —— 换个范围继续用同一个词是过滤器的常识,清掉是替用户做决定。
 */
export function setScope(
  state: ExposeState,
  scope: ProjectScope,
  facts: ListFacts,
): ExposeState {
  return clampFocus({ ...state, scope }, facts)
}

/* ── 房间展开 ──────────────────────────────────────────────────────────── */

export function isRoomExpanded(state: ExposeState, sessionId: string): boolean {
  return state.expandedRooms.includes(sessionId)
}

export function expandRoom(state: ExposeState, sessionId: string): ExposeState {
  if (isRoomExpanded(state, sessionId)) return state
  return { ...state, expandedRooms: [...state.expandedRooms, sessionId] }
}

/**
 * 收起一间房。焦点正落在它某个子行上时**退到房间那一行** —— 而不是退到序列首:
 * 收起是一次「往上走一层」的动作,焦点该跟着走到那一层,不该被弹到列表开头。
 */
export function collapseRoom(
  state: ExposeState,
  sessionId: string,
  facts: ListFacts,
): ExposeState {
  if (!isRoomExpanded(state, sessionId)) return state
  const model = listModelOf(state, facts)
  const focused = state.focusId
  const onChild =
    !!focused &&
    model.sections.some((section) =>
      section.rows.some((row) => row.id === focused && row.parentId === sessionId),
    )
  const next: ExposeState = {
    ...state,
    expandedRooms: state.expandedRooms.filter((id) => id !== sessionId),
    ...(onChild ? { focusId: sessionId } : {}),
  }
  return clampFocus(next, facts)
}

export function toggleRoom(
  state: ExposeState,
  sessionId: string,
  facts: ListFacts,
): ExposeState {
  return isRoomExpanded(state, sessionId)
    ? collapseRoom(state, sessionId, facts)
    : expandRoom(state, sessionId)
}

/* ── 焦点 ──────────────────────────────────────────────────────────────── */

/**
 * 「把键盘交给列表」—— 搜索框里按 ↑↓ 时走这一条。
 *
 * 它**只点亮不移动**:开场归位已经把焦点锚在当前会话(或序列首)上了,
 * 交接的那一下要让用户看见锚点在哪,而不是从一个他还没看见的位置再走一步。
 * 锚点失效(被过滤掉了)时才落到序列首。
 */
export function focusGrid(state: ExposeState, facts: ListFacts): ExposeState {
  const rowIds = rowIdsOf(state, facts)
  if (rowIds.length === 0) return state
  if (state.focusId && rowIds.includes(state.focusId)) return lit(state)
  return { ...state, focusId: rowIds[0], focusVisible: true }
}

/**
 * 活动行上下走。**一维**(方向 A:列表一行一条会话,没有「一行几张」这回事),
 * 到头不回绕 —— 步进判据在 `keys.stepRowIndex`,那一只复用 `ui/a11y/roving`
 * 的算术,所以「到头就停」与菜单那边的「到头回绕」不是两份手写的加一减一。
 */
export function moveFocus(
  state: ExposeState,
  dir: FocusDir,
  facts: ListFacts,
): ExposeState {
  const rowIds = rowIdsOf(state, facts)
  if (rowIds.length === 0) return state
  const cur = state.focusId ? rowIds.indexOf(state.focusId) : -1
  const next = stepRowIndex(dir === 'up' ? 'move-up' : 'move-down', cur, rowIds.length)
  if (next === null) return state
  // 撞边不动位置也要点亮环:用户按了方向键,就该看得见焦点在哪。
  if (rowIds[next] === state.focusId) return lit(state)
  return { ...state, focusId: rowIds[next], focusVisible: true }
}

/** `treeKey` 认的四种意图 —— 纵向那两个走 `moveFocus`,不从这个口进。 */
export type TreeKeyIntent = Extract<ExposeIntent, 'expand' | 'collapse' | 'home' | 'end'>

/**
 * 树语义的横向与首尾(§3.2 那张表的「焦点在树」那一列):
 *
 *  · `expand`(→):房间未展开 → 展开;已展开 → 进第一个子行;非房间 → 无动作;
 *  · `collapse`(←):子行 → 回父;展开的房间 → 收起;其余 → 无动作;
 *  · `home` / `end`:首行 / 末行。
 *
 * 「无动作」指**位置与展开态都不动**,但环照旧点亮 —— 按了键却什么都看不见
 * 是最难排查的一种沉默(与 `moveFocus` 撞边同一条口径)。
 * 还没落焦时任何一下都先把焦点放到序列首,与方向键同一句话。
 */
export function treeKey(
  state: ExposeState,
  intent: TreeKeyIntent,
  facts: ListFacts,
): ExposeState {
  const model = listModelOf(state, facts)
  const { rowIds } = model
  if (rowIds.length === 0) return state

  if (intent === 'home' || intent === 'end') {
    const target = intent === 'home' ? rowIds[0] : rowIds[rowIds.length - 1]
    return target === state.focusId ? lit(state) : { ...state, focusId: target, focusVisible: true }
  }

  const cur = rowIndexOf(model, state.focusId)
  if (cur < 0) return { ...state, focusId: rowIds[0], focusVisible: true }
  const row = model.sections.flatMap((section) => section.rows).find((r) => r.id === state.focusId)
  if (!row) return lit(state)

  if (intent === 'expand') {
    if (!row.expandable) return lit(state)
    if (!row.expanded) return lit(expandRoom(state, row.id))
    // 已展开:进第一个子行 —— 它就是序列里紧跟着这一行的那一个(flatten 的次序)。
    const first = rowIds[cur + 1]
    return first ? { ...state, focusId: first, focusVisible: true } : lit(state)
  }

  // collapse
  if (row.parentId) return { ...state, focusId: row.parentId, focusVisible: true }
  if (row.expandable && row.expanded) return lit(collapseRoom(state, row.id, facts))
  return lit(state)
}

/** `KeyboardEvent.key` → 这块面的意图。键名判据的单产地在 `keys.ts`。 */
export { exposeIntentOf }
export type { ExposeIntent }

/* ── Quick Look 内换会话 ───────────────────────────────────────────────── */

function quickLookStep(state: ExposeState, delta: number, facts: ListFacts): ExposeState {
  if (state.view.mode !== 'quicklook') return state
  const rowIds = rowIdsOf(state, facts)
  const i = rowIds.indexOf(state.view.sessionId)
  if (i < 0) return state
  const j = clampIndex(i + delta, rowIds.length)
  if (j === i) return state
  return {
    ...state,
    view: { mode: 'quicklook', sessionId: rowIds[j] },
    focusId: rowIds[j],
    focusVisible: true,
  }
}

/** 到头就停(不回绕):和 moveFocus 同一个边界口径,免得两种键有两种直觉。 */
export function quickLookPrev(state: ExposeState, facts: ListFacts): ExposeState {
  return quickLookStep(state, -1, facts)
}

export function quickLookNext(state: ExposeState, facts: ListFacts): ExposeState {
  return quickLookStep(state, 1, facts)
}

/**
 * 左右两个邻居的 id,到头是 null。给 Quick Look 上那对 ‹ › 控件用:
 * **禁用态得和键盘的「到头就停」是同一个判据**,否则会出现「按钮灰着但 ← 还能走」
 * 这种两套直觉。所以它和 quickLookStep 读的是同一条 `rowIds`(含范围与搜索)。
 */
export function quickLookNeighbors(
  state: ExposeState,
  facts: ListFacts,
): { prev: string | null; next: string | null } {
  if (state.view.mode !== 'quicklook') return { prev: null, next: null }
  const rowIds = rowIdsOf(state, facts)
  const i = rowIds.indexOf(state.view.sessionId)
  if (i < 0) return { prev: null, next: null }
  return {
    prev: i > 0 ? rowIds[i - 1] : null,
    next: i < rowIds.length - 1 ? rowIds[i + 1] : null,
  }
}

/* ── 搜索 / 进入 ───────────────────────────────────────────────────────── */

/**
 * 改搜索词。它**不换形态** —— 搜索是过滤器,不是另一层视图(F 批裁定,方向 A
 * §1.4 照旧):形状一格不变,不命中的行消失、空掉的节消失、命中词高亮。
 *
 * 唯一的附带动作是夹持:焦点所在的行要是被过滤掉了,焦点退到新序列首。
 */
export function setQuery(state: ExposeState, query: string, facts: ListFacts): ExposeState {
  return clampFocus({ ...state, query }, facts)
}

/**
 * 「进入」= 换当前会话 + 内容回到起点(退出 quicklook、清掉搜索词)。
 * 「顺手把这块面收回 Dock」是 Placement 的事,纯函数不认识落点 —— 那一步在 store 壳里。
 */
export function enterSession(state: ExposeState, sessionId: string): ExposeState {
  return { ...state, currentSessionId: sessionId, view: { mode: 'overview' }, query: '' }
}

/* ── 会话没了 ──────────────────────────────────────────────────────────── */

/**
 * 有会话被删掉了(H 批)。入参 `facts` 是**摘除之后**的那份名册 ——
 * 数据源先改列表再叫这个函数,所以这里算出来的序列已经不含被删的行。
 *
 * 它只做**夹持**,不做导航:被删的那条会话在屏幕上留下的每一个指针都得收回来,
 * 但一个还站得住的指针一格都不动。三条,各有各的理由:
 *
 *  1. Quick Look 正开着被删的那条 → 退回总览。不退的话状态机停在 quicklook 档
 *     而面板画不出任何东西,键盘语义与屏幕对不上。
 *  2. 当前会话被删 → 回**空态**(空串),而不是自动挑一条顶上:
 *     替用户选下一条会话是替他做决定。
 *  3. 焦点落在一行已经不在的行上 → 退到新序列首。与改搜索词逐字同一句话。
 *
 * 「组列表停在一个空掉的组」那一条随 list 视图一起退役(方向 A 没有那一层)。
 * 展开表里留着一个已被删的房间 id **不清** —— 它是一格无害的死键(那一行都不在了,
 * 展不出任何东西),而清它要多一次全量比对;房间再出现时它照旧是展开的,
 * 那正是用户上次留下的意思。
 *
 * 一条都没碰到时返回**同一个 state 引用** —— 别人删会话不该让这块面重渲染。
 */
export function sessionsRemoved(
  state: ExposeState,
  removedIds: readonly string[],
  facts: ListFacts,
): ExposeState {
  if (removedIds.length === 0) return state
  const gone = new Set(removedIds)
  let next = state

  const view = next.view
  if (view.mode === 'quicklook' && gone.has(view.sessionId)) {
    next = { ...next, view: { mode: 'overview' } }
  }

  if (next.currentSessionId && gone.has(next.currentSessionId)) {
    next = { ...next, currentSessionId: '' }
  }

  if (next.focusId && gone.has(next.focusId)) {
    next = { ...next, focusId: rowIdsOf(next, facts)[0] ?? null }
  }

  return next
}

/* ── 派生:搜索与时间 ──────────────────────────────────────────────────── */

/**
 * 一条会话命不命中。**判据住在 `list-model.ts`**(它是模型第 4 步的判据),
 * 这里只是把它按老地址再交出去一次 —— 依赖方向单向:transitions → list-model。
 */
export { sessionMatchesQuery } from './list-model'

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
 * 同一件事的第二个**入口**,不是第二份实现:命中区间由**别人**判好了递进来。
 *
 * `splitHighlight` 服务的是「文本与词都在手上,自己 indexOf」那一路;
 * 这一路服务的是「命中是产地判的」—— 跨会话正文检索的片段与 `matchRanges`
 * 都由后端给出,而后端的判据与本地的 `indexOf` 不完全一样(它先
 * `normalizeQuery` 剥掉开头的 `>` 与 `/`)。拿本地那条再算一遍就有两个产地
 * 各说一次「什么算命中」—— 迟早对不上。
 *
 * 入参**当作不可信**:区间来自另一个进程,可能越界、可能乱序、可能重叠。
 * 于是这里排序、夹进 `[0, text.length]`、丢掉空段与被前一段吞掉的那一段。
 */
export function splitHighlightRanges(
  text: string,
  ranges: readonly { start: number; end: number }[],
): HighlightPart[] {
  const clamped = ranges
    .map((range) => ({
      start: Math.max(0, Math.min(text.length, Math.trunc(range.start))),
      end: Math.max(0, Math.min(text.length, Math.trunc(range.end))),
    }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start)
  const parts: HighlightPart[] = []
  let from = 0
  for (const range of clamped) {
    // 与前一段重叠(或被它整个吞掉)的那一段:只取还没画过的那一截。
    const start = Math.max(range.start, from)
    if (range.end <= start) continue
    if (start > from) parts.push({ text: text.slice(from, start), hit: false })
    parts.push({ text: text.slice(start, range.end), hit: true })
    from = range.end
  }
  if (from < text.length) parts.push({ text: text.slice(from), hit: false })
  return parts.length > 0 ? parts : [{ text, hit: false }]
}

/**
 * 行右端那一小行时间的**标识**。纯函数只产出「这是哪一类时间」加上组成它的数,
 * 成品字符串由渲染层查字典拼(见 components/session-time.ts)——
 * 与 `sections.SectionLabel` 是同一条判例的两处落地。
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
