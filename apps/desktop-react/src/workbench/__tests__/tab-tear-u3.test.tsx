import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { residentRefusal, useTabDrag } from '../useTabDrag'
import { registerContentKind, refId, resetContentKinds } from '../kinds'
import { CENTER_REGION, edgeRegion } from '../regions'
import { makeLeaf } from '../tree'
import { useWorkbenchStore } from '../store'
import { Tabs } from '../../ui/Tabs'
import { resetDragSession } from '../../ui/drag'
import { focusTree } from '../../focus/registry'
import type { ContentRef } from '../kinds'
import type { DropTarget } from '../drop'
import type { PaneLeafNode } from '../tree'

/*
 * **jsdom 里没有 `CSS` 这个全局**,而 `useTabDrag` 认那一格 tab 元素时要
 * `CSS.escape` —— 补的是**环境**不是产品(判词与 `tab-gesture-u2.test.tsx` 逐字同源)。
 */
if (typeof globalThis.CSS === 'undefined') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => String(value).replace(/["\\]/g, '\\$&') },
  })
}

/**
 * **中央区最后一格常驻内容撕不走,而且要说出口**(U3,2026-09-08)。
 *
 * 被测的是 `useTabDrag` 的 `rules.accepts` 那一只判据(`residentRefusal`)——
 * 它是「这一下会不会把常驻那一格带离它的家」的**唯一产地**,而判据本体借的是
 * `store.canDetachTab`(种类自述的 `resident`),不新写一条。
 *
 * 夹具里的种类叫 `home` / `doc`,不是 `session` / `file`:这一组守的是**判据**,
 * 换成真名字会把读者引向「它认识会话」那个错的直觉。
 *
 * **反证**:把 `useTabDrag` 那一格 `rules` 整个摘掉 → 前四条全红(每一条都答成
 * 「放行」);把 `residentRefusal` 里那句 `to === region ? null : …` 反过来 →
 * 「条内换序放行」与「落回自己那片叶放行」当场红。
 */

const home = (key: string): ContentRef => ({ kind: 'home', key })
const doc = (key: string): ContentRef => ({ kind: 'doc', key })

const CENTER_LEAF = 'C1'
const SHELF_LEAF = 'S1'

beforeEach(() => {
  resetContentKinds()
  registerContentKind({
    id: 'home',
    singleton: false,
    // **家在中央区** —— 守卫成立与否问的就是这一格自述(`resident.region`)。
    resident: { region: CENTER_REGION, seed: () => 'main' },
    title: (ref) => ({ text: ref.key }),
    icon: () => 'Layers',
    render: () => null,
  })
  registerContentKind({
    id: 'doc',
    singleton: false,
    title: (ref) => ({ text: ref.key }),
    icon: () => 'File',
    render: () => null,
  })
  useWorkbenchStore.getState().reset()
})

/** 中央区一片叶 [home:main, doc:a],左架子一片叶 [doc:b]。 */
function seed(tabs: ContentRef[] = [home('main'), doc('a')]): PaneLeafNode {
  const leaf = makeLeaf(CENTER_LEAF, tabs, 0)
  useWorkbenchStore.setState({
    regions: {
      [CENTER_REGION]: leaf,
      [edgeRegion('left')]: makeLeaf(SHELF_LEAF, [doc('b')], 0),
    },
    hidden: [],
    focusLeafId: leaf.id,
    dragging: false,
  })
  return leaf
}

/** 拖的是中央区那一格常驻内容。 */
const dragHome = (leaf: PaneLeafNode, target: DropTarget) =>
  residentRefusal(leaf, refId(home('main')), target)

