import type { BlockModel } from '../../../model/blocks'
import { InlineRun } from '../../inline/InlineRun'
import s from './List.module.css'

type ListModel = Extract<BlockModel, { kind: 'list' }>

/**
 * 列表 —— flow。
 *
 * 项是**一行行内树**(嵌套在翻译表里被拍平一层,理由记在 markdown/to-blocks.ts)。
 * 所以这里没有递归:模型里没有子树,组件也就不该自己生一个出来 ——「模型是数据,
 * 组件不推导结构」在这一块的具体样子。
 *
 * key 用下标:列表项没有独立的源偏移(它们是同一个块的内部结构),而一张列表在
 * 流式期间只会在**末尾**长项,下标因此稳定。
 */
export function List({ model }: { model: ListModel }) {
  const items = model.items.map((item, index) => (
    <li key={index} className={s.item}>
      <InlineRun nodes={item} />
    </li>
  ))
  // data-prose:节奏表的钩子(见 content/ChatStream.module.css)。列表是「一段字」,
  // 与段落同档;项与项之间那一档更近的间距(--pr-li)在 List.module.css 里。
  return model.ordered ? (
    <ol className={s.list} data-prose="text">
      {items}
    </ol>
  ) : (
    <ul className={s.list} data-prose="text">
      {items}
    </ul>
  )
}
