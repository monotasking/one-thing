import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { LeafStrip } from '../LeafStrip'
import { useTabDrag } from '../useTabDrag'
import { makeLeaf } from '../tree'
import { registerContentKind, resetContentKinds } from '../kinds'
import { useWorkbenchStore } from '../store'
import { Tabs } from '../../ui/Tabs'
import { resetDragSession } from '../../ui/drag'
import { focusTree } from '../../focus/registry'
import type { ContentRef } from '../kinds'
import type { TabSpec } from '../../ui/Tabs'

/**
 * **拖拽 v4(二/五):标签自身的手势**(U2,2026-09-08,用户 09-08 拍板)。
 *
 * 这只文件守两件在 jsdom 里就是事实的东西 —— 像素与时序那一半归 `gate:drag`
 * (08-30 判例:交互时序类改动必须真机对照):
 *  ① **只有主键才激活那一格**:右键 / 中键按下去不切标签(Chrome 与 VS Code 都
 *     不切;W6-c 交卷时那条待拍就此了结);
 *  ② **取消 = 150ms 滑回,不是瞬移**:Esc / pointercancel / 窗口失焦**三条路**
 *     都走编舞的 `settle()`,而且**先量后收**(reset 之前量它在手上的左缘)。
 *     U2 之前 `endGesture` 只 `reset()` 不 `settle()` —— 真机探针读到的是 5ms
 *     到家、连一次 `data-settle` 都没挂过。
 *
 * jsdom 里 `getBoundingClientRect` 恒答零,所以两件事自己喂:几何打桩(与
 * `ui/__tests__/tabs-joined.test.tsx` 的 `stubLayout` 同一手),编舞包一层记账
 * (`vi.mock` + `importOriginal`,**真的那一只照跑** —— 记的是调用序,断的不是
 * 一个替身的行为)。
 */

/*
 * **jsdom 里没有 `CSS` 这个全局**(`ui/tab-reorder` 文件头点过名的那颗延时雷),
 * 而 `useTabDrag` 认那一格 tab 元素时要 `CSS.escape`(refId 里带 `:` 与路径分隔符,
 * 直接塞进属性选择器会当场语法错)。真机上它恒在,所以补的是**环境**不是产品:
 * 补一只与浏览器同义的最小实现,而不是把产品那一句改成扫属性 —— 那会让这只用例
 * 测的东西与真机上跑的不是同一条路。
 */
if (typeof globalThis.CSS === 'undefined') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => String(value).replace(/["\\]/g, '\\$&') },
  })
}

const calls = vi.hoisted(() => [] as { fn: string; args: unknown[] }[])

vi.mock('../../ui/tab-reorder', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../ui/tab-reorder')>()
  return {
    ...real,
    tabStripChoreo: (list: HTMLElement) => {
      const inner = real.tabStripChoreo(list)
      return {
        ...inner,
        reset: () => {
          calls.push({ fn: 'reset', args: [] })
          inner.reset()
        },
        settle: (id: string, from: number) => {
          calls.push({ fn: 'settle', args: [id, from] })
          inner.settle(id, from)
        },
      }
    },
  }
})

const A: ContentRef = { kind: 'u2', key: 'a' }
const B: ContentRef = { kind: 'u2', key: 'b' }
const C: ContentRef = { kind: 'u2', key: 'c' }
const ids = ['u2:a', 'u2:b', 'u2:c']

const TABS: TabSpec[] = ids.map((id) => ({ id, label: id }))

/** 三格各 120 宽依次排开、条 34 高。与 `tabs-joined` 那只打桩逐字同形。 */
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

/** 四发事件一律 `MouseEvent`(jsdom 没有 `PointerEvent`;判词在 drag-session.test 上)。 */
function down(el: Element, x: number, y: number, button = 0): void {
  el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button, clientX: x, clientY: y }))
}
function move(el: Element, x: number, y: number): void {
  el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y }))
}

beforeEach(() => {
  calls.length = 0
  resetContentKinds()
  registerContentKind({
    id: 'u2',
    singleton: false,
    title: (ref) => ({ text: ref.key }),
    icon: () => 'FileText',
    render: (ref) => <div>{ref.key}</div>,
  })
  useWorkbenchStore.getState().reset()
})

afterEach(() => {
  act(() => resetDragSession())
  resetContentKinds()
  focusTree.reset()
})

/* ══ ① 只认主键 ═══════════════════════════════════════════════════════ */

