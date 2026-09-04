import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { render } from '@testing-library/react'
import { Dots } from '../Dots'

/**
 * 三类状态一个不缺(收敛战役纪律)。这件三类里有两类是**空的** —— 空也要
 * 断言,断言的是「它不该长出来」:
 *  · 生命状态:挂载即三颗,卸载零残留(零订阅、零计时器,所以「干净」= 节点走光);
 *  · 交互状态:**它不是控件** —— 不进 Tab 序、不是任何可点角色。守卫:哪天有人
 *    给它加 onClick / tabIndex,这里当场红;
 *  · 数据状态:三颗是**常数**,不吃任何数据 —— 所以断言的是「永远三颗」。
 * 动效档那一格 CSS 说了算,由下面那条读样式表的用例钉着(jsdom 不排版,
 * 但「文件里写没写这两条降级」是可判定的)。
 */
describe('Dots:三个点', () => {
  it('生命状态:挂载画三颗,卸载后容器空干净', () => {
    const { container, unmount } = render(<Dots />)
    expect(container.childElementCount).toBe(1)
    expect(container.firstElementChild!.childElementCount).toBe(3)
    unmount()
    expect(container.innerHTML).toBe('')
  })

  it('数据状态:三颗是常数 —— 它没有任何让点变多变少的口子', () => {
    // 反过来断言:传什么进去都还是三颗(进度是进度条的活,不是这件的)。
    const { container } = render(<Dots className="mine" data-testid="d" />)
    expect(container.firstElementChild!.childElementCount).toBe(3)
  })

  it('交互状态:它不是控件 —— 不进 Tab 序,也不是任何可点角色', () => {
    const { container } = render(<Dots label="Generating" />)
    const el = container.firstElementChild as HTMLElement
    expect(el.tagName).toBe('SPAN')
    expect(el.hasAttribute('tabindex')).toBe(false)
    expect(el.getAttribute('role')).toBe('img')
  })

  /**
   * 守卫:**不给 label 就 aria-hidden**(与 `ui/StatusDot` 同一条判据,
   * 只是缺省档相反 —— 这件几乎总有一个容器在说话)。拆掉即红。
   */
  it('不给 label 时 aria-hidden、无 role;给了 label 才是 role=img + aria-label', () => {
    const { container: bare } = render(<Dots />)
    const hidden = bare.firstElementChild as HTMLElement
    expect(hidden.getAttribute('aria-hidden')).toBe('true')
    expect(hidden.hasAttribute('role')).toBe(false)
    expect(hidden.hasAttribute('aria-label')).toBe(false)

    const { container: named } = render(<Dots label="正在生成" />)
    const spoken = named.firstElementChild as HTMLElement
    expect(spoken.getAttribute('role')).toBe('img')
    expect(spoken.getAttribute('aria-label')).toBe('正在生成')
    expect(spoken.hasAttribute('aria-hidden')).toBe(false)
  })

  /** 它不许自己念 —— 每秒起伏一次的东西挂 live 区等于让读屏软件每秒念一句。 */
  it('无障碍:任何用法下都不挂 aria-live', () => {
    for (const node of [render(<Dots />), render(<Dots label="x" />)]) {
      expect((node.container.firstElementChild as HTMLElement).hasAttribute('aria-live')).toBe(false)
    }
  })

  it('className 追加而不是覆盖 —— 落点的皮肤加得上,自己的配方掉不了', () => {
    const { container } = render(<Dots className="mine" />)
    const cls = (container.firstElementChild as HTMLElement).className
    expect(cls).toMatch(/_dots_/)
    expect(cls).toMatch(/(^| )mine( |$)/)
  })

  it('透传:data-testid 到得了 DOM,且盖不掉语义身份', () => {
    const sneak = { role: 'button', 'aria-label': 'nope' } as Record<string, string>
    const { container } = render(<Dots label="正在生成" data-testid="dots-x" {...sneak} />)
    const el = container.firstElementChild as HTMLElement
    expect(el.getAttribute('data-testid')).toBe('dots-x')
    expect(el.getAttribute('role')).toBe('img')
    expect(el.getAttribute('aria-label')).toBe('正在生成')
  })

  /**
   * 动效档:`none` 与系统 `prefers-reduced-motion` 下 = **三颗静止的点**
   * (§5.3 字面),不是「不画」。jsdom 不排版,所以这里判的是**文件里写没写这两条**
   * —— 与 `components/__tests__/motion-tokens.test.ts` 解析 tokens.css 同一手。
   * 注释先剥掉:病历文本里会引这两条写法当例子(读样式表的门先剥注释,既有法条)。
   */
  it('动效档:两条降级都在,且都是「静止的点」而不是「没有点」', () => {
    const css = readFileSync(path.resolve(__dirname, '../Dots.module.css'), 'utf-8').replace(
      /\/\*[\s\S]*?\*\//g,
      ' ',
    )
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{[^}]*\{([^}]*)\}/.exec(css)
    const tierNone = /:root\[data-motion-tier='none'\] \.dot \{([^}]*)\}/.exec(css)
    for (const block of [reduced?.[1], tierNone?.[1]]) {
      expect(block, '两条降级必须都在').toBeTruthy()
      expect(block).toMatch(/animation:\s*none/)
      // 「静止」不等于「消失」:仍然要有一格看得见的不透明度,而那一格是 token
      // (组件文件零字面量,验收轴一)。
      expect(block).toMatch(/opacity:\s*var\(--dots-rest-opacity\)/)
      expect(block).not.toMatch(/display:\s*none/)
    }
    /*
     * 上面那条只证「消费了那个名字」;名字背后是不是一格看得见的数,得去正本里看
     * —— 少了这半条,把 token 定成 0 会让降级悄悄变成「不画」而两条断言全绿。
     */
    const tokens = readFileSync(path.resolve(__dirname, '../../styles/tokens.css'), 'utf-8').replace(
      /\/\*[\s\S]*?\*\//g,
      ' ',
    )
    expect(tokens).toMatch(/--dots-rest-opacity:\s*0?\.\d+/)
  })
})
