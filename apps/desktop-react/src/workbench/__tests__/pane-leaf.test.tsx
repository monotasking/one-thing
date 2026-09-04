import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CenterRegion } from '../CenterRegion'
import { CENTER_REGION } from '../regions'
import { registerContentKind, refId, resetContentKinds } from '../kinds'
import { startWorkbench, useWorkbenchStore } from '../store'
import { leavesOf } from '../tree'
import { useLiveTitleStore } from '../../stage/live-title'
import { useStageStore } from '../../stage/store'
import { focusTree } from '../../focus/registry'
import { FOCUS_SCOPES } from '../../focus/scopes'
import { FocusDispatchHarness } from '../../test/focus-harness'
import type { ContentRef } from '../kinds'

/**
 * **叶檐**(W1,设计 §2.2 / §10 的 `PaneLeaf` 三张状态表)。
 *
 * 这一组守六件:
 *  ① 一片叶只有一条檐,那条檐就是 tab 条(内容自己不画檐);
 *  ② 单 tab 退化成身份带 —— **同一条 tab 条**,不是第二个组件;
 *  ③ 预览斜体、未保存丸、常驻那一格不画 ✕(三格都是 `TabSpec` 上的数据);
 *  ④ 非活动 tab **inert 说两遍**(DOM 一遍、树一遍,同一个判据);
 *  ⑤ ⌘W 关当前 tab(面域局部键,声明在 `FOCUS_SCOPES.leaf.keys`);
 *  ⑥ **零重挂**:分屏 / 并 tab / 关叶不重挂兄弟叶(判据是元素同一性)。
 *
 * 用例里注册的是**假种类**,与 `store.test.ts` 同一条理由:核心层不认识
 * 任何一种内容,测试也不该靠真种类的名字来读懂。
 */

const doc = (key: string): ContentRef => ({ kind: 'doc', key })
let closed: string[] = []
let answer: 'close' | 'cancel' = 'close'

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  resetContentKinds()
  closed = []
  answer = 'close'
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
    toolbar: (ref) => <span data-testid={`doc-tool:${ref.key}`} />,
    beforeClose: () => Promise.resolve(answer),
    dispose: (ref) => closed.push(refId(ref)),
  })
  useWorkbenchStore.getState().reset()
  useLiveTitleStore.setState({ titles: {} })
  startWorkbench()
})

afterEach(() => {
  resetContentKinds()
  focusTree.reset()
})

function renderCenter() {
  return render(
    <>
      <FocusDispatchHarness />
      <CenterRegion />
    </>,
  )
}

const store = () => useWorkbenchStore.getState()
const centerLeaves = () => leavesOf(store().regions[CENTER_REGION])
const tabRow = (label: string) =>
  screen.getAllByRole('tab').find((el) => el.textContent?.includes(label))!

describe('一格一檐:叶檐就是 tab 条', () => {
  it('内容自己不画檐 —— 屏幕上这一片叶只有一条 tablist', () => {
    act(() => store().openRef(doc('a')))
    renderCenter()
    expect(screen.getAllByRole('tablist')).toHaveLength(1)
    expect(screen.getByTestId('home-body')).toBeTruthy()
  })

  it('型工具条由种类自述,叶檐把它挂进动作组(活动那一格的)', () => {
    act(() => store().openRef(doc('a')))
    renderCenter()
    expect(screen.getByTestId('doc-tool:a')).toBeTruthy()
    // 换到没有工具条的那一格 → 整格不画,不留一段空 gap。
    act(() => store().activateTab(centerLeaves()[0].id, 0))
    expect(screen.queryByTestId('doc-tool:a')).toBeNull()
  })

  it('单 tab = 身份带:同一条 tab 条,只是多一格 `data-single`', () => {
    renderCenter()
    const chrome = document.querySelector('[data-pane-chrome]')!
    expect(chrome.getAttribute('data-single')).toBe('true')
    act(() => store().openRef(doc('a')))
    // **不是换一个组件** —— 同一个 DOM 节点,只是那一格属性没了。
    expect(document.querySelector('[data-pane-chrome]')).toBe(chrome)
    expect(chrome.getAttribute('data-single')).toBeNull()
  })
})

describe('tab 上那三格数据', () => {
  it('预览那一条走 `TabSpec.preview`(斜体那一格由 CSS 画)', () => {
    act(() => store().openRef(doc('a'), { preview: true }))
    renderCenter()
    const leaf = centerLeaves()[0]
    expect(leaf.preview).toBe('doc:a')
    // 数据表里那一格翻了,画法归 `ui/Tabs` 的 `.tabPreview`。
    expect(tabRow('a').className).toMatch(/tabPreview/)
    act(() => store().pinTab(leaf.id, 1))
    expect(tabRow('a').className).not.toMatch(/tabPreview/)
  })

  it('未保存丸读 `live-title` 那一格(内容自己发布,活的盖静的)', () => {
    act(() => store().openRef(doc('a')))
    renderCenter()
    expect(document.querySelector('[data-tab-dirty]')).toBeNull()
    act(() => useLiveTitleStore.getState().setLiveTitle('doc:a', { text: 'a', dirty: true }))
    expect(within(tabRow('a')).getByText('a')).toBeTruthy()
    expect(tabRow('a').querySelector('[data-tab-dirty]')).toBeTruthy()
  })

  it('常驻那一种的最后一格**不画 ✕**(不是画出来再禁灰)', () => {
    act(() => store().openRef(doc('a')))
    renderCenter()
    const home = tabRow('家')
    expect(home.querySelector('[class*="close"]')).toBeNull()
    expect(tabRow('a').querySelector('[class*="close"]')).toBeTruthy()
  })
})

