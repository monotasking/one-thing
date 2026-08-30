import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { BlockView } from '../BlockView'
import type { BlockCtx } from '../registry'
import type { BlockModel } from '../../model/blocks'
import { useStageStore } from '../../../stage/store'

/**
 * P1 六个块的**上屏冒烟**(jsdom 只用在这一格:结构与热区)。
 *
 * 判据不是「长得好不好看」—— 那是真机的事;是三件在纯函数层测不到的:
 *  ① 注册 barrel 真的把它们接上了(查表 → 进壳 → 画出本体);
 *  ② 引用块递归回 `BlockView` 的那条**环形 import** 在运行时确实成立
 *     (barrel → quote → BlockView → barrel:ESM 的活绑定接得住,但接不住就是白屏,
 *      纯函数测试永远发现不了);
 *  ③ 定稿里那几条「必须在场 / 必须不在场」的东西(表格的列复制热区、代码檐上的语言)。
 */

// shiki 在这条冒烟里不该被拉起:它是异步的,而这里要断言的恰恰是**素文本先行**。
vi.mock('../kinds/code/highlight', () => ({
  loadHighlighter: () => Promise.resolve(undefined),
  highlight: () => undefined,
  HIGHLIGHT_THEME: 'vitesse-light',
  resetHighlighterForTest: () => undefined,
}))

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
})

const ctx: BlockCtx = { messageId: 'a1', streaming: false }
const text = (value: string) => [{ type: 'text' as const, text: value }]

function draw(block: BlockModel) {
  return render(<BlockView block={block} ctx={ctx} />)
}

describe('P1 六块上屏', () => {
  it('标题按级数画对标签', () => {
    const { container } = draw({ kind: 'heading', level: 2, inline: text('小标题') })
    expect(container.querySelector('h2')?.textContent).toBe('小标题')
  })

  it('列表:有序画 ol,无序画 ul,项按模型逐条', () => {
    const { container } = draw({ kind: 'list', ordered: true, items: [text('甲'), text('乙')] })
    expect(container.querySelectorAll('ol > li')).toHaveLength(2)
  })

  it('引用递归回块视图 —— 环形 import 在运行时成立(里面装的是代码块)', async () => {
    const { container } = draw({
      kind: 'quote',
      blocks: [{ kind: 'code', lang: 'ts', source: 'const a = 1', closed: true }],
    })
    // 代码块的懒加载闸是异步的(拉高亮器);等它落定再断言,免得 act 警告淹掉真信号。
    await act(async () => undefined)
    expect(container.querySelector('blockquote')).toBeTruthy()
    expect(container.querySelector('[data-block-kind="code"]')).toBeTruthy()
    expect(container.textContent).toContain('const a = 1')
  })

  it('引用块**不许**有左竖线(全域禁令,而它是这条禁令最容易破的地方)', () => {
    const { container } = draw({ kind: 'quote', blocks: [{ kind: 'paragraph', inline: text('引') }] })
    const quote = container.querySelector('blockquote')
    const style = quote ? getComputedStyle(quote) : undefined
    // jsdom 不跑 CSS 模块的样式表,所以这里断言的是**没有 inline 边框**这一半;
    // 真正的守卫在 Quote.module.css 的头注里(那句禁令写给下一个改这个文件的人)。
    expect(style?.borderLeftWidth || '0px').toBe('0px')
  })

  it('代码檐:左端是语言(小写 mono 灰),本体是素文本(高亮还没到)', async () => {
    const { container } = draw({ kind: 'code', lang: 'ts', source: 'const a = 1', closed: true })
    await act(async () => undefined)
    expect(container.querySelector('header')?.textContent).toContain('ts')
    expect(container.querySelector('pre')?.textContent).toBe('const a = 1')
    expect(screen.getByText('复制源码')).toBeTruthy()
  })

  it('表格:无斑马 / 列头带 ⧉ 复制列 / 檐上两个复制动作', () => {
    const { container } = draw({
      kind: 'table',
      head: [text('名字'), text('数量')],
      rows: [[text('苹果'), text('3')]],
    })
    expect(container.querySelectorAll('thead th')).toHaveLength(2)
    // 列复制是**块内热区**(长在列头上),不进檐上的动作组。
    expect(screen.getAllByLabelText('复制这一列')).toHaveLength(2)
    expect(screen.getByText('复制 Markdown')).toBeTruthy()
    expect(screen.getByText('复制 CSV')).toBeTruthy()
  })

  it('悬到单元格,整列的列号写在容器上(淡亮由 CSS 认这个属性)', () => {
    const { container } = draw({
      kind: 'table',
      head: [text('a'), text('b')],
      rows: [[text('1'), text('2')]],
    })
    const table = container.querySelector('table')!
    fireEvent.mouseEnter(container.querySelectorAll('tbody td')[1])
    expect(table.getAttribute('data-hover-col')).toBe('1')
    fireEvent.mouseLeave(table)
    expect(table.getAttribute('data-hover-col')).toBeNull()
  })

  it('数字列右对齐 + mono(判据是列里装的是什么)', () => {
    const { container } = draw({
      kind: 'table',
      head: [text('名字'), text('数量')],
      rows: [[text('苹果'), text('3')]],
    })
    const cells = Array.from(container.querySelectorAll('tbody td'))
    expect(cells[0].className).not.toContain('numeric')
    expect(cells[1].className).toContain('numeric')
  })

  it('没注册的 kind(figure)兜到源码可见 —— 图源码一个字不少', () => {
    const { container } = draw({ kind: 'figure', figKind: 'mermaid', source: 'graph TD' })
    expect(container.querySelector('[data-block-kind="figure"]')).toBeTruthy()
    expect(container.textContent).toContain('graph TD')
  })
})

describe('行内那一层(全仓一份)', () => {
  it('强调 / 行内码 / 删除线 / 链接各画各的标签', () => {
    const { container } = draw({
      kind: 'paragraph',
      inline: [
        { type: 'emphasis', strong: true, children: text('粗') },
        { type: 'emphasis', strong: false, children: text('斜') },
        { type: 'code', text: '码' },
        { type: 'strike', children: text('删') },
        { type: 'link', href: 'http://x', children: text('文') },
      ],
    })
    expect(container.querySelector('strong')?.textContent).toBe('粗')
    expect(container.querySelector('em')?.textContent).toBe('斜')
    expect(container.querySelector('code')?.textContent).toBe('码')
    expect(container.querySelector('s')?.textContent).toBe('删')
  })

  it('链接本批不是 `<a>`:目标地址进 title,点击行为留账(壳里还没有开外链的面)', () => {
    const { container } = draw({
      kind: 'paragraph',
      inline: [{ type: 'link', href: 'http://x', children: text('文') }],
    })
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('[title="http://x"]')?.textContent).toBe('文')
  })
})
