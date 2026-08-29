import type {
  ExposeState,
  FocusDir,
  HighlightPart,
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

/**
 * 卡网格的**出厂列数**。列数本身不再是常量 —— CSS 用 auto-fill 按容器宽度现算,
 * 渲染层把算出来的那个数读回状态机(setColumns),↑↓ 走一整行就永远走对。
 * 这个常量只是「还没量到之前先按几列算」的起手值,取 3 = 舞台满宽下的真实列数。
 */
export const CARD_COLS = 3

/**
 * 把 `grid-template-columns` 的**计算值**读成列数。
 *
 * 计算值是已解析的轨道列表('286.93px 286.93px 286.93px'),所以数轨道就是数列 ——
 * 不重算一遍 auto-fill 的公式,也就不会和 CSS 漂移。读不出来(jsdom 给空串、
 * 或还是没解析的 'repeat(...)' / 'none')一律回 null = 「这次没量到,别改状态」。
 */
export function columnsFromTemplate(template: string | null | undefined): number | null {
  if (!template) return null
  const text = template.trim()
  if (!text || text === 'none' || text.includes('(')) return null
  const tracks = text.split(/\s+/).filter(Boolean)
  return tracks.length > 0 ? tracks.length : null
}

/** 列数只在 [1, …] 里有意义:量到 0 或负数一律读作 1 列。 */
export function setColumns(state: ExposeState, columns: number): ExposeState {
  const next = Number.isFinite(columns) ? Math.max(1, Math.round(columns)) : CARD_COLS
  return next === state.columns ? state : { ...state, columns: next }
}

/**
 * 「把键盘交给网格」—— 搜索框里按 ↑↓ 时走这一条。
 *
 * 它**只点亮不移动**:开场归位已经把焦点锚在当前会话(或序列首)上了,
 * 交接的那一下要让用户看见锚点在哪,而不是从一个他还没看见的位置再走一步。
 * 锚点失效(被过滤 / 被折叠藏起来)时才落到序列首。
 */
export function focusGrid(state: ExposeState, groups: SessionGroup[]): ExposeState {
  const seq = visibleCardIds(state, groups)
  if (seq.length === 0) return state
  const anchored = state.focusId && seq.includes(state.focusId)
  if (anchored) return state.focusVisible ? state : { ...state, focusVisible: true }
  return { ...state, focusId: seq[0], focusVisible: true }
}

export const initialExposeState: ExposeState = {
  view: { mode: 'overview' },
  focusId: null,
  focusVisible: false,
  columns: CARD_COLS,
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
 * 焦点序列 = **屏幕上真的画着的那些卡**,按阅读次序拼接。
 * 两道减法,次序即语义:先按搜索词过滤(filterGroups),再摘掉折叠起来的组。
 *
 * 所以 moveFocus / quickLookPrev-Next 都只认这一个函数,不各算各的 ——
 * F 批把搜索也并进来之后,这条规矩才真正兑现:搜索时按 → 走的是**过滤后**的
 * 下一张卡,而不是一张已经不在屏幕上的卡。
 */
export function visibleCardIds(state: ExposeState, groups: SessionGroup[]): string[] {
  return filterGroups(groups, state.query)
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
  // 序列要按**清空搜索词之后**的屏幕算:开场就是重新看一眼全部,
  // 拿上一次的过滤结果去落焦点会把焦点落到一张马上就要重新出现的邻居上。
  const next: ExposeState = { ...state, view: { mode: 'overview' }, query: '' }
  const seq = visibleCardIds(next, groups)
  const focusId = seq.includes(state.currentSessionId) ? state.currentSessionId : (seq[0] ?? null)
  return { ...next, focusId, focusVisible: false }
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
  // 一整行有几张是**屏幕的事实**(state.columns 由渲染层现读 CSS 计算值报进来),
  // 不是常量:窄成一列时 ↑↓ 就该走一张,而不是固执地跳三张。
  const cols = Math.max(1, state.columns)
  const step = dir === 'left' ? -1 : dir === 'right' ? 1 : dir === 'up' ? -cols : cols
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

/**
 * 左右两个邻居的 id,到头是 null。给 Quick Look 上那对 ‹ › 控件用:
 * **禁用态得和键盘的「到头就停」是同一个判据**,否则会出现「按钮灰着但 ← 还能走」
 * 这种两套直觉。所以它和 quickLookStep 读的是同一条 visibleCardIds(含搜索过滤)。
 */
export function quickLookNeighbors(
  state: ExposeState,
  groups: SessionGroup[],
): { prev: string | null; next: string | null } {
  if (state.view.mode !== 'quicklook') return { prev: null, next: null }
  const seq = visibleCardIds(state, groups)
  const i = seq.indexOf(state.view.sessionId)
  if (i < 0) return { prev: null, next: null }
  return {
    prev: i > 0 ? seq[i - 1] : null,
    next: i < seq.length - 1 ? seq[i + 1] : null,
  }
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

/**
 * 改搜索词。它**不换形态** —— 这是 F 批的核心裁定:搜索是过滤器,不是第四层视图。
 *
 * 唯一的附带动作和 toggleGroupCollapsed 逐字相同:焦点所在的卡要是被过滤掉了,
 * 焦点退到新序列首(否则方向键的第一下会从一张不存在的卡起步)。
 * 所以它和折叠一样需要那份分组事实。
 */
export function setQuery(
  state: ExposeState,
  query: string,
  groups: SessionGroup[],
): ExposeState {
  const next: ExposeState = { ...state, query }
  const seq = visibleCardIds(next, groups)
  if (next.focusId && !seq.includes(next.focusId)) {
    return { ...next, focusId: seq[0] ?? null }
  }
  return next
}

/**
 * 「进入」= 换当前会话 + 内容回到起点(退出 quicklook / list、清掉搜索词)。
 * 「顺手把这块面收回 Dock」是 Placement 的事,纯函数不认识落点 —— 那一步在 store 壳里。
 */
export function enterSession(state: ExposeState, sessionId: string): ExposeState {
  return { ...state, currentSessionId: sessionId, view: { mode: 'overview' }, query: '' }
}

/* ── 会话没了 ──────────────────────────────────────────────────────────── */

/**
 * 有会话被删掉了(H 批)。入参 `groups` 是**摘除之后**的那份分组事实 ——
 * 数据源先改列表再叫这个函数,所以这里看到的序列已经不含被删的卡。
 *
 * 它只做**夹持**,不做导航:被删的那条会话在屏幕上留下的每一个指针都得收回来,
 * 但一个还站得住的指针一格都不动。四条,各有各的理由:
 *
 *  1. Quick Look 正开着被删的那条 → 退回总览。不退的话状态机停在 quicklook 档
 *     而面板画不出任何东西(`findSession` 已经找不到它),键盘语义与屏幕对不上。
 *  2. 组列表停在一个已经空掉、于是从分组事实里消失的组 → 退回总览。
 *     留在那儿看到的是一张空表 + 一条拿 groupId 当组名的面包屑。
 *  3. 当前会话被删 → 回**空态**(空串),而不是自动挑一条顶上:
 *     替用户选下一条会话是替他做决定,而 TopBar 的「新会话」文案与空聊天区
 *     本来就是这块壳对「还没有当前会话」的既有说法。
 *  4. 焦点落在一张已经不在的卡上 → 退到新序列首。与折叠 / 改搜索词逐字同一句话。
 *
 * 一条都没碰到时返回**同一个 state 引用** —— 别人删会话不该让这块面重渲染。
 */
export function sessionsRemoved(
  state: ExposeState,
  removedIds: readonly string[],
  groups: SessionGroup[],
): ExposeState {
  if (removedIds.length === 0) return state
  const gone = new Set(removedIds)
  let next = state

  const view = next.view
  if (view.mode === 'quicklook' && gone.has(view.sessionId)) {
    next = { ...next, view: { mode: 'overview' } }
  } else if (view.mode === 'list' && !groups.some((g) => g.id === view.groupId)) {
    next = { ...next, view: { mode: 'overview' } }
  }

  if (next.currentSessionId && gone.has(next.currentSessionId)) {
    next = { ...next, currentSessionId: '' }
  }

  if (next.focusId && gone.has(next.focusId)) {
    next = { ...next, focusId: visibleCardIds(next, groups)[0] ?? null }
  }

  return next
}

/* ── 派生:搜索与时间 ──────────────────────────────────────────────────── */

function has(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle)
}

/**
 * 一条会话命不命中。看的正是卡面上写着的那三格:标题、预览、摘要
 * —— 「命中的东西必须在卡上看得见」是 F 批的口径,所以搜的格与画的格是同一批。
 * H 批把摘要(`digest`,产地 `SessionMeta.lastMessagePreview`)接上卡面的同一刻
 * 就把它加进判据:少加一格就会出现「卡上明明标着那个词却搜不出来」。
 * 摘要缺席(老会话)时它是 null,那一格既不画也不参与判定。
 *
 * ── 诚实缺口:消息正文搜不到 ─────────────────────────────────────────────
 * 后端**没有**跨会话的内容检索面(`sessions.*` 二十六条里没有一条是「在所有会话里
 * 搜正文」,`search` 域是网页搜索不是会话搜索),前端唯一的替代是把每条会话的每一页
 * 消息都拉下来在内存里扫 —— 那是把缺口伪装成功能。留待后批(需要后端先有一个真检索面)。
 * 摘要只是「最后一条消息的一行」,不是正文检索,这条缺口一格没变。
 */
export function sessionMatchesQuery(session: SessionSummary, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    has(session.title, q) ||
    has(session.preview, q) ||
    (session.digest !== null && has(session.digest, q))
  )
}

/**
 * 一个组命不命中。判据只有**项目名**(工作目录的末段)——
 *
 * 不判路径:绝对路径里 `/Users/<我>/code/` 这一截在几乎每个项目上都一样,
 * 拿它当判据的话打三个字母就「全都命中」,过滤器等于没有。
 * 不判合成组(协作 / 独立)的组名:那两个名字是**界面文案**(nameKey),
 * 拿它当判据会让「搜什么词能保住这一组」随语言而变 —— 数据面的过滤器不该有这种事。
 */
export function groupMatchesQuery(group: SessionGroup, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return false
  return group.name !== undefined && has(group.name, q)
}

/**
 * **搜索的全部**:一个分组事实 + 一个词 → 另一个分组事实。形态一格没变,
 * 所以屏幕上仍是「项目头 + 卡网格」,卡照常能 QuickLook / 进入 / 键盘走查。
 *
 * 两种命中取**并集**(用户 08-29 拍板):
 *  - 词命中项目名 → 该组**整组保留**(组里全部会话都在,组头自己会高亮);
 *  - 否则 → 组内按卡过滤,一张不剩的组整个消失。
 * 空词是恒等变换,而且**原样返回同一个数组引用** —— 不搜的那条路上一次多余的
 * 分配都不该有(它是每次渲染、每次按方向键都要走的路)。
 */
export function filterGroups(groups: SessionGroup[], query: string): SessionGroup[] {
  const q = query.trim()
  if (!q) return groups
  const kept: SessionGroup[] = []
  for (const group of groups) {
    if (groupMatchesQuery(group, q)) {
      kept.push(group)
      continue
    }
    const sessions = group.sessions.filter((session) => sessionMatchesQuery(session, q))
    if (sessions.length > 0) kept.push({ ...group, sessions })
  }
  return kept
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
