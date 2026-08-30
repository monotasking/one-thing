import type { BlockModel } from '../model/blocks'
import type { ProjectedToolCall, ToolRowModel } from '../model/segments'
import { baseToolRow } from './row'

/**
 * 「不同工具的结果怎么展示」的那张表(§5.1)。
 *
 * 它是全系统第三张表(块注册表、figure 二级表、这一张),和前两张一个哲学:
 * **presenter 不产出组件,产出模型** —— 摘要行(`row`)+ 详情块序列(`detail`)。
 * 详情是 `BlockModel[]`,于是「工具抽屉里出现一段 diff」不是特例,是块注册表复用的
 * 自然结果:read 的结果画代码块,edit 的结果画 diff 块,和正文里的代码块 / diff 块
 * 是**同一个组件**。
 *
 * ── 兜底是合同的一部分,不是客气话 ──────────────────────────────────────
 * `defaultToolPresenter` 认领**任何**调用:一个新工具接进来,零配置就有诚实的展示
 * (工具名 + 状态,详情是参数与结果的 JSON 原样)。所以 presenter 是渐进增强,
 * 不是准入门槛 —— 没人给某个工具写 presenter,那个工具也不会在屏幕上消失或说谎。
 * ──────────────────────────────────────────────────────────────────────
 *
 * 表是**有序**的,先注册先认领:`match` 是布尔判据(按 toolName 或 result 形状),
 * 谁先说「这是我的」就归谁。这比「按 toolName 做 Map」宽:有些工具要按结果形状分流
 * (同一个 bash,拿到结构化输出和拿到裸文本是两种展示),Map 表达不了。
 */

/**
 * 调用的词汇住在 `model/segments.ts`(段模型自己要带它 —— C1 抽屉惰性算详情)。
 * 这里再导出一次,是因为 presenter 的作者读的是这个文件:让他为了一个类型跑去
 * 另一棵树里找,是把「一个概念一个归属」写成了「一个概念一次寻宝」。
 */
export type { ProjectedToolCall }

export interface ToolPresenter {
  /** 认领判据。按 toolName / result 形状说话,不看 UI。 */
  match(call: ProjectedToolCall): boolean
  /** 卡行数据(A1 + V2)。 */
  row(call: ProjectedToolCall): ToolRowModel
  /**
   * 抽屉内容(C1)。**惰性**:只有抽屉真被拉开时才调 —— 所以它不进段模型
   * (段模型必须可序列化、不持有函数),由消费方拿着 call 现算。
   */
  detail(call: ProjectedToolCall): BlockModel[]
}

const PRESENTERS: ToolPresenter[] = []

/** 注册。先注册先认领 —— 顺序即优先级,不另设 priority 字段(那会变成第二套排序)。 */
export function registerToolPresenter(presenter: ToolPresenter): void {
  PRESENTERS.push(presenter)
}

/** 只给测试用:表是模块级的,用例之间要能各注册各的而不互相污染。 */
export function clearToolPresenters(): void {
  PRESENTERS.length = 0
}

/** 认领。谁都不认就是 default —— 所以这个函数永远返回一个 presenter。 */
export function resolveToolPresenter(call: ProjectedToolCall): ToolPresenter {
  for (const presenter of PRESENTERS) {
    if (presenter.match(call)) return presenter
  }
  return defaultToolPresenter
}

/**
 * 兜底 presenter。
 *
 * `row` 只说得出**任何调用都成立的那几格**(工具名 + 状态 + 耗时 + 失败原因,见
 * `baseToolRow`):参数摘要与成果词要懂这个工具才编得出来,而兜底按定义不懂。
 * 不懂就不说 —— 这比猜一句好看的话诚实。
 *
 * `detail` 落 `source-fallback`:参数与结果的 JSON 原样。`reason` 是机器口径的词,
 * 不是文案。
 */
export const defaultToolPresenter: ToolPresenter = {
  match: () => true,
  row: (call) => baseToolRow(call),
  detail: (call) => [
    {
      kind: 'source-fallback',
      reason: 'tool-default',
      source: stringifyToolPayload(call),
    },
  ],
}

/**
 * JSON 原样 —— 但**不能让序列化本身成为新的失败源**:工具结果里出现环、
 * 出现 BigInt 都会让 `JSON.stringify` 抛错,而这里正是「一切都失败了之后」的那一格,
 * 它自己再抛就没有下一层了。抛了就说抛了。
 */
function stringifyToolPayload(call: ProjectedToolCall): string {
  const payload = {
    arguments: call.arguments,
    ...(call.result === undefined ? {} : { result: call.result }),
    ...(call.error === undefined ? {} : { error: call.error }),
  }
  try {
    return JSON.stringify(payload, null, 2)
  } catch (thrown) {
    return String(thrown)
  }
}
