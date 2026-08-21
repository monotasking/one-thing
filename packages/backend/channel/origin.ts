import type {
  ChannelActor,
  ChannelConversation,
  MessageOrigin,
  OriginTransport,
  ResolvedIdentity,
} from '@shared/ipc.js'

export const LOCAL_CLIENT_USER_ID = 'local-owner'

export function createLocalClientIdentity(displayName = 'Local user'): ResolvedIdentity {
  return {
    kind: 'client-user',
    userId: LOCAL_CLIENT_USER_ID,
    profileId: LOCAL_CLIENT_USER_ID,
    displayName,
    linkedClientUserId: LOCAL_CLIENT_USER_ID,
  }
}

export function createDesktopOrigin(input: {
  source?: string
  receivedAt?: number
  displayName?: string
} = {}): MessageOrigin {
  return {
    transport: 'desktop',
    source: input.source || 'text',
    receivedAt: input.receivedAt ?? Date.now(),
    resolvedIdentity: createLocalClientIdentity(input.displayName),
  }
}

export function createVoiceOrigin(input: {
  receivedAt?: number
  displayName?: string
} = {}): MessageOrigin {
  return {
    transport: 'voice',
    source: 'voice',
    receivedAt: input.receivedAt ?? Date.now(),
    resolvedIdentity: createLocalClientIdentity(input.displayName),
  }
}

export function createApiOrigin(input: {
  actor?: ChannelActor
  conversation?: ChannelConversation
  receivedAt?: number
} = {}): MessageOrigin {
  return {
    transport: 'api',
    source: 'api',
    actor: input.actor,
    conversation: input.conversation,
    receivedAt: input.receivedAt ?? Date.now(),
  }
}

export function cloneOrigin(origin: MessageOrigin | undefined): MessageOrigin | undefined {
  return origin ? JSON.parse(JSON.stringify(origin)) as MessageOrigin : undefined
}

export function sanitizeRendererOrigin(command: Record<string, unknown>): MessageOrigin {
  const source = typeof command.source === 'string' ? command.source : undefined
  const transport: OriginTransport = source === 'voice' ? 'voice' : 'desktop'
  return transport === 'voice'
    ? createVoiceOrigin()
    : createDesktopOrigin({ source })
}

/**
 * Message sources stamped by system-internal re-drives (goal kicks /
 * continuations). This set is THE single definition of "system-internal":
 * the stream engine's router bypass and every counterpart-identity scan key
 * off it. When a new internal emitter appears (scheduler re-drive, ...),
 * adding its source here updates all of them at once.
 *
 * Plugin pushes (N1) belong to the same class but form a PREFIX family rather
 * than members — one source per plugin id — so they are matched in
 * `isSystemInternalSource`, not listed here.
 */
export const SYSTEM_INTERNAL_MESSAGE_SOURCES: ReadonlySet<string> = new Set([
  'goal',
  // The radio conductor's DJ wake: a curation turn driven into the dedicated
  // radio session when the programme runs low.
  'radio',
  // Room-coordinator activation drives (multi-agent collab). These carry no
  // human counterpart; routing them would remap the room session and corrupt
  // memory attribution (docs/design/multi-agent-collab.md D8).
  'collab',
])

/**
 * 插件注入消息的 source 前缀:`plugin:<pluginId>`(N1)。
 *
 * 它是一个**前缀族**而不是集合里的一个成员,因为 id 是运行期的:每个插件一个
 * source。归属仍然是 SYSTEM_INTERNAL 那一类 —— 插件推送背后没有渠道身份,
 * 让路由去给它解析一个匿名身份的后果与 goal/radio 一模一样(命令被改派到身份
 * 会话、会话的 memory-profile 元数据被覆写)。
 */
export const PLUGIN_MESSAGE_SOURCE_PREFIX = 'plugin:'

export function pluginMessageSource(pluginId: string): string {
  return `${PLUGIN_MESSAGE_SOURCE_PREFIX}${pluginId}`
}

/**
 * 派工完成回投的 source 前缀:`task:<taskSessionId>`
 * (`docs/audit/self-hosting-gap-audit-2026-08-11.md` P0-5)。
 *
 * 与插件同为**前缀族**、同为 SYSTEM_INTERNAL:报告背后没有渠道身份,让路由去给它
 * 解析一个匿名身份的后果与 goal / radio / plugin 一模一样(命令被改派到身份会话、
 * 会话的 memory-profile 元数据被覆写)。一条派工回来的报告必须落在**派它出去的那条
 * 会话**上,这是它存在的全部理由。
 */
export const TASK_MESSAGE_SOURCE_PREFIX = 'task:'

export function taskMessageSource(taskSessionId: string): string {
  return `${TASK_MESSAGE_SOURCE_PREFIX}${taskSessionId}`
}

export function isSystemInternalSource(source: string | undefined): boolean {
  if (source === undefined) return false
  return SYSTEM_INTERNAL_MESSAGE_SOURCES.has(source)
    || source.startsWith(PLUGIN_MESSAGE_SOURCE_PREFIX)
    || source.startsWith(TASK_MESSAGE_SOURCE_PREFIX)
}

/**
 * System-internal injections persist an origin so the renderer can fold
 * them and routing can bypass identity resolution, but they carry no
 * conversation counterpart. Scans that answer "who is the model talking to"
 * must skip them — otherwise a goal-driven run shadows the real user's
 * origin: the prompt context would tell the model it is talking to an
 * unknown API user instead of its owner, permission enforcement would lose
 * its user scope, and memory attribution would lose display metadata.
 */
export function isSystemInternalOrigin(origin: MessageOrigin): boolean {
  return isSystemInternalSource(origin.source)
}

/**
 * Newest origin that represents a real conversation counterpart, scanning
 * backwards past system-internal injections. `role` narrows the scan (e.g.
 * 'user' for memory attribution).
 */
export function latestRealOrigin(
  messages: ReadonlyArray<{ role?: string; origin?: MessageOrigin }>,
  options: { role?: string } = {},
): MessageOrigin | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message?.origin) continue
    if (options.role !== undefined && message.role !== options.role) continue
    if (isSystemInternalOrigin(message.origin)) continue
    return message.origin
  }
  return undefined
}

export function identitySessionKey(origin: MessageOrigin): string | undefined {
  const identity = origin.resolvedIdentity
  if (!identity) return undefined
  if (origin.transport === 'desktop' || origin.transport === 'voice') return undefined

  const connector = origin.conversation?.connector || origin.replyTarget?.connector || origin.transport
  const workspaceId = origin.conversation?.workspaceId || origin.replyTarget?.workspaceId || 'default'
  return `identity:${origin.transport}:${connector}:${workspaceId}:${identity.userId}`
}

export function originDisplayName(origin: MessageOrigin): string {
  return origin.resolvedIdentity?.displayName
    || origin.actor?.displayName
    || origin.actor?.handle
    || origin.actor?.externalUserId
    || origin.resolvedIdentity?.userId
    || 'Unknown user'
}

export function originConnector(origin: MessageOrigin): string | undefined {
  return origin.conversation?.connector || origin.replyTarget?.connector
}

export function originWorkspaceId(origin: MessageOrigin): string | undefined {
  return origin.conversation?.workspaceId || origin.replyTarget?.workspaceId
}
