import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { BlockView } from '../../../BlockView'
import type { BlockCtx } from '../../../registry'
import type { BlockModel } from '../../../../model/blocks'

/**
 * 引用块**定稿 C**(08-31 用户比稿拍板)的门。
 *
 * 过渡形的断言(「零装饰、只有一层缩进」)在这一批**换掉**:它当年钉的是
 * 「还没拍板,所以什么都别加」,而板已经拍了。定稿要钉的是四件:
 *  ① 大引号在场(伪元素,内容是 U+201C);
 *  ② 零盒零线 —— 不描边、不涂底(左竖线禁令在这里是最容易破的一处);
 *  ③ UA 的 `margin-inline: 40px` 已清 —— 缩进只有一个产地(配方自己的 padding);
 *  ④ 嵌套小一号(引号 20 / 缩进 22,与顶层的 26 / 26 是两组数)。
 *
 * ①②③④ 读的是 **CSS 文本**:jsdom 不跑 CSS Modules 的样式表,伪元素与层叠
 * 在这一层量不出来(同 prose-rhythm.test.tsx 的判例)。DOM 那一半只钉一件
 * jsdom 说得出的事:嵌套引用真的递归成了嵌套的 <blockquote>。
 * 「屏幕上真的长这样」是真机的活。
 */

const cssPath = path.resolve(__dirname, '../Quote.module.css')
const css = readFileSync(cssPath, 'utf-8')
const tokensCss = readFileSync(
  path.resolve(__dirname, '../../../../../styles/tokens.css'),
  'utf-8',
)

/** 掏掉注释再断言 —— 禁令的字样正大光明写在文件头注里,不该被当成违例。 */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')

/** 顶层那一条规则(`.quote { … }`)的声明块 —— 嵌套那条是另一条,别混着断言。 */
const topLevelBlock = /(?:^|\n)\.quote\s*\{([^}]*)\}/.exec(rules)?.[1] ?? ''

function token(name: string): string | undefined {
  return new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(tokensCss)?.[1]?.trim()
}

describe('引用块定稿 C · 大引号纯排版', () => {
  it('① 大引号在场:伪元素 + U+201C + line-2 色', () => {
    expect(rules).toMatch(/\.quote::before\s*\{/)
    expect(rules).toContain("content: '\\201C'")
    expect(rules).toMatch(/\.quote::before[\s\S]*?color:\s*var\(--line-2\)/)
    // 引号必须**脱离**那个 flex 列,否则第一段的起笔会被它顶开。
    expect(rules).toMatch(/\.quote::before[\s\S]*?position:\s*absolute/)
  })

  it('② 零盒零线:不描边、不涂底(左竖线禁令在这里最容易破)', () => {
    expect(rules).not.toMatch(/border-inline-start/)
    expect(rules).not.toMatch(/border-left/)
    expect(rules).not.toMatch(/(^|[;{\s])border\s*:/)
    expect(rules).not.toMatch(/(^|[;{\s])background/)
  })

  it('③ UA 的 margin-inline 已清 —— 缩进只有一个产地', () => {
    expect(rules).toMatch(/margin-inline:\s*0/)
    expect(rules).toMatch(/padding-inline-start:\s*var\(--quote-pad\)/)
    // 顶层的 margin-block 归节奏表(`.row > *`),这个文件不许再写一遍:
    // 同特异性的两条规则抢一个值 = 谁赢取决于打包顺序。
    expect(topLevelBlock).not.toMatch(/margin-block/)
  })

  it('④ 嵌套小一号:引号 20 / 缩进 22,与顶层的 26 / 26 不是同一组数', () => {
    expect(rules).toMatch(/\.quote\s+\.quote[\s\S]*?padding-inline-start:\s*var\(--quote-pad-nested\)/)
    expect(rules).toMatch(/\.quote\s+\.quote::before[\s\S]*?font-size:\s*var\(--quote-mark-nested\)/)
    // 嵌套引用不是 `.row` 的直接子项,UA 的 margin-block 得由它自己清。
    expect(rules).toMatch(/\.quote\s+\.quote\s*\{[^}]*margin-block:\s*0/)
    expect(token('--quote-pad')).toBe('26px')
    expect(token('--quote-mark')).toBe('26px')
    expect(token('--quote-pad-nested')).toBe('22px')
    expect(token('--quote-mark-nested')).toBe('20px')
  })

  it('⑤ 组件里零字面几何 —— px 只许出现在 tokens.css(铁律)', () => {
    expect(rules).not.toMatch(/\d+px/)
  })

  it('嵌套引用递归成嵌套的 <blockquote>(注册表复用,不是特例)', () => {
    const ctx: BlockCtx = { messageId: 'a1', streaming: false }
    const block: BlockModel = {
      kind: 'quote',
      blocks: [
        { kind: 'paragraph', inline: [{ type: 'text', text: '外层' }] },
        { kind: 'quote', blocks: [{ kind: 'paragraph', inline: [{ type: 'text', text: '内层' }] }] },
      ],
    }
    const { container } = render(<BlockView block={block} ctx={ctx} />)
    const outer = container.querySelector('blockquote')
    expect(outer).toBeTruthy()
    expect(outer?.querySelector('blockquote')?.textContent).toContain('内层')
  })
})
