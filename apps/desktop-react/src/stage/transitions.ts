import type {
  DockEdge,
  FloatRect,
  MemorablePlacement,
  Placement,
  PlacementMemory,
  Point,
  ResolvedOpen,
  ShelfSide,
  ShelfState,
  StageForm,
  StageSettings,
  StageState,
  Viewport,
} from './types'

/**
 * 架子厚度的两条界。下界是绝对值(--shelf-min 同一事实),上界是比例 ——
 * 「架子最多吃掉视口的多少」是相对的,写死一个 px 在小屏上会把主区挤没。
 */
export const SHELF_MIN_THICKNESS = 240
export const SHELF_MAX_RATIO = 0.55
export const SHELF_DEFAULT_THICKNESS = 400

/** 浮窗的四条硬约束:最小身量、必须留在视口内的那一截、新窗默认身量。 */
export const FLOAT_MIN_W = 280
export const FLOAT_MIN_H = 200
export const FLOAT_KEEP = 40
export const FLOAT_DEFAULT_W = 720
export const FLOAT_DEFAULT_H = 520

/**
 * 纯函数不许读 window,所以视口由调用方递进来;测试里给定值,store 里给真视口。
 * 这个兜底只在「谁都没给」时用,存在的意义是让签名可选而不是让它有第二套真相。
 */
export const FALLBACK_VIEWPORT: Viewport = { w: 1280, h: 800 }

export const SHELF_SIDES: ShelfSide[] = ['left', 'right', 'top', 'bottom']

/**
 * 拖着一扇浮窗靠近视口边缘多少像素算「要钉上去」。
 * 撕离用的是同一个数(24):进这么多算吸,出这么多算撕,一进一出对称。
 */
export const SNAP_BAND = 24
export const TEAR_OFF_DISTANCE = 24

/** Dock 自动隐藏的感应带厚度。它是**指针到那条边的距离**,不再是一个盖在别人身上的元素。 */
export const DOCK_EDGE_BAND = 8

/** 浮窗标题栏高度,与 --float-header-h 同一事实(从架子上撕下来时要按它对准指针)。 */
export const FLOAT_HEADER_H = 40

/** persist 档案版本。改这个数就必须在 migrateStagePersisted 里加一段,两者同生共死。 */
export const STAGE_PERSIST_VERSION = 5

const DOCK: Placement = { kind: 'dock' }

function emptyShelf(): ShelfState {
  return { tabs: [], activeId: null, thickness: SHELF_DEFAULT_THICKNESS, collapsed: false }
}

export function emptyShelves(): Record<ShelfSide, ShelfState> {
  return { left: emptyShelf(), right: emptyShelf(), top: emptyShelf(), bottom: emptyShelf() }
}

export const initialStageState: StageState = {
  placements: {},
  floats: {},
  floatOrder: [],
  shelves: emptyShelves(),
  memory: {},
  flashPinned: 0,
  flashSide: null,
}

export const initialStageSettings: StageSettings = {
  defaultOpen: 'float',
  locale: 'system',
  dockEdge: 'bottom',
  dockAlign: 'center',
  dockSize: 'md',
}

/* ── 派生 ──────────────────────────────────────────────────────────────────── */

/**
 * 形态是「派生」的,不是存的:一个 id 的落点完全由 placements 决定。
 * 组件只能读这个函数,不许自己拼条件。
 * 注意:架子上的非活动 tab 也是 edge —— 形态说的是「它在哪」,不是「它可见吗」。
 */
export function placementOf(state: StageState, id: string): Placement {
  return state.placements[id] ?? DOCK
}

export function formOf(state: StageState, id: string): StageForm {
  return formIn(state.placements, id)
}

/**
 * 只拿到 placements 表时的形态查询。规则与 formOf 逐字相同(缺席 = dock)——
 * 存在的理由是投影层(Dock)只订阅了那张表,不该为了问一句形态去订阅整个 state。
 */
export function formIn(placements: Record<string, Placement>, id: string): StageForm {
  return (placements[id] ?? DOCK).kind
}

