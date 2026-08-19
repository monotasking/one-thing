import type { ChatMessage, ChannelReplyDeliveryRecord, MessageOrigin } from '@shared/ipc.js'
import type { EventBus } from '../events/event-bus.js'
import { getChannelIdentityStore } from './identity-store.js'
import { sendIMReply } from './connector-registry.js'
import { writeAppLog } from '../logging/index.js'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'

function isFinalAssistantMessage(message: ChatMessage): boolean {
  return message.role === 'assistant' && message.isStreaming !== true && Boolean(message.content?.trim())
}

function imOrigin(origin: MessageOrigin | undefined): MessageOrigin | undefined {
  if (origin?.source === 'gateway') return undefined
  return origin?.transport === 'im' && origin.replyTarget ? origin : undefined
}

function deliveryRecord(input: {
  message: ChatMessage
  sessionId: string
  origin: MessageOrigin
  status: ChannelReplyDeliveryRecord['status']
  error?: string
}): ChannelReplyDeliveryRecord {
  const now = Date.now()
  return {
    assistantMessageId: input.message.id,
    sessionId: input.sessionId,
    connector: input.origin.replyTarget!.connector,
    replyTarget: input.origin.replyTarget!,
    status: input.status,
    error: input.error,
    createdAt: now,
    updatedAt: now,
  }
}

export class OutboundReplyDispatcher {
  private unsubscribe: (() => void) | null = null
  private inFlight = new Set<string>()

  start(eventBus: EventBus): void {
    if (this.unsubscribe) return

    this.unsubscribe = eventBus.onAnySession(SESSION_EVENT_TYPES.MESSAGE_UPDATED, envelope => {
      const event = envelope.event as {
        type?: string
        messageId?: string
        updates?: Partial<ChatMessage>
      }
      if (event.updates?.isStreaming !== false) return
      this.dispatchFromSession(envelope.sessionId, event.messageId).catch(error => {
        console.error('[OutboundReplyDispatcher] dispatch failed:', error)
      })
    }, 'OutboundReplyDispatcher')
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.inFlight.clear()
  }

  async dispatchMessage(sessionId: string, message: ChatMessage): Promise<void> {
    if (!isFinalAssistantMessage(message)) return
    const origin = imOrigin(message.origin)
    if (!origin) return

    const store = getChannelIdentityStore()
    if (store.getDelivery(message.id)?.status === 'sent') return
    if (this.inFlight.has(message.id)) return

    this.inFlight.add(message.id)
    try {
      await sendIMReply(origin.replyTarget!, {
        text: message.content,
        sessionId,
        messageId: message.id,
      })
      store.upsertDelivery(deliveryRecord({ message, sessionId, origin, status: 'sent' }))
      writeAppLog('info', 'channel.reply', 'IM reply delivered', {
        sessionId,
        assistantMessageId: message.id,
        connector: origin.replyTarget!.connector,
      })
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      store.upsertDelivery(deliveryRecord({ message, sessionId, origin, status: 'failed', error: messageText }))
      writeAppLog('warn', 'channel.reply', 'IM reply delivery failed', {
        sessionId,
        assistantMessageId: message.id,
        connector: origin.replyTarget!.connector,
        error: messageText,
      })
    } finally {
      this.inFlight.delete(message.id)
    }
  }

  private async dispatchFromSession(sessionId: string, messageId?: string): Promise<void> {
    if (!messageId) return
    const { sessionReads } = await import('../session/reads.js')
    const message = sessionReads.getMessage(sessionId, messageId)
    if (!message) return
    await this.dispatchMessage(sessionId, message)
  }
}

let singleton: OutboundReplyDispatcher | null = null

export function getOutboundReplyDispatcher(): OutboundReplyDispatcher {
  if (!singleton) singleton = new OutboundReplyDispatcher()
  return singleton
}
