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
import type { AgentTurnRequest, AgentTurnStreamEvent } from '@onething/backend/agent-loop'
/**
 * 执行器 id / 种类 / 能力面三个类型 2026-10-04 随执行器表搬进 agent-loop
 * (`agent-loop/agent-loop-external-agent-providers.ts`,越层清零 C2):provider(L1)也要问
 * 「是不是外部执行体」,表住在 agent(L2)里它就只能越层。这里转交出去,agent 的读者不必改。
 */
import type { AgentExecutorCapabilities, AgentExecutorId, AgentExecutorKind } from '@onething/backend/agent-loop'
export type { AgentExecutorCapabilities, AgentExecutorId, AgentExecutorKind }
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
