import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { StatusDot, type StatusDotTone } from '../StatusDot'

/**
 * 三类状态一个不缺(收敛战役纪律):
 *  · 生命状态:挂载即一个节点,卸载零残留(它没有订阅,所以「干净」= 节点走光);
 *  · 交互状态:**它不是控件** —— 反过来断言:任何角色下都不该是 button,
 *    不进 Tab 序。这一条是守卫:哪天有人给它加 onClick,这里当场红;
 *  · 数据状态:六档 tone 各出各的 class,而且六个互不相同。
 */
describe('StatusDot:状态点', () => {
  const TONES: StatusDotTone[] = ['ok', 'info', 'warn', 'bad', 'idle', 'off']

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

  it('数据状态:六档 tone 各出一条自己的 class,互不相同', () => {
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
   * 尺寸两档(09-02 批 8a)。守的是**档位不是自由量**:
   *  · 缺省 = md,而 md **不挂第二个类**(几何写在基类里);
   *  · sm 加且只加一条覆盖类;
   *  · 两档都不接受消费方写死的几何 —— 它没有 style 出口,这里连带钉住。
   * 拆掉即红:sm 与 md 会长得一模一样,那两处檐上的丸就只能继续留在外面自绘。
   */
  it('数据状态:size 两档 —— 缺省 md 不挂第二类,sm 才加一条覆盖', () => {
    const { container: def } = render(<StatusDot tone="warn" />)
    const defCls = (def.firstElementChild as HTMLElement).className
    expect(defCls).toMatch(/_dot_/)
    expect(defCls).not.toMatch(/_sm_/)

    const { container: md } = render(<StatusDot tone="warn" size="md" />)
    // 显式 md 与缺省逐字相同:缺省档就是 md,不是「另一条路」。
    expect((md.firstElementChild as HTMLElement).className).toBe(defCls)

    const { container: sm } = render(<StatusDot tone="warn" size="sm" />)
    const smCls = (sm.firstElementChild as HTMLElement).className
    expect(smCls).toMatch(/_dot_/)
    expect(smCls).toMatch(/_warn_/)
    expect(smCls).toMatch(/_sm_/)
    expect(smCls).not.toBe(defCls)
  })

  it('数据状态:size 与 tone 是两格独立开关(六档 × 两档都成立)', () => {
    const seen = new Set<string>()
    for (const tone of TONES) {
      for (const size of ['sm', 'md'] as const) {
        const { container, unmount } = render(<StatusDot tone={tone} size={size} />)
        seen.add((container.firstElementChild as HTMLElement).className)
        unmount()
      }
    }
    expect(seen.size).toBe(TONES.length * 2)
  })

  it('交互状态:sm 档同样不是控件(尺寸不改变它是什么)', () => {
    const { container } = render(<StatusDot tone="bad" size="sm" label="Unsaved" />)
    const el = container.firstElementChild as HTMLElement
    expect(el.tagName).toBe('SPAN')
    expect(el.hasAttribute('tabindex')).toBe(false)
    expect(el.getAttribute('role')).toBe('img')
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

  /**
   * 属性透传(09-02 批 8c)。守的是**落点自己的身份**这一格:
   *  · `data-testid` / `aria-describedby` 真的到得了 DOM —— 起因是批 8b 时
   *    宿主檐那颗丸的既有契约 testid 无处可挂,只好落在外面那格落位 span 上;
   *  · 透传与 `className` 皮肤同时在场时两不相扰(透传不是样式旁路);
   *  · `role` / `aria-label` 是这件自己的语义身份,**外面盖不掉** ——
   *    类型上已经 Omit 掉(所以下面那条要绕过类型才写得出),
   *    运行时靠它们排在 rest 之后兜住。
   * 拆掉 rest 即红:三条一起挂。
   */
  it('透传:data-testid 与 aria-describedby 真的到 DOM,且不动皮肤', () => {
    const { container } = render(
      <StatusDot tone="warn" size="sm" className="mine" data-testid="dot-x" aria-describedby="why" />,
    )
    const el = container.firstElementChild as HTMLElement
    expect(el.getAttribute('data-testid')).toBe('dot-x')
    expect(el.getAttribute('aria-describedby')).toBe('why')
    // 皮肤三格一格不少:透传摊在 className 之后,但 className 已被解构走,
    // rest 里根本没有它 —— 覆盖不可能发生。
    expect(el.className).toMatch(/_dot_/)
    expect(el.className).toMatch(/_warn_/)
    expect(el.className).toMatch(/_sm_/)
    expect(el.className).toMatch(/(^| )mine( |$)/)
  })

  it('透传盖不掉语义身份:给了 label 时外部 role 与 aria-label 都写不进去', () => {
    // 两个键在类型上已被 Omit,这里刻意绕过类型断言**运行时**也拦得住 ——
    // 判据由「给不给 label」定,不许从外面交出去。
    const sneak = { role: 'button', 'aria-label': 'nope' } as Record<string, string>
    const { container } = render(<StatusDot tone="bad" label="Auth failed" {...sneak} />)
    const el = container.firstElementChild as HTMLElement
    expect(el.getAttribute('role')).toBe('img')
    expect(el.getAttribute('aria-label')).toBe('Auth failed')
  })

  it('透传盖不掉语义身份:不给 label 时外部 aria-hidden 也翻不过来', () => {
    const sneak = { 'aria-hidden': 'false' } as Record<string, string>
    const { container } = render(<StatusDot tone="idle" {...sneak} />)
    expect((container.firstElementChild as HTMLElement).getAttribute('aria-hidden')).toBe('true')
  })
})
