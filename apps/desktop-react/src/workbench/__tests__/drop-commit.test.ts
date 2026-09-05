import { beforeEach, describe, expect, it } from 'vitest'
import { dropRef, reorderTab } from '../drop-commit'
import { refIdsOf, leavesOf, makeLeaf } from '../tree'
import { CENTER_REGION, edgeRegion } from '../regions'
import { partsOfContent, refId } from '../kinds'
import { pairContentKind } from '../../content/kinds/pair'
import { resetContentKinds, registerContentKind } from '../kinds'
import { useWorkbenchStore } from '../store'
import { useStageStore } from '../../stage/store'
import type { ContentRef } from '../kinds'

/**
 * **落定那一个事务动作的守卫**(W3,派工令验收的反证第五条:「菜单与拖拽走两个
 * 动作 →『同一事务』单测红」)。
 *
 * 这里断言的正是那一条:`dropRef` 是**唯一**那口 —— 菜单里点「移到右侧」与把
 * 一格 tab 拖到窗口右边带,走的是这只函数、得到的是同一棵树。所以只要有人在
 * 某一头另开一条路,下面这几条里必有一条对不上。
 */

const A: ContentRef = { kind: 'test-a', key: 'a' }
const B: ContentRef = { kind: 'test-b', key: 'b' }
const C: ContentRef = { kind: 'test-b', key: 'c' }

function seedKinds(): void {
  resetContentKinds()
  /*
   * **`pair` 那一种要在场**(W6-b):`dropRef` 的两格并排走的是
   * `store.pairRefs` → `composeContent`,而后者**问整张表**谁并得出来 ——
   * 表被 `resetContentKinds()` 清空之后谁都答不出,那两条落点会静默成空动作。
   * 登记的是产品那一份真件,不是一个假的:并出来的 key 形状、拆得开拆不开
   * 都要与真机一致。
   */
  registerContentKind(pairContentKind)
  for (const kind of ['test-a', 'test-b']) {
    registerContentKind({
      id: kind,
      singleton: false,
      title: (ref) => ({ text: ref.key }),
      icon: () => 'File',
      render: () => null,
    })
  }
}

/** 中央区一片叶,装着 A 与 B 两格。 */
function seedTree(): string {
  const leaf = makeLeaf('leaf-1', [A, B], 0)
  useWorkbenchStore.setState({ regions: { [CENTER_REGION]: leaf }, hidden: [], focusLeafId: 'leaf-1' })
  return 'leaf-1'
}

beforeEach(() => {
  seedKinds()
  useWorkbenchStore.getState().reset()
  /*
   * 形态机没有 `reset` 那一口(它是 persist 的,用例之间只要那几格与本文件相关的
   * 归零就够)—— 这里只把架子的收展与浮窗表推回出厂,免得上一条用例撕出来的窗
   * 混进下一条的计数。
   */
  useStageStore.setState({ floats: {}, floatOrder: [] })
  seedTree()
})

const centerTree = () => useWorkbenchStore.getState().regions[CENTER_REGION]

