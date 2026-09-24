import { beforeEach, describe, expect, it } from 'vitest'
import { refId, registerContentKind, resetContentKinds } from '../kinds'
import { CENTER_REGION, edgeRegion } from '../regions'
import { useWorkbenchStore } from '../store'
import { leavesOf, makeLeaf, rekeyRef } from '../tree'
import type { ContentRef } from '../kinds'
import type { PaneLeafNode, PaneNode } from '../tree'

/**
 * **同一份内容换个写法,处处都换**(09-24)。
 *
 * 起因是目录面板那一格 key 以 `~` 起笔(病历在 `content/files/HomeRootResolver.tsx`):
 * 展开之后要把它改写成绝对路径,而同一个目录可以同时在两片叶里、藏着的那一张表里、
 * 全屏那一格里。`replaceRef` 做不到这件事 —— 它先把 `to` 从别处摘干净(它说的是
 * 「这一格换成另一份」),第二片叶一换就把第一片刚换好的那一格摘掉了。
 *
 * 这一组在**核心层**,一个「目录」的字都不出现在被测代码里 —— 夹具的种类名是 `doc`。
 */

const doc = (key: string): ContentRef => ({ kind: 'doc', key })
const FROM = doc('~/x')
const TO = doc('/home/me/x')

beforeEach(() => {
  resetContentKinds()
  registerContentKind({
    id: 'doc',
    singleton: false,
    title: (ref) => ({ text: ref.key }),
    icon: () => 'File',
    render: () => null,
  })
  useWorkbenchStore.getState().reset()
})

function split(a: PaneNode, b: PaneNode): PaneNode {
  return { kind: 'split', id: 'S', dir: 'row', ratio: 50, a, b }
}

function allKeys(): string[] {
  const out: string[] = []
  for (const tree of Object.values(useWorkbenchStore.getState().regions)) {
    for (const leaf of leavesOf(tree)) for (const tab of leaf.tabs) out.push(tab.key)
  }
  return out
}

describe('tree.rekeyRef:纯函数', () => {
  it('每一片装着 `from` 的叶各换各的;下标与活动格不动', () => {
    const tree = split(makeLeaf('A', [doc('a'), FROM], 1), makeLeaf('B', [FROM, doc('b')], 0))
    const next = rekeyRef(tree, FROM, TO)
    const [a, b] = leavesOf(next)
    expect(a.tabs).toEqual([doc('a'), TO])
    expect(a.active).toBe(1)
    expect(b.tabs).toEqual([TO, doc('b')])
    expect(b.active).toBe(0)
  })

  it('钉住**跟着走**(还是那一份,只是名字写法变了)—— 与 `replaceRef` 相反', () => {
    const leaf: PaneLeafNode = { ...makeLeaf('A', [FROM, doc('b')]), pinned: [refId(FROM)] }
    const next = rekeyRef(leaf, FROM, TO) as PaneLeafNode
    expect(next.pinned).toEqual([refId(TO)])
  })

  it('`from` 哪儿都没有 = 引用恒等', () => {
    const tree = makeLeaf('A', [doc('a')])
    expect(rekeyRef(tree, FROM, TO)).toBe(tree)
  })
})

describe('store.rekeyRef:整台拼贴台', () => {
  it('中央两片叶 + 左架子 + 藏着的 + 全屏那一格,落定之后没有一处还是 `from`', () => {
    const left = edgeRegion('left')
    useWorkbenchStore.setState({
      regions: {
        [CENTER_REGION]: split(makeLeaf('A', [FROM]), makeLeaf('B', [doc('b'), FROM], 1)),
        [left]: makeLeaf('L', [FROM]),
      },
      hidden: [{ ref: FROM, returnTo: { region: CENTER_REGION, leafId: 'A', index: 1 } }],
      full: { ref: FROM, from: { region: CENTER_REGION, leafId: 'A', index: 0 } },
    })
    useWorkbenchStore.getState().rekeyRef(FROM, TO)
    const st = useWorkbenchStore.getState()
    expect(allKeys()).toEqual(['/home/me/x', 'b', '/home/me/x', '/home/me/x'])
    expect(st.hidden.map((entry) => entry.ref)).toEqual([TO])
    expect(st.full?.ref).toEqual(TO)
    // 叶的身份一个没换(零重挂的前提):还是 A / B / L 三片。
    const ids = Object.values(st.regions).flatMap((tree) => leavesOf(tree).map((leaf) => leaf.id))
    expect(ids.sort()).toEqual(['A', 'B', 'L'])
  })

  it('哪儿都没有 `from` = 空动作,不惊动订阅者', () => {
    useWorkbenchStore.setState({ regions: { [CENTER_REGION]: makeLeaf('A', [doc('a')]) } })
    const before = useWorkbenchStore.getState()
    useWorkbenchStore.getState().rekeyRef(FROM, TO)
    expect(useWorkbenchStore.getState()).toBe(before)
  })
})
