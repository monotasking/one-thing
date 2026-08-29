import { describe, it, expect } from 'vitest'
import {
  FLOAT_DEFAULT_H,
  FLOAT_DEFAULT_W,
  FLOAT_KEEP,
  FLOAT_MIN_H,
  FLOAT_MIN_W,
  FALLBACK_VIEWPORT,
  SHELF_DEFAULT_THICKNESS,
  SHELF_MIN_THICKNESS,
  STAGE_PERSIST_VERSION,
  activateShelfTab,
  clamp,
  clampFloatRect,
  clampShelfThickness,
  clickDockIcon,
  closeStage,
  closeToDock,
  defaultFloatRect,
  defaultOpenMemory,
  edgeToFloat,
  floatRectForGrab,
  floatToEdge,
  focusFloat,
  formIn,
  formOf,
  initialStageSettings,
  initialStageState,
  memoryIsAt,
  memoryOf,
  migrateStagePersisted,
  moveFloat,
  openAs,
  openFromMemory,
  placementForOpen,
  closeShelf,
  placementOf,
  resizeFloat,
  resizeFrom,
  resolveOpen,
  setShelfThickness,
  shelfViewportExtent,
  shouldTearOff,
  snapSideAt,
  stageIdOf,
  stageToEdge,
  stageToFloat,
  tearOffDistance,
  thicknessFromPointer,
  togglePlacement,
  toggleShelfCollapsed,
  withinDockEdgeBand,
  withinDockHoldZone,
  withoutStagePlacements,
} from './transitions'
import { SESSIONS_ITEM_ID, STAGE_ITEMS, findItem } from './items'
import type { Placement, PlacementMemory, ShelfSide, StageState, Viewport } from './types'

const base: StageState = initialStageState

const STAGE: Placement = { kind: 'stage' }
const FLOAT: Placement = { kind: 'float' }
const RIGHT: Placement = { kind: 'edge', side: 'right' }
const DOCK: Placement = { kind: 'dock' }

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
  index: st.shelves[side].tabs.length,
})

/** 新浮窗那条记忆(矩形 = 这块视口下的默认身量)。 */
const M_FLOAT: PlacementMemory = { kind: 'float', rect: defaultFloatRect(VP) }

describe('resolveOpen(解析序:显式手势 > 记忆 > 全局默认档)', () => {
  /** 造一个「这块瓦有这么一条记忆」的态。 */
  const withMemory = (id: string, m: PlacementMemory): StageState => ({
    ...base,
    memory: { ...base.memory, [id]: m },
  })

  it('没有记忆 → 落到全局默认档', () => {
    expect(resolveOpen(base, 'files', 'stage', VP)).toEqual({ kind: 'stage' })
    expect(resolveOpen(base, 'files', 'pinned', VP)).toEqual({
      kind: 'edge',
      side: 'right',
      index: 0,
    })
    expect(resolveOpen(base, 'files', 'float', VP)).toEqual(M_FLOAT)
  })

  it('有记忆 → 记忆赢,全局默认档一句话说不上', () => {
    const st = withMemory('files', { kind: 'stage' })
    expect(resolveOpen(st, 'files', 'pinned', VP)).toEqual({ kind: 'stage' })

    const pinned = withMemory('files', { kind: 'edge', side: 'left', index: 2 })
    expect(resolveOpen(pinned, 'files', 'stage', VP)).toEqual({
      kind: 'edge',
      side: 'left',
      index: 2,
    })
  })

  it('记忆只作用于自己那一个 id —— 别的瓦照旧跟默认档', () => {
    const st = withMemory('files', { kind: 'float', rect: { x: 1, y: 2, w: 300, h: 400 } })
    expect(resolveOpen(st, 'diff', 'stage', VP)).toEqual({ kind: 'stage' })
  })

  it('第三层「显式手势」不经过这个函数:手势自己说得出落点,直接调 openAs', () => {
    // 记忆说钉左边,手势说上舞台 —— 手势赢,并且把记忆改写成舞台。
    const st = openAs(withMemory('files', { kind: 'edge', side: 'left', index: 0 }), 'files', STAGE)
    expect(formOf(st, 'files')).toBe('stage')
    expect(st.memory.files).toEqual({ kind: 'stage' })
  })

  it("'pinned' 这个历史值的语义就是 edge:right,翻译只此一处", () => {
    expect(placementForOpen('pinned')).toEqual({ kind: 'edge', side: 'right' })
    expect(placementForOpen('stage')).toEqual(STAGE)
    expect(placementForOpen('float')).toEqual(FLOAT)
  })

  it('默认档补成记忆时,缺的那两件事按「就当它没来过」补', () => {
    // 钉边:排到那条边现有的末尾,不是插到最前。
    const two = withShelf(['files', 'diff'])
    expect(defaultOpenMemory(two, 'pinned', VP)).toEqual({ kind: 'edge', side: 'right', index: 2 })
    // 浮窗:新窗默认身量。
    expect(defaultOpenMemory(base, 'float', VP)).toEqual(M_FLOAT)
  })

  it('检索面板是普通的一块瓦:参与 resolveOpen 全套', () => {
    expect(resolveOpen(base, 'search', 'stage', VP)).toEqual({ kind: 'stage' })
    expect(resolveOpen(withMemory('search', { kind: 'stage' }), 'search', 'pinned', VP)).toEqual({
      kind: 'stage',
    })
  })
})

