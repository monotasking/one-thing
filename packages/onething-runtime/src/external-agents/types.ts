import type { AgentReasoningEffort, AgentTurnStreamEvent } from '@onething/core/agent-loop'
import type { InteractionAnswer, InteractionQuestion } from '@onething/core/interaction'

/**
 * External agent connectors: the transport layer that speaks one concrete
 * agent protocol (ACP, Claude Agent SDK, Codex app-server, pi RPC) and
 * normalizes it into the engine's AgentTurnStreamEvent vocabulary. See
 * docs/design/external-agents-integration.md §3.
 */

export type ExternalAgentPermissionBridgeKind = 'callback' | 'rpc' | 'stdio-dialog' | 'none'

export interface ExternalAgentCapabilities {
  streamingText: boolean
  thinking: boolean
  toolSteps: boolean
  permissionBridge: ExternalAgentPermissionBridgeKind
  resume: boolean
  fork: boolean
  steer: boolean
  /**
   * 这个连接器接不接图片。**这一位有两个读者**(2026-08-12,审计「能力表要有读者」):
   *
   *  1. `provider.ts` 据它决定 `inputModalities` / `vision-input` 怎么声明;
   *  2. 同一处据它决定图片是**送进去**还是**当场说没送到** —— 翻成 false,
   *     发图的回合就会收到一句可见的「此引擎暂不支持图片」,而不是悄悄只发文本。
   *
   * 也就是说翻这一位真的会改变行为,它不是一行文档。
   */
  imagesIn: boolean
  mcpInjection: 'in-process' | 'config' | 'none'
  /**
   * Whether one connector process serves many onething sessions
   * ('multiplexed': Codex app-server, ACP) or each active session needs its
   * own process ('per-process': Claude SDK query, pi RPC).
   */
  concurrentSessions: 'multiplexed' | 'per-process'
}

/**
 * Persisted link between an onething session and the agent's own session.
 * Written into the session meta at turn start so a crash never orphans the
 * external session; the local transcript is a rendering snapshot, the
 * external session is the source of truth for the agent's context.
 */
export interface ExternalAgentSessionLink {
  localSessionId: string
  connectorId: string
  externalSessionId: string
  cwd: string
  createdAt: number
  lastUsedAt: number
}

/**
 * 一张随本轮用户消息进去的图片(2026-08-12,审计「图片静默丢弃」)。
 *
 * 形状与 `AgentImageContentPart.image` **逐字相同**(data URL / 裸 base64 /
 * http(s) URL),理由是这一位就是从那里抄过来的:多一层自造的格式,就多一处
 * 「哪一头忘了转换」的静默丢弃 —— 而那正是这次要修的那个 bug。
 */
export interface ExternalAgentImageInput {
  /** data URL(`data:image/png;base64,…`)、裸 base64,或 http(s) URL。 */
  image: string
  /** 裸 base64 时的兜底类型;data URL 自带的那个优先。 */
  mediaType?: string
}

export interface ExternalAgentTurnRequest {
  localSessionId: string
  /** Trusted host option for in-process tools; never serialized to the SDK prompt. */
  executionContext?: unknown
  /** Assistant message the turn streams into; threads into permission asks. */
  messageId?: string
  prompt: string
  /**
   * 本轮最后一条用户消息里的图片(2026-08-12)。
   *
   * **只有 `capabilities.imagesIn` 为真的连接器才会收到它** —— `provider.ts` 在那一位
   * 上分岔:接得住就送进来,接不住就当场发一句可见的正文说「图片没送到」。两条路都不
   * 静默,这是这一位存在的全部理由。
   */
  images?: ExternalAgentImageInput[]
  /**
   * 这一轮的 system prompt(E4/G9)。**persona 走这里进去** —— 在此之前整份
   * system prompt 在 `provider.ts` 被丢掉,群里的 Iris 于是不是 Iris,只是一台
   * 拿着最后一条 user 文本的 Claude Code。
   *
   * 谁认得它由 connector 决定:E0 能力表里 `persona: 'system'` 的执行器把它接到
   * 协议的 system 位(claude-code → SDK `systemPrompt`);`persona: 'prepend'`
   * 的只能拼在用户消息前面(ACP 没有 system 位)。
   */
  systemPrompt?: string
  cwd: string
  /** Connector-specific model/agent selector (ACP agent id, claude model, …). */
  model?: string
  thinking?: 'enabled' | 'disabled'
  reasoningEffort?: AgentReasoningEffort
  turn: number
  abortSignal?: AbortSignal
  /** Resume this previously persisted external session instead of starting fresh. */
  resume?: ExternalAgentSessionLink
}

