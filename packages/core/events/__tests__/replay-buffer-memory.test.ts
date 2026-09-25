import { describe, expect, it } from 'vitest'
import { EventBus } from '../event-bus.js'

type Ev = { type: string }

describe('EventBus replay buffers on the memory table', () => {
  it('counts buffered envelopes per session', async () => {
    const bus = new EventBus<Ev>(3)
    await bus.emit('a', { type: 'x' })
    await bus.emit('a', { type: 'x' })
    await bus.emit('b', { type: 'x' })
    expect(bus.bufferUsage()).toEqual({ sessions: 2, entries: 3, capacityPerSession: 3, subscribed: 0 })
  })

  it('releases only idle, unsubscribed buffers and keeps the sequence going', async () => {
    const bus = new EventBus<Ev>()
    await bus.emit('idle', { type: 'x' })
    await bus.emit('watched', { type: 'x' })
    const off = bus.onAny('watched', () => {})
    const later = Date.now() + 60_000
    const released = bus.releaseIdleBuffers(30_000, later)
    expect(released).toEqual({ releasedSessions: 1, releasedEntries: 1 })
    expect(bus.bufferUsage().sessions).toBe(1)
    // 序号不回绕:丢掉缓冲之后的下一条接着上一个号。
    const next = await bus.emit('idle', { type: 'x' })
    expect(next.envelope?.sequence).toBe(2)
    off()
  })

  it('keeps a recently active buffer even without subscribers', async () => {
    const bus = new EventBus<Ev>()
    await bus.emit('fresh', { type: 'x' })
    expect(bus.releaseIdleBuffers(60_000).releasedSessions).toBe(0)
  })
})
