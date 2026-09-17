import { useT } from '../../../../i18n'
import { Checkbox } from '../../../../ui/Checkbox'
import type { BlockModel } from '../../../model/blocks'
import { BlockView } from '../../BlockView'
import type { BlockCtx } from '../../registry'
import s from './List.module.css'

type ListModel = Extract<BlockModel, { kind: 'list' }>

/** 拍平前的层级 → 缩进(三档封顶;再深也只缩三格,窄栏里不至于挤没)。 */
const DEPTH_CLASS = ['', s.depth1, s.depth2, s.depth3] as const

const NOOP = () => {}

/**
 * 列表 —— flow。
 *
 * 一项是**一串块**(08-31 真机报障后改的:从前项内只装行内,围栏被拍平成字面
 * 文本,``` ```lua ``` 四个字符原样摊在屏幕上)。所以这里和 Quote 一样**递归回
 * `BlockView`**:项里可以是段落、代码块、表、引用,而那些块该长什么样已经有答案了
 * —— 嵌套不是特例,是注册表复用的自然结果(铁律 1)。
 *
 * 递归的**只有项内**:嵌套列表在翻译表里仍然被拍平成同层后续项(既有裁定,理由记在
 * markdown/to-blocks.ts),所以屏幕上不会出现 `<ul>` 套 `<ul>`;拍平前的层级留在
 * `depth` 上,按层缩进(待办 E1)。GFM 任务项(`- [ ]` / `- [x]`)画只读勾选框。
 *
 * key 用下标:列表项没有独立的源偏移(它们是同一个块的内部结构),而一张列表在
 * 流式期间只会在**末尾**长项,下标因此稳定。项内的块同理。
 */
export function List({ model, ctx }: { model: ListModel; ctx: BlockCtx }) {
  const t = useT()
  const items = model.items.map((item, index) => {
    const task = item.checked !== null
    const cls = [s.item, task ? s.task : '', item.checked ? s.done : '', DEPTH_CLASS[Math.min(item.depth, DEPTH_CLASS.length - 1)]]
      .filter(Boolean)
      .join(' ')
    return (
      <li key={index} className={cls}>
        {item.blocks.map((block, blockIndex) => (
          <BlockView key={blockIndex} block={block} ctx={ctx} />
        ))}
        {/* 任务项(E1):圆点的位置换成勾选框。消息里是**只读**的 —— 那是 AI 说的一件事实,
            勾它不会改任何东西;要勾去计划抽屉(content/todo)。 */}
        {task && (
          <span className={s.check}>
            <Checkbox checked={item.checked === true} onChange={NOOP} readOnly label={t(item.checked ? 'todo.checked' : 'todo.unchecked')} />
          </span>
        )}
      </li>
    )
  })
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
