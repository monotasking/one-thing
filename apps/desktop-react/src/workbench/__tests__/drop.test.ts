import { describe, expect, it } from 'vitest'
import {
  DROP_BAR_PX,
  DROP_EDGE_PX,
  dropTargetAt,
  edgeRectOf,
  stripIndexAt,
  targetRectOf,
  zoneAt,
  zoneRectOf,
  ZONE_SPLIT,
} from '../drop'
import type { DropGeometry, DropTarget, StripBox } from '../drop'

/**
 * **落点判据的表驱动守卫**(W3 交付 2;W3-b 改甲「浏览器式」后重写)。
 *
 * 这只文件里一个 DOM、一个 store、一个 React 都没有 —— 判据本来就该这样测:
 * 「指针在这儿、屏幕上有这几块矩形,松手会发生什么」是一句纯粹的算术。
 *
 * W3-b 换掉的是**哪一边是「其余」**:W3 时中心区内缩 25%、其余全是分屏;甲把它
 * 倒过来 —— 整个叶身都是并入,只有贴边那 `DROP_EDGE_PX` 16 是分屏。边界四条
 * (线上归谁、叶重叠取最上、窗口边带优先、拒绝那一档)照旧,外加两条新的:
 * **标签条优先于一切**、**插到第几格**。
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

/** 一条标签条:贴在叶的顶上,三格各 120 宽。 */
const STRIP: StripBox = {
  leafId: 'leaf-a',
  rect: { left: LEAF.left, top: LEAF.top, width: LEAF.width, height: 34 },
  tabs: [
    { left: 50, top: 50, width: 120, height: 34 },
    { left: 170, top: 50, width: 120, height: 34 },
    { left: 290, top: 50, width: 120, height: 34 },
  ],
}

describe('zoneAt —— 叶身是并入,只有贴边 16px 分屏(W3-b 裁定 6)', () => {
  it('叶身随便哪儿都是并入', () => {
    expect(zoneAt(center, LEAF)).toBe('center')
    // W3 时这一点(离左缘 1/5 宽)是「西带」,今天是叶身。
    expect(zoneAt({ x: LEAF.left + LEAF.width * 0.2, y: center.y }, LEAF)).toBe('center')
  })

  /*
   * **判据得有一头是闭的**,否则 16px 那条线上的那一像素谁都不认领。
   * 这一条钉的就是那句裁定:线上算叶身。
   */
  it('指针正好压在 16px 那条线上 = 叶身(闭区间)', () => {
    expect(zoneAt({ x: LEAF.left + DROP_EDGE_PX, y: center.y }, LEAF)).toBe('center')
    // 往外挪一个像素就进带了 —— 边界不是「附近」,是一条线。
    expect(zoneAt({ x: LEAF.left + DROP_EDGE_PX - 1, y: center.y }, LEAF)).toBe('w')
  })

  it('四条边带各在各的一侧', () => {
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

describe('dropTargetAt —— 五问按序', () => {
  it('落在叶身 = 并入这片叶', () => {
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

  /* `split: false` = 整片叶都是叶身(会话切一刀出来放什么都没有)。 */
  it('split: false 时四带不开', () => {
    const east = { x: LEAF.left + LEAF.width - 5, y: center.y }
    expect(dropTargetAt(east, geometry, { split: false })).toMatchObject({ zone: 'center' })
  })
})

describe('标签条(W3-b 裁定 6)', () => {
  const withStrip: DropGeometry = { ...geometry, strips: [STRIP] }

  it('落在条上 = 插到某一格,而不是并入那片叶', () => {
    // 第一格与第二格之间(x = 170 恰是第二格左缘,第一格中线 110 已越过)。
    expect(dropTargetAt({ x: 175, y: 60 }, withStrip)).toEqual({
      kind: 'strip',
      leafId: 'leaf-a',
      at: 1,
    })
  })

  /*
   * **条优先于一切**:条压在叶的北带(16px)里,也压在叶身里。反过来判的话条
   * 永远吸不到东西 —— 那正是「换序做不到」的第二种写法。
   */
  it('条优先于叶的北带与叶身', () => {
    expect(dropTargetAt({ x: 175, y: LEAF.top + 2 }, withStrip)).toMatchObject({ kind: 'strip' })
    expect(dropTargetAt({ x: 175, y: LEAF.top + 30 }, withStrip)).toMatchObject({ kind: 'strip' })
  })

  /* 带 = 条的上下各外扩 24(`TEAR_OFF_DISTANCE`,与条内换序同一个口径)。 */
  it('带的上下各外扩 24,出了就归叶', () => {
    expect(dropTargetAt({ x: 175, y: LEAF.top + 34 + 20 }, withStrip)).toMatchObject({ kind: 'strip' })
    expect(dropTargetAt({ x: 175, y: LEAF.top + 34 + 30 }, withStrip)).toMatchObject({ kind: 'leaf' })
  })

  it('横向不外扩:条右边之外归叶', () => {
    expect(dropTargetAt({ x: LEAF.left + LEAF.width + 5, y: 60 }, withStrip)).not.toMatchObject({
      kind: 'strip',
    })
  })

  /** 下标 = 指针越过了几条 tab 的中线。末格右边那一大片空白 = 排到最后。 */
  it('stripIndexAt:越过几条中线就是第几格', () => {
    expect(stripIndexAt(60, STRIP)).toBe(0)
    expect(stripIndexAt(109, STRIP)).toBe(0)
    expect(stripIndexAt(111, STRIP)).toBe(1)
    expect(stripIndexAt(800, STRIP)).toBe(3)
  })

  it('条不画高亮 —— 预示是条自己腾出来的那格空位', () => {
    expect(targetRectOf({ kind: 'strip', leafId: 'leaf-a', at: 1 }, withStrip)).toBeNull()
  })

  it('没交 strips 进来 = 这次拖拽不认条(与 W3 逐字相同)', () => {
    expect(dropTargetAt({ x: 175, y: 60 }, geometry)).toMatchObject({ kind: 'leaf' })
  })
})

describe('高亮画的就是判据用的那块矩形(W3-b 裁定 7:环与杠)', () => {
  it('叶身 = 整片叶(ring 在它里面描一圈)', () => {
    expect(zoneRectOf(LEAF, 'center')).toEqual(LEAF)
  })

  it('四带 = 贴那条边的一根 4px 杠,**永远在叶里**', () => {
    expect(zoneRectOf(LEAF, 'w')).toEqual({ left: 50, top: 50, width: DROP_BAR_PX, height: 700 })
    expect(zoneRectOf(LEAF, 'e')).toEqual({ left: 946, top: 50, width: DROP_BAR_PX, height: 700 })
    expect(zoneRectOf(LEAF, 'n')).toEqual({ left: 50, top: 50, width: 900, height: DROP_BAR_PX })
    expect(zoneRectOf(LEAF, 's')).toEqual({ left: 50, top: 746, width: 900, height: DROP_BAR_PX })
    for (const zone of ['w', 'e', 'n', 's'] as const) {
      const bar = zoneRectOf(LEAF, zone)
      expect(bar.left).toBeGreaterThanOrEqual(LEAF.left)
      expect(bar.top).toBeGreaterThanOrEqual(LEAF.top)
      expect(bar.left + bar.width).toBeLessThanOrEqual(LEAF.left + LEAF.width)
      expect(bar.top + bar.height).toBeLessThanOrEqual(LEAF.top + LEAF.height)
    }
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
