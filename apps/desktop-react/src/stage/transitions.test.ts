import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  FLOAT_DEFAULT_H,
  FLOAT_DEFAULT_W,
  FLOAT_KEEP,
  FLOAT_MARGIN,
  FLOAT_MIN_H,
  FLOAT_MIN_W,
  FALLBACK_VIEWPORT,
  SHELF_DEFAULT_THICKNESS,
  SHELF_MIN_THICKNESS,
  STAGE_PERSIST_VERSION,
  clamp,
  clampFloatRect,
  centerRectOf,
  clampShelfThickness,
  canNailShelf,
  CENTER_MIN_H,
  CENTER_MIN_W,
  OPPOSITE_SHELF,
  reclampShelves,
  SHELF_RAIL,
  TOP_CHROME,
  shelfExtentOf,
  shelfThicknessBudget,
  defaultFloatRect,
  freshFloatRect,
  FLOAT_CASCADE_STEP,
  FLOAT_SPAWN_INSET,
  defaultOpenMemory,
  factoryStageFurniture,
  fitFloatRect,
  floatRectForGrab,
  focusFloat,
  formIn,
  formOf,
  initialStageSettings,
  initialStageState,
  memoryIsAt,
  memoryOf,
  migrateStagePersisted,
  moveFloat,
  clampDefaultOpen,
  placementForOpen,
  reclampAll,
  pickStageFurniture,
  placementOf,
  resizeFloat,
  resizeFrom,
  resolveOpen,
  setShelfThickness,
  shelfViewportExtent,
  shouldTearOff,
  snapSideAt,
  stageIdOf,
  tearOffDistance,
  thicknessFromPointer,
  toggleShelfCollapsed,
  withinDockWakeBand,
  withinDockHoldZone,
  coverMemoryToFull,
  escapeTargetOf,
  isItemHidden,
  setItemHidden,
  settledDockRect,
  shouldShowDock,
  DOCK_HOLD_PAD,
  DOCK_WAKE_BAND,
  DOCK_WAKE_DWELL_MS,
} from './transitions'
import { emptyShelves } from './transitions'
import { DEFAULT_SPACE_ID } from '../workspace/types'
import { SESSIONS_ITEM_ID, STAGE_ITEMS, findItem } from './items'
import { stagePlacementDeps, syncStageResidency, useStageStore } from './store'
import * as P from './placement'
import { regionsFromLegacyFurniture } from './legacy-furniture'
import { seedStage } from '../test/stage-fixture'
import type { PaneNode } from '../workbench/tree'
import type {
  Placement,
  PlacementMemory,
  PlacementTarget,
  ShelfSide,
  StageState,
  Viewport,
} from './types'
import type { Rect } from './transitions'

const base: StageState = initialStageState

/*
 * ── 住处那一族**不再是纯函数**了(W4),这里给它们搭一层同形的壳 ────────────
 *
 * `openAs` / `closeToDock` / `openFromMemory` / … 从前是 `(state, …) => state`。
 * W4 把住处搬进了拼贴树(判词在 `stage/residency.ts`),它们于是要同时改两台
 * store,不再写得成一个纯函数 —— 整族搬进了 `stage/placement.ts`。
 *
 * 但**它们要守的判据一个字都没变**,而这只文件里那 70 多条断言问的全都是
 * 「事后这份 `StageState` 长什么样」—— 而那份读数今天仍然存在(它是树的投影)。
 * 所以这里不重写用例,只补一层壳:
 *   ① `load(st)` 把一份 `StageState` **摆进两台 store**(架子 tab 与浮窗翻成树,
 *      复用迁移那只纯函数 `regionsFromLegacyFurniture` —— 两处同一个折法);
 *   ② 跑那一句编排;
 *   ③ 交回投影后的 `StageState`,**没变就交回入参那个对象** ——
 *      「空动作 = 恒等变换」那一族断言(`.toBe(base)`)问的正是引用恒等。
 *
 * 视口由壳按参数写进 `window`(store 那一侧是从 window 量的,而用例一直是
 * 把它当参数给的)。
 */

function setViewport(vp: Viewport): void {
  Object.defineProperty(window, 'innerWidth', { value: vp.w, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: vp.h, configurable: true })
}

/** 把一份 `StageState` 摆进两台 store。翻译整件在共用夹具 `test/stage-fixture` 里。 */
const load = seedStage

/** 前后一样不一样。**一样就交回入参那个对象** —— 恒等变换那一族断言问的是引用。 */
function sameStage(a: StageState, b: StageState): boolean {
  return JSON.stringify(snapshotOf(a)) === JSON.stringify(snapshotOf(b))
}

function snapshotOf(st: StageState) {
  return {
    placements: st.placements,
    floats: st.floats,
    floatOrder: st.floatOrder,
    memory: st.memory,
    flashPinned: st.flashPinned,
    flashSide: st.flashSide,
    shelves: Object.fromEntries(
      (['left', 'right', 'top', 'bottom'] as ShelfSide[]).map((side) => [
        side,
        {
          tabs: st.shelves[side].tabs ?? [],
          activeId: st.shelves[side].activeId ?? null,
          thickness: st.shelves[side].thickness,
          collapsed: st.shelves[side].collapsed,
        },
      ]),
    ),
  }
}

function run(st: StageState, vp: Viewport, act: () => void): StageState {
  setViewport(vp)
  load(st)
  act()
  /*
   * 编排跑完把投影对一次账 —— 生产那一路由 store 的 `orchestrate` 做,
   * 这里直接调编排层,所以自己补这一句(判词在 `stage/store.ts` 的 `orchestrate`)。
   */
  syncStageResidency()
  const out = useStageStore.getState()
  return sameStage(st, out) ? st : out
}

const D = stagePlacementDeps

function openAs(
  st: StageState,
  id: string,
  placement: PlacementTarget,
  vp: Viewport = FALLBACK_VIEWPORT,
  edgeIndex?: number,
): StageState {
  return run(st, vp, () => P.placeAs(D, id, placement, edgeIndex))
}

/**
 * 一次落定的**外溢结果**(W2)。全屏那一档不写在形态机上 —— 它把「谁去铺」
 * 说给 store 听,由 store 派给拼贴台(判词在 `stage/placement.PlacementOutcome`)。
 * 这一层测不到那一步,能测的是**它有没有把这句话说出口**。
 */
function outcomeOf(
  st: StageState,
  vp: Viewport,
  act: () => P.PlacementOutcome,
): P.PlacementOutcome {
  let out: P.PlacementOutcome = null
  run(st, vp, () => {
    out = act()
  })
  return out
}

function closeToDock(st: StageState, id: string): StageState {
  return run(st, FALLBACK_VIEWPORT, () => P.closeToDock(D, id))
}

function openFromMemory(
  st: StageState,
  id: string,
  m: PlacementMemory,
  vp: Viewport = FALLBACK_VIEWPORT,
): StageState {
  return run(st, vp, () => P.openFromMemory(D, id, m))
}

function closeStage(st: StageState): StageState {
  return run(st, FALLBACK_VIEWPORT, () => P.closeStage(D))
}

/**
 * 宿主那一句的纯函数替身。`fullOpen` 是**参数**(W2):全屏那一格瞬态住在拼贴台
 * 那本账上,形态机的纯函数半边不认识它 —— 判词写在 `escapeTargetOf` 上。
 */
function escapeTopmost(st: StageState, fullOpen = false): StageState {
  return run(st, FALLBACK_VIEWPORT, () => {
    const target = escapeTargetOf(useStageStore.getState(), fullOpen)
    if (target?.kind === 'item') P.closeToDock(D, target.id)
  })
}

function stageToFloat(st: StageState, vp: Viewport = FALLBACK_VIEWPORT): StageState {
  return run(st, vp, () => {
    const id = useStageStore.getState().stageId
    if (id !== null) P.placeAs(D, id, { kind: 'float' })
  })
}

function stageToEdge(st: StageState, side: ShelfSide): StageState {
  return run(st, FALLBACK_VIEWPORT, () => {
    const id = useStageStore.getState().stageId
    if (id !== null) P.placeAs(D, id, { kind: 'edge', side })
  })
}

function floatToEdge(st: StageState, id: string, side: ShelfSide): StageState {
  return run(st, FALLBACK_VIEWPORT, () => {
    if (placementOf(useStageStore.getState(), id).kind !== 'float') return
    P.placeAs(D, id, { kind: 'edge', side })
  })
}

function edgeToFloat(st: StageState, id: string, vp: Viewport = FALLBACK_VIEWPORT): StageState {
  return run(st, vp, () => {
    if (placementOf(useStageStore.getState(), id).kind !== 'edge') return
    P.placeAs(D, id, { kind: 'float' })
  })
}

function closeShelf(st: StageState, side: ShelfSide): StageState {
  return run(st, FALLBACK_VIEWPORT, () => P.closeShelf(D, side))
}

function activateShelfTab(st: StageState, side: ShelfSide, id: string): StageState {
  return run(st, FALLBACK_VIEWPORT, () => P.activateShelfTabIn(D, side, id))
}

const STAGE: Placement = { kind: 'stage' }
const FLOAT: Placement = { kind: 'float' }
/** 全屏不是一种 Placement(W2)—— 它是「打开方式」那张表上的一档。 */
const FULL: PlacementTarget = { kind: 'full' }
const RIGHT: Placement = { kind: 'edge', side: 'right' }

/** 一块大得放得下默认浮窗的视口,免得每个用例都被钳制干扰。 */
const VP: Viewport = { w: 1600, h: 1000 }

/** 造一个「某条边的架子上有几个 tab」的态,省得每个用例手拼。 */
function withShelf(
  tabs: string[],
  activeId: string | null = tabs[tabs.length - 1] ?? null,
  side: ShelfSide = 'right',
): StageState {
  let st = base
  for (const id of tabs) st = openAs(st, id, { kind: 'edge', side })
  return activeId ? activateShelfTab(st, side, activeId) : st
}

const rightShelf = (st: StageState) => st.shelves.right

/**
 * 「排到那条边的末尾」——测试里最常要的那一条记忆。
 * 记忆带次序,所以「开在哪条边」不再是一个能到处复用的常量:它总是相对某个当下的态。
 */
const atEnd = (st: StageState, side: ShelfSide = 'right'): PlacementMemory => ({
  kind: 'edge',
  side,
  index: (st.shelves[side].tabs ?? []).length,
})

/**
 * 新浮窗那条记忆。**没有矩形**(W7-p 修一轮裁定 1):「记得它浮着,但没人量过
 * 它多大」——矩形由 `placeAs` 那一刻的唯一产地 `freshFloatRect` 现算(锚 + 层叠)。
 * 从前这里带一个 `defaultFloatRect(VP)`,而那个恒定值正是「点瓦开出来的四扇窗
 * 叠成一摞」的病根:记忆里有矩形 → `placeAs` 跳过产地。
 */
const M_FLOAT: PlacementMemory = { kind: 'float' }

describe('resolveOpen(解析序:显式手势 > 记忆 > 全局默认档)', () => {
  /** 造一个「这块瓦有这么一条记忆」的态。 */
  const withMemory = (id: string, m: PlacementMemory): StageState => ({
    ...base,
    memory: { ...base.memory, [id]: m },
  })

  it('没有记忆 → 落到全局默认档(舞台已不在档里)', () => {
    expect(resolveOpen(base, 'files', 'pinned')).toEqual({
      kind: 'edge',
      side: 'right',
      index: 0,
    })
    expect(resolveOpen(base, 'files', 'float')).toEqual(M_FLOAT)
  })

  it('记忆赢:打开还原最后一次显式落点,档只在无记忆时说话(08-30 晚定案)', () => {
    const rect = { x: 1, y: 2, w: 300, h: 400 }
    expect(resolveOpen(withMemory('files', { kind: 'float', rect }), 'files', 'float')).toEqual({
      kind: 'float',
      rect,
    })
    // 异形态照样还原 —— 「我亲手钉过它」是事实,档抹不掉它。
    expect(
      resolveOpen(withMemory('files', { kind: 'edge', side: 'left', index: 2 }), 'files', 'float'),
    ).toEqual({ kind: 'edge', side: 'left', index: 2 })
    expect(resolveOpen(withMemory('files', { kind: 'stage' }), 'files', 'float')).toEqual({
      kind: 'stage',
    })
  })

  it('用户流程逐字(08-30 晚定案):初开浮窗 → 钉右 → 关 → 开在右 → 弹出 → 关 → 开成浮窗', () => {
    // 初始无记忆:默认档 = 浮窗。
    expect(resolveOpen(base, 'sessions', 'float')).toEqual(M_FLOAT)
    // 手势一:钉到右边(显式落点,openAs 落定即写记忆)。
    let st = openAs(base, 'sessions', { kind: 'edge', side: 'right' }, VP)
    st = closeToDock(st, 'sessions')
    expect(resolveOpen(st, 'sessions', 'float')).toEqual({ kind: 'edge', side: 'right', index: 0 })
    // 按记忆开回右边,再弹出成浮窗(手势二改写记忆),关掉。
    st = openFromMemory(st, 'sessions', resolveOpen(st, 'sessions', 'float'), VP)
    st = edgeToFloat(st, 'sessions', VP)
    st = closeToDock(st, 'sessions')
    // 再开:浮窗(带弹出时落定的矩形)。
    const resolved = resolveOpen(st, 'sessions', 'float')
    expect(resolved.kind).toBe('float')
  })

  it('记忆只作用于自己那一个 id —— 别的瓦照旧跟默认档', () => {
    const st = withMemory('files', { kind: 'float', rect: { x: 1, y: 2, w: 300, h: 400 } })
    expect(resolveOpen(st, 'diff', 'float')).toEqual(M_FLOAT)
  })

  it('第三层「显式手势」不经过这个函数:手势自己说得出落点,直接调 openAs', () => {
    // 记忆说钉左边,手势说上舞台 —— 手势赢,并且把记忆改写成舞台。
    const st = openAs(withMemory('files', { kind: 'edge', side: 'left', index: 0 }), 'files', STAGE)
    expect(formOf(st, 'files')).toBe('stage')
    expect(st.memory.files).toEqual({ kind: 'stage' })
  })

  it("'pinned' 这个历史值的语义就是 edge:right,翻译只此一处", () => {
    expect(placementForOpen('pinned')).toEqual({ kind: 'edge', side: 'right' })
    expect(placementForOpen('float')).toEqual(FLOAT)
  })

  it('运行时残值一律钳成浮窗 —— 迁移会被在飞实例的写盘绕过(08-30 报障:弹出后再开又钉回右边)', () => {
    // v5 上线时开着的窗口把旧值 'stage' 配着新版本号写回 localStorage,migrate 不再跑。
    // 修前:残值走 else 分支被当成 pinned → 点开钉回右边;修后:除 'pinned' 外一律浮窗。
    expect(placementForOpen('stage' as never)).toEqual(FLOAT)
    expect(clampDefaultOpen('stage')).toBe('float')
    expect(clampDefaultOpen(undefined)).toBe('float')
    expect(clampDefaultOpen('pinned')).toBe('pinned')
    expect(clampDefaultOpen('float')).toBe('float')
    // 残值只影响**无记忆**的档兜底;有记忆时记忆照常还原(定案语义)。
    const pinnedOnce = withMemory('files', { kind: 'edge', side: 'right', index: 0 })
    expect(resolveOpen(pinnedOnce, 'files', 'stage' as never)).toEqual({
      kind: 'edge',
      side: 'right',
      index: 0,
    })
    expect(resolveOpen(base, 'files', 'stage' as never)).toEqual(M_FLOAT)
  })

  it('默认档补成记忆时,缺的那两件事按「就当它没来过」补', () => {
    // 钉边:排到那条边现有的末尾,不是插到最前。
    const two = withShelf(['files', 'diff'])
    expect(defaultOpenMemory(two, 'pinned')).toEqual({ kind: 'edge', side: 'right', index: 2 })
    // 浮窗:新窗默认身量。
    expect(defaultOpenMemory(base, 'float')).toEqual(M_FLOAT)
  })

  it('检索面板是普通的一块瓦:参与 resolveOpen 全套(记忆照常还原)', () => {
    expect(resolveOpen(base, 'search', 'float')).toEqual(M_FLOAT)
    expect(resolveOpen(withMemory('search', { kind: 'stage' }), 'search', 'pinned')).toEqual({
      kind: 'stage',
    })
  })
})

