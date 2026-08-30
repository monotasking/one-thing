import type { BlockModel } from '../../../model/blocks'
import { BlockView } from '../../BlockView'
import type { BlockCtx } from '../../registry'
import s from './Quote.module.css'

type QuoteModel = Extract<BlockModel, { kind: 'quote' }>

/**
 * 引用 —— **过渡形,P5 拍板后换**。
 *
 * 定稿形还没拍(六轮比稿把「左竖线」这个所有人的第一反应否掉了:引线在全仓禁用,
 * 而引用块正是引线最经典的用法 —— 所以它需要一个真正的替代设计,不是随手挑一个)。
 * 在那之前,本批给它一个**零装饰**的过渡形:普通段落 + 一层缩进。
 *
 * 为什么是这个过渡形而不是别的:缩进是唯一一个「不需要拍板就成立」的表达
 * (它说的是从属,不是风格),而任何底色、边框、字号变化都是在替 P5 做决定 ——
 * 那正是「行为裁定须先问」要挡住的事。
 *
 * 内容递归走 `BlockView`:引用里可以是任何块(包括代码块、表格),而那些块该长什么样
 * 已经有答案了 —— 嵌套不是特例,是注册表复用的自然结果(铁律 1)。
 */
export function Quote({ model, ctx }: { model: QuoteModel; ctx: BlockCtx }) {
  // `data-prose` 只让它**参与节奏**(与段落同档,见 content/ChatStream.module.css
  // 的节奏表)。视觉过渡形一个字不动 —— 定稿形仍等 P5 拍板。
  return (
    <blockquote className={s.quote} data-prose="text">
      {model.blocks.map((block, index) => (
        <BlockView key={index} block={block} ctx={ctx} />
      ))}
    </blockquote>
  )
}
