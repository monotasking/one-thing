import {
  buildListModel,
  findRow,
  findSectionOf,
  isSectionRowId,
  rowIndexOf,
  type ListModel,
} from './list-model'
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
    collapsedSections: state.collapsedSections,
    now: facts.now,
  })
}

/** 焦点序列(接替从前的 `visibleCardIds`)。**含节头** —— 节头也是树的一项。 */
export function rowIdsOf(state: ExposeState, facts: ListFacts): string[] {
  return listModelOf(state, facts).rowIds
}

/**
 * 同一条序列里只有会话的那一半。Quick Look(‹ › 与 ←→)吃它:
 * 「翻下一条」翻的是会话,节头不是可以预览的东西。
 */
export function sessionRowIdsOf(state: ExposeState, facts: ListFacts): string[] {
  return listModelOf(state, facts).sessionRowIds
}

/**
 * 「焦点没处落时落哪儿」——**优先第一条会话行**,而不是序列首(那是个节头)。
 *
 * 理由是 ↵:开场归位之后用户按 ↓ 再按 ↵,期待的是进一条会话;锚点落在节头上时
 * 那一下会变成「把今天收起来」。节头照旧在序列里(方向键走得到、← → 收得动),
 * 只是不当那个**默认**落点。一节都没展开时才退回序列首(那时屏幕上只有节头)。
 */
function anchorOf(model: ListModel): string | null {
  return model.sessionRowIds[0] ?? model.rowIds[0] ?? null
}

export const initialExposeState: ExposeState = {
  view: { mode: 'overview' },
  focusId: null,
  focusVisible: false,
  // 出厂即「全部」:打开就看见全部是这块面的语义,记住上次那一格是家具(store)。
  scope: ALL_SCOPE,
  // 房间缺省收起 —— 展开永远是一次用户动作(或搜索命中子行时的派生态)。
  expandedRooms: [],
  // 分节缺省**全开**,所以这一格记的是「我关掉了哪几节」(见 types.ts 那段)。
  collapsedSections: [],
  query: '',
  // 出厂是**一行字**,不是一只空输入框(09-12 方向 A:顶上没有常驻输入框)。
  searching: false,
  // 出厂没有哪一行在改名(A2)。同样不落盘,理由见 types.ts 那一格。
  renamingId: null,
  // 空串 = 还没有当前会话。开场归位时它会落到序列首。
  // **W5-b 起这两格是投影**(唯一写者 `content/session-projection.ts`);
  // 这里只是出厂值,形态机的每一条都不写它们。
  currentSessionId: '',
  envSessionId: '',
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
  const model = listModelOf(next, facts)
  if (model.rowIds.includes(next.focusId)) return next
  return { ...next, focusId: anchorOf(model) }
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
    // 开场即一行字:上次退出时那只开着的输入框不该在下次打开时还原(§4①)。
    searching: false,
    // 归位同样清掉原地改名(A2):理由与上一行逐字相同 —— 这块面重新摆出来时
    // 屏幕上不该还留着一只开着的改名框(何况那条会话可能已经不在这一屏了)。
    renamingId: null,
    scope: resolveScope(state.scope, facts.sessions),
  }
  const model = listModelOf(next, facts)
  const focusId = model.rowIds.includes(state.currentSessionId)
    ? state.currentSessionId
    : anchorOf(model)
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

/**
 * Quick Look 一条会话。**节头上是恒等变换**(Space 落在节头上什么都不做):
 * 一个分组没有可以预览的正文,开出来只会是一屏空白。判据(`isSectionRowId`)
 * 只在这一处问 —— 壳那层按「view 有没有真的变」决定要不要去拉消息。
 */