describe('中央区最后一格常驻内容:撕出去拒绝,条内换序放行(U3)', () => {
  it('撕到架子 = 拒绝,而且说得出理由', () => {
    const leaf = seed()
    expect(dragHome(leaf, { kind: 'edge', side: 'left' })).toBe('drag.refuseResidentLeave')
  })

  it('撕成浮窗 = 拒绝(窗号还没铸,判据问的是「浮窗这一类」)', () => {
    const leaf = seed()
    expect(dragHome(leaf, { kind: 'float' })).toBe('drag.refuseResidentLeave')
  })

  it('落到别人那条条上 = 拒绝(它会把这一格搬进那片叶所在的区域)', () => {
    const leaf = seed()
    expect(dragHome(leaf, { kind: 'strip', leafId: SHELF_LEAF, at: 0 }))
      .toBe('drag.refuseResidentLeave')
  })

  it('落点算不出区域 = 当作离开(指不出地方的落点不该被当成「还在原地」)', () => {
    const leaf = seed()
    expect(dragHome(leaf, { kind: 'strip', leafId: 'nobody', at: 0 }))
      .toBe('drag.refuseResidentLeave')
  })

  it('条内换序放行 —— 它一格区域都没换', () => {
    const leaf = seed()
    expect(dragHome(leaf, { kind: 'strip', leafId: CENTER_LEAF, at: 2 })).toBeNull()
  })

  it('落回自己那片叶(back)放行 —— 那是空动作,连拖都不算数', () => {
    const leaf = seed()
    expect(dragHome(leaf, { kind: 'back' })).toBeNull()
  })

  it('同区域的「开成新标签」/「二合一」放行(区域没变)', () => {
    const leaf = seed()
    expect(dragHome(leaf, { kind: 'open', region: CENTER_REGION, leafId: CENTER_LEAF })).toBeNull()
    expect(
      dragHome(leaf, { kind: 'pair', region: CENTER_REGION, leafId: CENTER_LEAF, side: 'right' }),
    ).toBeNull()
  })

  it('中央区有两格同种时,撕走一格放行(判据与「关得掉」逐字同一只)', () => {
    const leaf = seed([home('main'), home('second')])
    expect(dragHome(leaf, { kind: 'edge', side: 'left' })).toBeNull()
  })

  it('拖的不是常驻那一种 = 一句话都没有(它自己关得掉,当然也挪得走)', () => {
    const leaf = seed()
    expect(residentRefusal(leaf, refId(doc('a')), { kind: 'edge', side: 'left' })).toBeNull()
  })

  it('架子上那一格常驻内容撕得走 —— 守卫只在它自述的家里成立', () => {
    seed()
    const shelfLeaf = makeLeaf(SHELF_LEAF, [home('guest')], 0)
    useWorkbenchStore.setState((st) => ({
      regions: { ...st.regions, [edgeRegion('left')]: shelfLeaf },
    }))
    expect(residentRefusal(shelfLeaf, refId(home('guest')), { kind: 'float' })).toBeNull()
  })
})

/**
 * **这条判据真的接在手势上**(U3 的接线那一半)。
 *
 * 上面那一组测的是判据本身;这一组测的是它**被 `useTabDrag` 的 `rules` 交了出去**
 * —— 少了那一句,判据再对也一个字都到不了屏幕上。判的是屏幕上那格事实:
 * 根元素上的 `data-drag-refuse`(`ui/drag` 写它,`gate:drag` 读的也是它)。
 *
 * jsdom 里所有矩形恒零,所以 `measureDropGeometry()` 交回来的是一份空几何 ——
 * 落点判据的第 ⑧ 档「什么都没碰到 = 撕成浮窗」当场成立,而那正是这一组要的手势:
 * **把中央区那一格常驻内容撕出去**。
 *
 * **反证**:把 `useTabDrag` 那一句 `rules: { accepts: … }` 整格删掉 → 第一条红
 * (撕出去被判成放行,根上没有 `data-drag-refuse`)。
 */
describe('接线:撕出中央区当场变拒绝态(U3)', () => {
  function Harness({ leaf }: { leaf: PaneLeafNode }) {
    const onTabPointerDown = useTabDrag(leaf)
    return (
      <Tabs
        items={leaf.tabs.map((ref) => ({ id: refId(ref), label: refId(ref) }))}
        activeId={refId(leaf.tabs[0])}
        look="joined"
        label="tabs"
        onSelect={() => {}}
        onTabPointerDown={onTabPointerDown}
      />
    )
  }

  /** 三格各 120 宽依次排开、条 34 高(与 `tab-gesture-u2` 那只打桩逐字同形)。 */
  function stubLayout(list: HTMLElement, width = 120): void {
    const tabs = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]'))
    tabs.forEach((el, i) => {
      el.getBoundingClientRect = () =>
        ({ left: i * width, top: 0, width, height: 34, right: (i + 1) * width, bottom: 34 }) as DOMRect
    })
    list.getBoundingClientRect = () =>
      ({
        left: 0, top: 0, width: width * tabs.length, height: 34,
        right: width * tabs.length, bottom: 34,
      }) as DOMRect
  }

  /** 按住第 0 格(常驻那一格),竖向甩出带外 = 撕下。 */
  function tearFirstTab(leaf: PaneLeafNode): void {
    render(<Harness leaf={leaf} />)
    const list = screen.getByRole('tablist')
    stubLayout(list)
    const tab = screen.getAllByRole('tab')[0]
    act(() => {
      tab.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 60, clientY: 17 }),
      )
      // 34 + 24 = 58 是带的下沿,200 稳稳在带外。
      tab.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 60, clientY: 200 }))
    })
  }

  const refusing = () => document.documentElement.hasAttribute('data-drag-refuse')

  afterEach(() => {
    act(() => resetDragSession())
    focusTree.reset()
  })

  it('中央区唯一那格常驻内容撕出去 = 拒绝态', () => {
    tearFirstTab(seed())
    expect(refusing()).toBe(true)
  })

  it('中央区有两格同种时,同一个手势放行(读数不是恒真)', () => {
    tearFirstTab(seed([home('main'), home('second')]))
    expect(refusing()).toBe(false)
  })

  it('拖的不是常驻那一种时放行', () => {
    const leaf = seed([doc('a'), home('main')])
    tearFirstTab(leaf)
    expect(refusing()).toBe(false)
  })
})