describe('关一格:先问种类,答 close 才真关', () => {
  it('`beforeClose` 答 close → 摘掉并 dispose', async () => {
    act(() => store().openRef(doc('a')))
    renderCenter()
    fireEvent.click(tabRow('a').querySelector('[class*="close"]')!)
    await waitFor(() => expect(closed).toEqual(['doc:a']))
    expect(centerLeaves()[0].tabs.map(refId)).toEqual(['home:main'])
  })

  it('`beforeClose` 答 cancel → 树一个字不动', async () => {
    answer = 'cancel'
    act(() => store().openRef(doc('a')))
    renderCenter()
    fireEvent.click(tabRow('a').querySelector('[class*="close"]')!)
    await new Promise((r) => setTimeout(r, 0))
    expect(closed).toEqual([])
    expect(centerLeaves()[0].tabs.map(refId)).toEqual(['home:main', 'doc:a'])
  })

  it('⌘W 关当前 tab —— 声明在 `FOCUS_SCOPES.leaf.keys`,落点是叶注入的处理器', async () => {
    act(() => store().openRef(doc('a')))
    renderCenter()
    // 声明这一头。
    expect(FOCUS_SCOPES.leaf.keys?.map((k) => k.action)).toEqual(['closeTab'])
    // 落点那一头:真的挂起来的那个实例交出了同名处理器。
    const leafId = centerLeaves()[0].id
    const node = focusTree.dump().nodes.find((n) => n.scope === 'leaf' && n.owner === leafId)
    expect(node?.keys).toEqual(['closeTab'])
    // 焦点摆进这片叶,再按下去。
    act(() => {
      focusTree.activateScope('leaf', { owner: leafId, reason: 'open' })
    })
    fireEvent.keyDown(window, { key: 'w', metaKey: true })
    await waitFor(() => expect(closed).toEqual(['doc:a']))
  })
})

describe('非活动 tab:inert 说两遍,同一个判据', () => {
  it('DOM 一遍(`inert` 属性)、树一遍(`FocusScope inert`)', () => {
    act(() => store().openRef(doc('a')))
    renderCenter()
    const layers = Array.from(document.querySelectorAll('[data-pane-tab]'))
    const on = layers.find((el) => el.getAttribute('data-pane-tab') === 'doc:a')!
    const off = layers.find((el) => el.getAttribute('data-pane-tab') === 'home:main')!
    // DOM 那一遍。
    expect(on.hasAttribute('inert')).toBe(false)
    expect(off.hasAttribute('inert')).toBe(true)
    // 树那一遍 —— 少了它,后台那格照样能被算成第一响应者。
    const nodes = focusTree.dump().nodes
    expect(nodes.find((n) => n.owner === 'doc:a')?.inert).toBe(false)
    expect(nodes.find((n) => n.owner === 'home:main')?.inert).toBe(true)
  })

  it('后台那一层**还挂着**(keep-alive):切走再切回来不重建', () => {
    act(() => store().openRef(doc('a')))
    renderCenter()
    const home = screen.getByTestId('home-body')
    act(() => store().activateTab(centerLeaves()[0].id, 0))
    // 切回去之后还是同一个 DOM 节点 —— 它从来没被卸载过。
    expect(screen.getByTestId('home-body')).toBe(home)
  })
})

describe('零重挂:分屏 / 并 tab / 关叶不重挂兄弟叶', () => {
  it('并一格 tab:已经在场的那一格内容不重挂', () => {
    act(() => store().openRef(doc('a')))
    renderCenter()
    const before = screen.getByTestId('doc-body:a')
    act(() => store().openRef(doc('b')))
    expect(screen.getByTestId('doc-body:a')).toBe(before)
  })

  it('分屏:留在原叶的那些内容不重挂', () => {
    act(() => {
      store().openRef(doc('a'))
      store().openRef(doc('b'))
    })
    renderCenter()
    const kept = screen.getByTestId('doc-body:a')
    act(() => store().splitLeaf(centerLeaves()[0].id, 'row'))
    expect(leavesOf(store().regions[CENTER_REGION])).toHaveLength(2)
    expect(screen.getByTestId('doc-body:a')).toBe(kept)
  })

  it('关掉一整片叶:兄弟叶里的内容不重挂', async () => {
    act(() => {
      store().openRef(doc('a'))
      store().openRef(doc('b'))
    })
    renderCenter()
    act(() => store().splitLeaf(centerLeaves()[0].id, 'row'))
    const sibling = screen.getByTestId('doc-body:a')
    const fresh = centerLeaves()[1]
    act(() => store().closeTab(fresh.id, 0))
    await waitFor(() => expect(leavesOf(store().regions[CENTER_REGION])).toHaveLength(1))
    expect(screen.getByTestId('doc-body:a')).toBe(sibling)
  })
})

describe('超量:30 个 tab 永不换行(挤压纪律)', () => {
  it('tab 条横滚,不换行 —— 30 格都在一条 tablist 里', () => {
    act(() => {
      for (let i = 0; i < 30; i += 1) store().openRef(doc(`f${i}`))
    })
    renderCenter()
    expect(screen.getAllByRole('tab')).toHaveLength(31)
    expect(screen.getAllByRole('tablist')).toHaveLength(1)
  })
})
