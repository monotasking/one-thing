import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { FollowPill } from '../FollowPill'
import { FOLLOW_PINNED, type FollowState } from '../follow'
import { liveRegionText, resetLiveRegions } from '../../ui/a11y/live-region'
import { useStageStore } from '../../stage/store'

/**
 * 丸自己那三张脸(§5.3)。跨组件的两件事(挂载判据、点了回不回底)在
 * `ChatStream.test.tsx` 里量;这里量的是**这一件**:画什么、念什么、点了叫谁。
 */
const browsing = (unseen: FollowState['unseen']): FollowState => ({ mode: 'browsing', unseen })

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  resetLiveRegions()
})

afterEach(() => {
  resetLiveRegions()
})

describe('三张脸', () => {
  it('回复正在流 = 三个点,一个字不写(09-04 用户定)', () => {
    render(<FollowPill follow={browsing('reply')} streaming onJump={() => undefined} />)
    const pill = screen.getByTestId('chat-follow-pill')
    expect(pill.textContent).toBe('')
    // 没有可见文字,所以名字是另一句:先说此刻在发生什么,再说按下去会怎样。
    expect(pill.getAttribute('aria-label')).toBe('正在生成,回到最新')
    // 点是三颗,而且是装饰(名字由丸自己给,读屏软件不该念两遍)。
    expect(pill.querySelector('[aria-hidden="true"]')?.childElementCount).toBe(3)
  })

  it('自己发了一条、回复还没开始 = 「↓ 已发送」,名字与看得见的字逐字相同', () => {
    render(<FollowPill follow={browsing('sent')} streaming={false} onJump={() => undefined} />)
    const pill = screen.getByTestId('chat-follow-pill')
    expect(pill.textContent).toBe('↓ 已发送')
    expect(pill.getAttribute('aria-label')).toBe('↓ 已发送')
  })

  it('流收场了、下面还有没看的 = 「↓ 回到最新」', () => {
    render(<FollowPill follow={browsing('reply')} streaming={false} onJump={() => undefined} />)
    expect(screen.getByTestId('chat-follow-pill').textContent).toBe('↓ 回到最新')
  })

  /** `streaming` 排在最前:两件事同时成立时,人先要知道的是「此刻在不在跑」。 */
  it('生成中盖过 unseen —— 刚发出去就开始流,画的仍是三个点', () => {
    render(<FollowPill follow={browsing('sent')} streaming onJump={() => undefined} />)
    expect(screen.getByTestId('chat-follow-pill').textContent).toBe('')
  })
})

describe('挂不挂', () => {
  it('pinned 一律不画', () => {
    const { container } = render(
      <FollowPill follow={FOLLOW_PINNED} streaming onJump={() => undefined} />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('browsing 但下面什么都没长 —— 也不画', () => {
    const { container } = render(
      <FollowPill follow={browsing('none')} streaming={false} onJump={() => undefined} />,
    )
    expect(container.innerHTML).toBe('')
  })
})

describe('无障碍:播报一次,不挂 aria-live', () => {
  it('挂载播报一句;换脸不重播(脸换了,事实没换)', async () => {
    const view = render(
      <FollowPill follow={browsing('sent')} streaming={false} onJump={() => undefined} />,
    )
    // announce 排在一次 setTimeout(0) 之后(它先清空再写,好让读屏软件认出「变了」)。
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(liveRegionText('polite')).toBe('↓ 已发送')

    view.rerender(<FollowPill follow={browsing('reply')} streaming={false} onJump={() => undefined} />)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    // 还是第一句 —— 第二次没有播报(拆掉那格闩即红:这里会变成「↓ 回到最新」)。
    expect(liveRegionText('polite')).toBe('↓ 已发送')
  })

  it('丸自己不挂 aria-live —— 流式每帧一句会念疯', () => {
    const { container } = render(
      <FollowPill follow={browsing('reply')} streaming onJump={() => undefined} />,
    )
    expect(container.querySelector('[aria-live]')).toBeNull()
  })
})

describe('交互', () => {
  it('点它 = 把回底交给外面(这一件自己不碰滚动)', () => {
    let jumped = 0
    render(<FollowPill follow={browsing('reply')} streaming={false} onJump={() => (jumped += 1)} />)
    fireEvent.click(screen.getByTestId('chat-follow-pill'))
    expect(jumped).toBe(1)
  })

  it('它是一颗真按钮(键盘可达 / 四态随 ui/Button 走,不自绘)', () => {
    render(<FollowPill follow={browsing('reply')} streaming={false} onJump={() => undefined} />)
    const pill = screen.getByTestId('chat-follow-pill')
    expect(pill.tagName).toBe('BUTTON')
    expect(pill.getAttribute('type')).toBe('button')
    // 丸形来自库件那一档(`pill`),不是本地写死的圆角。
    expect(pill.className).toMatch(/_pill_/)
  })
})
