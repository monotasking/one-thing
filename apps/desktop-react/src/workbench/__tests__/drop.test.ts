import { describe, expect, it } from 'vitest'
import {
  ambientRectsOf,
  dropTargetAt,
  edgeRectOf,
  pairRectOf,
  PAIR_BAND,
  stripIndexAt,
  tabMiddleAt,
  targetRectOf,
} from '../drop'
import type { DropGeometry, DropRules, DropTarget, StripBox } from '../drop'

/**
 * **落点判据的表驱动守卫**(W3 交付 2;W6-b 按设计
 * `apps/desktop-react/docs/workbench-tabs-2026-09.md` §5 那张表重写)。
 *
 * 这只文件里一个 DOM、一个 store、一个 React 都没有 —— 判据本来就该这样测:
 * 「指针在这儿、屏幕上有这几块矩形、拖的这一格装了几份,松手会发生什么」是一句
 * 纯粹的算术。
 *
 * W6-b 换掉的是**表本身**:W3-b 的「叶身并入 + 贴边 16px 分屏」整段退役
 * (单叶政策),换成 §5 那九行 —— 拒绝区 / 标签正中 / 标签之间 / 窗口边带 /
 * 内容区右带 / 左带 / 中间 / 自己 / 窗外。每一行在这里各有一条,外加四条边界:
 * **次序即语义**(先命中先赢)、**叶重叠取最上**、**两格的不能再并**、
 * **浮窗不接住自己**。
 */

/** 一块 1000×800 的窗口,中间摆一片 900×700 的叶(四周各留 50 —— 出了边带)。 */
const WINDOW = { left: 0, top: 0, width: 1000, height: 800 }
const LEAF = { left: 50, top: 50, width: 900, height: 700 }

/** 一条标签条:贴在叶的顶上,三格各 120 宽,第 1 格是活动的。 */
const STRIP: StripBox = {
  region: 'center',
  leafId: 'leaf-a',
  rect: { left: LEAF.left, top: LEAF.top, width: LEAF.width, height: 34 },
  tabs: [
    { left: 50, top: 50, width: 120, height: 34, id: 'a', slots: 1 },
    { left: 170, top: 50, width: 120, height: 34, id: 'b', slots: 1 },
    { left: 290, top: 50, width: 120, height: 34, id: 'c', slots: 1 },
  ],
  activeAt: 1,
}

const geometry: DropGeometry = {
  window: WINDOW,
  leaves: [{ region: 'center', leafId: 'leaf-a', rect: LEAF }],
  strips: [STRIP],
}

/** 叶的中心那一点(条只有 34 高,中心离它远得很)。 */
const center = { x: LEAF.left + LEAF.width / 2, y: LEAF.top + LEAF.height / 2 }
/** 拖的是一格普通内容,不是这条条上的任何一格。 */
const OUTSIDER: DropRules = { dragged: { id: 'x', slots: 1 } }

/** 一格 tab 的正中那一点(第 i 格)。 */
const middleOf = (i: number) => ({
  x: STRIP.tabs[i].left + STRIP.tabs[i].width / 2,
  y: STRIP.rect.top + STRIP.rect.height / 2,
})

describe('①拒绝区 —— 先命中先赢,而且赢得最硬', () => {
  const withNodrop: DropGeometry = {
    ...geometry,
    nodrop: [{ left: 0, top: 0, width: 80, height: 80 }],
  }

  it('红绿灯那一块压在标签条的带里,判的仍是拒绝', () => {
    // 这一点同时落在 nodrop 与条的带内 —— 次序决定它归谁。
    const target = dropTargetAt({ x: 60, y: 60 }, withNodrop, OUTSIDER)
    expect(target.kind).toBe('refuse')
    expect(target.kind === 'refuse' && target.reasonKey).toBe('drag.refuseHere')
  })

  it('拒绝区之外照旧', () => {
    expect(dropTargetAt({ x: 200, y: 60 }, withNodrop, OUTSIDER).kind).not.toBe('refuse')
  })
})