/** 舞台至多一个,所以「谁在舞台上」是个查询而不是一个字段。 */
export function stageIdOf(state: StageState): string | null {
  for (const [id, p] of Object.entries(state.placements)) {
    if (p.kind === 'stage') return id
  }
  return null
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/* ── 位置记忆 ──────────────────────────────────────────────────────────────── */

/**
 * 把 id **此刻的落点**折成一条记忆。收在 Dock 里 = 没有落点可折,所以是 null。
 * 「折」是这一批的核心动词:活表(placements / floats / shelves)散在三处,
 * 记忆把它们压成一条能独立复原的记录 —— 关闭之后活表就问不出来了。
 */
export function memoryOf(
  state: StageState,
  id: string,
  viewport: Viewport = FALLBACK_VIEWPORT,
): PlacementMemory | null {
  const p = placementOf(state, id)
  if (p.kind === 'dock') return null
  if (p.kind === 'stage') return { kind: 'stage' }
  if (p.kind === 'float') {
    return { kind: 'float', rect: state.floats[id] ?? defaultFloatRect(viewport) }
  }
  const at = state.shelves[p.side].tabs.indexOf(id)
  return { kind: 'edge', side: p.side, index: at < 0 ? state.shelves[p.side].tabs.length : at }
}

/** 写一条记忆。null = 无可记(在 Dock 里),此时是恒等变换 —— 归档不擦旧记忆。 */
function remember(state: StageState, id: string, m: PlacementMemory | null): StageState {
  if (!m) return state
  return { ...state, memory: { ...state.memory, [id]: m } }
}

/**
 * 记忆与菜单里那一行说的是不是同一个落点。
 * 浮窗矩形与边内次序**不参与**比对:菜单问的是「放在哪」,不是「放在哪儿的第几个」。
 */
export function memoryIsAt(m: PlacementMemory | undefined, placement: MemorablePlacement): boolean {
  if (!m || m.kind !== placement.kind) return false
  if (m.kind === 'edge' && placement.kind === 'edge') return m.side === placement.side
  return true
}

/**
 * 按一条记忆把 id 放回去。三种形态各自需要补的那一件事都在这里:
 *  - edge:插回 min(记忆次序, 组长) —— 两块瓦记着同一条边,各自钳一下就都坐得下,不需要仲裁;
 *  - float:矩形先过**与拖拽落定同一把**视口钳制 —— 显示器变小了不能把窗开到屏外;
 *  - stage:什么都不用补(舞台没有第二个参数)。
 */
export function openFromMemory(
  state: StageState,
  id: string,
  m: PlacementMemory,
  viewport: Viewport = FALLBACK_VIEWPORT,
): StageState {
  if (m.kind === 'stage') return openAs(state, id, { kind: 'stage' }, viewport)
  if (m.kind === 'edge') return openAs(state, id, { kind: 'edge', side: m.side }, viewport, m.index)
  const seeded = { ...state, floats: { ...state.floats, [id]: clampFloatRect(m.rect, viewport) } }
  return openAs(seeded, id, { kind: 'float' }, viewport)
}

/* ── 打开方式 → 落点 ───────────────────────────────────────────────────────── */

/**
 * 全局默认档翻成形态机认识的 Placement。全仓唯一一处翻译:
 * 'pinned' 这个历史值的语义就是「钉到右边那条架子」,别处不许再判一次。
 */
export function placementForOpen(open: ResolvedOpen): Exclude<MemorablePlacement, { kind: 'stage' }> {
  if (open === 'float') return { kind: 'float' }
  return { kind: 'edge', side: 'right' }
}

/**
 * 全局默认档补成一条完整记忆 —— 缺的那两件事按「就当它没来过」补:
 * 浮窗取新窗默认矩形,钉边排到那条边的末尾。
 */
export function defaultOpenMemory(
  state: StageState,
  open: ResolvedOpen,
  viewport: Viewport = FALLBACK_VIEWPORT,
): PlacementMemory {
  const placement = placementForOpen(open)
  if (placement.kind === 'float') return { kind: 'float', rect: defaultFloatRect(viewport) }
  return {
    kind: 'edge',
    side: placement.side,
    index: state.shelves[placement.side].tabs.length,
  }
}

/**
 * 打开的解析序是三层:**显式手势 > 记忆 > 全局默认档**。
 * 头一层不经过这个函数 —— 手势自己就说得出落点(它直接调 openAs),根本不必问;
 * 这里回答的是剩下那句「没人点名时,它该回哪儿」,所以只剩后两层。
 */
export function resolveOpen(
  state: StageState,
  id: string,
  defaultOpen: ResolvedOpen,
  viewport: Viewport = FALLBACK_VIEWPORT,
): PlacementMemory {
  const remembered = state.memory[id]
  // 舞台已退出打开档(见 types.ts 的 ResolvedOpen 注释):存量记忆里的 stage 条目
  // 在这里钳掉,落回默认档 —— 写入侧(closeToDock 记形态)不清洗,单点治理。
  if (remembered && remembered.kind !== 'stage') return remembered
  return defaultOpenMemory(state, defaultOpen, viewport)
}

/* ── 浮窗几何(纯算术,与 state 无关,所以能单独测) ────────────────────────── */

/**
 * 钳制一个浮窗矩形:身量不小于最小档,且至少 FLOAT_KEEP 那么一截留在视口里。
 * 纵向下界是 0 而不是「露出 40px」—— 标题栏被推出屏顶就再也拖不回来了。
 */
export function clampFloatRect(rect: FloatRect, viewport: Viewport): FloatRect {
  const w = Math.max(FLOAT_MIN_W, Math.round(rect.w))
  const h = Math.max(FLOAT_MIN_H, Math.round(rect.h))
  return {
    w,
    h,
    x: clamp(Math.round(rect.x), FLOAT_KEEP - w, viewport.w - FLOAT_KEEP),
    y: clamp(Math.round(rect.y), 0, viewport.h - FLOAT_KEEP),
  }
}

/** 新浮窗:居中、默认身量(视口比默认还小就取视口)。 */
export function defaultFloatRect(viewport: Viewport): FloatRect {
  const w = Math.min(FLOAT_DEFAULT_W, viewport.w)
  const h = Math.min(FLOAT_DEFAULT_H, viewport.h)
  return clampFloatRect({ w, h, x: (viewport.w - w) / 2, y: (viewport.h - h) / 2 }, viewport)
}

export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/**
 * 从一个把手拖出 (dx, dy) 之后的矩形。拖北/西两边时最小档卡住的是**身量**,
 * 坐标要跟着回推,否则窗子会一边缩到最小一边继续往外跑。
 */
export function resizeFrom(rect: FloatRect, dir: ResizeDir, dx: number, dy: number): FloatRect {
  let { x, y, w, h } = rect
  if (dir.includes('e')) w = Math.max(FLOAT_MIN_W, rect.w + dx)
  if (dir.includes('s')) h = Math.max(FLOAT_MIN_H, rect.h + dy)
  if (dir.includes('w')) {
    w = Math.max(FLOAT_MIN_W, rect.w - dx)
    x = rect.x + rect.w - w
  }
  if (dir.includes('n')) {
    h = Math.max(FLOAT_MIN_H, rect.h - dy)
    y = rect.y + rect.h - h
  }
  return { x, y, w, h }
}

/* ── 落点变更(唯一的写入口,不变式都在这里维护) ──────────────────────────── */

/** 把 id 从它当下待的地方摘出来:架子 tab 与浮窗序。摘架子的活动 tab 时焦点先右后左。 */
function detach(state: StageState, id: string): StageState {
  let shelves = state.shelves
  let touched = false
  for (const side of SHELF_SIDES) {
    const shelf = shelves[side]
    const at = shelf.tabs.indexOf(id)
    if (at < 0) continue
    const tabs = shelf.tabs.filter((x) => x !== id)
    const activeId = shelf.activeId === id ? (tabs[at] ?? tabs[at - 1] ?? null) : shelf.activeId
    shelves = { ...shelves, [side]: { ...shelf, tabs, activeId } }
    touched = true
  }
  const inFloat = state.floatOrder.includes(id)
  if (!touched && !inFloat) return state
  return {
    ...state,
    shelves,
    floatOrder: inFloat ? state.floatOrder.filter((x) => x !== id) : state.floatOrder,
  }
}

/**
 * 把 id 放到某个落点。**全系统唯一改 placements 的函数** —— 三条不变式都在这里:
 *  1. 一个 id 只在一处:先从旧落点摘干净(架子 tab / 浮窗序),再登记新的;
 *  2. 舞台至多一个:新的上台,旧的落回 dock;
 *  3. dock 是缺席态:落回 dock 就是把它从表里删掉,不留一条 {kind:'dock'}。
 * 浮窗矩形不在这里擦 —— 那是记忆,收回 Dock 再开还要用。
 *
 * G 批起它还多做一件事:**落定即写记忆**。这是全系统唯一改 placements 的函数,
 * 所以把记忆挂在这里,「菜单点名 / 拖拽吸附 / tab 撕出 / 舞台转边」四条路一次全接上,
 * 不必每个组件在松手时另外记得写一次(散在组件里的记忆,迟早有一条忘了写)。
 *
 * edgeIndex 只在 placement 是 edge 时有意义:缺省 = 排到末尾(新来的排最后),
 * 给了 = 按记忆插回去,并钳进 [0, 组长] —— 它记着第 5 个,那条边现在只有 2 个,就坐第 3 个位子。
 */
export function openAs(
  state: StageState,
  id: string,
  placement: Placement,
  viewport: Viewport = FALLBACK_VIEWPORT,
  edgeIndex?: number,
): StageState {
  let next = detach(state, id)

  const placements = { ...next.placements }
  if (placement.kind === 'stage') {
    for (const [other, p] of Object.entries(placements)) {
      if (p.kind === 'stage' && other !== id) delete placements[other]
    }
  }
  if (placement.kind === 'dock') delete placements[id]
  else placements[id] = placement
  next = { ...next, placements }

  if (placement.kind === 'edge') {
    const shelf = next.shelves[placement.side]
    const at =
      edgeIndex === undefined ? shelf.tabs.length : clamp(Math.round(edgeIndex), 0, shelf.tabs.length)
    const tabs = [...shelf.tabs]
    tabs.splice(at, 0, id)
    // 新入架子顺手展开:用户的动作意图是「让它看得见」。
    next = {
      ...next,
      shelves: {
        ...next.shelves,
        [placement.side]: { ...shelf, tabs, activeId: id, collapsed: false },
      },
    }
  }

  if (placement.kind === 'float') {
    const rect = clampFloatRect(next.floats[id] ?? defaultFloatRect(viewport), viewport)
    next = {
      ...next,
      floats: { ...next.floats, [id]: rect },
      floatOrder: [...next.floatOrder, id],
    }
  }

  // 落定即写:折的是 next(已经落好的那一份),所以 edge 记下的是真实插入位、
  // float 记下的是钳制过的矩形 —— 记忆里没有一个「本来想放但没放成」的数。
  return remember(next, id, memoryOf(next, id, viewport))
}

/**
 * 收回 Dock。**关闭是归档,不是删除**:先把当下的落点折成记忆,再摘活表 ——
 * 顺序反了就什么都记不到(摘完之后 placements / shelves 里已经没有它了)。
 * 已经在 Dock 里的是恒等变换(它的记忆是上次归档时留下的,这一下不该动它)。
 */
export function closeToDock(state: StageState, id: string): StageState {
  if (placementOf(state, id).kind === 'dock') return state
  return remember(openAs(state, id, DOCK), id, memoryOf(state, id))
}

/**
 * 点 Dock 图标。先问「它现在在哪」,再决定这一下是什么意思:
 *  - 在舞台 → 关舞台(再点一次收回去)
 *  - 在架子上 → 不新开。判据是「它现在看得见吗」:
 *      看不见(不是活动 tab,或整栏收着)→ 激活 + 展开 + 闪一下,告诉用户"它在那儿";
 *      看得见(是活动 tab 且栏展开着)  → 再点一次是"收回去",与舞台那条同一个手感。
 *  - 已是浮窗 → 置顶它(浮窗可以有好几个,所以这一下是"把它翻到最上面")
 *  - 在 Dock 里 → 按解析出的记忆开(见 resolveOpen 的三层序)。
 */
export function clickDockIcon(
  state: StageState,
  id: string,
  open: PlacementMemory,
  viewport: Viewport = FALLBACK_VIEWPORT,
): StageState {
  const current = placementOf(state, id)

  if (current.kind === 'stage') return closeToDock(state, id)

  if (current.kind === 'edge') {
    const shelf = state.shelves[current.side]
    const visible = shelf.activeId === id && !shelf.collapsed
    if (visible) return setShelfCollapsed(state, current.side, true)
    return {
      ...state,
      shelves: { ...state.shelves, [current.side]: { ...shelf, activeId: id, collapsed: false } },
      flashPinned: state.flashPinned + 1,
      flashSide: current.side,
    }
  }

  if (current.kind === 'float') return focusFloat(state, id)

  return openFromMemory(state, id, open, viewport)
}

/**
 * ⌘P 那种「开关一块面」的语义:在 Dock 里就按打开方式开,在别处(舞台/浮窗/架子)
 * 就收回 Dock。它与 clickDockIcon 的区别只有一条 —— 快捷键没有"收起整栏"这个中间态,
 * 按第二下就是关掉,所以它不判架子看不看得见。
 */
export function togglePlacement(
  state: StageState,
  id: string,
  open: PlacementMemory,
  viewport: Viewport = FALLBACK_VIEWPORT,
): StageState {
  if (placementOf(state, id).kind === 'dock') return openFromMemory(state, id, open, viewport)
  return closeToDock(state, id)
}

/* ── 舞台 ──────────────────────────────────────────────────────────────────── */

export function closeStage(state: StageState): StageState {
  const id = stageIdOf(state)
  if (id === null) return state
  return openAs(state, id, DOCK)
}

/** 舞台 → 浮窗。没有舞台时是恒等变换。 */
export function stageToFloat(state: StageState, viewport: Viewport = FALLBACK_VIEWPORT): StageState {
  const id = stageIdOf(state)
  if (id === null) return state
  return openAs(state, id, { kind: 'float' }, viewport)
}

/** 舞台 → 某条边的架子。没有舞台时是恒等变换。 */
export function stageToEdge(state: StageState, side: ShelfSide): StageState {
  const id = stageIdOf(state)
  if (id === null) return state
  return openAs(state, id, { kind: 'edge', side })
}

/* ── 浮窗 ──────────────────────────────────────────────────────────────────── */

/** 置顶:挪到 floatOrder 末位。不是浮窗、或已经在末位,都是恒等变换。 */
export function focusFloat(state: StageState, id: string): StageState {
  const order = state.floatOrder
  const at = order.indexOf(id)
  if (at < 0 || at === order.length - 1) return state
  return { ...state, floatOrder: [...order.filter((x) => x !== id), id] }
}

/**
 * 落定一个浮窗矩形。活位置写 floats,**同一下**写进记忆 ——
 * 「拖到哪就记到哪」不该是组件在松手时另外记得做的第二件事。
 *
 * 只有此刻真是浮窗才写记忆:floats 是一张不擦的表(收回 Dock 也留着),
 * 拿一条陈年矩形去盖掉它现在的钉边记忆,就等于用过去否掉现在。
 */
function withFloatRect(state: StageState, id: string, rect: FloatRect): StageState {
  const next = { ...state, floats: { ...state.floats, [id]: rect } }
  if (placementOf(state, id).kind !== 'float') return next
  return remember(next, id, { kind: 'float', rect })
}

export function moveFloat(
  state: StageState,
  id: string,
  x: number,
  y: number,
  viewport: Viewport = FALLBACK_VIEWPORT,
): StageState {
  const rect = state.floats[id]
  if (!rect) return state
  return withFloatRect(state, id, clampFloatRect({ ...rect, x, y }, viewport))
}

export function resizeFloat(
  state: StageState,
  id: string,
  rect: FloatRect,
  viewport: Viewport = FALLBACK_VIEWPORT,
): StageState {
  if (!state.floats[id]) return state
  return withFloatRect(state, id, clampFloatRect(rect, viewport))
}

/** 浮窗 → 架子。不是浮窗时是恒等变换。 */
export function floatToEdge(state: StageState, id: string, side: ShelfSide): StageState {
  if (placementOf(state, id).kind !== 'float') return state
  return openAs(state, id, { kind: 'edge', side })
}

/** 架子 → 浮窗。不在架子上时是恒等变换;有旧矩形就回到旧位置。 */
export function edgeToFloat(
  state: StageState,
  id: string,
  viewport: Viewport = FALLBACK_VIEWPORT,
): StageState {
  if (placementOf(state, id).kind !== 'edge') return state
  return openAs(state, id, { kind: 'float' }, viewport)
}

/* ── 架子 ──────────────────────────────────────────────────────────────────── */

/**
 * 整栏关闭:这条边上的 tab 全部收回 Dock(逐个走 closeToDock,复用它的全部清理)。
 *
 * 次序要在**动手之前**整条拓下来:逐个收会让后面的 tab 次序一路往前塌,
 * 那样记下的就是塌过的次序 —— 整栏关掉再一个个开回来,三块瓦会挤成一摞。
 * 所以先按原状折一遍记忆,收完再把这一份盖回去(只覆盖这条边上的 id,别人一条不碰)。
 */
export function closeShelf(state: StageState, side: ShelfSide): StageState {
  const tabs = state.shelves[side].tabs
  if (tabs.length === 0) return state
  const memory = { ...state.memory }
  for (const id of tabs) {
    const m = memoryOf(state, id)
    if (m) memory[id] = m
  }
  return { ...tabs.reduce((st, id) => closeToDock(st, id), state), memory }
}

/** 激活一条边上的某个 tab。不在这条边上、或已经是活动的,都是恒等变换。 */
export function activateShelfTab(state: StageState, side: ShelfSide, id: string): StageState {
  const shelf = state.shelves[side]
  if (!shelf.tabs.includes(id)) return state
  if (shelf.activeId === id) return state
  return { ...state, shelves: { ...state.shelves, [side]: { ...shelf, activeId: id } } }
}

function setShelfCollapsed(state: StageState, side: ShelfSide, collapsed: boolean): StageState {
  const shelf = state.shelves[side]
  if (shelf.collapsed === collapsed) return state
  return { ...state, shelves: { ...state.shelves, [side]: { ...shelf, collapsed } } }
}

/** 收/展整条架子。tab 次序与活动 tab 一个都不动 —— 收起的是栏,不是内容。 */
export function toggleShelfCollapsed(state: StageState, side: ShelfSide): StageState {
  return setShelfCollapsed(state, side, !state.shelves[side].collapsed)
}

/**
 * 「厚度」换个轴读的唯一一处:竖边(左/右)量宽,横边(上/下)量高。
 * 钳制、拖拽反推、CSS 写哪个维度,三处都问这一个函数,不各判各的。
 */
export function shelfViewportExtent(side: ShelfSide, viewport: Viewport): number {
  return side === 'left' || side === 'right' ? viewport.w : viewport.h
}

/**
 * 架子厚度钳到 [240, 视口对应维度的 55%];视口太窄时下界赢(clamp 自己保证)。
 * 上界取整:厚度最终是一个 px,55% 算出来的浮点尾巴不该被存进档案。
 */
export function clampShelfThickness(thickness: number, viewportExtent: number): number {
  return clamp(
    Math.round(thickness),
    SHELF_MIN_THICKNESS,
    Math.round(viewportExtent * SHELF_MAX_RATIO),
  )
}

/**
 * 拖把手时从指针位置反推厚度。量的是「外缘 → 指针」那一段:
 * 外缘(架子贴着视口的那一侧)在整个拖拽期间不动,所以宿主只需在按下时测一次。
 */
export function thicknessFromPointer(side: ShelfSide, pointer: Point, outerEdge: number): number {
  if (side === 'left') return pointer.x - outerEdge
  if (side === 'right') return outerEdge - pointer.x
  if (side === 'top') return pointer.y - outerEdge
  return outerEdge - pointer.y
}

export function setShelfThickness(
  state: StageState,
  side: ShelfSide,
  thickness: number,
  viewportExtent: number,
): StageState {
  const shelf = state.shelves[side]
  return {
    ...state,
    shelves: {
      ...state.shelves,
      [side]: { ...shelf, thickness: clampShelfThickness(thickness, viewportExtent) },
    },
  }
}

/* ── 拖拽吸附(纯判定:输入是坐标,输出是「该落哪条边」) ────────────────────── */

/** 边 → 指针到这条边的距离。四条边只在这一张表里被写成坐标,别处不许再拼。 */
const EDGE_DISTANCE: Record<ShelfSide, (p: Point, v: Viewport) => number> = {
  left: (p) => p.x,
  right: (p, v) => v.w - p.x,
  top: (p) => p.y,
  bottom: (p, v) => v.h - p.y,
}

/**
 * 指针落在哪条边的热带里 —— 落不进任何一条就是 null(不吸,松手照常落位)。
 * 角落归最近的那条边;**平手优先左右**,理由是竖架子是主力形态(右栏是出厂默认),
 * 判据写死在这张表的次序里(left/right 排在前,严格小于才换人)。
 */
export function snapSideAt(pointer: Point, viewport: Viewport, band: number = SNAP_BAND): ShelfSide | null {
  let best: ShelfSide | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const side of SHELF_SIDES) {
    const d = EDGE_DISTANCE[side](pointer, viewport)
    if (d > band) continue
    if (d < bestDistance) {
      best = side
      bestDistance = d
    }
  }
  return best
}

