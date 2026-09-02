import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Segmented } from '../Segmented'
import { Tabs } from '../Tabs'

/**
 * A11y 线 · A2:两件「一组按钮」的键盘路。两件放一个文件是因为它们验的是**同一条**
 * 规矩(整组一个 Tab 位 + 方向键在组内走 + 移动不等于选中),分开写只会抄两遍。
 *
 * 「移到不等于选中」这一条特别值一条闸:自动激活的实现会在方向键那一步就调
 * onChange / onSelect —— 那是一路走过去把每一档都真的切一遍,可见的副作用。
 */
const OPTIONS = [
  { value: 'a', label: 'A' },
  { value: 'b', label: 'B' },
  { value: 'c', label: 'C' },
]

describe('Segmented:整组禁用(09-02 Dock 放大批立)', () => {
  it('禁着时:点不动、整组退出 Tab 序、也不再入 roving 组', () => {
    const onChange = vi.fn()
    const { container } = render(
      <Segmented options={OPTIONS} value="b" onChange={onChange} label="g" disabled />,
    )
    const radios = screen.getAllByRole('radio')
    fireEvent.click(radios[0])
    expect(onChange).not.toHaveBeenCalled()
    expect(radios.every((el) => (el as HTMLButtonElement).disabled)).toBe(true)
    expect(container.querySelectorAll('[data-roving-item]')).toHaveLength(0)
  })

  it('禁着时组上挂 aria-disabled;不禁时那个属性根本不在(而不是 "false")', () => {
    const { rerender } = render(
      <Segmented options={OPTIONS} value="b" onChange={() => {}} label="g" disabled />,
    )
    expect(screen.getByRole('radiogroup').getAttribute('aria-disabled')).toBe('true')
    rerender(<Segmented options={OPTIONS} value="b" onChange={() => {}} label="g" />)
    expect(screen.getByRole('radiogroup').hasAttribute('aria-disabled')).toBe(false)
    expect(screen.getAllByRole('radio').every((el) => !(el as HTMLButtonElement).disabled)).toBe(true)
  })

  it('禁着不等于失忆:选中的那一段照旧标着 aria-checked', () => {
    render(<Segmented options={OPTIONS} value="c" onChange={() => {}} label="g" disabled />)
    expect(screen.getAllByRole('radio').map((el) => el.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'true',
    ])
  })
})

describe('Segmented:键盘路', () => {
  it('整组一个 Tab 位,落在选中的那一段上', () => {
    render(<Segmented options={OPTIONS} value="b" onChange={() => {}} label="g" />)
    expect(screen.getAllByRole('radio').map((el) => el.tabIndex)).toEqual([-1, 0, -1])
  })

  it('← → 走焦点(循环),Home / End 到端点', () => {
    render(<Segmented options={OPTIONS} value="b" onChange={() => {}} label="g" />)
    const group = screen.getByRole('radiogroup')
    const segs = screen.getAllByRole('radio')
    segs[1].focus()

    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(segs[2])
    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(segs[0])
    fireEvent.keyDown(group, { key: 'End' })
    expect(document.activeElement).toBe(segs[2])
    fireEvent.keyDown(group, { key: 'Home' })
    expect(document.activeElement).toBe(segs[0])
  })

  it('移焦点**不**选中;Enter / 点击才选中', () => {
    const onChange = vi.fn()
    render(<Segmented options={OPTIONS} value="b" onChange={onChange} label="g" />)
    const group = screen.getByRole('radiogroup')
    screen.getAllByRole('radio')[1].focus()

    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getAllByRole('radio')[2])
    expect(onChange).toHaveBeenCalledWith('c')
  })

  it('纵向方向键不归它管 —— 不认识的键不许吞', () => {
    render(<Segmented options={OPTIONS} value="b" onChange={() => {}} label="g" />)
    const segs = screen.getAllByRole('radio')
    segs[1].focus()
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(segs[1])
  })
})

/**
 * 透传口子(09-02 批 8a)。起因是一格具体的哑火:`ui/Field` 里包一件 Segmented
 * 时 `htmlFor` 指了个空,而关联需要落点把 `aria-labelledby` 递进来 ——
 * 这一组守的就是「递得进来、而且盖不掉这件自己的身份与皮肤」。
 */
