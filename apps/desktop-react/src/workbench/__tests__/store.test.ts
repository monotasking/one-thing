import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WORKBENCH_PER_SPACE,
  canDetachTab,
  normalizeRegions,
  openStateOf,
  startWorkbench,
  useWorkbenchStore,
} from '../store'
import { registerContentKind, refId, resetContentKinds } from '../kinds'
import { CENTER_REGION } from '../regions'
import { leavesOf, makeLeaf, refIdsOf } from '../tree'
import { swapSpace } from '../../workspace/per-space'
import type { ContentRef } from '../kinds'

/**
 * **拼贴台的账**(W1,设计 §1.3 / §2.3)。
 *
 * 这一组守四件:①出厂布局是**问表**问出来的(核心层不认识任何一种内容);
 * ②预览 / 固定 / 隐藏 / 关闭四个动作的语义;③「常驻那一种的最后一格关不掉」
 * 是按**种类的自述**判的,不是按种类的名字;④per-space 换装的次序。
 *
 * 用例里注册的是**假种类**(`home` / `doc`),正是为了让第 ③ 条在测试里也成立:
 * 换成 `chat` / `file` 会把读者引向「它认识聊天」那个错的直觉。
 */

const doc = (key: string): ContentRef => ({ kind: 'doc', key })
let disposed: string[] = []

beforeEach(() => {
  resetContentKinds()
  disposed = []
  registerContentKind({
    id: 'home',
    singleton: true,
    resident: { region: CENTER_REGION, key: 'main' },
    regions: [CENTER_REGION],
    title: () => ({ text: '家' }),
    icon: () => 'Layers',
    render: () => null,
  })
  registerContentKind({
    id: 'doc',
    singleton: false,
    title: (ref) => ({ text: ref.key }),
    icon: () => 'FileText',
    render: () => null,
    dispose: (ref) => disposed.push(refId(ref)),
  })
  useWorkbenchStore.getState().reset()
  startWorkbench()
})

afterEach(() => {
  resetContentKinds()
})

/** 中央区那棵树。 */
const center = () => useWorkbenchStore.getState().regions[CENTER_REGION]
/** 焦点叶(出厂只有一片)。 */
const onlyLeaf = () => leavesOf(center())[0]

describe('出厂布局:问表,不写死', () => {
  it('自述了 `resident` 的那一种,出厂就在那个区域里有一格', () => {
    expect(refIdsOf(center())).toEqual(['home:main'])
  })

  it('播种**幂等** —— 再跑一次不会长出第二格', () => {
    startWorkbench()
    startWorkbench()
    expect(refIdsOf(center())).toEqual(['home:main'])
  })

  it('常驻那一格补在**第一片叶的最前面**(它是这个区域的家,不是后来加的)', () => {
    useWorkbenchStore.setState({ regions: { [CENTER_REGION]: makeLeaf('L1', [doc('a')]) } })
    startWorkbench()
    expect(refIdsOf(center())).toEqual(['home:main', 'doc:a'])
  })

  it('存量档案里认不得的种类当场剔掉(而且不留一棵空树)', () => {
    const dirty = makeLeaf('L1', [{ kind: 'gone', key: 'x' }, doc('a')])
    expect(refIdsOf(normalizeRegions({ [CENTER_REGION]: dirty })[CENTER_REGION])).toEqual([
      'home:main',
      'doc:a',
    ])
  })
})

describe('打开:预览 / 固定', () => {
  it('单击(预览)开出来的是预览 tab,再单击**就地替换**', () => {
    const store = useWorkbenchStore.getState()
    store.openRef(doc('a'), { preview: true })
    store.openRef(doc('b'), { preview: true })
    expect(refIdsOf(center())).toEqual(['home:main', 'doc:b'])
    expect(onlyLeaf().preview).toBe('doc:b')
  })

  it('↵ / 菜单那条路(固定)开出来的是固定 tab,一格一格攒', () => {
    const store = useWorkbenchStore.getState()
    store.openRef(doc('a'))
    store.openRef(doc('b'))
    expect(refIdsOf(center())).toEqual(['home:main', 'doc:a', 'doc:b'])
    expect(onlyLeaf().preview).toBeNull()
  })

  it('「保留」把预览那一格固定下来 —— 下一次单击不再替换它', () => {
    const store = useWorkbenchStore.getState()
    store.openRef(doc('a'), { preview: true })
    useWorkbenchStore.getState().pinTab(onlyLeaf().id, 1)
    useWorkbenchStore.getState().openRef(doc('b'), { preview: true })
    expect(refIdsOf(center())).toEqual(['home:main', 'doc:a', 'doc:b'])
  })

  it('单例已经开着 = 激活它,不插第二格', () => {
    const store = useWorkbenchStore.getState()
    store.openRef(doc('a'))
    store.openRef({ kind: 'home', key: 'main' })
    expect(refIdsOf(center())).toEqual(['home:main', 'doc:a'])
    expect(onlyLeaf().active).toBe(0)
  })

  it('这一种自述了 `regions`,别的区域开不进去', () => {
    useWorkbenchStore.setState({
      regions: { ...useWorkbenchStore.getState().regions, 'edge:right': makeLeaf('R1', [doc('z')]) },
    })
    useWorkbenchStore.getState().openRef({ kind: 'home', key: 'main' }, { region: 'edge:right' })
    expect(refIdsOf(useWorkbenchStore.getState().regions['edge:right'])).toEqual(['doc:z'])
  })
})