export type ExternalAgentEvent =
  | AgentTurnStreamEvent
  | { type: 'session-established'; link: ExternalAgentSessionLink }
  | {
      type: 'agent-status'
      status: 'starting' | 'ready' | 'busy' | 'crashed'
      detail?: string
    }

/** Connector-agnostic permission ask, bridged by the host to the permission policy gate. */
export interface ExternalAgentPermissionAsk {
  connectorId: string
  localSessionId: string
  messageId?: string
  cwd?: string
  toolName: string
  input: unknown
  /**
   * 协议侧的工具调用 id(SDK 的 `toolUseID`,`sdk.d.ts:241-245`)。
   *
   * **卡片靠它归位**:core 只在 `callId` 存在时才发 `permission:queued`
   * (`core/permission/index.ts:393-400`),renderer 匹配不到 toolCall 就把事件
   * 永久缓存、一个字都不画(`stores/chat.ts:996-1006`)。E4 之前这里是
   * `undefined`,于是审批卡从未上屏 —— F3 那 2 分 11 秒的直接成因。
   *
   * 它同时是 120s 无人值守自动拒绝桥的定位键(`permission-policy.ts:78-81` 按
   * callId + messageId 找 pending),所以丢了它连兜底都找不到东西可结算。
   */
  toolCallId?: string
}

/**
 * 审批结果。**deny 必带 message** —— 它原样进 SDK 的工具结果给模型看,所以
 * 「为什么不行」必须是一句人话(超时理由、策略拒绝理由),不能是一个 false。
 */
export type ExternalAgentPermissionDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message: string }

/** Must never throw; a rejection is treated as a deny with the error text. */
export type ExternalAgentPermissionHandler = (
  ask: ExternalAgentPermissionAsk,
) => Promise<ExternalAgentPermissionDecision>

/**
 * 连接器无关的**提问**(E4/G6+G7)。与审批并列的一等概念,不是它的一个 case ——
 * 理由见 `packages/core/interaction/types.ts` 开头那段。
 *
 * 两条入口都汇到这里:SDK 的 `AskUserQuestion` 工具(经 `canUseTool`)与
 * `onUserDialog` 控制请求。装配层拿到它去起 `Interaction.ask`,并在没有人类在场
 * 的场合(pair 房)当场 `declined` —— 原则 3。
 */
export interface ExternalAgentInteractionAsk {
  connectorId: string
  localSessionId: string
  messageId?: string
  /** 发起提问的工具调用(`AskUserQuestion` 的 toolUseID);卡片按它归位。 */
  toolCallId?: string
  questions: InteractionQuestion[]
}

/**
 * 提问处理器。**永不 throw、永不挂起** —— 四种 outcome 都是正常返回值
 * (`Interaction.ask` 的契约),调用方必须逐种翻译成模型看得懂的工具结果。
 */
export type ExternalAgentInteractionHandler = (
  ask: ExternalAgentInteractionAsk,
) => Promise<InteractionAnswer>

/**
 * 外部回合的**观测口**(E6,§6)。
 *
 * 与 `permissionHandler` / `interactionHandler` 同一个形状,理由也同一条:连接器住在
 * 纯运行时层,不认识调度时间轴,更不该认识「房间」这个概念。装上就记账,不装就是不记
 * —— 观测是旁路,金重放与纯测试跑的正是不装的那一档。
 *
 * 两个方法都必须**同步、绝不抛**:它们挂在外部回合的关键路径上,一次记账失败让那一轮
 * 炸掉,是把「看不见」升级成「跑不动」。
 */
