import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, renderHook, screen } from '@testing-library/react'
import { CenterRegion } from '../CenterRegion'
import { CENTER_REGION, edgeRegion } from '../regions'
import { focusIntoRef } from '../focus-into'
import { closePairSide, canClosePairSide, unpairTab } from '../drop-commit'
import { tabSpecOf } from '../LeafStrip'
import { useCloseLeafTab } from '../leaf-tabs'
import { useLeafOverflowStore } from '../leaf-overflow'
import {
  refId,
  registerContentKind,
  resetContentKinds,
  focusIntoScopeOf,
} from '../kinds'
import { startWorkbench, useWorkbenchStore } from '../store'
import { leavesOf, makeLeaf, refIdsOf } from '../tree'
import { useLiveTitleStore } from '../../stage/live-title'
import { useStageStore } from '../../stage/store'
import { focusTree } from '../../focus/registry'
import { pairContentKind } from '../../content/kinds/pair'
import { pairRefOf } from '../../content/kinds/pair-ref'
import { Tabs } from '../../ui/Tabs'
import type { TabsOverflow } from '../../ui/Tabs'
import type { ContentRef } from '../kinds'

/**
 * **W7-t:标签条与会话多开收尾**(审计 B 的 B1 / B3 / B6 / B7 / B11 / B12 + A12)。
 *
 * 这一组守的是**「能力自述、别人读表」在这一批里的六处落地**,每一条都配一句
 * 反证(拆掉哪一格它当场红):
 *  · B1  溢出名单是标签条自己的形(`ui/Tabs.onOverflow`),叶动作组只读表;
 *  · B3  「激活这一格,焦点落哪儿」是**内容自述**(`ContentKind.focusInto`),
 *        `focus-into` 里一个种类名都没有;
 *  · B6  「更宽的上限」也是内容自述(`ContentKind.tabWide` → `TabSpec.wide`);
 *  · B7  格头 ✕ 只关这一格,判据 `canClosePairSide` 借给 `canDetachTab`;
 *  · B11 拆开之后焦点进**左格**(它留在原标签);
 *  · B12 ⌘W 落在关不掉的格上要说话(那一条在 `leaf-tabs` 那一族里,
 *        用例走的是同一只 `canDetachTab`)。
 *
 * 这里注册的是**假种类**,与 `pair.test.tsx` 同一条理由:核心层不认识任何一种
 * 内容。真的那一种(`pair`)是 import 进来的 —— 它正是被测的那张自述。
 */

const doc = (key: string): ContentRef => ({ kind: 'doc', key })
const talk = (key: string): ContentRef => ({ kind: 'talk', key })
let disposed: string[] = []

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  resetContentKinds()
  disposed = []
  registerContentKind({
    id: 'talk',
    singleton: false,
    resident: { region: CENTER_REGION, seed: () => 'first' },
    title: (ref) => ({ text: `会话 ${ref.key}` }),
    icon: () => 'MessagesSquare',
    render: (ref) => <div data-testid={`talk-body:${ref.key}`}>{ref.key}</div>,
    /* 被测的那一格自述:这一种被激活时焦点交给输入面板。 */
    focusInto: 'composer',
  })
  registerContentKind({
    id: 'doc',
    singleton: false,
    title: (ref) => ({ text: ref.key }),
    icon: () => 'FileText',
    render: (ref) => <div data-testid={`doc-body:${ref.key}`}>{ref.key}</div>,
    dispose: (ref) => disposed.push(refId(ref)),
  })
  registerContentKind(pairContentKind)
  useWorkbenchStore.getState().reset()
  useLiveTitleStore.setState({ titles: {} })
  useLeafOverflowStore.setState({ byLeaf: {} })
  startWorkbench()
})

afterEach(() => {
  resetContentKinds()
  focusTree.reset()
})

const st = () => useWorkbenchStore.getState()
const center = () => st().regions[CENTER_REGION]
const onlyLeaf = () => leavesOf(center())[0]

