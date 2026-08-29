import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QuickLook } from './QuickLook'
import { SKELETON_DELAY_MS } from '../../components/motion'
import { GROUPS, seedSessionsSource, SESSIONS } from '../../data/__fixtures__/sessions'
import { useSessionsSource } from '../../data/sessions-source'
import { useStageStore } from '../../stage/store'
import { useExposeStore } from '../store'
import { initialExposeState } from '../transitions'

/**
 * D1:Quick Look 里画的是**真消息**(sessions.getMessagesPage 的首页),纯文本。
 * 这里钉三件事:文本真的出来了、载入骨架遵守 150ms 防闪、空会话说「还没有消息」。
 */
const session = SESSIONS[0]

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  seedSessionsSource()
  useExposeStore.setState({ ...initialExposeState, currentSessionId: session.id })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Quick Look 的消息', () => {
  it('消息到手就按 role 画出来(用户 / AI 各有标签)', () => {
    useSessionsSource.setState({
      messages: {
        [session.id]: [
          { id: 'm1', role: 'user', text: '把能力判定收敛到一处' },
          { id: 'm2', role: 'assistant', text: '三处读取点已经改成同一个纯函数' },
        ],
      },
    })
    render(<QuickLook sessionId={session.id} />)
    expect(screen.getByText('把能力判定收敛到一处')).toBeTruthy()
    expect(screen.getByText('三处读取点已经改成同一个纯函数')).toBeTruthy()
    expect(screen.getByText('你')).toBeTruthy()
    expect(screen.getByText('AI')).toBeTruthy()
  })

  it('一条消息都没有 = 「还没有消息」,而不是永远转圈', () => {
    useSessionsSource.setState({ messages: { [session.id]: [] } })
    render(<QuickLook sessionId={session.id} />)
    expect(screen.getByText('这条会话还没有消息')).toBeTruthy()
  })

  it('骨架延迟 150ms 才出 —— 比这更快到手的页面不该闪一下', () => {
    vi.useFakeTimers()
    render(<QuickLook sessionId={session.id} />)
    const body = screen.getByTestId('quicklook-body')
    expect(body.querySelector('[aria-label="正在读消息…"]')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS + 10)
    })
    expect(body.querySelector('[aria-label="正在读消息…"]')).not.toBeNull()
  })
})

/**
 * ── F 批:头部 meta 与 ‹ › 换会话 ────────────────────────────────────────
 * meta 三格(模型 / agent / 时间)一律「有产地才画」;
 * ‹ › 与键盘 ← → 是同一对 store action、同一个禁用判据(到头就停,不回卷),
 * 而序列是**搜索过滤之后**的那一条。
 */
describe('Quick Look 头部的 meta', () => {
  it('lastModel / agentId 都有的会话出两枚徽', () => {
    render(<QuickLook sessionId="os-provider" />)
    const meta = screen.getByTestId('quicklook-meta')
    expect(meta.textContent).toContain('claude-opus-5')
    expect(meta.textContent).toContain('reviewer')
  })

  it('agentId 是 default 时不出 agent 徽(默认 agent 不是一个选择)', () => {
    render(<QuickLook sessionId="os-compact" />)
    const meta = screen.getByTestId('quicklook-meta')
    expect(meta.textContent).toContain('deepseek-chat')
    expect(meta.textContent).not.toContain('default')
  })

  it('没跑过任何一轮的会话没有模型徽,但时间那一格照样在', () => {
    render(<QuickLook sessionId="lo-notes" />)
    const meta = screen.getByTestId('quicklook-meta')
    expect(meta.querySelectorAll('span').length).toBe(1)
    expect(meta.textContent?.trim().length).toBeGreaterThan(0)
  })
})

describe('Quick Look 的 ‹ › 换会话', () => {
  /** 屏幕上的卡序(未搜索时)—— 邻居判据读的就是它。 */
  const seq = GROUPS.flatMap((g) => g.sessions.map((x) => x.id))

  const open = (id: string) => {
    useExposeStore.setState({ view: { mode: 'quicklook', sessionId: id }, focusId: id })
    render(<QuickLook sessionId={id} />)
  }

  it('中间的会话两个控件都可点,点了就换到邻居', () => {
    open(seq[1])
    const next = screen.getByTestId('quicklook-next') as HTMLButtonElement
    expect(next.disabled).toBe(false)
    fireEvent.click(next)
    expect(useExposeStore.getState().view).toEqual({ mode: 'quicklook', sessionId: seq[2] })
  })

  it('‹ 换回上一个', () => {
    open(seq[1])
    fireEvent.click(screen.getByTestId('quicklook-prev'))
    expect(useExposeStore.getState().view).toEqual({ mode: 'quicklook', sessionId: seq[0] })
  })

  it('第一个 / 最后一个:那一侧禁用,不回卷', () => {
    open(seq[0])
    expect((screen.getByTestId('quicklook-prev') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('quicklook-next') as HTMLButtonElement).disabled).toBe(false)
    cleanup()

    open(seq[seq.length - 1])
    expect((screen.getByTestId('quicklook-next') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('quicklook-prev') as HTMLButtonElement).disabled).toBe(false)
  })

  it('导航序列是**过滤后**的:搜着词时 › 走的是下一张命中卡', () => {
    // 'transreader' 只留下那个项目组的两条,它们在全量序列里前面还有四条。
    useExposeStore.setState({ query: 'transreader' })
    open('tr-menubar')
    expect((screen.getByTestId('quicklook-prev') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('quicklook-next'))
    expect(useExposeStore.getState().view).toEqual({ mode: 'quicklook', sessionId: 'tr-flask' })
  })
})