describe('②标签正中 44% = 与它二合一', () => {
  it('落在某一格的正中 = pairTab,带着那一格的下标', () => {
    const target = dropTargetAt(middleOf(2), geometry, OUTSIDER)
    expect(target).toEqual({ kind: 'pairTab', region: 'center', leafId: 'leaf-a', at: 2 })
  })

  it('落在两侧 28% = 落到它旁边,不是并进它', () => {
    // 第 2 格左缘 +10px:在它的左侧 28% 里。
    const target = dropTargetAt({ x: 180, y: 60 }, geometry, OUTSIDER)
    expect(target.kind).toBe('strip')
  })

  it('**被拖的自己除外**:拖到自己头上是换序,不是并', () => {
    const target = dropTargetAt(middleOf(1), geometry, { dragged: { id: 'b', slots: 1 } })
    expect(target.kind).toBe('strip')
  })

  it('**两格的标签不能再并**:说得出理由,不是静默改判', () => {
    const target = dropTargetAt(middleOf(2), geometry, { dragged: { id: 'x', slots: 2 } })
    expect(target).toEqual({ kind: 'refuse', reasonKey: 'drag.refusePairNest' })
  })

  it('tabMiddleAt:正中的边界两头都算,两侧不算', () => {
    const side = (1 - 0.44) / 2
    const tab = STRIP.tabs[0]
    expect(tabMiddleAt(tab.left + tab.width * side, STRIP)).toBe(0)
    expect(tabMiddleAt(tab.left + tab.width * (1 - side), STRIP)).toBe(0)
    expect(tabMiddleAt(tab.left + tab.width * side - 1, STRIP)).toBe(-1)
  })
})

describe('③标签之间 = 插到第几格', () => {
  it('条优先于叶 —— 条压在叶身里,先问叶的话它永远吸不到东西', () => {
    const target = dropTargetAt({ x: 600, y: 60 }, geometry, OUTSIDER)
    expect(target).toEqual({ kind: 'strip', leafId: 'leaf-a', at: 3 })
  })

  it('带上下各外扩 24(与条内换序同一个口径)', () => {
    expect(dropTargetAt({ x: 600, y: STRIP.rect.top - 20 }, geometry, OUTSIDER).kind).toBe('strip')
    expect(dropTargetAt({ x: 600, y: STRIP.rect.top - 30 }, geometry, OUTSIDER).kind).not.toBe('strip')
  })

  it('stripIndexAt:越过几条中线就是第几格', () => {
    expect(stripIndexAt(60, STRIP)).toBe(0)
    expect(stripIndexAt(109, STRIP)).toBe(0)
    expect(stripIndexAt(111, STRIP)).toBe(1)
    expect(stripIndexAt(800, STRIP)).toBe(3)
  })
})

describe('④窗口边带优先于叶', () => {
  it('贴着窗口左缘 = 钉到左架子,不是落进那片叶', () => {
    expect(dropTargetAt({ x: 6, y: 400 }, geometry, OUTSIDER)).toEqual({ kind: 'edge', side: 'left' })
  })

  it('离边 24 以外就轮到叶了', () => {
    expect(dropTargetAt({ x: 60, y: 400 }, geometry, OUTSIDER).kind).toBe('pair')
  })
})

describe('⑤⑥⑦内容区三档', () => {
  it('右带 28% = 与活动标签并排,放右', () => {
    const x = LEAF.left + LEAF.width * (1 - PAIR_BAND / 2)
    expect(dropTargetAt({ x, y: center.y }, geometry, OUTSIDER)).toEqual({
      kind: 'pair',
      region: 'center',
      leafId: 'leaf-a',
      side: 'right',
    })
  })

  it('左带 28% = 放左', () => {
    const x = LEAF.left + LEAF.width * (PAIR_BAND / 2)
    expect(dropTargetAt({ x, y: center.y }, geometry, OUTSIDER)).toEqual({
      kind: 'pair',
      region: 'center',
      leafId: 'leaf-a',
      side: 'left',
    })
  })

  it('**左带仅 host 单格**:活动那一格已经是两格时,左带退成「开新标签」', () => {
    const paired: DropGeometry = {
      ...geometry,
      strips: [{ ...STRIP, tabs: [...STRIP.tabs.slice(0, 1), { ...STRIP.tabs[1], slots: 2 }, STRIP.tabs[2]] }],
    }
    const x = LEAF.left + LEAF.width * (PAIR_BAND / 2)
    expect(dropTargetAt({ x, y: center.y }, paired, OUTSIDER)).toEqual({
      kind: 'open',
      region: 'center',
      leafId: 'leaf-a',
    })
    // 右带照旧收(它是「替换右格」)。
    const rx = LEAF.left + LEAF.width * (1 - PAIR_BAND / 2)
    expect(dropTargetAt({ x: rx, y: center.y }, paired, OUTSIDER).kind).toBe('pair')
  })

  it('中间 = 末尾开一格新标签', () => {
    expect(dropTargetAt(center, geometry, OUTSIDER)).toEqual({
      kind: 'open',
      region: 'center',
      leafId: 'leaf-a',
    })
  })

  it('两格的标签落到左右带 = 拒绝,**落到中间照旧收**', () => {
    const pair: DropRules = { dragged: { id: 'x', slots: 2 } }
    const x = LEAF.left + LEAF.width * (1 - PAIR_BAND / 2)
    expect(dropTargetAt({ x, y: center.y }, geometry, pair)).toEqual({
      kind: 'refuse',
      reasonKey: 'drag.refusePairNest',
    })
    expect(dropTargetAt(center, geometry, pair).kind).toBe('open')
  })

  it('没有条 = 没有 host = 只剩「开成新标签」', () => {
    const bare: DropGeometry = { window: WINDOW, leaves: geometry.leaves }
    const x = LEAF.left + LEAF.width * (1 - PAIR_BAND / 2)
    expect(dropTargetAt({ x, y: center.y }, bare, OUTSIDER).kind).toBe('open')
  })
})

