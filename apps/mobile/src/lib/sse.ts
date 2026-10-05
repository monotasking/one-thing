/**
 * Incremental Server-Sent Events parser (spec: html.spec.whatwg.org/multipage/server-sent-events.html).
 * Pure TypeScript, no RN/DOM dependencies — unit-testable in plain node.
 *
 * Server side (packages/backend/http-server/http-server-sse.ts writeSse) emits:
 *   id: <sequence>\n        (session:event frames only, when envelope.sequence is set)
 *   event: <name>\n
 *   data: <single-line JSON>\n\n
 * plus a one-time ": connected" comment on connect.
 */

export interface SseFrame {
  /** Present only when the server stamped an `id:` line (session:event frames). */
  id?: string
  event: string
  data: string
}

export type SseFrameHandler = (frame: SseFrame) => void

export interface SseParser {
  push: (chunk: string) => void
  /** Flush a trailing frame that lacks the blank-line terminator. */
  end: () => void
}

export function createSseParser(onFrame: SseFrameHandler): SseParser {
  let buffer = ''
  let pendingId: string | undefined
  let pendingEvent = 'message'
  let pendingData: string[] = []

  function reset(): void {
    pendingId = undefined
    pendingEvent = 'message'
    pendingData = []
  }

  function dispatchFrame(): void {
    if (pendingData.length === 0) {
      // No data → not a frame (lone comment / keep-alive); per spec, ignore.
      reset()
      return
    }
    onFrame({ id: pendingId, event: pendingEvent, data: pendingData.join('\n') })
    reset()
  }

  function processLine(rawLine: string): void {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') {
      dispatchFrame()
      return
    }
    if (line.startsWith(':')) return // comment / keep-alive
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    switch (field) {
      case 'id':
        pendingId = value
        break
      case 'event':
        pendingEvent = value
        break
      case 'data':
        pendingData.push(value)
        break
      case 'retry':
        break // reconnect backoff is managed by EventStreamService
      default:
        break
    }
  }

  return {
    push(chunk: string): void {
      buffer += chunk
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        processLine(buffer.slice(0, newlineIndex))
        buffer = buffer.slice(newlineIndex + 1)
        newlineIndex = buffer.indexOf('\n')
      }
    },
    end(): void {
      if (buffer.length > 0) {
        processLine(buffer)
        buffer = ''
      }
      dispatchFrame()
    },
  }
}

/**
 * Reads an SSE response body (fetch ReadableStream, e.g. expo/fetch) and
 * invokes onFrame per complete frame until the stream ends or signal aborts.
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onFrame: SseFrameHandler,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = createSseParser(onFrame)
  const onAbort = () => {
    void reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', onAbort)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parser.push(decoder.decode(value, { stream: true }))
    }
    parser.end()
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}
