/**
 * SDK 外部会话的**后台任务可见性**(2026-08-11)。
 *
 * ## 症状
 *
 * 用户原话:「我发了之后,作为用户我认为它已经执行完了,但输入框还是可终止状态。
 * 它到底在不在执行、执行了多长时间,除了终止按钮我一律不知。」
 *
 * 主回合正文流完、后台子代理还在跑的那段时间(连接器日志里那句
 * `holding input open for N background task(s)`),界面上唯一的痕迹是终止按钮
 * 还亮着。信号一点不缺 —— `background_tasks_changed` 的整表替换早就把电平算准了
 * —— 缺的只是一条通向界面的路。这个文件就是那条路上的翻译层。
 *
 * ## 为什么复用 `plugin-status` 而不是新开一个 ContentPart 成员
 *
 * R6 把它设计成**一个泛化的流内状态格子**,不是"插件专属的类型":宿主只认一种
 * 类型,寻址是 `(pluginId, id)`,同 id 重复投递是更新而不是追加,`cleared` 撤下,
 * 流结束强制清扫。这些语义与"后台子代理在跑"逐条对上。
 *
 * 更实际的一条:这条轨道**已经通到底了** —— `content:part` → IPCBridge / SSE →
 * ipc-hub → chat store → MessageBubble,四个宿主共用。新开一个成员意味着同一条
 * 链路上的每一站都要再认一次,换来的只是把 `pluginId` 这个字段名叫得更准。
 * 那个字段在这里承载的是**归属**(谁在忙),`claude-code` 填进去读起来正确。
 *
 * ## 为什么计时是"起始墙钟"而不是"耗时"
 *
 * 过线的只有起、变、落三条事件;`startedAt` 在整段期间是同一个值,渲染侧自己
 * 算 `now - startedAt` 走秒。反过来做(宿主每秒发一条带 elapsed 的事件)会按秒
 * 冲 EventBus 的环形缓冲,而那个缓冲正是 SSE 断线重连 `?after=` 的重放依据。
 *
 * ## 装配层还是纯层
 *
 * 连接器住在 `src/external-agents/`,那一层不认识 `@onething/app`,更不该认识
 * EventBus。所以它只经 `ExternalAgentObserver.backgroundTasks` 这个**端口**报电平,
 * 翻译成会话事件是这里的事 —— 与 E4 的 `permissionHandler`、E6 的 `turn` 同款。
 */
import type { CorePluginStatusPart } from '@onething/core/plugins'
import { getEventBus } from '../events/index.js'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'

/** 这一格在 `(pluginId, id)` 寻址里的 id。整条会话上只有这一格。 */
export const EXTERNAL_AGENT_BACKGROUND_STATUS_ID = 'background-tasks'

export interface ExternalAgentBackgroundStatusInput {
  connectorId: string
  localSessionId: string
  phase: 'running' | 'settled'
  count: number
  startedAt: number
  elapsedMs?: number
}

/**
 * 电平 → 状态格子。**纯函数**,没有副作用 —— 文案与三态的判据在这里,投递在下面,
 * 所以"发了什么"可以脱离总线单测。
 */
export function buildExternalAgentBackgroundStatusPart(
  input: ExternalAgentBackgroundStatusInput,
): CorePluginStatusPart {
  return {
    type: 'plugin-status',
    pluginId: input.connectorId,
    id: EXTERNAL_AGENT_BACKGROUND_STATUS_ID,
    label: describeBackgroundLabel(input),
    startedAt: input.startedAt,
    // `durationMs` 一出现就意味着"已结算":渲染侧停止走秒并定格它,而且不再把
    // 这一格当成流内 transient 扫掉(见 shared 的 isStreamScopedTransientPart)。
    ...(input.phase === 'settled'
      ? { durationMs: Math.max(0, input.elapsedMs ?? 0) }
      : {}),
  }
}

function describeBackgroundLabel(input: ExternalAgentBackgroundStatusInput): string {
  if (input.phase === 'running') {
    return input.count > 1
      ? `后台子代理运行中 · ${input.count} 个任务`
      : '后台子代理运行中'
  }
  // 超时 / abort 的残留**如实报**。一条说"还有 2 个没收尾"的定格,比一条假装
  // 干净归零的结论有用 —— 后者正是这次事故里那个"我以为它跑完了"的复制品。
  return input.count > 0
    ? `后台子代理未收尾 · ${input.count} 个仍在运行`
    : '后台子代理已完成'
}

/**
 * 投递到会话事件总线。
 *
 * **绝不抛**:它挂在外部回合的关键路径上(观测口的契约),而 `getEventBus()` 在
 * 总线未初始化的宿主上是会抛的 —— CLI daemon 与纯连接器测试跑的正是那一档。
 * 报不出来的代价是这一轮没有状态条,抛出去的代价是这一轮整个炸掉。
 */
export function publishExternalAgentBackgroundStatus(
  input: ExternalAgentBackgroundStatusInput,
): void {
  try {
    const part = buildExternalAgentBackgroundStatusPart(input)
    // 走既有的 `content:part` 轨道,不新开通道 —— 与 R6 §5.2 第 4 条同一条理由。
    void getEventBus().emit(input.localSessionId, { type: SESSION_EVENT_TYPES.CONTENT_PART, part } as never)
  } catch {
    // 观测绝不能变成第二个故障源。
  }
}