/*
 * ── `describe('clickDockIcon')` 那一组的去处(W7-p 裁定 6)────────────────────
 * 「点 Dock 瓦这一下什么意思」从此**不是形态机的事**:两个入口(点瓦 / 快捷键)
 * 都走同一台召唤机器(`summon.summonFromSituation`),而那台机器的状态表由
 * `__tests__/summon.test.ts` 逐行钉着,两个入口逐字相同由
 * `__tests__/summon-entries.test.ts` 在真 store 上钉着。
 *
 * 所以那一组里**问 toggle 语义的八条**(舞台再点一下关掉、看得见的再点收整栏、
 * 收着的再点展开+闪、收展收一个来回、点非活动 tab 切过去、闪烁累加、浮窗再点
 * 置顶)整组搬走了 —— 它们的主语已经不存在。剩下的七条问的是**「按记忆开出来」
 * 这一支落在哪儿**,那仍旧是形态机的事,所以留在下面,只是改叫它真正的名字。
 */
describe('openFromMemory(「按记忆开出来」那一支 —— 召唤第一态的落点)', () => {
  it('落点 stage → 上舞台', () => {
    expect(stageIdOf(openFromMemory(base, 'files', STAGE))).toBe('files')
  })

  it('舞台一次只有一个:开另一个是直接替换,不排队', () => {
    const opened = openFromMemory(base, 'files', STAGE)
    const next = openFromMemory(opened, 'diff', STAGE)
    expect(stageIdOf(next)).toBe('diff')
    expect(formOf(next, 'files')).toBe('dock')
  })

  it('落点 edge → 追加成新 tab 并激活,不上舞台', () => {
    const next = openFromMemory(base, 'files', atEnd(base))
    expect(rightShelf(next).tabs).toEqual(['files'])
    expect(rightShelf(next).activeId).toBe('files')
    expect(stageIdOf(next)).toBeNull()
    expect(formOf(next, 'files')).toBe('edge')
  })

  it('连开两个 edge → 两个 tab 共存,次序即先后,活动的是后来的那个', () => {
    const one = openFromMemory(base, 'files', atEnd(base))
    const next = openFromMemory(one, 'diff', atEnd(one))
    expect(rightShelf(next).tabs).toEqual(['files', 'diff'])
    expect(rightShelf(next).activeId).toBe('diff')
    expect(formOf(next, 'files')).toBe('edge')
  })

  it('落点 edge 时舞台开着也不动它:架子与舞台正交', () => {
    const state = openAs(base, 'terminal', STAGE)
    const next = openFromMemory(state, 'files', atEnd(state))
    expect(stageIdOf(next)).toBe('terminal')
    expect(rightShelf(next).tabs).toEqual(['files'])
  })

  it('钉住 A 时开 B 上舞台,两者共存', () => {
    const state = withShelf(['diff'])
    const next = openFromMemory(state, 'files', STAGE)
    expect(stageIdOf(next)).toBe('files')
    expect(rightShelf(next).tabs).toEqual(['diff'])
    expect(next.flashPinned).toBe(0)
  })

  it('是纯函数:不改原对象', () => {
    const before = JSON.parse(JSON.stringify(base))
    openFromMemory(base, 'files', atEnd(base))
    expect(base).toEqual(before)
  })
})

describe('stageToEdge / stageToFloat', () => {
  it('把舞台落成新 tab 并激活,舞台清空', () => {
    const opened = openFromMemory(base, 'files', STAGE)
    const next = stageToEdge(opened, 'right')
    expect(rightShelf(next).tabs).toEqual(['files'])
    expect(rightShelf(next).activeId).toBe('files')
    expect(stageIdOf(next)).toBeNull()
    expect(formOf(next, 'files')).toBe('edge')
  })

  it('已有 tab 时追加到末尾,不再是替换', () => {
    const state = openAs(withShelf(['diff']), 'files', STAGE)
    const next = stageToEdge(state, 'right')
    expect(rightShelf(next).tabs).toEqual(['diff', 'files'])
    expect(rightShelf(next).activeId).toBe('files')
  })

  it('钉到别的边去:落到那条边,右边那条一个都不多', () => {
    const next = stageToEdge(openAs(base, 'files', STAGE), 'top')
    expect(next.shelves.top.tabs).toEqual(['files'])
    expect(next.shelves.right.tabs).toEqual([])
  })

  it('没有舞台时两者都是恒等变换', () => {
    expect(stageToEdge(base, 'right')).toBe(base)
    expect(stageToFloat(base, VP)).toBe(base)
  })

  it('舞台变浮窗:居中默认身量,舞台清空', () => {
    const next = stageToFloat(openAs(base, 'files', STAGE), VP)
    expect(formOf(next, 'files')).toBe('float')
    expect(stageIdOf(next)).toBeNull()
    // 锚点的参考系是**中央区**(W7-p 裁定 5),所以期望值也得从同一把尺算 ——
    // 这里没有架子,于是它就是「顶栏之下、视口右上角内缩一格」。
    expect(next.floats.files).toEqual(freshFloatRect(base, VP))
  })

  it('收起态下舞台钉到边,栏展开(点了不能"看起来什么都没发生")', () => {
    const st = stageToEdge(
      toggleShelfCollapsed(openAs(base, 'files', STAGE), 'right'),
      'right',
    )
    expect(rightShelf(st).tabs).toContain('files')
    expect(rightShelf(st).collapsed).toBe(false)
  })

  it('收起态下新图标入架子,栏展开', () => {
    const collapsed = toggleShelfCollapsed(base, 'right')
    const st = openFromMemory(collapsed, 'files', atEnd(collapsed))
    expect(rightShelf(st).tabs).toContain('files')
    expect(rightShelf(st).collapsed).toBe(false)
  })
})

describe('closeToDock(摘 tab 那一路)', () => {
  it('摘掉唯一的 tab → 架子空,活动为 null,该 item 回 dock 形态', () => {
    const next = closeToDock(withShelf(['diff']), 'diff')
    expect(rightShelf(next).tabs).toEqual([])
    expect(rightShelf(next).activeId).toBeNull()
    expect(formOf(next, 'diff')).toBe('dock')
  })

  it('摘掉活动 tab → 焦点先落右边那个', () => {
    const next = closeToDock(withShelf(['files', 'diff', 'terminal'], 'diff'), 'diff')
    expect(rightShelf(next).tabs).toEqual(['files', 'terminal'])
    expect(rightShelf(next).activeId).toBe('terminal')
  })

  it('摘掉最右的活动 tab → 右边没有了,退回左边', () => {
    const next = closeToDock(withShelf(['files', 'diff'], 'diff'), 'diff')
    expect(rightShelf(next).tabs).toEqual(['files'])
    expect(rightShelf(next).activeId).toBe('files')
  })

  it('摘掉非活动 tab → 活动的不动', () => {
    const next = closeToDock(withShelf(['files', 'diff'], 'diff'), 'files')
    expect(rightShelf(next).tabs).toEqual(['diff'])
    expect(rightShelf(next).activeId).toBe('diff')
  })

  it('收一个本来就在 Dock 里的 → 恒等变换', () => {
    const state = withShelf(['diff'])
    expect(closeToDock(state, 'files')).toBe(state)
    expect(closeToDock(base, 'files')).toBe(base)
  })
})

describe('activateShelfTab', () => {
  it('切换活动 tab', () => {
    const next = activateShelfTab(withShelf(['files', 'diff'], 'diff'), 'right', 'files')
    expect(rightShelf(next).activeId).toBe('files')
    expect(rightShelf(next).tabs).toEqual(['files', 'diff'])
  })

  it('已经是活动的 / 不在这条边上 → 都是恒等变换', () => {
    const state = withShelf(['files', 'diff'], 'diff')
    expect(activateShelfTab(state, 'right', 'diff')).toBe(state)
    expect(activateShelfTab(state, 'right', 'terminal')).toBe(state)
    expect(activateShelfTab(state, 'left', 'files')).toBe(state)
  })
})

describe('closeStage', () => {
  it('closeStage 关舞台,不动架子', () => {
    const state = openAs(withShelf(['diff']), 'files', STAGE)
    const next = closeStage(state)
    expect(stageIdOf(next)).toBeNull()
    expect(rightShelf(next).tabs).toEqual(['diff'])
  })

  it('无舞台时是恒等变换', () => {
    expect(closeStage(base)).toBe(base)
  })
})