describe('落到一片叶(W6-b:§5 那张表的后四行)', () => {
  it('中间 = 末尾开成一格新标签,不复制', () => {
    /*
     * 目标叶**装着东西**(C):树上不存在空叶 —— `prune` 当场把它剪掉,所以
     * 「往一片空叶里落」这一形在屏幕上不可能出现,用例也不该假造它。
     */
    const leaf = makeLeaf('leaf-2', [C], 0)
    useWorkbenchStore.setState({
      regions: { [CENTER_REGION]: centerTree(), [edgeRegion('right')]: leaf },
    })
    dropRef(A, { kind: 'open', region: edgeRegion('right'), leafId: 'leaf-2' })
    // 搬走了,不是复制了一份:两处加起来仍旧只有一个 A。
    expect(refIdsOf(centerTree())).toEqual([refId(B)])
    expect(refIdsOf(useWorkbenchStore.getState().regions[edgeRegion('right')])).toEqual([
      refId(C),
      refId(A),
    ])
  })

  /**
   * **左右带 = 二合一**(W6-b:边带分屏退役,单叶政策)。它落成一格复合内容顶在
   * 原位,而不是长出第二片叶 —— 这一条正是 W6-a 那句「止血」被换成终态语义的地方。
   */
  it('右带 = 与活动那一格并成两格,树上仍旧只有一片叶', () => {
    useWorkbenchStore.setState({
      regions: { [CENTER_REGION]: centerTree(), [edgeRegion('right')]: makeLeaf('leaf-2', [C], 0) },
    })
    dropRef(A, { kind: 'pair', region: edgeRegion('right'), leafId: 'leaf-2', side: 'right' })
    const tree = useWorkbenchStore.getState().regions[edgeRegion('right')]
    expect(leavesOf(tree)).toHaveLength(1)
    // 一格标签,装着两份 —— C 在左、A 在右。
    const tabs = leavesOf(tree)[0].tabs
    expect(tabs).toHaveLength(1)
    expect(partsOfContent(tabs[0])?.map(refId)).toEqual([refId(C), refId(A)])
    // 搬,不是复制:中央区那一头没有 A 了。
    expect(refIdsOf(centerTree())).toEqual([refId(B)])
  })

  it('左带 = 并进左侧', () => {
    useWorkbenchStore.setState({
      regions: { [CENTER_REGION]: centerTree(), [edgeRegion('right')]: makeLeaf('leaf-2', [C], 0) },
    })
    dropRef(A, { kind: 'pair', region: edgeRegion('right'), leafId: 'leaf-2', side: 'left' })
    const tabs = leavesOf(useWorkbenchStore.getState().regions[edgeRegion('right')])[0].tabs
    expect(partsOfContent(tabs[0])?.map(refId)).toEqual([refId(A), refId(C)])
  })

  it('落到某一格标签正中 = 与**那一格**并,不是与活动那一格并', () => {
    // 两格标签的叶,活动的是第 0 格;落点点名第 1 格。
    useWorkbenchStore.setState({
      regions: { [CENTER_REGION]: makeLeaf('leaf-1', [A, B], 0) },
      focusLeafId: 'leaf-1',
    })
    useWorkbenchStore.setState({
      regions: {
        [CENTER_REGION]: makeLeaf('leaf-1', [A, B], 0),
        [edgeRegion('right')]: makeLeaf('leaf-2', [C], 0),
      },
    })
    dropRef(C, { kind: 'pairTab', region: CENTER_REGION, leafId: 'leaf-1', at: 1 })
    const tabs = leavesOf(centerTree())[0].tabs
    expect(tabs).toHaveLength(2)
    expect(refId(tabs[0])).toBe(refId(A))
    expect(partsOfContent(tabs[1])?.map(refId)).toEqual([refId(B), refId(C)])
  })

  /*
   * **一片叶里唯一那一格拖到它自己身上 = 空动作**。判据在 `store.pairRefs`
   * (`sameRef(host, ref)` 当场返回),这里钉的是它真的没掉在地上。
   */
  it('唯一那一格拖回自己身上 = 什么都不发生', () => {
    const only = makeLeaf('leaf-solo', [A], 0)
    useWorkbenchStore.setState({ regions: { [CENTER_REGION]: only }, focusLeafId: 'leaf-solo' })
    dropRef(A, { kind: 'pair', region: CENTER_REGION, leafId: 'leaf-solo', side: 'right' })
    expect(refIdsOf(centerTree())).toEqual([refId(A)])
    expect(leavesOf(centerTree())).toHaveLength(1)
    dropRef(A, { kind: 'open', region: CENTER_REGION, leafId: 'leaf-solo' })
    expect(refIdsOf(centerTree())).toEqual([refId(A)])
  })

  /** `back` = 拖回自己那片叶的内容区:**空动作**(设计 §5 最后一行)。 */
  it('back = 一个字都不改', () => {
    const before = centerTree()
    dropRef(A, { kind: 'back' })
    expect(centerTree()).toBe(before)
  })
})

