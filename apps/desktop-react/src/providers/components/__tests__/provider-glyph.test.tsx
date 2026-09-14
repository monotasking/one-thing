import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ProviderGlyph } from '../ProviderGlyph'
import { providerIconOf } from '../../provider-icons'
import css from '../ProviderGlyph.module.css'

/**
 * 一家供应商的方图标(09-14,用户报障「供应商只有字母」)。
 *
 * 这一件的全部事实只有三格:**画图标还是画首字母**、**是不是自定义家**、**多大**。
 * 「此刻画的是哪一种」由 `data-glyph` 自述(类名构建后是哈希,而这是一格事实,
 * 不是一层皮),所以门与单测都按它取,不按像素也不按文字。
 */

function glyph() {
  return screen.getByTestId('glyph')
}

describe('ProviderGlyph', () => {
  it('有图标:画 mask 那一层,一个字都不画', () => {
    render(<ProviderGlyph familyId="deepseek" label="DeepSeek" data-testid="glyph" />)
    const box = glyph()
    expect(box.dataset.glyph).toBe('icon')
    // 「没有字」是这一条的正题:报障那一形就是这里剩着一个 'D'。
    expect(box.textContent).toBe('')
    const mark = box.firstElementChild as HTMLElement
    expect(mark.classList.contains(css.mark)).toBe(true)
    // 图标地址走自定义属性进 CSS —— mask 的配方在样式表里,这里只递地址。
    expect(mark.getAttribute('style')).toContain(providerIconOf('deepseek'))
  })

  it('没图标:回落首字母', () => {
    render(<ProviderGlyph familyId="qwen" label="Qwen" data-testid="glyph" />)
    const box = glyph()
    expect(box.dataset.glyph).toBe('initial')
    expect(box.textContent).toBe('Q')
    expect(box.querySelector(`.${css.mark}`)).toBeNull()
  })

  it('自定义家:虚线边那一类,且照旧回落首字母', () => {
    render(
      <ProviderGlyph familyId="custom:my-gateway" label="我的网关" custom data-testid="glyph" />,
    )
    const box = glyph()
    expect(box.classList.contains(css.custom)).toBe(true)
    expect(box.dataset.glyph).toBe('initial')
    expect(box.textContent).toBe('我')
  })

  it('不是自定义家就不挂虚线那一类', () => {
    render(<ProviderGlyph familyId="openai" label="OpenAI" data-testid="glyph" />)
    expect(glyph().classList.contains(css.custom)).toBe(false)
  })

  it('两档:缺省是名册行那枚 22 方,md 是详情头那枚 36 方', () => {
    const { rerender } = render(
      <ProviderGlyph familyId="claude" label="Claude" data-testid="glyph" />,
    )
    expect(glyph().classList.contains(css.sm)).toBe(true)
    expect(glyph().classList.contains(css.md)).toBe(false)

    rerender(<ProviderGlyph familyId="claude" label="Claude" size="md" data-testid="glyph" />)
    expect(glyph().classList.contains(css.md)).toBe(true)
    expect(glyph().classList.contains(css.sm)).toBe(false)
  })

  it('不进无障碍树 —— 名字就在旁边 / Tooltip 正念着同一句', () => {
    render(<ProviderGlyph familyId="claude" label="Claude" data-testid="glyph" />)
    expect(glyph().getAttribute('aria-hidden')).toBe('true')
  })

  /*
   * 这一件必须是**透明**的:名册把 `s.icon`(收起档那三条落点规则的把手)与
   * Tooltip 用 cloneElement 接上来的四只指针手一起交给它。不转发 = 收起档里
   * 提示悄悄不出了,而且不报错 —— 只能靠这一条抓。
   */
  it('自己那几格以外的 props 原样递给方框', () => {
    const onMouseEnter = vi.fn()
    render(
      <ProviderGlyph
        familyId="claude"
        label="Claude"
        className="rail-hook"
        onMouseEnter={onMouseEnter}
        data-testid="glyph"
      />,
    )
    const box = glyph()
    expect(box.classList.contains('rail-hook')).toBe(true)
    // 自己那一套类名没有被 className 挤掉 —— 两边都在。
    expect(box.classList.contains(css.glyph)).toBe(true)
    fireEvent.mouseEnter(box)
    expect(onMouseEnter).toHaveBeenCalledTimes(1)
  })
})