describe('浮窗', () => {
  it('开一扇:登记落点、进置顶序、给一个锚在右上角的默认矩形(W7-p 裁定 5)', () => {
    const st = openAs(base, 'files', FLOAT, VP)
    expect(formOf(st, 'files')).toBe('float')
    expect(st.floatOrder).toEqual(['files'])
    // 反证:把 defaultFloatRect 换回「恒定居中」→ x 变成 (VP.w - w)/2,这条红。
    expect(st.floats.files).toEqual({
      w: FLOAT_DEFAULT_W,
      h: FLOAT_DEFAULT_H,
      x: VP.w - FLOAT_SPAWN_INSET - FLOAT_DEFAULT_W,
      // **顶栏那条带切在中央区之外**(W7-p 裁定 5 的修正,判词在 `TOP_CHROME` 上):
      // 不切的话新窗一开就盖住标签条的右半截(`gate:drag` 场景①③的真机现场)。
      y: TOP_CHROME + FLOAT_SPAWN_INSET,
    })
  })

  it('层叠:已有 n 扇未关时往左下挪 n×28,挪不动了就回绕到起点(W7-p 裁定 5)', () => {
    // 层叠级数**从状态里读**(`floatOrder` 有几扇),不再由调用方递一个数进来 ——
    // W7-p 修一轮裁定 1:新窗矩形只有 `freshFloatRect` 一个产地,读数装配在它里面。
    const spawn = (open: number) =>
      freshFloatRect({ ...base, floatOrder: Array.from({ length: open }, (_, i) => `w${i}`) }, VP)
    const anchorX = VP.w - FLOAT_SPAWN_INSET - FLOAT_DEFAULT_W
    const first = spawn(0)
    const second = spawn(1)
    expect(second.x).toBe(anchorX - FLOAT_CASCADE_STEP)
    expect(second.y).toBe(TOP_CHROME + FLOAT_SPAWN_INSET + FLOAT_CASCADE_STEP)
    // 四扇两两不同:审计 A 的 A6 现场是四扇一模一样地叠在一起。
    const four = [0, 1, 2, 3].map(spawn)
    expect(new Set(four.map((r) => `${r.x},${r.y}`)).size).toBe(4)
    // 回绕:挪到出中央区就回起点(steps 由视口算,所以这里问的是「有没有回绕」)。
    const center = centerRectOf(base, VP)
    const steps = Math.min(
      Math.floor((anchorX - center.left) / FLOAT_CASCADE_STEP),
      Math.floor((center.bottom - center.top - FLOAT_SPAWN_INSET - FLOAT_DEFAULT_H) / FLOAT_CASCADE_STEP),
    )
    expect(spawn(steps + 1)).toEqual(first)
  })

  it('锚是**中央区**的右上角,不是视口的 —— 钉了右架子就往里让(W7-p 裁定 5)', () => {
    const withShelf = {
      ...base,
      shelves: {
        ...base.shelves,
        right: { ...base.shelves.right, thickness: 400, tabs: ['diff'], collapsed: false },
      },
    }
    const center = centerRectOf(withShelf, VP)
    expect(center.right).toBe(VP.w - 400)
    const rect = freshFloatRect(withShelf, VP)
    // 反证:把 `freshFloatRect` 换回 `defaultFloatRect`(参考系是整个视口)→
    // x 回到贴视口右缘,新窗开在右架子底下。
    expect(rect.x).toBe(VP.w - 400 - FLOAT_SPAWN_INSET - FLOAT_DEFAULT_W)
  })

  it('置顶:挪到序末;已经在末位或根本不是浮窗都是恒等变换', () => {
    let st = openAs(base, 'files', FLOAT, VP)
    st = openAs(st, 'diff', FLOAT, VP)
    expect(st.floatOrder).toEqual(['files', 'diff'])
    const raised = focusFloat(st, 'files')
    expect(raised.floatOrder).toEqual(['diff', 'files'])
    expect(focusFloat(raised, 'files')).toBe(raised)
    expect(focusFloat(raised, 'terminal')).toBe(raised)
  })

  /*
   * 09-04 §4 之后**这条口径一字未改**:拖拽走的是 `clampFloatRect` 那把尺,位置照旧
   * 允许出界、只保证露出 FLOAT_KEEP。重钳那把尺(fitFloatRect)另有一组用例在下面。
   */
  it('拖移钳制:横向至少留 40px 在视口内,纵向不许推出屏顶', () => {
    const st = openAs(base, 'files', FLOAT, VP)
    const far = moveFloat(st, 'files', 9999, 9999, VP)
    expect(far.floats.files.x).toBe(VP.w - FLOAT_KEEP)
    expect(far.floats.files.y).toBe(VP.h - FLOAT_KEEP)

    const near = moveFloat(st, 'files', -9999, -9999, VP)
    expect(near.floats.files.x).toBe(FLOAT_KEEP - FLOAT_DEFAULT_W)
    expect(near.floats.files.y).toBe(0)
  })

  it('拖移不改身量,也不动别的窗', () => {
    let st = openAs(base, 'files', FLOAT, VP)
    st = openAs(st, 'diff', FLOAT, VP)
    const before = st.floats.diff
    const moved = moveFloat(st, 'files', 10, 20, VP)
    expect(moved.floats.files.w).toBe(FLOAT_DEFAULT_W)
    expect(moved.floats.files.h).toBe(FLOAT_DEFAULT_H)
    expect(moved.floats.diff).toBe(before)
  })

  it('缩放钳到最小身量', () => {
    const st = openAs(base, 'files', FLOAT, VP)
    const tiny = resizeFloat(st, 'files', { x: 100, y: 100, w: 10, h: 10 }, VP)
    expect(tiny.floats.files.w).toBe(FLOAT_MIN_W)
    expect(tiny.floats.files.h).toBe(FLOAT_MIN_H)
  })

  it('拖北/西两边到最小时坐标跟着回推,窗子不会一边缩一边跑', () => {
    const from = { x: 400, y: 300, w: 300, h: 220 }
    const w = resizeFrom(from, 'w', 9999, 0)
    expect(w.w).toBe(FLOAT_MIN_W)
    expect(w.x).toBe(from.x + from.w - FLOAT_MIN_W)

    const n = resizeFrom(from, 'n', 0, 9999)
    expect(n.h).toBe(FLOAT_MIN_H)
    expect(n.y).toBe(from.y + from.h - FLOAT_MIN_H)
  })

  it('拖东南角同时改两轴,坐标不动', () => {
    const from = { x: 100, y: 100, w: 400, h: 300 }
    expect(resizeFrom(from, 'se', 50, 60)).toEqual({ x: 100, y: 100, w: 450, h: 360 })
  })

  it('收回 Dock 再开,还在老位置(矩形按 item 记忆)', () => {
    let st = openAs(base, 'files', FLOAT, VP)
    st = moveFloat(st, 'files', 42, 84, VP)
    const remembered = st.floats.files
    st = closeToDock(st, 'files')
    expect(st.floatOrder).toEqual([])
    expect(st.floats.files).toEqual(remembered)
    st = openAs(st, 'files', FLOAT, VP)
    expect(st.floats.files).toEqual(remembered)
  })

  it('不是浮窗的 id:拖移 / 缩放都是恒等变换', () => {
    expect(moveFloat(base, 'files', 10, 10, VP)).toBe(base)
    expect(resizeFloat(base, 'files', { x: 0, y: 0, w: 500, h: 400 }, VP)).toBe(base)
  })

  it('视口比默认身量还小:新窗取视口减掉两道气口(位置口径未动,仍从 0 起算)', () => {
    const small: Viewport = { w: 500, h: 400 }
    // 09-04 §4 只加了**身量上界**这一格:从前是 500×400(整个视口),现在留出两道气口。
    // x/y 仍是 0 —— 拖拽那把尺的位置口径一字没改,居中算出来是 0 就是 0。
    // W7-p 裁定 5:锚从「居中」换成「右上角内缩 24」,而这一档视口连一格身量都
    // 塞不下,`clampFloatRect` 的 KEEP 口径把它按回 0 —— 位置口径仍旧一字没改。
    expect(defaultFloatRect(small)).toEqual({
      x: 500 - FLOAT_SPAWN_INSET - (500 - 2 * FLOAT_MARGIN),
      y: FLOAT_SPAWN_INSET,
      w: 500 - 2 * FLOAT_MARGIN,
      h: 400 - 2 * FLOAT_MARGIN,
    })
  })

  it('clampFloatRect 是纯算术,两处(拖拽预览与落库)共用同一把尺', () => {
    expect(clampFloatRect({ x: 10, y: 10, w: 900, h: 700 }, VP)).toEqual({
      x: 10,
      y: 10,
      w: 900,
      h: 700,
    })
  })

  it('身量上界是本批唯一加在手势那条路上的新约束:比视口还宽的窗子拉不出来', () => {
    // 反证:把 clampFloatSize 里 w 那一句改回 Math.max(FLOAT_MIN_W, …) → 这条红。
    const rect = clampFloatRect({ x: 0, y: 0, w: 9999, h: 9999 }, VP)
    expect(rect.w).toBe(VP.w - 2 * FLOAT_MARGIN)
    expect(rect.h).toBe(VP.h - 2 * FLOAT_MARGIN)
  })

  /* ── 视口重钳(09-04 §4;宿主那一半在 __tests__/viewport-reclamp.test.tsx)── */

  it('fitFloatRect:放得下就整扇拉回视口内,两端各留 FLOAT_MARGIN', () => {
    // 同一份矩形、同一台视口,两把尺给出**不同**的答案 —— 这正是本批拆成两把的理由。
    // 反证:让 fitFloatRect 直接 return clampFloatRect(...) → 这条与下面两条一起红。
    const far = { x: 9999, y: 9999, w: FLOAT_DEFAULT_W, h: FLOAT_DEFAULT_H }
    expect(fitFloatRect(far, VP)).toEqual({
      x: VP.w - FLOAT_MARGIN - FLOAT_DEFAULT_W,
      y: VP.h - FLOAT_MARGIN - FLOAT_DEFAULT_H,
      w: FLOAT_DEFAULT_W,
      h: FLOAT_DEFAULT_H,
    })
    expect(clampFloatRect(far, VP).x).toBe(VP.w - FLOAT_KEEP)

    const near = fitFloatRect({ x: -9999, y: -9999, w: 600, h: 400 }, VP)
    expect(near.x).toBe(FLOAT_MARGIN)
    expect(near.y).toBe(FLOAT_MARGIN)
  })

  it('fitFloatRect:视口窄到塞不下最小档时退回 KEEP 那把尺,窗子还看得见、还抓得住', () => {
    // 两轴都要塞不下才走这一支:280 + 2*16 = 312 > 300(横),200 + 2*16 = 232 > 220(纵)。
    const narrow: Viewport = { w: 300, h: 220 }
    const far = fitFloatRect({ x: 9999, y: 9999, w: 280, h: 200 }, narrow)
    expect(far.x).toBe(narrow.w - FLOAT_KEEP)
    expect(far.y).toBe(narrow.h - FLOAT_KEEP)
    const near = fitFloatRect({ x: -9999, y: -9999, w: 280, h: 200 }, narrow)
    expect(near.x).toBe(FLOAT_KEEP - 280)
    // 纵向下界仍是 0:标题栏被推出屏顶就再也拖不回来了。
    expect(near.y).toBe(0)
  })

  it('宽窗里存下的浮窗落进 1100 视口:先钳身量再钳位置,右缘不出界', () => {
    // 真机报障那一份逐字:x=260 / w=879,搬进 1100 宽的窗里右缘在 1139 —— 屏幕外。
    const vp: Viewport = { w: 1100, h: 800 }
    const st = {
      ...base,
      floats: { sessions: { x: 260, y: 40, w: 879, h: 700 } },
      memory: { sessions: { kind: 'float' as const, rect: { x: 260, y: 40, w: 879, h: 700 } } },
    }
    const next = reclampAll(st, vp)
    const rect = next.floats.sessions
    // 反证:让 reclampAll 改用 clampFloatRect(手势那把尺)→ x 停在 260,右缘 1139,这条红。
    expect(rect.x + rect.w).toBeLessThanOrEqual(vp.w - FLOAT_MARGIN)
    expect(rect.y + rect.h).toBeLessThanOrEqual(vp.h - FLOAT_MARGIN)
    expect(rect.w).toBeGreaterThanOrEqual(FLOAT_MIN_W)
    expect(rect.x).toBeGreaterThanOrEqual(FLOAT_MARGIN)
    /*
     * **记忆一个字不动**(W7-p 裁定 4 推翻 09-04 那句「记忆里那一份同样钳过」)。
     * 记忆是用户的意图,只有手势与落定写得了它;重钳写它 = 一次临时的窄屏永久
     * 改写用户摆好的身量(审计 A 的 A5)。关着的窗再开出来靠 `openFromMemory`
     * 那一句 `clampFloatRect` 钳,不靠这里。
     * 反证:把 `reclampFloatMap` 旁边那只 `reclampMemoryMap` 加回去 → 这条红。
     */
    expect(next.memory.sessions).toEqual({ kind: 'float', rect: { x: 260, y: 40, w: 879, h: 700 } })

    // 变窄再变宽:活矩形从**同一份记忆**重算,所以逐字回到原样(裁定 4 的正题)。
    const back = reclampAll(next, { w: 1600, h: 900 })
    expect(back.floats.sessions).toEqual({ x: 260, y: 40, w: 879, h: 700 })
  })

  it('账上每个空间那一格家具也钳(切回去不会露出同一个病)', () => {
    const vp: Viewport = { w: 1100, h: 800 }
    const st = {
      ...base,
      byWorkspace: {
        other: {
          ...factoryStageFurniture(),
          floats: { sessions: { x: 260, y: 40, w: 879, h: 700 } },
        },
      },
    }
    const rect = reclampAll(st, vp).byWorkspace.other.floats.sessions
    expect(rect.x + rect.w).toBeLessThanOrEqual(vp.w - FLOAT_MARGIN)
  })

  it('一格都没越界 = 恒等变换:交回同一个对象,resize 不白推一轮渲染', () => {
    const vp: Viewport = { w: 1100, h: 800 }
    const fits = { x: 100, y: 100, w: 600, h: 400 }
    const st = {
      ...base,
      floats: { sessions: fits },
      memory: { sessions: { kind: 'float' as const, rect: fits } },
      byWorkspace: { other: { ...factoryStageFurniture(), floats: { diff: fits } } },
    }
    // 反证:把 reclampFloatMap 的 `return next ?? floats` 改成 `return { ...floats }`
    // → 这一条当场红(而屏幕上的表现是每发 resize 都重渲染一次浮窗层)。
    expect(reclampAll(st, vp)).toBe(st)
  })
})


/**
 * v6 之后**家具住在账里**(`byWorkspace.default`),迁移的产物也是那个形。
 *
 * 这些用例问的仍然是同一件事(v0→v5 那串翻译对不对),所以它们一个断言都没改口径,
 * 只是从这一口取件 —— 「家具搬了家」与「家具翻译对不对」是两件事,混在一起改会让
 * 这批用例失去它们原本盯着的那条链。
 *
 * 顺带:取不到那一格就原样回 `out`,好让「压根没有家具的老档」那几条仍然读得下去
 * (v6 段对没摘到家具的档案是恒等变换 —— 见 foldFlatIntoDefaultSpace)。
 */
function furniture(out: Record<string, unknown>): Record<string, unknown> {
  const ledger = out.byWorkspace as Record<string, Record<string, unknown>> | undefined
  return ledger?.default ?? out
}

/**
 * **v9 之后住处不在 stage 的档案里了**(W4:它交给了拼贴台)。
 *
 * 这些用例问的仍然是同一件事(v0→v8 那串翻译对不对),所以它们一个断言都不改
 * 口径 —— 只是取件口从「档案里那一格」换成「**交接单**上那一份」:v9 那一段在
 * 摘掉 `placements` / 架子 tab 之前把它们递出来,而那正是拼贴台接住的东西。
 *
 * 取的是默认空间那一格(这批老档一路走过 v6,家具都折在那儿),取不到就回空对象。
 */
function migrateWithHandoff(persisted: unknown, version: number) {
  const handed = new Map<string | null, Record<string, unknown>>()
  const out = migrateStagePersisted(persisted, version, (id, f) => {
    handed.set(id, f)
  }) as Record<string, unknown>
  return { out, handed }
}

/** 交接单上默认空间那一格(= v9 摘走的那一份住处)。 */
function handedFurniture(persisted: unknown, version: number): Record<string, unknown> {
  const { handed } = migrateWithHandoff(persisted, version)
  return handed.get(DEFAULT_SPACE_ID) ?? handed.get(null) ?? {}
}

/**
 * **交接单折出来的那批树** —— 「这份老档升上来之后,拼贴台里长出了什么」。
 * 这是 W4 之后「翻译对不对」最诚实的读法:住处已经不在 stage 的档案里,
 * 唯一说得出「架子上有哪几格、次序是什么」的地方就是这棵树。
 */
function handedRegions(persisted: unknown, version: number): Record<string, PaneNode> {
  let n = 0
  return regionsFromLegacyFurniture(handedFurniture(persisted, version), () => `leaf-${(n += 1)}`)
}

/** 一棵单叶树上那几格 tab 的瓦 id(按叶内次序)。 */
function tabsOf(tree: PaneNode | undefined): string[] {
  if (!tree || tree.kind !== 'leaf') return []
  return tree.tabs.map((ref) => ref.key)
}

