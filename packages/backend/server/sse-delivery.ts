import type { IncomingMessage, ServerResponse } from 'node:http'

/** Per connection, excluding Node's current write and the source domain snapshot. */
export const SSE_PENDING_BYTES_LIMIT = 1024 * 1024
export const SSE_WRITE_CHUNK_BYTES = 64 * 1024
const CONTROL_RESERVE_BYTES = 1024
const DATA_BYTES_LIMIT = SSE_PENDING_BYTES_LIMIT - CONTROL_RESERVE_BYTES

export interface SseFrame { event: string; payload: unknown; id?: number }
export interface SseDeliveryOptions {
  /** The frame written in place of the dropped tail; it tells the client to reconnect. */
  overflowFrame(): SseFrame
  onOverflow?(): void
  stallTimeoutMs?: number
}

function encode(frame: SseFrame): string {
  const id = typeof frame.id === 'number' && Number.isFinite(frame.id) ? `id: ${frame.id}\n` : ''
  return `${id}event: ${frame.event}\ndata: ${JSON.stringify(frame.payload)}\n\n`
}

/**
 * Owns one SSE response. A partial frame always finishes before invalidation;
 * unstarted frames may be replaced only by an explicit protocol reset and EOF.
 * On overflow the client is told to drop this stream and reconnect with `?after=`.
 */
export function createSseDelivery(response: ServerResponse, options: SseDeliveryOptions) {
  let queue: Array<{ bytes: Buffer; offset: number }> = []
  let pendingBytes = 0
  let blocked = false
  let closing = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const clearStall = () => { clearTimeout(timer); timer = undefined }
  const dispose = () => {
    if (disposed) return
    disposed = true; queue = []; pendingBytes = 0; clearStall()
    response.removeListener('drain', onDrain)
    response.removeListener('close', dispose)
  }
  const armStall = () => {
    if (timer) return
    timer = setTimeout(() => { dispose(); response.destroy() }, options.stallTimeoutMs ?? 30000)
    timer.unref?.()
  }
  const pump = () => {
    if (disposed || blocked) return
    while (queue.length && !blocked && !disposed) {
      const frame = queue[0]
      const end = Math.min(frame.bytes.length, frame.offset + SSE_WRITE_CHUNK_BYTES)
      // Copy the bounded write: Node must not retain an entire large frame for
      // one small in-flight slice after that frame leaves our queue.
      const chunk = Buffer.from(frame.bytes.subarray(frame.offset, end))
      frame.offset = end
      if (end === frame.bytes.length) { queue.shift(); pendingBytes -= frame.bytes.length }
      blocked = !response.write(chunk)
      if (blocked) armStall()
    }
    if (!queue.length && closing && !disposed) response.end()
  }
  function onDrain() { blocked = false; clearStall(); pump() }
  response.on('drain', onDrain)
  response.once('close', dispose)
  const overflow = () => {
    closing = true
    const partial = queue[0]?.offset ? queue[0] : undefined
    queue = partial ? [partial] : []
    pendingBytes = partial ? partial.bytes.length : 0
    const control = Buffer.from(encode(options.overflowFrame()), 'utf8')
    // Recovery envelopes are tiny, fixed protocol records, never user content.
    if (control.length > CONTROL_RESERVE_BYTES) { dispose(); response.destroy(); return }
    queue.push({ bytes: control, offset: 0 }); pendingBytes += control.length
    options.onOverflow?.()
    pump()
  }
  return {
    write(event: string, payload: unknown, id?: number): boolean {
      if (disposed || closing || response.destroyed || response.writableEnded) return false
      const encoded = encode({ event, payload, id })
      const size = Buffer.byteLength(encoded, 'utf8')
      if (size > DATA_BYTES_LIMIT || pendingBytes + size > DATA_BYTES_LIMIT) {
        overflow(); return false
      }
      queue.push({ bytes: Buffer.from(encoded, 'utf8'), offset: 0 }); pendingBytes += size
      pump()
      return true
    },
    dispose,
    /** Read-only counters for host diagnostics and the isolated performance probe. */
    get pendingBytes() { return pendingBytes },
  }
}
export type SseDelivery = ReturnType<typeof createSseDelivery>

/** Main session transport owns subscription cleanup and its overflow reset. */
export function bindSessionSseDelivery(
  context: { request: IncomingMessage; response: ServerResponse },
  subscriptions: Array<() => void>,
): SseDelivery {
  const closeSubscriptions = () => { for (const unsubscribe of subscriptions.splice(0)) unsubscribe() }
  context.request.on('close', closeSubscriptions)
  return createSseDelivery(context.response, {
    overflowFrame: () => ({ event: 'transport:resync-required', payload: { reason: 'buffer-overflow' } }),
    // Synchronous replay can overflow before subscribe() returns its disposer.
    onOverflow: () => queueMicrotask(closeSubscriptions),
  })
}

/** Other SSE routes retain their existing delivery contract until migrated. */
export function writeSse(context: { response: ServerResponse; sse?: SseDelivery }, event: string, payload: unknown, id?: number): void {
  if (context.sse) { context.sse.write(event, payload, id); return }
  const response = context.response
  if (typeof id === 'number' && Number.isFinite(id)) response.write(`id: ${id}\n`)
  response.write(`event: ${event}\n`)
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}
