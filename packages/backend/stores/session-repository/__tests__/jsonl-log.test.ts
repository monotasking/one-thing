import { describe, expect, it } from 'vitest'
import {
  collectTailMessages,
  encodeJsonlHeaderLine,
  encodeJsonlMessageLine,
  getMessagesPageFromArray,
  getMessagesPageFromLogSource,
  scanJsonlLog,
  JSONL_LOG_VERSION,
  type GetSessionMessagesPageRequest,
  type JsonlChunkReader,
  type StoredChatMessage,
} from '@onething/core/session'

interface TestMessage extends StoredChatMessage {
  role: 'user' | 'assistant'
}

function makeMessages(count: number): TestMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i + 1}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `消息 ${i + 1} — content ${'x'.repeat(i % 7)}`,
    timestamp: 1700000000000 + i,
  }))
}

function encodeLog(sessionId: string, messages: TestMessage[]): Uint8Array {
  let text = encodeJsonlHeaderLine(sessionId)
  messages.forEach((message, index) => {
    text += encodeJsonlMessageLine(index + 1, message)
  })
  return new TextEncoder().encode(text)
}

function readerFor(buffer: Uint8Array): JsonlChunkReader {
  return {
    size: buffer.length,
    read: (position, length) => buffer.subarray(position, Math.min(buffer.length, position + length)),
  }
}

describe('jsonl codec', () => {
  it('round-trips header and messages with byte offsets', () => {
    const messages = makeMessages(5)
    const buffer = encodeLog('s1', messages)
    const scan = scanJsonlLog<TestMessage>(buffer)

    expect(scan.header).toEqual({ t: 'h', v: JSONL_LOG_VERSION, sessionId: 's1' })
    expect(scan.recovered).toBe(false)
    expect(scan.validByteLength).toBe(buffer.length)
    expect(scan.entries.map(e => e.seq)).toEqual([1, 2, 3, 4, 5])
    expect(scan.entries.map(e => e.message)).toEqual(messages)

    // 字节区间必须连续覆盖 header 之后的全部内容
    for (let i = 1; i < scan.entries.length; i++) {
      expect(scan.entries[i].byteOffset).toBe(scan.entries[i - 1].byteOffset + scan.entries[i - 1].byteLength)
    }
    const last = scan.entries[scan.entries.length - 1]
    expect(last.byteOffset + last.byteLength).toBe(buffer.length)
  })

  it('recovers from a truncated tail at every byte position', () => {
    const messages = makeMessages(3)
    const buffer = encodeLog('s1', messages)
    const fullScan = scanJsonlLog<TestMessage>(buffer)
    const headerEnd = fullScan.entries[0].byteOffset
    const lineEnds = [headerEnd, ...fullScan.entries.map(e => e.byteOffset + e.byteLength)]

    for (let cut = 1; cut < buffer.length; cut++) {
      const scan = scanJsonlLog<TestMessage>(buffer.subarray(0, cut))
      // 恢复后的合法前缀必须落在行边界上,消息数等于完整消息行数
      const completeLineEnds = lineEnds.filter(end => end <= cut)
      if (completeLineEnds.length === 0) {
        expect(scan.header).toBeUndefined()
        expect(scan.entries).toEqual([])
        expect(scan.validByteLength).toBe(0)
      } else {
        expect(scan.header).toBeDefined()
        expect(scan.entries.length).toBe(completeLineEnds.length - 1)
        expect(scan.validByteLength).toBe(completeLineEnds[completeLineEnds.length - 1])
      }
      // 恰好切在行边界 = 一个更短但完整的日志,不算恢复
      expect(scan.recovered).toBe(!lineEnds.includes(cut))
    }
  })

  it('treats out-of-order seq as corruption point', () => {
    const messages = makeMessages(3)
    let text = encodeJsonlHeaderLine('s1')
    text += encodeJsonlMessageLine(1, messages[0])
    text += encodeJsonlMessageLine(3, messages[1]) // 断序
    text += encodeJsonlMessageLine(2, messages[2])
    const scan = scanJsonlLog<TestMessage>(new TextEncoder().encode(text))

    expect(scan.entries.length).toBe(1)
    expect(scan.recovered).toBe(true)
  })
})

