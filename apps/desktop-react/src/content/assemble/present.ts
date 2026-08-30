import type {
  ProjectedToolCall,
  ToolGroupEntry,
  ToolGroupModel,
  ToolRowModel,
  ToolStepModel,
} from '../model/segments'
import { resolveToolPresenter } from '../tools/presenter'
// 注册 barrel:import 它**就是**「这台上认识哪几个工具」。放在这里而不是应用入口,
// 是因为查表发生在这里 —— 谁要查表,谁负责保证表是装好的(与 BlockView 同款)。
import '../tools/presenters'

/**
 * 管线第 ③ 步:**呈现**(§2 ③)。
 *
 * 每个工具调用过一遍 presenter 表(§5.1),换来一行卡的数据。
 *
 * 这一步只碰 `row` —— 抽屉里的详情块是**惰性**的:段模型不持有函数,所以详情不进
 * 模型,由抽屉在被拉开那一刻拿着 call 现算(`resolveToolPresenter(call).detail(call)`)。
 * 这条分界不是性能优化,是「模型是数据」那条铁律的直接后果。
 */
export function presentToolRow(call: ProjectedToolCall): ToolRowModel {
  return resolveToolPresenter(call).row(call)
}

/** 一格清单项要的两件东西:画出来的那一行 + 抽屉要用的那份事实。 */
export function presentToolStep(call: ProjectedToolCall): ToolStepModel {
  return { row: presentToolRow(call), call }
}

/**
 * 一组的呈现(B2)。
 *
 * ── 同名连续聚合发生在**这里**,不在渲染层 ────────────────────────────
 * 「read ×3」是一条关于数据的判断(这三次调用是同一个工具连着来的),不是一种画法。
 * 放在渲染层的话,同一条判断会在「收起的计数句」和「展开的清单」里各算一遍,
 * 而它们必须一致 —— 两份算法就是两个会分叉的真相。
 *
 * 聚合键是**工具名**,不是行名:连读两个文件时行名是两个文件名,可它们仍然是
 * 「read ×2」。按行名聚合会把同一件事的两次拆成两格,按工具名聚合才是人读到的那个
 * 「它读了两个文件」。
 *
 * **只聚合连续的**:read、edit、read 是三格而不是「read ×2 + edit」—— 顺序是这一
 * 组唯一的结构,把不相邻的两次并起来等于把顺序抹掉。
 */
export function presentToolGroup(calls: readonly ProjectedToolCall[]): ToolGroupModel {
  const entries: ToolGroupEntry[] = []
  const names: string[] = []
  let failed = 0
  let durationTotal: number | undefined

  for (const call of calls) {
    const tool = call.toolName || call.toolId
    const step = presentToolStep(call)
    const isFailed = FAILED_STATUSES.has(call.status)
    if (isFailed) failed += 1
    if (!names.includes(tool)) names.push(tool)
    if (call.durationMs !== undefined) durationTotal = (durationTotal ?? 0) + call.durationMs

    const last = entries[entries.length - 1]
    if (last && last.tool === tool) {
      last.count += 1
      last.children.push(step)
      if (isFailed) last.failed += 1
      continue
    }
    entries.push({
      tool,
      row: step.row,
      count: 1,
      children: [step],
      failed: isFailed ? 1 : 0,
    })
  }

  return {
    entries,
    total: calls.length,
    names,
    failed,
    ...(durationTotal !== undefined ? { durationMs: durationTotal } : {}),
  }
}

/**
 * 什么算「失败」。
 *
 * `cancelled` 也进来:从人的角度「这一步没做成」是同一件事,而计数句上写
 * 「1 失败」比不写更接近事实。这张表故意与 `ToolRow` 那张**图标三态**表分开 ——
 * 这里回答的是「计几笔账」,那里回答的是「画什么颜色」,两个问题今天答案相同
 * 不代表它们是同一个问题。
 */
const FAILED_STATUSES = new Set(['failed', 'cancelled'])
