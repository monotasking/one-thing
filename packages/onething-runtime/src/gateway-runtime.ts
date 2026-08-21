import type { StreamChunkBase } from '@onething/core/events'
import type {
  CoreConversationEventBusLike,
  CoreConversationEventEnvelopeLike,
  CoreConversationRuntime,
  CoreConversationRuntimeFactoryOptions,
  CorePermissionRequestEvent,
  CorePermissionSurface,
  CoreSessionRuntime,
} from '@onething/core/gateway-runtime'
export {
  isCoreConversationRuntime as isOnethingConversationRuntime,
  isCoreTextStreamChunk as isOnethingTextStreamChunk,
} from '@onething/core/gateway-runtime'
export type {
  CoreConversationRuntime as OnethingConversationRuntime,
  CorePermissionDecision as OnethingPermissionDecision,
  CorePermissionMode as OnethingPermissionMode,
  CorePermissionRequestEvent as OnethingPermissionRequestEvent,
  CorePermissionSurface as OnethingPermissionSurface,
  CoreSendMessageOptions as OnethingSendMessageOptions,
  CoreSessionRuntime as OnethingSessionRuntime,
  CoreStreamChannelLike as OnethingStreamChannelLike,
  CoreTextStreamChunk as OnethingTextStreamChunk,
} from '@onething/core/gateway-runtime'
import {
  NoopOnethingStreamSender,
  type OnethingStreamSender,
} from './stream-sender.js'

import { SESSION_EVENT_TYPES, SESSION_COMMAND_TYPES } from '@shared/events/index.js'

export type OnethingConversationRuntimeFromStreamEngineOptions<TChunk extends StreamChunkBase = StreamChunkBase> =
  CoreConversationRuntimeFactoryOptions<TChunk, OnethingStreamSender>

export function createOnethingConversationRuntimeFromStreamEngine<TChunk extends StreamChunkBase = StreamChunkBase>(
  options: OnethingConversationRuntimeFromStreamEngineOptions<TChunk>,
): CoreConversationRuntime<TChunk> {
  const sender = options.sender ?? new NoopOnethingStreamSender()
  const sessionRuntime = options.sessionRuntime ?? {
    ensureSession() {},
    destroySession() {},
  }
  const permissions = createPermissionSurface(options.eventBus, sessionRuntime)

  return {
    streamChannel: options.streamChannel,
    permissions,
    ensureSession(sessionId) {
      sessionRuntime.ensureSession(sessionId)
    },
    destroySession(sessionId) {
      sessionRuntime.destroySession(sessionId)
    },
    async sendMessage(message) {
      sessionRuntime.ensureSession(message.sessionId)
      await options.engine.handleSendMessage(
        message.sessionId,
        {
          type: SESSION_COMMAND_TYPES.SEND_MESSAGE,
          channel: message.channel,
          content: message.content,
          source: message.source,
          attachments: message.attachments,
          origin: message.origin,
        },
        sender,
      )
    },
  }
}

function createPermissionSurface(
  eventBus: Partial<CoreConversationEventBusLike> | undefined,
  sessionRuntime: CoreSessionRuntime,
): CorePermissionSurface | undefined {
  if (!isPermissionEventBus(eventBus)) return undefined

  return {
    onPermissionRequest(sessionId, handler) {
      return eventBus.onAny(sessionId, (envelope) => {
        const request = permissionRequestFromEvent(sessionId, envelope.event)
        if (!request) return
        handler(request)
      }, 'GatewayPermissions')
    },
    async respondPermission(input) {
      await eventBus.emit(input.sessionId, {
        type: SESSION_COMMAND_TYPES.PERMISSION_RESPOND,
        channel: input.channel,
        requestId: input.requestId,
        decision: input.decision,
        rejectReason: input.rejectReason,
      })
    },
    setSessionPermissionMode(sessionId, mode) {
      sessionRuntime.setSessionPermissionMode?.(sessionId, mode)
    },
  }
}

function isPermissionEventBus(
  eventBus: Partial<CoreConversationEventBusLike> | undefined,
): eventBus is CoreConversationEventBusLike {
  return !!eventBus
    && typeof eventBus.onAny === 'function'
    && typeof eventBus.emit === 'function'
}

function permissionRequestFromEvent(
  sessionId: string,
  event: CoreConversationEventEnvelopeLike['event'],
): CorePermissionRequestEvent | null {
  if (event.type !== SESSION_EVENT_TYPES.PERMISSION_REQUEST) return null
  if (typeof event.requestId !== 'string') return null
  if (typeof event.targetChannel !== 'string') return null
  if (typeof event.permissionType !== 'string') return null
  if (typeof event.title !== 'string') return null

  return {
    sessionId,
    requestId: event.requestId,
    targetChannel: event.targetChannel,
    permissionType: event.permissionType,
    title: event.title,
    toolCallId: typeof event.toolCallId === 'string' ? event.toolCallId : undefined,
    pattern: toPattern(event.pattern),
    metadata: toJsonObject(event.metadata),
    userId: typeof event.userId === 'string' ? event.userId : undefined,
    workspaceId: typeof event.workspaceId === 'string' ? event.workspaceId : undefined,
    timeoutMs: typeof event.timeoutMs === 'number' ? event.timeoutMs : undefined,
  }
}

function toPattern(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value
  return undefined
}

function toJsonObject(value: unknown): CorePermissionRequestEvent['metadata'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as CorePermissionRequestEvent['metadata']
}
