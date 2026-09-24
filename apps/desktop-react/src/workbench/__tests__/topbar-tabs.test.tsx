import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CenterRegion } from '../CenterRegion'
import { TopBarLeafTabs } from '../TopBarTabs'
import { CENTER_REGION } from '../regions'
import { registerContentKind, resetContentKinds } from '../kinds'
import { startWorkbench, useWorkbenchStore } from '../store'
import { topStrips } from '../layout'
import { leavesOf, makeLeaf } from '../tree'
import { useLiveTitleStore } from '../../stage/live-title'
import { useStageStore } from '../../stage/store'
import { focusTree } from '../../focus/registry'
import { FocusDispatchHarness } from '../../test/focus-harness'
import type { ContentRef } from '../kinds'
import type { PaneNode } from '../tree'
import { pinMacUserAgent } from '../../test/mac-ua'

/**
 * **中央区的檐就是窗口顶栏**(W1-b,设计 §2.2 D 稿)。
 *
 * 这一组守五件:
 *  ① **落位是纯函数**:一片叶一组,左右分家各自成组,上下重叠按序平分,
 *     退化形(切分里还嵌着切分)宁偏勿叠 —— 顶栏上两组永远不许压在一起;
 *  ② **标签从顶栏自己的开头排**(W7-c 裁定 1):组是带子里的普通 flex 项,
 *     身上没有任何行内几何 —— 从前那两格 `--tabgrp-x/w` 与量它们的
 *     `leaf-geometry.ts` 一起退役了;
 *  ③ **中央区永远一组**(W6-a 单叶政策):开几格标签、切几次都只有一条标签条;
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
  /* T1-fix:这一组拿 mac 的词写(⌘…),而 jsdom 的 UA 不是 mac ——
   * 判词整段在 `src/test/mac-ua.ts` 上。 */
  pinMacUserAgent()
  useStageStore.setState({ locale: 'zh' })
  resetContentKinds()
  registerContentKind({
    id: 'home',
    singleton: true,
    resident: { region: CENTER_REGION, seed: () => 'main' },
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

describe('标签从顶栏自己的开头排(W7-c 裁定 1)', () => {
  /*
   * W1-b 到 W6 之间这一组守的是**几何链**:`leaf-geometry.ts` 量出叶的跨度、
   * 写成两格 CSS 变量、组读 `calc()` 坐上去、卸载抹掉。v3 把中央区收成一条
   * 标签条之后「对准哪片叶」没有对象了(屏幕上只有一组),那条链整条删掉 ——
   * 它同时是 `gate:perf` ⑤a 第 4 次强制排版的来源(W6-p 留账)。
   *
   * 于是这一组改守它的反面:**组身上一格行内几何都没有**,以及那两格变量
   * 与它们的取件口在 DOM 上彻底不在场。反证:把 `useLeafGeometry` 那只 hook
   * 与 `--tabgrp-*` 恢复回去,下面三条一起红。
   */
  it('组身上没有行内 style(几何不再经过 JS)', () => {
    act(() => store().openRef(doc('a')))
    renderBand()
    const leafId = centerLeaves()[0].id
    const group = document.querySelector(`[data-topbar-leaf="${leafId}"]`) as HTMLElement
    expect(group.getAttribute('style')).toBeNull()
    expect(group.style.getPropertyValue('--tabgrp-x')).toBe('')
    expect(group.style.getPropertyValue('--tabgrp-w')).toBe('')
  })

  it('带子身上没有跨度读数(`--leaf-x-*` / `--leaf-w-*` 整族退役)', () => {
    act(() => store().openRef(doc('a')))
    renderBand()
    const band = screen.getByTestId('topbar-tabs') as HTMLElement
    const leafId = centerLeaves()[0].id
    expect(band.style.getPropertyValue(`--leaf-x-${leafId}`)).toBe('')
    expect(band.style.getPropertyValue(`--leaf-w-${leafId}`)).toBe('')
    expect(band.getAttribute('style')).toBeNull()
  })

  it('中央区那棵树上没有跨度取件口(`data-pane-span` 删了)', () => {
    act(() => {
      store().openRef(doc('a'))
      store().openRef(doc('b'))
    })
    renderBand()
    expect(
      document.querySelectorAll(`[data-pane-region="${CENTER_REGION}"] [data-pane-span]`),
    ).toHaveLength(0)
    expect(centerLeaves()).toHaveLength(1)
  })
})

describe('中央区永远一组(单叶政策)', () => {

  /**
   * **一片叶一组,分了屏零组**(09-24:单叶政策撤了,分屏后每片叶自带标签条,
   * 判据 `layout.centerStripOnTopBar`)。开多少格标签顶栏都只有一条;一分屏它就让开。
   */
  it('一片叶时一组;分屏之后顶栏一组都不画', () => {
    act(() => {
      store().openRef(doc('a'))
      store().openRef(doc('b'))
    })
    renderBand()
    const one = Array.from(document.querySelectorAll('[data-topbar-leaf]')) as HTMLElement[]
    expect(one).toHaveLength(1)
    expect(one[0].getAttribute('style')).toBeNull()
    act(() => store().splitLeaf(centerLeaves()[0].id, 'col'))
    expect(document.querySelectorAll('[data-topbar-leaf]')).toHaveLength(0)
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
    for (const node of nodes) expect(node.keys).toContain('tab.close')
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
    for (const node of nodes) expect(node.keys).toContain('tab.close')
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
    const leafId = centerLeaves()[0].id
    // 焦点叶先指到一个**不存在**的叶上,再点这一组 —— 它把指针拉回来。
    act(() => store().setFocusLeaf('nobody'))
    const group = document.querySelector(`[data-topbar-leaf="${leafId}"]`) as HTMLElement
    act(() => {
      group.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(store().focusLeafId).toBe(leafId)
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
  it('一组一条 tablist(W6-a:中央区永远一组,所以恒是一条)', () => {
    act(() => {
      store().openRef(doc('a'))
      store().openRef(doc('b'))
    })
    renderBand()
    const band = screen.getByTestId('topbar-tabs')
    expect(band.getAttribute('role')).toBe('group')
    expect(band.getAttribute('aria-label')).toBe('中央区标签')
    expect(band.querySelectorAll('[role="tablist"]')).toHaveLength(1)
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
