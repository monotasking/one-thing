import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '../parse'
import { routeFence, isFigureLang } from '../fence'
import type { BlockModel } from '../../model/blocks'

/**
 * 翻译表的单测 —— **逐节点**,外加那条「表外一律 source-fallback」的总纪律。
 *
 * 全是纯函数,jsdom 都不用起:mdast 进,块出。这正是把解析摆在 `markdown/` 而不是
 * 摆在组件里换来的东西。
 */

const blocks = (text: string): BlockModel[] => parseMarkdown(text).map((entry) => entry.block)
const one = (text: string): BlockModel => blocks(text)[0]

describe('翻译表:mdast → BlockModel', () => {
  it('段落:软换行留在 text 节点里(段落不因单个换行结束)', () => {
    expect(one('第一行\n第二行')).toEqual({
      kind: 'paragraph',
      inline: [{ type: 'text', text: '第一行\n第二行' }],
    })
  })

  it('空行是段落边界,偏移是源里的真偏移', () => {
    expect(parseMarkdown('a\n\nb').map((entry) => entry.offset)).toEqual([0, 3])
  })

  it('标题一到三级原样,更深的钳到 3', () => {
    expect(blocks('# a\n\n## b\n\n### c\n\n#### d\n\n###### e').map((block) =>
      block.kind === 'heading' ? block.level : block.kind,
    )).toEqual([1, 2, 3, 3, 3])
  })

  it('行内五件:强调 / 行内码 / 链接 / 删除线 / 硬换行', () => {
    expect(one('**粗** *斜* `码` [文](http://x) ~~删~~')).toEqual({
      kind: 'paragraph',
      inline: [
        { type: 'emphasis', strong: true, children: [{ type: 'text', text: '粗' }] },
        { type: 'text', text: ' ' },
        { type: 'emphasis', strong: false, children: [{ type: 'text', text: '斜' }] },
        { type: 'text', text: ' ' },
        { type: 'code', text: '码' },
        { type: 'text', text: ' ' },
        { type: 'link', href: 'http://x', children: [{ type: 'text', text: '文' }] },
        { type: 'text', text: ' ' },
        { type: 'strike', children: [{ type: 'text', text: '删' }] },
      ],
    })
  })

  it('硬换行翻成一个 `\\n`(段落是 pre-wrap 画的,不需要一个 br 节点)', () => {
    expect(one('a  \nb')).toEqual({
      kind: 'paragraph',
      inline: [{ type: 'text', text: 'a\nb' }],
    })
  })

  it('列表:有序 / 无序各自认得,一项是一串块', () => {
    expect(one('- a\n- b')).toEqual({
      kind: 'list',
      ordered: false,
      items: [
        [{ kind: 'paragraph', inline: [{ type: 'text', text: 'a' }] }],
        [{ kind: 'paragraph', inline: [{ type: 'text', text: 'b' }] }],
      ],
    })
    expect(one('1. a\n2. b')).toMatchObject({ kind: 'list', ordered: true })
  })

  it('嵌套列表拍平一层 —— 内容一个字不丢,层级丢了(记档的过渡形)', () => {
    const list = one('- a\n  - a1\n- b')
    expect(list).toMatchObject({ kind: 'list', ordered: false })
    expect(list.kind === 'list' && list.items.map((item) => item[0])).toEqual([
      { kind: 'paragraph', inline: [{ type: 'text', text: 'a' }] },
      { kind: 'paragraph', inline: [{ type: 'text', text: 'a1' }] },
      { kind: 'paragraph', inline: [{ type: 'text', text: 'b' }] },
    ])
  })
  it('GFM 表:第一行是表头,其余是数据行', () => {
    expect(one('| a | b |\n|---|---|\n| 1 | 2 |')).toEqual({
      kind: 'table',
      head: [[{ type: 'text', text: 'a' }], [{ type: 'text', text: 'b' }]],
      rows: [[[{ type: 'text', text: '1' }], [{ type: 'text', text: '2' }]]],
    })
  })

  it('引用 → quote 块,里面照样是块(嵌套 = 注册表复用)', () => {
    expect(one('> 一段\n>\n> ```js\n> x\n> ```')).toMatchObject({
      kind: 'quote',
      blocks: [{ kind: 'paragraph' }, { kind: 'code', lang: 'js' }],
    })
  })

  it('围栏:闭合的 closed:true,没闭合的 closed:false(流式契约的判据)', () => {
    expect(one('```ts\nconst a = 1\n```')).toEqual({
      kind: 'code',
      lang: 'ts',
      source: 'const a = 1',
      closed: true,
    })
    expect(one('```ts\nconst a = 1\n')).toMatchObject({ closed: false })
  })

  it('缩进代码块天然是闭合的(它没有围栏,由下一行不缩进结束)', () => {
    expect(one('    const a = 1\n')).toMatchObject({ kind: 'code', closed: true, lang: null })
  })
})

/**
 * 项内嵌块(08-31 真机报障:``` ```lua ``` 原样可见)。
 *
 * 病根是项内只装行内,非段落子块只好取源码原文当字面文字。这一组钉的是那条修法:
 * 项内逐子块走**同一张翻译表**,和引用块是同一个答案。
 */
