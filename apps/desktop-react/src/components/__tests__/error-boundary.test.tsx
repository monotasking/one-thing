import { useState } from 'react'
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ErrorBoundary } from '../ErrorBoundary'
import { Button } from '../../ui/Button'
import { __resetLogForTests } from '../../services/log'
import { dumpCrashes } from '../../services/crash'
import { useStageStore } from '../../stage/store'

/**
 * React 在边界接住错之后仍会往 console.error 打一整篇("The above error occurred…")。
 * 那是 React 自己的行为,不是被测对象;不静音的话测试输出里全是红字,
 * 真出问题时反而看不见。只在本文件静音,且只静 error 这一档。
 */
let quiet: ReturnType<typeof vi.spyOn>
beforeAll(() => {
  // `console` 是全局对象,`vi.spyOn(console, 'error')` 里并没有一次 console.* **调用**,
  // 所以 no-console 本来就不报它 —— 这里不需要 disable 注释。
  quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterAll(() => quiet.mockRestore())

beforeEach(() => {
  __resetLogForTests()
  useStageStore.setState({ locale: 'zh' })
})

/** 一个能按开关炸的子树。`boom` 为真时在**渲染期**抛 —— 这才是边界能接住的那一类。 */
function Bomb({ boom, label }: { boom: boolean; label: string }) {
  if (boom) throw new Error(`${label} 炸了`)
  return <div data-testid={`alive-${label}`}>{label} 活着</div>
}

/**
 * 一块受**外部闸门**控制的面板。
 *
 * 这里刻意不用「第一次渲染抛、之后正常」那种自复位的写法:React 19 在并发渲染
 * 撞到错时会自己**同步重渲一遍整棵根**再决定要不要交给边界,于是自复位组件在那第二遍
 * 就成功了,边界根本不会亮 —— 测出来的是 React 的恢复机制,不是这个边界。
 * 闸门由测试自己开合,两遍渲染看到的是同一个状态,故障因此是确定的。
 */
const gate = { fail: true }

function Gated() {
  if (gate.fail) throw new Error('闸关着')
  return <div data-testid="gated-ok">通了</div>
}

/** 一块**先正常跑、攒了状态之后才炸**的面板 —— 用来验重试后状态是否被丢干净。 */
function Stateful() {
  const [n, setN] = useState(0)
  if (gate.fail) throw new Error('攒完状态才炸')
  /* 夹具也照 `ui:consume` 的规矩来:测试里手写一颗裸钮,下一个人就照抄。 */
  return (
    <Button data-testid="bump" onClick={() => setN(n + 1)}>
      {`n=${n}`}
    </Button>
  )
}

describe('分区错误边界', () => {
  it('炸掉的那一界出错误卡,**兄弟面板照常活着**', () => {
    render(
      <>
        <ErrorBoundary where="files">
          <Bomb boom label="files" />
        </ErrorBoundary>
        <ErrorBoundary where="terminal">
          <Bomb boom={false} label="terminal" />
        </ErrorBoundary>
      </>,
    )
    expect(screen.getByTestId('error-card-files')).toBeTruthy()
    // 关键断言:一块炸了不带走另一块。
    expect(screen.getByTestId('alive-terminal')).toBeTruthy()
    expect(screen.queryByTestId('error-card-terminal')).toBeNull()
  })

  it('错误卡带齐三要素:说人话的标题 / 哪错了 / 怎么办', () => {
    render(
      <ErrorBoundary where="browser">
        <Bomb boom label="browser" />
      </ErrorBoundary>,
    )
    const card = screen.getByTestId('error-card-browser')
    expect(card.getAttribute('role')).toBe('alert')
    expect(card.textContent).toContain('这块崩了')
    // 哪错了 = where,原样显示(它是标识,不进字典)。
    expect(card.textContent).toContain('browser')
    // 怎么办 = 一颗真按钮。
    expect(screen.getByTestId('error-retry-browser')).toBeTruthy()
    // 技术细节折叠着,给排障的人。
    expect(card.textContent).toContain('技术细节')
    expect(card.querySelector('pre')?.textContent).toContain('browser 炸了')
  })

  it('重试**重挂**那一界:故障排除之后点一下就回来了', () => {
    gate.fail = true
    render(
      <ErrorBoundary where="gated">
        <Gated />
      </ErrorBoundary>,
    )
    expect(screen.getByTestId('error-card-gated')).toBeTruthy()

    // 故障还在的时候点重试:应该**再次**亮错误卡,而不是画出半个坏面板。
    fireEvent.click(screen.getByTestId('error-retry-gated'))
    expect(screen.getByTestId('error-card-gated')).toBeTruthy()

    gate.fail = false
    fireEvent.click(screen.getByTestId('error-retry-gated'))
    expect(screen.getByTestId('gated-ok')).toBeTruthy()
    expect(screen.queryByTestId('error-card-gated')).toBeNull()
  })

  it('重试后子树的 state 回到初始值 —— 攒下的坏状态不会被带过来', () => {
    gate.fail = false
    render(
      <ErrorBoundary where="stateful">
        <Stateful />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByTestId('bump'))
    fireEvent.click(screen.getByTestId('bump'))
    expect(screen.getByTestId('bump').textContent).toBe('n=2')

    // 关闸,再戳一下触发重渲 —— 这一次它在渲染期抛,边界接住。
    gate.fail = true
    fireEvent.click(screen.getByTestId('bump'))
    expect(screen.getByTestId('error-card-stateful')).toBeTruthy()

    gate.fail = false
    fireEvent.click(screen.getByTestId('error-retry-stateful'))
    expect(screen.getByTestId('bump').textContent).toBe('n=0')
  })

  it('没崩的时候边界**不生成任何 DOM 节点**(带 key 的 Fragment,不是 div)', () => {
    const { container } = render(
      <ErrorBoundary where="plain">
        <span data-testid="only-child">x</span>
      </ErrorBoundary>,
    )
    expect(container.firstElementChild?.tagName).toBe('SPAN')
    expect(container.children).toHaveLength(1)
  })

  it('捕获同时记一条崩溃日志,where 与组件栈都在', () => {
    render(
      <ErrorBoundary where="settings">
        <Bomb boom label="settings" />
      </ErrorBoundary>,
    )
    const crashes = dumpCrashes()
    expect(crashes).toHaveLength(1)
    expect(crashes[0].ns).toBe('crash.boundary')
    expect(crashes[0].msg).toContain('settings 炸了')
    expect(crashes[0].args[0]).toContain('"where":"settings"')
  })

  it('错误卡跟着 locale 走 —— 英文环境不该冒出中文', () => {
    useStageStore.setState({ locale: 'en' })
    render(
      <ErrorBoundary where="diff">
        <Bomb boom label="diff" />
      </ErrorBoundary>,
    )
    expect(screen.getByTestId('error-card-diff').textContent).toContain('This part crashed')
  })
})