/**
 * 从架子上往主区方向拖了多远。为负 = 还压在架子那一侧。
 * innerEdge 是架子朝主区那一侧的坐标(宿主量 DOM 得到)。
 */
export function tearOffDistance(side: ShelfSide, pointer: Point, innerEdge: number): number {
  if (side === 'right') return innerEdge - pointer.x
  if (side === 'left') return pointer.x - innerEdge
  if (side === 'bottom') return innerEdge - pointer.y
  return pointer.y - innerEdge
}

/** 拖过阈值才算「撕下来」——够不着阈值的一次按下松开仍然是一次普通点击。 */
export function shouldTearOff(
  side: ShelfSide,
  pointer: Point,
  innerEdge: number,
  threshold: number = TEAR_OFF_DISTANCE,
): boolean {
  return tearOffDistance(side, pointer, innerEdge) > threshold
}

/**
 * 刚被撕下来的那扇窗落在哪:指针是**标题栏的中心**(横向居中、纵向落在标题栏一半高处),
 * 所以手指底下那一点仍然是「用户抓着的地方」。身量由调用方给(有记忆就用记忆)。
 */
export function floatRectForGrab(
  pointer: Point,
  size: { w: number; h: number },
  viewport: Viewport,
  headerHeight: number = FLOAT_HEADER_H,
): FloatRect {
  return clampFloatRect(
    { w: size.w, h: size.h, x: pointer.x - size.w / 2, y: pointer.y - headerHeight / 2 },
    viewport,
  )
}

