import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ConfirmHost, Dialog, useConfirm, useConfirmHub } from '../Dialog'
import { useStageStore } from '../../stage/store'
import { en } from '../../i18n/en'

/**
 * 两件事:对话框自己的**逃生口**(Esc / 点遮罩),和 useConfirm 的 promise 语义。
 *
 * 逃生口是板上写死的规矩(「禁止只有确定的死胡同」),所以它值一条回归闸。
 * 点遮罩那条特意分成「点在遮罩上」和「从面板里拖出去松手」两例 —— 后者不该关窗,
 * 判据是 mousedown 的 target === currentTarget,与既有的 StageOverlay 同一条。
 *
 * 文案取自字典而不是写字面:锁 locale 到 en,再从 en.ts 读那两句 ——
 * 这样改文案时测试跟着走,也顺带钉住了「组件用的确实是字典里那两个键」。
 */
beforeEach(() => {
  useStageStore.setState({ locale: 'en' })
  useConfirmHub.setState({ request: null })
})

describe('Dialog:逃生口', () => {
  it('Esc 关', () => {
    const onClose = vi.fn()
    render(<Dialog open onClose={onClose} label="d" />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('按在遮罩上关;从面板里拖出去松手不关', () => {
    const onClose = vi.fn()
    render(<Dialog open onClose={onClose} label="d">body</Dialog>)
    const scrim = screen.getByTestId('dialog-scrim')

    // 从面板里按下:target 是面板,不是遮罩 —— 不该关
    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.mouseDown(scrim)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('打开时焦点落进面板', () => {
    render(<Dialog open onClose={() => {}} label="d" />)
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
  })

  it('关着时什么都不渲染,Esc 也不再触发', () => {
    const onClose = vi.fn()
    render(<Dialog open={false} onClose={onClose} label="d" />)
    expect(screen.queryByRole('dialog')).toBe(null)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('挂在 body 上,不留在调用点(浮层一律 portal)', () => {
    const { container } = render(<Dialog open onClose={() => {}} label="d" />)
    expect(container.querySelector('[role="dialog"]')).toBe(null)
    expect(document.body.contains(screen.getByRole('dialog'))).toBe(true)
  })
})

function Harness({ onDone }: { onDone: (v: boolean) => void }) {
  const confirm = useConfirm()
  return (
    <>
      <button type="button" onClick={() => void confirm({ title: 'Sure?' }).then(onDone)}>
        ask
      </button>
      <ConfirmHost />
    </>
  )
}

describe('useConfirm:promise 化的一问一答', () => {
  it('点确定 resolve(true)', async () => {
    const done = vi.fn()
    render(<Harness onDone={done} />)
    fireEvent.click(screen.getByText('ask'))

    expect(screen.getByRole('dialog').textContent).toContain('Sure?')
    fireEvent.click(screen.getByText(en['common.confirm']))

    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(true))
    expect(screen.queryByRole('dialog')).toBe(null)
  })

  it('点取消 resolve(false)', async () => {
    const done = vi.fn()
    render(<Harness onDone={done} />)
    fireEvent.click(screen.getByText('ask'))
    fireEvent.click(screen.getByText(en['common.cancel']))

    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(false))
  })

  it('Esc 也算取消 —— 逃生口对 confirm 同样成立', async () => {
    const done = vi.fn()
    render(<Harness onDone={done} />)
    fireEvent.click(screen.getByText('ask'))
    fireEvent.keyDown(window, { key: 'Escape' })

    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(false))
  })

  it('单槽:第二问顶掉第一问,第一问以 false 结掉,不留悬空 promise', async () => {
    const first = vi.fn()
    const second = vi.fn()
    render(
      <>
        <button type="button" onClick={() => void useConfirmHub.getState().ask({ title: 'A' }).then(first)}>a</button>
        <button type="button" onClick={() => void useConfirmHub.getState().ask({ title: 'B' }).then(second)}>b</button>
        <ConfirmHost />
      </>,
    )
    fireEvent.click(screen.getByText('a'))
    fireEvent.click(screen.getByText('b'))

    await vi.waitFor(() => expect(first).toHaveBeenCalledWith(false))
    expect(screen.getByRole('dialog').textContent).toContain('B')
    expect(second).not.toHaveBeenCalled()
  })
})

/**
 * A11y 线 · A2:焦点圈禁与无障碍名。
 *
 * 圈禁本身的机制归 ui/a11y/__tests__/focus-trap.test.tsx;这里验的是**接线**——
 * Dialog 真的接上了它(开时焦点进面板、关时还给锚点),以及标题真的被指为名字。
 */
describe('Dialog:焦点与名字', () => {
  it('打开时焦点进面板,关闭时还给开它的那个元素', () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
            open
          </button>
          <Dialog open={open} onClose={() => setOpen(false)} label="d">
            body
          </Dialog>
        </>
      )
    }
    render(<Harness />)
    const opener = screen.getByTestId('opener')
    opener.focus()
    fireEvent.click(opener)
    expect(document.activeElement).toBe(screen.getByRole('dialog'))

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.activeElement).toBe(opener)
  })

  it('有可见标题就 aria-labelledby 指过去,没有才用 aria-label —— 两者只有一个', () => {
    const { unmount } = render(
      <Dialog open onClose={() => {}} title="删掉它?" label="兜底名">
        body
      </Dialog>,
    )
    const withTitle = screen.getByRole('dialog')
    expect(withTitle.getAttribute('aria-label')).toBe(null)
    expect(document.getElementById(withTitle.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('删掉它?')
    unmount()

    render(
      <Dialog open onClose={() => {}} label="兜底名">
        body
      </Dialog>,
    )
    const noTitle = screen.getByRole('dialog')
    expect(noTitle.getAttribute('aria-labelledby')).toBe(null)
    expect(noTitle.getAttribute('aria-label')).toBe('兜底名')
  })
})
