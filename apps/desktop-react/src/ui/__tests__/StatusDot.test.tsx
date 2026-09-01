import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { StatusDot, type StatusDotTone } from '../StatusDot'

/**
 * 三类状态一个不缺(收敛战役纪律):
 *  · 生命状态:挂载即一个节点,卸载零残留(它没有订阅,所以「干净」= 节点走光);
 *  · 交互状态:**它不是控件** —— 反过来断言:任何角色下都不该是 button,
 *    不进 Tab 序。这一条是守卫:哪天有人给它加 onClick,这里当场红;
 *  · 数据状态:五档 tone 各出各的 class,而且五个互不相同。
 */
describe('StatusDot:状态点', () => {
  const TONES: StatusDotTone[] = ['ok', 'warn', 'bad', 'idle', 'off']

  it('生命状态:挂载画一个节点,卸载后容器空干净', () => {
    const { container, unmount } = render(<StatusDot tone="ok" />)
    expect(container.childElementCount).toBe(1)
    unmount()
    expect(container.innerHTML).toBe('')
  })

  it('交互状态:它不是控件 —— 不进 Tab 序,也不是任何可点角色', () => {
    const { container } = render(<StatusDot tone="warn" label="Needs attention" />)
    const el = container.firstElementChild as HTMLElement
    expect(el.tagName).toBe('SPAN')
    expect(el.hasAttribute('tabindex')).toBe(false)
    expect(el.getAttribute('role')).toBe('img')
  })

  it('数据状态:五档 tone 各出一条自己的 class,互不相同', () => {
    const seen = new Set<string>()
    for (const tone of TONES) {
      const { container, unmount } = render(<StatusDot tone={tone} />)
      const cls = (container.firstElementChild as HTMLElement).className
      // CSS Modules 出来的是 `_dot_hash _ok_hash`,所以判据是「有这一段词」。
      expect(cls).toMatch(new RegExp(`_${tone}_`))
      seen.add(cls)
      unmount()
    }
    expect(seen.size).toBe(TONES.length)
  })

  /**
   * 守卫:**不给 label 就 aria-hidden**。点旁边通常已经有等价文字,
   * 再念一遍是噪音 —— 这条判据是这件的无障碍全部,拆掉即红。
   */
  it('不给 label 时 aria-hidden、无 role;给了 label 才是 role=img + aria-label', () => {
    const { container: bare } = render(<StatusDot tone="idle" />)
    const hidden = bare.firstElementChild as HTMLElement
    expect(hidden.getAttribute('aria-hidden')).toBe('true')
    expect(hidden.hasAttribute('role')).toBe(false)
    expect(hidden.hasAttribute('aria-label')).toBe(false)

    const { container: named } = render(<StatusDot tone="bad" label="Auth failed" />)
    const spoken = named.firstElementChild as HTMLElement
    expect(spoken.getAttribute('role')).toBe('img')
    expect(spoken.getAttribute('aria-label')).toBe('Auth failed')
    expect(spoken.hasAttribute('aria-hidden')).toBe(false)
  })

  it('className 追加而不是覆盖 —— 落点的皮肤加得上,自己的配方掉不了', () => {
    const { container } = render(<StatusDot tone="ok" className="mine" />)
    const cls = (container.firstElementChild as HTMLElement).className
    expect(cls).toMatch(/_dot_/)
    expect(cls).toMatch(/_ok_/)
    expect(cls).toMatch(/(^| )mine( |$)/)
  })
})
