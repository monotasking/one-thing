// 会话详情投影(从 `session-store-helpers.ts` 拆出,拆分批 1,D226):详情快照怎么从缓存与元数据合出来,
// 以及详情与装载共用的「带编号的消息 / 带步骤的消息 / 带消息列表的会话」这一家形状
// (`CoreSessionMessageWithId` 等;它们不并进 `session-message-shapes.ts`,那只在 `session:gate` 的名单上)。
import type { CoreSessionMessage, CoreSessionMeta } from './session-meta.js'
import { hasSessionUsageDetails } from './session-usage-fold.js'

export interface CoreSessionMessageWithId {
  id: string
}

export interface CoreSessionWithMessages<TMessage extends CoreSessionMessageWithId = CoreSessionMessageWithId> {
  messages: TMessage[]
}

export interface CoreSessionStepWithId {
  id: string
  title?: string
  status?: string
  toolCallId?: string
  turnIndex?: number
  usage?: unknown
}

export interface CoreSessionMessageWithSteps<TStep extends CoreSessionStepWithId = CoreSessionStepWithId>
  extends CoreSessionMessageWithId {
  steps?: TStep[]
}

export interface CoreSessionDetails extends CoreSessionMeta {
  workingDirectory?: string
  workingDirectoryRoots?: string[]
  variables?: unknown[]
  summary?: string
  summaryUpToMessageId?: string
  summaryCreatedAt?: number
  promptContext?: unknown | null
  totalInputTokens?: number
  totalOutputTokens?: number
  totalTokens?: number
  lastInputTokens?: number
  contextSize?: number
}

export interface CoreSessionDetailsWithMessages<TMessage = unknown> extends CoreSessionDetails {
  messages: TMessage[]
}

export interface ResolveSessionDetailsSnapshotOptions<
  TSession extends CoreSessionDetailsWithMessages = CoreSessionDetailsWithMessages,
> extends SessionDetailsMergeOptions {
  meta?: CoreSessionMeta
  sqliteDetails?: CoreSessionMeta | CoreSessionDetails
  getSession?: () => TSession | undefined
}

export interface CoreSessionMessageWithModelInfo extends CoreSessionMessageWithId {
  role: string
  provider?: string
  model?: string
}

export interface CoreSessionWithMessageList<TMessage extends CoreSessionMessageWithModelInfo = CoreSessionMessageWithModelInfo> {
  id?: string
  messages: TMessage[]
  updatedAt: number
  lastProvider?: string
  lastModel?: string
  totalInputTokens?: number
  totalOutputTokens?: number
  totalTokens?: number
  lastInputTokens?: number
  contextSize?: number
  summary?: string
  summaryUpToMessageId?: string
  summaryCreatedAt?: number
}

export interface CoreSession<TMessage extends CoreSessionMessage = CoreSessionMessage>
  extends CoreSessionDetails {
  messages: TMessage[]
}

export interface SessionDetailsMergeOptions {
  defaultAgentId?: string
}

export function mergeSessionDetails(
  meta: CoreSessionMeta | undefined,
  details: CoreSessionMeta | CoreSessionDetails,
  options: SessionDetailsMergeOptions = {},
): CoreSessionDetails {
  const messageCount =
    details.messageCount && details.messageCount > 0
      ? details.messageCount
      : meta?.messageCount ?? details.messageCount ?? 0

  return {
    ...meta,
    ...details,
    agentId: details.agentId || meta?.agentId || options.defaultAgentId,
    messageCount,
    totalInputTokens: (details as CoreSessionDetails).totalInputTokens ?? 0,
    totalOutputTokens: (details as CoreSessionDetails).totalOutputTokens ?? 0,
    totalTokens: (details as CoreSessionDetails).totalTokens ?? 0,
    lastInputTokens: (details as CoreSessionDetails).lastInputTokens ?? 0,
    contextSize: (details as CoreSessionDetails).contextSize ?? 0,
  }
}

export function resolveSessionDetailsSnapshot<
  TSession extends CoreSessionDetailsWithMessages = CoreSessionDetailsWithMessages,
>(
  options: ResolveSessionDetailsSnapshotOptions<TSession>,
): CoreSessionDetails | undefined {
  const { meta, sqliteDetails, getSession, ...mergeOptions } = options

  if (sqliteDetails && hasSessionUsageDetails(sqliteDetails as CoreSessionDetails)) {
    return mergeSessionDetails(meta, sqliteDetails, mergeOptions)
  }

  const session = getSession?.()
  if (session) {
    const { messages, ...details } = session
    return mergeSessionDetails(meta, {
      ...details,
      messageCount: messages.length,
    }, mergeOptions)
  }

  if (sqliteDetails) {
    return mergeSessionDetails(meta, sqliteDetails, mergeOptions)
  }

  if (meta) {
    return mergeSessionDetails(undefined, meta, mergeOptions)
  }

  return undefined
}
