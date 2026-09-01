import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Card } from '../Card'

describe('Card:区块卡骨架', () => {
  it('生命状态:挂载画一层卡,卸载零残留', () => {
    const { container, unmount } = render(<Card>body</Card>)
    expect(container.childElementCount).toBe(1)
    expect(container.textContent).toBe('body')
    unmount()
    expect(container.innerHTML).toBe('')
  })

  /**
   * 守卫:**空槽不渲染 DOM**。
   * 一条空檐会在 column flex 里多吃一个 gap,卡身整段下移 —— 看不见的病,
   * 所以这里断言的是「那个节点根本不在」,不是「它是空的」。
   */
  it('生命状态:不给 title 也不给 note 时,整条檐不渲染', () => {
    const { container } = render(<Card>body</Card>)
    expect(container.querySelector('[class*="head"]')).toBeNull()
    expect(container.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull()
    expect(container.querySelector('[class*="note"]')).toBeNull()
    // 卡身仍在:空槽不渲染说的是那一格,不是整件。
    expect(container.firstElementChild?.textContent).toBe('body')
  })

  it('生命状态:只给 note(inline)时檐在、标题不在;只给 title 时反过来', () => {
    const { container: onlyNote } = render(<Card note="cached 3m ago">b</Card>)
    expect(onlyNote.querySelector('[class*="head"]')).not.toBeNull()
    expect(onlyNote.querySelector('h3')).toBeNull()

    const { container: onlyTitle } = render(<Card title="Usage">b</Card>)
    expect(onlyTitle.querySelector('h3')?.textContent).toBe('Usage')
    expect(onlyTitle.querySelector('[class*="note"]')).toBeNull()
  })

  /**
   * 交互状态:**卡不是控件**。整张卡可点的那一形归 ui/ButtonBase ——
   * 这条断言是守卫:哪天有人给 Card 加 onClick / disabled,这里当场红。
   */
  it('交互状态:卡不是控件 —— 没有按钮角色、不进 Tab 序', () => {
    const { container } = render(<Card title="Usage">body</Card>)
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.querySelector('[tabindex]')).toBeNull()
  })

  it('数据状态:titleAs 决定标题层级,缺省 h3(迁移时各面保持原级,不让无障碍树跳级)', () => {
    const { container: def } = render(<Card title="Usage">b</Card>)
    expect(def.querySelector('h3')?.textContent).toBe('Usage')

    const { container: h2 } = render(
      <Card title="Usage" titleAs="h2">
        b
      </Card>,
    )
    expect(h2.querySelector('h2')?.textContent).toBe('Usage')
    expect(h2.querySelector('h3')).toBeNull()

    const { container: h4 } = render(
      <Card title="Usage" titleAs="h4">
        b
      </Card>,
    )
    expect(h4.querySelector('h4')?.textContent).toBe('Usage')
  })

  it('数据状态:note 两个落点是两种东西 —— inline 在檐里、below 在檐外自成一段', () => {
    const { container: inline } = render(
      <Card title="Usage" note="cached 3m ago">
        b
      </Card>,
    )
    const head = inline.querySelector('[class*="head"]') as HTMLElement
    expect(head.textContent).toContain('cached 3m ago')

    const { container: below } = render(
      <Card title="Mode" note="Subscription mode does not use an API key." notePlacement="below">
        b
      </Card>,
    )
    const belowHead = below.querySelector('[class*="head"]') as HTMLElement
    expect(belowHead.textContent).toBe('Mode')
    expect(below.querySelector('p[class*="noteBelow"]')?.textContent).toBe(
      'Subscription mode does not use an API key.',
    )
  })

  it('数据状态:pad 与 bordered 是两格独立开关,className 只追加不覆盖', () => {
    const { container: def } = render(<Card className="mine">b</Card>)
    // CSS Modules 出来的是 `_card_hash _padMd_hash`,所以判据是「有这一段词」。
    const defCls = (def.firstElementChild as HTMLElement).className
    expect(defCls).toMatch(/_padMd_/)
    expect(defCls).toMatch(/_bordered_/)
    expect(defCls).toMatch(/(^| )mine( |$)/)

    const { container: lg } = render(
      <Card pad="lg" bordered={false}>
        b
      </Card>,
    )
    const lgCls = (lg.firstElementChild as HTMLElement).className
    expect(lgCls).toMatch(/_padLg_/)
    expect(lgCls).not.toMatch(/_padMd_/)
    expect(lgCls).not.toMatch(/_bordered_/)
  })

  it('数据状态 · 超量:卡身是开放 children,长内容原样在里面(卡不替内容做减法)', () => {
    const rows = Array.from({ length: 120 }, (_, i) => <p key={i}>row {i}</p>)
    const { container } = render(<Card title="Models">{rows}</Card>)
    expect(container.querySelectorAll('p').length).toBe(120)
  })

  /**
   * 透传口子(批 2c):落点自己的身份**真的到 DOM**。
   * 这条不是形式主义 —— 错误边界那张卡靠 `role="alert"` 才播得出来,
   * 而八处测试靠 `data-testid` 找到它。透传断了,两件事一起哑。
   */
  it('透传:落点自己的 data-testid / role / aria-* 原样落到根节点上', () => {
    const { container } = render(
      <Card
        title="Usage"
        role="alert"
        data-testid="error-card-files"
        aria-label="崩了"
        id="boundary-files"
      >
        b
      </Card>,
    )
    const root = container.firstElementChild as HTMLElement
    expect(root.tagName).toBe('DIV')
    expect(root.getAttribute('role')).toBe('alert')
    expect(root.getAttribute('data-testid')).toBe('error-card-files')
    expect(root.getAttribute('aria-label')).toBe('崩了')
    expect(root.id).toBe('boundary-files')
    // 真的能按 role 找到它(不是只挂了个属性字符串)。
    expect(screen.getByRole('alert')).toBe(root)
  })

  /**
   * 透传**不许变成样式旁路**:皮肤仍然是这件算出来的那一串。
   * `className` 在解构时就被拿走了,所以它不可能出现在 rest 里被覆盖掉 ——
   * 这条断言把那个事实钉住(哪天有人改成 `{...rest}` 在前、`className` 在后,
   * 消费方一个 `className` 就能把 pad / bordered 全抹掉)。
   */
  it('透传:className 合并不被 rest 覆盖 —— 皮肤与落点各说各的', () => {
    const { container } = render(
      <Card pad="lg" className="mine" data-testid="skin">
        b
      </Card>,
    )
    const cls = (container.firstElementChild as HTMLElement).className
    expect(cls).toMatch(/_card_/)
    expect(cls).toMatch(/_padLg_/)
    expect(cls).toMatch(/_bordered_/)
    expect(cls).toMatch(/(^| )mine( |$)/)
  })
})