describe('隐藏 ≠ 关闭(设计 §2.3 那张表)', () => {
  it('隐藏:从叶里摘掉、记 returnTo,**实例不丢**', () => {
    const store = useWorkbenchStore.getState()
    store.openRef(doc('a'))
    const leafId = onlyLeaf().id
    useWorkbenchStore.getState().hideTab(leafId, 1)
    expect(refIdsOf(center())).toEqual(['home:main'])
    expect(useWorkbenchStore.getState().hidden).toEqual([
      { ref: doc('a'), returnTo: { region: CENTER_REGION, leafId, index: 1 } },
    ])
    // dispose **没有**被叫过 —— 那正是「隐藏」与「关闭」的分水岭。
    expect(disposed).toEqual([])
  })

  it('恢复:回它藏起来时那个位置', () => {
    const store = useWorkbenchStore.getState()
    store.openRef(doc('a'))
    store.openRef(doc('b'))
    const leafId = onlyLeaf().id
    useWorkbenchStore.getState().hideTab(leafId, 1)
    expect(refIdsOf(center())).toEqual(['home:main', 'doc:b'])
    useWorkbenchStore.getState().restoreHidden('doc:a')
    expect(refIdsOf(center())).toEqual(['home:main', 'doc:a', 'doc:b'])
    expect(useWorkbenchStore.getState().hidden).toEqual([])
  })

  it('那片叶已经没了 → 落在焦点叶上(结构归还的同一条口径)', () => {
    const store = useWorkbenchStore.getState()
    store.openRef(doc('a'))
    useWorkbenchStore.getState().hideTab(onlyLeaf().id, 1)
    // 伪造「那片叶没了」:整棵树换成另一片。
    useWorkbenchStore.setState({
      regions: { [CENTER_REGION]: makeLeaf('OTHER', [{ kind: 'home', key: 'main' }]) },
      focusLeafId: 'OTHER',
    })
    useWorkbenchStore.getState().restoreHidden('doc:a')
    expect(refIdsOf(center())).toEqual(['home:main', 'doc:a'])
  })

  it('关闭:从叶里摘掉**并且** dispose', () => {
    const store = useWorkbenchStore.getState()
    store.openRef(doc('a'))
    useWorkbenchStore.getState().closeTab(onlyLeaf().id, 1)
    expect(refIdsOf(center())).toEqual(['home:main'])
    expect(disposed).toEqual(['doc:a'])
  })

  it('重新打开一份藏着的 = 请回来(不留一条孤儿隐藏记录)', () => {
    const store = useWorkbenchStore.getState()
    store.openRef(doc('a'))
    useWorkbenchStore.getState().hideTab(onlyLeaf().id, 1)
    useWorkbenchStore.getState().openRef(doc('a'))
    expect(useWorkbenchStore.getState().hidden).toEqual([])
    expect(refIdsOf(center())).toEqual(['home:main', 'doc:a'])
  })
})

describe('常驻那一种的最后一格关不掉(T0 拍点 2)', () => {
  it('判据是**同种还剩几个**,不是「它是不是那一种」', () => {
    const tree = center()
    const leafId = onlyLeaf().id
    expect(canDetachTab(tree, leafId, 0)).toBe(false)
    useWorkbenchStore.getState().closeTab(leafId, 0)
    useWorkbenchStore.getState().hideTab(leafId, 0)
    // 关不掉也藏不掉 —— 两条路同一条判据。
    expect(refIdsOf(center())).toEqual(['home:main'])
  })

  it('同种有两格时就关得掉(W5 会话多开靠的正是这一格,一个字不用改)', () => {
    /*
     * `home` 是单例,所以这一格靠**手动摆两格**来演 —— 演的是判据本身:
     * 「这个区域里这一种还剩几个」。W5 把 chat 改成非单例之后,这就是真场景。
     */
    useWorkbenchStore.setState({
      regions: {
        [CENTER_REGION]: makeLeaf('L1', [
          { kind: 'home', key: 'main' },
          { kind: 'home', key: 'second' },
        ]),
      },
    })
    expect(canDetachTab(center(), 'L1', 0)).toBe(true)
  })

  it('没自述 `resident` 的那一种随便关', () => {
    useWorkbenchStore.getState().openRef(doc('a'))
    expect(canDetachTab(center(), onlyLeaf().id, 1)).toBe(true)
  })
})