describe('Segmented:透传口子', () => {
  it('落点自己的 id / aria-* / data-* 原样落到根 <div> 上', () => {
    render(
      <Segmented
        options={OPTIONS}
        value="a"
        onChange={() => {}}
        id="density"
        aria-labelledby="density-label"
        aria-describedby="density-hint"
        data-testid="seg"
      />,
    )
    const group = screen.getByTestId('seg')
    expect(group.tagName).toBe('DIV')
    expect(group.id).toBe('density')
    expect(group.getAttribute('aria-labelledby')).toBe('density-label')
    expect(group.getAttribute('aria-describedby')).toBe('density-hint')
  })

  /**
   * `role` 是这件的语义身份,写在 rest **之后** —— 透传盖不掉。
   * 拆掉那条次序,一个落点就能把 radiogroup 变成别的东西,而它的
   * `role="radio"` 子项当场失去合法的父容器。
   */
  it('role 盖不掉:落点写 role=group 也仍然是 radiogroup', () => {
    render(
      <Segmented
        options={OPTIONS}
        value="a"
        onChange={() => {}}
        role="group"
        data-testid="seg"
      />,
    )
    expect(screen.getByTestId('seg').getAttribute('role')).toBe('radiogroup')
    expect(screen.getAllByRole('radio')).toHaveLength(OPTIONS.length)
  })

  it('className 追加而不是覆盖 —— 落点的皮肤加得上,槽底配方掉不了', () => {
    render(
      <Segmented options={OPTIONS} value="a" onChange={() => {}} className="mine" data-testid="seg" />,
    )
    const cls = screen.getByTestId('seg').className
    expect(cls).toMatch(/_group_/)
    expect(cls).toMatch(/(^| )mine( |$)/)
  })

  /**
   * `label` 缺席时不许把落点自己传的 `aria-label` 抹掉 —— 这正是
   * `aria-label` 排在 rest **之前**的理由(排在后面会写进一个 undefined)。
   */
  it('不给 label 时,落点自己的 aria-label 活着;给了 label 则以它为名', () => {
    const { unmount } = render(
      <Segmented options={OPTIONS} value="a" onChange={() => {}} aria-label="从落点来的" />,
    )
    expect(screen.getByRole('radiogroup', { name: '从落点来的' })).toBeTruthy()
    unmount()

    render(<Segmented options={OPTIONS} value="a" onChange={() => {}} label="从 label 来的" />)
    expect(screen.getByRole('radiogroup', { name: '从 label 来的' })).toBeTruthy()
  })
})

const TABS = [
  { id: 'x', label: 'X' },
  { id: 'y', label: 'Y' },
  { id: 'z', label: 'Z' },
]

describe('Tabs:键盘路', () => {
  it('整条一个 Tab 位,落在活动的那一页上', () => {
    render(<Tabs items={TABS} activeId="y" onSelect={() => {}} label="t" />)
    expect(screen.getAllByRole('tab').map((el) => el.tabIndex)).toEqual([-1, 0, -1])
  })

  it('← → 走焦点但**不切页**;点击才切', () => {
    const onSelect = vi.fn()
    render(<Tabs items={TABS} activeId="y" onSelect={onSelect} label="t" />)
    const list = screen.getByRole('tablist')
    const tabs = screen.getAllByRole('tab')
    tabs[1].focus()

    fireEvent.keyDown(list, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tabs[2])
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.click(tabs[2])
    expect(onSelect).toHaveBeenCalledWith('z')
  })

  it('tab 是 tablist 的**直接**子元素 —— 中间不许再夹一层', () => {
    render(<Tabs items={TABS} activeId="y" onSelect={() => {}} label="t" />)
    const list = screen.getByRole('tablist')
    for (const tab of screen.getAllByRole('tab')) expect(tab.parentElement).toBe(list)
  })

  it('× 住在 tab 里面、不进 Tab 序;点它不顺手切页', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    const { container } = render(
      <Tabs items={TABS} activeId="y" onSelect={onSelect} onClose={onClose} label="t" />,
    )
    const list = screen.getByRole('tablist')
    // tablist 的直接子元素**全部**是 tab —— 别的东西一个都不许露在外面
    // (ARIA 只许 tablist 装 tab;× 露在外面 axe 判 critical)。
    expect([...list.children].every((el) => el.getAttribute('role') === 'tab')).toBe(true)

    /*
     * × 是鼠标的顺手路:装饰性、**连 <button> 都不是**。
     * 判据来自真机 axe 的原话 ——「负 tabindex 加 aria-hidden 也挡不住辅助技术
     * 聚焦到它」,所以一个原生控件放在 role=tab 里怎么修都过不了 nested-interactive。
     * 这条断言钉的就是「这里不许再长回一个控件」。
     */
    expect(container.querySelectorAll('button').length).toBe(0)
    const closes = [...list.querySelectorAll('[aria-hidden="true"]')].filter(
      (el) => el.tagName === 'SPAN' && el.querySelector('svg'),
    )
    expect(closes.length).toBe(TABS.length)

    fireEvent.click(closes[0])
    expect(onClose).toHaveBeenCalledWith('x')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('键盘那一路是 Delete / Backspace;没给 onClose 就什么都不做', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <Tabs items={TABS} activeId="y" onSelect={() => {}} onClose={onClose} label="t" />,
    )
    fireEvent.keyDown(screen.getAllByRole('tab')[1], { key: 'Delete' })
    expect(onClose).toHaveBeenCalledWith('y')

    onClose.mockClear()
    rerender(<Tabs items={TABS} activeId="y" onSelect={() => {}} label="t" />)
    fireEvent.keyDown(screen.getAllByRole('tab')[1], { key: 'Delete' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('tab 不是原生按钮了,Enter / Space 得自己接住', () => {
    const onSelect = vi.fn()
    render(<Tabs items={TABS} activeId="y" onSelect={onSelect} label="t" />)
    const tabs = screen.getAllByRole('tab')
    fireEvent.keyDown(tabs[2], { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('z')
    fireEvent.keyDown(tabs[0], { key: ' ' })
    expect(onSelect).toHaveBeenCalledWith('x')
  })
})
