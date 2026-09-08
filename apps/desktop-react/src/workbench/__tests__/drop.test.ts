import { describe, expect, it } from 'vitest'
import {
  dropTargetAt,
  edgeRectOf,
  pairRectOf,
  NEW_SHELF_BAND,
  PAIR_BAND,
  stripIndexAt,
  targetRectOf,
} from '../drop'
import type { DropGeometry, DropRules, DropTarget, StripBox } from '../drop'

/**
 * **落点判据的表驱动守卫**(W3 交付 2;W6-b 按设计
 * `apps/desktop-react/docs/workbench-tabs-2026-09.md` §5 那张表重写;U1 2026-09-08
 * 按用户拍板的拖拽 v4 再改三处)。
 *
 * 这只文件里一个 DOM、一个 store、一个 React 都没有 —— 判据本来就该这样测:
 * 「指针在这儿、屏幕上有这几块矩形、拖的这一格装了几份,松手会发生什么」是一句
 * 纯粹的算术。
 *
 * U1 换掉的三格:
 *  · 「标签正中 44% = 与它二合一」(`pairTab` / `tabMiddleAt`)整段删掉 —— 外来
 *    来源落到条上只剩一种落点。换上来的是**空位位移下的下标自稳**那一组:同一趟
 *    扫描把上一帧的空位喂回去,下标只能单调走,同一个 x 上不许来回。
 *  · 窗口边带从 24 收到 12(`NEW_SHELF_BAND`),而且**只对还没有架子的那一边**
 *    成立 —— 用户报的「莫名钉边」。
 *  · 「氛围」那一组(`ambientRectsOf`)整段删掉 —— 用户报的「一拖整窗变色」。
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
  // 这台夹具四条边都还没有架子 —— 于是四条 12px 的窄带全都成立。
  shelves: [],
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

/**
 * **外来来源落到标签条上只有一种落点**(U1)。
 *
 * 反证:把 `pairTab` 那一档种回 `stripAt`(正中 44% 判成「与它二合一」),
 * 第一条当场红 —— 而它红的正是用户报的那件事:同一条条上两种落点按 28% 线交替,
 * 每交替一次宿主就删掉占位再插一格新的。
 */
