import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { ButtonBase } from '../ButtonBase'
import {
  clampListIndex,
  stepListIndex,
  useListSelection,
} from '../a11y/list-selection'

/**
 * 键盘选择状态机的守卫。分两半:
 *  ① 纯判据(走一步 / 夹范围)—— 从 composer/transitions 搬过来的那两条断言;
 *  ② **hover ≠ active** 那条纪律的反证:mouseenter 一发都不许动 active,
 *     scrollIntoView 引起的那一发合成 mouseenter 同样不许动它(二次污染)。
 *
 * ── 反证纪律 ────────────────────────────────────────────────────────────
 * 这两条断言各真跑过一次「拆掉即红」:
 *  · 在 Probe 的行上补回 `onMouseEnter={() => sel.select(i)}` → 「鼠标经过」
 *    与「滚动后的合成 enter」两条全红(active 被拽到 3 / 被拽到滚动落点那一行);
 *  · 把 useListSelection 里那条 scrollIntoView 的 effect 注释掉 → 「滚进视野」
 *    那条红(拿不到调用)。
 * ──────────────────────────────────────────────────────────────────────
 */

describe('纯判据', () => {
  it('走一步:不循环时在两端钳住,空表钉在 0', () => {
    expect(stepListIndex(0, -1, 3, false)).toBe(0)
    expect(stepListIndex(2, 1, 3, false)).toBe(2)
    expect(stepListIndex(1, 1, 3, false)).toBe(2)
    expect(stepListIndex(2, 1, 0, false)).toBe(0)
  })

  it('走一步:循环时两端绕回去', () => {
    expect(stepListIndex(0, -1, 3, true)).toBe(2)
    expect(stepListIndex(2, 1, 3, true)).toBe(0)
  })

  it('夹范围:越界拉回端点,空表钉在 0', () => {
    expect(clampListIndex(5, 3)).toBe(2)
    expect(clampListIndex(-2, 3)).toBe(0)
    expect(clampListIndex(1, 0)).toBe(0)
  })
})

/**
 * 最小消费面:一行输入 + 一列候选,焦点恒在输入框 —— 与 composer 抽屉、
 * 工作区快切、模型抽屉是同一种形状。行上**刻意**挂了 mouseenter,
 * 但它做的事是「记一笔」,不是改 active:门守的正是这一格。
 */
function Probe({ count = 5 }: { count?: number }) {
  /* 「鼠标真的到过」的读数。它是**另一个**状态 —— 门要证明的正是
   * 「mouseenter 到了、也做了事,却没碰 active」,所以计数必须真涨。 */
  const [enters, setEnters] = useState(0)
  const sel = useListSelection({ count })
  return (
    <div>
      <input
        data-testid="probe-input"
        onKeyDown={(e) => {
          if (sel.handleKey(e.key)) e.preventDefault()
        }}
      />
      <output data-testid="probe-active">{sel.active}</output>
      <output data-testid="probe-enters">{enters}</output>
      {Array.from({ length: count }, (_, i) => (
        <ButtonBase
          key={i}
          ref={sel.rowRef(i)}
          data-testid={`probe-row-${i}`}
          data-on={i === sel.active ? 'true' : undefined}
          onMouseEnter={() => setEnters((n) => n + 1)}
          onClick={() => sel.select(i)}
        >
          row {i}
        </ButtonBase>
      ))}
    </div>
  )
}

const activeOf = () => screen.getByTestId('probe-active').textContent

describe('hover ≠ active(09-01 用户裁定)', () => {
  it('mouseenter 一发都不改 active —— 鼠标经过只是经过', () => {
    render(<Probe />)
    const input = screen.getByTestId('probe-input')
    act(() => void fireEvent.keyDown(input, { key: 'ArrowDown' }))
    expect(activeOf()).toBe('1')

    // 鼠标扫过三行。真到了(计数在涨),但键盘位一格没动。
    act(() => void fireEvent.mouseEnter(screen.getByTestId('probe-row-3')))
    act(() => void fireEvent.mouseEnter(screen.getByTestId('probe-row-4')))
    expect(screen.getByTestId('probe-enters').textContent).toBe('2')
    expect(activeOf()).toBe('1')
  })

  it('↵ 落在键盘位上 —— 鼠标停在哪一行都不改答案', () => {
    render(<Probe />)
    const input = screen.getByTestId('probe-input')
    act(() => void fireEvent.keyDown(input, { key: 'ArrowDown' }))
    act(() => void fireEvent.keyDown(input, { key: 'ArrowDown' }))
    act(() => void fireEvent.mouseEnter(screen.getByTestId('probe-row-0')))
    // 屏幕上带 accent 底的那一行仍然是键盘走到的第 2 行。
    expect(screen.getByTestId('probe-row-2').dataset.on).toBe('true')
    expect(screen.getByTestId('probe-row-0').dataset.on).toBeUndefined()
  })

  it('点击是显式意图,可以改 active', () => {
    render(<Probe />)
    act(() => void fireEvent.click(screen.getByTestId('probe-row-3')))
    expect(activeOf()).toBe('3')
  })

  /**
   * 二次污染那一格。真机上这一发 mouseenter 是浏览器在**鼠标一动没动**的情况下
   * 补出来的:scrollIntoView 把列表滚了一段,静止的指针脚下换了一行。
   * jsdom 不排版也不会自己补这一发,所以这里按真机的次序**手动重演**它:
   * 先按 ↓(触发滚动),紧接着对滚动落点那一行发一次 mouseenter。
   * 只要行上不写 active,这条链就断在第一环 —— 这正是修法。
   */
  it('scrollIntoView 之后补来的那发合成 mouseenter,不许把 active 拽走', () => {
    const original = Element.prototype.scrollIntoView
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      render(<Probe />)
      const input = screen.getByTestId('probe-input')
      scrollIntoView.mockClear()
      act(() => void fireEvent.keyDown(input, { key: 'ArrowDown' }))
      expect(activeOf()).toBe('1')
      // 限高必然带出来的那一半:选中行要被滚回视野。
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })

      // 滚完,静止的鼠标脚下换成了第 4 行 —— 浏览器补的那一发。
      act(() => void fireEvent.mouseEnter(screen.getByTestId('probe-row-4')))
      expect(activeOf()).toBe('1')
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })
})

describe('键表', () => {
  it('不认识的键不吞:handleKey 回 false,调用方照常放行', () => {
    render(<Probe />)
    const input = screen.getByTestId('probe-input')
    act(() => void fireEvent.keyDown(input, { key: 'a' }))
    expect(activeOf()).toBe('0')
  })

  it('Home / End 默认不接 —— 输入框里那两下是到行首行尾', () => {
    render(<Probe />)
    const input = screen.getByTestId('probe-input')
    act(() => void fireEvent.keyDown(input, { key: 'End' }))
    expect(activeOf()).toBe('0')
  })

  it('候选变少时 active 自动夹回范围内', () => {
    const { rerender } = render(<Probe count={5} />)
    const input = screen.getByTestId('probe-input')
    act(() => void fireEvent.keyDown(input, { key: 'ArrowDown' }))
    act(() => void fireEvent.keyDown(input, { key: 'ArrowDown' }))
    act(() => void fireEvent.keyDown(input, { key: 'ArrowDown' }))
    expect(activeOf()).toBe('3')
    rerender(<Probe count={2} />)
    expect(activeOf()).toBe('1')
  })
})
