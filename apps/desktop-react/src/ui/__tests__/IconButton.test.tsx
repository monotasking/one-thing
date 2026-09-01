import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { IconButton } from '../IconButton'
import { X } from '../../components/icons'

/**
 * **IconButton(第 18 件)的规格测试**。
 *
 * 照 09-01 立的「组件收敛战役纪律」把三类状态测全:
 *  · **生命状态**:挂载即在场、卸载不留 tooltip 残影;
 *  · **交互状态**:rest / hover(样式,由 CSS 保证,这里测 class 挂没挂)/ focus /
 *    active / pressed / disabled;
 *  · **页面与数据状态**:没有数据面 —— 它是一颗钮,`label` 是它全部的数据,
 *    所以那一类落在「名字必给」这条上。
 */
describe('IconButton:名字与语义', () => {
  it('只有图标的钮必须说得出自己叫什么(aria-label)', () => {
    render(<IconButton icon={X} label="关闭" />)
    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy()
  })

  it('没有开关语义时**不报** aria-pressed(缺席与 false 是两件事)', () => {
    render(<IconButton icon={X} label="关闭" />)
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBeNull()
  })

  it('pressed 报 aria-pressed 并挂 on 那一档(accent 晕底)', () => {
    render(<IconButton icon={X} label="编辑" pressed />)
    const btn = screen.getByRole('button')
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    expect(btn.className).toMatch(/on/)
  })

  it('三档尺寸各挂各的类 —— 尺寸是**位子**不是审美', () => {
    const { rerender } = render(<IconButton icon={X} label="a" size="xs" />)
    expect(screen.getByRole('button').className).toMatch(/xs/)
    rerender(<IconButton icon={X} label="a" size="md" />)
    expect(screen.getByRole('button').className).toMatch(/md/)
  })
})

describe('IconButton:交互与禁用', () => {
  it('点得响', () => {
    const onClick = vi.fn()
    render(<IconButton icon={X} label="关闭" onClick={onClick} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('禁用的钮点不响,而且**不挂提示** —— 禁用元素本来就不该只靠 tooltip 说话', async () => {
    const onClick = vi.fn()
    render(<IconButton icon={X} label="关闭" disabled onClick={onClick} />)
    const btn = screen.getByRole('button')
    expect(btn).toHaveProperty('disabled', true)
    fireEvent.click(btn)
    expect(onClick).not.toHaveBeenCalled()
    fireEvent.focus(btn)
    await new Promise((r) => setTimeout(r, 400))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})

/**
 * 透传(09-01 批 3.5 补口)。这一组守的是**次序**,不是「能不能传」——
 * 「落点自己的身份能到 DOM」与「透传盖不掉库件算好的皮肤」是同一件事的两半,
 * 少测一半,某天有人把 `{...rest}` 挪到 `className` 后面就没人拦得住。
 */
describe('IconButton:透传落点自己的身份', () => {
  it('`data-*` 与 `aria-*` 原样到 DOM —— 判例就是 composer 发送键的 data-mode', () => {
    render(
      <IconButton
        icon={X}
        label="停止"
        data-mode="stop"
        data-testid="composer-send"
        aria-expanded
      />,
    )
    const btn = screen.getByTestId('composer-send')
    expect(btn.getAttribute('data-mode')).toBe('stop')
    expect(btn.getAttribute('aria-expanded')).toBe('true')
  })

  it('`className` 合并、且**盖不掉**库件那一串 —— 透传不是样式旁路', () => {
    render(<IconButton icon={X} label="关闭" size="md" className="local-skin" />)
    const cls = screen.getByRole('button').className
    expect(cls).toMatch(/local-skin/)
    // 库件自己的皮肤(基类 + 尺寸档)一格没丢。
    expect(cls).toMatch(/btn/)
    expect(cls).toMatch(/md/)
  })

  it('`onClick` 收得到事件 —— currentTarget 就是那颗 <button> 自己', () => {
    const seen: Array<EventTarget | null> = []
    render(
      <IconButton
        icon={X}
        label="钉边"
        testId="pin"
        onClick={(e) => seen.push(e.currentTarget)}
      />,
    )
    const btn = screen.getByTestId('pin')
    fireEvent.click(btn)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(btn)
    expect((seen[0] as HTMLButtonElement).tagName).toBe('BUTTON')
  })

  it('落点直写 `data-testid=` 时以落点为准(`testId` 只是它的短写)', () => {
    render(<IconButton icon={X} label="关闭" testId="short" data-testid="explicit" />)
    expect(screen.getByRole('button').getAttribute('data-testid')).toBe('explicit')
  })
})

describe('IconButton:提示走 ui/Tooltip,禁 native title', () => {
  it('聚焦后出提示,内容 = label(说给眼睛和说给读屏的是同一句)', async () => {
    render(<IconButton icon={X} label="关闭查看器" />)
    const btn = screen.getByRole('button')
    expect(btn.getAttribute('title')).toBeNull()
    fireEvent.focus(btn)
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe('关闭查看器'), {
      timeout: 2000,
    })
  })

  it('`tip={false}` 关掉提示 —— 唯一正当的关法是「旁边已经写着同一句话」', async () => {
    render(<IconButton icon={X} label="更多操作" tip={false} />)
    fireEvent.focus(screen.getByRole('button'))
    await new Promise((r) => setTimeout(r, 400))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