describe('B3:「激活这一格,焦点落哪儿」是内容自述', () => {
  it('种类自述了 focusInto → `focusIntoRef` 先问那块面', () => {
    expect(focusIntoScopeOf(talk('x'))).toBe('composer')
    // 没自述的那一种照旧:落进它自己的内容层。
    expect(focusIntoScopeOf(doc('a'))).toBeUndefined()
  })

  it('自述的那块面在场 → 焦点送去它;不在场 → 回落内容层', () => {
    const tries: { scope: string; owner?: string }[] = []
    const spy = vi
      .spyOn(focusTree, 'activateScope')
      .mockImplementation((scope, opts) => {
        tries.push({ scope, owner: opts?.owner })
        return scope === 'composer'
      })
    expect(focusIntoRef(refId(talk('x')))).toBe(true)
    expect(tries).toEqual([{ scope: 'composer', owner: undefined }])

    /*
     * **反证**:把那块面撤下场(答 false)→ 这一句回落到内容层那一格,
     * 而不是「送不进去就不管了」。删掉 focus-into 里那句回落,下面第二格没有。
     */
    tries.length = 0
    spy.mockImplementation((scope, opts) => {
      tries.push({ scope, owner: opts?.owner })
      return false
    })
    expect(focusIntoRef(refId(talk('x')))).toBe(false)
    expect(tries).toEqual([
      { scope: 'composer', owner: undefined },
      { scope: 'leaf', owner: refId(talk('x')) },
    ])

    // 没自述的那一种一次都不问 composer(核心层不替谁猜)。
    tries.length = 0
    focusIntoRef(refId(doc('a')))
    expect(tries).toEqual([{ scope: 'leaf', owner: refId(doc('a')) }])
    spy.mockRestore()
  })
})

describe('B6:更宽的上限也是内容自述', () => {
  it('`tabSpecOf` 把 `ContentKind.tabWide` 变成 `TabSpec.wide`', () => {
    const made = pairRefOf(doc('a'), doc('b'))
    expect(tabSpecOf(made, {}).wide).toBe(true)
    // **反证**:把 `pairContentKind.tabWide` 删掉 → 下面第一句读 false,当场红。
    expect(tabSpecOf(doc('a'), {}).wide).toBe(false)
  })

  it('`ui/Tabs` 只认这一格布尔,画成 `data-tab-wide`(样式表不按种类开分支)', () => {
    render(
      <Tabs
        items={[
          { id: 'x', label: 'x', wide: true },
          { id: 'y', label: 'y' },
        ]}
        activeId="x"
        onSelect={() => {}}
      />,
    )
    expect(document.querySelector('[data-tab-id="x"]')?.hasAttribute('data-tab-wide')).toBe(true)
    expect(document.querySelector('[data-tab-id="y"]')?.hasAttribute('data-tab-wide')).toBe(false)
  })
})

describe('B1:溢出名单是标签条自己的形', () => {
  it('条还没排出盒(jsdom)→ 一格都不报:不画一颗永远按不动的 ⋯', () => {
    const seen: TabsOverflow[] = []
    render(
      <Tabs
        items={[{ id: 'x', label: 'x' }]}
        activeId="x"
        onSelect={() => {}}
        onOverflow={(state) => seen.push(state)}
      />,
    )
    // jsdom 里所有矩形恒 0 → `clippedTabIds` 答空 → 与 `seen` 的初值相同,不报。
    expect(seen).toHaveLength(0)
  })

  it('注册表:同一份名单不重复写(引用恒等),`forget` 摘干净', () => {
    const reveal = () => {}
    const store = useLeafOverflowStore.getState()
    store.report('leaf-1', { ids: ['a', 'b'], reveal })
    const first = useLeafOverflowStore.getState().byLeaf['leaf-1']
    store.report('leaf-1', { ids: ['a', 'b'], reveal })
    /*
     * **反证**:把 `report` 里那句 `sameIds(...) && now.reveal === ...` 拆掉 →
     * 下面这句读到两个不同的对象,而屏幕上那颗 ⋯ 会跟着条的每一次滚动重渲。
     */
    expect(useLeafOverflowStore.getState().byLeaf['leaf-1']).toBe(first)
    store.report('leaf-1', { ids: ['a'], reveal })
    expect(useLeafOverflowStore.getState().byLeaf['leaf-1']?.ids).toEqual(['a'])
    store.forget('leaf-1')
    expect(useLeafOverflowStore.getState().byLeaf['leaf-1']).toBeUndefined()
  })
})

