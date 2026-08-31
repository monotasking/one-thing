import type { BlockModel } from '../../../model/blocks'
import { BlockView } from '../../BlockView'
import type { BlockCtx } from '../../registry'
import s from './List.module.css'

type ListModel = Extract<BlockModel, { kind: 'list' }>

/**
 * 列表 —— flow。
 *
 * 一项是**一串块**(08-31 真机报障后改的:从前项内只装行内,围栏被拍平成字面
 * 文本,``` ```lua ``` 四个字符原样摊在屏幕上)。所以这里和 Quote 一样**递归回
 * `BlockView`**:项里可以是段落、代码块、表、引用,而那些块该长什么样已经有答案了
 * —— 嵌套不是特例,是注册表复用的自然结果(铁律 1)。
 *
 * 递归的**只有项内**:嵌套列表在翻译表里仍然被拍平成同层后续项(既有裁定,理由记在
 * markdown/to-blocks.ts),所以屏幕上不会出现 `<ul>` 套 `<ul>`。
 *
 * key 用下标:列表项没有独立的源偏移(它们是同一个块的内部结构),而一张列表在
 * 流式期间只会在**末尾**长项,下标因此稳定。项内的块同理。
 */
export function List({ model, ctx }: { model: ListModel; ctx: BlockCtx }) {
  const items = model.items.map((item, index) => (
    <li key={index} className={s.item}>
      {item.map((block, blockIndex) => (
        <BlockView key={blockIndex} block={block} ctx={ctx} />
      ))}
    </li>
  ))
  // data-prose:节奏表的钩子(见 content/ChatStream.module.css)。列表是「一段字」,
  // 与段落同档;项与项之间那一档更近的间距(--pr-li)在 List.module.css 里。
  // 项**内**的块与块之间同样是 --pr-li,理由也写在那个文件里。
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