describe('clickDockIcon', () => {
  it("从收拢态点一下(落点 stage)→ 上舞台", () => {
    expect(stageIdOf(clickDockIcon(base, 'files', STAGE))).toBe('files')
  })

  it('舞台上的同一个再点一下 → 关舞台', () => {
    const opened = clickDockIcon(base, 'files', STAGE)
    expect(stageIdOf(clickDockIcon(opened, 'files', STAGE))).toBeNull()
  })

  it('舞台一次只有一个:点另一个是直接替换,不排队', () => {
    const opened = clickDockIcon(base, 'files', STAGE)
    const next = clickDockIcon(opened, 'diff', STAGE)
    expect(stageIdOf(next)).toBe('diff')
    expect(formOf(next, 'files')).toBe('dock')
  })

  it('落点 edge → 追加成新 tab 并激活,不上舞台', () => {
    const next = clickDockIcon(base, 'files', atEnd(base))
    expect(rightShelf(next).tabs).toEqual(['files'])
    expect(rightShelf(next).activeId).toBe('files')
    expect(stageIdOf(next)).toBeNull()
    expect(formOf(next, 'files')).toBe('edge')
  })

  it('连开两个 edge → 两个 tab 共存,次序即点击次序,活动的是后来的那个', () => {
    const one = clickDockIcon(base, 'files', atEnd(base))
    const next = clickDockIcon(one, 'diff', atEnd(one))
    expect(rightShelf(next).tabs).toEqual(['files', 'diff'])
    expect(rightShelf(next).activeId).toBe('diff')
    expect(formOf(next, 'files')).toBe('edge')
  })

  it('落点 edge 时舞台开着也不动它:架子与舞台正交', () => {
    const state = openAs(base, 'terminal', STAGE)
    const next = clickDockIcon(state, 'files', atEnd(state))
    expect(stageIdOf(next)).toBe('terminal')
    expect(rightShelf(next).tabs).toEqual(['files'])
  })

  it('已钉且看得见(活动 tab + 栏展开)的再点 → 收起整栏,不开舞台也不重复追加', () => {
    const state = withShelf(['diff'])
    const next = clickDockIcon(state, 'diff', STAGE)
    expect(stageIdOf(next)).toBeNull()
    expect(rightShelf(next).tabs).toEqual(['diff'])
    expect(rightShelf(next).collapsed).toBe(true)
    expect(rightShelf(next).activeId).toBe('diff')
    // 收起不是「找到它」,所以不闪
    expect(next.flashPinned).toBe(state.flashPinned)
  })

  it('已钉但栏收着的再点 → 激活 + 展开 + 闪一下(看不见就等于"找它")', () => {
    const state = toggleShelfCollapsed(withShelf(['diff']), 'right')
    const next = clickDockIcon(state, 'diff', STAGE)
    expect(rightShelf(next).collapsed).toBe(false)
    expect(rightShelf(next).activeId).toBe('diff')
    expect(next.flashPinned).toBe(state.flashPinned + 1)
  })

  it('收 → 展 → 收:同一块瓦点三下走一个来回', () => {
    const a = clickDockIcon(withShelf(['diff']), 'diff', STAGE)
    expect(rightShelf(a).collapsed).toBe(true)
    const b = clickDockIcon(a, 'diff', STAGE)
    expect(rightShelf(b).collapsed).toBe(false)
    expect(b.flashPinned).toBe(1)
    const c = clickDockIcon(b, 'diff', STAGE)
    expect(rightShelf(c).collapsed).toBe(true)
    expect(c.flashPinned).toBe(1)
  })

  it('栏收着时点「非活动」的那个 → 切过去并展开', () => {
    const state = toggleShelfCollapsed(withShelf(['files', 'diff'], 'diff'), 'right')
    const next = clickDockIcon(state, 'files', STAGE)
    expect(rightShelf(next).activeId).toBe('files')
    expect(rightShelf(next).collapsed).toBe(false)
    expect(next.flashPinned).toBe(1)
  })

  it('点架子上「非活动」的那个 → 活动 tab 切过去(落点是什么都一样)', () => {
    const state = withShelf(['files', 'diff'], 'diff')
    const next = clickDockIcon(state, 'files', atEnd(state))
    expect(rightShelf(next).activeId).toBe('files')
    expect(rightShelf(next).tabs).toEqual(['files', 'diff'])
    expect(next.flashPinned).toBe(1)
  })

  it('闪烁是累加的:两次「找它」记两次', () => {
    const state = withShelf(['files', 'diff'], 'diff')
    const twice = clickDockIcon(clickDockIcon(state, 'files', STAGE), 'diff', STAGE)
    expect(twice.flashPinned).toBe(2)
  })

  it('钉住 A 时点 B 上舞台,两者共存', () => {
    const state = withShelf(['diff'])
    const next = clickDockIcon(state, 'files', STAGE)
    expect(stageIdOf(next)).toBe('files')
    expect(rightShelf(next).tabs).toEqual(['diff'])
    expect(next.flashPinned).toBe(0)
  })

  it('已是浮窗的再点 → 置顶它,不关也不新开第二扇', () => {
    let st = openAs(base, 'files', FLOAT, VP)
    st = openAs(st, 'diff', FLOAT, VP)
    const next = clickDockIcon(st, 'files', STAGE, VP)
    expect(next.floatOrder).toEqual(['diff', 'files'])
    expect(formOf(next, 'files')).toBe('float')
  })

  it('是纯函数:不改原对象', () => {
    const before = JSON.parse(JSON.stringify(base))
    clickDockIcon(base, 'files', atEnd(base))
    expect(base).toEqual(before)
  })
})

