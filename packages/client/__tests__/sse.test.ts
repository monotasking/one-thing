// @vitest-environment node
/**
 * `parseSseStream` 的黄金表。
 *
 * 每一格都是「一段字节 → 应该折出哪几条消息」,断言写死期望值而不是复述实现 ——
 * 这样把分块处理拆掉、把行尾判断改错,是**这张表**红,不是某个更下游的门。
 */
import { describe, expect, it } from 'vitest'
import { parseSseStream, type SseMessage } from '../transport/sse.js'

/** 把若干块字节喂成一条 `ReadableStream` —— 块的切法就是被测的东西之一。 */
function streamOf(chunks: readonly (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) return controller.close()
      const chunk = chunks[index++]
      controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
    },
  })
}

async function collect(
  chunks: readonly (string | Uint8Array)[],
  onRetry?: (ms: number) => void,
): Promise<SseMessage[]> {
  const out: SseMessage[] = []
  for await (const message of parseSseStream(
    streamOf(chunks),
    onRetry ? { onRetry } : {},
  )) out.push(message)
  return out
}

describe('parseSseStream 黄金表', () => {
  it('① 最小一条:event + data', async () => {
    expect(await collect(['event: session:event\ndata: {"a":1}\n\n'])).toEqual([
      { event: 'session:event', data: '{"a":1}' },
    ])
  })

  it('② 没有 event: 名字缺省是 message', async () => {
    expect(await collect(['data: hello\n\n'])).toEqual([
      { event: 'message', data: 'hello' },
    ])
  })

  it('③ 多行 data 用 \\n 拼,末尾那个 \\n 不带出来', async () => {
    expect(await collect(['data: one\ndata: two\ndata: three\n\n'])).toEqual([
      { event: 'message', data: 'one\ntwo\nthree' },
    ])
  })

  it('④ id 带出来,并且跨事件保留', async () => {
    expect(await collect(['id: 7\ndata: a\n\n', 'data: b\n\n'])).toEqual([
      { event: 'message', data: 'a', id: '7' },
      { event: 'message', data: 'b', id: '7' },
    ])
  })

  it('⑤ 只有 id、没有 data 的一段:不分发', async () => {
    expect(await collect(['id: 42\n\n', 'data: after\n\n'])).toEqual([
      { event: 'message', data: 'after', id: '42' },
    ])
  })

  it('⑥ 注释行(server 的 `: connected` 心跳)整行丢掉,不分发', async () => {
    expect(await collect([': connected\n\n', ': keep-alive\ndata: x\n\n'])).toEqual([
      { event: 'message', data: 'x' },
    ])
  })

  it('⑦ retry 立刻回调,并粘在随后的消息上', async () => {
    const seen: number[] = []
    const messages = await collect(['retry: 2500\ndata: x\n\n'], ms => seen.push(ms))
    expect(seen).toEqual([2500])
    expect(messages).toEqual([{ event: 'message', data: 'x', retry: 2500 }])
  })

  it('⑧ 只有 retry、流就断了:回调照样发生(重连要靠它)', async () => {
    const seen: number[] = []
    expect(await collect(['retry: 900\n\n'], ms => seen.push(ms))).toEqual([])
    expect(seen).toEqual([900])
  })

  it('⑨ 非数字 retry 按规范忽略', async () => {
    const seen: number[] = []
    const messages = await collect(['retry: soon\ndata: x\n\n'], ms => seen.push(ms))
    expect(seen).toEqual([])
    expect(messages).toEqual([{ event: 'message', data: 'x' }])
  })

  it('⑩ \\r\\n 行尾与 \\n 等价', async () => {
    expect(await collect(['event: a\r\ndata: 1\r\n\r\n'])).toEqual([
      { event: 'a', data: '1' },
    ])
  })

  it('⑪ 分块边界切在 \\r 与 \\n 之间:不许多分发一条', async () => {
    expect(await collect(['data: 1\r', '\n\r\n'])).toEqual([
      { event: 'message', data: '1' },
    ])
  })

  it('⑪b 同上,但后面还有 data —— 这一格才真的把「\\r 结尾先别收行」钉住', async () => {
    // 上一格其实两种实现都过(切开的 CRLF 恰好只多出一个空行,而空行遇到空的 data
    // 缓冲不分发)。**判别性**在这里:如果把 `\r` 结尾的块当成行已结束,后半块开头
    // 那个 `\n` 就成了一个"空行" → 提前分发,一条消息被劈成两条。
    expect(await collect(['data: 1\r', '\ndata: 2\r\n\r\n'])).toEqual([
      { event: 'message', data: '1\n2' },
    ])
  })

  it('⑫ 分块边界切在 `data:` 字段名中间', async () => {
    expect(await collect(['da', 'ta: split\n', '\n'])).toEqual([
      { event: 'message', data: 'split' },
    ])
  })

  it('⑬ 分块边界切在 data 的值中间(每字节一块)', async () => {
    const payload = 'event: session:stream\ndata: {"sessionId":"s1"}\n\n'
    const perByte = [...new TextEncoder().encode(payload)].map(b => Uint8Array.of(b))
    expect(await collect(perByte)).toEqual([
      { event: 'session:stream', data: '{"sessionId":"s1"}' },
    ])
  })

  it('⑭ 分块边界切在一个多字节 UTF-8 字符中间', async () => {
    const bytes = new TextEncoder().encode('data: 会话\n\n')
    // 「会」占三个字节,切在第 7 字节 = 切在它中间。
    expect(await collect([bytes.slice(0, 7), bytes.slice(7)])).toEqual([
      { event: 'message', data: '会话' },
    ])
  })

  it('⑮ 冒号后只剥一个空格,不是 trim', async () => {
    expect(await collect(['data:  two-spaces\n\n'])).toEqual([
      { event: 'message', data: ' two-spaces' },
    ])
  })

  it('⑯ 没有冒号的行 = 值为空串;`data` 于是加一个空行', async () => {
    expect(await collect(['data: a\ndata\ndata: b\n\n'])).toEqual([
      { event: 'message', data: 'a\n\nb' },
    ])
  })

  it('⑰ 流结束时残留的半条(没有收尾空行)按规范丢掉', async () => {
    expect(await collect(['data: complete\n\n', 'data: dangling\n'])).toEqual([
      { event: 'message', data: 'complete' },
    ])
  })

  it('⑱ 一块里连着好几条,顺序不乱;event 分发后重置', async () => {
    expect(await collect(['event: a\ndata: 1\n\ndata: 2\n\nevent: c\ndata: 3\n\n'])).toEqual([
      { event: 'a', data: '1' },
      { event: 'message', data: '2' },
      { event: 'c', data: '3' },
    ])
  })

  it('⑲ 未知字段照规范忽略', async () => {
    expect(await collect(['weird: 1\ndata: x\n\n'])).toEqual([
      { event: 'message', data: 'x' },
    ])
  })

  it('⑳ 这一切都发生在没有 window 的环境里(「Node 能用」的证词)', () => {
    expect(typeof window).toBe('undefined')
    expect(typeof (globalThis as { EventSource?: unknown }).EventSource).toBe('undefined')
  })
})
