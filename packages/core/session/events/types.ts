/**
 * 会话事件词表 v2 —— `docs/design/session-event-sourcing-2026-08.md` §9.1/§9.2。
 *
 * 这里是**唯一**的事件形状定义处:S0 之前七类住在
 * `packages/onething-runtime/src/sessions/session-events.ts`,那里 import 了
 * `node:crypto`,renderer 只能靠 shared 层那个契约面的 `export type` 擦除来绕开。现在类型上移到 core(零依赖),runtime 那个文件降为**再导出 +
 * 哈希/检视工具**,盘上格式与既有消费者逐字不变。
 *
 * 四条铁律照旧(原文见 runtime 侧的文件头):只记时刻;执行前记账;记模型当时
 * 看到的世界;追加不截断(读侧遇到不认识的 type 跳过那一行)。
 *
 * v2 在此之上加两条:
 *
 * 1. **surface 是事件的顶层字段,不是投影的猜测**(dsh 判例,§3.1)。
 *    `surfaceOp` + `sourceEventSeqs` 一个机制同时表达 compact / edit-resend /
 *    regenerate / delete / 工具结果剪枝;被遮蔽的事件留在日志里,只是不在
 *    模型可见历史上。
 * 2. **响应正文只有一个来源**:`assistant/chunks` 的 delta fold。
 *    `request/response` 只带 finish/usage/ids + 各 part 的 len/hash,
 *    不存第二份文本 —— 这一条由本文件末尾的类型级门钉住。
 */

// ============ 记录外壳 ============

/**
 * surface 操作(§9.1)。
 *
 * - `'append'`:这条事件在模型可见历史的末尾新增一个节点。
 * - `{op:'replace', start, end}`:遮蔽 `[start, end]`(闭区间,按 **eventSeq**)
 *   这一段 surface 节点。替换进去的是本事件自己(如果它是节点类型),否则就是
 *   纯删除(`message/deleted` / `session/cleared`)。
 *
 * `start`/`end` 是 **eventSeq**,不是数组下标 —— 下标会随前面的替换平移,
 * 而 seq 是身份(§7.2 M6:`ChatMessage.seq` 是位置,事件 seq 是身份)。
 */
export type SessionSurfaceOp =
  | 'append'
  | { op: 'replace'; start: number; end: number }

/**
 * 事件记录(§9.1)。`surfaceOp` / `sourceEventSeqs` 与 seq/time 同级 —— 它们是
 * **账本层**的字段,不属于任何一条事件的业务 data。
 */
export interface SessionEventRecordShape<TType extends string, TData> {
  /** 会话内单调递增,从 1 起。身份,不是位置。 */
  seq: number
  /** Date.now()。只有时刻,没有时长。 */
  time: number
  type: TType
  data: TData
  /** 仅 surface 事件带。 */
  surfaceOp?: SessionSurfaceOp
  /** 因果/遮蔽引用:被这条事件遮蔽或导出它的那些 eventSeq。 */
  sourceEventSeqs?: number[]
}

// ============ Blob 引用 ============

/**
 * 大正文的引用(§9.1)。S0 **只定义类型与判定**,blob 落盘在 S1。
 *
 * 谁必须是 BlobRef:附件的 `base64Data`、超 64KB 的工具结果、图片 part。
 * 判定故意收得紧(三个字段的类型都查):事件行里塞一个
 * `{hash: 'abc'}` 而没有 bytes 的半成品,是 S1 最容易犯的错。
 */
export interface BlobRef {
  hash: string
  bytes: number
  mime?: string
}

export function isBlobRef(value: unknown): value is BlobRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const ref = value as Partial<BlobRef>
  if (typeof ref.hash !== 'string' || ref.hash.length === 0) return false
  if (typeof ref.bytes !== 'number' || !Number.isFinite(ref.bytes) || ref.bytes < 0) return false
  if (ref.mime !== undefined && typeof ref.mime !== 'string') return false
  return true
}

/** 超过这个字节数的工具结果/正文必须走 blob(§9.1)。S0 只是常量,不落盘。 */
export const SESSION_EVENT_BLOB_THRESHOLD_BYTES = 64 * 1024