describe('jsonl tail collection', () => {
  it.each([7, 16, 64, 1024])('collects tail across chunk boundaries (chunkSize=%i)', chunkSize => {
    const messages = makeMessages(20)
    const buffer = encodeLog('s1', messages)

    const tail = collectTailMessages<TestMessage>(readerFor(buffer), 5, chunkSize)
    expect(tail).toBeDefined()
    expect(tail!.items.map(i => i.seq)).toEqual([16, 17, 18, 19, 20])
    expect(tail!.reachedHead).toBe(false)

    const all = collectTailMessages<TestMessage>(readerFor(buffer), 100, chunkSize)
    expect(all!.items.length).toBe(20)
    expect(all!.reachedHead).toBe(true)
  })

  it('ignores a crash-truncated unterminated tail line', () => {
    const messages = makeMessages(4)
    const buffer = encodeLog('s1', messages)
    const truncated = buffer.subarray(0, buffer.length - 3)

    const tail = collectTailMessages<TestMessage>(readerFor(truncated), 10, 16)
    expect(tail).toBeDefined()
    expect(tail!.items.map(i => i.seq)).toEqual([1, 2, 3])
  })

  it('returns undefined on interior corruption', () => {
    const messages = makeMessages(3)
    let text = encodeJsonlHeaderLine('s1')
    text += encodeJsonlMessageLine(1, messages[0])
    text += 'garbage-not-json\n'
    text += encodeJsonlMessageLine(3, messages[2])
    const buffer = new TextEncoder().encode(text)

    expect(collectTailMessages<TestMessage>(readerFor(buffer), 10, 16)).toBeUndefined()
  })

  it('handles header-only and empty logs', () => {
    const headerOnly = new TextEncoder().encode(encodeJsonlHeaderLine('s1'))
    const tail = collectTailMessages<TestMessage>(readerFor(headerOnly), 10, 8)
    expect(tail).toEqual({ items: [], reachedHead: true })

    const empty = collectTailMessages<TestMessage>(readerFor(new Uint8Array(0)), 10, 8)
    expect(empty).toEqual({ items: [], reachedHead: true })
  })
})

describe('jsonl log paging equivalence', () => {
  // 用数组实现 JsonlLogPageSource,穷举请求形状,断言与 getMessagesPageFromArray 完全一致
  function sourceFor(messages: TestMessage[]) {
    return {
      totalCount: messages.length,
      readRange: (startSeq: number, endSeq: number) =>
        messages
          .map((message, index) => ({ message, seq: index + 1 }))
          .filter(item => item.seq >= startSeq && item.seq <= endSeq),
      resolveAnchorSeq: (messageId: string) => {
        const index = messages.findIndex(m => m.id === messageId)
        return index === -1 ? undefined : index + 1
      },
    }
  }

  function assertEquivalent(messages: TestMessage[], request: GetSessionMessagesPageRequest) {
    const expected = getMessagesPageFromArray(messages, request)
    const actual = getMessagesPageFromLogSource(request, sourceFor(messages))
    expect(actual, JSON.stringify(request)).toEqual(expected)
  }

  it('matches array paging across request shapes and sizes', () => {
    for (const count of [0, 1, 2, 15, 16, 17, 40]) {
      const messages = makeMessages(count)
      const requests: GetSessionMessagesPageRequest[] = [
        { sessionId: 's1' },
        { sessionId: 's1', limit: 10 },
        { sessionId: 's1', anchor: 'tail', limit: 5 },
        { sessionId: 's1', anchor: { seq: Math.max(1, Math.floor(count / 2)) }, limit: 6 },
        { sessionId: 's1', anchor: { messageId: 'm1', before: 2, after: 3 } },
        { sessionId: 's1', anchor: { messageId: 'missing' } },
        { sessionId: 's1', cursor: 'not-json' },
      ]
      for (const request of requests) {
        assertEquivalent(messages, request)
      }

      // 用 tail 页返回的 cursor 连续向前翻到头,再向后翻回来
      if (count > 0) {
        let page = getMessagesPageFromArray(messages, { sessionId: 's1', limit: 7 })
        assertEquivalent(messages, { sessionId: 's1', limit: 7 })
        while (page.nextCursor) {
          const request: GetSessionMessagesPageRequest = { sessionId: 's1', cursor: page.nextCursor, limit: 7 }
          assertEquivalent(messages, request)
          const next = getMessagesPageFromArray(messages, request)
          if (!next.messages?.length) break
          page = next
        }
        if (page.backwardsCursor) {
          assertEquivalent(messages, {
            sessionId: 's1',
            cursor: page.backwardsCursor,
            direction: 'newer',
            limit: 7,
          })
        }
      }
    }
  })
})
