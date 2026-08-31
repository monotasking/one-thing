import type { BlockModel } from '../../../model/blocks'
import { BlockView } from '../../BlockView'
import type { BlockCtx } from '../../registry'
import s from './Quote.module.css'

type QuoteModel = Extract<BlockModel, { kind: 'quote' }>

/**
 * 引用 —— **定稿 C「大引号纯排版」**(08-31 用户比稿拍板)。
 *
 * 过渡形(普通段落 + 一层缩进,零装饰)到此结束。定稿要回答的是同一个问题:
 * 左竖线在全仓禁用,而引用块正是引线最经典的用法 —— 那用什么代替?三台比稿给了
 * 三个答案(A 左缘墨线 / B 衬纸内衬 / C 大引号纯排版),用户选了最轻的那台:
 * **一枚装饰引号 + 色温降一档 + 缩进,零盒零线**。
 *
 * 视觉配方一个字都不在这个文件里(全在 Quote.module.css,几何在 tokens.css)。
 * 这里只剩两件事:
 *  · 标签是 `<blockquote>` —— 语义归语义,引号只是画上去的装饰(伪元素),
 *    读屏软件读的是标签,不是那枚引号;
 *  · 内容**递归走 `BlockView`**:引用里可以是任何块(代码块、表格、再一层引用),
 *    而那些块该长什么样已经有答案了 —— 嵌套不是特例,是注册表复用的自然结果
 *    (铁律 1)。嵌套引用的「小一号」因此也不是这里判的:CSS 的 `.quote .quote`
 *    自己就说得出「我在另一条引用里面」。
 */
export function Quote({ model, ctx }: { model: QuoteModel; ctx: BlockCtx }) {
  // `data-prose="text"` 让它**参与节奏表**(与段落同档,见 content/ChatStream.module.css)。
  // 定稿换的是引用自己长什么样,不是它与前后邻居隔多远 —— 那张表一个值都没动。
  return (
    <blockquote className={s.quote} data-prose="text">
      {model.blocks.map((block, index) => (
        <BlockView key={index} block={block} ctx={ctx} />
      ))}
    </blockquote>
  )
}
