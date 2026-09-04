import type {
  ProjectedToolCall,
  ToolCardEntry,
  ToolCardModel,
  ToolRowModel,
  ToolStepModel,
} from '../model/segments'
import { headIcons, headText, isLiveStep } from '../tools/card'
import { resolveToolPresenter } from '../tools/presenter'
import { truncate } from '../tools/row'
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
  const presenter = resolveToolPresenter(call)
  const row = presenter.row(call)
  if (call.status !== 'input-streaming') return row

  /*
   * **参数还在流的那一行,画成最终那一行的形**(C2-a,§6.2 第一段)。
   *
   * presenter 的 `row()` 这一刻什么都说不出:`arguments` 还是 `{}`。C2-a 之前
   * 的兜底是把收到的原始 JSON 摆出来 —— 那是事实,但读的人要在一串 `{"command":`
   * 里找那条命令。`partial()` 让 presenter 从半截 JSON 里取出它认得的那几格
   * (容错前缀解析),行上于是直接是「命令逐字长出来」。
   *
   * 三档退让,一档比一档诚实少一点、但一档都不编:
   *  ① presenter 有 `partial()` 且说出了名字 → 用它;
   *  ② 说不出(工具没实现 / 那一格还没到)→ 退回原始 JSON 尾巴(C2-a 之前的形);
   *  ③ 连原文都没有 → 就是 `row()` 那一行(工具名 + 状态)。
   */
  const patch = presenter.partial?.(call)
  const streamed = { ...row, ...(patch ?? {}) }
  if (streamed.summary || streamed.name !== row.name) return streamed

  const args = (call as { streamingArgs?: string }).streamingArgs
  return args ? { ...streamed, summary: truncate(args, STREAMING_ARGS_MAX) } : streamed
}

/** 一行放得下的参数原文长度 —— 与 `baseToolRow` 的失败原因同一档口径。 */
const STREAMING_ARGS_MAX = 56

/** 一格清单项要的两件东西:画出来的那一行 + 抽屉要用的那份事实。 */
export function presentToolStep(call: ProjectedToolCall): ToolStepModel {
  return { row: presentToolRow(call), call }
}

/**
 * 一张卡的呈现(§6.1「一件事一张脸」)。
 *
 * ── 一次调用与连续调用是**同一个模型** ────────────────────────────────
 * C2-a 起没有「单发」那一支了:`steps.length === 1` 时 `head` 缺席,卡里只有那一行。
 * 从前这里产的 `ToolGroupModel` 带着 `names` / `total` 两格专供计数句(「执行了 7 步 ·
 * read / edit / bash」),那句旁白随头行一起退役 —— 头行画的是**这几步本身**。
 *
 * ── 同名连续聚合发生在**这里**,不在渲染层 ────────────────────────────
 * 「read ×3」是一条关于数据的判断(这三次调用是同一个工具连着来的),不是一种画法。
 * 放在渲染层的话,同一条判断会在头行的摘要句和展开的清单里各算一遍,
 * 而它们必须一致 —— 两份算法就是两个会分叉的真相。
 *
 * 聚合键是**工具名**,不是行名:连读两个文件时行名是两个文件名,可它们仍然是
 * 「read ×2」。按行名聚合会把同一件事的两次拆成两格,按工具名聚合才是人读到的那个
 * 「它读了两个文件」。
 *
 * **只聚合连续的**:read、edit、read 是三格而不是「read ×2 + edit」—— 顺序是这一
 * 卡唯一的结构,把不相邻的两次并起来等于把顺序抹掉。同一条理由让 `steps` 永远是
 * **时间序**:拍点 ⑨ 撤掉了失败置顶。
 */
export function presentToolCard(calls: readonly ProjectedToolCall[]): ToolCardModel {
  const steps: ToolStepModel[] = []
  const entries: ToolCardEntry[] = []
  let failed = 0
  let durationTotal: number | undefined

  for (const call of calls) {
    const tool = call.toolName || call.toolId
    const step = presentToolStep(call)
    steps.push(step)
    const isFailed = FAILED_STATUSES.has(call.status)
    if (isFailed) failed += 1
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
    steps,
    entries,
    total: steps.length,
    failed,
    // 一步的卡没有头 —— 一个人做了一件事,上面再压一句概括它的话只是把那件事推远。
    ...(steps.length > 1
      ? {
          head: {
            icons: headIcons(entries),
            text: headText(entries),
            failed,
            ...(durationTotal !== undefined ? { durationMs: durationTotal } : {}),
            live: steps.some(isLiveStep),
          },
        }
      : {}),
  }
}

/**
 * 什么算「失败」。
 *
 * `cancelled` 也进来:从人的角度「这一步没做成」是同一件事,而头行上写
 * 「1 失败」比不写更接近事实。这张表故意与 `ToolRow` 那张**图标三态**表分开 ——
 * 这里回答的是「计几笔账」,那里回答的是「画什么颜色」,两个问题今天答案相同
 * 不代表它们是同一个问题。
 */
const FAILED_STATUSES = new Set(['failed', 'cancelled'])
