import type { ToolRowModel } from '../model/segments'
import { resolveToolPresenter, type ProjectedToolCall } from '../tools/presenter'

/**
 * 管线第 ③ 步:**呈现**(§2)。
 *
 * 每个工具调用过一遍 presenter 表(§5.1),换来一行卡的数据。
 *
 * 这一步只碰 `row` —— 抽屉里的详情块是**惰性**的:段模型必须可序列化、不持有
 * 函数,所以详情不进模型,由抽屉在被拉开那一刻拿着 call 现算
 * (`resolveToolPresenter(call).detail(call)`)。这条分界不是性能优化,是
 * 「模型是数据」那条铁律的直接后果。
 */
export function presentToolRow(call: ProjectedToolCall): ToolRowModel {
  return resolveToolPresenter(call).row(call)
}