describe('migrateStagePersisted', () => {
  it('v0 的单值 pinnedId → 一路翻成 v3 的右架子 + placements', () => {
    const archive = { pinnedId: 'diff', pinnedWidth: 500 }
    // 住处走**交接单**(v9 把它交给拼贴台了),厚度那一半仍旧留在 stage 的档案里。
    const handed = handedFurniture(archive, 0)
    const handedShelves = handed.shelves as Record<string, { tabs: string[]; activeId: string | null }>
    expect(handedShelves.right.tabs).toEqual(['diff'])
    expect(handedShelves.right.activeId).toBe('diff')
    expect(handed.placements).toEqual({ diff: { kind: 'edge', side: 'right' } })

    const out = migrateStagePersisted(archive, 0) as Record<string, unknown>
    const shelves = furniture(out).shelves as Record<string, { thickness: number }>
    expect(shelves.right.thickness).toBe(500)
    // 住处那两格从 stage 的档案里摘干净了 —— 留着就是第二份说法。
    expect('placements' in furniture(out)).toBe(false)
    expect('tabs' in shelves.right).toBe(false)
    expect('pinnedId' in out).toBe(false)
    expect('pinned' in out).toBe(false)
    expect('pinnedWidth' in out).toBe(false)
  })

  it('v0 但没有 pinnedId(或是 null)→ 空架子,别的字段原样留着', () => {
    const archive = { pinnedId: null, dockDisplay: 'autohide' }
    // 一格 tab 都没有 = 交接单折出来**一棵树都没有**。
    expect(handedRegions(archive, 0)).toEqual({})
    const out = migrateStagePersisted(archive, 0) as Record<string, unknown>
    const shelves = furniture(out).shelves as Record<string, { thickness: number }>
    expect(shelves.right.thickness).toBe(SHELF_DEFAULT_THICKNESS)
    expect(out.dockDisplay).toBe('autohide')
    expect('pinnedId' in out).toBe(false)
  })

  it('v1 → v2 的那段仍在:缺的 Dock 四边 / 沿边位置 / 大小按默认补齐', () => {
    const out = migrateStagePersisted({ pinned: ['files'], activePinnedId: 'files' }, 1) as Record<
      string,
      unknown
    >
    expect(out.dockEdge).toBe(initialStageSettings.dockEdge)
    expect(out.dockAlign).toBe(initialStageSettings.dockAlign)
    expect(out.dockSize).toBe(initialStageSettings.dockSize)
    const shelves = furniture(out).shelves as Record<string, { collapsed: boolean }>
    expect(shelves.right.collapsed).toBe(false)
    const handed = handedFurniture({ pinned: ['files'], activePinnedId: 'files' }, 1)
    expect((handed.shelves as Record<string, { tabs: string[] }>).right.tabs).toEqual(['files'])
  })

  it('v1 档案里已有的值赢:补默认是铺底,不是覆盖', () => {
    const out = migrateStagePersisted({ dockEdge: 'left', dockSize: 'lg' }, 1) as Record<
      string,
      unknown
    >
    expect(out.dockEdge).toBe('left')
    expect(out.dockSize).toBe('lg')
    expect(out.dockAlign).toBe(initialStageSettings.dockAlign)
  })

  it('v2 → v3:钉栏那四个字段整组翻成右架子,收起态与厚度都带过去', () => {
    const out = migrateStagePersisted(
      {
        pinned: ['files', 'diff'],
        activePinnedId: 'files',
        pinnedWidth: 520,
        pinnedCollapsed: true,
        dockEdge: 'left',
      },
      2,
    ) as Record<string, unknown>
    const shelves = furniture(out).shelves as Record<
      string,
      { thickness: number; collapsed: boolean }
    >
    // 几何留在 stage 的档案里;tab 次序与活动 tab 走交接单。
    expect(shelves.right).toEqual({ thickness: 520, collapsed: true })
    const handed = handedFurniture(
      {
        pinned: ['files', 'diff'],
        activePinnedId: 'files',
        pinnedWidth: 520,
        pinnedCollapsed: true,
        dockEdge: 'left',
      },
      2,
    )
    const handedShelves = handed.shelves as Record<string, { tabs: string[]; activeId: string | null }>
    expect(handedShelves.right.tabs).toEqual(['files', 'diff'])
    expect(handedShelves.right.activeId).toBe('files')
    // 别的三条边一格都没有 —— 折出来只有 `edge:right` 那一棵。
    expect(Object.keys(handedRegions(
      {
        pinned: ['files', 'diff'],
        activePinnedId: 'files',
        pinnedWidth: 520,
        pinnedCollapsed: true,
        dockEdge: 'left',
      },
      2,
    ))).toEqual(['edge:right'])
    expect(handed.placements).toEqual({
      files: { kind: 'edge', side: 'right' },
      diff: { kind: 'edge', side: 'right' },
    })
    expect(furniture(out).floats).toEqual({})
    expect(furniture(out).floatOrder).toEqual([])
    expect(out.dockEdge).toBe('left')
    expect('pinnedCollapsed' in out).toBe(false)
  })

  it('v2 档案里活动 tab 已不在名单上 → 退回最后一个,不留悬空 id', () => {
    const handed = handedFurniture({ pinned: ['files'], activePinnedId: 'gone' }, 2)
    const shelves = handed.shelves as Record<string, { activeId: string | null }>
    expect(shelves.right.activeId).toBe('files')
  })

  it('v2 没有钉栏字段 → 四条空架子 + 默认厚度', () => {
    const out = migrateStagePersisted({ locale: 'zh' }, 2) as Record<string, unknown>
    const shelves = furniture(out).shelves as Record<string, { thickness: number }>
    expect(shelves.right.thickness).toBe(SHELF_DEFAULT_THICKNESS)
    expect(handedRegions({ locale: 'zh' }, 2)).toEqual({})
    expect(out.locale).toBe('zh')
  })

  it('v6 → v7:Dock 放大那三格铺底,缺省逐字等于升级前的行为(零迁移感)', () => {
    const out = migrateStagePersisted({ dockEdge: 'left' }, 6) as Record<string, unknown>
    expect(out.dockMagnify).toBe(true)
    expect(out.dockMagnifyLevel).toBe('md')
    expect(out.dockRunningDot).toBe(true)
    expect(out.dockEdge).toBe('left')
  })

  it('v7 的铺底也是铺底不是覆盖:自己关过放大的档案升上来还是关着', () => {
    const out = migrateStagePersisted({ dockMagnify: false, dockMagnifyLevel: 'lg' }, 6) as Record<
      string,
      unknown
    >
    expect(out.dockMagnify).toBe(false)
    expect(out.dockMagnifyLevel).toBe('lg')
    expect(out.dockRunningDot).toBe(true)
  })

  it('已经是当前版本的原样放行', () => {
    const current = { placements: {}, dockEdge: 'right' }
    expect(migrateStagePersisted(current, STAGE_PERSIST_VERSION)).toBe(current)
  })
})

describe('pickStageFurniture(存盘只带几何走)', () => {
  /*
   * W4 之前这里测的是 `withoutTransientPlacements`:存盘前把舞台那条
   * placement 摘掉。W4 之后**整张 `placements` 都不存了**(它是树的投影,
   * 事实跟着 `onething.workbench` 那本账走),所以这条判据升级成:
   * 摘出来的那一份里**一格住处都没有** —— 既没有 placements,架子上也只剩几何。
   */
  it('摘出来的家具里一格住处都没有:没有 placements,架子只剩厚度与收起态', () => {
    let st = openAs(base, 'diff', RIGHT)
    st = openAs(st, 'browser', FLOAT, VP)
    st = openAs(st, 'files', STAGE)
    const saved = pickStageFurniture(st)
    expect('placements' in saved).toBe(false)
    expect(saved.shelves.right.tabs).toBeUndefined()
    expect(saved.shelves.right.activeId).toBeUndefined()
    expect(saved.shelves.right.collapsed).toBe(false)
    // 几何那一半照旧跟着走:浮窗矩形与位置记忆都在。
    expect(Object.keys(saved.floats)).toContain('browser')
    expect(saved.memory.diff).toEqual({ kind: 'edge', side: 'right', index: 0 })
  })
})

describe('厚度钳制(W2:下界 240 绝对值,上界 55% 比例)', () => {
  it('区间内的厚度原样通过', () => {
    expect(clampShelfThickness(500, 1600)).toBe(500)
  })

  it('小于 240 抬到 240', () => {
    expect(clampShelfThickness(100, 1600)).toBe(SHELF_MIN_THICKNESS)
  })

  it('大于视口的 55% 压回 55%', () => {
    expect(clampShelfThickness(1400, 1600)).toBe(880)
  })

  it('视口太窄时下界赢(不会算出小于 240 的上界)', () => {
    expect(clampShelfThickness(400, 300)).toBe(SHELF_MIN_THICKNESS)
  })

  it('setShelfThickness 走的是同一个钳子', () => {
    // W7-p 裁定 3:递整个视口(共同预算要问对边);对边空着时预算不设限,
    // 上界照旧是 55%,所以这两条读数与 W2 逐字相同。
    const vp = { w: 1600, h: 1600 }
    expect(rightShelf(setShelfThickness(base, 'right', 100, vp)).thickness).toBe(
      SHELF_MIN_THICKNESS,
    )
    expect(rightShelf(setShelfThickness(base, 'right', 1400, vp)).thickness).toBe(880)
  })

  it('改的是这一条边的厚度,别的边不动', () => {
    const st = setShelfThickness(base, 'left', 500, { w: 1600, h: 1600 })
    expect(st.shelves.left.thickness).toBe(500)
    expect(st.shelves.right.thickness).toBe(SHELF_DEFAULT_THICKNESS)
  })

  it('竖边量宽、横边量高 —— 同一个数换个轴读', () => {
    const vp = { w: 1600, h: 900 }
    expect(shelfViewportExtent('left', vp)).toBe(1600)
    expect(shelfViewportExtent('right', vp)).toBe(1600)
    expect(shelfViewportExtent('top', vp)).toBe(900)
    expect(shelfViewportExtent('bottom', vp)).toBe(900)
  })

  it('从指针反推厚度:量的是外缘到指针那一段,四条边各一个方向', () => {
    // 右架子外缘在 1600,指针在 1200 → 厚 400;左架子外缘在 0,指针在 400 → 也是 400。
    expect(thicknessFromPointer('right', { x: 1200, y: 0 }, 1600)).toBe(400)
    expect(thicknessFromPointer('left', { x: 400, y: 0 }, 0)).toBe(400)
    expect(thicknessFromPointer('bottom', { x: 0, y: 700 }, 900)).toBe(200)
    // 顶架子的外缘不是 0(它在 TopBar 之下),所以外缘必须由宿主量出来递进来。
    expect(thicknessFromPointer('top', { x: 0, y: 344 }, 44)).toBe(300)
  })
})

/**
 * **共同预算:四条边与中央区分同一块地**(W7-p 裁定 3,审计 A 的 A3/A4)。
 *
 * 上面那一组问的是「一条边自己钳到哪」;这一组问的是**两条对边加起来还给中央
 * 留没留下地方** —— 那正是 A3 的病根:`clampShelfThickness` 逐边算 55%,上下两条
 * 各拿走 55% 加起来 110%,真机上中央区量到 h = 0,输入框浮在上架子的内容上。
 */
describe('架子共同预算(W7-p 裁定 3)', () => {
  /** 一条边上有几格 tab、多厚、收没收。**只造几何**,不碰树。 */
  const shelvesOf = (
    spec: Partial<Record<ShelfSide, { thickness?: number; collapsed?: boolean; empty?: boolean }>>,
  ): StageState['shelves'] => {
    const shelves = emptyShelves()
    for (const [side, cfg] of Object.entries(spec) as [ShelfSide, { thickness?: number; collapsed?: boolean; empty?: boolean }][]) {
      shelves[side] = {
        ...shelves[side],
        tabs: cfg.empty ? [] : ['x'],
        activeId: cfg.empty ? null : 'x',
        thickness: cfg.thickness ?? SHELF_DEFAULT_THICKNESS,
        collapsed: cfg.collapsed ?? false,
      }
    }
    return shelves
  }

  it('「这条边此刻占多厚」三档:空的 0、收着的一条细梁、展开的才是厚度', () => {
    const sh = shelvesOf({ left: { thickness: 400 }, right: { collapsed: true, thickness: 400 }, top: { empty: true } })
    expect(shelfExtentOf(sh.left)).toBe(400)
    expect(shelfExtentOf(sh.right)).toBe(SHELF_RAIL)
    expect(shelfExtentOf(sh.top)).toBe(0)
  })

  it('预算 = 该轴**可用长度** − 中央最小 − 对边此刻厚度(竖轴先扣顶栏)', () => {
    const st = { shelves: shelvesOf({ left: { thickness: 400 }, top: { thickness: 300 } }) }
    const vp = { w: 1600, h: 1000 }
    expect(shelfThicknessBudget(st, 'right', vp)).toBe(1600 - CENTER_MIN_W - 400)
    /*
     * **竖轴扣顶栏**(W7-p 修一轮裁定 6)。反证:把 `usableExtent` 换回
     * `shelfViewportExtent`(即不扣 TOP_CHROME)→ 这条与下面那条一起红,而真机上的
     * 样子是 860 高的窗里「上 300 + 下 240」被判为装得下、中央区实高只有 276。
     */
    expect(shelfThicknessBudget(st, 'bottom', vp)).toBe(1000 - TOP_CHROME - CENTER_MIN_H - 300)
    // 对面空着 = 不占地:整条轴减中央最小就是全部预算。
    expect(shelfThicknessBudget({ shelves: emptyShelves() }, 'right', vp)).toBe(1600 - CENTER_MIN_W)
    expect(shelfThicknessBudget({ shelves: emptyShelves() }, 'top', vp)).toBe(
      1000 - TOP_CHROME - CENTER_MIN_H,
    )
    // 预算与 `centerRectOf` 是**同一把尺**:上下都钉满预算时中央区正好等于最小高。
    const filled = { shelves: shelvesOf({ top: { thickness: 300 }, bottom: { thickness: 1000 - TOP_CHROME - CENTER_MIN_H - 300 } }) }
    const center = centerRectOf(filled, vp)
    expect(center.bottom - center.top).toBe(CENTER_MIN_H)
  })

  it('对边配对只在一张表里:left↔right、top↔bottom', () => {
    expect(OPPOSITE_SHELF).toEqual({ left: 'right', right: 'left', top: 'bottom', bottom: 'top' })
  })

  it('钉得上吗:预算够 240 才钉得上,不够就**拒绝**(不是压成 0)', () => {
    const vp = { w: 1024, h: 768 }
    // 1024 − 480 = 544;左边钉了 400 之后只剩 144 < 240 → 右边摆不下。
    const st = { shelves: shelvesOf({ left: { thickness: 400 } }) }
    expect(canNailShelf(st, 'right', vp)).toBe(false)
    // 反证:去掉共同预算(退回逐边 55%)→ 这里会答 true,右架子当场钉上去,
    // 中央区被压到 224 —— 那正是 A3。
    expect(canNailShelf({ shelves: emptyShelves() }, 'right', vp)).toBe(true)
  })

  it('已经开着的那条边永远钉得上 —— 再插一格 tab 不改几何', () => {
    const vp = { w: 700, h: 500 }
    const st = { shelves: shelvesOf({ left: { thickness: 240 }, right: { thickness: 240 } }) }
    // 预算此刻是负的,可这条边已经有东西:拒绝往一条开着的架子上再放一格是莫名其妙。
    expect(shelfThicknessBudget(st, 'right', vp)).toBeLessThan(SHELF_MIN_THICKNESS)
    expect(canNailShelf(st, 'right', vp)).toBe(true)
  })

  it('钳子的上界是「55% 与预算里小的那个」,而下界 240 永远赢', () => {
    expect(clampShelfThickness(900, 1600, 500)).toBe(500)
    expect(clampShelfThickness(900, 1600, 1200)).toBe(880)
    // 预算比下界还小(挤到没地方了):钳到 240,而不是钳出一个比 240 还小的数。
    expect(clampShelfThickness(900, 1600, 100)).toBe(SHELF_MIN_THICKNESS)
  })

  it('拖杆落定走同一把尺:对边占着 400 时,右边拖到底也只到预算那一格', () => {
    const st: StageState = { ...initialStageState, shelves: shelvesOf({ left: { thickness: 400 }, right: { thickness: 300 } }) }
    const next = setShelfThickness(st, 'right', 5000, { w: 1600, h: 1000 })
    expect(next.shelves.right.thickness).toBe(1600 - CENTER_MIN_W - 400)
    // 左边一个字没动。
    expect(next.shelves.left.thickness).toBe(400)
  })

  it('视口重钳:窗子变小,四条边按同一把尺收回来(A4:右架子曾探出屏幕 204px)', () => {
    const st: StageState = {
      ...initialStageState,
      shelves: shelvesOf({ left: { thickness: 400 }, right: { thickness: 400 } }),
      shelfNailOrder: ['left', 'right'],
    }
    const next = reclampShelves(st, { w: 1200, h: 800 })
    // 后钉的那条先让:right 先被钳到 1200 − 480 − 400 = 320。
    expect(next.shelves.right.thickness).toBe(320)
    expect(next.shelves.left.thickness).toBe(400)
    // 中央区确实还站得住。
    expect(1200 - next.shelves.left.thickness - next.shelves.right.thickness)
      .toBeGreaterThanOrEqual(CENTER_MIN_W)
  })

  it('次序即语义:换一个钉边序,让路的就换一条', () => {
    const base9: StageState = {
      ...initialStageState,
      shelves: shelvesOf({ left: { thickness: 400 }, right: { thickness: 400 } }),
      shelfNailOrder: ['right', 'left'],
    }
    const next = reclampShelves(base9, { w: 1200, h: 800 })
    // 反证:把 `nailRank` 的排序方向翻过来 → 这两条读数对调,先摆好的那条被人挤。
    expect(next.shelves.left.thickness).toBe(320)
    expect(next.shelves.right.thickness).toBe(400)
  })

  /**
   * **空的一格地都不占;收着的按细梁占地,但它的厚度照钳**。
   *
   * 后半句是这一格里最容易被「顺手优化掉」的一条,所以单独钉:收起来的架子屏幕上
   * 只有 12px,重钳当然不必为它腾地 —— 可 `toggleShelfCollapsed` **不重钳**
   * (它只翻一格布尔,见 `placement.setShelfCollapsed`)。于是「展开任何一条架子,
   * 中央区仍旧站得住」这句话唯一的守处就是这里:重钳时连收着的那条一起钳,
   * 它才不会在被展开的那一刻把中央区顶穿。
   */
  it('空着的边不参与;收着的按细梁占地,但它自己的厚度照样钳(展开即穿帮的唯一守处)', () => {
    const st: StageState = {
      ...initialStageState,
      shelves: shelvesOf({ left: { collapsed: true, thickness: 400 }, right: { thickness: 900 }, top: { empty: true } }),
      shelfNailOrder: ['left', 'right'],
    }
    const next = reclampShelves(st, { w: 1600, h: 900 })
    // 右边算预算时左边只占一条细梁:min(1600×0.55 = 880, 1600 − 480 − 12 = 1108) → 880。
    expect(next.shelves.right.thickness).toBe(880)
    // 左边收着,可它的厚度按「展开之后还站得住」钳:1600 − 480 − 880 = 240。
    expect(next.shelves.left.thickness).toBe(SHELF_MIN_THICKNESS)
    // 空着那条一个字没动 —— 它不在场,谈不上钳。
    expect(next.shelves.top.thickness).toBe(SHELF_DEFAULT_THICKNESS)
    // 这一条才是上面那句话的意思:此刻把左边展开,中央区仍旧 ≥ 480。
    expect(1600 - next.shelves.left.thickness - next.shelves.right.thickness).toBe(CENTER_MIN_W)
  })

  it('一条都没动就交回同一个对象(与 reclampAll 逐字同一条纪律)', () => {
    const st: StageState = {
      ...initialStageState,
      shelves: shelvesOf({ right: { thickness: 400 } }),
      shelfNailOrder: ['right'],
    }
    expect(reclampShelves(st, { w: 1600, h: 900 })).toBe(st)
  })

  it('钉边序缺席也确定:退到 SHELF_SIDES 的固定次序(冷启动第一帧)', () => {
    const st: StageState = {
      ...initialStageState,
      shelves: shelvesOf({ left: { thickness: 400 }, right: { thickness: 400 } }),
      shelfNailOrder: [],
    }
    const a = reclampShelves(st, { w: 1200, h: 800 })
    const b = reclampShelves(st, { w: 1200, h: 800 })
    expect(a.shelves.left.thickness).toBe(b.shelves.left.thickness)
    expect(a.shelves.right.thickness).toBe(b.shelves.right.thickness)
    expect(1200 - a.shelves.left.thickness - a.shelves.right.thickness)
      .toBeGreaterThanOrEqual(CENTER_MIN_W)
  })

  it('reclampAll 把架子一起钳(它是 resize 那条路的唯一口)', () => {
    const st: StageState = {
      ...initialStageState,
      shelves: shelvesOf({ left: { thickness: 400 }, right: { thickness: 400 } }),
      shelfNailOrder: ['left', 'right'],
    }
    // 反证:把 `reclampAll` 里那句 `reclampShelves(...)` 拆掉 → 这条读到 400。
    expect(reclampAll(st, { w: 1200, h: 800 }).shelves.right.thickness).toBe(320)
  })
})

