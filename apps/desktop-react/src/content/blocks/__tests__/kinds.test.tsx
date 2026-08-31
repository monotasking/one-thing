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
/** 一项 / 一段最常见的那一形:纯文本的段落块。 */
const para = (value: string): BlockModel => ({ kind: 'paragraph', inline: text(value) })

function draw(block: BlockModel) {
  return render(<BlockView block={block} ctx={ctx} />)
}

describe('P1 六块上屏', () => {
  it('标题按级数画对标签', () => {
    const { container } = draw({ kind: 'heading', level: 2, inline: text('小标题') })
    expect(container.querySelector('h2')?.textContent).toBe('小标题')
  })

  it('列表:有序画 ol,无序画 ul,项按模型逐条', () => {
    const { container } = draw({ kind: 'list', ordered: true, items: [[para('甲')], [para('乙')]] })
    expect(container.querySelectorAll('ol > li')).toHaveLength(2)
    // 最常见的那一形(单段落项)长成 `<li><p>` —— 像素守恒的那半由 UA 边距清零守
    // (kinds/list/List.module.css 的 `.item > *`),jsdom 量不出层叠,那是真机的活。
    expect(container.querySelectorAll('ol > li > p')).toHaveLength(2)
  })

  it('列表项递归回块视图 —— 项里的围栏真的画成代码块,不再是字面 ``` 文本', async () => {
    const { container } = draw({
      kind: 'list',
      ordered: false,
      items: [[para('看这段:'), { kind: 'code', lang: 'lua', source: 'print(1)', closed: true }]],
    })
    // 代码块的懒加载闸是异步的(拉高亮器);等它落定再断言。
    await act(async () => undefined)
    const li = container.querySelector('ul > li')!
    expect(li.querySelector('[data-block-kind="code"]'), '项里应当有一个代码块的壳').toBeTruthy()
    expect(li.querySelector('pre')?.textContent).toBe('print(1)')
    // 檐在场 = 它走的是同一张注册表 + 同一个壳,不是列表自己画的一段字。
    expect(li.querySelector('header')?.textContent).toContain('lua')
    expect(li.textContent).not.toContain('```')
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
    // jsdom 不跑 CSS 模块的样式表,所以这里断言的是**没有 inline 边框**这一半。
    // 另一半(定稿 C 的四件:大引号在场 / 零盒零线 / UA 缩进已清 / 嵌套小一号)
    // 在 kinds/quote/__tests__/quote.test.tsx —— 它读 CSS 文本,守的是配方本身。
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

  /*
   * 列感应**只归表头**(08-30 报障:身体格也感应 → 行 hover 与整列淡亮叠成十字准星)。
   * 三条一起看才说得清这件事:身体格不感应 / 表头感应 / 从表头滑进表体后列光要灭。
   */
  it('悬到列头,整列的列号写在容器上(淡亮由 CSS 认这个属性)', () => {
    const { container } = draw({
      kind: 'table',
      head: [text('a'), text('b')],
      rows: [[text('1'), text('2')]],
    })
    const table = container.querySelector('table')!
    fireEvent.mouseEnter(container.querySelectorAll('thead th')[1])
    expect(table.getAttribute('data-hover-col')).toBe('1')
    fireEvent.mouseLeave(table)
    expect(table.getAttribute('data-hover-col')).toBeNull()
  })

  it('身体格不感应列:悬到 td,容器上一个列号都不写', () => {
    const { container } = draw({
      kind: 'table',
      head: [text('a'), text('b')],
      rows: [[text('1'), text('2')]],
    })
    const table = container.querySelector('table')!
    fireEvent.mouseEnter(container.querySelectorAll('tbody td')[1])
    expect(table.getAttribute('data-hover-col')).toBeNull()
  })

  it('从列头滑进表体,列光当场灭(整张表还没被离开,只有 thead 那一层管得着)', () => {
    const { container } = draw({
      kind: 'table',
      head: [text('a'), text('b')],
      rows: [[text('1'), text('2')]],
    })
    const table = container.querySelector('table')!
    fireEvent.mouseEnter(container.querySelectorAll('thead th')[0])
    expect(table.getAttribute('data-hover-col')).toBe('0')
    /*
     * 必须带 relatedTarget:React 的 enter/leave 是从 mouseout 那一对里合成的,
     * 落点仍在表内时 **table 的 onMouseLeave 不会响**(它不是被离开的那一层),
     * 响的只有 thead。不带 relatedTarget 的话相当于「鼠标离开了整个文档」,
     * 连 table 那层都会响,这条就白测了。
     */
    fireEvent.mouseOut(container.querySelector('thead')!, {
      relatedTarget: container.querySelector('tbody td')!,
    })
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

  it('图种认不出时兜到源码可见 —— 图源码一个字不少', () => {
    // P3 起 `figure` 在表上了,所以这一条问的是**二级表**的未知格:图块认得,
    // 图种不认得。刻意不用 mermaid —— 那会在这条冒烟里真去拉几 MB 的库,
    // 而这里要验的是降级,不是懒加载。
    const { container } = draw({ kind: 'figure', figKind: 'plantuml', source: '@startuml' })
    expect(container.querySelector('[data-block-kind="figure"]')).toBeTruthy()
    expect(container.textContent).toContain('@startuml')
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