describe('②标签条 = 插到第几格(条上不再有第二种落点)', () => {
  it('落在某一格的正中,答的也是「插到它旁边」而不是「并进它」', () => {
    const target = dropTargetAt(middleOf(2), geometry, OUTSIDER)
    // 第 2 格正中(x=350)已经越过第 0/1 格的中线,还没越过它自己的 → 插到第 2 位。
    expect(target).toEqual({ kind: 'strip', leafId: 'leaf-a', at: 2 })
  })

  it('落在两侧照旧是「插到它旁边」—— 两处答的是同一种落点,不再有那条 28% 线', () => {
    // 第 2 格左缘 +10px:从前这里是「两侧 28%」那一档,今天与正中同一档。
    const target = dropTargetAt({ x: 180, y: 60 }, geometry, OUTSIDER)
    expect(target.kind).toBe('strip')
  })

  it('两格的标签落到条上照旧收 —— 条上没有「并」,也就没有「不能再并」', () => {
    const target = dropTargetAt(middleOf(2), geometry, { dragged: { id: 'x', slots: 2 } })
    expect(target.kind).toBe('strip')
  })

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

/**
 * **空位位移下的下标自稳**(U1 —— 这一批新立的那条判据,判词整段在
 * `drop.stripIndexAt` 上)。
 *
 * 病历:空位一插进去,它右边那几格标签整体右移一个空位宽;而判据从前一律按
 * 起拖时那份**基准**量。于是屏幕上指针明明压在第 2 格上,读数说「放到第 3 位」
 * —— 差的正好是一个空位宽。
 *
 * 修法是把那一格位移当成入参算进去。这一组钉的是它**不会因此自激**:
 *  ① 同一个 x 上把结果喂回去再算一次,答案不动(幂等 = 一帧一次来回不可能);
 *  ② 一路往右扫,下标只增不减;一路往左扫,只减不增。
 *
 * 反证(真跑过):把 `stripIndexAt` 里的 `shift` 挖掉(退回基准),① 仍绿而
 * ③「屏幕上压在哪一格」那一条当场红 —— 它是这条判据存在的理由。
 */
describe('空位位移下的下标自稳(U1)', () => {
  /** 一条 4 格条,每格 100 宽,从 x=0 起排;空位宽 = 一格宽。 */
  const FOUR: StripBox = {
    region: 'center',
    leafId: 'leaf-a',
    rect: { left: 0, top: 0, width: 800, height: 34 },
    tabs: [0, 1, 2, 3].map((i) => ({
      left: i * 100,
      top: 0,
      width: 100,
      height: 34,
      id: `t${i}`,
      slots: 1,
    })),
    activeAt: 0,
  }
  const GAP_W = 100
  /** 一帧:拿上一帧的空位下标当输入,算出这一帧的。 */
  const step = (x: number, at: number) => stripIndexAt(x, FOUR, { at, width: GAP_W })

  it('①同一个 x 上算两次答案不动(幂等 —— 那正是「不会来回」)', () => {
    for (let at = 0; at <= FOUR.tabs.length; at += 1) {
      for (let x = 0; x <= 900; x += 1) {
        const once = step(x, at)
        expect(step(x, once), `x=${x} at=${at}`).toBe(once)
      }
    }
  })

  it('②从左扫到右再扫回来:去程只增、回程只减,一次翻转都没有', () => {
    let at = 0
    const forward: number[] = []
    for (let x = 0; x <= 900; x += 1) {
      at = step(x, at)
      forward.push(at)
    }
    for (let i = 1; i < forward.length; i += 1) {
      expect(forward[i], `去程 x=${i}`).toBeGreaterThanOrEqual(forward[i - 1])
    }
    const back: number[] = []
    for (let x = 900; x >= 0; x -= 1) {
      at = step(x, at)
      back.push(at)
    }
    for (let i = 1; i < back.length; i += 1) {
      expect(back[i], `回程 x=${900 - i}`).toBeLessThanOrEqual(back[i - 1])
    }
    // 一趟走完回到原点,下标也回到 0 —— 没有攒下任何漂移。
    expect(back[back.length - 1]).toBe(0)
  })

  it('③读数与屏幕一致:指针压在活位置的第 2 格上,答的就是第 2 位', () => {
    /*
     * 空位开在第 1 格之前,于是屏幕上:t0 在 [0,100)、空位 [100,200)、
     * t1 在 [200,300)、t2 在 [300,400)。指针站在 t2 的活中线左边一点(x=340)
     * —— 眼睛看到的是「插在 t2 之前」= 第 2 位。
     */
    expect(step(340, 1)).toBe(2)
    // 反证的读数:按基准量的话 t2 的中线在 250,340 已经越过 → 答 3,差一格。
    expect(stripIndexAt(340, FOUR)).toBe(3)
  })
})

/**
 * **窗口边带:12px,而且只对那一边还没有架子时成立**(U1)。
 *
 * 病历两条,一条修:24px 的四条带排在叶之前,于是任何一次贴边经过都判「钉边」;
 * 而左边明明开着文件架子时,那条带说的「钉成左侧架子」更是无处可去 —— 用户报的
 * 「莫名钉边」。
 */
describe('③新架子那条窄边带(U1)', () => {
  /**
   * 这一组要在**边带与叶重叠**的地方量,所以叶铺满整扇窗(上面那台夹具的叶四周
   * 各留 50 —— 边带外面是空地,量不出「谁赢了谁」)。
   */
  const FULL_LEAF = { left: 0, top: 0, width: 1000, height: 800 }
  const FULL: DropGeometry = {
    window: WINDOW,
    leaves: [{ region: 'center', leafId: 'leaf-a', rect: FULL_LEAF }],
    strips: [{ ...STRIP, rect: { left: 0, top: 0, width: 1000, height: 34 } }],
    shelves: [],
  }

  it('离左缘 6px 且左边没有架子 = 在那条边上生一条架子', () => {
    expect(dropTargetAt({ x: 6, y: 400 }, FULL, OUTSIDER)).toEqual({
      kind: 'edge',
      side: 'left',
    })
  })

  it('离边 12 以外就轮到叶了(24 那一版在这里还答 edge)', () => {
    expect(dropTargetAt({ x: 20, y: 400 }, FULL, OUTSIDER).kind).toBe('pair')
  })

  it('**那条边上已经有架子 = 这条带不存在**,落的是底下那片叶', () => {
    const withLeftShelf: DropGeometry = { ...FULL, shelves: ['left'] }
    expect(dropTargetAt({ x: 6, y: 400 }, withLeftShelf, OUTSIDER).kind).toBe('pair')
    // 别的边不受影响 —— 它是一张按边逐条的表,不是一个总开关。
    expect(dropTargetAt({ x: 994, y: 400 }, withLeftShelf, OUTSIDER)).toEqual({
      kind: 'edge',
      side: 'right',
    })
  })

  it('**边带排在条之后、叶之前**:条上那一点仍归条,叶上那一点归边带', () => {
    /*
     * 一条铺满窗口顶部的条,它的左端压在左边那 12px 里 —— 这一点两者都够得着,
     * 而条先问。这条断言拆掉次序(把边带提到条前面)当场红。
     */
    const topStrip: StripBox = {
      region: 'center',
      leafId: 'leaf-a',
      rect: { left: 0, top: 0, width: 1000, height: 34 },
      tabs: [{ left: 0, top: 0, width: 120, height: 34, id: 'a', slots: 1 }],
      activeAt: 0,
    }
    const geo: DropGeometry = { ...geometry, strips: [topStrip] }
    expect(dropTargetAt({ x: 4, y: 17 }, geo, OUTSIDER).kind).toBe('strip')
    // 同一条边,离开条之后就是边带(它排在叶之前)。
    expect(dropTargetAt({ x: 4, y: 400 }, geo, OUTSIDER)).toEqual({ kind: 'edge', side: 'left' })
  })
})

describe('④⑤⑥内容区三档', () => {
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
    const bare: DropGeometry = { window: WINDOW, leaves: geometry.leaves, shelves: [] }
    const x = LEAF.left + LEAF.width * (1 - PAIR_BAND / 2)
    expect(dropTargetAt({ x, y: center.y }, bare, OUTSIDER).kind).toBe('open')
  })
})

