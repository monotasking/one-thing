import type { BlockModel } from '../../../model/blocks'
import { InlineRun } from '../../inline/InlineRun'
import s from './Paragraph.module.css'

type ParagraphModel = Extract<BlockModel, { kind: 'paragraph' }>

/**
 * 段落 —— 纸上的一段字。
 *
 * 行内那一层由 `InlineRun` 画(全仓一份):强调 / 行内码 / 删除线 / 链接 / 引用角标
 * 在段落、标题、列表项、单元格里必须长得一模一样,所以那段代码不该住在这里。
 *
 * `white-space: pre-wrap` 是**事实**,不是纯文本时代的残留:markdown 的段落内软换行
 * 由源文本说了算,解析器把它原样留在 text 节点里(硬换行也一样,翻成一个 `\n`)。
 */
export function Paragraph({ model }: { model: ParagraphModel }) {
  return (
    <p className={s.paragraph}>
      <InlineRun nodes={model.inline} />
    </p>
  )
}