describe('列表项里嵌块 —— 注册表复用,不再拍平成字面文本', () => {
  const itemsOf = (text: string): BlockModel[][] => {
    const list = one(text)
    if (list.kind !== 'list') throw new Error(`不是列表:${list.kind}`)
    return list.items
  }

  it('项含围栏 → [paragraph, code(lang=lua)],不再是一段 ``` 字面文本', () => {
    const [item] = itemsOf('- 看这段:\n\n  ```lua\n  print(1)\n  ```\n')
    expect(item).toEqual([
      { kind: 'paragraph', inline: [{ type: 'text', text: '看这段:' }] },
      { kind: 'code', lang: 'lua', source: 'print(1)', closed: true },
    ])
  })

  it('项含表 / 引用 / 分隔线,各按本来的块画', () => {
    expect(itemsOf('- 表:\n\n  | a |\n  |---|\n  | 1 |\n')[0]).toMatchObject([
      { kind: 'paragraph' },
      { kind: 'table' },
    ])
    expect(itemsOf('- 引:\n\n  > 一句\n')[0]).toMatchObject([
      { kind: 'paragraph' },
      { kind: 'quote', blocks: [{ kind: 'paragraph' }] },
    ])
    expect(itemsOf('- 线:\n\n  ---\n')[0]).toMatchObject([{ kind: 'paragraph' }, { kind: 'divider' }])
  })

  it('一项里连续两段 = 两个 paragraph 块(从前被 `\\n` 接成一棵行内树)', () => {
    expect(itemsOf('- 上一段\n\n  下一段\n')[0]).toEqual([
      { kind: 'paragraph', inline: [{ type: 'text', text: '上一段' }] },
      { kind: 'paragraph', inline: [{ type: 'text', text: '下一段' }] },
    ])
  })

  it('项内没闭合的围栏照旧是 closed:false —— 流式契约不需要为项内特判', () => {
    expect(itemsOf('- 看这段:\n\n  ```lua\n  print(1)\n')[0]).toMatchObject([
      { kind: 'paragraph' },
      { kind: 'code', lang: 'lua', closed: false },
    ])
  })
})

describe('分隔线 → divider 块(08-31 真机报障后进表:一条横线不是一段源码)', () => {
  it.each([['---'], ['***'], ['___']])('%s', (source) => {
    expect(one(source)).toEqual({ kind: 'divider' })
  })
})

describe('表外节点一律 source-fallback —— 原文永远可见', () => {
  it.each([
    ['HTML 块', '<div>x</div>'],
    ['脚注定义', '[^1]: 一条脚注'],
  ])('%s', (_name, source) => {
    const block = one(source)
    expect(block.kind).toBe('source-fallback')
    // reason 是机器口径的一个词(`md:<节点类型>`),不是界面文案。
    expect(block.kind === 'source-fallback' && block.reason.startsWith('md:')).toBe(true)
    expect(block.kind === 'source-fallback' && block.source).toContain(source.slice(0, 3))
  })
})

describe('围栏路由:语言即路由', () => {
  it('图种围栏闭合后进 figure(P3 起注册表里有渲染器,figKind 仍是原样的语言名)', () => {
    expect(one('```mermaid\ngraph TD\n```')).toEqual({
      kind: 'figure',
      figKind: 'mermaid',
      source: 'graph TD',
    })
  })

  it('图种围栏没闭合时按 code 显示,闭合那一刻才换装', () => {
    expect(routeFence('mermaid', 'graph TD', false)).toMatchObject({ kind: 'code', closed: false })
    expect(routeFence('mermaid', 'graph TD', true)).toMatchObject({ kind: 'figure' })
  })

  it('```diff 闭合后进 diff 一等块(P2 留账在 P3 结清:与工具产地同一个块)', () => {
    expect(one('```diff\n+a\n-b\n```')).toEqual({
      kind: 'diff',
      source: '+a\n-b',
      // 没有 @@ 头的碎片:一个隐式 hunk,起始行号缺席(编不出来就不编)。
      hunks: [{ lines: [{ kind: 'add', text: 'a' }, { kind: 'del', text: 'b' }] }],
      stat: { add: 1, del: 1 },
    })
  })

  it('```diff 没闭合时按 code 显示(半段 diff 的行号无从起算)', () => {
    expect(routeFence('diff', '+a', false)).toMatchObject({ kind: 'code', lang: 'diff', closed: false })
  })

  it('标了 diff 却不像 diff 的那段文字退回 code —— 降级,不报错', () => {
    expect(one('```diff\njust some prose\n```')).toEqual({
      kind: 'code',
      lang: 'diff',
      source: 'just some prose',
      closed: true,
    })
  })

  it('图种表认小写原名,别的语言一律 code', () => {
    expect(isFigureLang('mermaid')).toBe(true)
    expect(isFigureLang('plantuml')).toBe(true)
    expect(isFigureLang('ts')).toBe(false)
    expect(isFigureLang(null)).toBe(false)
  })
})
