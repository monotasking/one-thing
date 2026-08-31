import { useRef } from 'react'
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { nextRovingIndex, useRoving } from '../roving'

/**
 * 两半分开验:纯判据(按键 → 新位)与 DOM 外衣(tabIndex 转移 + 焦点移动)。
 * 「整组只占一个 Tab 位」是这件东西的全部意义,所以每个用例都顺带断言 tabIndex 表。
 */
function Group({ axis }: { axis: 'horizontal' | 'vertical' }) {
  const ref = useRef<HTMLDivElement>(null)
  useRoving(ref, { axis })
  return (
    <div ref={ref} data-testid="group">
      {/* role="tab" 是**必要的**,不是装饰:aria-selected 只在特定角色上合法,
          裸 <button> 上写它会被 jsx-a11y 当场判违例(而它判得对)。
          这里要验的正是「useRoving 会认 aria-selected 当初始位」。 */}
      {['一', '二', '三'].map((label, i) => (
        <button key={label} type="button" role="tab" data-roving-item aria-selected={i === 1}>
          {label}
        </button>
      ))}
    </div>
  )
}

const tabIndexes = () =>
  ['一', '二', '三'].map((label) => screen.getByText(label).tabIndex)

describe('nextRovingIndex', () => {
  it('横轴只认左右,纵轴只认上下', () => {
    expect(nextRovingIndex('ArrowRight', 0, 3, 'horizontal')).toBe(1)
    expect(nextRovingIndex('ArrowDown', 0, 3, 'horizontal')).toBeNull()
    expect(nextRovingIndex('ArrowDown', 0, 3, 'vertical')).toBe(1)
    expect(nextRovingIndex('ArrowRight', 0, 3, 'vertical')).toBeNull()
    expect(nextRovingIndex('ArrowRight', 0, 3, 'both')).toBe(1)
    expect(nextRovingIndex('ArrowDown', 0, 3, 'both')).toBe(1)
  })

  it('Home / End 到端点,与轴向无关', () => {
    expect(nextRovingIndex('Home', 2, 3, 'horizontal')).toBe(0)
    expect(nextRovingIndex('End', 0, 3, 'vertical')).toBe(2)
  })

  it('默认循环:末尾再走一步回开头', () => {
    expect(nextRovingIndex('ArrowDown', 2, 3, 'vertical')).toBe(0)
    expect(nextRovingIndex('ArrowUp', 0, 3, 'vertical')).toBe(2)
    expect(nextRovingIndex('ArrowDown', 2, 3, 'vertical', false)).toBe(2)
    expect(nextRovingIndex('ArrowUp', 0, 3, 'vertical', false)).toBe(0)
  })

  it('不认识的键返回 null —— 不许吞', () => {
    expect(nextRovingIndex('Enter', 0, 3, 'both')).toBeNull()
    expect(nextRovingIndex('Escape', 0, 3, 'both')).toBeNull()
    expect(nextRovingIndex('a', 0, 3, 'both')).toBeNull()
  })
})

describe('useRoving', () => {
  it('整组一个 Tab 位,初始落在 aria-selected 的那一项上', () => {
    render(<Group axis="horizontal" />)
    expect(tabIndexes()).toEqual([-1, 0, -1])
  })

  it('方向键移焦点,tabIndex 跟着走', () => {
    render(<Group axis="horizontal" />)
    const group = screen.getByTestId('group')
    screen.getByText('二').focus()

    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByText('三'))
    expect(tabIndexes()).toEqual([-1, -1, 0])

    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByText('一'))
    expect(tabIndexes()).toEqual([0, -1, -1])

    fireEvent.keyDown(group, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByText('三'))
    expect(tabIndexes()).toEqual([-1, -1, 0])

    fireEvent.keyDown(group, { key: 'Home' })
    expect(document.activeElement).toBe(screen.getByText('一'))
    expect(tabIndexes()).toEqual([0, -1, -1])
  })

  it('焦点还在容器上时,第一下方向键落到当前项本身,不跳过它', () => {
    render(<Group axis="horizontal" />)
    const group = screen.getByTestId('group')
    group.tabIndex = -1
    group.focus()

    // 当前项 = aria-selected 的「二」。这一下不该走成「三」。
    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByText('二'))

    // 已经在组里了,下一下才真的走一步。
    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByText('三'))
  })

  it('Home / End 不吃那条豁免 —— 它们说的是端点,与从哪儿出发无关', () => {
    render(<Group axis="horizontal" />)
    const group = screen.getByTestId('group')
    group.tabIndex = -1
    group.focus()
    fireEvent.keyDown(group, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByText('三'))
  })

  it('轴向不匹配的方向键不动焦点', () => {
    render(<Group axis="horizontal" />)
    const group = screen.getByTestId('group')
    screen.getByText('二').focus()
    fireEvent.keyDown(group, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByText('二'))
  })
})
