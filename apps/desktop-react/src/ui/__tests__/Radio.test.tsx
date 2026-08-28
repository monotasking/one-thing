import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Radio, RadioGroup } from '../Radio'

/**
 * 单选的「一组只能选一个」不是组件写出来的,是原生 name 白送的 ——
 * 所以这里钉的是「同组共享一个 name」和「选中态跟着 value 走」。
 * 方向键行为归浏览器,jsdom 里测不了也不该由我们实现,故不测。
 */
function setup(value = 'a', onChange = vi.fn()) {
  render(
    <RadioGroup value={value} onChange={onChange} label="g">
      <Radio value="a">A</Radio>
      <Radio value="b">B</Radio>
      <Radio value="c" disabled>C</Radio>
    </RadioGroup>,
  )
  return onChange
}

describe('RadioGroup:单选', () => {
  it('同组三颗共享同一个 name', () => {
    setup()
    const names = screen.getAllByRole('radio').map((el) => (el as HTMLInputElement).name)
    expect(new Set(names).size).toBe(1)
    expect(names[0]).toBeTruthy()
  })

  it('选中态只由 value 决定', () => {
    setup('b')
    const [a, b, c] = screen.getAllByRole('radio') as HTMLInputElement[]
    expect([a.checked, b.checked, c.checked]).toEqual([false, true, false])
  })

  it('点另一颗交出它的 value', () => {
    const onChange = setup('a')
    fireEvent.click(screen.getByLabelText('B'))
    expect(onChange).toHaveBeenCalledWith('b')
  })

  it('单颗禁用只禁自己', () => {
    setup('a')
    const [a, b, c] = screen.getAllByRole('radio') as HTMLInputElement[]
    expect([a.disabled, b.disabled, c.disabled]).toEqual([false, false, true])
  })

  it('整组禁用 = 每一颗都禁', () => {
    render(
      <RadioGroup value="a" onChange={() => {}} label="g2" disabled>
        <Radio value="a" label="x" />
        <Radio value="b" label="y" />
      </RadioGroup>,
    )
    const all = screen.getAllByRole('radio') as HTMLInputElement[]
    expect(all.length).toBe(2)
    expect(all.every((el) => el.disabled)).toBe(true)
  })
})
