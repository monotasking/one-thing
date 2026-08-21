import { describe, expect, it } from 'vitest'
import { readJsonSseData, readSseData, readSseEvents } from '@onething/runtime/agent-loop/providers'

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  }), { status: 200 })
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of items) result.push(item)
  return result
}

describe('agent provider SSE reader', () => {
  it('reads SSE data across chunks and ignores done sentinels', async () => {
    const response = streamResponse([
      'data: {"a"',
      ':1}\n\n',
      'data: [DONE]\n\n',
      'data: {"b":2}\n\n',
    ])

    await expect(collect(readSseData(response, { sourceName: 'test stream' })))
      .resolves.toEqual(['{"a":1}', '{"b":2}'])
  })

  it('preserves event names and joins multi-line data payloads', async () => {
    const response = streamResponse([
      'event: delta\n',
      'data: line 1\n',
      'data: line 2\n\n',
    ])

    await expect(collect(readSseEvents(response, { sourceName: 'test stream' })))
      .resolves.toEqual([{ event: 'delta', data: 'line 1\nline 2' }])
  })

  it('throws a source-specific error when the response has no body', async () => {
    const response = new Response(null, { status: 200 })

    await expect(collect(readSseData(response, { sourceName: 'empty stream' })))
      .rejects.toThrow('empty stream: response has no body')
  })

  it('parses JSON SSE payloads with source-specific invalid payload errors', async () => {
    const response = streamResponse([
      'data: {"ok":true}\n\n',
      'data: not-json\n\n',
    ])

    const stream = readJsonSseData<{ ok: boolean }>(response, {
      sourceName: 'json stream',
      invalidMessage: 'invalid test chunk',
    })
    const reader = stream[Symbol.asyncIterator]()

    await expect(reader.next()).resolves.toEqual({
      done: false,
      value: { ok: true },
    })
    await expect(reader.next())
      .rejects.toThrow('json stream: invalid test chunk: not-json')
  })
})
