/**
 * AgentExecutor 契约(docs/design/claude-code-integration-v2.md §3,E0 期)。
 *
 * 病根:外部 agent 今天是「provider 槽里的一个异类」,于是每一层都要认它——
 * 压缩、鉴权、工具装载各拿一份 id 名单去猜「它支不支持 X」。猜出来的能力
 * 一定会猜错(§0.1 宪法 5:能力差异是声明出来的,不是猜出来的)。
 *
 * 这里定义的是**执行器**:上层(AgentActor / MindPort / 引擎)只知道「有一个
 * 执行器能跑回合」,不知道思考在哪里发生。local = 本引擎 + 我们的工具循环;
 * external = 包住一个 connector(今天只有 acp;Claude Code / Codex 都是 ACP 名册里的一台)。
 *
 * E0 只落契约与骨架:`runTurn` 的真实驱动在 E4 接(connector 改吃这个契约),
 * `interrupt`/`dispose` 的调用者在 E5 接(停止三级)。本期先让能力查询有唯一
 * 落点,把散在三处的 Set 判定收进来。
 */
import type { AgentTurnRequest, AgentTurnStreamEvent } from '@onething/backend/agent-loop/loop-primitives'

/**
 * 执行器 id。与 providerId 同名不是巧合——今天外部 agent 就是靠 providerId
 * 被认出来的,E0 保持这个映射不变以维持向后兼容;真正的选择权在 E4 之后
 * 交给 agent 配置里的 `executor` 字段。
 */
export type AgentExecutorId = 'local' | 'acp' | (string & {})

/** 思考在哪里发生。这是 local/external 唯一的本质差别。 */
export type AgentExecutorKind = 'local' | 'external'

/**
 * 声明式能力面。每一条都对应一个真实的分流点,不是装饰:
 * 加一条能力之前先问「谁会 if 它」,没有消费者就不加。
 */
export interface AgentExecutorCapabilities {
  /**
   * 能不能接宿主工具面(以 MCP 形式注入协作工具:send_message/board/…)。
   * 消费者:E3 宿主工具面。声明 true 不等于 E0 就接上了——E0 阶段这一位是
   * 「架构上可注入」的声明,真注入在 E3。
   */
  hostTools: boolean
  /** 能不能中途注入用户输入(steer)。消费者:steering 链路。 */
  steer: boolean
  /**
   * 有没有比 abort 更强的中断(能让对面进程真正停下,而不只是我们不再读)。
   * 消费者:E5 停止三级的人级撤牌。
   */
  interrupt: boolean
  /**
   * 上下文窗口归谁管。`theirs` = 执行体自己管,我们的压缩/阻断一律不介入。
   * 消费者:core 的压缩门(经 registerCoreProviderExecution 下沉到 core)。
   */
  contextWindow: 'ours' | 'theirs'
  /**
   * persona 怎么进:`system` = 作为 system prompt 原文送进去(不可包装,
   * 协作 P0 的既有纪律);`prepend` = 只能拼在用户消息前面。
   * 消费者:E4 的 persona 装配。
   */
  persona: 'system' | 'prepend'
}

/**
 * 一个回合的执行请求。E0 直接复用引擎既有的 `AgentTurnRequest` 词汇表,
 * 避免再造一套平行类型——executor 是**同构层**,不是新协议层。
 */
export type AgentExecutorTurnRequest = AgentTurnRequest

/** 回合事件流。同样对齐既有 `AgentTurnStreamEvent`,E4 接真实驱动时零翻译。 */
export type AgentExecutorTurnEvent = AgentTurnStreamEvent

export interface AgentExecutor {
  readonly id: AgentExecutorId
  readonly kind: AgentExecutorKind
  readonly capabilities: AgentExecutorCapabilities
  /**
   * 回合执行。E0 期骨架不实现——真实驱动在 E4 接:local 走引擎的工具循环,
   * external 走 connector.streamTurn。留成可选是为了让 E0 的骨架能被解析、
   * 被查能力、被写测试,而不必先把驱动搬过来。
   */
  runTurn?(request: AgentExecutorTurnRequest): AsyncIterable<AgentExecutorTurnEvent>
  /** 比 abort 更强的中断;仅当 capabilities.interrupt 为真时有意义(E5 接线)。 */
  interrupt?(sessionId: string): Promise<void>
  /** 释放该会话占用的执行体资源(进程/连接)。运行时 shutdown 与撤牌时调。 */
  dispose?(sessionId: string): Promise<void>
}
