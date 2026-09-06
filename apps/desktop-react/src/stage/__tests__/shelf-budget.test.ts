import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { liveRegionText, resetLiveRegions } from '../../ui/a11y/live-region'
import { seedStage } from '../../test/stage-fixture'
import { useStageStore } from '../store'
import { useWorkbenchStore } from '../../workbench/store'
import {
  CENTER_MIN_H,
  CENTER_MIN_W,
  SHELF_RAIL,
  centerRectOf,
  initialStageState,
  reclampAll,
  shelfExtentOf,
} from '../transitions'
import { t } from '../../i18n'
import type { ShelfSide, ShelfState, StageState } from '../types'

/**
 * **架子与中央区分同一块地**(W7-p 裁定 3;修一轮裁定 3/6 补的两条)。
 *
 * 这一组守三件事,三件都在真机上发作过:
 *  ① **拒绝要说话** —— 摆不下时凡「往边上钉」的路都经 `store.land`,播报
 *    `stage.shelfNoRoom`。从前舞台檐 / 浮窗檐上的「钉到边」把 `placeAs` 的返回值
 *    丢了,于是那两条路上拒绝是**静默不动**:用户点了那一行,屏幕没变、读屏也没有
 *    一个字;
 *  ② **竖轴的预算先扣顶栏** —— 预算与 `centerRectOf` 必须是同一把尺;
 *  ③ **中央区最小身量优先于架子最小厚度** —— 预算装不下时那条架子收成细梁,
 *    而不是停在 240 把中央区挤没。
 */

const VP_SMALL = { w: 700, h: 500 }

function setViewport(w: number, h: number): void {
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: h, configurable: true })
}

/** 播报口里此刻那句话(`announce` 走一拍 `setTimeout`,所以要把它推完)。 */
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

describe('拒绝要说话 —— 唯一产地是 store.land(裁定 3)', () => {
  /**
   * 反证:把 `store.stageToEdge` / `floatToEdge` 那两句 `land(...)` 换回
   * 光秃秃的 `orchestrate(() => P.placeAs(…))` → 这两条当场红,而真机上的样子
   * 正是「点了菜单里那一行,什么都没发生」。
   */
  it('舞台檐上的「钉到边」摆不下时:形态不动,而且读屏听得到那一句', () => {
    setViewport(1024, 768)
    seedStage({
      placements: { files: { kind: 'stage' } },
      shelves: shelvesWith({ left: 400 }),
    })
    useStageStore.getState().stageToEdge('right')
    // 拒绝 = **一格状态都不写**:它还在舞台上,右架子还是空的。
    expect(useStageStore.getState().stageId).toBe('files')
    expect(useStageStore.getState().shelves.right.tabs).toEqual([])
    expect(liveText()).toBe(t('stage.shelfNoRoom', { side: t('drag.sideRight') }))
  })

  it('浮窗檐上的「钉到边」同一句话、同一个产地', () => {
    setViewport(1024, 768)
    seedStage({
      placements: { files: { kind: 'float' } },
      shelves: shelvesWith({ left: 400 }),
    })
    useStageStore.getState().floatToEdge('files', 'right')
    expect(useStageStore.getState().placements.files?.kind).toBe('float')
    expect(liveText()).toBe(t('stage.shelfNoRoom', { side: t('drag.sideRight') }))
  })

  it('摆得下的时候不说话 —— 播报只在拒绝那一格上', () => {
    seedStage({ placements: { files: { kind: 'stage' } } })
    useStageStore.getState().stageToEdge('right')
    expect(useStageStore.getState().shelves.right.tabs).toEqual(['files'])
    expect(liveText()).toBe('')
  })
})

describe('竖向预算与中央区读同一把尺(修一轮裁定 6)', () => {
  /**
   * 病历:860 高的窗上「上架子 300 + 下架子 240」被判为装得下
   * (860 − 320 − 300 = 240 ≥ 240),而屏幕上中央区实高只有
   * 860 − 44(顶栏)− 300 − 240 = 276 < 320。
   *
   * 反证:把 `shelfThicknessBudget` 里的 `usableExtent` 换回 `shelfViewportExtent`
   * → 这一条红(下架子会被钉上去)。
   */
  it('860 高的窗:钉了 300 的上架子之后,下架子钉不上(预算 196 < 240)', () => {
    setViewport(1280, 860)
    seedStage({ shelves: shelvesWith({ top: 300 }) })
    useStageStore.getState().openAs('files', { kind: 'edge', side: 'bottom' })
    expect(useStageStore.getState().shelves.bottom.tabs).toEqual([])
    expect(liveText()).toBe(t('stage.shelfNoRoom', { side: t('drag.sideBottom') }))
  })
})

describe('中央区最小身量优先:装不下就把架子收成细梁(修一轮裁定 6 的第二半)', () => {
  /**
   * 病历:两条对边都钉着再把窗缩到 700×500,`clampShelfThickness` 的下界 240
   * 永远赢 —— 真机量到中央区 220×216(裁定 3 立的 480×320 当场失效)。
   *
   * 反证:把 `reclampShelves` 里那格 `shelfFitsBudget → collapsed: true` 拆掉 →
   * 中央区那两条当场红(算出来是 220×216)。
   */
  it('三边钉上再缩到 700×500:中央区仍旧 ≥ 480×320,而让位的那条被收成细梁', () => {
    const state = {
      ...initialStageState,
      shelves: shelvesWith({ left: 400, right: 400, top: 400 }),
      // 钉边序:左 → 右 → 上,所以**后钉的先让**,上架子第一个被收。
      shelfNailOrder: ['left', 'right', 'top'] as ShelfSide[],
    } as StageState
    const next = reclampAll(state, VP_SMALL)
    const center = centerRectOf(next, VP_SMALL)
    expect(center.right - center.left).toBeGreaterThanOrEqual(CENTER_MIN_W)
    expect(center.bottom - center.top).toBeGreaterThanOrEqual(CENTER_MIN_H)
    // 让位的那条是**最后钉的**(上),而且它是被收成细梁、不是被删掉。
    expect(next.shelves.top.collapsed).toBe(true)
    expect(shelfExtentOf(next.shelves.top)).toBe(SHELF_RAIL)
    expect(next.shelves.top.tabs).toEqual(['top'])
  })

  it('宽敞的窗里一条都不收 —— 恒等变换,连对象都不换', () => {
    const state = {
      ...initialStageState,
      shelves: shelvesWith({ left: 300, top: 300 }),
      shelfNailOrder: ['left', 'top'] as ShelfSide[],
    } as StageState
    expect(reclampAll(state, { w: 1920, h: 1200 })).toBe(state)
  })
})
