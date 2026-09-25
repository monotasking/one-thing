import { describe, expect, it } from 'vitest'
import {
  dropTargetAt,
  EDGE_BAND_MAX_PX,
  EDGE_BAND_RATIO,
  edgeBandOf,
  edgeRectOf,
  newShelfZoneOf,
  NEW_SHELF_ZONE,
  pairRectOf,
  SPLIT_BAND,
  splitRectOf,
  splitSideAt,
  stripIndexAt,
  targetRectOf,
} from '../drop'
import type { DropGeometry, DropRules, DropTarget, LeafBox, StripBox } from '../drop'

/**
 * **落点判据的表驱动守卫**(W3 立;09-24 按用户令重写 —— 次序与判词见 `drop.ts` 文件头)。
 *
 * 纯算术:指针在哪、屏幕上有哪几块矩形、拖的这一格是谁,松手会发生什么。
 * 09-24 换掉的几组:12px 窄边带 → 左 / 右 / 下三条 30% 新架子带;叶上的 28% 并排带与
 * 「中间 = 开新标签」→ 任意叶四边 30% 分屏、中间 = 浮窗;`back` 改成按「自己那条条上
 * 有几格」分两形。`pair` / `open` 两种类型留着,只是判据不再产生它们。
 */

/** 一块 1000×800 的窗口:新架子带左右各 300、底边 240。 */
const WINDOW = { left: 0, top: 0, width: 1000, height: 800 }
/** 中央叶四周各留 50。 */
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

const CENTER_BOX: LeafBox = { region: 'center', leafId: 'leaf-a', rect: LEAF }

/** 三条边都还没有架子 —— 三条新架子带全都成立。 */
const geometry: DropGeometry = {
  window: WINDOW,
  leaves: [CENTER_BOX],
  strips: [STRIP],
  shelves: [],
}

/** 三条边都已有架子 —— 新架子带全不存在,只剩叶自己的分屏带(量分屏用它)。 */
const SHELVED: DropGeometry = { ...geometry, shelves: ['left', 'right', 'bottom'] }

/** 叶上按比例取一点(fx / fy ∈ [0,1])。 */
const inLeaf = (fx: number, fy: number, rect = LEAF) => ({
  x: rect.left + rect.width * fx,
  y: rect.top + rect.height * fy,
})
const center = inLeaf(0.5, 0.5)
/** 拖的是一格外来内容,不是这条条上的任何一格。 */
const OUTSIDER: DropRules = { dragged: { id: 'x', slots: 1 } }
const split = (side: string, leafId = 'leaf-a', region = 'center') => ({
  kind: 'split',
  region,
  leafId,
  side,
})

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

  it('红绿灯那一块压在标签条的带里、也压在左边新架子带里,判的仍是拒绝', () => {
    const target = dropTargetAt({ x: 60, y: 60 }, withNodrop, OUTSIDER)
    expect(target).toEqual({ kind: 'refuse', reasonKey: 'drag.refuseHere' })
  })

  it('拒绝区之外照旧', () => {
    expect(dropTargetAt({ x: 200, y: 60 }, withNodrop, OUTSIDER).kind).not.toBe('refuse')
  })
})

/**
 * **标签条 = 插到第几格,而且是「铺满」唯一的路**(U1 + 09-24)。条上只有一种落点。
 */
