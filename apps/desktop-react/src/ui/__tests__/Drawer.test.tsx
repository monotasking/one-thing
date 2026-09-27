import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useRef } from 'react'
import { Drawer } from '../Drawer'
import type { DrawerProps } from '../Drawer'
import { useStageStore } from '../../stage/store'
import { FocusScope } from '../../focus/FocusScope'
import { focusTree } from '../../focus/registry'
import { FocusDispatchHarness } from '../../test/focus-harness'
import { en } from '../../i18n/en'

/**
 * 抽屉(`ui/Drawer`,主持人抽屉 H0)的库件规格:三条出口(遮罩 / Esc / ✕)、落点两档(缺省 ✕、
 * 消费方点名的那一格)、两档形换档不重挂、檐上可选的头像与状态、定高那一格、底栏不跟身子滚。
 * 播放列表抽屉的像素零差由 `music-panel.test.tsx` 那几条原封不动的用例钉着。
 */

beforeEach(() => {
  useStageStore.setState({ locale: 'en' })
})

afterEach(() => {
  focusTree.reset()
})

function Shell({ children }: { children: ReactNode }) {
  return (
    <FocusScope scope="root">
      {({ scopeProps }) => (
        <div {...scopeProps}>
          <FocusDispatchHarness />
          {children}
        </div>
      )}
    </FocusScope>
  )
}

function mount(props: Partial<DrawerProps> = {}) {
  const onClose = props.onClose ?? vi.fn()
  const base: DrawerProps = { form: 'side', title: 'Songs', onClose, testId: 'd', children: <p>body</p>, ...props }
  const view = render(
    <Shell>
      <Drawer {...base} />
    </Shell>,
  )
  const rerender = (next: Partial<DrawerProps>) =>
    view.rerender(
      <Shell>
        <Drawer {...base} {...next} />
      </Shell>,
    )
  return { onClose, rerender }
}

describe('Drawer:三条出口', () => {
  it('Esc 关(这一层认领,答 true)', () => {
    const { onClose } = mount()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('✕ 关;名字是 common.close', () => {
    const { onClose } = mount()
    const close = screen.getByTestId('d-close')
    expect(close.getAttribute('aria-label')).toBe(en['common.close'])
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('按在遮罩上关;从抽屉里按下不关', () => {
    const { onClose } = mount()
    fireEvent.mouseDown(screen.getByTestId('d'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(screen.getByTestId('d-scrim'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('Drawer:落点', () => {
  it('缺省落在 ✕', async () => {
    mount()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.activeElement).toBe(screen.getByTestId('d-close'))
  })

  it('消费方点名的那一格(输入框);答 null 退回 ✕', async () => {
    function WithInput({ answer }: { answer: boolean }) {
      const ref = useRef<HTMLInputElement | null>(null)
      return (
        <Drawer form="side" title="Host" onClose={() => undefined} testId="d" restingTarget={() => (answer ? ref.current : null)} footer={<input ref={ref} aria-label="say" data-testid="say" />}>
          <p>log</p>
        </Drawer>
      )
    }
    const view = render(
      <Shell>
        <WithInput answer />
      </Shell>,
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.activeElement).toBe(screen.getByTestId('say'))
    view.unmount()
    focusTree.reset()
    render(
      <Shell>
        <WithInput answer={false} />
      </Shell>,
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.activeElement).toBe(screen.getByTestId('d-close'))
  })
})

describe('Drawer:形', () => {
  it('role=dialog;读屏名缺省是 title,给了 label 听 label', () => {
    const { rerender } = mount()
    expect(screen.getByTestId('d').getAttribute('role')).toBe('dialog')
    expect(screen.getByTestId('d').getAttribute('aria-label')).toBe('Songs')
    rerender({ label: 'Host Heidou' })
    expect(screen.getByTestId('d').getAttribute('aria-label')).toBe('Host Heidou')
  })

  it('换档(side ↔ sheet)是同一只节点,只换 data-form;fill 只在给了时挂', () => {
    const { rerender } = mount()
    const node = screen.getByTestId('d')
    expect(node.dataset.form).toBe('side')
    expect(node.dataset.fill).toBeUndefined()
    rerender({ form: 'sheet', fill: true })
    expect(screen.getByTestId('d')).toBe(node)
    expect(node.dataset.form).toBe('sheet')
    expect(node.dataset.fill).toBe('true')
  })

  it('没给 lead / subtitle / footer:檐是一个 h2 + 工具,没有多余的节点(播放列表的 DOM 次序不变)', () => {
    mount({ tools: <button type="button">stop</button> })
    const drawer = screen.getByTestId('d')
    const head = drawer.firstElementChild as HTMLElement
    expect(Array.from(head.children).map((el) => el.tagName)).toEqual(['H2', 'SPAN'])
    expect(head.lastElementChild?.textContent).toContain('stop')
    expect(drawer.children).toHaveLength(2)
  })

  it('给了 lead(不念)、subtitle 与 footer:都在各自的位置', () => {
    mount({ lead: <i data-testid="avatar" />, subtitle: <span data-testid="sub">Asleep</span>, footer: <p data-testid="foot">f</p> })
    const drawer = screen.getByTestId('d')
    expect(screen.getByTestId('avatar').parentElement?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByTestId('sub').textContent).toBe('Asleep')
    expect(drawer.children).toHaveLength(3)
    expect(drawer.lastElementChild?.contains(screen.getByTestId('foot'))).toBe(true)
  })
})