describe('snapSideAt(拖到边缘要不要吸)', () => {
  const VIEWPORT = { w: 1000, h: 800 }

  it('四条边各自的热带里各吸各的', () => {
    expect(snapSideAt({ x: 5, y: 400 }, VIEWPORT)).toBe('left')
    expect(snapSideAt({ x: 995, y: 400 }, VIEWPORT)).toBe('right')
    expect(snapSideAt({ x: 500, y: 3 }, VIEWPORT)).toBe('top')
    expect(snapSideAt({ x: 500, y: 797 }, VIEWPORT)).toBe('bottom')
  })

  it('带外一律 null —— 不吸,松手照常落位', () => {
    expect(snapSideAt({ x: 500, y: 400 }, VIEWPORT)).toBeNull()
    // 恰好差一个像素出带:24 进、25 出。
    expect(snapSideAt({ x: 24, y: 400 }, VIEWPORT)).toBe('left')
    expect(snapSideAt({ x: 25, y: 400 }, VIEWPORT)).toBeNull()
  })

  it('角落归**最近**的那条边,不是归先写的那条', () => {
    // 左 5、上 20 → 左近;左 20、上 5 → 上近。
    expect(snapSideAt({ x: 5, y: 20 }, VIEWPORT)).toBe('left')
    expect(snapSideAt({ x: 20, y: 5 }, VIEWPORT)).toBe('top')
  })

  it('平手优先左右(竖架子是主力形态)', () => {
    expect(snapSideAt({ x: 10, y: 10 }, VIEWPORT)).toBe('left')
    expect(snapSideAt({ x: 990, y: 790 }, VIEWPORT)).toBe('right')
  })

  it('band 是参数,不是写死的数', () => {
    expect(snapSideAt({ x: 40, y: 400 }, VIEWPORT)).toBeNull()
    expect(snapSideAt({ x: 40, y: 400 }, VIEWPORT, 60)).toBe('left')
  })
})

describe('tab 从架子上撕下来的阈值', () => {
  it('四条边各朝主区那个方向量距离', () => {
    // 右架子内缘在 1200,指针越往左走距离越大。
    expect(tearOffDistance('right', { x: 1160, y: 0 }, 1200)).toBe(40)
    expect(tearOffDistance('left', { x: 340, y: 0 }, 300)).toBe(40)
    expect(tearOffDistance('bottom', { x: 0, y: 560 }, 600)).toBe(40)
    expect(tearOffDistance('top', { x: 0, y: 240 }, 200)).toBe(40)
  })

  it('还压在架子那一侧是负数 —— 不可能撕下来', () => {
    expect(tearOffDistance('right', { x: 1260, y: 0 }, 1200)).toBe(-60)
    expect(shouldTearOff('right', { x: 1260, y: 0 }, 1200)).toBe(false)
  })

  it('没过 24 就不算撕:一次没拖动的按下松开仍然是普通点击', () => {
    expect(shouldTearOff('right', { x: 1180, y: 0 }, 1200)).toBe(false)
    expect(shouldTearOff('right', { x: 1176, y: 0 }, 1200)).toBe(false)
    expect(shouldTearOff('right', { x: 1175, y: 0 }, 1200)).toBe(true)
  })

  it('撕下来那一刻:指针是标题栏的中心(横向居中、纵向落在标题栏一半高处)', () => {
    const rect = floatRectForGrab({ x: 600, y: 300 }, { w: 400, h: 300 }, { w: 1000, h: 800 }, 40)
    expect(rect).toEqual({ x: 400, y: 280, w: 400, h: 300 })
  })

  it('撕下来的矩形也过浮窗钳制(不许一半在屏外)', () => {
    const rect = floatRectForGrab({ x: 10, y: 10 }, { w: 400, h: 300 }, { w: 1000, h: 800 }, 40)
    expect(rect.x).toBeGreaterThanOrEqual(FLOAT_KEEP - rect.w)
    expect(rect.y).toBeGreaterThanOrEqual(0)
  })
})

describe('Dock 自动隐藏的唤醒窄带(去元素化后就是一次距离判定)', () => {
  const VIEWPORT = { w: 1000, h: 800 }

  it('四条边各问各的那一维', () => {
    expect(withinDockWakeBand({ x: 500, y: 795 }, VIEWPORT, 'bottom')).toBe(true)
    expect(withinDockWakeBand({ x: 500, y: 3 }, VIEWPORT, 'top')).toBe(true)
    expect(withinDockWakeBand({ x: 3, y: 400 }, VIEWPORT, 'left')).toBe(true)
    expect(withinDockWakeBand({ x: 997, y: 400 }, VIEWPORT, 'right')).toBe(true)
  })

  it('8 进、9 出;停在别的边不算进这条边的带', () => {
    expect(withinDockWakeBand({ x: 500, y: 792 }, VIEWPORT, 'bottom')).toBe(true)
    expect(withinDockWakeBand({ x: 500, y: 791 }, VIEWPORT, 'bottom')).toBe(false)
    expect(withinDockWakeBand({ x: 500, y: 3 }, VIEWPORT, 'bottom')).toBe(false)
  })
})

describe('formOf / placementOf / clamp', () => {
  it('四种形态互斥,默认 dock', () => {
    const state = openAs(withShelf(['diff']), 'files', STAGE)
    expect(formOf(state, 'files')).toBe('stage')
    expect(formOf(state, 'diff')).toBe('edge')
    expect(formOf(state, 'terminal')).toBe('dock')
    expect(formOf(openAs(base, 'browser', FLOAT, VP), 'browser')).toBe('float')
  })

  it('架子上的非活动 tab 也是 edge(形态说的是「在哪」不是「可见吗」)', () => {
    const state = withShelf(['files', 'diff'], 'diff')
    expect(formOf(state, 'files')).toBe('edge')
  })

  it('placementOf 连边一起给出来 —— 光知道 kind 不够定位', () => {
    const st = openAs(base, 'files', { kind: 'edge', side: 'bottom' })
    expect(placementOf(st, 'files')).toEqual({ kind: 'edge', side: 'bottom' })
  })

  it('clamp 在 max < min 时返回 min', () => {
    expect(clamp(50, 320, 100)).toBe(320)
  })

  it('formIn 与 formOf 同一条规则(投影层只订阅 placements 也问得出形态)', () => {
    const state = openAs(withShelf(['diff']), 'files', STAGE)
    expect(formIn(state.placements, 'files')).toBe('stage')
    expect(formIn(state.placements, 'diff')).toBe('edge')
    expect(formIn(state.placements, 'terminal')).toBe('dock')
  })
})

describe('items 表', () => {
  it('会话总览是普通瓦:上舞台 / 收回 Dock 与别的瓦逐字同一条路', () => {
    const st = openAs(base, SESSIONS_ITEM_ID, STAGE)
    expect(formOf(st, SESSIONS_ITEM_ID)).toBe('stage')
    expect(formOf(closeToDock(st, SESSIONS_ITEM_ID), SESSIONS_ITEM_ID)).toBe('dock')
  })

  it('检索也是普通瓦:两块瓦在同一张表里,没有第二种打开法', () => {
    expect(findItem('search')).toBeDefined()
    expect(findItem(SESSIONS_ITEM_ID)).toBeDefined()
    // 落点解析也一视同仁:同一份设置、同一个没记忆的起点,两块瓦解析出同一条记忆。
    expect(resolveOpen(base, SESSIONS_ITEM_ID, 'float')).toEqual(
      resolveOpen(base, 'search', 'float'),
    )
  })

  it('接管型已退役:一块瓦都不许再带 takeover 字段', () => {
    expect(STAGE_ITEMS.filter((i) => 'takeover' in i)).toEqual([])
  })
})

describe('closeShelf(整栏关闭)', () => {
  it('这条边上的 tab 全部收回 Dock,别的边不动', () => {
    let st = initialStageState
    st = openFromMemory(st, 'diff', atEnd(st))
    st = openFromMemory(st, 'terminal', atEnd(st))
    st = openFromMemory(st, 'files', atEnd(st, 'left'))
    st = closeShelf(st, 'right')
    expect(st.shelves.right.tabs).toEqual([])
    expect(st.shelves.right.activeId).toBeNull()
    expect(placementOf(st, 'diff').kind).toBe('dock')
    expect(placementOf(st, 'terminal').kind).toBe('dock')
    expect(st.shelves.left.tabs).toEqual(['files'])
  })

  it('空栏是恒等变换', () => {
    expect(closeShelf(initialStageState, 'top')).toBe(initialStageState)
  })
})

describe('withinDockHoldZone(自动隐藏留驻区)', () => {
  const vp = { w: 1000, h: 800 }
  const rect = { left: 930, right: 992, top: 300, bottom: 500 } // 右边 Dock,内缩 8

  it('边带与本体之间的死缝也算留驻(一闪而逝的根因)', () => {
    expect(withinDockHoldZone({ x: 995, y: 400 }, vp, 'right', rect)).toBe(true)
  })

  /*
   * 余量 08-31 由 8 放宽到 24(DOCK_HOLD_PAD)。用例跟着改的是**数**不是意图:
   * 「本体四周一段余量内算留驻,出了那一段就不算」这句话一个字没变,
   * 所以断言点全部按 DOCK_HOLD_PAD 现算 —— 下次再调这个数,用例不必再改一遍。
   */
  it('矩形四周 pad 内算留驻,远处不算', () => {
    expect(withinDockHoldZone({ x: rect.left - DOCK_HOLD_PAD + 1, y: 400 }, vp, 'right', rect)).toBe(true)
    expect(withinDockHoldZone({ x: rect.left - DOCK_HOLD_PAD - 1, y: 400 }, vp, 'right', rect)).toBe(false)
    expect(withinDockHoldZone({ x: 960, y: rect.top - DOCK_HOLD_PAD - 1 }, vp, 'right', rect)).toBe(false)
  })

  it('补边只朝所属边:right 的区不含左半屏', () => {
    expect(withinDockHoldZone({ x: 100, y: 400 }, vp, 'right', rect)).toBe(false)
  })
})

/* ── G 批:位置记忆 ─────────────────────────────────────────────────────────── */

