import { SESSION_COMMAND_TYPES } from '@shared/events/session-command-types.js'
import type { JsonObject } from '@shared/json.js'
import type { StreamChunkHandler, Unsubscribe } from '@onething/backend/runtime/events/types'
import type { StreamChunkBase } from '@shared/events/stream-chunks.js'

// `@onething/backend/runtime/gateway/conversation-runtime` 是网关看得见的**唯一**一扇 core 门(boundary
// 里 `GATEWAY_CORE_DEPENDENCY_FORBIDDEN_PATTERNS` 把别的子路径全焊死了)。
// 网关真正要用的 core 零件不止协议类型 —— 取消订阅句柄、共享斜杠命令表、日志
// 内核 —— 所以在这里把它们再导出一遍:门还是一扇,门后的东西由 core 决定。
export type { Unsubscribe } from '@onething/backend/runtime/events/types'
export { ConsoleSink, LoggerRoot } from '@onething/backend/runtime/logging/logger-primitives'
export type { LogRecord, Logger } from '@onething/backend/runtime/logging/logger-primitives'
// 引用标签的编解码器(IM 渠道上没有可点的东西,`<ref/>` 必须在出站前投影成文字,
// `docs/design/reference-tag-2026-09.md` §2.8)与斜杠命令表从前也经这里再导出;
// 2026-10 它们搬进了 shared(两边共用的纯逻辑),网关直接从 `@shared/references`、
// `@shared/slash-commands` 取。

export interface CoreTextStreamChunk extends StreamChunkBase {
  type: 'text-delta'
  text: string
  turnIndex?: number
  voiceSpeakText?: string
}

export interface CoreStreamChannelLike<TChunk extends StreamChunkBase = StreamChunkBase> {
  subscribe(sessionId: string, handler: StreamChunkHandler<TChunk>): Unsubscribe
}

export interface CoreSendMessageOptions {
  sessionId: string
  content: string
  channel?: string
  source?: string
  attachments?: JsonObject[]
  origin?: unknown
}

export type CorePermissionDecision = 'once' | 'session' | 'workdir' | 'reject'
export type CorePermissionMode = 'normal' | 'auto-accept-edits' | 'dangerously-allow-all'

export interface CorePermissionRequestEvent {
  sessionId: string
  requestId: string
  targetChannel: string
  permissionType: string
  title: string
  toolCallId?: string
  pattern?: string | string[]
  metadata: JsonObject
  userId?: string
  workspaceId?: string
  timeoutMs?: number
}

export interface CorePermissionSurface {
  onPermissionRequest(
    sessionId: string,
    handler: (req: CorePermissionRequestEvent) => void,
  ): Unsubscribe
  respondPermission(input: {
    sessionId: string
    requestId: string
    channel: string
    decision: CorePermissionDecision
    rejectReason?: string
  }): Promise<void>
  setSessionPermissionMode(sessionId: string, mode: CorePermissionMode): void
}

export interface CoreConversationEventEnvelopeLike {
  event: {
    type: string
    [key: string]: unknown
  }
}

export interface CoreConversationEventBusLike {
  onAny(
    sessionId: string,
    handler: (envelope: CoreConversationEventEnvelopeLike) => void,
    label?: string,
  ): Unsubscribe
  emit(sessionId: string, event: { type: string; [key: string]: unknown }): Promise<unknown>
}

export interface CoreConversationSendMessageCommand {
  type: typeof SESSION_COMMAND_TYPES.SEND_MESSAGE
  channel?: string
  content: string
  source?: string
  attachments?: JsonObject[]
  origin?: unknown
}

export interface CoreSessionRuntime {
  ensureSession(sessionId: string): void
  destroySession(sessionId: string): void
  setSessionPermissionMode?(sessionId: string, mode: CorePermissionMode): void
}

export interface CoreConversationRuntime<TChunk extends StreamChunkBase = StreamChunkBase>
  extends CoreSessionRuntime {
  readonly streamChannel: CoreStreamChannelLike<TChunk>
  readonly permissions?: CorePermissionSurface
  sendMessage(options: CoreSendMessageOptions): Promise<void>
}

export interface CoreConversationEngineLike<TSender = unknown> {
  handleSendMessage(
    sessionId: string,
    command: CoreConversationSendMessageCommand,
    sender: TSender,
  ): Promise<void>
}

export interface CoreConversationRuntimeFactoryOptions<
  TChunk extends StreamChunkBase = StreamChunkBase,
  TSender = unknown,
> {
  engine: CoreConversationEngineLike<TSender>
  streamChannel: CoreStreamChannelLike<TChunk>
  sender?: TSender
  sessionRuntime?: CoreSessionRuntime
  eventBus?: Partial<CoreConversationEventBusLike>
}

export function isCoreTextStreamChunk(chunk: unknown): chunk is CoreTextStreamChunk {
  if (!chunk || typeof chunk !== 'object') return false
  const candidate = chunk as Partial<CoreTextStreamChunk>
  return candidate.type === 'text-delta' && typeof candidate.text === 'string'
}

export function isCoreConversationRuntime(value: unknown): value is CoreConversationRuntime {
  if (!value || typeof value !== 'object') return false
  const runtime = value as Partial<CoreConversationRuntime>
  const streamChannel = runtime.streamChannel as Partial<CoreStreamChannelLike> | undefined
  return typeof runtime.ensureSession === 'function'
    && typeof runtime.destroySession === 'function'
    && typeof runtime.sendMessage === 'function'
    && streamChannel !== undefined
    && typeof streamChannel.subscribe === 'function'
}
