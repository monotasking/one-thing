import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '../parse'
import { analyzeUnit } from '../../editing/inline-tokens'
import type { Unit } from '../../editing/units'
import type { InlineNode } from '../../model/inline'

/**
 * **中文行内记号**(`parse.ts` 的 `EXTENSIONS` 里那两格 cjk-friendly)。
 *
 * 判词写在 `parse.ts` 上:CommonMark 判「这个 `**` 能不能收尾」时,左边是标点就要求
 * 右边是空白或标点;中文的 `**…吗?**为什么` 左边是全角问号、右边是汉字,两头都不满足,
 * 于是整段塌回带星号的字面量。这一组钉的就是**塌不回去**。
 *
 * 病历:2026-09-21 用户报「`**对 \`greet()\` 这种没传参数的调用,行为一样吗?**为什么?`
 * 这个为什么没有加粗,用户能够看到原始字符串」。第一条用的就是那一行的原文。
 *
 * 最后一条守的是**只有一份判断**:待办编辑器走 `parseMarkdownTree`,与消息同一个
 * `EXTENSIONS`。哪天有人只给其中一条路加扩展,那一条会红。
 */

/** 这段文字里出现过哪些行内记号(深度优先,含嵌套)。 */
const marks = (text: string): string[] => {
  const out: string[] = []
  const walk = (nodes: readonly InlineNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'emphasis') out.push(node.strong ? 'strong' : 'emphasis')
      if (node.type === 'strike') out.push('strike')
      if ('children' in node) walk(node.children)
    }
  }
  for (const entry of parseMarkdown(text)) {
    const block = entry.block
    if ('inline' in block) walk(block.inline)
  }
  return out
}

/** 一个最小的段落单元;行号不参与判断。 */
const para: Unit = { type: 'para', start: 0, end: 0 }

describe('中文行内记号:标点收尾 + 右边紧跟汉字', () => {
  it('病历原文:问号收尾、后面紧跟「为什么」,两段都是粗体', () => {
    const line = "**3.** `if (name === '')` 和 `if (!name)`,**对 `greet()` 这种没传参数的调用,行为一样吗?**为什么?"
    expect(marks(line).filter((mark) => mark === 'strong')).toHaveLength(2)
  })

  it('各式中文标点收尾、右边贴汉字,都不塌', () => {
    for (const tail of ['，', '。', '？', '！', '：', '；', '、', '）', '》', '」']) {
      expect(marks(`**收尾是${tail}**后面是汉字`), `收尾 ${tail}`).toEqual(['strong'])
    }
  })

  it('单星号与删除线同治 —— 删除线那格必须排在 gfm() 之后才生效', () => {
    expect(marks('*斜体吗？*后面')).toEqual(['emphasis'])
    expect(marks('~~删掉了。~~后面')).toEqual(['strike'])
  })

  it('左边贴汉字的开头记号一并管住', () => {
    expect(marks('问题**一样吗？**答案')).toEqual(['strong'])
  })

  it('CommonMark 本来就对的仍然对:行尾收尾、空格收尾', () => {
    expect(marks('**行尾就结束了吗？**')).toEqual(['strong'])
    expect(marks('**空格收尾吗？** 后面')).toEqual(['strong'])
  })

  it('不该粗的仍然不粗:星号两边都是空白', () => {
    expect(marks('a ** b ** c')).toHaveLength(0)
  })

  it('嵌套照旧:粗体里套删除线', () => {
    expect(marks('**加粗~~又删掉。~~了吗？**为什么')).toEqual(['strong', 'strike'])
  })

  it('待办编辑器切的是同一份判断', () => {
    const kinds = analyzeUnit(para, '**一样吗？**为什么').groups.map((group) => group.kind)
    expect(kinds).toContain('strong')
  })
})