describe('②标签条 = 插到第几格', () => {
  it('落在某一格的正中,答的也是「插到它旁边」而不是「并进它」', () => {
    expect(dropTargetAt(middleOf(2), geometry, OUTSIDER)).toEqual({
      kind: 'strip',
      leafId: 'leaf-a',
      at: 2,
    })
  })

  it('两格的标签落到条上照旧收', () => {
    expect(dropTargetAt(middleOf(2), geometry, { dragged: { id: 'x', slots: 2 } }).kind).toBe('strip')
  })

  it('条优先于新架子带与叶 —— 条的左端压在左边 30% 带里,仍归条', () => {
    expect(dropTargetAt({ x: 100, y: 60 }, geometry, OUTSIDER)).toEqual({
      kind: 'strip',
      leafId: 'leaf-a',
      at: 0,
    })
    expect(dropTargetAt({ x: 600, y: 60 }, SHELVED, OUTSIDER)).toEqual({
      kind: 'strip',
      leafId: 'leaf-a',
      at: 3,
    })
  })

  it('自己那条条上下各外扩 24(与条内换序同一个口径)', () => {
    const own: DropRules = { dragged: { id: 'b', slots: 1 } }
    expect(dropTargetAt({ x: 600, y: STRIP.rect.top - 20 }, SHELVED, own).kind).toBe('strip')
    expect(dropTargetAt({ x: 600, y: STRIP.rect.top - 30 }, SHELVED, own).kind).not.toBe('strip')
  })

  it('别人的条只外扩 8(09-25):再远一点就是旁边那片叶的分屏带,不许被条吃掉', () => {
    expect(dropTargetAt({ x: 600, y: STRIP.rect.top - 6 }, SHELVED, OUTSIDER).kind).toBe('strip')
    expect(dropTargetAt({ x: 600, y: STRIP.rect.top - 12 }, SHELVED, OUTSIDER).kind).not.toBe('strip')
    const below = STRIP.rect.top + STRIP.rect.height
    expect(dropTargetAt({ x: 600, y: below + 6 }, SHELVED, OUTSIDER).kind).toBe('strip')
    expect(dropTargetAt({ x: 600, y: below + 12 }, SHELVED, OUTSIDER)).toEqual(split('top'))
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
 * **边带:贴着窗口左 / 右 / 下三条边的窄带,只对没有架子(或架子收着)的那一边成立**
 * (09-25 外窄内宽)。宽 = `min(64, 那条轴 × 6%)`:这块 1000×800 的窗左右各 60、底边 48。
 *
 * 这一组在**带与叶重叠**的地方量 —— 叶铺满整扇窗(无架子时中央区就是这一形),于是每一处
 * 都同时够得着边带与叶的分屏带。09-24 那一版带宽 30%、排在叶前面,贴边那一侧的分屏带整块
 * 落在带里,永远判不到(用户报「chat 区没办法分屏到右侧」)。
 */
describe('④边带(外窄内宽)', () => {
  const FULL: DropGeometry = {
    window: WINDOW,
    leaves: [{ region: 'center', leafId: 'leaf-a', rect: WINDOW }],
    shelves: [],
  }
  const splitFull = (side: string) => split(side, 'leaf-a', 'center')

  it('带宽 = min(64, 轴 × 6%):左右 60,底边 48;大窗封顶 64', () => {
    expect(edgeBandOf('left', WINDOW)).toBe(60)
    expect(edgeBandOf('bottom', WINDOW)).toBe(48)
    expect(edgeBandOf('right', { left: 0, top: 0, width: 2560, height: 1440 })).toBe(EDGE_BAND_MAX_PX)
    expect(EDGE_BAND_RATIO).toBeLessThan(SPLIT_BAND)
  })

  it('左右:59 还在带里,61 就轮到叶的分屏带(不再是 30% 一整块)', () => {
    expect(dropTargetAt({ x: 59, y: 400 }, FULL, OUTSIDER)).toEqual({ kind: 'edge', side: 'left' })
    expect(dropTargetAt({ x: 61, y: 400 }, FULL, OUTSIDER)).toEqual(splitFull('left'))
    expect(dropTargetAt({ x: 950, y: 400 }, FULL, OUTSIDER)).toEqual({ kind: 'edge', side: 'right' })
    expect(dropTargetAt({ x: 900, y: 400 }, FULL, OUTSIDER)).toEqual(splitFull('right'))
  })

  it('底边按**窗高**算(48,不是窗宽的 60)', () => {
    expect(dropTargetAt({ x: 500, y: 760 }, FULL, OUTSIDER)).toEqual({ kind: 'edge', side: 'bottom' })
    expect(dropTargetAt({ x: 500, y: 745 }, FULL, OUTSIDER)).toEqual(splitFull('bottom'))
  })

  it('顶边永远不生架子 —— 那里是叶的上分屏带', () => {
    expect(dropTargetAt({ x: 500, y: 5 }, FULL, OUTSIDER)).toEqual(splitFull('top'))
  })

  it('角上两条带重叠:取归一距离更近的那条,平手优先左右', () => {
    // 左 12/60 = .2,底 20/48 ≈ .42 → 左。
    expect(dropTargetAt({ x: 12, y: 780 }, FULL, OUTSIDER)).toEqual({ kind: 'edge', side: 'left' })
    // 左 50/60 ≈ .83,底 4/48 ≈ .08 → 底。
    expect(dropTargetAt({ x: 50, y: 796 }, FULL, OUTSIDER)).toEqual({ kind: 'edge', side: 'bottom' })
    // 左 30/60 = 底 24/48 = .5 → 平手,左。
    expect(dropTargetAt({ x: 30, y: 776 }, FULL, OUTSIDER)).toEqual({ kind: 'edge', side: 'left' })
  })

  it('**那条边上已经有(展开的)架子 = 这条带不存在**,落的是底下那片叶;别的边不受影响', () => {
    const withLeft: DropGeometry = { ...FULL, shelves: ['left'] }
    expect(dropTargetAt({ x: 20, y: 400 }, withLeft, OUTSIDER)).toEqual(splitFull('left'))
    expect(dropTargetAt({ x: 980, y: 400 }, withLeft, OUTSIDER)).toEqual({ kind: 'edge', side: 'right' })
  })

  it('**收起的架子**:边带照旧成立(落进去 = 展开),预示按它展开后的厚度画', () => {
    const folded: DropGeometry = { ...FULL, shelves: ['right'], collapsed: [{ side: 'right', thickness: 360 }] }
    const target = dropTargetAt({ x: 990, y: 400 }, folded, OUTSIDER)
    expect(target).toEqual({ kind: 'edge', side: 'right' })
    expect(targetRectOf(target, folded)).toEqual({ left: 640, top: 0, width: 360, height: 800 })
    // 出了边带仍是叶的分屏。
    expect(dropTargetAt({ x: 900, y: 400 }, folded, OUTSIDER)).toEqual(splitFull('right'))
  })

  it('边带先于叶,但只占最外那一条:同一片叶的四向分屏全都够得着', () => {
    expect(dropTargetAt({ x: 55, y: 400 }, geometry, OUTSIDER)).toEqual({ kind: 'edge', side: 'left' })
    expect(dropTargetAt(inLeaf(0.05, 0.5), geometry, OUTSIDER)).toEqual(split('left'))
    expect(dropTargetAt(inLeaf(0.95, 0.5), geometry, OUTSIDER)).toEqual(split('right'))
    expect(dropTargetAt(inLeaf(0.5, 0.9), geometry, OUTSIDER)).toEqual(split('bottom'))
  })
})

describe('⑤任意一片叶的四边 30% = 分屏', () => {
  it('中央叶四向', () => {
    expect(dropTargetAt(inLeaf(0.1, 0.5), SHELVED, OUTSIDER)).toEqual(split('left'))
    expect(dropTargetAt(inLeaf(0.9, 0.5), SHELVED, OUTSIDER)).toEqual(split('right'))
    expect(dropTargetAt(inLeaf(0.5, 0.2), SHELVED, OUTSIDER)).toEqual(split('top'))
    expect(dropTargetAt(inLeaf(0.5, 0.9), SHELVED, OUTSIDER)).toEqual(split('bottom'))
  })

  it('带宽按叶自己的宽高算 30%:29% 在带里,31% 就是中间', () => {
    expect(dropTargetAt(inLeaf(0.29, 0.5), SHELVED, OUTSIDER)).toEqual(split('left'))
    expect(dropTargetAt(inLeaf(0.31, 0.5), SHELVED, OUTSIDER)).toEqual({ kind: 'float' })
  })

  it('角上按**归一**距离取最近,不按像素', () => {
    // 离左 180px(.20)、离上 175px(.25):按像素上边更近,按归一左边更近 → 左。
    expect(dropTargetAt(inLeaf(0.2, 0.25), SHELVED, OUTSIDER)).toEqual(split('left'))
    expect(dropTargetAt(inLeaf(0.25, 0.2), SHELVED, OUTSIDER)).toEqual(split('top'))
  })

  it('splitSideAt:平手优先左右,中间与零尺寸答 null', () => {
    const r = { left: 0, top: 0, width: 100, height: 100 }
    expect(splitSideAt({ x: 10, y: 10 }, r)).toBe('left')
    expect(splitSideAt({ x: 90, y: 10 }, r)).toBe('right')
    expect(splitSideAt({ x: 90, y: 90 }, r)).toBe('right')
    expect(splitSideAt({ x: 50, y: 50 }, r)).toBeNull()
    expect(splitSideAt({ x: 0, y: 0 }, { ...r, width: 0 })).toBeNull()
  })

  it('架子上的叶也分屏,region 是它自己那一格', () => {
    const geo: DropGeometry = {
      window: WINDOW,
      leaves: [
        { region: 'center', leafId: 'leaf-a', rect: { left: 0, top: 0, width: 700, height: 800 } },
        { region: 'edge:right', leafId: 'leaf-s', rect: { left: 700, top: 0, width: 300, height: 800 } },
      ],
      shelves: ['right'],
    }
    expect(dropTargetAt({ x: 950, y: 400 }, geo, OUTSIDER)).toEqual(split('right', 'leaf-s', 'edge:right'))
    expect(dropTargetAt({ x: 720, y: 400 }, geo, OUTSIDER)).toEqual(split('left', 'leaf-s', 'edge:right'))
  })

  it('两格的标签照样能分屏(不再有「不能再并」的拒绝)', () => {
    const pair: DropRules = { dragged: { id: 'x', slots: 2 } }
    expect(dropTargetAt(inLeaf(0.9, 0.5), SHELVED, pair)).toEqual(split('right'))
  })
})

describe('⑥⑦叶的中间:别人的 = 浮窗,自己的 = 放回', () => {
  /** 这片叶只有一格 `b`。 */
  const SOLE: DropGeometry = { ...SHELVED, strips: [{ ...STRIP, tabs: [STRIP.tabs[1]], activeAt: 0 }] }
  const OWN: DropRules = { dragged: { id: 'b', slots: 1 } }

  it('外来的东西落在叶中间 = 浮窗(不再「开成一格新标签」)', () => {
    expect(dropTargetAt(center, SHELVED, OUTSIDER)).toEqual({ kind: 'float' })
  })

  it('拖的是这片叶**唯一**那一格:整片叶都是放回,分屏带也不例外', () => {
    expect(dropTargetAt(center, SOLE, OWN)).toEqual({ kind: 'back' })
    expect(dropTargetAt(inLeaf(0.1, 0.5), SOLE, OWN)).toEqual({ kind: 'back' })
    expect(dropTargetAt(inLeaf(0.05, 0.95), SOLE, OWN)).toEqual({ kind: 'back' })
  })

  it('……但那只是叶身上的事:边带排在叶之前,照样能拖出一条架子', () => {
    const noShelves: DropGeometry = { ...SOLE, shelves: [] }
    expect(dropTargetAt({ x: 55, y: 400 }, noShelves, OWN)).toEqual({ kind: 'edge', side: 'left' })
  })

  it('拖的是活动格、叶里还有别的格:四边照样分屏,只有中间是放回', () => {
    expect(dropTargetAt(inLeaf(0.1, 0.5), SHELVED, OWN)).toEqual(split('left'))
    expect(dropTargetAt(center, SHELVED, OWN)).toEqual({ kind: 'back' })
  })

  it('拖的是自己叶里一格**非活动**标签:不算「自己」,中间 = 浮窗', () => {
    expect(dropTargetAt(center, SHELVED, { dragged: { id: 'a', slots: 1 } })).toEqual({ kind: 'float' })
  })

  it('没有条 = 认不出「自己」:中间浮窗、四边分屏', () => {
    const bare: DropGeometry = { ...SHELVED, strips: undefined }
    expect(dropTargetAt(center, bare, OWN)).toEqual({ kind: 'float' })
    expect(dropTargetAt(inLeaf(0.9, 0.5), bare, OWN)).toEqual(split('right'))
  })

  it('出了窗 = 浮窗', () => {
    expect(dropTargetAt({ x: 500, y: 900 }, geometry, OUTSIDER)).toEqual({ kind: 'float' })
  })

  it('判据不再产生 pair / open(整窗扫一遍)', () => {
    const seen = new Set<string>()
    for (const geo of [geometry, SHELVED, SOLE]) {
      for (const rules of [OUTSIDER, OWN, { dragged: { id: 'x', slots: 2 } }]) {
        for (let x = -20; x <= 1020; x += 20) {
          for (let y = -20; y <= 820; y += 20) seen.add(dropTargetAt({ x, y }, geo, rules).kind)
        }
      }
    }
    expect(seen.has('pair')).toBe(false)
    expect(seen.has('open')).toBe(false)
    expect([...seen].sort()).toEqual(['back', 'edge', 'float', 'split', 'strip'])
  })
})

describe('③浮窗里的叶:盖在新架子带之上;叶重叠取最上', () => {
  it('浮窗贴着左边:它的分屏带赢过身子底下那条新架子带', () => {
    const FLOAT = { left: 20, top: 250, width: 300, height: 300 }
    const geo: DropGeometry = {
      ...geometry,
      leaves: [CENTER_BOX, { region: 'float:w1', leafId: 'leaf-f', rect: FLOAT }],
    }
    expect(dropTargetAt({ x: 40, y: 400 }, geo, OUTSIDER)).toEqual(split('left', 'leaf-f', 'float:w1'))
    // 从那扇浮窗里拖出来时它不接住自己 → 露出底下那条新架子带。
    expect(dropTargetAt({ x: 40, y: 400 }, geo, { ...OUTSIDER, excludeLeaves: ['leaf-f'] })).toEqual({
      kind: 'edge',
      side: 'left',
    })
  })

  const FLOAT = { left: 300, top: 500, width: 300, height: 200 }
  const stacked: DropGeometry = {
    ...SHELVED,
    leaves: [CENTER_BOX, { region: 'float:w1', leafId: 'leaf-f', rect: FLOAT }],
  }
  /** 浮窗左带(.1)里;同一点在中央叶上落在下分屏带(fy ≈ .86)。 */
  const at = { x: 330, y: 650 }

  it('浮窗盖在中央叶上,落进的是浮窗', () => {
    expect(dropTargetAt(at, stacked, OUTSIDER)).toEqual(split('left', 'leaf-f', 'float:w1'))
  })

  it('**从那扇浮窗里拖出来时它不接住自己**,按窗底下那片叶判(设计 §8)', () => {
    expect(dropTargetAt(at, stacked, { ...OUTSIDER, excludeLeaves: ['leaf-f'] })).toEqual(split('bottom'))
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
    expect(dropTargetAt(onStrip, withStrip, { ...OUTSIDER, excludeLeaves: ['leaf-f'] })).toEqual({
      kind: 'strip',
      leafId: 'leaf-f',
      at: 0,
    })
  })
})

describe('rules.accepts —— 来源自述的复核,它说了算', () => {
  it('被拒的落点换成 refuse,理由是它给的那一句', () => {
    const target = dropTargetAt(inLeaf(0.9, 0.5), SHELVED, {
      ...OUTSIDER,
      accepts: (t) => (t.kind === 'split' ? 'drag.regionRefused' : null),
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
  it('edge = 那条新架子将来占的地方(与判据读同一个 NEW_SHELF_ZONE)', () => {
    expect(newShelfZoneOf('left', WINDOW)).toBe(WINDOW.width * NEW_SHELF_ZONE)
    expect(newShelfZoneOf('bottom', WINDOW)).toBe(WINDOW.height * NEW_SHELF_ZONE)
    expect(targetRectOf({ kind: 'edge', side: 'left' }, geometry)).toEqual({ left: 0, top: 0, width: 300, height: 800 })
    expect(targetRectOf({ kind: 'edge', side: 'right' }, geometry)).toEqual({ left: 700, top: 0, width: 300, height: 800 })
    expect(targetRectOf({ kind: 'edge', side: 'bottom' }, geometry)).toEqual({ left: 0, top: 560, width: 1000, height: 240 })
    expect(targetRectOf({ kind: 'edge', side: 'bottom' }, geometry)).toEqual(
      edgeRectOf(WINDOW, 'bottom', newShelfZoneOf('bottom', WINDOW)),
    )
  })

  it('split = 新叶将来占的那一半', () => {
    expect(splitRectOf(LEAF, 'left')).toEqual({ left: 50, top: 50, width: 450, height: 700 })
    expect(splitRectOf(LEAF, 'right')).toEqual({ left: 500, top: 50, width: 450, height: 700 })
    expect(splitRectOf(LEAF, 'top')).toEqual({ left: 50, top: 50, width: 900, height: 350 })
    expect(splitRectOf(LEAF, 'bottom')).toEqual({ left: 50, top: 400, width: 900, height: 350 })
    const target = dropTargetAt(inLeaf(0.9, 0.5), SHELVED, OUTSIDER) as DropTarget
    expect(targetRectOf(target, SHELVED)).toEqual(splitRectOf(LEAF, 'right'))
    // 认不出那片叶 = 没有可指的地方。
    expect(targetRectOf({ kind: 'split', region: 'center', leafId: 'nope', side: 'left' }, SHELVED)).toBeNull()
  })

  it('open / pair 菜单直接点名时照旧有矩形', () => {
    expect(targetRectOf({ kind: 'open', region: 'center', leafId: 'leaf-a' }, geometry)).toEqual(LEAF)
    const right: DropTarget = { kind: 'pair', region: 'center', leafId: 'leaf-a', side: 'right' }
    expect(targetRectOf(right, geometry)).toEqual(pairRectOf(LEAF, 'right'))
  })

  it('条 / 放回 / 浮窗故意不答矩形', () => {
    expect(targetRectOf({ kind: 'strip', leafId: 'leaf-a', at: 1 }, geometry)).toBeNull()
    expect(targetRectOf({ kind: 'back' }, geometry)).toBeNull()
    expect(targetRectOf({ kind: 'float' }, geometry)).toBeNull()
  })

  it('两个比例都小于一半 —— 窗与叶都留得出「中间」', () => {
    expect(NEW_SHELF_ZONE).toBeLessThan(0.5)
    expect(SPLIT_BAND).toBeLessThan(0.5)
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
    // 屏幕上真有一条左架子(它那条条就在这儿)—— 左边那条新架子带因此不存在。
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

  it('两条都够不着的地方仍旧靠外扩接住:别人的条 8px,自己的条 24px', () => {
    // 架子条上缘之上 6px,x 只在架子里(顶栏从 80 起) → 仍归架子。
    expect(dropTargetAt({ x: 40, y: 38 }, geo, {})).toMatchObject({ leafId: 'leaf-shelf' })
    // 上缘之上 10px:外来的够不着,拖的就是架子那一格(它自己的条)时仍归它。
    expect(dropTargetAt({ x: 40, y: 34 }, geo, {}).kind).not.toBe('strip')
    expect(dropTargetAt({ x: 40, y: 34 }, geo, { dragged: { id: 's', slots: 1 } })).toMatchObject({
      leafId: 'leaf-shelf',
    })
  })
})
