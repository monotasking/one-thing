import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { liveRegionText, resetLiveRegions } from '../../ui/a11y/live-region'
import { seedStage } from '../../test/stage-fixture'
import { useStageStore } from '../store'
import { useWorkbenchStore } from '../../workbench/store'
import { nextFloatId } from '../placement'
import { edgeRegion, floatRegion } from '../../workbench/regions'
import { refId } from '../../workbench/kinds'
import { leavesOf } from '../../workbench/tree'
import { initialStageState } from '../transitions'
import { t } from '../../i18n'
import type { ContentRef } from '../../workbench/kinds'
import type { ShelfSide, ShelfState } from '../types'

/**
 * **整扇浮窗塌进一条边**(`store.floatWindowToEdge` → `placement.placeFloatIn`,
 * 2026-09-14)。
 *
 * ── 病历 ──────────────────────────────────────────────────────────────────
 * 用户报「浏览器无法拖拽到四处的架子上,拖过去又回到原位」。拖窗那条路的落定
 * 从前调 `floatToEdge(窗号, side)`,而那一只说的是**瓦**的话:先问
 * `placementOf(state, id).kind === 'float'`,`placements` 只按瓦 id 记,窗号
 * `win-…` 查无此人 → 当场 `return` → 一格都没写 → 窗滑回 `stored`。瓦撕出来的窗
 * 窗号就是瓦 id,所以只有它们钉得上去。
 *
 * 反证:把 `FloatWindow` 拖窗 `end` 里那句 `floatWindowToEdge(id, landing)` 换回
 * `floatToEdge(id, landing)` → 下面「非瓦」那几条当场红(树一字不动)。
 * 把 `placeFloatIn` 开头那句 `canNailShelf` 挖掉 → 「预算」那条红(文件被钉进了
 * 摆不下的那条边)。
 */

const fileRef = (path: string): ContentRef => ({ kind: 'file', key: path })

function setViewport(w: number, h: number): void {
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: h, configurable: true })
}

function liveText(): string {
  vi.advanceTimersByTime(50)
  return liveRegionText('polite').trim()
}

function shelvesWith(nailed: Partial<Record<ShelfSide, number>>): Record<ShelfSide, ShelfState> {
  const out = { ...initialStageState.shelves }
  for (const [side, thickness] of Object.entries(nailed) as [ShelfSide, number][]) {
    out[side] = { ...out[side], thickness, tabs: [side], activeId: side, collapsed: false }
  }
  return out
}

/** 铸一扇装着这些 ref 的窗(第一格活动),答窗号。 */
function openFloatWith(refs: ContentRef[]): string {
  const win = nextFloatId()
  const stage = useStageStore.getState()
  for (const [i, ref] of refs.entries()) {
    stage.placeRef(ref, floatRegion(win), {
      rect: { x: 300, y: 200, w: 600, h: 400 },
      activate: i === 0,
    })
  }
  return win
}

const tabIdsOf = (region: string): string[] => {
  const tree = useWorkbenchStore.getState().regions[region]
  return tree ? leavesOf(tree).flatMap((leaf) => leaf.tabs.map(refId)) : []
}

const activeIdOf = (region: string): string | null => {
  const tree = useWorkbenchStore.getState().regions[region]
  const leaf = tree ? leavesOf(tree)[0] : undefined
  return leaf ? refId(leaf.tabs[leaf.active]) : null
}

beforeEach(() => {
  vi.useFakeTimers()
  resetLiveRegions()
  useWorkbenchStore.getState().reset()
  useStageStore.setState({ ...initialStageState, locale: 'zh' })
  setViewport(1600, 1100)
})

afterEach(() => {
  vi.useRealTimers()
  setViewport(1024, 768)
})