describe('togglePlacement(⌘P 那种开关语义)', () => {
  it('收着 → 按打开方式开(不问架子看不看得见)', () => {
    const next = togglePlacement(base, 'search', STAGE, VP)
    expect(stageIdOf(next)).toBe('search')
  })

  it('开着(任一形态)→ 再按一次收回 Dock', () => {
    const onStage = togglePlacement(base, 'search', STAGE, VP)
    expect(formOf(togglePlacement(onStage, 'search', STAGE, VP), 'search')).toBe('dock')

    const onShelf = togglePlacement(base, 'search', atEnd(base), VP)
    expect(formOf(togglePlacement(onShelf, 'search', atEnd(onShelf), VP), 'search')).toBe('dock')
    expect(rightShelf(togglePlacement(onShelf, 'search', atEnd(onShelf), VP)).tabs).toEqual([])

    const onFloat = togglePlacement(base, 'search', M_FLOAT, VP)
    expect(formOf(togglePlacement(onFloat, 'search', M_FLOAT, VP), 'search')).toBe('dock')
  })
})

describe('placements 是唯一事实源', () => {
  it('一个 id 只在一处:上舞台会把它从架子上摘走', () => {
    const st = openAs(withShelf(['files', 'diff'], 'files'), 'files', STAGE)
    expect(formOf(st, 'files')).toBe('stage')
    expect(rightShelf(st).tabs).toEqual(['diff'])
    expect(rightShelf(st).activeId).toBe('diff')
  })

  it('变浮窗会把它从架子上摘走,反过来也一样', () => {
    const floated = edgeToFloat(withShelf(['files']), 'files', VP)
    expect(floated.floatOrder).toEqual(['files'])
    expect(rightShelf(floated).tabs).toEqual([])

    const back = floatToEdge(floated, 'files', 'left')
    expect(back.floatOrder).toEqual([])
    expect(back.shelves.left.tabs).toEqual(['files'])
    expect(placementOf(back, 'files')).toEqual({ kind: 'edge', side: 'left' })
  })

  it('dock 是缺席态:收回 Dock 就是从表里消失,不留一条 {kind:dock}', () => {
    const st = closeToDock(openAs(base, 'files', STAGE), 'files')
    expect('files' in st.placements).toBe(false)
    expect(placementOf(st, 'files')).toEqual(DOCK)
  })

  it('舞台至多一个:第二个上台,第一个落回 dock', () => {
    const st = openAs(openAs(base, 'files', STAGE), 'diff', STAGE)
    expect(Object.values(st.placements).filter((p) => p.kind === 'stage')).toHaveLength(1)
    expect(stageIdOf(st)).toBe('diff')
  })

  it('四条边各有一份架子,互不干涉', () => {
    let st = openAs(base, 'files', { kind: 'edge', side: 'left' })
    st = openAs(st, 'diff', { kind: 'edge', side: 'bottom' })
    expect(st.shelves.left.tabs).toEqual(['files'])
    expect(st.shelves.bottom.tabs).toEqual(['diff'])
    expect(st.shelves.right.tabs).toEqual([])
    expect(st.shelves.top.tabs).toEqual([])
  })
})

