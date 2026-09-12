import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CenterRegion } from '../CenterRegion'
import { TopBarLeafActions, TopBarLeafTabs } from '../TopBarTabs'
import { CENTER_REGION } from '../regions'
import { registerContentKind, refId, resetContentKinds } from '../kinds'
import { startWorkbench, useWorkbenchStore } from '../store'
import { leavesOf, refIdsOf } from '../tree'
import { useLiveTitleStore } from '../../stage/live-title'
import { useStageStore } from '../../stage/store'
import { focusTree } from '../../focus/registry'
import { FOCUS_SCOPES } from '../../focus/scopes'
import { FocusDispatchHarness } from '../../test/focus-harness'
import type { ContentRef } from '../kinds'
import { pinMacUserAgent } from '../../test/mac-ua'

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
  /* T1-fix:这一组拿 mac 的词写(⌘…),而 jsdom 的 UA 不是 mac ——
   * 判词整段在 `src/test/mac-ua.ts` 上。 */
  pinMacUserAgent()
  useStageStore.setState({ locale: 'zh' })
  resetContentKinds()
  closed = []
  answer = 'close'
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

/**
 * **檐与身分居两处了**(W1-b,设计 §2.2 D 稿):tab 条画在窗口顶栏上
 * (`TopBarLeafTabs`),身留在中央区那棵树里(`CenterRegion`)。所以夹具要把
 * 两半都摆上台 —— 只挂一半的话,量的就不是用户看见的那台机器。
 *
 * 摆的**顺序照真机**(顶栏在前、中央区在后):`leaf-geometry` 的取件口是
 * `document.querySelector`,而 DOM 插入发生在 React 提交的 mutation 相位、早于
 * 任何 layout effect —— 顺序在这里不该有影响,把它摆成真机的样子正是为了让
 * 「哪天它有影响了」这件事在用例里也现形。
 */