describe('分屏', () => {
  it('把活动 tab 拉到新的那一片,焦点叶指向新的那一片', () => {
    const store = useWorkbenchStore.getState()
    store.openRef(doc('a'))
    useWorkbenchStore.getState().splitLeaf(onlyLeaf().id, 'row')
    const leaves = leavesOf(center())
    expect(leaves).toHaveLength(2)
    expect(leaves[1].tabs.map(refId)).toEqual(['doc:a'])
    expect(useWorkbenchStore.getState().focusLeafId).toBe(leaves[1].id)
  })

  it('关掉新叶里最后一格 → 剪枝,树回到一片叶', () => {
    const store = useWorkbenchStore.getState()
    store.openRef(doc('a'))
    useWorkbenchStore.getState().splitLeaf(onlyLeaf().id, 'row')
    const fresh = leavesOf(center())[1]
    useWorkbenchStore.getState().closeTab(fresh.id, 0)
    expect(leavesOf(center())).toHaveLength(1)
    expect(refIdsOf(center())).toEqual(['home:main'])
  })
})

describe('三态标记:一处产地', () => {
  it('树里 = shown / 隐藏表里 = hidden / 都不在 = null', () => {
    const store = useWorkbenchStore.getState()
    store.openRef(doc('a'))
    const read = () => useWorkbenchStore.getState()
    expect(openStateOf(read(), doc('a'))).toBe('shown')
    useWorkbenchStore.getState().hideTab(onlyLeaf().id, 1)
    expect(openStateOf(read(), doc('a'))).toBe('hidden')
    useWorkbenchStore.getState().dropHidden('doc:a')
    expect(openStateOf(read(), doc('a'))).toBeNull()
  })

  it('分栏那一格(不进树)同样算 shown —— 它也是「打开着并显示」', () => {
    useWorkbenchStore.getState().openInPanel('/repo/a.ts')
    expect(openStateOf(useWorkbenchStore.getState(), { kind: 'file', key: '/repo/a.ts' })).toBe(
      'shown',
    )
  })
})

describe('per-space:换装的次序即语义', () => {
  it('先把旧空间的收进账,再把新空间的摊开(反过来旧布局当场蒸发)', () => {
    const store = useWorkbenchStore.getState()
    store.openRef(doc('a'))
    const state = useWorkbenchStore.getState()
    const swapped = swapSpace(state, WORKBENCH_PER_SPACE, 'space-2', 'space-1')
    // 旧空间那一格记住了它的树。
    expect(refIdsOf(swapped.byWorkspace['space-1'].regions[CENTER_REGION])).toEqual([
      'home:main',
      'doc:a',
    ])
    // 新空间是出厂布局(账上没有 = 第一次进这个空间)。
    expect(refIdsOf(swapped.regions[CENTER_REGION])).toEqual([])
  })

  it('瞬态那两格不进家具账(焦点叶 / 分栏路径是「此刻在哪」,不是摆好的东西)', () => {
    useWorkbenchStore.getState().openInPanel('/repo/a.ts')
    useWorkbenchStore.getState().setFocusLeaf('L-whatever')
    const picked = WORKBENCH_PER_SPACE.pick(useWorkbenchStore.getState())
    expect(Object.keys(picked).sort()).toEqual(['hidden', 'regions'])
  })
})

describe('种类表:重名抛,注销可回收', () => {
  it('两处抢同一个种类名 = 真冲突,当场抛', () => {
    expect(() =>
      registerContentKind({
        id: 'doc',
        singleton: false,
        title: () => ({ text: '' }),
        icon: () => 'File',
        render: () => null,
      }),
    ).toThrow(/doc/)
  })

  it('`registerContentKind` 交出的注销口只摘「确实是我登记的那一格」', () => {
    const spy = vi.fn()
    const off = registerContentKind({
      id: 'tmp',
      singleton: false,
      title: () => ({ text: '' }),
      icon: () => 'File',
      render: () => null,
      dispose: spy,
    })
    off()
    off()
    expect(() =>
      registerContentKind({
        id: 'tmp',
        singleton: false,
        title: () => ({ text: '' }),
        icon: () => 'File',
        render: () => null,
      }),
    ).not.toThrow()
  })
})