describe('LeafStrip:按下哪个键才算「切到这一格」', () => {
  function renderStrip() {
    const onSelect = vi.fn()
    const onTabPointerDown = vi.fn()
    render(
      <LeafStrip
        tabs={TABS}
        activeId={ids[0]}
        label="tabs"
        onSelect={onSelect}
        onClose={() => {}}
        onTabPointerDown={onTabPointerDown}
      />,
    )
    return { onSelect, onTabPointerDown }
  }

  it('主键:照旧按下即激活(这一条不许被 U2 顺手改坏)', () => {
    const { onSelect, onTabPointerDown } = renderStrip()
    act(() => down(screen.getAllByRole('tab')[1], 180, 17, 0))
    expect(onSelect).toHaveBeenCalledWith(ids[1])
    expect(onTabPointerDown).toHaveBeenCalled()
  })

  /*
   * **右键只开菜单,不切标签**(U2)。从前这一句对任何按钮都跑,于是右键一格
   * 非活动标签会先把它切过来 —— 用户为了看一眼某格的菜单,当前那格的内容当场没了。
   * 反证:把 `if (e.button === 0)` 那一句挖掉,这一条与下一条同时红。
   */
  it('右键(button 2):不激活', () => {
    const { onSelect } = renderStrip()
    act(() => down(screen.getAllByRole('tab')[1], 180, 17, 2))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('中键(button 1):什么都不做', () => {
    const { onSelect } = renderStrip()
    act(() => down(screen.getAllByRole('tab')[1], 180, 17, 1))
    expect(onSelect).not.toHaveBeenCalled()
  })

  /*
   * **手势那一口照旧无条件递出去**:它自己第一句就是 `if (e.button !== 0) return`
   * (`DragSession`)。在檐上再判一次等于两处判据 —— 这一格判的是激活,那一格
   * 判的是拖拽,两件事。
   */
  it('非主键仍旧把这一下递给手势那一口(挡在 DragSession 自己那一句上)', () => {
    const { onTabPointerDown } = renderStrip()
    act(() => down(screen.getAllByRole('tab')[1], 180, 17, 2))
    expect(onTabPointerDown).toHaveBeenCalled()
  })
})

/* ══ ② 取消 = 滑回 ════════════════════════════════════════════════════ */

describe('useTabDrag:取消那三条路都滑回原位', () => {
  function Harness() {
    const leaf = makeLeaf('leaf-1', [A, B, C], 0)
    const onTabPointerDown = useTabDrag(leaf)
    return (
      <Tabs
        items={TABS}
        activeId={ids[0]}
        look="joined"
        label="tabs"
        onSelect={() => {}}
        onTabPointerDown={onTabPointerDown}
      />
    )
  }

  /** 起拖并停在带里(条 [0,360]×[0,34],外扩 24 —— y=17 稳在带内)。 */
  function liftInBand(): HTMLElement {
    render(<Harness />)
    const list = screen.getByRole('tablist')
    stubLayout(list)
    const tab = screen.getAllByRole('tab')[0]
    act(() => {
      down(tab, 60, 17)
      // 横向走过 DRAG_START_X(6):这一帧起拖,而且仍在带里 = 换序。
      move(tab, 100, 17)
    })
    expect(tab.dataset.lift).toBe('')
    // 起拖那一段自己也会 `reset()` 一次(`inline.enter` 的「折起来那一格展回来」)。
    // 这几条断的是**取消之后**的调用序,所以从这里重新记账。
    calls.length = 0
    return tab
  }

  /**
   * **先量后收**:`settle` 收到的起点必须是它**在手上**的左缘(打桩下恒为 0,
   * 所以这里断的是「settle 真的被叫了、而且排在 reset 之后」——「量」那一半由
   * 参数不是 `undefined` 与真机门那条「首帧位移非零」一起钉)。
   *
   * 反证:把 `endGesture` 的 `cancel` 分支换回 `choreo.reset()`,三条路同时红。
   */
  function expectSlidBack(tab: HTMLElement): void {
    const settled = calls.filter((c) => c.fn === 'settle')
    expect(settled.length).toBe(1)
    expect(settled[0].args[0]).toBe(ids[0])
    expect(typeof settled[0].args[1]).toBe('number')
    // 次序:reset 在 settle 之前(settle 量的是「新槽位」,它必须在属性摘掉之后)。
    expect(calls.map((c) => c.fn)).toEqual(['reset', 'settle'])
    // 而且抬起 / 折起两格属性都清干净了(树一个字不变的另一半)。
    expect(tab.dataset.lift).toBeUndefined()
    expect(tab.dataset.torn).toBeUndefined()
  }

  it('Esc(响应链的瞬态口)', () => {
    const tab = liftInBand()
    const handlers = focusTree.transientEscapeHandlers()
    expect(handlers.length).toBeGreaterThan(0)
    act(() => {
      expect(handlers[handlers.length - 1]()).toBe(true)
    })
    expectSlidBack(tab)
  })

  it('pointercancel', () => {
    const tab = liftInBand()
    act(() => {
      tab.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }))
    })
    expectSlidBack(tab)
  })

  it('窗口失焦', () => {
    const tab = liftInBand()
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expectSlidBack(tab)
  })

  /**
   * **已经撕下(带外)时取消 = 原位展回,不滑回**:那一格此刻折成 0 宽、编舞手上
   * 没有抬起的格(`lifted()` 答 null),`reset()` 一摘 `data-torn` 它就原样展开。
   * 再排一段 150ms 的位移过渡是对一件没发生过位移的事做动画。
   */
  it('撕下之后取消:只 reset,不 settle', () => {
    const tab = liftInBand()
    act(() => {
      // 竖向越过带的下沿(34 + 24 = 58)= 出带 = 撕下。
      move(tab, 100, 200)
    })
    expect(tab.dataset.torn).toBe('')
    calls.length = 0
    act(() => {
      tab.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }))
    })
    expect(calls.map((c) => c.fn)).toEqual(['reset'])
    expect(tab.dataset.torn).toBeUndefined()
  })
})