describe('落到边 / 撕成浮窗', () => {
  it('边:进那条边的树,而且这条架子是展开的', () => {
    useStageStore.setState((st) => ({
      shelves: { ...st.shelves, right: { ...st.shelves.right, collapsed: true } },
    }))
    dropRef(A, { kind: 'edge', side: 'right' })
    expect(refIdsOf(useWorkbenchStore.getState().regions[edgeRegion('right')])).toEqual([refId(A)])
    expect(useStageStore.getState().shelves.right.collapsed).toBe(false)
    expect(refIdsOf(centerTree())).toEqual([refId(B)])
  })

  /*
   * **W4 留账 2 的了结**:从前只有瓦撕得出去(浮窗三张表都按瓦 id 记)。
   * 现在窗号由 `nextFloatId` 铸,所以一格**文件**(这里是 `test-a`)也撕得出来。
   */
  it('浮窗:任何一种 ref 都撕得出去,窗号新铸', () => {
    dropRef(A, { kind: 'float' }, { pointer: { x: 400, y: 300 } })
    const regions = useWorkbenchStore.getState().regions
    const floats = Object.keys(regions).filter((r) => r.startsWith('float:'))
    expect(floats).toHaveLength(1)
    expect(refIdsOf(regions[floats[0]])).toEqual([refId(A)])
    // 矩形也补上了 —— 不补的话 `FloatWindow` 那句 `if (!rect) return null` 会让
    // 这扇窗一帧都不画,而树已经建好了(屏幕上就是「点了没反应」)。
    const winId = floats[0].slice('float:'.length)
    expect(useStageStore.getState().floats[winId]).toBeTruthy()
  })

  it('同一格再撕一次 = 回原来那扇窗,不开第二扇', () => {
    dropRef(A, { kind: 'float' })
    const first = Object.keys(useWorkbenchStore.getState().regions).filter((r) => r.startsWith('float:'))
    dropRef(A, { kind: 'float' })
    const second = Object.keys(useWorkbenchStore.getState().regions).filter((r) => r.startsWith('float:'))
    expect(second).toEqual(first)
  })
})

describe('拖拽期间树形冻住(W3 两个坑之一)', () => {
  /*
   * 判词整段在 `WorkbenchState.dragging` 上:落点判据吃的是**起拖时量的那份几何**,
   * 而几何只在树不变的前提下成立。拖拽中用户自己动不了树(指针被 capture 住),
   * 但异步的动得了 —— 一份文件读完了要插一格 tab,那一格插进去屏幕上的叶全部
   * 重排,而手上那份几何还是旧的:高亮画在 A,松手落在 B。
   */
  it('闸上之后改树形的那几口都是空动作', () => {
    const store = useWorkbenchStore.getState()
    const before = centerTree()
    store.setDragging(true)
    store.openRef(C)
    store.moveRef(A, edgeRegion('right'))
    store.splitLeaf('leaf-1', 'row', B, false)
    store.closeTab('leaf-1', 1)
    store.hideTab('leaf-1', 1)
    // **同一个对象**:一格都没动,不只是「看起来一样」。
    expect(centerTree()).toBe(before)
    expect(Object.keys(useWorkbenchStore.getState().regions)).toEqual([CENTER_REGION])
  })

  it('落定 / 取消解闸之后照旧', () => {
    const store = useWorkbenchStore.getState()
    store.setDragging(true)
    store.setDragging(false)
    store.openRef(C)
    expect(refIdsOf(centerTree())).toContain(refId(C))
  })

  /* 落定那条路**不在闸内**:它是开闸之后才跑的,再闸一次只会让「松手没反应」成真。 */
  it('moveRefIntoLeaf 不在闸内(它就是落定那条路)', () => {
    const store = useWorkbenchStore.getState()
    store.setDragging(true)
    store.moveRefIntoLeaf(A, 'leaf-1')
    expect(refIdsOf(centerTree())).toEqual([refId(B), refId(A)])
    useWorkbenchStore.getState().setDragging(false)
  })
})

