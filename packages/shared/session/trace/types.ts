/**
 * 会话轨迹树的形状(S3 只读查询面)。
 *
 * 它们是 `sessionEvents` RPC 域(`@shared/ipc/session-events.ts`)交给客户端的载荷;
 * 装配器 `assembleSessionTrace` 是后端的纯函数,住在 `packages/backend/session/trace/assemble.ts`,
 * 从这里取形状。四条纪律(只记时刻、正文不进树……)写在装配器的文件头。
 */

import type {
  BlobRef,
  SessionAssistantPartKind,
  SessionRequestEndUsage,
  SessionResponseUsage,
  SessionRunKind,
} from '../events/types.js'

// ============ 树 ============

/** 一次工具调用:调用 + 结果 + 审计 + 权限答复,合成一格。 */
export interface SessionTraceToolCall {
  callId: string
  name: string
  /** 模型给的原始 arguments 串 —— 原样,包括它写坏的那次。 */
  argumentsRaw: string
  callSeq: number
  callTime: number
  /** G3:父调用。有它说明这次调用发生在另一次调用**内部**。 */
  parentCallId?: string
  resultSeq?: number
  resultTime?: number
  /** 给模型看的那段正文的预览(事件里存的就是预览,不是全文)。 */
  resultPreview?: string
  /** 结果走了 blob:树上只有引用。 */
  resultRef?: BlobRef
  isError?: boolean
  audit?: SessionTraceToolAudit
  permission?: SessionTracePermission
}

export interface SessionTraceToolAudit {
  toolId: string
  effects: string[]
  effectCount: number
  outcome: 'ok' | 'invalid' | 'denied' | 'aborted' | 'failed'
  decision?: 'allow' | 'deny'
  asked?: boolean
  previewTitle?: string
  intercepted?: { action: 'rewrite' | 'block'; by?: string[] }
  time: number
}

export interface SessionTracePermission {
  requestId: string
  askedTime?: number
  answeredTime?: number
  approved?: boolean
  scope?: string
  /** 拒绝理由 —— 模型看到的那句话。 */
  reason?: string
}

/** 响应各 part 的**指纹**。正文不在这里(纪律 2)。 */
export interface SessionTraceResponsePart {
  partIndex: number
  kind: SessionAssistantPartKind
  len: number
  hash?: string
  toolCallId?: string
}

export interface SessionTraceRequestError {
  seq: number
  time: number
  name?: string
  message: string
  status?: number
  willRetry: boolean
  attempt: number
}

export interface SessionTraceRequest {
  requestIndex: number
  /** `request/start` 的 seq —— 与轨迹面板的组 key 对齐的**连接键**。 */
  startSeq?: number
  provider?: string
  model?: string
  systemPromptHash?: string
  toolsHash?: string
  /** 当时目录里的工具数。拿不到就缺席(与面板的 `unavailable` 同一条纪律)。 */
  toolCount?: number
  /** `request/recipe` 里那次请求发出去的历史条数。 */
  recipeMessageCount?: number
  params?: Record<string, unknown>
  startTime?: number
  firstTokenTime?: number
  endTime?: number
  usage?: SessionResponseUsage | SessionRequestEndUsage
  finishReason?: string
  stopReason?: string
  responseModel?: string
  providerResponseId?: string
  parts: SessionTraceResponsePart[]
  errors: SessionTraceRequestError[]
  toolCalls: SessionTraceToolCall[]
}

export interface SessionTraceRun {
  /**
   * 这一组的**地址**。真 run 就是 runId;老文件的合成组是
   * `legacy:<assistantMessageId>` —— CLI 的 `--run` 与 HTTP 的 `?run=` 认它。
   */
  key: string
  /** 老文件没有 runId,这里留空串 —— **不发明**(纪律 4)。 */
  runId: string
  synthetic: boolean
  kind?: SessionRunKind
  agentId?: string
  assistantMessageId?: string
  provider?: string
  model?: string
  /** G5:这次执行激活的技能。 */
  skillUsed?: string
  trigger?: {
    messageId?: string
    eventSeq?: number
    /** 触发这次执行的那条用户消息的开头。截断的,不是全文。 */
    preview?: string
  }
  outcome?: 'completed' | 'aborted' | 'error' | 'interrupted'
  error?: { name?: string; message: string }
  /** run 的第一条事件的 seq —— 排序键,也是"这一组从哪开始"。 */
  firstSeq: number
  startTime?: number
  endTime?: number
  requests: SessionTraceRequest[]
}

/** 压缩:发生在 run 之外,所以它是会话级的一行,不挂在任何一棵 run 上。 */
export interface SessionTraceCompaction {
  seq: number
  time: number
  messageId: string
  compactedMessageCount: number
  status: 'completed' | 'failed'
  model?: string
  provider?: string
  error?: string
}

export interface SessionTrace {
  sessionId?: string
  /** 日志里有 `run/start` 吗。false = 老文件,下面的 run 全是合成的。 */
  hasRunEvents: boolean
  eventCount: number
  createdAt?: number
  sessionKind?: string
  agentId?: string
  /** 会话里**一共**有多少组(过滤之前)。`runs.length` 是过滤之后的。 */
  totalRuns: number
  runs: SessionTraceRun[]
  compactions: SessionTraceCompaction[]
}

export interface SessionTraceResponseText {
  text: string
  reasoning: string
  /** 折出这段正文的 delta 条数 —— 空正文与"没有这次请求"由它分开。 */
  partCount: number
}
