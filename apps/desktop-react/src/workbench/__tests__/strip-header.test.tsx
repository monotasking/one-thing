import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import { LeafStrip } from '../LeafStrip'
import { PaneTree } from '../PaneTree'
import { registerContentKind, resetContentKinds } from '../kinds'
import type { ContentRef, StripHeaderProps } from '../kinds'
import type { PaneLeafNode } from '../tree'
import { usePanelVisibility } from '../../content/visibility'
import { focusTree } from '../../focus/registry'
import { FocusDispatchHarness } from '../../test/focus-harness'
import { useStageStore } from '../../stage/store'
import { useWorkbenchStore } from '../store'

/**
 * **内容自带的头**(待办 B 形 U1,正本 `docs/todo-app-b-2026-09.md` §3)。
 *
 * 守三件:
 *  ① 叶里只有一格、那一种自述了 `stripHeader` → 条上不画标签,画那条头;
 *  ② 叶里两格 → 标签照常,头不上条;内容从 `headerInStrip` 读到的是 false(它自己画);
 *  ③ 没有自述的种类 → 一个字不变。
 *
 * 叶不在 `regions` 里 = 不住在中央区 = 有自己的条(判据在 `PaneLeaf` 的 `stripInLeaf`),
 * 这正是架子 / 浮窗里那片叶的形,用例因此不必摆一整台外壳。
 */

const note = (key: string): ContentRef => ({ kind: 'note', key })
const plain = (key: string): ContentRef => ({ kind: 'plain', key })

function Header({ contentRef }: StripHeaderProps) {
  return <div data-testid="own-header">{contentRef.key}</div>
}

function Body({ id }: { id: string }) {
  const { headerInStrip } = usePanelVisibility()
  return <div data-testid={`body:${id}`} data-header-in-strip={String(headerInStrip === true)} />
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  resetContentKinds()
  registerContentKind({
    id: 'note',
    singleton: false,
    title: (ref) => ({ text: ref.key }),
    icon: () => 'FileText',
    render: (ref) => <Body id={ref.key} />,
    stripHeader: () => Header,
  })
  registerContentKind({
    id: 'plain',
    singleton: false,
    title: (ref) => ({ text: ref.key }),
    icon: () => 'FileText',
    render: (ref) => <Body id={ref.key} />,
  })
  useWorkbenchStore.getState().reset()
})

afterEach(() => {
  resetContentKinds()
  focusTree.reset()
})

const leaf = (tabs: ContentRef[]): PaneLeafNode => ({ kind: 'leaf', id: 'L1', tabs, active: 0 })

function mount(node: PaneLeafNode) {
  return render(
    <>
      <FocusDispatchHarness />
      <PaneTree node={node} />
    </>,
  )
}

describe('内容自带的头', () => {
  it('独占一片叶 → 条上画头、不画标签;内容读到 headerInStrip = true', () => {
    mount(leaf([note('a')]))
    expect(screen.getByTestId('own-header').textContent).toBe('a')
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(document.querySelector('[data-strip-header]')).not.toBeNull()
    expect(screen.getByTestId('body:a').dataset.headerInStrip).toBe('true')
  })

  it('叶里两格 → 标签照常、头不上条;内容读到 headerInStrip = false(自己画)', () => {
    mount(leaf([note('a'), plain('b')]))
    expect(screen.queryByTestId('own-header')).toBeNull()
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(screen.getByTestId('body:a').dataset.headerInStrip).toBe('false')
  })

  it('没有自述的种类 → 单格照旧画标签(身份带)', () => {
    mount(leaf([plain('b')]))
    expect(screen.queryByTestId('own-header')).toBeNull()
    expect(document.querySelector('[data-strip-header]')).toBeNull()
    expect(screen.getAllByRole('tab')).toHaveLength(1)
  })
})

/**
 * **抓手**(U1-fix 第二半,2026-09-18 用户报「没有了 tab,导致不能拖入到 tab header 中」):
 * 头把标签条换掉之后,这扇窗没有一格标签可抓,按住头只会挪窗子。头里标了 `[data-strip-grab]`
 * 的那一块 = 那一格标签;按在别处照旧是檐的空白(拖窗)。
 */
describe('自带头的抓手', () => {
  const mountStrip = () => {
    const onTabPointerDown = vi.fn()
    const onChromePointerDown = vi.fn()
    render(
      <LeafStrip
        header={<div><span data-testid="grab" data-strip-grab="">把手</span><span data-testid="blank">空白</span></div>}
        tabs={[{ id: 'note:a', label: 'a' }]}
        activeId="note:a"
        label="tabs"
        onSelect={() => {}}
        onClose={() => {}}
        onTabPointerDown={onTabPointerDown}
        onChromePointerDown={onChromePointerDown}
      />,
    )
    return { onTabPointerDown, onChromePointerDown }
  }

  it('按在抓手上 = 按在那一格标签上,而且不拖窗', () => {
    const { onTabPointerDown, onChromePointerDown } = mountStrip()
    fireEvent.pointerDown(screen.getByTestId('grab'))
    expect(onTabPointerDown).toHaveBeenCalledTimes(1)
    expect(onTabPointerDown.mock.calls[0][0]).toBe('note:a')
    expect(onChromePointerDown).not.toHaveBeenCalled()
  })

  it('按在头的别处 = 檐的空白,照旧拖窗', () => {
    const { onTabPointerDown, onChromePointerDown } = mountStrip()
    fireEvent.pointerDown(screen.getByTestId('blank'))
    expect(onTabPointerDown).not.toHaveBeenCalled()
    expect(onChromePointerDown).toHaveBeenCalledTimes(1)
  })
})
