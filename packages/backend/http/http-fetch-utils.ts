export type FetchLike = typeof globalThis.fetch

export interface SseEvent {
  event?: string
  data: string
}

export async function assertOkResponse(response: Response, label: string): Promise<void> {
  if (response.ok) return
  let body = ''
  try {
    body = await response.text()
  } catch {
    body = '<failed to read response body>'
  }
  throw new Error(`${label} API error: ${response.status} ${response.statusText} ${body}`.trim())
}

export async function* readSseEvents(response: Response): AsyncIterable<SseEvent> {
  if (!response.body) {
    throw new Error('SSE response has no body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() ?? ''

      for (const frame of frames) {
        const event = parseSseFrame(frame)
        if (event) {
          yield event
        }
      }
    }

    buffer += decoder.decode()
    const event = parseSseFrame(buffer)
    if (event) {
      yield event
    }
  } finally {
    reader.releaseLock()
  }
}

export async function* readJsonSseData<T>(response: Response): AsyncIterable<T> {
  for await (const event of readSseEvents(response)) {
    if (event.data === '[DONE]') {
      break
    }
    yield JSON.parse(event.data) as T
  }
}

function parseSseFrame(frame: string): SseEvent | null {
  const lines = frame.split(/\r?\n/)
  const data: string[] = []
  let event: string | undefined

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator >= 0 ? line.slice(0, separator) : line
    const rawValue = separator >= 0 ? line.slice(separator + 1) : ''
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue

    if (field === 'event') {
      event = value
    } else if (field === 'data') {
      data.push(value)
    }
  }

  if (!event && data.length === 0) {
    return null
  }
  return {
    event,
    data: data.join('\n'),
  }
}
