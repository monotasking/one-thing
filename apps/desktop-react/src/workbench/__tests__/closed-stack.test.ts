import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WORKBENCH_PER_SPACE, startWorkbench, useWorkbenchStore } from '../store'
import { registerContentKind, refId, resetContentKinds, restoreContent } from '../kinds'
import { CLOSED_STACK_DEPTH } from '../closed-tabs'
import { CENTER_REGION } from '../regions'
import { leavesOf } from '../tree'
import type { ContentRef } from '../kinds'

/**
 * **关闭栈接进 store 那一段**(K2,⌘⇧T)。
 *
 * 纯算术在 `./leaf-commands.test.ts`;这一组守的是**接线**,而它只有三句话:
 *  ① 影是在 `dispose` **之前**取的(次序是硬的:`dispose` 会把那一格真的销毁,
 *     之后再问 `snapshot` 读到的是一份空壳);
 *  ② 栈**按叶**记(⌘⇧T 的语义是「这一排刚关掉的那一格」);
 *  ③ `takeClosedTab` 是**取走**,不是看一眼(按两下回来两格)。
 *
 * 用的是**假种类**(与 `store.test.ts` 同一条纪律):真种类会把读者引向
 * 「核心层认识浏览器」那个错的直觉,而这一段一个种类名都不该出现。
 */

const doc = (key: string): ContentRef => ({ kind: 'doc', key })
/** 自述快照的那一种(浏览器在真产品里是它) */
const vol = (key: string): ContentRef => ({ kind: 'vol', key })

let order: string[] = []

beforeEach(() => {
  resetContentKinds()
  order = []
  registerContentKind({
    id: 'home',
    singleton: true,
    resident: { region: CENTER_REGION, seed: () => 'main' },
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
  })
  registerContentKind({
    id: 'vol',
    singleton: false,
    title: (ref) => ({ text: ref.key }),
    icon: () => 'FileText',
    render: () => null,
    /* 「关了之后这个 key 就不存在了」那一种:影里记的是别的东西。 */
    snapshot: (ref) => {
      order.push(`snapshot:${ref.key}`)
      return { url: `https://${ref.key}.test` }
    },
    restore: async (snapshot) => {
      const url = (snapshot as { url?: string }).url
      return url ? vol(url.replace(/^https:\/\/|\.test$/g, '')) : null
    },
    dispose: (ref) => order.push(`dispose:${ref.key}`),
  })
  useWorkbenchStore.getState().reset()
  startWorkbench()
})

afterEach(() => resetContentKinds())

const center = () => useWorkbenchStore.getState().regions[CENTER_REGION]
const leafId = () => leavesOf(center())[0].id
const tabs = () => leavesOf(center())[0].tabs.map(refId)

describe('关之前先留影', () => {
  it('**次序是硬的**:`snapshot` 在 `dispose` 之前', () => {
    const store = useWorkbenchStore.getState()
    store.openRef(vol('a'))
    const at = tabs().indexOf('vol:a')
    store.closeTab(leafId(), at)
    expect(order).toEqual(['snapshot:a', 'dispose:a'])
  })

  it('栈上那一格记着种类、影与它坐过的第几格', () => {
    const store = useWorkbenchStore.getState()
    store.openRef(doc('a'))
    const at = tabs().indexOf('doc:a')
    store.closeTab(leafId(), at)
    const entry = useWorkbenchStore.getState().takeClosedTab(leafId())
    expect(entry).toEqual({ kind: 'doc', snapshot: doc('a'), index: at })
  })

  it('自述快照那一种存的是影不是 ref —— 重开经 `restore` 回来一格新的', async () => {
    const store = useWorkbenchStore.getState()
    store.openRef(vol('a'))
    store.closeTab(leafId(), tabs().indexOf('vol:a'))
    const entry = useWorkbenchStore.getState().takeClosedTab(leafId())!
    expect(entry.snapshot).toEqual({ url: 'https://a.test' })
    expect(await restoreContent(entry.kind, entry.snapshot)).toEqual(vol('a'))
  })
})

describe('取走,不是看一眼', () => {
  it('按两下回来两格,栈空之后答 null', () => {
    const store = useWorkbenchStore.getState()
    store.openRef(doc('a'))
    store.openRef(doc('b'))
    store.closeTab(leafId(), tabs().indexOf('doc:b'))
    store.closeTab(leafId(), tabs().indexOf('doc:a'))
    const live = () => useWorkbenchStore.getState()
    // 后进先出:最近关掉的是 a。
    expect(live().takeClosedTab(leafId())?.snapshot).toEqual(doc('a'))
    expect(live().takeClosedTab(leafId())?.snapshot).toEqual(doc('b'))
    expect(live().takeClosedTab(leafId())).toBeNull()
  })

  it('没关过东西的那片叶答 null(⌘⇧T 于是不交 handler)', () => {
    expect(useWorkbenchStore.getState().takeClosedTab('leaf-nope')).toBeNull()
    expect(useWorkbenchStore.getState().takeClosedTab(leafId())).toBeNull()
  })

  it('封顶 10 格(store 这一头也走同一只纯函数)', () => {
    const store = useWorkbenchStore.getState()
    for (let n = 1; n <= 13; n += 1) {
      store.openRef(doc(`d${n}`))
      useWorkbenchStore.getState().closeTab(leafId(), tabs().indexOf(`doc:d${n}`))
    }
    expect(useWorkbenchStore.getState().closedTabs[leafId()]).toHaveLength(CLOSED_STACK_DEPTH)
    expect(useWorkbenchStore.getState().takeClosedTab(leafId())?.snapshot).toEqual(doc('d13'))
  })
})

describe('不落盘', () => {
  /**
   * 重启之后没有「刚关的」这回事 —— 那是一句关于**这一段操作**的话,不是用户
   * 摆好的家具。判据落在 per-space 的 `pick`(「什么算家具」的单产地)上:
   * 它一个字都不提这张表。
   */
  it('`closedTabs` 不在家具账里', () => {
    const store = useWorkbenchStore.getState()
    store.openRef(doc('a'))
    store.closeTab(leafId(), tabs().indexOf('doc:a'))
    expect(useWorkbenchStore.getState().closedTabs[leafId()]).toHaveLength(1)
    const furniture = Object.keys(WORKBENCH_PER_SPACE.pick(useWorkbenchStore.getState()))
    expect(furniture).not.toContain('closedTabs')
  })
})