describe('⑧自己的内容区 = 放回', () => {
  it('拖的就是这片叶的活动标签 —— 整片叶都是 back,左右带也不例外', () => {
    const self: DropRules = { dragged: { id: 'b', slots: 1 } }
    expect(dropTargetAt(center, geometry, self)).toEqual({ kind: 'back' })
    const x = LEAF.left + LEAF.width * (1 - PAIR_BAND / 2)
    expect(dropTargetAt({ x, y: center.y }, geometry, self)).toEqual({ kind: 'back' })
  })
})

describe('⑨窗外 / 什么都没碰到 = 撕成浮窗', () => {
  it('出了窗', () => {
    expect(dropTargetAt({ x: 500, y: 900 }, geometry, OUTSIDER)).toEqual({ kind: 'float' })
  })
})

describe('边界:叶重叠取最上、浮窗不接住自己', () => {
  const FLOAT = { left: 300, top: 300, width: 300, height: 200 }
  const stacked: DropGeometry = {
    ...geometry,
    leaves: [
      { region: 'center', leafId: 'leaf-a', rect: LEAF },
      { region: 'float:w1', leafId: 'leaf-f', rect: FLOAT },
    ],
  }
  const at = { x: 450, y: 400 }

  it('浮窗盖在中央叶上,落进的是浮窗', () => {
    const target = dropTargetAt(at, stacked, OUTSIDER)
    expect(target.kind === 'open' && target.leafId).toBe('leaf-f')
  })

  it('**从那扇浮窗里拖出来时它不接住自己**,按窗底下那片叶判(设计 §8)', () => {
    const target = dropTargetAt(at, stacked, { ...OUTSIDER, excludeLeaves: ['leaf-f'] })
    expect(target.kind === 'open' && target.leafId).toBe('leaf-a')
  })

  it('挡住的只有叶,**它的条照旧收**(不然自己那扇窗上换序也没了)', () => {
    const withStrip: DropGeometry = {
      ...stacked,
      strips: [
        STRIP,
        { region: 'float:w1', leafId: 'leaf-f', rect: { ...FLOAT, height: 34 }, tabs: [], activeAt: -1 },
      ],
    }
    const onStrip = { x: 450, y: FLOAT.top + 10 }
    const target = dropTargetAt(onStrip, withStrip, { ...OUTSIDER, excludeLeaves: ['leaf-f'] })
    expect(target).toEqual({ kind: 'strip', leafId: 'leaf-f', at: 0 })
  })
})

describe('rules.accepts —— 来源自述的复核,它说了算', () => {
  it('被拒的落点换成 refuse,理由是它给的那一句', () => {
    const target = dropTargetAt(center, geometry, {
      ...OUTSIDER,
      accepts: () => 'drag.regionRefused',
    })
    expect(target).toEqual({ kind: 'refuse', reasonKey: 'drag.regionRefused' })
  })

  it('已经是 refuse 的不再问一遍', () => {
    let asked = 0
    dropTargetAt({ x: 60, y: 60 }, { ...geometry, nodrop: [{ left: 0, top: 0, width: 80, height: 80 }] }, {
      ...OUTSIDER,
      accepts: () => {
        asked += 1
        return null
      },
    })
    expect(asked).toBe(0)
  })
})

