import type { ChatMessage, ChannelReplyDeliveryRecord, MessageOrigin } from '@shared/ipc.js'
import type { EventBus } from '../events/event-bus.js'
import { getOnethingStorePath } from '@onething/runtime/storage'
import { createChannelReplyDeliveryStore } from './identity-store.js'
import { sendIMReply } from './connector-registry.js'
import { writeAppLog } from '../wiring/logging/index.js'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('channel.outbound')


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

interface DispatchOwner {
  store: ReturnType<typeof createChannelReplyDeliveryStore>
  pending: Set<Promise<void>>
  inFlight: Set<string>
  failures: unknown[]
  accepting: boolean
  unsubscribe: () => void
  closing?: Promise<void>
}

export class OutboundReplyDispatcher {
  private owner: DispatchOwner | undefined

  start(eventBus: EventBus): void {
    if (this.owner?.accepting) return
    if (this.owner) throw new Error('Outbound replies are still draining')
    const owner: DispatchOwner = {
      store: createChannelReplyDeliveryStore(getOnethingStorePath()),
      pending: new Set(), inFlight: new Set(), failures: [], accepting: true,
      unsubscribe: () => {},
    }
    owner.unsubscribe = eventBus.onAnySession(SESSION_EVENT_TYPES.MESSAGE_UPDATED, envelope => {
      const event = envelope.event as {
        type?: string
        messageId?: string
        updates?: Partial<ChatMessage>
      }
      if (event.updates?.isStreaming !== false) return
      if (!owner.accepting) return
      this.track(owner, () => this.dispatchFromSession(owner, envelope.sessionId, event.messageId)).catch(error => {
        log.error('outbound reply dispatch failed', { sessionId: envelope.sessionId }, error)
      })
    }, 'OutboundReplyDispatcher')
    this.owner = owner
  }

  quiesce(): void {
    const owner = this.owner
    if (!owner?.accepting) return
    owner.accepting = false
    owner.unsubscribe()
  }

  drain(): Promise<void> {
    this.quiesce()
    const owner = this.owner
    if (!owner) return Promise.resolve()
    if (owner.closing) return owner.closing
    owner.closing = (async () => {
      await Promise.allSettled([...owner.pending])
      if (owner.failures.length) throw new AggregateError(owner.failures, 'Outbound reply receipts could not be persisted')
      owner.inFlight.clear()
      if (this.owner === owner) this.owner = undefined
    })()
    return owner.closing
  }

  stop(): Promise<void> { return this.drain() }

  dispatchMessage(sessionId: string, message: ChatMessage): Promise<void> {
    const owner = this.owner
    if (!owner?.accepting) return Promise.reject(new Error('Outbound replies are not accepting work'))
    return this.track(owner, () => this.deliver(owner, sessionId, message))
  }

  private track(owner: DispatchOwner, run: () => Promise<void>): Promise<void> {
    const work = run()
    owner.pending.add(work)
    void work.then(
      () => { owner.pending.delete(work) },
      error => { owner.pending.delete(work); owner.failures.push(error) },
    )
    return work
  }

  private async deliver(owner: DispatchOwner, sessionId: string, message: ChatMessage): Promise<void> {
    if (!isFinalAssistantMessage(message)) return
    const origin = imOrigin(message.origin)
    if (!origin) return

    const store = owner.store
    if (store.getDelivery(message.id)?.status === 'sent') return
    if (owner.inFlight.has(message.id)) return

    owner.inFlight.add(message.id)
    try {
      let failure: { error: string } | undefined
      try {
        await sendIMReply(origin.replyTarget!, {
          text: message.content,
          sessionId,
          messageId: message.id,
        })
      } catch (error) {
        failure = { error: error instanceof Error ? error.message : String(error) }
      }
      // A receipt failure must reach the owner; it must not turn a successful
      // external send into a retryable failed-send receipt.
      store.upsertDelivery(deliveryRecord({ message, sessionId, origin, status: failure ? 'failed' : 'sent', ...failure }))
      writeAppLog(failure ? 'warn' : 'info', 'channel.reply', failure ? 'IM reply delivery failed' : 'IM reply delivered', {
        sessionId,
        assistantMessageId: message.id,
        connector: origin.replyTarget!.connector,
        ...failure,
      })
    } finally {
      owner.inFlight.delete(message.id)
    }
  }

  private async dispatchFromSession(owner: DispatchOwner, sessionId: string, messageId?: string): Promise<void> {
    if (!messageId) return
    const { sessionReads } = await import('../session/reads.js')
    const message = sessionReads.getMessage(sessionId, messageId)
    if (!message) return
    await this.deliver(owner, sessionId, message)
  }
}

let singleton: OutboundReplyDispatcher | null = null

export function getOutboundReplyDispatcher(): OutboundReplyDispatcher {
  if (!singleton) singleton = new OutboundReplyDispatcher()
  return singleton
}