describe('B7 / B11:两格标签的关与拆', () => {
  /** 摆好「中央区一条条:会话 / a / b」,活动格 = a。 */
  function seed(): string {
    st().openRef(doc('a'))
    useWorkbenchStore.getState().openRef(doc('b'))
    const leaf = onlyLeaf()
    useWorkbenchStore.getState().activateTab(leaf.id, 1)
    return leaf.id
  }

  it('格头 ✕ 只关这一格:另一格原位变回一格标签,被关那格丢实例', async () => {
    const leafId = seed()
    act(() => useWorkbenchStore.getState().pairRefs(leafId, 1, doc('b'), 'right'))
    expect(refIdsOf(center())).toEqual(['talk:first', refId(pairRefOf(doc('a'), doc('b')))])

    await act(async () => {
      closePairSide(leafId, 1, 'right')
      await Promise.resolve()
    })
    expect(refIdsOf(center())).toEqual(['talk:first', 'doc:a'])
    expect(disposed).toEqual(['doc:b'])
  })

  it('格头 ✕ 走的是「拆开 + 关掉」两只现成动作:那格 pair 的分栏比例不留尾', async () => {
    const leafId = seed()
    act(() => useWorkbenchStore.getState().pairRefs(leafId, 1, doc('b'), 'right'))
    const pairId = refId(pairRefOf(doc('a'), doc('b')))
    act(() => useWorkbenchStore.getState().setPairRatio(pairId, 70))
    expect(useWorkbenchStore.getState().pairRatios[pairId]).toBe(70)

    await act(async () => {
      closePairSide(leafId, 1, 'right')
      await Promise.resolve()
    })
    /*
     * **反证**(09-06 审查逮到的那笔账):把 `closePairSide` 换回修前那一句
     * `live.replaceRef(leafId, tab, staying)` → 下面这一句读到 70。`replaceRef`
     * 的非复合那条路不归一 `pairRatios`,于是表里躺着一格谁也不认识的比例,
     * 下次同样两格再并起来会读到这份陈年的比例 —— 同一件事两套记账的长相。
     */
    expect(useWorkbenchStore.getState().pairRatios[pairId]).toBeUndefined()
    expect(refIdsOf(center())).toEqual(['talk:first', 'doc:a'])
  })

  it('判据借给 `canDetachTab`:两格里那格常驻的关不掉(T0 拍点 2)', () => {
    const leafId = seed()
    // 把**唯一那格会话**并进来:它此刻是这个区域里最后一格常驻的。
    act(() => useWorkbenchStore.getState().pairRefs(leafId, 1, talk('first'), 'left'))
    const at = onlyLeaf().tabs.findIndex((ref) => ref.kind === pairContentKind.id)
    /*
     * **反证**:把 `canClosePairSide` 换成 `() => true` → 下面第一句变绿,
     * 而屏幕上那条唯一的会话会被一颗 ✕ 关掉。
     */
    expect(canClosePairSide(center(), leafId, at, 'left', CENTER_REGION)).toBe(false)
    expect(canClosePairSide(center(), leafId, at, 'right', CENTER_REGION)).toBe(true)
  })

  /*
   * ── U3(2026-09-08 报障「放进去之后关不掉」)──────────────────────────────
   * 同一格两格标签,搬到架子上就**两格都关得掉** —— 守卫只在常驻那一种自述的家
   * (中央区)里成立,架子上那一格是客。
   *
   * **反证**:把 `canDetachTab` 里那句 `?.resident?.region === region` 换回
   * `?.resident` → 下面第一句当场红(架子上那格会话被判成「最后一格常驻」)。
   */
  it('同一格两格标签搬到架子上就两格都关得掉(U3:守卫只在家里成立)', () => {
    const shelf = edgeRegion('left')
    act(() => {
      useWorkbenchStore.setState((s) => ({
        regions: {
          ...s.regions,
          [shelf]: makeLeaf('SL1', [pairRefOf(talk('guest'), doc('z'))], 0),
        },
      }))
    })
    const tree = useWorkbenchStore.getState().regions[shelf]
    expect(canClosePairSide(tree, 'SL1', 0, 'left', shelf)).toBe(true)
    expect(canClosePairSide(tree, 'SL1', 0, 'right', shelf)).toBe(true)
  })

  it('拆开之后焦点进**左格**(它留在原标签)', () => {
    const leafId = seed()
    act(() => useWorkbenchStore.getState().pairRefs(leafId, 1, doc('b'), 'right'))
    const tries: string[] = []
    const spy = vi.spyOn(focusTree, 'activateScope').mockImplementation((_scope, opts) => {
      if (opts?.owner) tries.push(opts.owner)
      return true
    })
    vi.useFakeTimers()
    act(() => unpairTab(leafId, 1))
    /*
     * `focusIntoRefAfterCommit` 排一拍微任务 + 一帧。**反证**:把 `unpairTab`
     * 末尾那一句删掉 → 下面这句读到空数组(焦点掉在叶容器上,正是 B11 报的病)。
     */
    return Promise.resolve().then(() => {
      vi.useRealTimers()
      expect(tries).toContain('doc:a')
      spy.mockRestore()
    })
  })
})

