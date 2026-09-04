import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CenterRegion } from '../CenterRegion'
import { TopBarLeafTabs } from '../TopBarTabs'
import { CENTER_REGION } from '../regions'
import { registerContentKind, resetContentKinds } from '../kinds'
import { startWorkbench, useWorkbenchStore } from '../store'
import { spanWVar, spanXVar, topStrips } from '../layout'
import { leavesOf, makeLeaf } from '../tree'
import { useLiveTitleStore } from '../../stage/live-title'
import { useStageStore } from '../../stage/store'
import { focusTree } from '../../focus/registry'
import { FocusDispatchHarness } from '../../test/focus-harness'
import type { ContentRef } from '../kinds'
import type { PaneNode } from '../tree'

/**
 * **中央区的檐就是窗口顶栏**(W1-b,设计 §2.2 D 稿)。
 *
 * 这一组守五件:
 *  ① **落位是纯函数**:一片叶一组,左右分家各自成组,上下重叠按序平分,
 *     退化形(切分里还嵌着切分)宁偏勿叠 —— 顶栏上两组永远不许压在一起;
 *  ② **几何是量出来的**:两格 CSS 变量写在带子自己身上,值是相对带子左缘的偏移;
 *     卸载时抹掉(留着 = 下一次挂载先读到一份陈旧的几何);
 *  ③ **组的算式**把 index/count 折进去,所以「平分」这件事在 CSS 里也成立;
 *  ④ **焦点归属靠 owner**:顶栏那一组与叶身体是**同一个 owner 的两份实例**,
 *     ⌘W 在标签上也接得住;
 *  ⑤ **DOM 留在带子里**(坑 ①:portal 出去 = 静默破拖拽区)。
 */

const leafOf = (id: string) => makeLeaf(id, [{ kind: 'doc', key: id }])
const split = (id: string, dir: 'row' | 'col', a: PaneNode, b: PaneNode): PaneNode => ({
  kind: 'split',
  id,
  dir,
  ratio: 50,
  a,
  b,
})

describe('落位:一片叶一组,重叠的按序平分', () => {
  it('一片叶 = 一组,跨度就是它自己', () => {
    expect(topStrips(leafOf('L1'))).toEqual([
      { leafId: 'L1', spanId: 'L1', index: 0, count: 1 },
    ])
  })

  it('左右分家:两组各跟各的叶,序 = 左到右', () => {
    expect(topStrips(split('S1', 'row', leafOf('L1'), leafOf('L2')))).toEqual([
      { leafId: 'L1', spanId: 'L1', index: 0, count: 1 },
      { leafId: 'L2', spanId: 'L2', index: 0, count: 1 },
    ])
  })

  it('上下重叠:并成一组,跨度是那次切分自己那块地,按序平分', () => {
    expect(topStrips(split('S1', 'col', leafOf('L1'), leafOf('L2')))).toEqual([
      { leafId: 'L1', spanId: 'S1', index: 0, count: 2 },
      { leafId: 'L2', spanId: 'S1', index: 1, count: 2 },
    ])
  })

  it('退化形(col 里嵌着 row):整块地按阅读序平分 —— **宁偏勿叠**', () => {
    const tree = split('S1', 'col', leafOf('L1'), split('S2', 'row', leafOf('L2'), leafOf('L3')))
    expect(topStrips(tree)).toEqual([
      { leafId: 'L1', spanId: 'S1', index: 0, count: 3 },
      { leafId: 'L2', spanId: 'S1', index: 1, count: 3 },
      { leafId: 'L3', spanId: 'S1', index: 2, count: 3 },
    ])
  })

  it('两组的区间永不重叠 —— 这是这张表存在的理由', () => {
    // 左右 + 上下混着来:每一片叶恰好出现一次,而共用同一个 spanId 的那几组
    // 各占互不相交的一段(index 唯一 + count 相同)。
    const tree = split(
      'S1',
      'row',
      split('S2', 'col', leafOf('L1'), leafOf('L2')),
      leafOf('L3'),
    )
    const slots = topStrips(tree)
    expect(slots.map((s) => s.leafId)).toEqual(['L1', 'L2', 'L3'])
    const bySpan = new Map<string, number[]>()
    for (const slot of slots) {
      bySpan.set(slot.spanId, [...(bySpan.get(slot.spanId) ?? []), slot.index])
    }
    for (const [, indexes] of bySpan) {
      expect(new Set(indexes).size).toBe(indexes.length)
    }
  })
})

/* ── 挂起来的那一半 ──────────────────────────────────────────────────────── */

const doc = (key: string): ContentRef => ({ kind: 'doc', key })

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  resetContentKinds()
  registerContentKind({
    id: 'home',
    singleton: true,
    resident: { region: CENTER_REGION, key: 'main' },
    regions: [CENTER_REGION],
    title: () => ({ text: '家' }),
    icon: () => 'Layers',
    render: () => <div data-testid="home-body">家</div>,
  })
  registerContentKind({
    id: 'doc',
    singleton: false,
    title: (ref) => ({ text: ref.key }),
    icon: () => 'FileText',
    render: (ref) => <div data-testid={`doc-body:${ref.key}`}>{ref.key}</div>,
  })
  useWorkbenchStore.getState().reset()
  useLiveTitleStore.setState({ titles: {} })
  startWorkbench()
})

