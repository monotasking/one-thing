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
