import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ThinkingSegment } from '../ThinkingSegment'
import { useStageStore } from '../../stage/store'

/**
 * 思考段的三条行为(定稿 S2)。
 *
 * 只有这三条值得进 jsdom:收起 / 展开是**排版**的事(line-clamp),测不了也不必测;
 * 「点了会不会收」才是逻辑,而它的判据(选区空不空)恰恰是 jsdom 里可以拨的。
 */

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  // 选区是 window 上的东西:上一条用例伪造过就会漏给下一条,而「点了收不收」
  // 恰恰全靠它 —— 不复位的话后面每条用例都在别人的选区里跑。
  vi.restoreAllMocks()
})

/** 拨选区:jsdom 的 getSelection 默认给一个空选区,圈选态要手动伪造。 */
function selectSomething(): void {
  vi.spyOn(window, 'getSelection').mockReturnValue({ isCollapsed: false } as Selection)
}

const thought = () => screen.getByTestId('chat-thought')

describe('思考段:同一段字的两个读法', () => {
  it('不流时默认收起,点一下展开', () => {
    render(<ThinkingSegment text="想了一些事" live={false} />)
    expect(thought().getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(thought())
    expect(thought().getAttribute('aria-expanded')).toBe('true')
  })

  it('展开后圈着字点一下 —— 不收(否则复制到一半这段就自己关了)', () => {
    render(<ThinkingSegment text="想了一些事" live={false} />)
    fireEvent.click(thought())
    selectSomething()
    fireEvent.click(thought())
    expect(thought().getAttribute('aria-expanded')).toBe('true')
  })

  it('展开后在空选区处点一下 —— 收起', () => {
    render(<ThinkingSegment text="想了一些事" live={false} />)
    fireEvent.click(thought())
    fireEvent.click(thought())
    expect(thought().getAttribute('aria-expanded')).toBe('false')
  })

  it('流式中自动展开,收尾自动折 —— 跟着事实走,不替用户记偏好', () => {
    const view = render(<ThinkingSegment text="正在想" live />)
    expect(thought().getAttribute('aria-expanded')).toBe('true')
    view.rerender(<ThinkingSegment text="想完了" live={false} />)
    expect(thought().getAttribute('aria-expanded')).toBe('false')
  })

  it('原文照实摆着(收起态靠排版钳一行,不靠截字符串)', () => {
    render(<ThinkingSegment text={'第一行\n第二行'} live={false} />)
    expect(thought().textContent).toBe('第一行\n第二行')
  })

  it('键盘也能开合(整块是它自己的开关,没有另设小三角)', () => {
    render(<ThinkingSegment text="想了一些事" live={false} />)
    fireEvent.keyDown(thought(), { key: 'Enter' })
    expect(thought().getAttribute('aria-expanded')).toBe('true')
  })
})