afterEach(() => {
  resetContentKinds()
  focusTree.reset()
})

const store = () => useWorkbenchStore.getState()
const centerLeaves = () => leavesOf(store().regions[CENTER_REGION])

function renderBand() {
  return render(
    <>
      <FocusDispatchHarness />
      <TopBarLeafTabs />
      <CenterRegion />
    </>,
  )
}

describe('几何:量出来的两格变量写在带子自己身上', () => {
  /*
   * jsdom 的 `getBoundingClientRect` 恒答全 0,所以**值**没法在这里断言 ——
   * 能断言的是那条链:写了没有、写在谁身上、卸载抹没抹掉、以及**写的是哪几个
   * 节点的跨度**(那正是「上下切分共用一段」的落地)。值那一半归真机门
   * (`npm run gate:drag-region` 量组的 left/width 与叶的矩形对不对得上,≤1px)。
   */
  it('每一个 spanId 各写两格,写在带子上;卸载抹掉', () => {
    act(() => store().openRef(doc('a')))
    const view = renderBand()
    const band = screen.getByTestId('topbar-tabs') as HTMLElement
    const leafId = centerLeaves()[0].id
    expect(band.style.getPropertyValue(spanXVar(leafId))).toBe('0px')
    expect(band.style.getPropertyValue(spanWVar(leafId))).toBe('0px')
    view.unmount()
    expect(band.style.getPropertyValue(spanXVar(leafId))).toBe('')
  })

  it('上下切分:两组共用**同一个** spanId(= 那次切分),只量一次', () => {
    act(() => {
      store().openRef(doc('a'))
      store().openRef(doc('b'))
    })
    renderBand()
    act(() => store().splitLeaf(centerLeaves()[0].id, 'col'))
    const tree = store().regions[CENTER_REGION]
    expect(tree.kind).toBe('split')
    const splitId = tree.kind === 'split' ? tree.id : ''
    const band = screen.getByTestId('topbar-tabs') as HTMLElement
    expect(band.style.getPropertyValue(spanXVar(splitId))).toBe('0px')
    // 叶自己那两格不必写 —— 组读的是切分那一段。
    for (const leaf of centerLeaves()) {
      expect(band.style.getPropertyValue(spanXVar(leaf.id))).toBe('')
    }
  })

  it('取件口在中央区那棵树里(切分那个盒也带 data-pane-span)', () => {
    act(() => {
      store().openRef(doc('a'))
      store().openRef(doc('b'))
    })
    renderBand()
    act(() => store().splitLeaf(centerLeaves()[0].id, 'row'))
    const spans = Array.from(
      document.querySelectorAll(`[data-pane-region="${CENTER_REGION}"] [data-pane-span]`),
    ).map((el) => el.getAttribute('data-pane-span'))
    const tree = store().regions[CENTER_REGION]
    const splitId = tree.kind === 'split' ? tree.id : ''
    expect(spans).toContain(splitId)
    for (const leaf of centerLeaves()) expect(spans).toContain(leaf.id)
  })
})

describe('组的算式:平分折进 calc()', () => {
  it('单叶:count = 1,左缘就是那片叶的左缘', () => {
    renderBand()
    const leafId = centerLeaves()[0].id
    const group = document.querySelector(`[data-topbar-leaf="${leafId}"]`) as HTMLElement
    expect(group.style.getPropertyValue('--tabgrp-x')).toBe(
      `calc(var(${spanXVar(leafId)}, 0px) + var(${spanWVar(leafId)}, 0px) * 0 / 1)`,
    )
    expect(group.style.getPropertyValue('--tabgrp-w')).toBe(
      `calc(var(${spanWVar(leafId)}, 0px) / 1)`,
    )
  })

  it('上下切分:第二组的左缘 = 那一段的一半,宽 = 一半(按序平分)', () => {
    act(() => {
      store().openRef(doc('a'))
      store().openRef(doc('b'))
    })
    renderBand()
    act(() => store().splitLeaf(centerLeaves()[0].id, 'col'))
    const tree = store().regions[CENTER_REGION]
    const splitId = tree.kind === 'split' ? tree.id : ''
    const groups = Array.from(document.querySelectorAll('[data-topbar-leaf]')) as HTMLElement[]
    expect(groups).toHaveLength(2)
    expect(groups[1].style.getPropertyValue('--tabgrp-x')).toBe(
      `calc(var(${spanXVar(splitId)}, 0px) + var(${spanWVar(splitId)}, 0px) * 1 / 2)`,
    )
    expect(groups[1].style.getPropertyValue('--tabgrp-w')).toBe(
      `calc(var(${spanWVar(splitId)}, 0px) / 2)`,
    )
  })
})