export interface ExternalAgentObserver {
  /** 一轮的起 / 落。`end` 带收场与墙钟。 */
  turn(input: {
    connectorId: string
    localSessionId: string
    phase: 'start' | 'end'
    outcome?: 'complete' | 'error' | 'aborted'
    elapsedMs?: number
  }): void
  /**
   * `canUseTool` 的一次决定。`hostTool` 分开两条完全不同的路:宿主工具直接放行
   * (真正的门在下游我们自己的执行器里),SDK 自带工具走宿主审批。
   */
  toolDecision(input: {
    connectorId: string
    localSessionId: string
    /** 归一化之后的名字(`mcp__onething__` 前缀已剥)。 */
    toolName: string
    decision: 'allow' | 'deny'
    hostTool: boolean
    toolCallId?: string
  }): void
  /**
   * 后台子代理的**电平**(2026-08-11)。
   *
   * 用户的原话是:「我发了之后,作为用户我认为它已经执行完了,但输入框还是可终止
   * 状态。它到底在不在执行、执行了多长时间,除了终止按钮我一律不知。」正文流完而
   * 输入仍开着的那段时间,连接器手上有全部信号(`background_tasks_changed` 的整表
   * 替换),缺的只是一条通向界面的路 —— 这就是那条路。
   *
   * **可选**:装配层装上才有界面,不装(金重放、纯连接器测试)就是不报,与
   * `turn` / `toolDecision` 同一档纪律。同样必须同步、绝不抛。
   *
   * 三相:
   *  - `running` —— 电平从零抬起,或抬起后任务数变了。`startedAt` 是**第一次**
   *    抬起的墙钟,整段期间不变:呈现侧据此自算耗时,不需要逐秒事件。
   *  - `settled` —— 电平归零(`count` 为 0),或回合收场时仍未归零(防呆表超时 /
   *    abort,此时 `count` 是残留数,如实报,不谎称干净收尾)。
   *
   * **零后台的普通回合一条都不发** —— 每次对话都挂一根状态条是噪音,不是可见性。
   */
  backgroundTasks?(input: {
    connectorId: string
    localSessionId: string
    phase: 'running' | 'settled'
    /** 这一刻活着的后台任务数。`settled` 时为 0,除非是超时 / abort 的残留。 */
    count: number
    /** 电平第一次抬起的墙钟。整段期间是同一个值。 */
    startedAt: number
    /** `settled` 才有:从抬起到收场的总时长。 */
    elapsedMs?: number
  }): void
}

/**
 * 一次中途追话**真的**落到了哪一档(2026-08-12)。
 *
 * 存在的理由只有一条:不许假装。追话有三种截然不同的下场,而它们在界面上必须
 * 长得不一样 —— 把三者压成一个 `void` 就等于让宿主猜,而宿主猜错的方向永远是
 * 「以为插进去了」。
 *
 *  - `'steered'` —— 就地插进了正在跑的那一轮(claude-code 走 SDK 的
 *    `priority:'now'`:当前轮就地截断、已生成的正文保留,新的一轮马上回答追话)。
 *  - `'queued'` —— 送到了,但要等当前这一轮跑完才轮到它。**这不是失败**,是
 *    一个较弱的真相:通道收下了,只是排在后面。
 *  - `'unavailable'` —— 没送到(这条会话上没有正在跑的外部回合,或输入通道已经
 *    收口)。宿主该退回自己的 steering 队列,而不是当作已送达。
 */
export type ExternalAgentSteerOutcome = 'steered' | 'queued' | 'unavailable'

export interface ExternalAgentConnector {
  readonly id: string
  readonly capabilities: ExternalAgentCapabilities
  streamTurn(request: ExternalAgentTurnRequest): AsyncIterable<ExternalAgentEvent>
  interrupt(localSessionId: string): Promise<void>
  /**
   * 中途追话;**只有 `capabilities.steer` 为真的连接器才有它**。
   *
   * **同步**(此前是 `Promise<void>`,没有任何实现,所以改它不破坏谁)。理由不是
   * 省一个 await,是宿主那一侧:`CoreStreamEngine.steerMessage` 返回 void,它必须
   * 在**那一刻**就知道「这条要不要入队」。给它一个 promise,它只能先入队再说 ——
   * 而那正好是同一句话进模型两遍的做法。投递本身也确实没有异步的东西:往一个
   * 开着的输入迭代器里塞一条消息而已。
   */
  steer?(localSessionId: string, text: string): ExternalAgentSteerOutcome
  dispose(): Promise<void>
}

/**
 * MCP caller attribution: when onething injects its MCP server into an
 * external agent, the injected config carries a per-(connector, session)
 * token so incoming MCP calls can be attributed for permission-card
 * bylines and run_agent loop detection. Contract fixed here at P0; the
 * MCP server lands in P4.
 */
export interface ExternalAgentMcpAttribution {
  token: string
  connectorId: string
  localSessionId: string
  /** run_agent call-chain depth at issuance; used to enforce the depth cap. */
  chainDepth: number
}