describe('⑦自己的内容区 = 放回', () => {
  it('拖的就是这片叶的活动标签 —— 整片叶都是 back,左右带也不例外', () => {
    const self: DropRules = { dragged: { id: 'b', slots: 1 } }
    expect(dropTargetAt(center, geometry, self)).toEqual({ kind: 'back' })
    const x = LEAF.left + LEAF.width * (1 - PAIR_BAND / 2)
    expect(dropTargetAt({ x, y: center.y }, geometry, self)).toEqual({ kind: 'back' })
  })
})

describe('⑧窗外 / 什么都没碰到 = 撕成浮窗', () => {
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
  it('open = 整片叶(slab 铺满它)', () => {
    const target: DropTarget = { kind: 'open', region: 'center', leafId: 'leaf-a' }
    expect(targetRectOf(target, geometry)).toEqual(LEAF)
  })

  it('pair = 落下后占的那一半(与 open 同一种板,差的只是矩形)', () => {
    const right: DropTarget = { kind: 'pair', region: 'center', leafId: 'leaf-a', side: 'right' }
    expect(targetRectOf(right, geometry)).toEqual(pairRectOf(LEAF, 'right'))
    expect(pairRectOf(LEAF, 'right')).toEqual({ left: 500, top: 50, width: 450, height: 700 })
    expect(pairRectOf(LEAF, 'left')).toEqual({ left: 50, top: 50, width: 450, height: 700 })
  })

  it('条上那一档故意不答矩形(预示是条自己腾出来的空位)', () => {
    expect(targetRectOf({ kind: 'strip', leafId: 'leaf-a', at: 1 }, geometry)).toBeNull()
    expect(targetRectOf({ kind: 'back' }, geometry)).toBeNull()
    expect(targetRectOf({ kind: 'float' }, geometry)).toBeNull()
  })

  it('edge = 贴那条边的一条 12 宽的带(与判据读同一个 NEW_SHELF_BAND)', () => {
    expect(targetRectOf({ kind: 'edge', side: 'left' }, geometry)).toEqual(
      edgeRectOf(WINDOW, 'left', NEW_SHELF_BAND),
    )
    expect(edgeRectOf(WINDOW, 'right', NEW_SHELF_BAND)).toEqual({
      left: 1000 - NEW_SHELF_BAND,
      top: 0,
      width: NEW_SHELF_BAND,
      height: 800,
    })
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
  const geo: DropGeometry = {
    window: WINDOW,
    leaves: [],
    strips: [topbar, shelf],
    nodrop: [],
    // 屏幕上真有一条左架子(它那条条就在这儿)—— 左边那 12px 因此不是边带。
    shelves: ['left'],
  }

  it('指针在顶栏那一格的正中 → 插进顶栏那条条,而不是插进架子那条条', () => {
    // DOM 逆序里架子排在后面(它盖在上面),所以一遍扫描时它先被问到。
    expect(dropTargetAt({ x: 149, y: 22 }, geo, {})).toEqual({
      kind: 'strip',
      leafId: 'leaf-center',
      // 149 恰好是第 0 格的中线,还没越过 —— 插到它前面。要紧的是**哪条条**。
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