describe('位置记忆:关闭是归档,不是删除', () => {
  it('三种形态各走一趟归档-恢复往返', () => {
    // 舞台
    let st = openAs(base, 'files', STAGE, VP)
    st = closeToDock(st, 'files')
    expect(st.memory.files).toEqual({ kind: 'stage' })
    expect(formOf(openFromMemory(st, 'files', st.memory.files, VP), 'files')).toBe('stage')

    // 浮窗:连矩形一起回来
    st = openAs(base, 'diff', FLOAT, VP)
    st = moveFloat(st, 'diff', 123, 45, VP)
    const rect = st.floats.diff
    st = closeToDock(st, 'diff')
    expect(st.memory.diff).toEqual({ kind: 'float', rect })
    const backFloat = openFromMemory(st, 'diff', st.memory.diff, VP)
    expect(formOf(backFloat, 'diff')).toBe('float')
    expect(backFloat.floats.diff).toEqual(rect)

    // 钉边:连边与次序一起回来
    st = withShelf(['files', 'diff', 'terminal'])
    st = closeToDock(st, 'diff')
    expect(st.memory.diff).toEqual({ kind: 'edge', side: 'right', index: 1 })
    const backEdge = openFromMemory(st, 'diff', st.memory.diff, VP)
    expect(backEdge.shelves.right.tabs).toEqual(['files', 'diff', 'terminal'])
  })

  it('归档记的是**当下**那个落点,不是最早那个', () => {
    let st = openAs(base, 'files', STAGE, VP)
    st = openAs(st, 'files', { kind: 'edge', side: 'bottom' }, VP)
    st = closeToDock(st, 'files')
    expect(st.memory.files).toEqual({ kind: 'edge', side: 'bottom', index: 0 })
  })

  it('本来就在 Dock 里的收一下是恒等变换:不擦上一次归档的记忆', () => {
    const archived = closeToDock(openAs(base, 'files', STAGE, VP), 'files')
    expect(closeToDock(archived, 'files')).toBe(archived)
    expect(archived.memory.files).toEqual({ kind: 'stage' })
  })

  it('整栏关闭:次序在动手前整条拓下来,不会一路塌成一摞', () => {
    const st = closeShelf(withShelf(['files', 'diff', 'terminal']), 'right')
    expect(st.memory.files).toEqual({ kind: 'edge', side: 'right', index: 0 })
    expect(st.memory.diff).toEqual({ kind: 'edge', side: 'right', index: 1 })
    expect(st.memory.terminal).toEqual({ kind: 'edge', side: 'right', index: 2 })
    // 再一个个开回来,次序与关掉之前逐字相同。
    let back = st
    for (const id of ['terminal', 'files', 'diff']) {
      back = openFromMemory(back, id, back.memory[id], VP)
    }
    expect(back.shelves.right.tabs).toEqual(['files', 'diff', 'terminal'])
  })

  it('整栏关闭不碰别的边的记忆', () => {
    let st = openAs(base, 'files', { kind: 'edge', side: 'left' }, VP)
    st = openAs(st, 'diff', { kind: 'edge', side: 'right' }, VP)
    st = closeShelf(st, 'right')
    expect(st.memory.files).toEqual({ kind: 'edge', side: 'left', index: 0 })
  })
})

describe('位置记忆:落定即写', () => {
  it('菜单点名(= openAs)既执行也写记忆', () => {
    const st = openAs(base, 'files', { kind: 'edge', side: 'top' }, VP)
    expect(formOf(st, 'files')).toBe('edge')
    expect(st.memory.files).toEqual({ kind: 'edge', side: 'top', index: 0 })
  })

  it('浮窗移动 / 缩放落定当场写进记忆', () => {
    let st = openAs(base, 'browser', FLOAT, VP)
    st = moveFloat(st, 'browser', 200, 150, VP)
    expect(st.memory.browser).toEqual({ kind: 'float', rect: st.floats.browser })
    st = resizeFloat(st, 'browser', { x: 10, y: 20, w: 640, h: 480 }, VP)
    expect(st.memory.browser).toEqual({ kind: 'float', rect: { x: 10, y: 20, w: 640, h: 480 } })
  })

  it('记忆里的矩形是**钳制之后**的那一个,不是「本来想放但没放成」的数', () => {
    const st = moveFloat(openAs(base, 'browser', FLOAT, VP), 'browser', 99999, 99999, VP)
    expect(st.memory.browser).toEqual({ kind: 'float', rect: st.floats.browser })
    expect(st.floats.browser.x).toBeLessThanOrEqual(VP.w - FLOAT_KEEP)
  })

  it('不是浮窗时改 floats 不写记忆 —— 陈年矩形不许盖掉现在的钉边记忆', () => {
    let st = openAs(base, 'files', FLOAT, VP)
    st = floatToEdge(st, 'files', 'left')
    expect(st.memory.files).toEqual({ kind: 'edge', side: 'left', index: 0 })
    // floats.files 还留着(那是不擦的表),对它动手不该改写落点记忆。
    st = moveFloat(st, 'files', 7, 7, VP)
    expect(st.memory.files).toEqual({ kind: 'edge', side: 'left', index: 0 })
  })

  it('吸附成钉边 / tab 撕出成浮窗:两条拖拽路都经 openAs,所以都写到了', () => {
    let st = openAs(base, 'files', FLOAT, VP)
    st = floatToEdge(st, 'files', 'bottom')
    expect(st.memory.files).toEqual({ kind: 'edge', side: 'bottom', index: 0 })

    st = edgeToFloat(st, 'files', VP)
    expect(st.memory.files).toEqual({ kind: 'float', rect: st.floats.files })
  })

  it('舞台转边 / 转浮窗也是落定', () => {
    let st = stageToEdge(openAs(base, 'files', STAGE, VP), 'top')
    expect(st.memory.files).toEqual({ kind: 'edge', side: 'top', index: 0 })
    st = stageToFloat(openAs(st, 'diff', STAGE, VP), VP)
    expect(st.memory.diff).toEqual({ kind: 'float', rect: st.floats.diff })
  })

  it('memoryOf:在 Dock 里 = 折不出记忆', () => {
    expect(memoryOf(base, 'files')).toBeNull()
  })
})

describe('位置记忆:按记忆恢复(index 钳制与同边合流)', () => {
  it('记着第 5 个,那条边现在只有 2 个 → 坐第 3 个位子(min(次序, 组长))', () => {
    const st = withShelf(['files', 'diff'])
    const back = openFromMemory(st, 'terminal', { kind: 'edge', side: 'right', index: 5 }, VP)
    expect(back.shelves.right.tabs).toEqual(['files', 'diff', 'terminal'])
  })

  it('负数次序也钳得住(坏档案不许把 tab 排到数组之外)', () => {
    const st = withShelf(['files', 'diff'])
    const back = openFromMemory(st, 'terminal', { kind: 'edge', side: 'right', index: -3 }, VP)
    expect(back.shelves.right.tabs).toEqual(['terminal', 'files', 'diff'])
  })

  it('两块瓦都记着同一条边:各自钳一下就都坐得下,不需要仲裁', () => {
    let st = closeShelf(withShelf(['files', 'diff', 'terminal']), 'right')
    // 先回来的那块记着 index 2,此刻组长 0 → 坐 0;后回来的记着 1,组长 1 → 坐 1。
    st = openFromMemory(st, 'terminal', st.memory.terminal, VP)
    st = openFromMemory(st, 'diff', st.memory.diff, VP)
    expect(st.shelves.right.tabs).toEqual(['terminal', 'diff'])
    // 一个 id 只在一处这条不变式仍然成立。
    expect((st.shelves.right.tabs ?? []).filter((x) => x === 'diff')).toHaveLength(1)
  })

  it('记忆里的浮窗矩形要过与拖拽落定同一把视口尺', () => {
    const tiny: Viewport = { w: 600, h: 400 }
    const back = openFromMemory(
      base,
      'browser',
      { kind: 'float', rect: { x: 5000, y: 5000, w: 900, h: 700 } },
      tiny,
    )
    expect(back.floats.browser).toEqual(
      clampFloatRect({ x: 5000, y: 5000, w: 900, h: 700 }, tiny),
    )
    expect(back.floats.browser.x).toBeLessThanOrEqual(tiny.w - FLOAT_KEEP)
  })

  it('召唤第一态走的就是这条路:无记忆 → 档(浮窗);有记忆 → 还原记忆', () => {
    const remembered: StageState = {
      ...base,
      memory: { files: { kind: 'edge', side: 'left', index: 0 } },
    }
    expect(
      formOf(openFromMemory(base, 'files', resolveOpen(base, 'files', 'float'), VP), 'files'),
    ).toBe('float')
    const next = openFromMemory(
      remembered,
      'files',
      resolveOpen(remembered, 'files', 'float'),
      VP,
    )
    expect(placementOf(next, 'files')).toEqual({ kind: 'edge', side: 'left' })
  })
})

describe('memoryIsAt(菜单那排单选的判据)', () => {
  it('比的是「放在哪」,不比矩形与次序', () => {
    expect(memoryIsAt({ kind: 'stage' }, { kind: 'stage' })).toBe(true)
    expect(memoryIsAt({ kind: 'float', rect: { x: 9, y: 9, w: 300, h: 300 } }, { kind: 'float' })).toBe(
      true,
    )
    expect(
      memoryIsAt({ kind: 'edge', side: 'left', index: 7 }, { kind: 'edge', side: 'left' }),
    ).toBe(true)
  })

  it('边不同就不是同一个落点;没有记忆一行都不勾', () => {
    expect(
      memoryIsAt({ kind: 'edge', side: 'left', index: 0 }, { kind: 'edge', side: 'right' }),
    ).toBe(false)
    expect(memoryIsAt({ kind: 'stage' }, { kind: 'float' })).toBe(false)
    expect(memoryIsAt(undefined, { kind: 'stage' })).toBe(false)
  })
})

describe('migrateStagePersisted v3 → v4(打开方式配置并入记忆)', () => {
  const v3 = (over: Record<string, unknown>) => ({
    placements: {},
    floats: { diff: { x: 10, y: 20, w: 400, h: 300 } },
    floatOrder: [],
    shelves: { ...emptyShelvesLike(), right: { tabs: ['files', 'terminal'], activeId: 'files', thickness: 400, collapsed: false } },
    openOverrides: over,
  })
  function emptyShelvesLike() {
    const one = { tabs: [] as string[], activeId: null, thickness: SHELF_DEFAULT_THICKNESS, collapsed: false }
    return { left: { ...one }, right: { ...one }, top: { ...one }, bottom: { ...one } }
  }

  it('三种配置各一条:float / pinned 不丢;stage 在随后的 v5 段被清(舞台退出打开档)', () => {
    const out = migrateStagePersisted(
      v3({ browser: 'stage', diff: 'float', terminal: 'pinned' }),
      3,
    ) as Record<string, unknown>
    const memory = furniture(out).memory as Record<string, PlacementMemory>
    // v4 段先把 'stage' 翻成记忆,v5 段再把它清掉 —— 净效果:这块瓦回到「没表过态」,
    // 点开跟默认档走(= 浮窗)。float / pinned 记忆原样存活。
    expect('browser' in memory).toBe(false)
    // 'float' 带上老档里存过的那个矩形,不是一个新的默认窗。
    expect(memory.diff).toEqual({ kind: 'float', rect: { x: 10, y: 20, w: 400, h: 300 } })
    // 'pinned' 带上它当时在右架子里的次序(terminal 排第 2)。
    expect(memory.terminal).toEqual({ kind: 'edge', side: 'right', index: 1 })
  })

  it("'default'(以及不认识的值)不写记忆 —— 它继续跟全局默认档走", () => {
    const out = migrateStagePersisted(v3({ files: 'default', browser: 'wat' }), 3) as Record<
      string,
      unknown
    >
    expect(furniture(out).memory).toEqual({})
  })

  it("配了 'float' 但老档没存过矩形 → 给新窗的默认身量", () => {
    const out = migrateStagePersisted(v3({ browser: 'float' }), 3) as Record<string, unknown>
    const memory = furniture(out).memory as Record<string, PlacementMemory>
    // **不编矩形**(W7-p 修一轮裁定 1):迁移期没有真视口,编出来的那一份会被
    // 当成「用户摆过的身量」永久留在档案里。缺矩形 = 开的时候由唯一产地现算。
    expect(memory.browser).toEqual({ kind: 'float', rect: undefined })
  })

  it("配了 'pinned' 但当时不在右架子上 → 排到末尾", () => {
    const out = migrateStagePersisted(v3({ browser: 'pinned' }), 3) as Record<string, unknown>
    const memory = furniture(out).memory as Record<string, PlacementMemory>
    expect(memory.browser).toEqual({ kind: 'edge', side: 'right', index: 2 })
  })

  it('openOverrides 这个键本身退役,活 placements / floats / shelves 照旧恢复', () => {
    const out = migrateStagePersisted(v3({ browser: 'stage' }), 3) as Record<string, unknown>
    expect('openOverrides' in out).toBe(false)
    expect(furniture(out).floats).toEqual({ diff: { x: 10, y: 20, w: 400, h: 300 } })
    // 架子那一份走交接单(v9 起它不在 stage 的档案里了)。
    expect(tabsOf(handedRegions(v3({ browser: 'stage', diff: 'float', terminal: 'pinned' }), 3)['edge:right']))
      .toEqual(['files', 'terminal'])
  })

  it('老档根本没有 openOverrides → 空记忆表,别的字段原样留着', () => {
    const out = migrateStagePersisted({ locale: 'en', floats: {}, shelves: emptyShelvesLike() }, 3) as Record<
      string,
      unknown
    >
    expect(furniture(out).memory).toEqual({})
    expect(out.locale).toBe('en')
  })

  it('v0 的老档一路连到 v5:结构都在,stage 记忆被终段清掉', () => {
    const out = migrateStagePersisted(
      { pinnedId: 'diff', pinnedWidth: 500, openOverrides: { files: 'stage' } },
      0,
    ) as Record<string, unknown>
    expect('files' in (furniture(out).memory as Record<string, PlacementMemory>)).toBe(false)
    expect(tabsOf(handedRegions({ pinnedId: 'diff', openOverrides: { files: 'stage' } }, 0)['edge:right']))
      .toEqual(['diff'])
  })

  it('v4 → v5:defaultOpen 的 stage 迁到 float,float 值原样', () => {
    const out = migrateStagePersisted({ defaultOpen: 'stage', memory: {} }, 4) as Record<string, unknown>
    expect(out.defaultOpen).toBe('float')
    const kept = migrateStagePersisted({ defaultOpen: 'pinned', memory: {} }, 4) as Record<string, unknown>
    expect(kept.defaultOpen).toBe('pinned')
  })
})

/* ══ 08-31 Dock/形态批:盖 · Esc 退层链 · 露面管理 · 自动隐藏留驻区 ══════════ */

/* ══ W2:「盖」退役,真全屏接替它 ═══════════════════════════════════════════ */

