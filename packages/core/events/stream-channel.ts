/**
 * Stream Channel
 *
 * High-frequency chunk delivery for text-delta, reasoning-delta, and
 * tool-input-delta. These chunks are too voluminous for the EventBus
 * ring buffer (hundreds per second), so they get their own lightweight
 * pub/sub channel.
 *
 * Design:
 * - Subscribers are scoped to a sessionId
 * - push() fans out synchronously (no async overhead)
 * - destroySession() cleans up all subscribers for a session
 * - No persistence, no replay — chunks are ephemeral
 */

import type { StreamChunkBase, StreamChunkHandler, Unsubscribe } from './types.js'
import { getCoreLogger } from '../logging/index.js'

const log = getCoreLogger('core.events')


export interface StreamChannelPayload<TChunk> {
  sessionId: string
  chunk: TChunk
}

export type StreamChannelPayloadHandler<TChunk> = (
  payload: StreamChannelPayload<TChunk>,
) => void

export class StreamChannel<TChunk extends StreamChunkBase = StreamChunkBase> {
  private subscribers = new Map<string, Set<StreamChunkHandler<TChunk>>>()
  private wildcardSubscribers = new Set<StreamChannelPayloadHandler<TChunk>>()

  /**
   * Push a chunk to all subscribers of a session.
   * Synchronous fan-out — handlers should be fast.
   */
  push(sessionId: string, chunk: TChunk): void {
    const handlers = this.subscribers.get(sessionId)
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(chunk)
        } catch (err) {
          log.error('handler failed', { sessionId }, err)
        }
      }
    }
    for (const handler of this.wildcardSubscribers) {
      try {
        handler({ sessionId, chunk })
      } catch (err) {
        log.error('wildcard handler failed', { sessionId }, err)
      }
    }
  }

  /**
   * Subscribe to every session's chunks (SSE-style fan-out to remote
   * observers that cannot subscribe per session up front).
   */
  subscribeAny(handler: StreamChannelPayloadHandler<TChunk>): Unsubscribe {
    this.wildcardSubscribers.add(handler)
    return () => {
      this.wildcardSubscribers.delete(handler)
    }
  }

  /**
   * Subscribe to chunks for a specific session.
   * Returns an unsubscribe function.
   */
  subscribe(sessionId: string, handler: StreamChunkHandler<TChunk>): Unsubscribe {
    let handlers = this.subscribers.get(sessionId)
    if (!handlers) {
      handlers = new Set()
      this.subscribers.set(sessionId, handlers)
    }
    handlers.add(handler)

    return () => {
      handlers!.delete(handler)
      if (handlers!.size === 0) {
        this.subscribers.delete(sessionId)
      }
    }
  }

  /**
   * Remove all subscribers for a session.
   */
  destroySession(sessionId: string): void {
    this.subscribers.delete(sessionId)
  }

  /**
   * Shut down: remove all subscribers for all sessions.
   */
  shutdown(): void {
    this.subscribers.clear()
    this.wildcardSubscribers.clear()
  }
}
