/**
 * Ring Buffer
 *
 * Fixed-capacity circular buffer for storing event envelopes.
 * When the buffer is full, the oldest entries are overwritten.
 *
 * Used by EventBus to store committed events per-session for replay.
 * Each session gets its own RingBuffer instance.
 *
 * Design decisions:
 * - Fixed capacity (default 1000) prevents unbounded memory growth
 * - Sequence-based replay: callers provide a starting sequence number
 * - O(1) push, O(n) replay where n = number of events replayed
 */

import type { EventBase, SessionEventEnvelope } from './types.js'

export class RingBuffer<TEvent extends EventBase = EventBase> {
  private buffer: (SessionEventEnvelope<TEvent> | undefined)[]
  private head = 0  // Next write position
  private count = 0 // Number of items currently stored
  private readonly capacity: number

  constructor(capacity = 1000) {
    this.capacity = capacity
    this.buffer = new Array(capacity)
  }

  /**
   * Push an envelope into the buffer.
   * If full, the oldest entry is overwritten.
   */
  push(envelope: SessionEventEnvelope<TEvent>): void {
    this.buffer[this.head] = envelope
    this.head = (this.head + 1) % this.capacity
    if (this.count < this.capacity) {
      this.count++
    }
  }

  /**
   * Replay all envelopes with sequence >= fromSequence.
   * Returns them in order (oldest first).
   */
  replay(fromSequence: number): SessionEventEnvelope<TEvent>[] {
    const result: SessionEventEnvelope<TEvent>[] = []

    // Calculate the start index (oldest item in the buffer)
    const start = this.count < this.capacity
      ? 0
      : this.head // When full, head points to the oldest item

    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity
      const envelope = this.buffer[idx]
      if (envelope && envelope.sequence >= fromSequence) {
        result.push(envelope)
      }
    }

    return result
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.buffer = new Array(this.capacity)
    this.head = 0
    this.count = 0
  }

  /** 最新一条的时间戳;缓冲为空时为 `undefined`。 */
  get newestTimestamp(): number | undefined {
    if (this.count === 0) return undefined
    const idx = (this.head - 1 + this.capacity) % this.capacity
    return this.buffer[idx]?.timestamp
  }

  /**
   * Current number of items in the buffer.
   */
  get size(): number {
    return this.count
  }
}
