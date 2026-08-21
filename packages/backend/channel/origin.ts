import type {
  ChannelActor,
  ChannelConversation,
  MessageOrigin,
  OriginTransport,
  ResolvedIdentity,
} from '@shared/ipc.js'

import { isSystemInternalSource } from '@onething/runtime/engine/message-sources'

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
 * 「什么是 system-internal」的定义住在产品层(`runtime/src/engine/message-sources.ts`,
 * P3'e-A2a):引擎本体归位之后,路由旁路与 principal 铸造两处判据都在那边,而判据
 * 本身零依赖。这里原样再导出,所以 `channel/origin.js` 仍是装配层读它的那个门。
 */
export {
  SYSTEM_INTERNAL_MESSAGE_SOURCES,
  PLUGIN_MESSAGE_SOURCE_PREFIX,
  pluginMessageSource,
  TASK_MESSAGE_SOURCE_PREFIX,
  taskMessageSource,
  isSystemInternalSource,
} from '@onething/runtime/engine/message-sources'

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
