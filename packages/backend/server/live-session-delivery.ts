import type { AgentEngineSessionEvent, AgentEngineStreamChunk, EventBus } from '@onething/core'
import type {
  RuntimeEventsAdapter, RuntimeRequestContext, RuntimeStreamsAdapter,
  RuntimeStreamPayload, RuntimeUnsubscribe,
} from '@onething/core/runtime-facade'
import { canReceiveSessionRemoval } from '../session/removal-event.js'
import type { SessionAudience, SessionAudienceFactory } from './audience.js'

export interface ServerLiveSessionDeliveryPorts {
  eventBus: Pick<EventBus<AgentEngineSessionEvent>, 'replay' | 'onAny' | 'onAnySessionAny'>
  streamChannel: {
    subscribe(sessionId: string, handler: (chunk: AgentEngineStreamChunk) => void): RuntimeUnsubscribe
    subscribeAny(handler: (payload: RuntimeStreamPayload<AgentEngineStreamChunk>) => void): RuntimeUnsubscribe
  }
  audienceFactory: SessionAudienceFactory
  defaultContext(): RuntimeRequestContext
}

/** Live notifications share authorization and lifetime; recovery is the ledger's `?after=` replay. */
export function createServerLiveSessionDelivery(ports: ServerLiveSessionDeliveryPorts) {
  const subscriptions = new Set<RuntimeUnsubscribe>()
  let disposed = false
  function own(audience: SessionAudience, attach: () => RuntimeUnsubscribe): RuntimeUnsubscribe {
    if (disposed) { audience.dispose(); return () => {} }
    let off: RuntimeUnsubscribe
    try { off = attach() } catch (error) { audience.dispose(); throw error }
    if (disposed) { try { off() } finally { audience.dispose() }; return () => {} }
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      subscriptions.delete(close)
      try { off() } finally { audience.dispose() }
    }
    subscriptions.add(close)
    return close
  }
  const events: RuntimeEventsAdapter<AgentEngineSessionEvent> = {
    subscribe(sessionId, handler, options, context = ports.defaultContext()) {
      if (disposed) return () => {}
      const audience = ports.audienceFactory(context)
      if (sessionId !== '*' && !audience.covers(sessionId)) { audience.dispose(); return () => {} }
      return own(audience, () => {
        const deliver = (envelope: Parameters<typeof handler>[0]) => {
          if (canReceiveSessionRemoval(context, envelope.sessionId, envelope.event) ?? audience.covers(envelope.sessionId)) handler(envelope)
        }
        if (sessionId === '*') return ports.eventBus.onAnySessionAny(deliver, 'ServerRuntimeEvents')
        if (options?.afterSeq !== undefined) {
          for (const envelope of ports.eventBus.replay(sessionId, options.afterSeq + 1)) deliver(envelope)
        }
        return ports.eventBus.onAny(sessionId, deliver, 'ServerRuntimeEvents')
      })
    },
  }
  const streams: RuntimeStreamsAdapter<AgentEngineStreamChunk> = {
    subscribe(sessionId, handler, _options, context = ports.defaultContext()) {
      if (disposed) return () => {}
      const audience = ports.audienceFactory(context)
      if (sessionId !== '*' && !audience.covers(sessionId)) { audience.dispose(); return () => {} }
      return own(audience, () => {
        if (sessionId === '*') return ports.streamChannel.subscribeAny(payload => {
          if (audience.covers(payload.sessionId)) handler(payload)
        })
        return ports.streamChannel.subscribe(sessionId, chunk => {
          if (audience.covers(sessionId)) handler({ sessionId, chunk })
        })
      })
    },
  }
  return {
    events, streams,
    dispose(): void {
      if (disposed) return
      disposed = true
      const failures: unknown[] = []
      for (const close of subscriptions) { try { close() } catch (error) { failures.push(error) } }
      if (failures.length) throw new AggregateError(failures, 'Session delivery cleanup failed')
    },
  }
}
