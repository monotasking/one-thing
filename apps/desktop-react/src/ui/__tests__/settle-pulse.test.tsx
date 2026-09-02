import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useSettlePulse } from '../settle-pulse'

/**
 * `useSettlePulse` 的门。三条性质各配一个反证:
 *   · 挂载那一次**不播**(屏幕上本来就在长内容);
 *   · token 变一次播一次;
 *   · 收尾看 `animationend`,不看计时器(动效档 0ms 时它立刻回来)。
 */

function Host({ token }: { token: unknown }) {
  const pulse = useSettlePulse(token)
  return (
    <div
      data-testid="target"
      data-on={pulse.on ? 'yes' : 'no'}
      onAnimationEnd={pulse.end}
    />
  )
}

function on(): string {
  return screen.getByTestId('target').getAttribute('data-on') ?? ''
}

function animationEnd() {
  const target = screen.getByTestId('target')
  act(() => {
    target.dispatchEvent(new Event('animationend', { bubbles: true }))
  })
}

describe('useSettlePulse:一次落位的淡入闸', () => {
  it('挂载那一次不播 —— 再淡一次是噪音', () => {
    render(<Host token={1} />)
    expect(on()).toBe('no')
  })

  it('token 变了就播', () => {
    const { rerender } = render(<Host token={1} />)
    rerender(<Host token={2} />)
    expect(on()).toBe('yes')
  })

  it('反证:token 没变就不播 —— 重渲不是「变了」', () => {
    const { rerender } = render(<Host token={1} />)
    rerender(<Host token={1} />)
    expect(on()).toBe('no')
  })

  it('animationend 收尾;收完还能再播下一发', () => {
    const { rerender } = render(<Host token={1} />)
    rerender(<Host token={2} />)
    expect(on()).toBe('yes')

    animationEnd()
    expect(on()).toBe('no')

    rerender(<Host token={3} />)
    expect(on()).toBe('yes')
  })

  it('播放中 token 又变:仍然只有一发,end 一到就收(不叠帧、不排队)', () => {
    const { rerender } = render(<Host token={1} />)
    rerender(<Host token={2} />)
    rerender(<Host token={3} />)
    expect(on()).toBe('yes')
    animationEnd()
    expect(on()).toBe('no')
  })

  it('token 不必是数:任何 !== 判得出「变了」的值都行(字符串同理)', () => {
    const { rerender } = render(<Host token="a" />)
    expect(on()).toBe('no')
    rerender(<Host token="b" />)
    expect(on()).toBe('yes')
  })
})