describe('全屏(full):形态机这一侧只做**一**件事(W7-p 裁定 2)', () => {
  /*
   * 全屏**不是一种 Placement**(判词在 `stage/types.ts`):树一个字不动、
   * `placements` 里没有它的位子,真正那一格瞬态住在拼贴台那本账上。
   *
   * W2 交卷时这一层做了三件事,而其中两件是**同一个错**的两半 —— 它把全屏当成了
   * 一种住处:摘树 + 写 `remember({kind:'full'})`。真机后果(审计 A 的 A2):
   * 一块钉在右边的瓦全屏一次,记忆被改写成 full,退出后它回 Dock,此后**点它
   * 永远进全屏**,右架子再也回不来。W7-p 裁定 2 把那两件删了,于是这一层只剩
   * ③:把「谁去铺」说出口(`PlacementOutcome`)——落地在 store 那一层,由
   * `workbench/__tests__/full.test.ts` 那一组守。
   */
  it('① 不摘树:钉在右边的瓦全屏之后仍旧钉在右边(退出即回原位,不必搬)', () => {
    let st = openAs(base, 'files', RIGHT)
    expect(formOf(st, 'files')).toBe('edge')
    st = openAs(st, 'files', FULL)
    // 反证:把 `placeAs` 的 full 支里那句 `detachItem(id)` 加回去 → 这条读到 'dock'。
    expect(formOf(st, 'files')).toBe('edge')
  })

  it('② 不写记忆:进之前的住处原样留在记忆里', () => {
    let st = openAs(base, 'files', RIGHT)
    st = closeToDock(st, 'files')
    expect(st.memory.files).toEqual({ kind: 'edge', side: 'right', index: 0 })
    st = openAs(st, 'files', FULL)
    // 反证:把 `remember(deps, id, { kind: 'full' })` 加回去 → 记忆变成 {kind:'full'},
    // 「再点这块瓦」从此永远进全屏(A2 现场)。
    expect(st.memory.files).toEqual({ kind: 'edge', side: 'right', index: 0 })
  })

  it('③ 说出口:`placeAs` 与 `openFromMemory` 都把这一档交回给调用方', () => {
    expect(outcomeOf(base, VP, () => P.placeAs(D, 'files', FULL))).toEqual({ kind: 'full' })
    // 在 Dock 里 + 记忆 = 全屏 → 召唤第一态走的是 `openFromMemory` 那一支。
    expect(
      outcomeOf(base, VP, () => P.openFromMemory(D, 'apps', { kind: 'full' })),
    ).toEqual({ kind: 'full' })
    // 别的档一律不说话 —— 它们的效果全写在这两台 store 上了。
    expect(outcomeOf(base, VP, () => P.placeAs(D, 'files', RIGHT))).toBe(null)
    expect(outcomeOf(base, VP, () => P.placeAs(D, 'files', STAGE))).toBe(null)
  })

  it('不顶掉舞台:全屏盖在它上面,退出即露出(W7-p 裁定 2)', () => {
    let st = openAs(base, 'files', STAGE)
    expect(stageIdOf(st)).toBe('files')
    st = openAs(st, 'files', FULL)
    // 反证:把 `clearTransientOf(deps, id)` 加回 full 那一支 → stageId 变 null,
    // 退出全屏时那块面回了 Dock 而不是回舞台。
    expect(stageIdOf(st)).toBe('files')
    expect(st.memory.files).toEqual({ kind: 'stage' })
  })
})

describe('item 天生落点:解析序的第三层', () => {
  it('没记忆时听 item 的天生落点,而不是全局默认档', () => {
    expect(resolveOpen(base, 'apps', 'float', { kind: 'full' })).toEqual({ kind: 'full' })
  })

  it('有记忆时记忆压过天生落点 —— 「我亲手放过」永远赢', () => {
    const st = openAs(base, 'apps', RIGHT)
    const closed = closeToDock(st, 'apps')
    expect(resolveOpen(closed, 'apps', 'float', { kind: 'full' }).kind).toBe('edge')
  })

  it('没有天生落点就落回全局默认档(与加这一层之前逐字相同)', () => {
    expect(resolveOpen(base, 'files', 'pinned')).toEqual(defaultOpenMemory(base, 'pinned'))
  })

  it('「所有应用」在 items 表上确实声明了 full 与「藏不掉」(W2 拍点 ②)', () => {
    const apps = findItem('apps')
    expect(apps?.defaultPlacement).toEqual({ kind: 'full' })
    expect(apps?.alwaysInDock).toBe(true)
  })
})

describe('Esc 退层链(08-31 修「浮窗按 Esc 没反应」)', () => {
  it('什么都没开时没有目标 —— 宿主据此不拦这一下', () => {
    expect(escapeTargetOf(base, false)).toBeNull()
    expect(escapeTopmost(base)).toBe(base)
  })

  it('**浮窗退得掉**:这正是修前掉进空里的那一下', () => {
    const st = openAs(base, 'sessions', FLOAT, VP)
    expect(escapeTargetOf(st, false)).toEqual({ kind: 'item', id: 'sessions' })
    expect(formOf(escapeTopmost(st), 'sessions')).toBe('dock')
  })

  it('多扇浮窗时退最上面那一扇(floatOrder 末位最上)', () => {
    let st = openAs(base, 'files', FLOAT, VP)
    st = openAs(st, 'diff', FLOAT, VP)
    expect(escapeTargetOf(st, false)).toEqual({ kind: 'item', id: 'diff' })
  })

  it('次序 = z 序:**全屏 > 舞台 > 最上面那扇浮窗**(W2 三级链)', () => {
    let st = openAs(base, 'files', FLOAT, VP)
    expect(escapeTargetOf(st, false)).toEqual({ kind: 'item', id: 'files' })
    st = openAs(st, 'diff', STAGE)
    expect(escapeTargetOf(st, false)).toEqual({ kind: 'item', id: 'diff' })
    /*
     * 反证:把 `fullOpen` 这个输入摘掉(函数体第一句 `if (fullOpen)` 删掉)→
     * 这两条当场红,退层链会先去收舞台,而全屏在它上面盖着。
     */
    expect(escapeTargetOf(st, true)).toEqual({ kind: 'full' })
    expect(escapeTargetOf(base, true)).toEqual({ kind: 'full' })
  })

  it('架子**不在链里** —— 钉在边上是常驻家具,Esc 不该拆家具', () => {
    const st = openAs(base, 'files', RIGHT)
    expect(escapeTargetOf(st, false)).toBeNull()
    expect(escapeTopmost(st)).toBe(st)
  })

  it('退一层就是一层:全屏退掉之后下一下才轮到舞台', () => {
    const st = openAs(base, 'files', STAGE)
    // 全屏开着那一拍:目标是全屏,舞台一个字不动(收全屏的动作不在形态机这一侧)。
    expect(escapeTargetOf(st, true)).toEqual({ kind: 'full' })
    expect(stageIdOf(escapeTopmost(st, true))).toBe('files')
    // 退掉之后才轮到舞台。
    const after = escapeTopmost(st, false)
    expect(stageIdOf(after)).toBeNull()
  })
})

describe('Dock 露面管理(「所有应用」那块瓦的判据)', () => {
  it('藏 / 不藏就是一张 id 表', () => {
    const hidden = setItemHidden([], 'diff', true)
    expect(hidden).toEqual(['diff'])
    expect(isItemHidden(hidden, 'diff')).toBe(true)
    expect(isItemHidden(hidden, 'files')).toBe(false)
    expect(setItemHidden(hidden, 'diff', false)).toEqual([])
  })

  it('重复藏同一块不会写进去两条', () => {
    expect(setItemHidden(['diff'], 'diff', true)).toEqual(['diff'])
  })

  it('alwaysInDock 的瓦藏不掉 —— 挡在判据里,不只是把开关画灰', () => {
    expect(setItemHidden([], 'apps', true, true)).toEqual([])
  })

  it('藏起来的瓦仍然有落点与记忆 —— 藏的是入口,不是这块面', () => {
    let st = openAs(base, 'diff', RIGHT)
    st = closeToDock(st, 'diff')
    // 「藏」根本不经过形态机:同一份 state,同一条记忆。
    expect(st.memory.diff?.kind).toBe('edge')
    expect(formOf(openFromMemory(st, 'diff', st.memory.diff!, VP), 'diff')).toBe('edge')
  })
})

describe('自动隐藏的留驻区:判停稳位而不是飞行中的矩形', () => {
  const vp: Viewport = { w: 1440, h: 900 }
  const INSET = 12 // --sp-3
  /** 真机量到的身量:底边 Dock,高 62,停稳时 top=826 / bottom=888。 */
  const H = 62

  it('停稳位由**身量**算出来 —— translate 不改变尺寸,所以不必等动画停', () => {
    // 滑入到一半:量到的矩形还在 863.8,而它最终会停在 826。
    const flying = { left: 500, right: 940, top: 863.8, bottom: 863.8 + H }
    const settled = settledDockRect(flying, vp, 'bottom', INSET)
    expect(settled.bottom).toBe(vp.h - INSET)
    expect(settled.top).toBe(vp.h - INSET - H)
    // 沿边那一轴照抄:那一截 translate 是常量,从不动画。
    expect(settled.left).toBe(500)
    expect(settled.right).toBe(940)
  })

  it('修前的那一下:滑入第 40ms 抬到 y=850,拿飞行矩形判是「走了」', () => {
    const flying = { left: 500, right: 940, top: 863.8, bottom: 863.8 + H }
    expect(withinDockHoldZone({ x: 720, y: 850 }, vp, 'bottom', flying, 8)).toBe(false)
  })

  it('修后同一下留在区里 —— 手比动画快,判的该是它要去的地方', () => {
    const flying = { left: 500, right: 940, top: 863.8, bottom: 863.8 + H }
    const settled = settledDockRect(flying, vp, 'bottom', INSET)
    expect(withinDockHoldZone({ x: 720, y: 850 }, vp, 'bottom', settled)).toBe(true)
  })

  it('余量放宽到 24:擦着上缘往上抬那一段仍算留驻', () => {
    const settled = { left: 500, right: 940, top: 826, bottom: 888 }
    expect(withinDockHoldZone({ x: 720, y: 826 - 20 }, vp, 'bottom', settled)).toBe(true)
    // 但它是**余量**不是新的家:出了这一段就该老老实实开始计收回。
    expect(withinDockHoldZone({ x: 720, y: 826 - DOCK_HOLD_PAD - 1 }, vp, 'bottom', settled)).toBe(false)
  })

  it('四条边各按自己那一轴算停稳位', () => {
    const flying = { left: 100, right: 162, top: 300, bottom: 700 }
    expect(settledDockRect(flying, vp, 'left', INSET).left).toBe(INSET)
    expect(settledDockRect(flying, vp, 'right', INSET).right).toBe(vp.w - INSET)
    expect(settledDockRect(flying, vp, 'top', INSET).top).toBe(INSET)
  })

  /*
   * 病历(08-31,修完 (d) 第一次跑探针就红):宿主递进来的是 `getBoundingClientRect()`
   * 的返回值,而 DOMRect 的四条边全是**原型上的取值器**——写 `{ ...rect, top, bottom }`
   * 得到的沿边两轴是 undefined,留驻区当场恒假(Dock 停在 826,指针停在窗体正中的
   * 862 也被判成「走了」)。
   *
   * 这条用例造一个同样把边挂在原型上的对象来钉它:朴素对象字面量测不出这个坑,
   * 而这正是真机上唯一会出现的那种输入。反证:把 settledDockRect 改回 `{ ...rect }`,
   * 这一条立刻红。
   */
  it('输入是原型取值器形的矩形(DOMRect 就是这种)时,沿边两轴照抄得到真数', () => {
    const proto = { get left() { return 500 }, get right() { return 940 }, get top() { return 863.8 }, get bottom() { return 925.8 } }
    const domRectLike: Rect = Object.create(proto) as Rect
    const settled = settledDockRect(domRectLike, vp, 'bottom', INSET)
    expect(settled.left).toBe(500)
    expect(settled.right).toBe(940)
    expect(withinDockHoldZone({ x: 720, y: 862 }, vp, 'bottom', settled)).toBe(true)
  })
})

/**
 * 09-01 报障:「现在的 dock 自动出现范围太大了,我想输入都没法输入了」。
 *
 * 这一组用**真机量到的那一屏**当被试(隔离 store,视口 1280×828,底边 / md / 居中):
 *   停稳位  left 310.5  right 969.5  top 754  bottom 816   (身量 62,inset 12)
 *   输入区  left 303    right 801.8  top 775  bottom 799
 *   发送键  left 949    right 977    top 771  bottom 799
 * 修前热区高 12+62+24 = 98px、宽 707px,整条输入区 100% 落在里面。
 *
 * **反证纪律**:把 shouldShowDock 里那行 `if (!shown) return false` 删掉,
 * 「藏着时」那三条立刻红(已真跑过);把 DOCK_HOLD_PAD 调小去「顺手治」唤醒,
 * 「出来之后」那四条立刻红 —— 两个方向都钉住了,谁也别想再把两个语义并回一句。
 */
describe('唤醒与留驻是两个语义(09-01 报障:输入区被唤醒区盖住)', () => {
  const vp: Viewport = { w: 1280, h: 828 }
  const SETTLED = { left: 310.5, right: 969.5, top: 754, bottom: 816 }
  /**
   * 09-03 起唤醒多了一个入参:**在窄带里已经停了多久**。这个帮手默认喂足
   * (DOCK_WAKE_DWELL_MS),于是下面「藏着时」那几条判的仍然是**范围**这件事 ——
   * 停留门槛单独由下一个 describe 钉,两件事不搅在一组断言里。
   */
  const at = (shown: boolean, x: number, y: number, dwelledMs = DOCK_WAKE_DWELL_MS) =>
    shouldShowDock({ shown, pointer: { x, y }, viewport: vp, edge: 'bottom', rect: SETTLED, dwelledMs })

  it('藏着时:composer 输入区 / 发送键上的每一点都不唤醒(报障那几点)', () => {
    expect(at(false, 552, 787)).toBe(false) // 输入区中心
    expect(at(false, 311, 787)).toBe(false) // 输入区左端
    expect(at(false, 794, 787)).toBe(false) // 输入区右端
    expect(at(false, 552, 797)).toBe(false) // 输入区底缘内 2px
    expect(at(false, 963, 785)).toBe(false) // 发送键中心
  })

  it('藏着时:唤醒区就是贴边那条窄带,一像素不多', () => {
    expect(at(false, 640, vp.h - 2)).toBe(true)
    expect(at(false, 640, vp.h - DOCK_WAKE_BAND)).toBe(true)
    expect(at(false, 640, vp.h - DOCK_WAKE_BAND - 1)).toBe(false)
    // 修前这一点是 true(它在停稳位 + pad 里),正是「范围太大」的字面样子。
    expect(withinDockHoldZone({ x: 640, y: 787 }, vp, 'bottom', SETTLED)).toBe(true)
  })

  it('出来之后:08-31 那 12 组手势一条不回退(留驻仍是 24 宽容)', () => {
    for (const dy of [0, 4, 8, 12, 16, 20, DOCK_HOLD_PAD]) {
      expect(at(true, 640, SETTLED.top - dy)).toBe(true)
    }
    expect(at(true, 640, SETTLED.top - DOCK_HOLD_PAD - 1)).toBe(false)
    expect(at(true, SETTLED.left - 10, 785)).toBe(true)
    expect(at(true, SETTLED.left - 30, 785)).toBe(false)
  })

  it('出来之后:本体到视口边那条死缝仍算留驻(08-29「一闪而逝」不回退)', () => {
    expect(at(true, 640, vp.h - 1)).toBe(true)
  })

  it('拿不到停稳位时,出来了也只剩窄带 —— 不编一个矩形出来', () => {
    const noRect = (y: number) =>
      shouldShowDock({ shown: true, pointer: { x: 640, y }, viewport: vp, edge: 'bottom' })
    expect(noRect(vp.h - 2)).toBe(true)
    expect(noRect(787)).toBe(false)
  })

  it('四条边各按自己那一维分岔', () => {
    const edges = [
      { edge: 'top' as const, wake: { x: 640, y: 2 }, inside: { x: 640, y: 60 } },
      { edge: 'left' as const, wake: { x: 2, y: 400 }, inside: { x: 60, y: 400 } },
      { edge: 'right' as const, wake: { x: vp.w - 2, y: 400 }, inside: { x: vp.w - 60, y: 400 } },
    ]
    for (const { edge, wake, inside } of edges) {
      const rect = { left: 0, right: vp.w, top: 0, bottom: vp.h }
      const dwelledMs = DOCK_WAKE_DWELL_MS
      expect(shouldShowDock({ shown: false, pointer: wake, viewport: vp, edge, dwelledMs })).toBe(true)
      expect(shouldShowDock({ shown: false, pointer: inside, viewport: vp, edge, dwelledMs })).toBe(false)
      // 同一点,出来之后被留驻区接住(这里的矩形铺满视口,只为证明分岔真的分了)。
      expect(shouldShowDock({ shown: true, pointer: inside, viewport: vp, edge, rect })).toBe(true)
    }
  })
})

