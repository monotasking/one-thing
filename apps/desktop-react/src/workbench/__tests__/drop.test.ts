import { describe, expect, it } from 'vitest'
import {
  DROP_CENTER_INSET,
  dropTargetAt,
  edgeRectOf,
  targetRectOf,
  zoneAt,
  zoneRectOf,
  ZONE_SPLIT,
} from '../drop'
import type { DropGeometry, DropTarget } from '../drop'

/**
 * **落点判据的表驱动守卫**(W3,派工令交付 2)。
 *
 * 这只文件里一个 DOM、一个 store、一个 React 都没有 —— 判据本来就该这样测:
 * 「指针在这儿、屏幕上有这几块矩形,松手会发生什么」是一句纯粹的算术。
 *
 * 边界四条(派工令点名的):指针**正好压在 25% 那条线上**、叶**重叠时取最上**、
 * **窗口边带优先于叶四带**、拒绝那一档。
 */

/** 一块 1000×800 的窗口,中间摆一片 900×700 的叶(四周各留 50 —— 出了边带)。 */
const WINDOW = { left: 0, top: 0, width: 1000, height: 800 }
const LEAF = { left: 50, top: 50, width: 900, height: 700 }

const geometry: DropGeometry = {
  window: WINDOW,
  leaves: [{ region: 'center', leafId: 'leaf-a', rect: LEAF }],
}

/** 叶的中心那一点。 */
const center = { x: LEAF.left + LEAF.width / 2, y: LEAF.top + LEAF.height / 2 }

describe('zoneAt —— 五区', () => {
  it('中心区 = 内缩 25% 的矩形', () => {
    expect(zoneAt(center, LEAF)).toBe('center')
  })

  /*
   * **判据得有一头是闭的**,否则 25% 那条线上的那一像素谁都不认领。
   * 这一条钉的就是那句裁定:线上算中心。
   */
  it('指针正好压在 25% 那条线上 = 中心(闭区间)', () => {
    const onLine = { x: LEAF.left + LEAF.width * DROP_CENTER_INSET, y: center.y }
    expect(zoneAt(onLine, LEAF)).toBe('center')
    // 往外挪一个像素就出去了 —— 边界不是「附近」,是一条线。
    expect(zoneAt({ x: onLine.x - 1, y: center.y }, LEAF)).toBe('w')
  })

  it('四带各在各的一侧', () => {
    expect(zoneAt({ x: LEAF.left + 5, y: center.y }, LEAF)).toBe('w')
    expect(zoneAt({ x: LEAF.left + LEAF.width - 5, y: center.y }, LEAF)).toBe('e')
    expect(zoneAt({ x: center.x, y: LEAF.top + 5 }, LEAF)).toBe('n')
    expect(zoneAt({ x: center.x, y: LEAF.top + LEAF.height - 5 }, LEAF)).toBe('s')
  })

  /* 角上平手时优先左右 —— 与 `snapSideAt` 那条判例同向(竖着切是主力形态)。 */
  it('角落平手优先左右', () => {
    expect(zoneAt({ x: LEAF.left, y: LEAF.top }, LEAF)).toBe('w')
  })
})

describe('dropTargetAt —— 四问按序', () => {
  it('落在叶中心 = 并入这片叶', () => {
    expect(dropTargetAt(center, geometry)).toEqual({
      kind: 'leaf',
      region: 'center',
      leafId: 'leaf-a',
      zone: 'center',
    })
  })

  it('落在叶东带 = 往那一侧切一刀', () => {
    const target = dropTargetAt({ x: LEAF.left + LEAF.width - 5, y: center.y }, geometry)
    expect(target).toMatchObject({ kind: 'leaf', zone: 'e' })
    expect(ZONE_SPLIT.e).toEqual({ dir: 'row', before: false })
  })

  /*
   * **窗口边带优先于叶的四带**(文件头那条「次序即语义」)。这里让叶一直铺到
   * 窗口右缘,于是右缘那 24px 同时落在两者里 —— 答案必须是边带。
   */
  it('窗口边带优先于叶四带', () => {
    const flush: DropGeometry = {
      window: WINDOW,
      leaves: [{ region: 'center', leafId: 'leaf-a', rect: { left: 0, top: 0, width: 1000, height: 800 } }],
    }
    expect(dropTargetAt({ x: 995, y: 400 }, flush)).toEqual({ kind: 'edge', side: 'right' })
  })

  it('叶重叠时取最上(= 交进来的最后一片)', () => {
    const stacked: DropGeometry = {
      window: WINDOW,
      leaves: [
        { region: 'center', leafId: 'below', rect: LEAF },
        { region: 'float:win-1', leafId: 'above', rect: { left: 300, top: 300, width: 200, height: 200 } },
      ],
    }
    expect(dropTargetAt({ x: 400, y: 400 }, stacked)).toMatchObject({
      kind: 'leaf',
      leafId: 'above',
      region: 'float:win-1',
    })
  })

  it('什么都没碰到 = 撕成浮窗', () => {
    const empty: DropGeometry = { window: WINDOW, leaves: [] }
    expect(dropTargetAt({ x: 500, y: 400 }, empty)).toEqual({ kind: 'float' })
  })

  /* 会话行走的正是这一档:落中央收、别处一律一句 key(裁定 7)。 */
  it('accepts 说不收 = 结构化拒绝,带得出理由', () => {
    const rules = {
      accepts: (t: DropTarget) =>
        t.kind === 'leaf' && t.region === 'center' ? null : ('drag.sessionOnlyCenter' as const),
    }
    expect(dropTargetAt(center, geometry, rules)).toMatchObject({ kind: 'leaf' })
    const outside: DropGeometry = { window: WINDOW, leaves: [] }
    expect(dropTargetAt({ x: 500, y: 400 }, outside, rules)).toEqual({
      kind: 'refuse',
      reasonKey: 'drag.sessionOnlyCenter',
    })
  })

  /* `split: false` = 整片叶都是中心区(会话切一刀出来放什么都没有)。 */
  it('split: false 时四带不开', () => {
    const east = { x: LEAF.left + LEAF.width - 5, y: center.y }
    expect(dropTargetAt(east, geometry, { split: false })).toMatchObject({ zone: 'center' })
  })
})

describe('高亮画的就是判据用的那块矩形', () => {
  it('四带各切一半', () => {
    expect(zoneRectOf(LEAF, 'e')).toEqual({ left: 500, top: 50, width: 450, height: 700 })
    expect(zoneRectOf(LEAF, 'n')).toEqual({ left: 50, top: 50, width: 900, height: 350 })
    expect(zoneRectOf(LEAF, 'center')).toEqual(LEAF)
  })

  it('边带贴着窗口那一侧', () => {
    expect(edgeRectOf(WINDOW, 'right', 24)).toEqual({ left: 976, top: 0, width: 24, height: 800 })
  })

  /*
   * **同一块矩形**:`targetRectOf` 交出来的必须与判据自己算的一样 —— 这是
   * 「高亮说的和松手做的是一件事」那句话的机器化。
   */
  it('targetRectOf 与判据同源', () => {
    const target = dropTargetAt({ x: LEAF.left + LEAF.width - 5, y: center.y }, geometry)
    expect(targetRectOf(target, geometry)).toEqual(zoneRectOf(LEAF, 'e'))
  })

  it('撕浮窗答不出矩形(那块由宿主问形态机)', () => {
    expect(targetRectOf({ kind: 'float' }, geometry)).toBeNull()
  })
})