describe('非瓦的窗(窗号是 win-…)钉到边', () => {
  it('一扇装着文件的窗钉到右边:文件进右架子、架子展开、这扇窗没了', () => {
    const win = openFloatWith([fileRef('/a.md')])
    expect(tabIdsOf(floatRegion(win))).toEqual(['file:/a.md'])
    useStageStore.getState().floatWindowToEdge(win, 'right')
    expect(tabIdsOf(edgeRegion('right'))).toEqual(['file:/a.md'])
    expect(useWorkbenchStore.getState().regions[floatRegion(win)]).toBeUndefined()
    expect(useStageStore.getState().shelves.right.collapsed).toBe(false)
    // 窗号的那格矩形随窗一起退役(下一次撕出来是新号,没人会再读它)。
    expect(win in useStageStore.getState().floats).toBe(false)
    expect(useStageStore.getState().floatOrder).toEqual([])
  })

  it('三条边各钉一次,每条边都接得住', () => {
    for (const side of ['left', 'right', 'bottom'] as ShelfSide[]) {
      const win = openFloatWith([fileRef(`/${side}.md`)])
      useStageStore.getState().floatWindowToEdge(win, side)
      expect(tabIdsOf(edgeRegion(side))).toEqual([`file:/${side}.md`])
    }
  })

  it('窗里几格标签一起搬,次序逐字相同,活动的那一格还是活动的', () => {
    const win = openFloatWith([fileRef('/a.md'), fileRef('/b.md'), fileRef('/c.md')])
    // 把中间那格点成活动的,好证明「搬完点回来」不是「最后一格恒活动」。
    const tree = useWorkbenchStore.getState().regions[floatRegion(win)]!
    useWorkbenchStore.getState().activateTab(leavesOf(tree)[0].id, 1)
    expect(activeIdOf(floatRegion(win))).toBe('file:/b.md')
    useStageStore.getState().floatWindowToEdge(win, 'left')
    expect(tabIdsOf(edgeRegion('left'))).toEqual(['file:/a.md', 'file:/b.md', 'file:/c.md'])
    expect(activeIdOf(edgeRegion('left'))).toBe('file:/b.md')
  })

  it('钉进一条已经有东西的架子:排在既有标签之后', () => {
    seedStage({ shelves: shelvesWith({ right: 400 }) })
    const win = openFloatWith([fileRef('/a.md')])
    useStageStore.getState().floatWindowToEdge(win, 'right')
    expect(tabIdsOf(edgeRegion('right'))).toEqual(['panel:right', 'file:/a.md'])
  })

  it('瓦与文件混在一扇窗里:两格都进架子,瓦的记忆也跟着落成 edge', () => {
    seedStage({ placements: { files: { kind: 'float' } } })
    useStageStore.getState().placeRef(fileRef('/a.md'), floatRegion('files'), { activate: false })
    expect(tabIdsOf(floatRegion('files'))).toEqual(['panel:files', 'file:/a.md'])
    useStageStore.getState().floatWindowToEdge('files', 'right')
    expect(tabIdsOf(edgeRegion('right'))).toEqual(['panel:files', 'file:/a.md'])
    expect(useStageStore.getState().placements.files).toEqual({ kind: 'edge', side: 'right' })
    expect(useStageStore.getState().memory.files?.kind).toBe('edge')
    // 瓦的窗号就是瓦 id,那格矩形是 `edgeToFloat` 的记忆,留着。
    expect('files' in useStageStore.getState().floats).toBe(true)
  })

  it('摆不下就整个拒绝:树一字不动,而且读屏听得到那一句', () => {
    setViewport(1024, 768)
    seedStage({ shelves: shelvesWith({ left: 400 }) })
    const win = openFloatWith([fileRef('/a.md')])
    useStageStore.getState().floatWindowToEdge(win, 'right')
    expect(tabIdsOf(floatRegion(win))).toEqual(['file:/a.md'])
    expect(tabIdsOf(edgeRegion('right'))).toEqual([])
    expect(liveText()).toBe(t('stage.shelfNoRoom', { side: t('drag.sideRight') }))
  })

  it('不存在的窗号是空动作', () => {
    const before = useWorkbenchStore.getState().regions
    useStageStore.getState().floatWindowToEdge('win-nope-1', 'right')
    expect(useWorkbenchStore.getState().regions).toBe(before)
  })
})

describe('瓦撕出来的窗(窗号 = 瓦 id)走的仍是瓦那条老路', () => {
  it('与 floatToEdge 逐字同一个结果:placements / memory / 架子展开', () => {
    seedStage({ placements: { files: { kind: 'float' } } })
    useStageStore.getState().floatWindowToEdge('files', 'left')
    const st = useStageStore.getState()
    expect(st.placements.files).toEqual({ kind: 'edge', side: 'left' })
    expect(st.shelves.left.tabs).toEqual(['files'])
    expect(st.shelves.left.collapsed).toBe(false)
    expect(st.memory.files).toEqual({ kind: 'edge', side: 'left', index: 0 })
  })
})

/**
 * **反向:整条架子弹成一扇窗**(`store.shelfToFloat` → `placement.placeShelfInFloat`)。
 * 同一个病:架子檐菜单「弹出 X 为浮窗」从前调 `edgeToFloat(根叶活动格的瓦 id)`,
 * 装着浏览器 / 文件的架子那一行整个灰着。
 * 反证:把 `EdgeShelf` 那一行换回 `activeItemId && edgeToFloat(activeItemId)` +
 * `disabled` → `edge-shelf.test` 的「文件架子」那条红。
 */
describe('整条架子弹成一扇窗', () => {
  it('只装着文件的架子:铸一个窗号,文件进那扇窗,架子没了', () => {
    const stage = useStageStore.getState()
    stage.placeRef(fileRef('/a.md'), edgeRegion('right'))
    stage.placeRef(fileRef('/b.md'), edgeRegion('right'), { activate: false })
    expect(activeIdOf(edgeRegion('right'))).toBe('file:/a.md')
    useStageStore.getState().shelfToFloat('right')
    const st = useStageStore.getState()
    expect(st.floatOrder).toHaveLength(1)
    const win = st.floatOrder[0]
    expect(win.startsWith('win-')).toBe(true)
    expect(tabIdsOf(floatRegion(win))).toEqual(['file:/a.md', 'file:/b.md'])
    expect(activeIdOf(floatRegion(win))).toBe('file:/a.md')
    expect(st.floats[win]).toBeTruthy()
    expect(useWorkbenchStore.getState().regions[edgeRegion('right')]).toBeUndefined()
  })

  it('瓦 + 文件的架子:窗号就是瓦 id,两格同一扇窗,瓦走老路(placements / memory 都是 float)', () => {
    seedStage({ shelves: shelvesWith({ right: 400 }) })
    useStageStore.getState().placeRef(fileRef('/a.md'), edgeRegion('right'), { activate: false })
    expect(tabIdsOf(edgeRegion('right'))).toEqual(['panel:right', 'file:/a.md'])
    useStageStore.getState().shelfToFloat('right')
    const st = useStageStore.getState()
    expect(st.floatOrder).toEqual(['right'])
    expect(tabIdsOf(floatRegion('right'))).toEqual(['panel:right', 'file:/a.md'])
    expect(activeIdOf(floatRegion('right'))).toBe('panel:right')
    expect(st.placements.right).toEqual({ kind: 'float' })
    expect(st.memory.right?.kind).toBe('float')
    expect(useWorkbenchStore.getState().regions[edgeRegion('right')]).toBeUndefined()
  })

  it('空着的边是空动作', () => {
    const before = useWorkbenchStore.getState().regions
    useStageStore.getState().shelfToFloat('bottom')
    expect(useWorkbenchStore.getState().regions).toBe(before)
  })
})