describe('A12:中央区空态', () => {
  it('那棵树被剪成 null → 画空态与一颗「新建会话」,不再是一片白', () => {
    render(<CenterRegion />)
    act(() => useWorkbenchStore.setState({ regions: {} }))
    /*
     * **反证**:把 `CenterRegion` 那句 `return <CenterEmpty />` 换回 `return null`
     * → 下面两句都读不到东西,而屏幕上是一整块白。
     */
    expect(screen.getByTestId('center-empty')).toBeTruthy()
    expect(screen.getByTestId('center-empty-new')).toBeTruthy()
  })
})

describe('B12:关不掉的那一格要说话', () => {
  /** 播报口(全应用一个,module 级懒挂在 body 末尾)。 */
  const spoken = () => document.querySelector('[data-live="polite"]')?.textContent ?? ''
  /** `announce` 先清空、下一个宏任务再写(读屏要两次差分才重念),所以要走一拍。 */
  const settleAnnounce = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))))

  beforeEach(() => {
    const slot = document.querySelector('[data-live="polite"]')
    if (slot) slot.textContent = ''
  })

  /**
   * 屏幕上那颗 ✕ 对这一格是**不画**的,所以走到这条路的只可能是**键盘**
   * (⌘W / Delete)—— 而键盘那条路从前是一次**静默的空动作**:真机读数
   * 「before 5 / after 5」,人听不出是坏了还是不许。
   *
   * **反证**:把 `useCloseLeafTab` 里那三句(取树 → `canDetachTab` → `announce`)
   * 删掉 → 下面第二句读到空串,也就是修前那一态。
   */
  it('最后一格常驻的关不掉:那一格还在,而且**说了一句话**', async () => {
    const leaf = onlyLeaf()
    const at = leaf.tabs.findIndex((ref) => ref.kind === 'talk')
    expect(at).toBeGreaterThanOrEqual(0)
    const { result } = renderHook(() => useCloseLeafTab(onlyLeaf()))
    await act(async () => {
      await result.current(at)
    })
    expect(refIdsOf(center())).toContain('talk:first')
    await settleAnnounce()
    expect(spoken()).toMatch(/关不掉/)
  })

  /**
   * 另一半:关得掉的那一格照旧关掉,而且**一个字都不说** —— 播报是「被拒绝」
   * 那一刻的话,不是每次关标签的旁白。
   */
  it('关得掉的那一格:照旧关掉,一个字都不说', async () => {
    act(() => st().openRef(doc('a')))
    const leaf = onlyLeaf()
    const at = leaf.tabs.findIndex((ref) => refId(ref) === 'doc:a')
    const { result } = renderHook(() => useCloseLeafTab(onlyLeaf()))
    await act(async () => {
      await result.current(at)
    })
    expect(refIdsOf(center())).not.toContain('doc:a')
    await settleAnnounce()
    expect(spoken()).toBe('')
  })
})
