import { beforeEach, describe, expect, it } from 'vitest'
import { dropRef } from '../drop-commit'
import { refIdsOf, leavesOf, makeLeaf } from '../tree'
import { CENTER_REGION, edgeRegion } from '../regions'
import { refId } from '../kinds'
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
  const leaf = makeLeaf('leaf-1', [A, B], 0, null)
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

describe('落到一片叶', () => {
  it('中心区 = 并入,不复制', () => {
    /*
     * 目标叶**装着东西**(C):树上不存在空叶 —— `prune` 当场把它剪掉,所以
     * 「往一片空叶里落」这一形在屏幕上不可能出现,用例也不该假造它。
     */
    const leaf = makeLeaf('leaf-2', [C], 0, null)
    useWorkbenchStore.setState({
      regions: { [CENTER_REGION]: centerTree(), [edgeRegion('right')]: leaf },
    })
    dropRef(A, { kind: 'leaf', region: edgeRegion('right'), leafId: 'leaf-2', zone: 'center' })
    // 搬走了,不是复制了一份:两处加起来仍旧只有一个 A。
    expect(refIdsOf(centerTree())).toEqual([refId(B)])
    expect(refIdsOf(useWorkbenchStore.getState().regions[edgeRegion('right')])).toEqual([
      refId(C),
      refId(A),
    ])
  })

  it('四带 = 切一刀,原叶一格都不少', () => {
    dropRef(B, { kind: 'leaf', region: CENTER_REGION, leafId: 'leaf-1', zone: 'e' })
    const leaves = leavesOf(centerTree())
    expect(leaves).toHaveLength(2)
    // 原叶留着 A,新叶装 B —— 而且 B 只有一份(先摘干净再切)。
    expect(refIdsOf(centerTree()).filter((id) => id === refId(B))).toHaveLength(1)
    expect(leaves[0].tabs.map(refId)).toEqual([refId(A)])
    expect(leaves[1].tabs.map(refId)).toEqual([refId(B)])
  })

  /*
   * **一片叶里唯一那一格拖到它自己身上 = 空动作**。少了这一句,那一格会先被摘掉
   * (叶随之被剪)、`splitLeaf` 再答「没有这片叶」—— 那一格就此从树上消失。
   */
  it('唯一那一格拖回自己身上 = 什么都不发生', () => {
    const only = makeLeaf('leaf-solo', [A], 0, null)
    useWorkbenchStore.setState({ regions: { [CENTER_REGION]: only }, focusLeafId: 'leaf-solo' })
    dropRef(A, { kind: 'leaf', region: CENTER_REGION, leafId: 'leaf-solo', zone: 'e' })
    expect(refIdsOf(centerTree())).toEqual([refId(A)])
    expect(leavesOf(centerTree())).toHaveLength(1)
    dropRef(A, { kind: 'leaf', region: CENTER_REGION, leafId: 'leaf-solo', zone: 'center' })
    expect(refIdsOf(centerTree())).toEqual([refId(A)])
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
    dropRef(A, { kind: 'refuse', reasonKey: 'drag.sessionOnlyCenter' })
    // **同一个对象**,不只是「长得一样」——结构共享是零重挂的结构前提。
    expect(centerTree()).toBe(before)
  })
})