// ============ 投影用的消息形状(core 本地,不引 shared 的契约) ============

/**
 * 事件里承载的一条消息。
 *
 * 与 shared 层契约里的 `ChatMessage` **结构兼容**但不引用它 —— core 是零依赖层,
 * 而那些契约住在 shared。字段全部可选(除 id/role),因为事件里存的就是
 * 当时那条消息**有什么就是什么**,不补全、不规整。
 */
export interface SessionEventMessage {
  id: string
  role: string
  content?: string
  timestamp?: number
  [key: string]: unknown
}

// ============ 既有七类(形状不变,只加可选 runId) ============

export interface SessionEventToolSchema {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

export interface SessionRequestToolsEventData {
  requestIndex: number
  toolsHash: string
  tools: SessionEventToolSchema[]
  runId?: string
}

export interface SessionRequestHeaderEventData {
  requestIndex: number
  provider: string
  model: string
  systemPromptHash: string
  toolsHash: string
  reason: 'initial' | 'change'
  runId?: string
}

export interface SessionRequestStartEventData {
  requestIndex: number
  messageId: string
  runId?: string
}

export interface SessionAssistantFirstTokenEventData {
  requestIndex: number
  messageId: string
  runId?: string
}

export interface SessionToolCallEventData {
  callId: string
  /** 模型给的原始 arguments JSON 串 —— 原样存,包括它写坏的时候。 */
  argumentsRaw: string
  name: string
  messageId: string
  runId?: string
  /**
   * G3(§10.1):父调用的 callId —— 一次工具调用在另一次调用**内部**发生时才有。
   * 采集点拿得到就填,拿不到就平铺(不猜、不按时间窗配对);投影按它建
   * `childSteps`。
   */
  parentCallId?: string
}

/**
 * 工具结果。v2 把正文补上:`result` 是 `{text}` 或 `{blob}`,
 * `resultPreview` **保留**(既有文件只有它,轨迹面板也只读它)。
 */
export interface SessionToolResultEventData {
  callId: string
  isError: boolean
  resultPreview: string
  /** 对应 `tool/call` 事件的 seq。因果显式引用,不靠"就近配对"猜。 */
  sourceSeq?: number
  result?: { text: string } | { blob: BlobRef }
  /**
   * 工具**结构化**结局的 JSON(`ToolCall.result` 的正身)。
   *
   * `result` 是给模型看的那段正文(历史里放的就是它),而工具卡上渲染的是
   * 结构化的那一份 —— `{title, output, metadata}` 里的 metadata 才是 diff
   * hunks / 文件路径 / 命令退出码的所在处。只记正文的话,S2 切读之后每张工具卡
   * 都会退化成一段纯文本,而门却是绿的。
   *
   * 与 `result` 同一条 64KB 线(超过走 blob);工具结局本身就是字符串时不写
   * 这一格(那时两者是同一个东西)。
   */
  resultData?: { text: string } | { blob: BlobRef }
  /**
   * 工具**自报**的标题(`annotate{title}` 的最后一条,§10.12 第 6 类)。
   *
   * 引擎的 step 标题就是它:每一条带标题的 `tool-metadata` 都会
   * `sendStepUpdated({title})` 覆盖一次(`applyAgentLoopToolMetadata`)。
   * 成功的调用里它同时被抄进结局的 `resultData.title`,所以从前只读 resultData
   * 也对得上;**失败的调用没有结局对象**(`{success:false, error}` 里没有 title),
   * 于是账本上那一格凭空消失,投影退回派生标题 —— 真机上 `read` 越界失败的那条
   * 就是这么从 "Reading X.md" 变成 "Tool: read: X.md" 的。
   */
  reportedTitle?: string
  runId?: string
}

export interface SessionToolAuditEventData {
  callId: string
  toolId: string
  effects: string[]
  effectCount: number
  previewTitle?: string
  decision?: 'allow' | 'deny'
  asked?: boolean
  outcome: 'ok' | 'invalid' | 'denied' | 'aborted' | 'failed'
  intercepted?: { action: 'rewrite' | 'block'; by?: string[] }
  messageId?: string
  runId?: string
}

export interface SessionRequestEndUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface SessionRequestEndEventData {
  requestIndex: number
  stopReason?: string
  usage?: SessionRequestEndUsage
  runId?: string
}

// ============ 会话 ============

export interface SessionCreatedEventData {
  sessionId: string
  kind?: string
  agentId?: string
  model?: string
  provider?: string
  workingDirectory?: string
}

export interface SessionAgentChangedEventData {
  from?: string
  to: string
}

export interface SessionModelChangedEventData {
  from?: string
  to: string
  provider?: string
}

export interface SessionWorkdirChangedEventData {
  from?: string
  to: string
}

/**
 * 压缩。**它自己是一个 surface 节点**(summary 作为历史里的那条 system 消息),
 * 同时带 `surfaceOp: replace` 遮蔽被压掉的那一段。
 *
 * `messageId` 是今天 UI 上那条 compact 标记消息的 id —— 投影要把它复原成
 * `role:'system'` 的派生消息(§9.4 的"注意"),所以 id 必须在事件里。
 */
export interface SessionCompactedEventData {
  summary: string
  messageId: string
  /** 被压掉的消息条数(UI 卡片上显示的那个数)。 */
  compactedMessageCount: number
  /** 切点:压到哪条消息为止。 */
  compactedThroughMessageId?: string
  model?: string
  provider?: string
  /** 失败的压缩也记一条 —— 它在 UI 上是一张红卡,不是"什么都没发生"。 */
  status?: 'completed' | 'failed'
  error?: string
}

/** `replaceAll{clear}` / collab 的 MESSAGES_REPLACED(§9.3)。 */
export interface SessionClearedEventData {
  reason: 'clear' | 'replaced'
}

// ============ 用户 / 消息 ============

export interface SessionUserMessageEventData {
  message: SessionEventMessage
}

export interface SessionSystemMessageEventData {
  message: SessionEventMessage
}

export interface SessionUserMessageEditedEventData {
  messageId: string
  message: SessionEventMessage
}

export interface SessionMessageDeletedEventData {
  messageId: string
}

/**
 * 非正文字段的改写(§9.2)。
 *
 * `patch` 里**不许**出现 content/contentParts/reasoning —— 那三样的来源是
 * chunks,不是命令。类型上收不住(patch 是开放记录),所以由投影侧丢弃并在
 * 合同测试里钉住。
 */
export interface SessionMessagePatchedEventData {
  messageId: string
  patch: Record<string, unknown>
}

export interface SessionMessageImportedEventData {
  message: SessionEventMessage
}

// ============ 执行 ============

export type SessionRunKind =
  | 'send'
  | 'retry'
  | 'edit-resend'
  | 'resume'
  | 'steer'
  | 'follow-up'

export interface SessionRunStartEventData {
  runId: string
  kind: SessionRunKind
  agentId?: string
  /**
   * 触发这次执行的那条事件(通常是 `user/message`)。
   *
   * S1 里它**经常解不出来**:引擎入口拿到的是 messageId,而 id→eventSeq 的索引
   * 要到 S2 才有。所以下面那一格是并列的、不是替补 —— 解得出就填 seq,解不出
   * 就只有 id,两者都没有就说明这次执行不是被某条消息触发的(retry / resume)。
   */
  triggerEventSeq?: number
  triggerMessageId?: string
  assistantMessageId: string
  provider?: string
  model?: string
  /**
   * 助手消息本身的时刻(`ChatMessage.timestamp`)。
   *
   * 事件的 `time` 是**记账时刻**,而助手那条占位消息是在开 run 之前就建好的
   * (引擎先建消息、再进执行入口)。投影把这一格物化成一条消息,时刻必须跟着
   * 消息走 —— 否则每一个 run 的投影都比事实晚几毫秒,而影子断言会把它当成
   * 一次真的不等。缺席时退回 `event.time`(老文件里没有这一格)。
   */
  timestamp?: number
  /**
   * 触发这次执行的那条命令的来源(`ChatMessage.origin`)。
   *
   * 引擎把它**同时**盖在用户消息与助手占位消息上(`core-stream-engine.ts` 的
   * `origin: cmd.origin`),外发路由靠它回到正确的渠道。助手那条不经翻译器
   * (它在 surface 上的那一格就是这条 `run/start`),所以它只能住在这里 ——
   * 从触发消息上"推"是错的:输入被插件改写过时,用户消息那份多一枚
   * `inputTransformed` 戳,而助手那份没有。
   */
  origin?: Record<string, unknown>
  /**
   * 这次 run **接着**哪一次 run 的执行往下跑(§10.12 第 5 类)。
   *
   * "一条 assistant 消息 = 一次 run"(§10.7 口径 1)是投影的前提,而引擎那边的
   * **一次执行**可以跨两条消息:steering 打断时 `response-boundary` 换助手消息、
   * `rotateSessionRun` 换 run,但 agent-loop 的**回合计数器与用量累加器一格都不
   * 重置** —— 新消息的第一段推理是 `turnIndex 2`(所以是 `inline` 落点,不是
   * `top`),整次执行的 usage 最后落在**接手的那条消息**上,被打断的那条一格都
   * 没有。
   *
   * 只有 `rotateSessionRun` 填这一格。没有它,投影只能按"每个 run 从第 1 轮数起"
   * 猜,于是 steering 之后每一条消息的推理落点、turnIndex 与 usage 三样全错
   * (真机第四批 17 行不等的唯一病根)。
   */
  continuesRunId?: string
}

export interface SessionRunEndEventData {
  runId: string
  outcome: 'completed' | 'aborted' | 'error' | 'interrupted'
  error?: { name?: string; message: string }
}

// ============ 请求 ============

export interface SessionRequestRecipeEventData {
  runId: string
  requestIndex: number
  systemPromptHash: string
  toolsHash: string
  /** 这次请求发出去的历史,按 surface 节点的 eventSeq + 内容指纹。 */
  messages: Array<{ eventSeq: number; contentHash: string }>
  params?: Record<string, unknown>
}

/** 响应用量。比 `request/end` 的那份多两格(总数与推理 token)。 */
export interface SessionResponseUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface SessionRequestResponseEventData {
  runId: string
  requestIndex: number
  messageId: string
  providerResponseId?: string
  responseModel?: string
  finishReason?: string
  usage?: SessionResponseUsage
  /** 各 part 的**指纹**,不是正文。正文唯一来源是 `assistant/chunks`。 */
  parts?: Array<{ partIndex: number; kind: SessionAssistantPartKind; len: number; hash?: string }>
  toolCallIds?: string[]
}

export interface SessionRequestErrorEventData {
  runId: string
  requestIndex: number
  error: { name?: string; message: string; status?: number }
  willRetry: boolean
  attempt: number
}

// ============ 助手 ============

export type SessionAssistantPartKind = 'text' | 'reasoning' | 'tool-input' | 'image'

/**
 * 一批 delta(§9.2 助手行)。**一行就是一个事件** —— dsh 那边打包行要在逻辑层
 * 展开成 N 个事件(它有 `events[i].seq === i` 的连续契约),我们不需要:
 * 一条 delta 的身份 = `(eventSeq, index)`。
 *
 * `dt[i]` 是相对 `time0` 的毫秒,`text[i]` 是那一条 delta 的原文,两个数组等长。
 */
export interface SessionAssistantChunksEventData {
  runId: string
  requestIndex: number
  messageId: string
  partIndex: number
  kind: Exclude<SessionAssistantPartKind, 'image'>
  toolCallId?: string
  time0: number
  dt: number[]
  text: string[]
}

export interface SessionAssistantPartEndEventData {
  runId: string
  requestIndex: number
  messageId: string
  partIndex: number
  kind: SessionAssistantPartKind
  len: number
  hash?: string
  toolCallId?: string
  /** 图片 part:正文在 blob 里,事件行只有引用。 */
  blob?: BlobRef
}

/**
 * G5(§10.1):技能被激活。今天它是一条**流事件**(`skill:activated`,
 * `core/engine/event-only-emitter.ts`),只在内存里活到 renderer 把
 * `message.skillUsed` 写上为止 —— 重载后那一格从消息字段里读回来,而事件账本
 * 上没有任何痕迹。这里给它一条自己的账:`skillUsed` 因此是派生的,不是补丁。
 */
export interface SessionSkillActivatedEventData {
  runId?: string
  messageId: string
  skill: string
}

// ============ 权限 / 交互 ============

export interface SessionPermissionAskedEventData {
  requestId: string
  runId?: string
  toolCallId?: string
  toolName?: string
}

export interface SessionPermissionAnsweredEventData {
  requestId: string
  runId?: string
  toolCallId?: string
  approved: boolean
  scope?: string
  reason?: string
}

export interface SessionInteractionAskedEventData {
  requestId: string
  runId?: string
  toolCallId?: string
  kind?: string
}

export interface SessionInteractionAnsweredEventData {
  requestId: string
  runId?: string
  toolCallId?: string
  /** 决定,不是正文:自由文本答复走 `answerText`,长答复走 blob(S1)。 */
  answer?: string
  cancelled?: boolean
}

// ============ 上下文 / 插件 ============

/** 取代 `ChatMessage.turnContext` 字段(§9.2)。 */
export interface SessionContextTurnUpdateEventData {
  /** 这次尾块挂在哪条(最新的)用户消息上。 */
  messageId: string
  set?: Record<string, string>
  removed?: string[]
}

export interface SessionPluginStatusEventData {
  pluginId: string
  id: string
  label: string
  cleared?: boolean
  runId?: string
  startedAt?: number
  durationMs?: number
}

// ============ 联合 ============

export type SessionRequestToolsEvent = SessionEventRecordShape<'request/tools', SessionRequestToolsEventData>
export type SessionRequestHeaderEvent = SessionEventRecordShape<'request/header', SessionRequestHeaderEventData>
export type SessionRequestStartEvent = SessionEventRecordShape<'request/start', SessionRequestStartEventData>
export type SessionAssistantFirstTokenEvent = SessionEventRecordShape<'assistant/first-token', SessionAssistantFirstTokenEventData>
export type SessionToolCallEvent = SessionEventRecordShape<'tool/call', SessionToolCallEventData>
export type SessionToolResultEvent = SessionEventRecordShape<'tool/result', SessionToolResultEventData>
export type SessionToolAuditEvent = SessionEventRecordShape<'tool/audit', SessionToolAuditEventData>
export type SessionRequestEndEvent = SessionEventRecordShape<'request/end', SessionRequestEndEventData>

export type SessionCreatedEvent = SessionEventRecordShape<'session/created', SessionCreatedEventData>
export type SessionAgentChangedEvent = SessionEventRecordShape<'session/agent-changed', SessionAgentChangedEventData>
export type SessionModelChangedEvent = SessionEventRecordShape<'session/model-changed', SessionModelChangedEventData>
export type SessionWorkdirChangedEvent = SessionEventRecordShape<'session/workdir-changed', SessionWorkdirChangedEventData>
export type SessionCompactedEvent = SessionEventRecordShape<'session/compacted', SessionCompactedEventData>
export type SessionClearedEvent = SessionEventRecordShape<'session/cleared', SessionClearedEventData>

export type SessionUserMessageEvent = SessionEventRecordShape<'user/message', SessionUserMessageEventData>
export type SessionSystemMessageEvent = SessionEventRecordShape<'system/message', SessionSystemMessageEventData>
export type SessionUserMessageEditedEvent = SessionEventRecordShape<'user/message-edited', SessionUserMessageEditedEventData>
export type SessionMessageDeletedEvent = SessionEventRecordShape<'message/deleted', SessionMessageDeletedEventData>
export type SessionMessagePatchedEvent = SessionEventRecordShape<'message/patched', SessionMessagePatchedEventData>
export type SessionMessageImportedEvent = SessionEventRecordShape<'message/imported', SessionMessageImportedEventData>

export type SessionRunStartEvent = SessionEventRecordShape<'run/start', SessionRunStartEventData>
export type SessionRunEndEvent = SessionEventRecordShape<'run/end', SessionRunEndEventData>

export type SessionRequestRecipeEvent = SessionEventRecordShape<'request/recipe', SessionRequestRecipeEventData>
export type SessionRequestResponseEvent = SessionEventRecordShape<'request/response', SessionRequestResponseEventData>
export type SessionRequestErrorEvent = SessionEventRecordShape<'request/error', SessionRequestErrorEventData>

export type SessionAssistantChunksEvent = SessionEventRecordShape<'assistant/chunks', SessionAssistantChunksEventData>
export type SessionAssistantPartEndEvent = SessionEventRecordShape<'assistant/part-end', SessionAssistantPartEndEventData>
export type SessionSkillActivatedEvent = SessionEventRecordShape<'skill/activated', SessionSkillActivatedEventData>

export type SessionPermissionAskedEvent = SessionEventRecordShape<'permission/asked', SessionPermissionAskedEventData>
export type SessionPermissionAnsweredEvent = SessionEventRecordShape<'permission/answered', SessionPermissionAnsweredEventData>
export type SessionInteractionAskedEvent = SessionEventRecordShape<'interaction/asked', SessionInteractionAskedEventData>
export type SessionInteractionAnsweredEvent = SessionEventRecordShape<'interaction/answered', SessionInteractionAnsweredEventData>

export type SessionContextTurnUpdateEvent = SessionEventRecordShape<'context/turn-update', SessionContextTurnUpdateEventData>
export type SessionPluginStatusEvent = SessionEventRecordShape<'plugin/status', SessionPluginStatusEventData>

/** E0 的七类 —— 盘上已有的文件只含这些,读侧永远要认得它们。 */
export type SessionLegacyEventRecord =
  | SessionRequestToolsEvent
  | SessionRequestHeaderEvent
  | SessionRequestStartEvent
  | SessionAssistantFirstTokenEvent
  | SessionToolCallEvent
  | SessionToolResultEvent
  | SessionToolAuditEvent
  | SessionRequestEndEvent

export type SessionLogEventRecord =
  | SessionLegacyEventRecord
  | SessionCreatedEvent
  | SessionAgentChangedEvent
  | SessionModelChangedEvent
  | SessionWorkdirChangedEvent
  | SessionCompactedEvent
  | SessionClearedEvent
  | SessionUserMessageEvent
  | SessionSystemMessageEvent
  | SessionUserMessageEditedEvent
  | SessionMessageDeletedEvent
  | SessionMessagePatchedEvent
  | SessionMessageImportedEvent
  | SessionRunStartEvent
  | SessionRunEndEvent
  | SessionRequestRecipeEvent
  | SessionRequestResponseEvent
  | SessionRequestErrorEvent
  | SessionAssistantChunksEvent
  | SessionAssistantPartEndEvent
  | SessionSkillActivatedEvent
  | SessionPermissionAskedEvent
  | SessionPermissionAnsweredEvent
  | SessionInteractionAskedEvent
  | SessionInteractionAnsweredEvent
  | SessionContextTurnUpdateEvent
  | SessionPluginStatusEvent

export type SessionLogEventType = SessionLogEventRecord['type']

export type SessionLogEventDataFor<TType extends SessionLogEventType> =
  Extract<SessionLogEventRecord, { type: TType }>['data']

/** 七类的 type 元组 —— 盘上老文件的全集,顺序即当年的定义顺序。 */
export const SESSION_LEGACY_EVENT_TYPES = [
  'request/tools',
  'request/header',
  'request/start',
  'assistant/first-token',
  'tool/call',
  'tool/result',
  'tool/audit',
  'request/end',
] as const satisfies readonly SessionLegacyEventRecord['type'][]

/**
 * v2 全集。**加一个类型 = 加一行 + 过下面的双向穷尽守卫**,
 * 与 `COLLAB_SCHEDULER_LOG_TABLE_IS_EXHAUSTIVE` 同一套纪律。
 */
export const SESSION_LOG_EVENT_TYPES = [
  ...SESSION_LEGACY_EVENT_TYPES,
  'session/created',
  'session/agent-changed',
  'session/model-changed',
  'session/workdir-changed',
  'session/compacted',
  'session/cleared',
  'user/message',
  'system/message',
  'user/message-edited',
  'message/deleted',
  'message/patched',
  'message/imported',
  'run/start',
  'run/end',
  'request/recipe',
  'request/response',
  'request/error',
  'assistant/chunks',
  'assistant/part-end',
  'skill/activated',
  'permission/asked',
  'permission/answered',
  'interaction/asked',
  'interaction/answered',
  'context/turn-update',
  'plugin/status',
] as const satisfies readonly SessionLogEventType[]

/** 双向穷尽守卫:表里少一个 → 红;表里多一个(打错字)→ 红。 */
type SessionEventTableMissing = Exclude<SessionLogEventType, (typeof SESSION_LOG_EVENT_TYPES)[number]>
type SessionEventTableStray = Exclude<(typeof SESSION_LOG_EVENT_TYPES)[number], SessionLogEventType>
export const SESSION_LOG_EVENT_TABLE_IS_EXHAUSTIVE: [SessionEventTableMissing] extends [never]
  ? [SessionEventTableStray] extends [never]
    ? true
    : never
  : never = true

// ============ 类型级门:正文只住在四个地方 ============

/**
 * **响应正文永远不进 surface 事件的 data**(§9.2 助手行的那句"不再存第二份文本")。
 *
 * 允许携带整条消息正文的只有四类:`user/message`、`system/message`、
 * `user/message-edited`、`message/imported` —— 它们记的是**人写的东西**,
 * 那本来就是一条完整消息。模型说的话只有一个来源:`assistant/chunks` 的 fold。
 *
 * 门的形状:在"surface 事件减去这四类"的联合上做分配式 `keyof`,与一张禁用
 * 字段名表求交。哪天有人往 `run/start` 上加 `content`、往 `request/response`
 * 上加回 `text`,这一行当场红 —— 而那种重复在测试里很难看见(账写得出来、
 * 读得回来,只是同一段话存了两份,§7.2 M2 的三处重复正是这么来的)。
 */
type SessionSurfaceEventRecord = Extract<
  SessionLogEventRecord,
  { type: 'user/message' | 'system/message' | 'user/message-edited' | 'message/imported'
    | 'message/deleted' | 'session/compacted' | 'session/cleared' | 'run/start' | 'tool/result' }
>
type SessionBodyBearingEventType =
  | 'user/message'
  | 'system/message'
  | 'user/message-edited'
  | 'message/imported'
type SessionBodylessSurfaceEvent = Exclude<
  SessionSurfaceEventRecord,
  { type: SessionBodyBearingEventType }
>
type SessionEventAllKeys<T> = T extends unknown ? keyof T : never
type SessionEventForbiddenBodyKey =
  | 'message'
  | 'messages'
  | 'content'
  | 'contentParts'
  | 'reasoning'
type SessionEventLeakedBodyKey = Extract<
  SessionEventAllKeys<SessionBodylessSurfaceEvent['data']>,
  SessionEventForbiddenBodyKey
>
export const SESSION_SURFACE_EVENTS_CARRY_NO_MESSAGE_BODY: [SessionEventLeakedBodyKey] extends [never]
  ? true
  : never = true

// ============ surface 分类表 ============

/**
 * 哪些类型会在 surface 上**成为一个节点**(模型可见历史里的一格)。
 *
 * `message/deleted` / `session/cleared` 带 replace op 但不是节点(纯遮蔽);
 * `tool/result` 是节点但**不单独物化**成一条历史消息 —— 它折进所属 run 的那条
 * assistant 消息里(今天 `buildHistoryMessages` 就是 assistant+tool 成对发的)。
 * 它在 surface 上占一格,是为了将来"工具结果剪枝"能用同一个 replace 机制表达。
 */
export const SESSION_SURFACE_NODE_TYPES = [
  'user/message',
  'system/message',
  'user/message-edited',
  'message/imported',
  'run/start',
  'tool/result',
  'session/compacted',
] as const

export type SessionSurfaceNodeType = (typeof SESSION_SURFACE_NODE_TYPES)[number]

export function isSessionSurfaceNodeType(type: string): type is SessionSurfaceNodeType {
  return (SESSION_SURFACE_NODE_TYPES as readonly string[]).includes(type)
}
