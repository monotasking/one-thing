import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { QuickLook } from './QuickLook'
import { SKELETON_DELAY_MS } from '../../components/motion'
import { seedSessionsSource, SESSIONS } from '../../data/__fixtures__/sessions'
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
