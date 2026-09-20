import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '../parse'
import { MarkdownStream } from '../incremental'
import { stableCut } from '../stable-cut'
import { markdownToFrame } from '../../assemble/markdown'
import { inlineText } from '../../model/inline'
import type { InlineNode } from '../../model/inline'
import type { BlockModel } from '../../model/blocks'

/**
 * **助手那句话里的 `<ref/>`**(B2,正本 `docs/design/reference-tag-2026-09.md` §2.5/§2.6)。
 *
 * 这只文件量的是**翻译表**与**流式扣尾**两件事,一个种类名都不出现:认不认得出
 * `type="file"` 是 `src/references/` 那张表的事,这一层只管「这里有没有一格 ref
 * 节点」。所以下面用的 type 是随手写的 —— 翻译表本来就不该在乎。
 */

const blocksOf = (src: string): BlockModel[] => parseMarkdown(src).map((entry) => entry.block)
const soleParagraph = (src: string): InlineNode[] => {
  const blocks = blocksOf(src)
  expect(blocks).toHaveLength(1)
  const block = blocks[0]
  expect(block.kind).toBe('paragraph')
  return (block as Extract<BlockModel, { kind: 'paragraph' }>).inline
}
const kinds = (nodes: readonly InlineNode[]) => nodes.map((n) => n.type)

describe('行内:micromark 把标签切成什么,翻译表都认得出', () => {
  it('句中一个', () => {
    const inline = soleParagraph('看 <ref type="file" path="/a/b.ts" line="3"/> 这里')
    expect(kinds(inline)).toEqual(['text', 'ref', 'text'])
    expect(inline[1]).toEqual({
      type: 'ref',
      tag: { type: 'file', attrs: { path: '/a/b.ts', line: '3' } },
    })
  })

  it('句中两个相邻(中间一个字都没有)', () => {
    const inline = soleParagraph('看 <ref type="a" id="1"/><ref type="b" id="2"/> 两个')
    expect(kinds(inline)).toEqual(['text', 'ref', 'ref', 'text'])
  })

  it('紧贴中文标点 —— 标点还是标点,一个字都不吞', () => {
    const inline = soleParagraph('看<ref type="a" id="1"/>,然后')
    expect(kinds(inline)).toEqual(['text', 'ref', 'text'])
    expect((inline[2] as { text: string }).text).toBe(',然后')
  })

  it('宽容形 `<ref …>文字</ref>`:文字进 label,三个节点合成一格', () => {
    const inline = soleParagraph('<ref type="a" id="1">那一条</ref> 在句首')
    expect(kinds(inline)).toEqual(['ref', 'text'])
    expect(inline[0]).toEqual({
      type: 'ref',
      tag: { type: 'a', attrs: { id: '1', label: '那一条' } },
    })
  })

  it('宽容形没闭合 = 原文照抄(总纪律)', () => {
    const inline = soleParagraph('<ref type="a" id="1">那一条 后面没有闭合')
    expect(kinds(inline)).toEqual(['text'])
    expect(inlineText(inline)).toBe('<ref type="a" id="1">那一条 后面没有闭合')
  })

  it('强调里面', () => {
    const inline = soleParagraph('**<ref type="a" id="1"/>** 强调')
    expect(kinds(inline)).toEqual(['emphasis', 'text'])
    const strong = inline[0] as Extract<InlineNode, { type: 'emphasis' }>
    expect(kinds(strong.children)).toEqual(['ref'])
  })

  it('表格单元格里', () => {
    const blocks = blocksOf('| a | b |\n| - | - |\n| <ref type="a" id="1"/> | x |')
    expect(blocks[0].kind).toBe('table')
    const table = blocks[0] as Extract<BlockModel, { kind: 'table' }>
    expect(kinds(table.rows[0][0])).toEqual(['ref'])
  })

  it('行内码里**是字面量**(markdown 解析器天然保证)', () => {
    const inline = soleParagraph('`<ref type="a" id="1"/>`')
    expect(kinds(inline)).toEqual(['code'])
  })

  it('围栏里**是字面量**', () => {
    const blocks = blocksOf('```\n<ref type="a" id="1"/>\n```')
    expect(blocks[0].kind).toBe('code')
  })

  it('认不出语法的照旧原文可见(`<reference/>` 不是 `<ref/>`)', () => {
    const inline = soleParagraph('看 <reference id="1"/> 这里')
    expect(kinds(inline)).toEqual(['text'])
    expect(inlineText(inline)).toBe('看 <reference id="1"/> 这里')
  })
})

