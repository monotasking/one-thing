import type {
  DockEdge,
  FloatRect,
  OpenBehavior,
  Placement,
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
export const STAGE_PERSIST_VERSION = 3

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
  flashPinned: 0,
  flashSide: null,
}

export const initialStageSettings: StageSettings = {
  defaultOpen: 'stage',
  locale: 'system',
  openOverrides: {},
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

/* ── 打开方式 → 落点 ───────────────────────────────────────────────────────── */

/**
 * 设置层的「打开方式」翻成形态机认识的 Placement。全仓唯一一处翻译:
 * 'pinned' 这个历史值的语义就是「钉到右边那条架子」,别处不许再判一次。
 */
export function placementForOpen(open: ResolvedOpen): Placement {
  if (open === 'stage') return { kind: 'stage' }
  if (open === 'float') return { kind: 'float' }
  return { kind: 'edge', side: 'right' }
}

/**
 * 解析「打开方式」:图标自己的覆盖优先,没表态(或没登记)才落到全局默认。
 * 直接给出 Placement —— 形态机本身不认识 'default',也不认识 'pinned'。
 */
export function resolveOpen(
  id: string,
  overrides: Record<string, OpenBehavior>,
  defaultOpen: ResolvedOpen,
): Placement {
  const own = overrides[id] ?? 'default'
  return placementForOpen(own === 'default' ? defaultOpen : own)
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
 */
export function openAs(
  state: StageState,
  id: string,
  placement: Placement,
  viewport: Viewport = FALLBACK_VIEWPORT,
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
    // 新入架子顺手展开:用户的动作意图是「让它看得见」。
    next = {
      ...next,
      shelves: {
        ...next.shelves,
        [placement.side]: { ...shelf, tabs: [...shelf.tabs, id], activeId: id, collapsed: false },
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

  return next
}

/** 收回 Dock。已经在 Dock 里的是恒等变换;浮窗矩形留着当记忆。 */
export function closeToDock(state: StageState, id: string): StageState {
  if (placementOf(state, id).kind === 'dock') return state
  return openAs(state, id, DOCK)
}

/**
 * 点 Dock 图标。先问「它现在在哪」,再决定这一下是什么意思:
 *  - 在舞台 → 关舞台(再点一次收回去)
 *  - 在架子上 → 不新开。判据是「它现在看得见吗」:
 *      看不见(不是活动 tab,或整栏收着)→ 激活 + 展开 + 闪一下,告诉用户"它在那儿";
 *      看得见(是活动 tab 且栏展开着)  → 再点一次是"收回去",与舞台那条同一个手感。
 *  - 已是浮窗 → 置顶它(浮窗可以有好几个,所以这一下是"把它翻到最上面")
 *  - 在 Dock 里 → 按解析出的落点开。
 */
export function clickDockIcon(
  state: StageState,
  id: string,
  placement: Placement,
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

  return openAs(state, id, placement, viewport)
}

/**
 * ⌘P 那种「开关一块面」的语义:在 Dock 里就按打开方式开,在别处(舞台/浮窗/架子)
 * 就收回 Dock。它与 clickDockIcon 的区别只有一条 —— 快捷键没有"收起整栏"这个中间态,
 * 按第二下就是关掉,所以它不判架子看不看得见。
 */
export function togglePlacement(
  state: StageState,
  id: string,
  placement: Placement,
  viewport: Viewport = FALLBACK_VIEWPORT,
): StageState {
  if (placementOf(state, id).kind === 'dock') return openAs(state, id, placement, viewport)
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

export function moveFloat(
  state: StageState,
  id: string,
  x: number,
  y: number,
  viewport: Viewport = FALLBACK_VIEWPORT,
): StageState {
  const rect = state.floats[id]
  if (!rect) return state
  return { ...state, floats: { ...state.floats, [id]: clampFloatRect({ ...rect, x, y }, viewport) } }
}

export function resizeFloat(
  state: StageState,
  id: string,
  rect: FloatRect,
  viewport: Viewport = FALLBACK_VIEWPORT,
): StageState {
  if (!state.floats[id]) return state
  return { ...state, floats: { ...state.floats, [id]: clampFloatRect(rect, viewport) } }
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
  return out
}