/* ── Dock 自动隐藏的边缘带(去元素化:热区是一次距离判定,不是一个盖住别人的 div) ── */

const DOCK_EDGE_DISTANCE: Record<DockEdge, (p: Point, v: Viewport) => number> = {
  left: (p) => p.x,
  right: (p, v) => v.w - p.x,
  top: (p) => p.y,
  bottom: (p, v) => v.h - p.y,
}

export function withinDockEdgeBand(
  pointer: Point,
  viewport: Viewport,
  edge: DockEdge,
  band: number = DOCK_EDGE_BAND,
): boolean {
  return DOCK_EDGE_DISTANCE[edge](pointer, viewport) <= band
}

/**
 * 自动隐藏的**留驻区**:Dock 已滑出后,指针在这个区域内就不收回。
 * 区域 = Dock 矩形向所属边**补到视口边**(边带与本体之间原有 4px 死缝,
 * 真鼠标连续移动必经,08-29 用户报"一闪而逝"的根因),再四周放 pad 余量。
 */
export interface Rect { left: number; right: number; top: number; bottom: number }

export function withinDockHoldZone(
  pointer: Point,
  viewport: Viewport,
  edge: DockEdge,
  rect: Rect,
  pad = 8,
): boolean {
  let { left, right, top, bottom } = rect
  if (edge === 'right') right = viewport.w
  if (edge === 'left') left = 0
  if (edge === 'top') top = 0
  if (edge === 'bottom') bottom = viewport.h
  return (
    pointer.x >= left - pad && pointer.x <= right + pad && pointer.y >= top - pad && pointer.y <= bottom + pad
  )
}

