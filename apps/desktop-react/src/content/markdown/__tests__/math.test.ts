import { describe, expect, it } from 'vitest'
import type { BlockModel } from '../../model/blocks'
import { inlineText } from '../../model/inline'
import { parseMarkdown } from '../parse'

/**
 * 公式进翻译表 —— **解析那一半**(渲染那一半在 blocks/math/__tests__)。
 *
 * 纯函数,jsdom 都不用起:文本进,块出。断言分四组 —— 四种定界符各自认得出、
 * 提升判据、单 `$` 那道 pandoc 闸、以及「源码回读的是作者的字节」。
 */

const blocks = (text: string): BlockModel[] => parseMarkdown(text).map((entry) => entry.block)
const one = (text: string): BlockModel => blocks(text)[0]

/** 这一段的纯文字 —— 「没过闸的公式原样落回文字」那几条靠它比对。 */
function textOf(source: string): string {
  const block = one(source)
  if (block.kind !== 'paragraph') throw new Error(`这一段不是 paragraph,是 ${block.kind}`)
  return inlineText(block.inline)
}

const OPEN = String.raw`\[`
const CLOSE = String.raw`\]`

describe('四种定界符', () => {
  it('$a^2$ 是行内公式,tex 不含定界符', () => {
    expect(one('$a^2$')).toEqual({
      kind: 'paragraph',
      inline: [{ type: 'math', tex: 'a^2' }],
    })
  })

  it('\\(x\\) 也是行内公式(归一之后是 $$,但它**不**提升成块)', () => {
    expect(one(String.raw`\(x\)`)).toEqual({
      kind: 'paragraph',
      inline: [{ type: 'math', tex: 'x' }],
    })
  })

  it('$$…$$ 跨行是块公式', () => {
    expect(one('$$\nE=mc^2\n$$')).toEqual({ kind: 'math', source: 'E=mc^2', closed: true })
  })

  it('\\[…\\] 跨行同样是块公式', () => {
    expect(one(`${OPEN}\nE=mc^2\n${CLOSE}`)).toEqual({ kind: 'math', source: 'E=mc^2', closed: true })
  })

  it('行内公式混在一句话里,前后的字原样', () => {
    expect(one('设 $x$ 为解')).toEqual({
      kind: 'paragraph',
      inline: [
        { type: 'text', text: '设 ' },
        { type: 'math', tex: 'x' },
        { type: 'text', text: ' 为解' },
      ],
    })
  })
})

describe('提升:独占一段的块定界符', () => {
  it('写成一行的 $$x$$ 提升成块公式(closed 恒真 —— 它首尾俱全)', () => {
    expect(one('$$x$$')).toEqual({ kind: 'math', source: 'x', closed: true })
  })

  it('写成一行的 \\[x\\] 同理', () => {
    expect(one(String.raw`\[x\]`)).toEqual({ kind: 'math', source: 'x', closed: true })
  })

  it('独占一段的 $x$ **不**提升 —— 单 $ 说的是「夹在字里」', () => {
    expect(one('$x$')).toEqual({ kind: 'paragraph', inline: [{ type: 'math', tex: 'x' }] })
  })

  it('独占一段的 \\(x\\) 同样不提升', () => {
    expect(one(String.raw`\(x\)`).kind).toBe('paragraph')
  })

  it('一段里还有别的字就不提升(那是一句话的一部分)', () => {
    expect(one('看 $$x$$ 这里').kind).toBe('paragraph')
  })
})

describe('单 $ 的 pandoc 闸', () => {
  it('「花了 $5 和 $10」整句保持原文', () => {
    expect(one('花了 $5 和 $10')).toEqual({
      kind: 'paragraph',
      inline: [{ type: 'text', text: '花了 $5 和 $10' }],
    })
  })

  it('内容首尾是空白的不算公式(`$ x $` 里那个 $ 是货币符号)', () => {
    expect(textOf('$ x $ 元')).toBe('$ x $ 元')
  })

  it('闭合 $ 后面跟数字的不算公式', () => {
    expect(one('$a$5').kind).toBe('paragraph')
    expect(textOf('$a$5')).toBe('$a$5')
  })

  it('$$ 与 \\( 不设这道闸 —— 写出两个字符的人已经表明了意图', () => {
    // 首尾那一格空白是扩展自己剥的 padding(`$$ x $$` 的值就是 `x`),不是我们判掉的。
    expect(one('$$ x $$')).toEqual({ kind: 'math', source: 'x', closed: true })
    // `\(` 是**行内**那一档,所以它停在段落里 —— 闸没拦它,提升判据也没认它。
    expect(one(String.raw`\( x \)`)).toEqual({
      kind: 'paragraph',
      inline: [{ type: 'math', tex: 'x' }],
    })
  })
})

describe('免疫:代码里的 $ 一个字不动', () => {
  it('围栏代码', () => {
    expect(one('```\n$a$\n```')).toEqual({ kind: 'code', lang: null, source: '$a$', closed: true })
  })

  it('行内码', () => {
    expect(one('`$a$`')).toEqual({ kind: 'paragraph', inline: [{ type: 'code', text: '$a$' }] })
  })
})

describe('容器里的块公式', () => {
  it('列表项里', () => {
    expect(one('- $$\n  a\n  $$')).toEqual({
      kind: 'list',
      ordered: false,
      items: [{ blocks: [{ kind: 'math', source: 'a', closed: true }], checked: null, depth: 0 }],
    })
  })

  it('引用里 —— `> ` 是容器的记号,不是公式的内容,所以 closed 照样为真', () => {
    expect(one('> $$\n> a\n> $$')).toEqual({
      kind: 'quote',
      blocks: [{ kind: 'math', source: 'a', closed: true }],
    })
  })
})

describe('流式与源码回读', () => {
  it('没收尾的 $$ 是 closed:false(判据只从源文本看,与 code 同一条)', () => {
    expect(one('$$\nE=mc')).toEqual({ kind: 'math', source: 'E=mc', closed: false })
  })

  it('\\] 收尾也算收尾 —— 翻译表吃的是原文,归一只喂给了解析器', () => {
    expect(one(`${OPEN}\nx\n${CLOSE}`)).toMatchObject({ closed: true })
  })

  it('偏移落在原文上,按它切回来的是作者写的 \\[ 那两个字节', () => {
    const text = `前言\n\n${OPEN}\nx\n${CLOSE}\n\n后记`
    const entry = parseMarkdown(text).find((item) => item.block.kind === 'math')
    expect(entry).toBeDefined()
    expect(text.slice(entry!.offset, entry!.offset + 2)).toBe(OPEN)
  })

  it('行内公式没过闸时,落回去的也是原文那几个字节', () => {
    const text = '花了 $5 和 $10'
    expect(textOf(text)).toBe(text)
  })
})
