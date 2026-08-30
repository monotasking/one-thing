import type { BlockModel } from '../../../model/blocks'
import { InlineRun } from '../../inline/InlineRun'
import s from './Heading.module.css'

type HeadingModel = Extract<BlockModel, { kind: 'heading' }>

/**
 * 标题 —— 纸上的一行大字(flow,不进壳)。
 *
 * 三级到顶(更深的在翻译表里被钳到 3)。为什么不做四级、五级:聊天纸面上一条消息
 * 通常一屏出头,四层结构在这个尺度上分不出来 —— 字号阶梯只有三档,第四档要么和
 * 第三档同形(那就是没有),要么小到比正文还轻(那就读不出是标题)。
 */
export function Heading({ model }: { model: HeadingModel }) {
  const inline = <InlineRun nodes={model.inline} />
  if (model.level === 1) return <h1 className={s.h1}>{inline}</h1>
  if (model.level === 2) return <h2 className={s.h2}>{inline}</h2>
  return <h3 className={s.h3}>{inline}</h3>
}