/* ── persist ───────────────────────────────────────────────────────────────── */

/**
 * 存盘前把舞台那条摘掉:架子和浮窗是用户摆好的工作台,理应留着;
 * 舞台是「当下正在看的那一眼」,重开该从收拢态开始(与 W1 之前同一条判例)。
 */
export function withoutStagePlacements(
  placements: Record<string, Placement>,
): Record<string, Placement> {
  const out: Record<string, Placement> = {}
  for (const [id, p] of Object.entries(placements)) {
    if (p.kind !== 'stage') out[id] = p
  }
  return out
}

/**
 * persist 迁移。逐版顺着往上补,不跳级 —— v0 的档案要连过三段。
 *  v0 → v1:存的是单值 `pinnedId`,v1 起是 tab 数组。
 *  v1 → v2:多了 Dock 四边/沿边位置/大小与钉栏收起态,旧档案缺哪条补哪条。
 *  v2 → v3:三态枚举升 Placement —— 旧的 pinned/activePinnedId/pinnedWidth/pinnedCollapsed
 *           整组翻成 shelves.right + placements(每条 tab 一条 edge:right)。
 *  v3 → v4:每瓦的「打开方式」配置(openOverrides)退役,并入位置记忆 ——
 *           用户配过的一条都不丢,只是换了一种存在方式:配置变成初始记忆。
 * 放在这里(而不是 store 里)是为了它能被当成纯函数测 —— 迁移只有一次机会跑对。
 */
