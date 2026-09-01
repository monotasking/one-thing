/**
 * 投影输出的形状 —— 与 shared 层契约里的 `ChatMessage` / `Step` / `ToolCall` /
 * `ContentPart` **结构兼容**,但 core 不引用它们(零依赖层)。
 *
 * "结构兼容"的意思是:投影出的对象可以直接当 `ChatMessage` 用(字段名、可选性、
 * 字面量联合都对得上),但这里只声明投影**会填**的字段 —— 事件里没有的东西
 * 不出现在类型上,免得下一个人以为投影能给出它。
 */

import type { CoreStepType } from '../../engine/tool-step.js'

export type ProjectedToolCallStatus =
  | 'pending'
  | 'queued'
  | 'received'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'input-streaming'

export interface ProjectedToolCall {
  id: string
  toolId: string
  toolName: string
  arguments: Record<string, unknown>
  status: ProjectedToolCallStatus
  result?: unknown
  error?: string
  rejected?: boolean
  rejectionReason?: string
  timestamp: number
  /** 参数流收齐的时刻(`assistant/part-end` 的 tool-input part)。 */
  receivedAt?: number
  startTime?: number
  endTime?: number
  /** `endTime − startTime`(引擎那份账里是同名字段)。 */
  durationMs?: number
  /** 收场时引擎写死的那一位(确认闸已经关上)。 */
  requiresConfirmation?: boolean
  /** 参数还在流式生成时的原始 JSON 片段;`tool/call` 一到就撤下。 */
  streamingArgs?: string
  /**
   * edit/write 的结构化 diff(`CoreToolCallChangesLike`,§13.17)。工具卡的 diff
   * 视图读它;`tool/result.changes` 物化出来的那一份。不透明,不含 originalContent。
   */
  changes?: unknown
}

export type ProjectedStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'awaiting-confirmation'
  | 'cancelled'

export interface ProjectedStepUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  /**
   * 批 P-a:厂商报的本次请求成本(USD)。**只在 step 那一格**出现 —— 消息级
   * `usage` 走引擎累加器,累加器不带成本(见 `addUsage`)。
   */
  providerCostUSD?: number
}

export interface ProjectedStep {
  id: string
  /** 与引擎同一条派生规则(getStepType):bash 按命令内容分 command/file-read/skill-read。 */
  type: CoreStepType
  title: string
  /** G3:父调用之下的子步骤(`tool/call.parentCallId` 建起来的那一层)。 */
  childSteps?: ProjectedStep[]
  status: ProjectedStepStatus
  timestamp: number
  turnIndex?: number
  toolCallId?: string
  toolCall?: ProjectedToolCall
  result?: string
  error?: string
  rejected?: boolean
  rejectionReason?: string
  /**
   * 结构化结局(工具卡渲染的那一份)。落盘时被摘掉,冷加载由
   * `rehydrateSessionFromStorage` 从 `toolCall.result` 算回来 —— 投影用同一条规则。
   */
  partialResult?: unknown
  partialResultIsPartial?: boolean
  usage?: ProjectedStepUsage
}

/**
 * `partIndex` 只在 `ProjectionMaterializeOptions.includePartIndex` 打开时才有
 * (R 线 R2,壳侧水位合并要认段;默认档一律缺席,影子对账因此零感知)。
 */
export type ProjectedContentPart =
  | { type: 'text'; content: string; turnIndex?: number; partIndex?: number }
  | { type: 'reasoning'; content: string; turnIndex?: number; partIndex?: number }
  | { type: 'image'; blob: { hash: string; bytes: number; mime?: string }; turnIndex?: number; partIndex?: number }
  /**
   * A1:provider 让我们原样带回的那块不透明数据(Claude 的 thinking 签名 /
   * codex 的加密推理)。引擎那一格逐字是 `{type, providerData, turnIndex}`;
   * 载荷超 64KB 走了 blob 而当前没有 resolver 时,留 `blob` 引用(与 image 同款)。
   */
  | { type: 'provider-data'; providerData: unknown; turnIndex?: number }
  | { type: 'provider-data'; blob: { hash: string; bytes: number; mime?: string }; turnIndex?: number }

export interface ProjectedTurnContext {
  set?: Record<string, string>
  removed?: string[]
}

export interface ProjectedChatMessage {
  id: string
  role: 'user' | 'assistant' | 'error' | 'system'
  content: string
  timestamp: number
  isStreaming?: boolean
  errorDetails?: string
  reasoning?: string
  toolCalls?: ProjectedToolCall[]
  contentParts?: ProjectedContentPart[]
  model?: string
  provider?: string
  agentId?: string
  steps?: ProjectedStep[]
  /** G5:这一轮激活了哪个技能(`skill/activated`)。 */
  skillUsed?: string
  /** G5:派生的思考时长(ms) —— 推理段的首尾差,没有推理时是首 token 的等待。 */
  thinkingTime?: number
  turnContext?: ProjectedTurnContext
  usage?: ProjectedStepUsage
  /** 事件坐标:这条消息由哪条事件开头(§3.2 `ChatMessage.seq` 退役后的身份)。 */
  eventSeq?: number
  /** 老会话导入 / 用户消息原样带过来的其余字段。 */
  [key: string]: unknown
}

export interface ProjectChatMessagesResult {
  messages: ProjectedChatMessage[]
  /** 正在生成的那一条(`run/start` 之后、`run/end` 之前)。 */
  activeRun?: { runId: string; messageId: string }
}
