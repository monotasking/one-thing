import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { createSseDelivery, SSE_PENDING_BYTES_LIMIT, SSE_WRITE_CHUNK_BYTES } from '../sse-delivery.js'

class BackpressuredResponse extends EventEmitter {
  readonly chunks: Buffer[] = []
  writableEnded = false
  destroyed = false
  blocked = true
  write(chunk: Buffer) { this.chunks.push(chunk); return !this.blocked }
  end() { this.writableEnded = true }
  destroy() { this.destroyed = true; this.emit('close') }
}
const reset = () => ({ event: 'transport:resync-required', payload: { reason: 'buffer-overflow' } })

describe('bounded SSE delivery', () => {
  it('preserves a partial UTF-8 frame before explicit reset, bounds retained bytes, and stops subsequent writes', () => {
    const response = new BackpressuredResponse()
    const overflow = vi.fn()
    const delivery = createSseDelivery(response as unknown as ServerResponse, { overflowFrame: reset, onOverflow: overflow })
    const text = '界'.repeat(150000)
    expect(delivery.write('unicode', { text }, 1)).toBe(true)
    expect(response.chunks).toHaveLength(1)
    // In UTF-8 this is > 1MiB; string.length alone would incorrectly accept it.
    expect(delivery.write('oversize', { text: '界'.repeat(400000) }, 2)).toBe(false)
    expect(overflow).toHaveBeenCalledTimes(1)
    expect(delivery.pendingBytes).toBeLessThanOrEqual(SSE_PENDING_BYTES_LIMIT)
    expect(delivery.write('later', { text: 'must not be delivered' }, 3)).toBe(false)
    response.blocked = false; response.emit('drain')
    const wire = Buffer.concat(response.chunks).toString('utf8')
    const frames = wire.trim().split('\n\n')
    expect(frames).toHaveLength(2)
    expect(JSON.parse(frames[0].split('\n').find(line => line.startsWith('data: '))!.slice(6))).toEqual({ text })
    expect(frames[1]).toContain('"reason":"buffer-overflow"')
    expect(wire).not.toContain('id: 2')
    expect(response.chunks.every(chunk => chunk.length <= SSE_WRITE_CHUNK_BYTES)).toBe(true)
    expect(response.writableEnded).toBe(true)
    expect(delivery.pendingBytes).toBe(0)
    delivery.dispose()
    expect(response.listenerCount('drain')).toBe(0)
  })

  it('bounds a sequence of individually small frames without silently skipping queued events', () => {
    const response = new BackpressuredResponse()
    const delivery = createSseDelivery(response as unknown as ServerResponse, { overflowFrame: reset })
    let accepted = 0
    for (let index = 0; index < 100; index++) {
      if (delivery.write('item', { index, text: 'x'.repeat(32000) }, index)) accepted++
      expect(delivery.pendingBytes).toBeLessThanOrEqual(SSE_PENDING_BYTES_LIMIT)
    }
    expect(accepted).toBeGreaterThan(1); expect(accepted).toBeLessThan(100)
    response.blocked = false; response.emit('drain')
    const wire = Buffer.concat(response.chunks).toString('utf8')
    expect(wire).toContain('id: 0\n')
    expect(wire).toContain('"reason":"buffer-overflow"')
    expect(response.writableEnded).toBe(true)
    delivery.dispose()
  })

  it('releases the queue and listeners if a peer never drains', async () => {
    vi.useFakeTimers()
    const response = new BackpressuredResponse()
    const delivery = createSseDelivery(response as unknown as ServerResponse, { overflowFrame: reset, stallTimeoutMs: 20 })
    try {
      delivery.write('item', { text: 'x'.repeat(100000) })
      await vi.advanceTimersByTimeAsync(20)
      expect(response.destroyed).toBe(true)
      expect(delivery.pendingBytes).toBe(0)
      expect(response.listenerCount('drain')).toBe(0)
    } finally { delivery.dispose(); vi.useRealTimers() }
  })
})