export function migrateStagePersisted(persisted: unknown, version: number): unknown {
  if (version >= STAGE_PERSIST_VERSION) return persisted
  if (!persisted || typeof persisted !== 'object') return persisted
  let out = persisted as Record<string, unknown>
  if (version < 1) {
    const { pinnedId, ...rest } = out
    out = typeof pinnedId === 'string' ? { ...rest, pinned: [pinnedId], activePinnedId: pinnedId } : rest
  }
  if (version < 2) {
    // 缺省补默认:已有的值赢,所以这里是「铺底」而不是「覆盖」。
    out = {
      dockEdge: initialStageSettings.dockEdge,
      dockAlign: initialStageSettings.dockAlign,
      dockSize: initialStageSettings.dockSize,
      pinnedCollapsed: false,
      ...out,
    }
  }
  if (version < 3) {
    const { pinned, activePinnedId, pinnedWidth, pinnedCollapsed, ...rest } = out
    const tabs = Array.isArray(pinned) ? pinned.filter((x): x is string => typeof x === 'string') : []
    const placements: Record<string, Placement> = {}
    for (const id of tabs) placements[id] = { kind: 'edge', side: 'right' }
    const shelves = emptyShelves()
    shelves.right = {
      tabs,
      activeId: typeof activePinnedId === 'string' && tabs.includes(activePinnedId) ? activePinnedId : (tabs[tabs.length - 1] ?? null),
      thickness: typeof pinnedWidth === 'number' ? pinnedWidth : SHELF_DEFAULT_THICKNESS,
      collapsed: pinnedCollapsed === true,
    }
    out = { ...rest, placements, floats: {}, floatOrder: [], shelves }
  }
  if (version < 4) {
    const { openOverrides, ...rest } = out
    // 活 placements / floats / shelves 照旧恢复,这一段只把**配置**翻成记忆。
    const floats = (rest.floats ?? {}) as Record<string, FloatRect>
    const shelves = (rest.shelves ?? emptyShelves()) as Record<ShelfSide, ShelfState>
    const memory: Record<string, PlacementMemory> = {}
    if (openOverrides && typeof openOverrides === 'object') {
      for (const [id, value] of Object.entries(openOverrides as Record<string, unknown>)) {
        if (value === 'stage') memory[id] = { kind: 'stage' }
        else if (value === 'float') {
          // 有存过的矩形就用存过的;没有就给新窗的默认身量(恢复时还会再过一次视口钳制)。
          memory[id] = { kind: 'float', rect: floats[id] ?? defaultFloatRect(FALLBACK_VIEWPORT) }
        } else if (value === 'pinned') {
          const tabs = shelves.right?.tabs ?? []
          const at = tabs.indexOf(id)
          memory[id] = { kind: 'edge', side: 'right', index: at < 0 ? tabs.length : at }
        }
        // 'default'(以及任何不认识的值)= 这块瓦从没表过态,不写记忆:
        // 它继续跟全局默认档走,与升级前逐字同一个结果。
      }
    }
    out = { ...rest, memory }
  }
  if (version < 5) {
    // 舞台退出打开档(08-30):存量 defaultOpen 的 'stage' 迁到 'float';
    // 记忆里的 stage 条目直接删 —— 缺记忆 = 跟默认档走,resolveOpen 会补浮窗默认身量
    // (迁移期拿不到视口,不在这里编一个矩形)。活 placements 不动:开着的舞台照常恢复,
    // 它仍是合法形态,只是点开的路不再通向它。
    if (out.defaultOpen === 'stage') out = { ...out, defaultOpen: 'float' }
    const memory = out.memory
    if (memory && typeof memory === 'object') {
      const next: Record<string, unknown> = {}
      for (const [id, value] of Object.entries(memory as Record<string, unknown>)) {
        if (!(value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'stage')) next[id] = value
      }
      out = { ...out, memory: next }
    }
  }
  return out
}
