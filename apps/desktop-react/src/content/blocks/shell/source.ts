import type { BlockModel } from '../../model/blocks'

/**
 * 「这块的源码是什么」—— 降级与「查看源码」共用的**唯一**答案。
 *
 * 失败语义(§3.1 第 2 条)要求源码永远可见,而「源码」对不同块不是同一个字段:
 * 代码块与兜底块自己带 `source`,别的块的诚实答案是它的模型本身。写成一个函数,
 * 是为了让「降级看到的东西」和「主动查看源码看到的东西」逐字相同 —— 两处各写一遍,
 * 迟早会分叉成两种真相。
 */
export function blockSourceText(model: BlockModel): string {
  if ('source' in model && typeof model.source === 'string') return model.source
  try {
    return JSON.stringify(model, null, 2)
  } catch (thrown) {
    // 这里已经是最后一层了,自己再抛就没有下一层接着 —— 抛了就说抛了。
    return String(thrown)
  }
}