describe('toggleShelfCollapsed', () => {
  it('收/展往返:两次回到原点,tab 次序与活动 tab 一个都不动', () => {
    const state = withShelf(['files', 'diff'], 'files')
    const collapsed = toggleShelfCollapsed(state, 'right')
    expect(rightShelf(collapsed).collapsed).toBe(true)
    expect(rightShelf(collapsed).tabs).toEqual(['files', 'diff'])
    expect(rightShelf(collapsed).activeId).toBe('files')

    const back = toggleShelfCollapsed(collapsed, 'right')
    expect(rightShelf(back).collapsed).toBe(false)
    expect(back).toEqual(state)
  })

  it('初始四条边都是展开的', () => {
    for (const side of ['left', 'right', 'top', 'bottom'] as ShelfSide[]) {
      expect(initialStageState.shelves[side].collapsed).toBe(false)
    }
  })

  it('收的是这一条边,不碰别的边', () => {
    const st = toggleShelfCollapsed(withShelf(['files']), 'right')
    expect(st.shelves.left.collapsed).toBe(false)
  })
})

describe('stageToEdge / stageToFloat', () => {
  it('把舞台落成新 tab 并激活,舞台清空', () => {
    const opened = clickDockIcon(base, 'files', STAGE)
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
    expect(next.floats.files).toEqual(defaultFloatRect(VP))
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
    const st = clickDockIcon(collapsed, 'files', atEnd(collapsed))
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
  it('开一扇:登记落点、进置顶序、给一个居中的默认矩形', () => {
    const st = openAs(base, 'files', FLOAT, VP)
    expect(formOf(st, 'files')).toBe('float')
    expect(st.floatOrder).toEqual(['files'])
    expect(st.floats.files).toEqual({
      w: FLOAT_DEFAULT_W,
      h: FLOAT_DEFAULT_H,
      x: (VP.w - FLOAT_DEFAULT_W) / 2,
      y: (VP.h - FLOAT_DEFAULT_H) / 2,
    })
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

  it('视口比默认身量还小:新窗取视口那么大', () => {
    const small: Viewport = { w: 500, h: 400 }
    expect(defaultFloatRect(small)).toEqual({ x: 0, y: 0, w: 500, h: 400 })
  })

  it('clampFloatRect 是纯算术,两处(拖拽预览与落库)共用同一把尺', () => {
    expect(clampFloatRect({ x: 10, y: 10, w: 900, h: 700 }, VP)).toEqual({
      x: 10,
      y: 10,
      w: 900,
      h: 700,
    })
  })
})

describe('migrateStagePersisted', () => {
  it('v0 的单值 pinnedId → 一路翻成 v3 的右架子 + placements', () => {
    const out = migrateStagePersisted({ pinnedId: 'diff', pinnedWidth: 500 }, 0) as Record<string, unknown>
    const shelves = out.shelves as Record<string, { tabs: string[]; thickness: number; activeId: string | null }>
    expect(shelves.right.tabs).toEqual(['diff'])
    expect(shelves.right.activeId).toBe('diff')
    expect(shelves.right.thickness).toBe(500)
    expect(out.placements).toEqual({ diff: { kind: 'edge', side: 'right' } })
    expect('pinnedId' in out).toBe(false)
    expect('pinned' in out).toBe(false)
    expect('pinnedWidth' in out).toBe(false)
  })

  it('v0 但没有 pinnedId(或是 null)→ 空架子,别的字段原样留着', () => {
    const out = migrateStagePersisted({ pinnedId: null, dockDisplay: 'autohide' }, 0) as Record<string, unknown>
    const shelves = out.shelves as Record<string, { tabs: string[]; activeId: string | null }>
    expect(shelves.right.tabs).toEqual([])
    expect(shelves.right.activeId).toBeNull()
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
    const shelves = out.shelves as Record<string, { tabs: string[]; collapsed: boolean }>
    expect(shelves.right.tabs).toEqual(['files'])
    expect(shelves.right.collapsed).toBe(false)
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
    const shelves = out.shelves as Record<
      string,
      { tabs: string[]; activeId: string | null; thickness: number; collapsed: boolean }
    >
    expect(shelves.right).toEqual({
      tabs: ['files', 'diff'],
      activeId: 'files',
      thickness: 520,
      collapsed: true,
    })
    expect(shelves.left.tabs).toEqual([])
    expect(out.placements).toEqual({
      files: { kind: 'edge', side: 'right' },
      diff: { kind: 'edge', side: 'right' },
    })
    expect(out.floats).toEqual({})
    expect(out.floatOrder).toEqual([])
    expect(out.dockEdge).toBe('left')
    expect('pinnedCollapsed' in out).toBe(false)
  })

  it('v2 档案里活动 tab 已不在名单上 → 退回最后一个,不留悬空 id', () => {
    const out = migrateStagePersisted({ pinned: ['files'], activePinnedId: 'gone' }, 2) as Record<
      string,
      unknown
    >
    const shelves = out.shelves as Record<string, { activeId: string | null }>
    expect(shelves.right.activeId).toBe('files')
  })

  it('v2 没有钉栏字段 → 四条空架子 + 默认厚度', () => {
    const out = migrateStagePersisted({ locale: 'zh' }, 2) as Record<string, unknown>
    const shelves = out.shelves as Record<string, { tabs: string[]; thickness: number }>
    expect(shelves.right.tabs).toEqual([])
    expect(shelves.right.thickness).toBe(SHELF_DEFAULT_THICKNESS)
    expect(out.locale).toBe('zh')
  })

  it('已经是当前版本的原样放行', () => {
    const current = { placements: {}, dockEdge: 'right' }
    expect(migrateStagePersisted(current, STAGE_PERSIST_VERSION)).toBe(current)
  })
})

describe('withoutStagePlacements(存盘前摘舞台)', () => {
  it('架子与浮窗留着,舞台那条不存', () => {
    let st = openAs(base, 'diff', RIGHT)
    st = openAs(st, 'browser', FLOAT, VP)
    st = openAs(st, 'files', STAGE)
    const saved = withoutStagePlacements(st.placements)
    expect('files' in saved).toBe(false)
    expect(saved.diff).toEqual(RIGHT)
    expect(saved.browser).toEqual(FLOAT)
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
    expect(rightShelf(setShelfThickness(base, 'right', 100, 1600)).thickness).toBe(
      SHELF_MIN_THICKNESS,
    )
    expect(rightShelf(setShelfThickness(base, 'right', 1400, 1600)).thickness).toBe(880)
  })

  it('改的是这一条边的厚度,别的边不动', () => {
    const st = setShelfThickness(base, 'left', 500, 1600)
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

describe('Dock 自动隐藏的边缘带(去元素化后就是一次距离判定)', () => {
  const VIEWPORT = { w: 1000, h: 800 }

  it('四条边各问各的那一维', () => {
    expect(withinDockEdgeBand({ x: 500, y: 795 }, VIEWPORT, 'bottom')).toBe(true)
    expect(withinDockEdgeBand({ x: 500, y: 3 }, VIEWPORT, 'top')).toBe(true)
    expect(withinDockEdgeBand({ x: 3, y: 400 }, VIEWPORT, 'left')).toBe(true)
    expect(withinDockEdgeBand({ x: 997, y: 400 }, VIEWPORT, 'right')).toBe(true)
  })

  it('8 进、9 出;停在别的边不算进这条边的带', () => {
    expect(withinDockEdgeBand({ x: 500, y: 792 }, VIEWPORT, 'bottom')).toBe(true)
    expect(withinDockEdgeBand({ x: 500, y: 791 }, VIEWPORT, 'bottom')).toBe(false)
    expect(withinDockEdgeBand({ x: 500, y: 3 }, VIEWPORT, 'bottom')).toBe(false)
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
    expect(resolveOpen(base, SESSIONS_ITEM_ID, 'float', VP)).toEqual(
      resolveOpen(base, 'search', 'float', VP),
    )
  })

  it('接管型已退役:一块瓦都不许再带 takeover 字段', () => {
    expect(STAGE_ITEMS.filter((i) => 'takeover' in i)).toEqual([])
  })
})

describe('closeShelf(整栏关闭)', () => {
  it('这条边上的 tab 全部收回 Dock,别的边不动', () => {
    let st = initialStageState
    st = clickDockIcon(st, 'diff', atEnd(st))
    st = clickDockIcon(st, 'terminal', atEnd(st))
    st = clickDockIcon(st, 'files', atEnd(st, 'left'))
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

  it('矩形四周 pad 内算留驻,远处不算', () => {
    expect(withinDockHoldZone({ x: 925, y: 400 }, vp, 'right', rect)).toBe(true)
    expect(withinDockHoldZone({ x: 900, y: 400 }, vp, 'right', rect)).toBe(false)
    expect(withinDockHoldZone({ x: 960, y: 290 }, vp, 'right', rect)).toBe(false)
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
    expect(st.shelves.right.tabs.filter((x) => x === 'diff')).toHaveLength(1)
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

  it('点 Dock 图标走的就是这条路:无记忆 → 默认档;有记忆 → 记忆', () => {
    const remembered: StageState = {
      ...base,
      memory: { files: { kind: 'edge', side: 'left', index: 0 } },
    }
    expect(
      formOf(clickDockIcon(base, 'files', resolveOpen(base, 'files', 'stage', VP), VP), 'files'),
    ).toBe('stage')
    const next = clickDockIcon(
      remembered,
      'files',
      resolveOpen(remembered, 'files', 'stage', VP),
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

  it('三种配置各一条:用户配过的一条不丢', () => {
    const out = migrateStagePersisted(
      v3({ browser: 'stage', diff: 'float', terminal: 'pinned' }),
      3,
    ) as Record<string, unknown>
    const memory = out.memory as Record<string, PlacementMemory>
    expect(memory.browser).toEqual({ kind: 'stage' })
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
    expect(out.memory).toEqual({})
  })

  it("配了 'float' 但老档没存过矩形 → 给新窗的默认身量", () => {
    const out = migrateStagePersisted(v3({ browser: 'float' }), 3) as Record<string, unknown>
    const memory = out.memory as Record<string, PlacementMemory>
    expect(memory.browser).toEqual({ kind: 'float', rect: defaultFloatRect(FALLBACK_VIEWPORT) })
  })

  it("配了 'pinned' 但当时不在右架子上 → 排到末尾", () => {
    const out = migrateStagePersisted(v3({ browser: 'pinned' }), 3) as Record<string, unknown>
    const memory = out.memory as Record<string, PlacementMemory>
    expect(memory.browser).toEqual({ kind: 'edge', side: 'right', index: 2 })
  })

  it('openOverrides 这个键本身退役,活 placements / floats / shelves 照旧恢复', () => {
    const out = migrateStagePersisted(v3({ browser: 'stage' }), 3) as Record<string, unknown>
    expect('openOverrides' in out).toBe(false)
    expect(out.floats).toEqual({ diff: { x: 10, y: 20, w: 400, h: 300 } })
    expect((out.shelves as Record<string, { tabs: string[] }>).right.tabs).toEqual([
      'files',
      'terminal',
    ])
  })

  it('老档根本没有 openOverrides → 空记忆表,别的字段原样留着', () => {
    const out = migrateStagePersisted({ locale: 'en', floats: {}, shelves: emptyShelvesLike() }, 3) as Record<
      string,
      unknown
    >
    expect(out.memory).toEqual({})
    expect(out.locale).toBe('en')
  })

  it('v0 的老档一路连过四段也到得了 v4', () => {
    const out = migrateStagePersisted(
      { pinnedId: 'diff', pinnedWidth: 500, openOverrides: { files: 'stage' } },
      0,
    ) as Record<string, unknown>
    expect((out.memory as Record<string, PlacementMemory>).files).toEqual({ kind: 'stage' })
    expect((out.shelves as Record<string, { tabs: string[] }>).right.tabs).toEqual(['diff'])
  })
})