/**
 * 09-03 报障:「dock 的出现太敏感」。
 *
 * 唤醒从「碰到」改成「停留」:进了窄带还不算数,要在带内**连续停满**
 * DOCK_WAKE_DWELL_MS 才唤醒。理由是窗口边不是墙 —— 去点系统 Dock / 去别的窗口 /
 * 拖窗口边都要穿过那 8px,穿一次唤醒一次(病历写在 transitions.ts 的文件头)。
 *
 * **反证纪律**:把 shouldShowDock 里 `&& (dwelledMs ?? 0) >= DOCK_WAKE_DWELL_MS`
 * 那半句删掉,下面「不够不出来」三条立刻红(已真跑过);真机那一半(出窗之后
 * 计时器还在跑)在纯函数里看不见,由 scripts/gate-dock-wake.mjs 的③与
 * components/__tests__/dock-autohide.test.tsx 钉着。
 */
describe('唤醒是停留不是碰到(09-03 报障:出现太敏感)', () => {
  const vp: Viewport = { w: 1280, h: 828 }
  const SETTLED = { left: 310.5, right: 969.5, top: 754, bottom: 816 }
  const wake = (dwelledMs?: number) =>
    shouldShowDock({
      shown: false,
      pointer: { x: 640, y: vp.h - 2 },
      viewport: vp,
      edge: 'bottom',
      rect: SETTLED,
      dwelledMs,
    })

  it('藏着 + 带内 + 停够 → 出来', () => {
    expect(wake(DOCK_WAKE_DWELL_MS)).toBe(true)
    expect(wake(DOCK_WAKE_DWELL_MS + 1000)).toBe(true)
  })

  it('藏着 + 带内 + 停不够 → 不出来(「穿过去」那一下就落在这里)', () => {
    expect(wake(DOCK_WAKE_DWELL_MS - 1)).toBe(false)
    // 自然速度 6px/帧 穿过 8px 的带 ≈ 1.3 帧 ≈ 22ms —— 差一个量级。
    expect(wake(22)).toBe(false)
    expect(wake(0)).toBe(false)
  })

  it('不喂时间 = 刚碰到 —— 纯函数不认识时钟,缺省不许退回旧行为', () => {
    expect(wake(undefined)).toBe(false)
  })

  it('停够也只在带内算数:输入区上停一整天照旧不唤醒', () => {
    const onComposer = shouldShowDock({
      shown: false,
      pointer: { x: 552, y: 787 },
      viewport: vp,
      edge: 'bottom',
      rect: SETTLED,
      dwelledMs: 10_000,
    })
    expect(onComposer).toBe(false)
  })

  it('已经出来之后**不看**停留 —— 它是入门的门槛,不是住下的条件', () => {
    const hold = (dwelledMs?: number) =>
      shouldShowDock({
        shown: true,
        pointer: { x: 640, y: SETTLED.top - 10 },
        viewport: vp,
        edge: 'bottom',
        rect: SETTLED,
        dwelledMs,
      })
    expect(hold(undefined)).toBe(true)
    expect(hold(0)).toBe(true)
    // 窄带那一支同理(留驻语义 08-31 那 12 组一条不回退)。
    expect(
      shouldShowDock({
        shown: true,
        pointer: { x: 640, y: vp.h - 1 },
        viewport: vp,
        edge: 'bottom',
        rect: SETTLED,
        dwelledMs: 0,
      }),
    ).toBe(true)
  })
})

/**
 * 两个语义的**两侧单产地对账**:JS 常量与 tokens.css 那两行必须逐字相同。
 * 读样式表源文本前先剥注释 —— 病历文本里写着这两个数,不剥就会自己把自己判绿
 * (仓规:「读样式表源文本的门先剥注释」)。
 */
describe('--dock-wake-band / --dock-hold-pad 与 JS 常量同源', () => {
  /* 从**应用根**拼路径(vitest 的 cwd 就是 apps/desktop-react)——
   * jsdom 环境里 `import.meta.url` 是个 http URL,readFileSync 吃不下
   * (同一条判例见 composer/components/composer-css.test.ts)。 */
  const css = readFileSync(resolve('src/styles/tokens.css'), 'utf-8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  )
  const read = (name: string) => {
    const hit = new RegExp(`${name}:\\s*([0-9.]+)px`).exec(css)
    if (!hit) throw new Error(`tokens.css 里没有 ${name}`)
    return Number(hit[1])
  }

  it('顶栏那条带两侧同一个数(W7-p 裁定 5:它是新窗锚点的参考系,见 centerRectOf)', () => {
    // 反证:把 `TOP_CHROME` 改回 0(第一版把顶栏留在「中央区」里)→ 这条当场红,
    // 而真机上的样子是新窗盖住标签条的右半截(`gate:drag` 场景①③)。
    expect(read('--topbar-h')).toBe(TOP_CHROME)
  })

  /**
   * **细梁那一格**(W7-p 修一轮裁定 7)。`SHELF_RAIL` 是「收起来的架子还占多厚」——
   * `shelfExtentOf` 拿它算预算、tokens.css 拿它画,两个数写在两处必然分叉,而
   * 修一轮的裁定 6 让它多了一个消费者(装不下时把架子收成细梁),分叉的代价从
   * 「差几个像素」变成「中央区还够不够 480×320」。
   *
   * 反证:把 `SHELF_RAIL` 改成 16 → 这一条当场红。
   */
  it('细梁两侧同一个数(W7-p 修一轮裁定 7:它是预算算式的一项)', () => {
    expect(read('--shelf-rail')).toBe(SHELF_RAIL)
  })

  it('唤醒窄带两侧同一个数', () => {
    expect(read('--dock-wake-band')).toBe(DOCK_WAKE_BAND)
  })

  it('留驻宽容两侧同一个数', () => {
    expect(read('--dock-hold-pad')).toBe(DOCK_HOLD_PAD)
  })

  it('唤醒必须比留驻克制 —— 反过来就是报障那一天', () => {
    expect(DOCK_WAKE_BAND).toBeLessThan(DOCK_HOLD_PAD)
  })

  /**
   * 停留门槛的两侧对账在 components/__tests__/motion-tokens.test.ts(ms 那张表的产地
   * 是 tokens.css,JS 侧唯一镜像是 components/motion.ts)。这里只钉它的**量级**:
   * 一次自然速度的穿越在带内只待 20–30ms,门槛必须比那大一个量级才拦得住。
   */
  it('停留门槛比一次穿越大一个量级', () => {
    expect(DOCK_WAKE_DWELL_MS).toBeGreaterThanOrEqual(100)
  })
})


describe('migrateStagePersisted v5 → v6(家具按工作区各持一份)', () => {
  /*
   * 这一组是**反证跑出来的**:第一版只有上面那些「翻译对不对」的用例,
   * 而它们经 `furniture()` 取件,取不到账时会退回读扁平层 —— 于是把 v6 那一段
   * 整段删掉,全部 183 条照样绿。守卫必须自己盯着「家具搬进账了没有」,
   * 不能靠一个宽容的取件口。
   */
  it('五格家具**折进默认空间那一格**,顶层不再留着它们', () => {
    const out = migrateStagePersisted(
      {
        placements: { files: { kind: 'edge', side: 'right' } },
        floats: { diff: { x: 1, y: 2, w: 3, h: 4 } },
        floatOrder: ['diff'],
        shelves: emptyShelves(),
        memory: { files: { kind: 'stage' } },
        dockEdge: 'left',
        locale: 'en',
      },
      5,
    ) as Record<string, unknown>

    const ledger = out.byWorkspace as Record<string, Record<string, unknown>>
    expect(Object.keys(ledger)).toEqual([DEFAULT_SPACE_ID])
    expect(ledger[DEFAULT_SPACE_ID].floatOrder).toEqual(['diff'])
    // 住处那一格随后被 v9 交给了拼贴台,所以它不在账里 —— 但**交接单上有**。
    expect(ledger[DEFAULT_SPACE_ID].placements).toBeUndefined()
    expect(
      handedFurniture(
        {
          placements: { files: { kind: 'edge', side: 'right' } },
          floats: { diff: { x: 1, y: 2, w: 3, h: 4 } },
          floatOrder: ['diff'],
          shelves: emptyShelves(),
          memory: { files: { kind: 'stage' } },
          dockEdge: 'left',
          locale: 'en',
        },
        5,
      ).placements,
    ).toEqual({ files: { kind: 'edge', side: 'right' } })
    // 五格都搬走了,顶层一格不留 —— 留着就是两份真相。
    for (const key of ['placements', 'floats', 'floatOrder', 'shelves', 'memory']) {
      expect(key in out).toBe(false)
    }
  })

  it('**偏好留在顶层**:Dock 那几格与语言不跟着空间走', () => {
    const out = migrateStagePersisted(
      { placements: {}, dockEdge: 'left', dockSize: 'lg', locale: 'en', hiddenItems: ['music'] },
      5,
    ) as Record<string, unknown>
    expect(out.dockEdge).toBe('left')
    expect(out.dockSize).toBe('lg')
    expect(out.locale).toBe('en')
    expect(out.hiddenItems).toEqual(['music'])
  })

  it('已经有账的档案不再折一次 —— 折叠幂等(存量实例的写盘会带着新版本号落旧值)', () => {
    // 账上那一格用**几何**(v9 不碰它),免得这一条被 v9 的摘除动作误伤 ——
    // 它守的是「已经有账的不许再折一次」,与住处搬家无关。
    const already = { byWorkspace: { 'ws-a': { floatOrder: [] } }, dockEdge: 'top' }
    const out = migrateStagePersisted(already, 5) as Record<string, unknown>
    /*
     * 09-02 起这一条断言的是**账本原样**而不是整份对象原样:v7 会给这份档案补上
     * Dock 放大那三格(它们在 v5 时还不存在),所以外层必然是个新对象。要守的那件事
     * 没变 —— 「已经有账的不许再折一次」,把账本按身份比就正好只守它:再折一次会
     * 造出一个新的 byWorkspace,并把 ws-a 折进默认空间里去。
     */
    expect(out.byWorkspace).toBe(already.byWorkspace)
    expect(out.dockEdge).toBe('top')
  })

  it('v0 的老档一路连到 v6:翻译的产物落在账里,零丢失', () => {
    const out = migrateStagePersisted({ pinnedId: 'diff', pinnedWidth: 420 }, 0) as Record<
      string,
      unknown
    >
    const ledger = out.byWorkspace as Record<string, Record<string, unknown>>
    const shelves = ledger[DEFAULT_SPACE_ID].shelves as Record<string, { thickness: number }>
    // 几何落在账里;tab 那一格走交接单(v9)。零丢失说的是两半都在。
    expect(shelves.right.thickness).toBe(420)
    expect(tabsOf(handedRegions({ pinnedId: 'diff', pinnedWidth: 420 }, 0)['edge:right'])).toEqual(['diff'])
  })
})

describe('migrateStagePersisted v9 → v10(「盖」的位置记忆迁成全屏)', () => {
  /*
   * W2 拍点 ②:`cover` 这一档退役,它想成为的东西就是真全屏。要迁的**只有位置
   * 记忆一格** —— `placements` 从 v9 起是树的投影(档案里根本没有它),而盖本来
   * 就是瞬态、从来不落盘。
   *
   * 两条路都要走:**扁平层**与 `byWorkspace` 里**每一个空间那一格**。只迁当前
   * 那一格的话,切到别的空间就会露出同一个病(与 v8 / v9 逐字同一条判据)。
   */
  const legacy = () => ({
    // 两条架子的几何(v10 一个字不碰它们 —— 这一条同时守「别的格别乱动」)。
    shelves: {
      ...emptyShelves(),
      right: { ...emptyShelves().right, thickness: 420 },
      left: { ...emptyShelves().left, collapsed: true },
    },
    memory: { apps: { kind: 'cover' }, files: { kind: 'edge', side: 'right', index: 1 } },
    byWorkspace: {
      'ws-b': {
        memory: { diff: { kind: 'cover' }, browser: { kind: 'stage' } },
        floatOrder: ['browser'],
      },
    },
    dockEdge: 'left',
  })

  it('扁平层与每个空间那一格**两处都成 full**,别的记忆一个字不动', () => {
    const out = migrateStagePersisted(legacy(), 9) as Record<string, unknown>
    const flat = out.memory as Record<string, unknown>
    expect(flat.apps).toEqual({ kind: 'full' })
    expect(flat.files).toEqual({ kind: 'edge', side: 'right', index: 1 })

    const ledger = out.byWorkspace as Record<string, Record<string, unknown>>
    const spaced = ledger['ws-b'].memory as Record<string, unknown>
    expect(spaced.diff).toEqual({ kind: 'full' })
    expect(spaced.browser).toEqual({ kind: 'stage' })
    expect(ledger['ws-b'].floatOrder).toEqual(['browser'])

    // 几何与偏好一格没动(这一段只翻记忆)。
    const shelves = out.shelves as Record<string, { thickness: number; collapsed: boolean }>
    expect(shelves.right.thickness).toBe(420)
    expect(shelves.left.collapsed).toBe(true)
    expect(out.dockEdge).toBe('left')
  })

  it('**幂等**:再迁一次交回同一个对象(引用恒等 —— 一格都没碰到)', () => {
    const once = migrateStagePersisted(legacy(), 9)
    // 已经是当前版本 → 原样放行(存量实例带着新版本号写盘的那条路)。
    expect(migrateStagePersisted(once, STAGE_PERSIST_VERSION)).toBe(once)
    /*
     * 直接对着**产物**再跑一遍 v10 那一段:一条 cover 都没有了,所以每一层都该
     * 交回同一个对象。这是「幂等」在这一族档案上的机器化判据(同 v8 / v9)。
     */
    const furniture = once as Record<string, unknown>
    expect(coverMemoryToFull(furniture)).toBe(furniture)
    const ledger = furniture.byWorkspace as Record<string, unknown>
    expect(coverMemoryToFull(ledger['ws-b'])).toBe(ledger['ws-b'])
  })

  it('**漏掉 byWorkspace 那一路即红**:反证靠的就是这一条', () => {
    const out = migrateStagePersisted(legacy(), 9) as Record<string, unknown>
    const ledger = out.byWorkspace as Record<string, Record<string, unknown>>
    const spaced = ledger['ws-b'].memory as Record<string, { kind: string }>
    // 摘掉迁移里那段 `byWorkspace` 循环 → 这里读到的仍是 'cover'。
    expect(spaced.diff.kind).toBe('full')
  })

  it('没有记忆表的档案原样交回(缺席不是错)', () => {
    const bare = { dockEdge: 'top' }
    expect(coverMemoryToFull(bare)).toBe(bare)
  })
})
