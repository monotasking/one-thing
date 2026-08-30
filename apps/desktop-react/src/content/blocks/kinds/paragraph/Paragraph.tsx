import type { BlockModel } from '../../../model/blocks'
import type { InlineNode } from '../../../model/inline'
import s from './Paragraph.module.css'

type ParagraphModel = Extract<BlockModel, { kind: 'paragraph' }>

/**
 * 段落 —— 纸上的一段字。
 *
 * P0 的行内树只有 `text` 一种节点(纯文本产地,见 assemble/markdown.ts),但这里
 * **按行内树写**而不是按一个字符串写:P1 真解析器进来时,强调 / 行内码 / 链接 /
 * 引用角标是往这个 switch 里加分支,不是重写这个组件。
 *
 * `white-space: pre-wrap` 是纯文本时代留下的**事实**,不是过渡:换行照实保留,
 * 换成真 markdown 之后段落内的软换行仍然由源文本说了算。
 */
export function Paragraph({ model }: { model: ParagraphModel }) {
  return <p className={s.paragraph}>{model.inline.map(renderInline)}</p>
}

function renderInline(node: InlineNode, index: number) {
  switch (node.type) {
    case 'text':
      // 直接吐字符串,不套 span —— 多一层元素会让 `pre-wrap` 的空白折叠规则
      // 在边界上出现意外(相邻元素间的换行),而这一段的排版是逐像素定过的。
      return node.text
    case 'code':
      return (
        <code key={index} className={s.code}>
          {node.text}
        </code>
      )
    case 'emphasis':
      return node.strong ? (
        <strong key={index}>{node.children.map(renderInline)}</strong>
      ) : (
        <em key={index}>{node.children.map(renderInline)}</em>
      )
    case 'link':
      return (
        <a key={index} className={s.link} href={node.href}>
          {node.children.map(renderInline)}
        </a>
      )
    case 'citation':
      // 角标的呈现(预览卡、来源清单联动)是 P4 的事;在那之前只画一个数字,
      // 而不是把它悄悄丢掉 —— 正文里确实有这一处引用,这是事实。
      return (
        <sup key={index} className={s.citation}>
          {node.index}
        </sup>
      )
  }
}