describe('块:一行只有标签时 CommonMark 判成 html 块', () => {
  it('整段只有标签 → 一段话(不是 source-fallback)', () => {
    const blocks = blocksOf('前一段\n\n<ref type="a" id="1"/>\n\n后一段')
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'paragraph', 'paragraph'])
    expect(kinds((blocks[1] as Extract<BlockModel, { kind: 'paragraph' }>).inline)).toEqual(['ref'])
  })

  it('两条标签各占一行 = **一个** html 块 → 一段话里两格 ref,中间那个换行留着', () => {
    const inline = soleParagraph('<ref type="a" id="1"/>\n<ref type="b" id="2"/>')
    expect(kinds(inline)).toEqual(['ref', 'text', 'ref'])
    expect((inline[1] as { text: string }).text).toBe('\n')
  })

  it('列表项里 `- <ref …/>` 同理', () => {
    const blocks = blocksOf('- <ref type="a" id="1"/>\n- 第二项')
    const list = blocks[0] as Extract<BlockModel, { kind: 'list' }>
    expect(list.items[0].blocks[0].kind).toBe('paragraph')
    expect(
      kinds((list.items[0].blocks[0] as Extract<BlockModel, { kind: 'paragraph' }>).inline),
    ).toEqual(['ref'])
  })

  it('一段真 HTML 里恰好夹着一条标签 → 照旧 source-fallback(总纪律没有例外)', () => {
    const blocks = blocksOf('<div>\n<ref type="a" id="1"/>\n</div>')
    expect(blocks[0].kind).toBe('source-fallback')
  })
})

/**
 * ── 流式扣尾(§2.6)────────────────────────────────────────────────────────
 *
 * 判据在 `content/assemble/markdown.ts` 的 `markdownToFrame`:**还在流**的那一段
 * 先过 `splitIncompleteRefTail`,半截标签根本不进解析器。所以这里逐字符喂,断言
 * 每一个中间帧里都没有以 `<ref` 开头的文字。
 */
describe('流式:半截标签一个中间帧都不上屏', () => {
  const SRC = '看 <ref type="file" path="/a/b.ts" line="3"/> 这里'

  function textOfFrame(blocks: readonly BlockModel[]): string {
    return blocks
      .map((block) =>
        block.kind === 'paragraph'
          ? inlineText(block.inline)
          : block.kind === 'source-fallback'
            ? block.source
            : '',
      )
      .join('\n')
  }

  it('逐字符喂:任何一帧里都没有 `<ref` 开头的文字,闭合那一拍直接是 ref 节点', () => {
    let sawRef = false
    for (let i = 1; i <= SRC.length; i += 1) {
      const frame = markdownToFrame('m1', SRC.slice(0, i), true)
      // ① 半截标签一个字都不上屏。
      expect(textOfFrame(frame.blocks)).not.toContain('<ref')
      // ② 一闭合就是 chip —— 不经过「先画成字、再换成 chip」那一帧。
      const inline = frame.blocks.flatMap((b) => (b.kind === 'paragraph' ? b.inline : []))
      if (inline.some((n) => n.type === 'ref')) sawRef = true
    }
    expect(sawRef).toBe(true)
  })

  it('一条单独成行的标签:全程没有 source-fallback 块(块身份不翻转)', () => {
    const src = '一段话\n\n<ref type="file" path="/a/b.ts"/>\n\n下一段'
    for (let i = 1; i <= src.length; i += 1) {
      const frame = markdownToFrame('m2', src.slice(0, i), true)
      expect(frame.blocks.map((b) => b.kind)).not.toContain('source-fallback')
    }
  })

  it('流结束(`live=false`)不扣:没闭合的就是字面量', () => {
    const frame = markdownToFrame('m3', '看 <ref type="fi', false)
    expect(textOfFrame(frame.blocks)).toBe('看 <ref type="fi')
  })
})

/**
 * ── `stable-cut` 的切点不会落在一条未闭合的 ref 里 ────────────────────────────
 *
 * **论证**(读代码):`stableCut` 返回的一定是**一行的行首**(它只在
 * `cut = pos` 那一处赋值,而 `pos` 每轮都是 `lineEnd + 1`,即下一行的起点),
 * 而编解码器那条法说「一个标签不跨行」。于是一条在切点之前**开始**的标签必然
 * 在更早的一行上,也就必然在切点之前**结束** —— 切点落进标签里在结构上不可能。
 *
 * 下面这几条是那句论证的活口:真喂几段带标签的文本,断言切点处要么是行首、
 * 要么就是 0,而且切出来的前缀里 `<` 与 `>` 成对。
 */
describe('stable-cut 与标签:切点永远在行首', () => {
  it.each([
    '一段话\n\n<ref type="a" id="1"/>\n\n下一段',
    '看 <ref type="a" id="1"/> 这里\n\n下一段\n\n第三段',
    '<ref type="a" id="1"/>\n<ref type="b" id="2"/>\n\n后面',
  ])('切点落在行首:%s', (src) => {
    const cut = stableCut(src)
    expect(cut === 0 || src[cut - 1] === '\n').toBe(true)
    // 前缀里没有开了不闭的尖括号(标签不跨行的直接推论)。
    const head = src.slice(0, cut)
    expect((head.match(/</g) ?? []).length).toBe((head.match(/>/g) ?? []).length)
  })

  it('增量那条路给出的与全量逐字相同(切点沿用不会切坏一条标签)', () => {
    const src = '一段话\n\n下一段\n\n看 <ref type="a" id="1"/> 收尾'
    const stream = new MarkdownStream(() => 0)
    // 逐帧喂完整段(`now` 恒为 0 会走「贴尾巴」那条节流路,所以这里每次都换 id)。
    for (let i = 1; i <= src.length; i += 1) stream.parse(`lane-${i}`, src.slice(0, i), true)
    const live = stream.parse('final', src, true)
    const settled = parseMarkdown(src).map((entry) => entry.block)
    expect(live.blocks).toEqual(settled)
  })
})