describe('焦点归属靠 owner,不靠 DOM 位置', () => {
  it('顶栏那一组登记的是**这片叶**的作用域(同 owner 的第二份实例)', () => {
    renderBand()
    const leafId = centerLeaves()[0].id
    const nodes = focusTree.dump().nodes.filter((n) => n.scope === 'leaf' && n.owner === leafId)
    // 两份:叶身体那一格,与顶栏上它的标签组那一格。少了后者 = 焦点落在标签上时
    // ⌘W 没人接,而屏幕上看不出任何异样。
    expect(nodes).toHaveLength(2)
    for (const node of nodes) expect(node.keys).toEqual(['closeTab'])
  })

  it('焦点摆在顶栏那一组上,⌘W 照样关得掉当前 tab(owner 那第二份实例的用处)', async () => {
    act(() => store().openRef(doc('a')))
    renderBand()
    const leafId = centerLeaves()[0].id
    /*
     * 同一个 owner 下有两份实例(叶身体一份、顶栏那一组一份),而**两份都注入了
     * 同名的那一口** —— 所以 `activateScope` 按 MRU 取到哪一份都不影响结果。
     * 这正是这一格设计要的:焦点在叶里还是在它的标签上,⌘W 都关得掉。
     */
    const nodes = focusTree.dump().nodes.filter((n) => n.scope === 'leaf' && n.owner === leafId)
    expect(nodes).toHaveLength(2)
    for (const node of nodes) expect(node.keys).toEqual(['closeTab'])
    act(() => {
      focusTree.activateScope('leaf', { owner: leafId, reason: 'open' })
    })
    fireEvent.keyDown(window, { key: 'w', metaKey: true })
    await waitFor(() => expect(centerLeaves()[0].tabs.map((ref) => ref.key)).toEqual(['main']))
  })

  it('点标签组 = 它成为焦点叶(「新标签开在哪一片」的答案)', () => {
    act(() => {
      store().openRef(doc('a'))
      store().openRef(doc('b'))
    })
    renderBand()
    act(() => store().splitLeaf(centerLeaves()[0].id, 'row'))
    const [first, second] = centerLeaves()
    act(() => store().setFocusLeaf(first.id))
    const group = document.querySelector(`[data-topbar-leaf="${second.id}"]`) as HTMLElement
    act(() => {
      group.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(store().focusLeafId).toBe(second.id)
  })

  it('悬停一组 → 它下面那片叶亮一圈(data-pane-hint;离开就摘)', () => {
    renderBand()
    const leafId = centerLeaves()[0].id
    const group = document.querySelector(`[data-topbar-leaf="${leafId}"]`) as HTMLElement
    const leaf = document.querySelector(`[data-pane-leaf="${leafId}"]`) as HTMLElement
    /*
     * 派的是 `pointerover` / `pointerout` 而不是 enter / leave:React 的
     * enter/leave 是**从 over/out 推出来的**(它只在根上挂那两条委托监听),
     * 直接派一发不冒泡的 `pointerenter` 谁也收不到 —— 那是一条会「静默绿」的假路。
     */
    fireEvent.pointerOver(group, { relatedTarget: document.body })
    expect(leaf.hasAttribute('data-pane-hint')).toBe(true)
    fireEvent.pointerOut(group, { relatedTarget: document.body })
    expect(leaf.hasAttribute('data-pane-hint')).toBe(false)
  })
})

describe('结构:带子是一个 group,组是它的子孙', () => {
  it('每一组一条 tablist(APG:两片叶是两组互不相干的 tab,不是一组)', () => {
    act(() => {
      store().openRef(doc('a'))
      store().openRef(doc('b'))
    })
    renderBand()
    act(() => store().splitLeaf(centerLeaves()[0].id, 'row'))
    const band = screen.getByTestId('topbar-tabs')
    expect(band.getAttribute('role')).toBe('group')
    expect(band.getAttribute('aria-label')).toBe('中央区标签')
    expect(band.querySelectorAll('[role="tablist"]')).toHaveLength(2)
    // 组都在带子里 —— portal 出去当场静默破拖拽区(坑 ①)。
    for (const group of document.querySelectorAll('[data-topbar-leaf]')) {
      expect(band.contains(group)).toBe(true)
    }
  })
})

describe('ResizeObserver 不在场时照样量(jsdom / 老宿主)', () => {
  it('没有 RO = 只剩「渲染即重量」那一条,不抛', () => {
    const had = 'ResizeObserver' in globalThis
    const original = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
    // 用例环境本来就没有 RO;这一条钉的是「哪天有人补了 polyfill 也不许改行为」。
    const spy = vi.fn()
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = undefined
    try {
      expect(() => renderBand()).not.toThrow()
      expect(spy).not.toHaveBeenCalled()
    } finally {
      if (had) (globalThis as { ResizeObserver?: unknown }).ResizeObserver = original
      else delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
    }
  })
})