describe('拒绝是空动作', () => {
  it('树前后逐字相同', () => {
    const before = centerTree()
    dropRef(A, { kind: 'refuse', reasonKey: 'drag.regionRefused' })
    // **同一个对象**,不只是「长得一样」——结构共享是零重挂的结构前提。
    expect(centerTree()).toBe(before)
  })
})

/**
 * **`at` 的坐标系:从编舞算出来那个数,到树上真正的次序**(W6-b 二修)。
 *
 * `ui/tab-reorder.track()` 答的是「插到第 `at` 格**之前**,对着没摘掉任何东西的
 * 那张原始表」,`reorderTab` 收的也是这个坐标系,而 `tree.moveTab` 再自己收
 * splice 的那一格偏移 —— 三处必须是同一句话。**判词对不对不算数,结果才算数**:
 * 这几条把「换序判据 → 松手之后条上是什么次序」整条链钉死,谁在中间任何一处
 * 多加减一格,下面必有一条红。
 *
 * 每一条的 `at` 都是拿真判据算出来的(三格各 120 宽、条 [0,360]):
 *   A 拖到最右   抓 A 中心 60,右缘钳到 360 > B/C 两个中心 → next=2 → at=3
 *   C 拖到最左   抓 C 中心 300,左缘钳到 0,两个左邻居的中心都在它右边 → next=0 → at=0
 *   A 往右一格   右缘越过 B 的中心 180、没到 C 的 300 → next=1 → at=2
 *   B 往左一格   左缘越过 A 的中心 60(走到它左边)、右缘没到 C 的 300 → next=0 → at=0
 */
describe('换序:判据算出来的 at 落到树上是什么次序', () => {
  /** 中央区一片叶,装着 A / B / C 三格,活动位在第 0 格。 */
  const seedThree = (active = 0): void => {
    useWorkbenchStore.setState({
      regions: { [CENTER_REGION]: makeLeaf('leaf-1', [A, B, C], active) },
      hidden: [],
      focusLeafId: 'leaf-1',
    })
  }
  const orderNow = (): string[] => refIdsOf(centerTree())
  const activeNow = (): string | undefined => {
    const leaf = leavesOf(centerTree())[0]
    return leaf.tabs[leaf.active] ? refId(leaf.tabs[leaf.active]) : undefined
  }

  it('A 拖到最右(at=3)→ [B, C, A],活动位跟着 A', () => {
    seedThree(0)
    reorderTab('leaf-1', 0, 3)
    expect(orderNow()).toEqual([refId(B), refId(C), refId(A)])
    expect(activeNow()).toBe(refId(A))
  })

  it('C 拖到最左(at=0)→ [C, A, B],活动位跟着 C', () => {
    seedThree(2)
    reorderTab('leaf-1', 2, 0)
    expect(orderNow()).toEqual([refId(C), refId(A), refId(B)])
    expect(activeNow()).toBe(refId(C))
  })

  it('A 往右一格(at=2)→ [B, A, C]', () => {
    seedThree(0)
    reorderTab('leaf-1', 0, 2)
    expect(orderNow()).toEqual([refId(B), refId(A), refId(C)])
    expect(activeNow()).toBe(refId(A))
  })

  it('B 往左一格(at=0)→ [B, A, C]', () => {
    seedThree(1)
    reorderTab('leaf-1', 1, 0)
    expect(orderNow()).toEqual([refId(B), refId(A), refId(C)])
    expect(activeNow()).toBe(refId(B))
  })

  /*
   * **原地不动有两种写法**,两种都必须是空动作(判词在 `reorderTab` 上:
   * 引用恒等 —— 条内换序里「手抖了一下又放回去」是最常发生的一下)。
   * 静止时判据答的正是 `at === from`(next === index);往右走了半格但还没
   * 越过任何中心时答的是 `at === from + 1`。
   */
  it('原地不动的两种写法都不改树(同一个对象)', () => {
    seedThree(1)
    const before = centerTree()
    reorderTab('leaf-1', 1, 1)
    expect(centerTree()).toBe(before)
    reorderTab('leaf-1', 1, 2)
    expect(centerTree()).toBe(before)
  })
})
