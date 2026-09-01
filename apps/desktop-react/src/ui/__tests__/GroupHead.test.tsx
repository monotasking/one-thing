import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { FormEvent } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { GroupHead } from '../GroupHead'

/** 读样式表源文本的断言先剥注释(本仓纪律:病历文本会让断言自红)。 */
function css(file: string) {
  const at = path.join(__dirname, '..', file)
  return readFileSync(at, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, ' ')
}

describe('GroupHead:列表分组头', () => {
  it('生命状态:不给 onToggle 是静态组头(div,不进 Tab 序);卸载零残留', () => {
    const { container, unmount } = render(<GroupHead label="Cloud" />)
    expect(container.firstElementChild?.tagName).toBe('DIV')
    expect(screen.queryByRole('button')).toBeNull()
    unmount()
    expect(container.innerHTML).toBe('')
  })

  /**
   * 守卫:**空槽不渲染 DOM**,不是渲染一个空壳。
   * 空壳在 flex 行里会多吃一个 gap,组名的截断点跟着漂 —— 看不见的病。
   */
  it('生命状态:不给 note 时那一格连节点都不在', () => {
    const { container: bare } = render(<GroupHead label="Cloud" />)
    expect(bare.querySelector('[class*="note"]')).toBeNull()

    const { container: withNote } = render(<GroupHead label="Cloud" note="12 models" />)
    expect(withNote.querySelector('[class*="note"]')?.textContent).toBe('12 models')
  })

  it('交互状态:给了 onToggle 就是原生 button,点一下交出去、aria-expanded 跟着 collapsed 翻', () => {
    const onToggle = vi.fn()
    const { rerender } = render(<GroupHead label="anthropic/" collapsed onToggle={onToggle} />)
    const btn = screen.getByRole('button')
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(btn)
    expect(onToggle).toHaveBeenCalledTimes(1)
    // 受控:自己不翻,只画被告知的那一态。
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')

    rerender(<GroupHead label="anthropic/" collapsed={false} onToggle={onToggle} />)
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true')
  })

  /**
   * 键盘白送的那一半:jsdom 不实现 <button> 的「↵/Space → 激活行为」,
   * 所以这里断言的是**它凭什么白送** —— 一个真的 `<button>`,
   * 而且 `type="button"`(ButtonBase 的默认档):
   * 一个「展开这一组」的行长在表单里,按下去不该顺手提交整张表。
   */
  it('交互状态:是 type=button 的原生钮 —— 键盘语义与「不提交表单」都由它白送', () => {
    const onSubmit = vi.fn((e: FormEvent) => e.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <GroupHead label="anthropic/" collapsed onToggle={() => {}} />
      </form>,
    )
    const btn = screen.getByRole('button')
    expect(btn.getAttribute('type')).toBe('button')
    fireEvent.click(btn)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('交互状态:disabled 时点不动(判例:检索时组由判据打开,那一刻点它不该关上)', () => {
    const onToggle = vi.fn()
    render(<GroupHead label="anthropic/" collapsed={false} disabled onToggle={onToggle} />)
    const btn = screen.getByRole('button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(onToggle).not.toHaveBeenCalled()
    // 禁着也要**看得见组名**:禁用说的是「现在按不动」,不是「这行不重要」。
    expect(btn.textContent).toContain('anthropic/')
  })

  /**
   * 交互状态 · 规范修正(09-01 批 2c 拍定):**禁着不淡化,只换指针**。
   * 唯一的消费方语义是「组被判据打开、钮禁点」——那是一种**模式**,不是
   * 「这一组不可用」;淡下去会让人以为整组内容用不了,而它盖住的恰好是
   * 检索命中最需要看清的那一行。jsdom 不算样式,所以这条钉的是配方本身。
   */
  it('交互状态:禁用只换指针,一点都不淡(去掉 opacity 是本批的规范修正)', () => {
    const sheet = css('GroupHead.module.css')
    const m = sheet.match(/\.head:disabled\s*\{([^}]*)\}/)
    expect(m).toBeTruthy()
    expect(m?.[1]).toMatch(/cursor:\s*default/)
    expect(m?.[1]).not.toMatch(/opacity/)
    // 整份样式表里都不该再有淡化 —— 换个选择器写回来同样算复活。
    expect(sheet).not.toMatch(/opacity/)
  })

  it('数据状态:caret 随开合换向,且不进无障碍树(aria-expanded 才是给读屏的那一句)', () => {
    const { container, rerender } = render(<GroupHead label="g" collapsed onToggle={() => {}} />)
    const caret = () => container.querySelector('[class*="caret"]') as HTMLElement
    expect(caret().getAttribute('aria-hidden')).toBe('true')
    expect(caret().textContent).toBe('▸')

    rerender(<GroupHead label="g" collapsed={false} onToggle={() => {}} />)
    expect(caret().textContent).toBe('▾')
  })

  /**
   * 数据状态 · 挤压纪律(律一):一行恰有一个弯腰件,**结构行只截断不换行**。
   * 判例:08-30 长组名折行,把右端读数压住 —— 真机量出来的病。
   * jsdom 不排版,所以这条钉的是**配方本身**:两格都要 min-width: 0 + 单行省略号,
   * 而且吸剩余空间的角色只有 note 一个。
   */
  it('数据状态:超长 note 与超长组名都只截断不换行,吸空间的角色只有 note', () => {
    const sheet = css('GroupHead.module.css')
    const rule = (name: string) => {
      const m = sheet.match(new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`))
      return m?.[1] ?? ''
    }
    for (const name of ['label', 'note']) {
      expect(rule(name)).toMatch(/min-width:\s*0/)
      expect(rule(name)).toMatch(/white-space:\s*nowrap/)
      expect(rule(name)).toMatch(/text-overflow:\s*ellipsis/)
      expect(rule(name)).toMatch(/overflow:\s*hidden/)
    }
    expect(rule('note')).toMatch(/flex:\s*1 1 auto/)
    expect(rule('label')).toMatch(/flex:\s*0 1 auto/)

    // 真渲染一遍:超长文本原样在 note 那一格里,没有被组件自己截字符串
    //(截断是排版的事,不是把内容改短 —— 复制出来的仍该是全文)。
    const long = 'anthropic/claude-fable-5-with-a-very-long-suffix'
    render(<GroupHead label="g" note={long} onToggle={() => {}} collapsed={false} />)
    expect(screen.getByText(long)).toBeTruthy()
  })

  /**
   * 透传口子(批 2c):**两形都要透**。
   * 模型目录那两条组头带着 `data-testid`,而既有测试正是靠它找到组头去点、
   * 去读 disabled —— 透传断了,等价迁移的证词当场全哑。
   */
  it('透传:静态形的 data-testid / role / aria-* 落到那个 <div> 上', () => {
    const { container } = render(
      <GroupHead label="已选 · 3" data-testid="picked-head" role="presentation" id="ph" />,
    )
    const root = container.firstElementChild as HTMLElement
    expect(root.tagName).toBe('DIV')
    expect(root.getAttribute('data-testid')).toBe('picked-head')
    expect(root.getAttribute('role')).toBe('presentation')
    expect(root.id).toBe('ph')
  })

  it('透传:可折叠形的 data-testid 落到那颗钮上,且 aria-expanded 仍归 collapsed 管', () => {
    render(
      <GroupHead
        label="anthropic/"
        collapsed
        disabled
        onToggle={() => {}}
        data-testid="model-group-anthropic/"
        aria-label="anthropic 组"
      />,
    )
    const btn = screen.getByTestId('model-group-anthropic/') as HTMLButtonElement
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('aria-label')).toBe('anthropic 组')
    // 开合只有 collapsed 一个产地:透传排在它前面,盖不掉。
    expect(btn.getAttribute('aria-expanded')).toBe('false')
  })

  /**
   * 透传**不是样式旁路**:皮肤仍然是 `.head` + 消费方的 className 那一串。
   * 哪天有人把 `{...rest}` 挪到 className 后面,消费方一个 className
   * 就能把库件的排布整份抹掉 —— 这条守着那个次序。
   */
  it('透传:className 合并不被 rest 覆盖(两形同判)', () => {
    const { container: div } = render(<GroupHead label="g" className="mine" data-testid="a" />)
    const divCls = (div.firstElementChild as HTMLElement).className
    expect(divCls).toMatch(/_head_/)
    expect(divCls).toMatch(/(^| )mine( |$)/)

    render(
      <GroupHead label="g" className="mine" collapsed onToggle={() => {}} data-testid="b" />,
    )
    const btnCls = screen.getByTestId('b').className
    expect(btnCls).toMatch(/_head_/)
    expect(btnCls).toMatch(/(^| )mine( |$)/)
  })
})