function renderCenter() {
  return render(
    <>
      <FocusDispatchHarness />
      <TopBarLeafActions />
      <TopBarLeafTabs />
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

  it('W1-b:那条檐画在顶栏那条带上,**叶身上零檐**(设计 §2.2 D 稿)', () => {
    act(() => store().openRef(doc('a')))
    renderCenter()
    const leaf = document.querySelector('[data-pane-leaf]')!
    const band = screen.getByTestId('topbar-tabs')
    // 叶身上一条 tablist 都没有 —— 聊天区里一个像素的檐都不画。
    expect(leaf.querySelectorAll('[role="tablist"]')).toHaveLength(0)
    expect(leaf.querySelectorAll('[data-pane-chrome]')).toHaveLength(0)
    // 那一条整条在带子里,而且**认得出它是哪片叶的**(组的取件口 = 叶 id)。
    const group = band.querySelector(`[data-topbar-leaf="${leaf.getAttribute('data-pane-leaf')}"]`)!
    expect(group.querySelectorAll('[role="tablist"]')).toHaveLength(1)
    expect(group.getAttribute('data-focus-scope')).toBe('leaf')
  })

  /**
   * **中央区永远一组标签条**(W6-a 单叶政策,设计 §2.1)。从前这里是
   * 「分屏 → 一片叶一组标签,留下来那一组不重挂」;单叶之下那一形在中央区不存在了,
   * 而这一条守它的反面 —— 开多少格、分屏喊多少次,顶栏都只有一组,
   * 而且**那一组的 DOM 节点自始至终是同一个**(它不该因为标签增减而重挂)。
   */
  it('W6-a:中央区永远一组标签条,而且那一组不重挂', () => {
    act(() => store().openRef(doc('a')))
    renderCenter()
    const before = document.querySelector('[data-topbar-leaf]')!
    act(() => {
      store().openRef(doc('b'))
      store().splitLeaf(centerLeaves()[0].id, 'row')
    })
    const groups = Array.from(document.querySelectorAll('[data-topbar-leaf]'))
    expect(groups).toHaveLength(1)
    expect(groups[0]).toBe(before)
  })

  it('W1-b:动作组只画焦点叶那一份(设计 §2.2「右端是焦点叶的动作组」)', () => {
    act(() => {
      store().openRef(doc('a'))
      store().openRef(doc('b'))
    })
    renderCenter()
    const leaf = centerLeaves()[0]
    expect(document.querySelectorAll('[data-pane-actions]')).toHaveLength(1)
    act(() => store().setFocusLeaf(leaf.id))
    expect(document.querySelector('[data-pane-actions]')?.getAttribute('data-pane-actions'))
      .toBe(leaf.id)
    // 焦点指到一片**不存在**的叶上时回落到这个区域的第一片 —— 动作组照旧只有一份。
    act(() => store().setFocusLeaf('nobody'))
    expect(document.querySelector('[data-pane-actions]')?.getAttribute('data-pane-actions'))
      .toBe(leaf.id)
  })

  it('W1-b:「这一组的家」= 种类自述自己常驻(图标上主题色那一格数据)', () => {
    act(() => store().openRef(doc('a')))
    renderCenter()
    // `home` 那一种(注册时声明了 resident)拿到 home 那一格,别的没有。
    expect(tabRow('家').className).toMatch(/tabHome/)
    expect(tabRow('a').className).not.toMatch(/tabHome/)
  })

  /*
   * **型工具条那一格 W7-c 整格退役**(裁定 2:顶栏右端只剩 ⋯ 与 AgentChip)。
   * 这一条从「它挂上去了」翻成「它不在了」——`ContentKind.toolbar` 连声明都没有,
   * 所以判据是**中央叶的檐上零工具位**:一格 `.tool` 都不许长回来。
   * 反证:把 `LeafStrip` 那格 `tool` prop 与它那句 JSX 恢复,这一条当场红。
   */
  it('W7-c:檐上没有型工具条那一格(内容的动作单产地是它自己的右键菜单)', () => {
    act(() => store().openRef(doc('a')))
    renderCenter()
    const chrome = document.querySelector('[data-pane-chrome]') as HTMLElement
    // 檐里只有两格结构:标签条与(有的话)动作组。第三格是那个已经退役的工具位。
    expect(chrome.children.length).toBeLessThanOrEqual(2)
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

describe('tab 上那几格数据', () => {
  /*
   * **预览那一格已退役**(W6-a):从前这里断言「单击开出来的那条是斜体的
   * `TabSpec.preview`,按『保留』之后不再是」。单击与 ↵ 走同一条路之后,屏幕上
   * 再没有「我只是浏览一下」这一态可画 —— 那条断言连同 `.tabPreview` 一起删。
   * 它的反面(连点三次 = 三格)由 `tree.test` 与 `store.test` 各钉一条。
   */

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

  it('⌘W 关当前 tab —— 声明在 `FOCUS_SCOPES.leaf.answers`,落点是叶注入的处理器', async () => {
    act(() => store().openRef(doc('a')))
    renderCenter()
    // 声明这一头。
    expect(FOCUS_SCOPES.leaf.answers?.map((a) => a.command)).toEqual(['tab.close'])
    // 落点那一头:真的挂起来的那个实例交出了同名处理器。
    const leafId = centerLeaves()[0].id
    const node = focusTree.dump().nodes.find((n) => n.scope === 'leaf' && n.owner === leafId)
    expect(node?.keys).toEqual(['tab.close'])
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

  it('开一格新标签:别的标签的内容不重挂', () => {
    act(() => store().openRef(doc('a')))
    renderCenter()
    const kept = screen.getByTestId('doc-body:a')
    act(() => store().openRef(doc('b')))
    expect(leavesOf(store().regions[CENTER_REGION])).toHaveLength(1)
    expect(screen.getByTestId('doc-body:a')).toBe(kept)
  })

  it('关掉一格标签:别的标签的内容不重挂', async () => {
    act(() => {
      store().openRef(doc('a'))
      store().openRef(doc('b'))
    })
    renderCenter()
    const sibling = screen.getByTestId('doc-body:a')
    const leaf = centerLeaves()[0]
    act(() => store().closeTab(leaf.id, leaf.tabs.length - 1))
    await waitFor(() => expect(refIdsOf(store().regions[CENTER_REGION])).not.toContain('doc:b'))
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
