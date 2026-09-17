import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Progress } from '../Progress'

/**
 * `ui/Progress` 的两态(2026-09-17)。这一件唯一容易做错的事是**把「不知道」画成 0%**
 * —— 那会让人以为「开始了但一个字节都没走」,而真相是总数还没问出来。所以这里逐条
 * 钉的是「缺席一路缺到 ARIA」。
 */
describe('Progress', () => {
  it('给了 value:报真值,那一段占对应宽度', () => {
    render(<Progress value={0.38} label="下载" />)
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('0.38')
    expect(bar.getAttribute('aria-valuemin')).toBe('0')
    expect(bar.getAttribute('aria-valuemax')).toBe('1')
    expect(bar.getAttribute('aria-label')).toBe('下载')
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('38%')
  })

  it('`value` 缺席 = 不知道:**不报 `aria-valuenow`**,也不写 width', () => {
    render(<Progress label="下载" />)
    const bar = screen.getByRole('progressbar')
    expect(bar.hasAttribute('aria-valuenow')).toBe(false)
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('')
  })

  it('越界自己夹(后端读数偶尔会越过分母),NaN 当「不知道」', () => {
    const { rerender } = render(<Progress value={1.4} label="下载" />)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1')
    rerender(<Progress value={-3} label="下载" />)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0')
    rerender(<Progress value={Number.NaN} label="下载" />)
    expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false)
  })
})