describe('高亮矩形:与判据同源', () => {
  it('open = 整片叶(ring 在它里面描一圈)', () => {
    const target: DropTarget = { kind: 'open', region: 'center', leafId: 'leaf-a' }
    expect(targetRectOf(target, geometry)).toEqual(LEAF)
  })

  it('pair = 落下后占的那一半', () => {
    const right: DropTarget = { kind: 'pair', region: 'center', leafId: 'leaf-a', side: 'right' }
    expect(targetRectOf(right, geometry)).toEqual(pairRectOf(LEAF, 'right'))
    expect(pairRectOf(LEAF, 'right')).toEqual({ left: 500, top: 50, width: 450, height: 700 })
    expect(pairRectOf(LEAF, 'left')).toEqual({ left: 50, top: 50, width: 450, height: 700 })
  })

  it('条上那三档故意不答矩形(预示是条自己腾出来的空位 / 那一格上的圈)', () => {
    expect(targetRectOf({ kind: 'strip', leafId: 'leaf-a', at: 1 }, geometry)).toBeNull()
    expect(
      targetRectOf({ kind: 'pairTab', region: 'center', leafId: 'leaf-a', at: 1 }, geometry),
    ).toBeNull()
    expect(targetRectOf({ kind: 'back' }, geometry)).toBeNull()
    expect(targetRectOf({ kind: 'float' }, geometry)).toBeNull()
  })

  it('edge = 贴那条边的一条 24 宽的带', () => {
    expect(targetRectOf({ kind: 'edge', side: 'left' }, geometry)).toEqual(
      edgeRectOf(WINDOW, 'left'),
    )
    expect(edgeRectOf(WINDOW, 'right')).toEqual({ left: 976, top: 0, width: 24, height: 800 })
  })
})

describe('氛围:能放的地方有哪几块(§5 贯穿规则 1)', () => {
  it('叶 + 条 + 四条边带', () => {
    const rects = ambientRectsOf(geometry)
    expect(rects).toContainEqual(LEAF)
    expect(rects).toContainEqual(STRIP.rect)
    expect(rects).toContainEqual(edgeRectOf(WINDOW, 'left'))
    expect(rects).toHaveLength(1 + 1 + 4)
  })

  it('挡掉的叶不进这张表 —— 说「这里能放」而落不进去比不说更糟', () => {
    const rects = ambientRectsOf(geometry, { excludeLeaves: ['leaf-a'] })
    expect(rects).not.toContainEqual(LEAF)
  })
})

/**
 * **落在条上的赢过只是够得着的**(W7-c)。
 *
 * 病历(真机门 `gate:drag` 场景 ① 当场抓到):裁定 1 把顶栏标签改成从红绿灯右边
 * 起排之后,它与**左架子那条条**横向重叠了 —— 从前顶栏那一组坐在中央叶的正上方,
 * 而中央叶在架子右边,两条条永远不同 x。架子那条条的 24px 上下外扩(「瞄准附近
 * 也算」)正好够到顶栏里,而 `stripAt` 从前一遍扫描、DOM 逆序先到先得,于是指针
 * 明明在顶栏第 0 格的正中,判据交回的是「插进左架子第 1 位」。
 *
 * 反证:把 `stripAt` 改回一遍扫描(直接用 `TEAR_OFF_DISTANCE` 扫),这一条当场红。
 */
describe('两条条挨着时:落在上面的赢过只是够得着的(W7-c)', () => {
  const topbar: StripBox = {
    region: 'center',
    leafId: 'leaf-center',
    rect: { left: 80, top: 8, width: 1000, height: 28 },
    tabs: [
      { left: 89, top: 8, width: 120, height: 28, id: 'a', slots: 1 },
      { left: 209, top: 8, width: 120, height: 28, id: 'b', slots: 1 },
    ],
    activeAt: 0,
  }
  /** 左架子那条:x 与顶栏重叠,顶缘只比顶栏底缘低 8px(24 的外扩够得到)。 */
  const shelf: StripBox = {
    region: 'edge:left',
    leafId: 'leaf-shelf',
    rect: { left: 0, top: 44, width: 300, height: 28 },
    tabs: [{ left: 4, top: 44, width: 120, height: 28, id: 's', slots: 1 }],
    activeAt: 0,
  }
  const geo: DropGeometry = { window: WINDOW, leaves: [], strips: [topbar, shelf], nodrop: [] }

  it('指针在顶栏那一格的正中 → 与它二合一,而不是插进架子那条条', () => {
    // DOM 逆序里架子排在后面(它盖在上面),所以一遍扫描时它先被问到。
    expect(dropTargetAt({ x: 149, y: 22 }, geo, {})).toEqual({
      kind: 'pairTab',
      region: 'center',
      leafId: 'leaf-center',
      at: 0,
    })
  })

  it('指针真的落在架子那条条上时照旧归它(容差没被削掉)', () => {
    expect(dropTargetAt({ x: 60, y: 58 }, geo, {})).toMatchObject({ leafId: 'leaf-shelf' })
  })

  it('两条都够不着的地方仍旧靠外扩接住(24px 那一格没变)', () => {
    // 架子条上缘之上 10px,x 只在架子里(顶栏从 80 起) → 仍归架子。
    expect(dropTargetAt({ x: 40, y: 34 }, geo, {})).toMatchObject({ leafId: 'leaf-shelf' })
  })
})
