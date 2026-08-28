import { describe, it, expect } from 'vitest'
import {
  FLOAT_DEFAULT_H,
  FLOAT_DEFAULT_W,
  FLOAT_KEEP,
  FLOAT_MIN_H,
  FLOAT_MIN_W,
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
  edgeToFloat,
  floatRectForGrab,
  floatToEdge,
  focusFloat,
  formIn,
  formOf,
  initialStageSettings,
  initialStageState,
  migrateStagePersisted,
  moveFloat,
  openAs,
  placementForOpen,
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
  withoutStagePlacements,
} from './transitions'
import { STAGE_ITEMS, findItem } from './items'
import type { OpenBehavior, Placement, ShelfSide, StageState, Viewport } from './types'

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

describe('resolveOpen / placementForOpen', () => {
  it("override 为 'default' → 跟随全局默认", () => {
    expect(resolveOpen('files', { files: 'default' }, 'stage')).toEqual(STAGE)
    expect(resolveOpen('files', { files: 'default' }, 'pinned')).toEqual(RIGHT)
  })

  it('没登记过的 id 等价于 default(所以初始表是空的)', () => {
    expect(resolveOpen('files', {}, 'pinned')).toEqual(RIGHT)
  })

  it("override 'stage' 压过默认 'pinned'", () => {
    expect(resolveOpen('files', { files: 'stage' }, 'pinned')).toEqual(STAGE)
  })

  it("override 'pinned' 压过默认 'stage'", () => {
    expect(resolveOpen('files', { files: 'pinned' }, 'stage')).toEqual(RIGHT)
  })

  it("override 'float' 压过默认 'stage'", () => {
    expect(resolveOpen('files', { files: 'float' }, 'stage')).toEqual(FLOAT)
  })

  it('覆盖只作用于自己那一个 id', () => {
    const o: Record<string, OpenBehavior> = { files: 'pinned' }
    expect(resolveOpen('diff', o, 'stage')).toEqual(STAGE)
  })

  it("'pinned' 这个历史值的语义就是 edge:right,翻译只此一处", () => {
    expect(placementForOpen('pinned')).toEqual({ kind: 'edge', side: 'right' })
    expect(placementForOpen('stage')).toEqual(STAGE)
    expect(placementForOpen('float')).toEqual(FLOAT)
  })

  it('检索面板是普通的一块瓦:参与 resolveOpen 全套', () => {
    expect(resolveOpen('search', {}, 'stage')).toEqual(STAGE)
    expect(resolveOpen('search', { search: 'float' }, 'stage')).toEqual(FLOAT)
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
    const next = clickDockIcon(base, 'files', RIGHT)
    expect(rightShelf(next).tabs).toEqual(['files'])
    expect(rightShelf(next).activeId).toBe('files')
    expect(stageIdOf(next)).toBeNull()
    expect(formOf(next, 'files')).toBe('edge')
  })

  it('连开两个 edge → 两个 tab 共存,次序即点击次序,活动的是后来的那个', () => {
    const next = clickDockIcon(clickDockIcon(base, 'files', RIGHT), 'diff', RIGHT)
    expect(rightShelf(next).tabs).toEqual(['files', 'diff'])
    expect(rightShelf(next).activeId).toBe('diff')
    expect(formOf(next, 'files')).toBe('edge')
  })

  it('落点 edge 时舞台开着也不动它:架子与舞台正交', () => {
    const state = openAs(base, 'terminal', STAGE)
    const next = clickDockIcon(state, 'files', RIGHT)
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
    const next = clickDockIcon(state, 'files', RIGHT)
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
    clickDockIcon(base, 'files', RIGHT)
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

    const onShelf = togglePlacement(base, 'search', RIGHT, VP)
    expect(formOf(togglePlacement(onShelf, 'search', RIGHT, VP), 'search')).toBe('dock')
    expect(rightShelf(togglePlacement(onShelf, 'search', RIGHT, VP)).tabs).toEqual([])

    const onFloat = togglePlacement(base, 'search', FLOAT, VP)
    expect(formOf(togglePlacement(onFloat, 'search', FLOAT, VP), 'search')).toBe('dock')
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
    const st = clickDockIcon(toggleShelfCollapsed(base, 'right'), 'files', RIGHT)
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
  it('会话总览是接管型(它只有一种打开法,所以不进 Placement)', () => {
    expect(findItem('sessions')?.takeover).toBe(true)
  })

  it('检索是普通瓦,不接管', () => {
    expect(findItem('search')?.takeover).toBeUndefined()
  })

  it('除了会话总览,其余都不是接管型', () => {
    const takeovers = STAGE_ITEMS.filter((i) => i.takeover).map((i) => i.id)
    expect(takeovers).toEqual(['sessions'])
  })
})
