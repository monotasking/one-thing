/**
 * SSE 解析 —— **纯函数,不认识 `EventSource`**(C0,`docs/design/client-sdk-2026-09.md` §4.1)。
 *
 * 为什么自己解析:`EventSource` 是浏览器独有的(Node 没有),而且**带不了 header**,
 * 于是 token 只能塞进 URL query —— server 侧那条"唯一接受 `?token=` 的路由"就是为它
 * 开的口子。自己拿 `fetch` 的 `ReadableStream` 解析之后:①Node 22/24 与浏览器同一份
 * 代码(CLI 因此能当 core 的客户端);②token 回到 `Authorization: Bearer`;③`?after=`
 * 续播由我们自己控制,不用指望 `EventSource` 的 `Last-Event-ID`。
 *
 * 按 WHATWG「server-sent events」的行解析规则写,一条不含糊:
 *
 * | 行 | 处理 |
 * |---|---|
 * | 空行 | **分发**(data 缓冲为空则只重置,不分发 —— 只有 `id:` 的一段不该冒出一条空事件) |
 * | `:` 开头 | 注释,整行丢掉(server 的 `: connected` 心跳走这条) |
 * | `字段: 值` | 冒号后**只**剥一个前导空格(`data:  x` 的值是 ` x`) |
 * | `字段`(无冒号) | 值 = 空串 |
 * | `event` | 事件名;分发后重置为缺省 `message` |
 * | `data` | 追加一行;多行 `data:` 用 `\n` 拼,分发时去掉末尾那个 `\n` |
 * | `id` | 记住(**跨事件保留**,与 data / event 不同);含 NUL 的按规范忽略 |
 * | `retry` | 全是 ASCII 数字才认;立刻生效(见下) |
 *
 * 两个必须钉死的坑:
 *
 * 1. **分块边界可以切在任何地方**,包括字段名中间、`\r\n` 的两个字节之间、一个
 *    多字节 UTF-8 字符的中间。所以行缓冲跨 chunk 保留,解码用 `TextDecoder` 的
 *    `{ stream: true }`,`\r` 结尾的 chunk **不能**立刻当成行结束(下一块可能是 `\n`)。
 * 2. **`retry:` 可能永远等不到一次分发**(服务器说完 retry 就断线)。所以它除了粘在
 *    下一条消息上,还走 `onRetry` 立刻回调 —— `http.ts` 的重连要在"一条消息都没收到"
 *    的情况下也知道服务器要求多久后再来。
 */

export interface SseMessage {
  /** `event:` 说的名字;没说 = `'message'`(规范缺省)。 */
  event: string
  /** 多行 `data:` 用 `\n` 拼起来的整块;末尾那个 `\n` 已去掉。 */
  data: string
  /** 最近一次 `id:`(跨事件保留),没有过就是 `undefined`。 */
  id?: string
  /** 最近一次合法 `retry:`(毫秒,跨事件保留)。 */
  retry?: number
}

export interface ParseSseStreamOptions {
  /** 收到一条合法 `retry:` 就立刻回调 —— 不等分发(见文件头坑 2)。 */
  onRetry?: (retryMs: number) => void
  signal?: AbortSignal
}

/** SSE 规范说 `id` 值里出现 U+0000 就整条忽略。写成转义常量，源文件里不留真 NUL 字节。 */
const NUL = '\u0000'

/** 只有 ASCII 数字才是合法的 `retry` 值(规范原话)。 */
function parseRetry(value: string): number | undefined {
  if (value.length === 0 || !/^[0-9]+$/.test(value)) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * 把一条字节流折成 SSE 消息序列。
 *
 * 流正常结束时,**不**分发残留的 data 缓冲 —— 规范如此:没有那个空行就不算一条
 * 完整事件,把半条交出去等于伪造。
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  options: ParseSseStreamOptions = {},
): AsyncIterable<SseMessage> {
  const decoder = new TextDecoder('utf-8')
  const reader = stream.getReader()
  const abort = (): void => { void reader.cancel().catch(() => {}) }
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()

  let buffer = ''
  let dataLines: string[] = []
  let eventName = ''
  let lastId: string | undefined
  let lastRetry: number | undefined

  const dispatch = (): SseMessage | undefined => {
    if (dataLines.length === 0) {
      // 只有 `id:` / 只有注释的一段:重置事件名,但不冒出一条空事件。
      eventName = ''
      return undefined
    }
    const message: SseMessage = {
      event: eventName || 'message',
      data: dataLines.join('\n'),
      ...(lastId === undefined ? {} : { id: lastId }),
      ...(lastRetry === undefined ? {} : { retry: lastRetry }),
    }
    dataLines = []
    eventName = ''
    return message
  }

  const handleLine = (line: string): SseMessage | undefined => {
    if (line === '') return dispatch()
    if (line.startsWith(':')) return undefined

    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    // 冒号后**只**剥一个空格,不是 trim:`data:  x` 的值是 ` x`。
    if (value.startsWith(' ')) value = value.slice(1)

    switch (field) {
      case 'event':
        eventName = value
        break
      case 'data':
        dataLines.push(value)
        break
      case 'id':
        // 规范:含 NUL 的 id 整条忽略(不清掉旧的)。
        if (!value.includes(NUL)) lastId = value
        break
      case 'retry': {
        const retry = parseRetry(value)
        if (retry !== undefined) {
          lastRetry = retry
          options.onRetry?.(retry)
        }
        break
      }
      default:
        // 未知字段照规范忽略。
        break
    }
    return undefined
  }

  /**
   * 从缓冲里取出所有**已经完整**的行。
   *
   * `endOfStream=false` 时,末尾单独一个 `\r` 留在缓冲里 —— 它可能是 `\r\n` 被切开的
   * 前半个字节,当场收行就会多分发一次(文件头坑 1)。
   */
  const takeLines = (endOfStream: boolean): string[] => {
    const lines: string[] = []
    let start = 0
    let index = 0
    while (index < buffer.length) {
      const char = buffer[index]
      if (char === '\n') {
        lines.push(buffer.slice(start, index))
        index += 1
        start = index
        continue
      }
      if (char === '\r') {
        if (index === buffer.length - 1 && !endOfStream) break
        lines.push(buffer.slice(start, index))
        index += buffer[index + 1] === '\n' ? 2 : 1
        start = index
        continue
      }
      index += 1
    }
    buffer = buffer.slice(start)
    return lines
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (const line of takeLines(false)) {
        const message = handleLine(line)
        if (message) yield message
      }
    }
    buffer += decoder.decode()
    for (const line of takeLines(true)) {
      const message = handleLine(line)
      if (message) yield message
    }
    // 流断了但最后一行没有换行符:那是半条,按规范丢掉(见函数注释)。
  } finally {
    options.signal?.removeEventListener('abort', abort)
    // 消费者 `break` 出去时也要放开底层连接。
    try {
      await reader.cancel()
    } catch {
      /* 流已经坏了/已经关了:取消失败不该盖过消费者本来的退出原因。 */
    }
    reader.releaseLock()
  }
}
