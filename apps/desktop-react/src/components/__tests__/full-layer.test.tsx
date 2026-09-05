import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { CenterRegion } from '../../workbench/CenterRegion'
import { CENTER_REGION } from '../../workbench/regions'
import { registerContentKind, resetContentKinds } from '../../workbench/kinds'
import { startWorkbench, useWorkbenchStore } from '../../workbench/store'
import { leavesOf } from '../../workbench/tree'
import { useStageStore } from '../../stage/store'
import { focusTree } from '../../focus/registry'
import { FocusDispatchHarness } from '../../test/focus-harness'
import { FullLayer } from '../FullLayer'
import type { ContentRef } from '../../workbench/kinds'

/**
 * **全屏层**(W2,设计 §4;三张状态表写在 `components/FullLayer.tsx` 头上)。
 *
 * 这一组守五件:
 *  ① 没开着时**一个 DOM 节点都不画**;
 *  ② **零重挂**:进 / 出全屏前后,`[data-pane-body]` 里那个内容根节点是**同一个**
 *     DOM 节点 —— 这是本批最重要的一条(判词与三种写法的实测读数写在 `PaneLeaf`
 *     文件头:切 portal 容器会重挂,只有「身份恒定的 holder + appendChild」不会);
 *  ③ 全屏期间内容**真的搬进了全屏层**(叶的身子留空),退出即搬回;
 *  ④ 檐带三件齐:让位 / 身份 / 退出钮,而且退出钮点得动;
 *  ⑤ Esc 归这一层(它自己声明 `onEscape`,答 true 就不再往外传)。
 *
 * 用例里注册的是**假种类**,与 `workbench/__tests__/*` 同一条理由。
 */

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
    title: (ref) => ({ text: `名 ${ref.key}` }),
    icon: () => 'FileText',
    render: (ref) => <div data-testid={`doc-body:${ref.key}`}>{ref.key}</div>,
  })
  useWorkbenchStore.getState().reset()
  startWorkbench()
})

afterEach(() => {
  resetContentKinds()
  focusTree.reset()
})

function renderShell() {
  return render(
    <>
      <FocusDispatchHarness />
      <CenterRegion />
      <FullLayer />
    </>,
  )
}

const st = () => useWorkbenchStore.getState()
const bodyOf = (leafId: string) =>
  document.querySelector(`[data-pane-body="${leafId}"]`) as HTMLElement | null
const slot = () => document.querySelector('[data-full-slot]') as HTMLElement | null

describe('① 没开着 = 不在场', () => {
  it('一个 DOM 节点都不画', () => {
    renderShell()
    expect(document.querySelector('[data-testid="full-layer"]')).toBeNull()
  })
})

describe('② 零重挂:进 / 出全屏前后是**同一个** DOM 节点', () => {
  it('`[data-pane-body]` 里那个内容根节点前后同一(本批最重要的一条)', () => {
    renderShell()
    act(() => st().openRef(doc('a')))
    const leafId = leavesOf(st().regions[CENTER_REGION])[0].id

    const before = bodyOf(leafId)?.firstElementChild
    const content = document.querySelector('[data-testid="doc-body:a"]')
    expect(before).toBeTruthy()
    expect(content).toBeTruthy()

    act(() => void st().toggleFull())
    // 全屏期间它搬进了全屏层,而且**还是那一个节点**(appendChild 是移动)。
    expect(slot()?.firstElementChild).toBe(before)
    expect(document.querySelector('[data-testid="doc-body:a"]')).toBe(content)
    // 叶自己的身子留空(被盖住的那一格占位)。
    expect(bodyOf(leafId)?.firstElementChild).toBeNull()

    act(() => st().exitFull())
    expect(bodyOf(leafId)?.firstElementChild).toBe(before)
    expect(document.querySelector('[data-testid="doc-body:a"]')).toBe(content)
  })

  it('实例状态跟着活下来 —— 内容那棵子树一次都没重建', () => {
    renderShell()
    act(() => st().openRef(doc('a')))
    const content = document.querySelector('[data-testid="doc-body:a"]') as HTMLElement
    // 往真 DOM 上做一个记号:重挂会把它一起丢掉。
    content.dataset.mark = 'kept'
    act(() => void st().toggleFull())
    act(() => st().exitFull())
    expect(
      (document.querySelector('[data-testid="doc-body:a"]') as HTMLElement).dataset.mark,
    ).toBe('kept')
  })
})

describe('③ 檐带:让位 / 身份 / 退出钮', () => {
  it('身份读的是那一格的名字(种类自述的静态半,活的由 live-title 盖)', () => {
    renderShell()
    act(() => st().openRef(doc('a')))
    act(() => void st().toggleFull())
    expect(screen.getByTestId('full-strip').textContent).toContain('名 a')
  })

  it('这一层是 `role="region"` 而不是对话框(后面那些面还在,只是被盖住)', () => {
    renderShell()
    act(() => st().openRef(doc('a')))
    act(() => void st().toggleFull())
    const layer = screen.getByTestId('full-layer')
    expect(layer.getAttribute('role')).toBe('region')
    expect(layer.hasAttribute('aria-modal')).toBe(false)
    expect(layer.getAttribute('aria-label')).toBe('全屏')
  })

  it('退出钮**有名**,点一下就退出', () => {
    renderShell()
    act(() => st().openRef(doc('a')))
    act(() => void st().toggleFull())
    const exit = screen.getByRole('button', { name: '退出全屏' })
    act(() => void fireEvent.click(exit))
    expect(st().full).toBeNull()
  })
})

describe('④ 焦点与 Esc', () => {
  it('开出来 → 键盘进这一层(`full-layer` 在活动路径上)', () => {
    renderShell()
    act(() => st().openRef(doc('a')))
    act(() => void st().toggleFull())
    // 活动路径存的是实例 id(`<scope>@<useId>`),所以按前缀问「哪一格 scope」。
    expect(focusTree.activePath().some((id) => id.startsWith('full-layer@'))).toBe(true)
  })

  it('Esc 归这一层:退出全屏,而且**接住**(不再往外传)', () => {
    renderShell()
    act(() => st().openRef(doc('a')))
    act(() => void st().toggleFull())
    let prevented = false
    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
      window.dispatchEvent(event)
      prevented = event.defaultPrevented
    })
    expect(st().full).toBeNull()
    expect(prevented).toBe(true)
  })

  it('退出之后键盘回到**原叶原 tab**(§3.5 规则 5)', () => {
    renderShell()
    act(() => st().openRef(doc('a')))
    act(() => void st().toggleFull())
    act(() => st().exitFull())
    // 活动路径上那一格 `leaf` 的 owner 就是那一格的 refId(`PaneTabLayer` 按它登记)。
    expect(focusTree.isOwnerActive('doc:a')).toBe(true)
  })
})

describe('⑤ 哪棵树都不在那一路:全屏层自己画', () => {
  it('`from === null` → 内容画在 slot 里(没有叶持有它,也就没有可投影的实例)', () => {
    renderShell()
    act(() => st().enterFull(doc('z'), null))
    expect(slot()?.querySelector('[data-testid="doc-body:z"]')).toBeTruthy()
  })
})