export function openQuickLook(state: ExposeState, sessionId: string): ExposeState {
  if (isSectionRowId(sessionId)) return state
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

/* ── 分节折叠(09-04 用户报「分组没法收」)─────────────────────────────── */

export function isSectionCollapsed(state: ExposeState, sectionId: string): boolean {
  return state.collapsedSections.includes(sectionId)
}

export function expandSection(state: ExposeState, sectionId: string): ExposeState {
  if (!isSectionCollapsed(state, sectionId)) return state
  return { ...state, collapsedSections: state.collapsedSections.filter((id) => id !== sectionId) }
}

/**
 * 收起一节。焦点正落在这一节的某条会话行上时**退到节头**——与 `collapseRoom`
 * 逐字同一条:收起是一次「往上走一层」,焦点该跟到那一层,不该被弹回列表开头。
 *
 * 夹持照旧走 `clampFocus`(节头在序列里,所以这一手之后它一定站得住)。
 */
export function collapseSection(
  state: ExposeState,
  sectionId: string,
  facts: ListFacts,
): ExposeState {
  if (isSectionCollapsed(state, sectionId)) return state
  const section = listModelOf(state, facts).sections.find((s) => s.id === sectionId)
  const onRow = !!state.focusId && !!section?.rows.some((row) => row.id === state.focusId)
  const next: ExposeState = {
    ...state,
    collapsedSections: [...state.collapsedSections, sectionId],
    ...(onRow && section ? { focusId: section.head.id } : {}),
  }
  return clampFocus(next, facts)
}

export function toggleSection(
  state: ExposeState,
  sectionId: string,
  facts: ListFacts,
): ExposeState {
  return isSectionCollapsed(state, sectionId)
    ? expandSection(state, sectionId)
    : collapseSection(state, sectionId, facts)
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
  const model = listModelOf(state, facts)
  if (model.rowIds.length === 0) return state
  if (state.focusId && model.rowIds.includes(state.focusId)) return lit(state)
  return { ...state, focusId: anchorOf(model), focusVisible: true }
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
  if (cur < 0) return { ...state, focusId: anchorOf(model), focusVisible: true }
  const row = findRow(model, state.focusId)
  if (!row) return lit(state)

  /*
   * ── 节头这一档(09-04)────────────────────────────────────────────────
   * 与房间那一档**同一句话**(→ 展开 / 进第一个孩子,← 收起),只是收展的动作
   * 换成分节那一对。写成两支而不是抽一个「可展开的项」的共同抽象:两支的
   * 「孩子」不是同一种东西(节的孩子是顶层会话,房间的孩子是子会话),
   * 硬合会逼出一个既要认节又要认房的参数,那才是真的两个产地。
   */
  if (row.type === 'section') {
    if (intent === 'expand') {
      if (!row.expanded) return lit(expandSection(state, row.sectionId))
      // 已展开:进第一行 —— 它就是序列里紧跟着节头的那一个(flatten 的次序)。
      const first = rowIds[cur + 1]
      return first ? { ...state, focusId: first, focusVisible: true } : lit(state)
    }
    // collapse:展开着就收起来;已经收着了没有更上一层可退(节头就是第一级)。
    if (row.expanded) return lit(collapseSection(state, row.sectionId, facts))
    return lit(state)
  }

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
  /*
   * 顶层会话行上的 ← :**回到它的节头**(APG tree:← 在没有可收的项上 = 回父项)。
   * 从前这里是「什么都不做」,因为那时节头不是一格 —— 一条顶层行**没有**父。
   */
  const section = findSectionOf(model, row.id)
  if (section) return { ...state, focusId: section.head.id, focusVisible: true }
  return lit(state)
}

/**
 * ↵ 落在活动行上是什么意思 —— **两档,由行自己的形态说了算**:
 *  · 节头 → 收 / 展这一节(它是这一格唯一的「激活」语义);
 *  · 会话行 → 进这条会话。
 *
 * 它交出的是「状态 + 一件还没做的事」而不是直接进会话:`enterSession` 在 store
 * 那层还要顺手开聊天面、把焦点交给输入框、按落点形态收面板 —— 纯函数不认识那些。
 * 所以这里只答**这一下是哪一档**,由壳去执行第二半(与 `togglePin` 同一手)。
 */
export function activateRow(
  state: ExposeState,
  facts: ListFacts,
): { state: ExposeState; enterSessionId: string | null } {
  const row = findRow(listModelOf(state, facts), state.focusId)
  if (!row) return { state, enterSessionId: null }
  if (row.type === 'section') {
    return { state: toggleSection(state, row.sectionId, facts), enterSessionId: null }
  }
  return { state, enterSessionId: row.id }
}

/** `KeyboardEvent.key` → 这块面的意图。键名判据的单产地在 `keys.ts`。 */
export { exposeIntentOf }
export type { ExposeIntent }

/* ── Quick Look 内换会话 ───────────────────────────────────────────────── */

function quickLookStep(state: ExposeState, delta: number, facts: ListFacts): ExposeState {
  if (state.view.mode !== 'quicklook') return state
  // **只在会话之间翻**(09-04):节头也在焦点序列里,但它不是可以预览的东西。
  const rowIds = sessionRowIdsOf(state, facts)
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
  const rowIds = sessionRowIdsOf(state, facts)
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
 * 点开搜索行 —— 那一行**原地**换成一只输入框(09-12 方向 A §3.1)。
 *
 * 它不碰 `query`(缺省本来就是空串),也不碰焦点:焦点落到哪儿由作用域的
 * `restingTarget` 在提交之后去认(「开的人点名、被开的那一格挂载时自己取走」),
 * 纯函数不认识 DOM。已经开着时是**同一个引用** —— 不触发一次白重渲染。
 */
export function openSearch(state: ExposeState): ExposeState {
  return state.searching ? state : { ...state, searching: true }
}

/**
 * 收回成一行字 —— **连词一起清**(Esc 那一下的语义:正本 §5「有词就清词并
 * 收回成行」)。
 *
 * 「清词」与「收回」是一件事而不是两件:留下一个「收着但还在过滤」的状态,
 * 屏幕上就会有一张少了行的列表而没有任何东西说明为什么(而那正是 09-04
 * 卡片时代留下的那类「看不见的过滤器」)。清了词所以要夹持焦点:活动行可能
 * 是一条只有在搜索结果里才存在的子行。
 */
export function closeSearch(state: ExposeState, facts: ListFacts): ExposeState {
  if (!state.searching && !state.query) return state
  return clampFocus({ ...state, searching: false, query: '' }, facts)
}

/**
 * **这块面离开活动路径那一拍**(A6,正本 §9 拍板 4;09-13 用户第二条报障:
 * 「筛选行变成输入框之后,焦点走了不恢复」)。
 *
 * 两档,判据是**有没有词**:
 *  · 没词 → 与没点过一样(= `closeSearch`):一只空着的输入框留在那儿,既占着
 *    一行的宽,又让人以为自己还在搜;
 *  · **有词 → 只收形,词留着**。这一格是新的:从前 `searching === false` 蕴含
 *    `query === ''`,而「收着但还在过滤」正是 09-04 立法要防的「看不见的过滤器」——
 *    所以它只有在那一行**自己把词说出来**(「筛选 · 词」+ 一颗 ×)的前提下才合法。
 *    屏幕上的话是那一行说的,这只函数只负责让那个状态存在。
 *
 * 它**不碰焦点**:焦点此刻已经在别处了(这条迁移就是被「别处」触发的)。
 * 也**不夹持焦点**:一格行都没离场 —— 词没变,列表就没变。
 */
export function leaveExpose(state: ExposeState, facts: ListFacts): ExposeState {
  if (!state.searching) return state
  if (!state.query) return closeSearch(state, facts)
  return { ...state, searching: false }
}

/**
 * **原地改名:开**(A2)。那一行的标题当场换成一只输入框。
 *
 * 它不碰焦点(与 `openSearch` 逐字同一条:「开的人点名、被开的那一格挂载时
 * 自己取走」,纯函数不认识 DOM),也**不碰 `focusId`** —— 改名是对**某一条**
 * 会话动手,而键盘的活动行是另一件事:右键第三行、活动行在别处,是一个合法的
 * 屏幕状态,把活动行拽过去等于替用户挪了键盘。
 *
 * 同一行再开一次是**同一个引用**(不触发一次白重渲染);开着 A 又对 B 动手时
 * 直接换人 —— A 那只输入框随它卸载,草稿跟着没(草稿归那只输入框,见 types.ts)。
 * 那正是「改到一半点开第二行 = 前一行收回」该有的样子。
 */
export function startRename(state: ExposeState, sessionId: string): ExposeState {
  if (!sessionId || state.renamingId === sessionId) return state
  return { ...state, renamingId: sessionId }
}

/**
 * **原地改名:收**(A2)。↵ 落定之后、Esc 收回之后、失焦之后,三条路同一口
 * —— 「这一行不再是输入框了」只是一句话,它与「写成没成」无关(写路在数据源,
 * 而屏幕上那只输入框该在发出去那一刻就收回:留着它等一次往返是让人对着一只
 * 不知道还能不能打字的框)。
 *
 * 没在改名时是**同一个引用**。它**不夹持焦点**:改名不会让任何一行离场
 * (名字换了行可能换节 —— 那是重投影的事,`clampFocus` 在写路对账那一头)。
 */
export function stopRename(state: ExposeState): ExposeState {
  return state.renamingId === null ? state : { ...state, renamingId: null }
}

/**
 * 「进入」= 内容回到起点(退出 quicklook、清掉搜索词)。
 *
 * **它不再写 `currentSessionId`**(W5-b 裁定 3):那一格成了树的投影,而
 * 「换哪片叶看哪条会话」是拼贴台的事 —— 那一步在 store 壳里
 * (`content/session-open.enterSessionInWorkbench`),与「顺手把这块面收回 Dock」
 * 落在同一处、出于同一条理由:纯函数不认识落点,也不认识树。
 *
 * 入参 `sessionId` 保留在签名上是**故意的**:这条状态迁移属于「进入某条会话」
 * 这件事,将来这块面要按它做别的(比如把那一行滚进视野)时不必再改签名。
 */
export function enterSession(state: ExposeState, _sessionId: string): ExposeState {
  /*
   * 「回到起点」在 09-12 之后多了一格:搜索行也收回成一行字(它与清词是一件事);
   * A2 又多一格:原地改名也收回 —— 点进一条会话之后屏幕上不该还留着一只
   * 改名框(那一下的意思是「我要去用这条会话了」,不是「我还在整理名字」)。
   */
  return { ...state, view: { mode: 'overview' }, query: '', searching: false, renamingId: null }
}

/* ── 会话没了 ──────────────────────────────────────────────────────────── */

/**
 * 有会话被删掉了(H 批)。入参 `facts` 是**摘除之后**的那份名册 ——
 * 数据源先改列表再叫这个函数,所以这里算出来的序列已经不含被删的行。
 *
 * 它只做**夹持**,不做导航:被删的那条会话在屏幕上留下的每一个指针都得收回来,
 * 但一个还站得住的指针一格都不动。两条,各有各的理由:
 *
 *  1. Quick Look 正开着被删的那条 → 退回总览。不退的话状态机停在 quicklook 档
 *     而面板画不出任何东西,键盘语义与屏幕对不上。
 *  2. 焦点落在一行已经不在的行上 → 退到新序列首。与改搜索词逐字同一句话。
 *
 * **「当前会话被删 → 回空态」那一条 W5-b 删掉了**:它成了树的投影,而清洗
 * 那一格死 tab 是拼贴台的事(`workbench.sweepRefs`,发起点在
 * `content/session-projection.ts`)。留在这里就是第二个写者 —— 两处各清一遍,
 * 而屏幕上那片会话叶只听树的。
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

  if (next.focusId && gone.has(next.focusId)) {
    next = { ...next, focusId: anchorOf(listModelOf(next, facts)) }
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
