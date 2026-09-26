export interface SseEvent {
  event?: string
  data: string
}

export interface ReadSseOptions {
  sourceName: string
  ignoreDone?: boolean
  /**
   * 跳过哪一条 data 作为结束标记(方言可注入,§7.5)。缺 = 按 `ignoreDone`
   * (缺省 true → `'[DONE]'`,false → 不跳);`null` = 这家不发结束标记,每条 data 照常交出。
   * 标记只被**跳过**,不截断读取 —— 收尾靠流关闭,与今天 `[DONE]` 的处理一致。
   */
  doneMarker?: string | null
}

export interface ReadJsonSseOptions extends ReadSseOptions {
  invalidMessage?: string
}

function fieldValue(line: string, prefixLength: number): string {
  const value = line.slice(prefixLength)
  return value.startsWith(' ') ? value.slice(1) : value
}

function maybeEvent(
  event: string | undefined,
  dataLines: string[],
  doneMarker: string | null,
): SseEvent | undefined {
  if (dataLines.length === 0) return undefined
  const data = dataLines.join('\n')
  if (doneMarker !== null && data === doneMarker) return undefined
  return {
    ...(event ? { event } : {}),
    data,
  }
}

export async function* readSseEvents(
  response: Response,
  options: ReadSseOptions,
): AsyncGenerator<SseEvent, void, void> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error(`${options.sourceName}: response has no body`)

  const decoder = new TextDecoder()
  let buffer = ''
  let event: string | undefined
  let dataLines: string[] = []
  const doneMarker =
    options.doneMarker !== undefined
      ? options.doneMarker
      : (options.ignoreDone ?? true)
        ? '[DONE]'
        : null

  const handleLine = (rawLine: string): SseEvent | undefined => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') {
      const nextEvent = maybeEvent(event, dataLines, doneMarker)
      event = undefined
      dataLines = []
      return nextEvent
    }
    if (line.startsWith(':')) return undefined
    if (line.startsWith('event:')) {
      event = fieldValue(line, 'event:'.length)
      return undefined
    }
    if (line.startsWith('data:')) {
      dataLines.push(fieldValue(line, 'data:'.length))
    }
    return undefined
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const nextEvent = handleLine(line)
        if (nextEvent) yield nextEvent
      }
    }

    buffer += decoder.decode()
    if (buffer) {
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const nextEvent = handleLine(line)
        if (nextEvent) yield nextEvent
      }
      if (buffer) {
        const nextEvent = handleLine(buffer)
        if (nextEvent) yield nextEvent
      }
    }

    const nextEvent = maybeEvent(event, dataLines, doneMarker)
    if (nextEvent) yield nextEvent
  } finally {
    reader.releaseLock()
  }
}

export async function* readSseData(
  response: Response,
  options: ReadSseOptions,
): AsyncGenerator<string, void, void> {
  for await (const event of readSseEvents(response, options)) {
    yield event.data
  }
}

export async function* readJsonSseData<T>(
  response: Response,
  options: ReadJsonSseOptions,
): AsyncGenerator<T, void, void> {
  for await (const payload of readSseData(response, options)) {
    try {
      yield JSON.parse(payload) as T
    } catch {
      throw new Error(`${options.sourceName}: ${options.invalidMessage ?? 'invalid JSON SSE payload'}: ${payload}`)
    }
  }
}
