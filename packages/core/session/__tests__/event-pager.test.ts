/**
 * 事件日志上的倒读分页(S2a,§3.2 / §11.1)。
 *
 * 这一套钉的是三件事:
 *  1. **倒读一页 ≡ 全量 fold 取尾一页** —— 分页不是另一种投影,只是同一个投影
 *     的一个窗口。合同测试里每条场景都另有一行同款断言;这里钉的是 pager 自己
 *     的边界(块大小、半行、空文件、游标往返)。
 *  2. **遮蔽事件必须被倒读看见**:删除 / 编辑重发的截断 / 清空,三条都在
 *     "被遮蔽的那条在窗口之外"时试一遍 —— 那正是"只读尾巴"最容易漏掉的地方。
 *  3. **不读整份文件**:攒够一页就停(`scannedEvents` 是自证)。
 */
import { describe, expect, it } from 'vitest'
import {
  buildSessionEventJumpIndex,
  encodeSessionLogEventLine,
  foldEventPageBackward,
  listEventUserMessageMarkers,
  pageEventMessages,
  projectChatMessages,
  type SessionEventByteReader,
  type SessionLogEventRecord,
} from '@onething/core/session'

// ============ 事件流的小工具 ============

class Log {
  readonly events: SessionLogEventRecord[] = []
  private seq = 0

  push(event: Omit<SessionLogEventRecord, 'seq' | 'time'> & { time?: number }): SessionLogEventRecord {
    this.seq += 1
    const record = { seq: this.seq, time: event.time ?? this.seq, ...event } as SessionLogEventRecord
    this.events.push(record)
    return record
  }

  user(id: string, content = `ask ${id}`): SessionLogEventRecord {
    return this.push({
      type: 'user/message',
      data: { message: { id, role: 'user', content, timestamp: this.seq + 1 } },
      surfaceOp: 'append',
    } as never)
  }

  /** 一整个助手回合(run/start + 一段正文 + run/end)。 */
  turn(runId: string, messageId: string, text = `reply ${messageId}`): void {
    this.push({
      type: 'run/start',
      data: { runId, kind: 'send', assistantMessageId: messageId },
      surfaceOp: 'append',
    } as never)
    this.push({
      type: 'assistant/chunks',
      data: { runId, requestIndex: 1, messageId, partIndex: 0, kind: 'text', time0: 1, dt: [0], text: [text] },
    } as never)
    this.push({ type: 'run/end', data: { runId, outcome: 'completed' } } as never)
  }

  bytes(): Uint8Array {
    return new TextEncoder().encode(this.events.map(encodeSessionLogEventLine).join(''))
  }
}

function readerOf(buffer: Uint8Array): SessionEventByteReader {
  return {
    size: buffer.length,
    read: (position, length) => buffer.subarray(position, Math.min(buffer.length, position + length)),
  }
}

function conversation(turns: number): Log {
  const log = new Log()
  for (let index = 1; index <= turns; index++) {
    log.user(`u${index}`)
    log.turn(`r${index}`, `a${index}`)
  }
  return log
}

/** 全量 fold 之后取尾 N 条 —— pager 的**判据**。 */
function foldTail(log: Log, count: number): unknown[] {
  const all = projectChatMessages(log.events).messages
  return all.slice(Math.max(0, all.length - count))
}

describe('event pager: 倒读一页 ≡ 全量 fold 取尾一页', () => {
  it('matches the full fold for every page size and chunk size', () => {
    const log = conversation(12)
    const reader = readerOf(log.bytes())
    for (const limit of [1, 2, 5, 12, 40]) {
      for (const chunkSize of [64, 512, 8192, 1 << 20]) {
        const page = foldEventPageBackward(reader, { limit, chunkSize })
        expect(page.messages, `limit=${limit} chunk=${chunkSize}`).toEqual(foldTail(log, limit))
      }
    }
  })

  it('stops as soon as the page is full (it does not read the whole file)', () => {
    const log = conversation(40)
    const page = foldEventPageBackward(readerOf(log.bytes()), { limit: 4, chunkSize: 256 })
    expect(page.messages).toHaveLength(4)
    expect(page.hasMoreBefore).toBe(true)
    expect(page.reachedHead).toBe(false)
    expect(page.scannedEvents).toBeLessThan(log.events.length / 2)
  })

  it('reports the head when the whole log fits in one page', () => {
    const log = conversation(2)
    const page = foldEventPageBackward(readerOf(log.bytes()), { limit: 40 })
    expect(page.messages).toHaveLength(4)
    expect(page.hasMoreBefore).toBe(false)
    expect(page.reachedHead).toBe(true)
  })

  it('handles an empty log and a crash-truncated tail line', () => {
    expect(foldEventPageBackward(readerOf(new Uint8Array(0)), { limit: 10 }).messages).toEqual([])

    const log = conversation(3)
    const full = log.bytes()
    const truncated = full.subarray(0, full.length - 12)
    const page = foldEventPageBackward(readerOf(truncated), { limit: 10 })
    // 半行被跳过(与 parseSessionLogEventLog 同口径),其余照旧折出来。
    expect(page.messages.length).toBeGreaterThanOrEqual(5)
  })
})

describe('event pager: 遮蔽事件在窗口之外时也必须生效', () => {
  it('a deleted message stays hidden', () => {
    const log = conversation(6)
    log.push({ type: 'message/deleted', data: { messageId: 'u3' } } as never)
    const page = foldEventPageBackward(readerOf(log.bytes()), { limit: 40 })
    expect(page.messages.map(m => m.id)).not.toContain('u3')
    expect(page.messages).toEqual(foldTail(log, 40))
  })

  it('an edit-resend truncation is honoured even when its target is far behind the tail', () => {
    const log = conversation(8)
    // 编辑第 2 条:它自己与它之后的一切都不再显示,只剩新那条。
    log.push({
      type: 'user/message-edited',
      data: { messageId: 'u2', message: { id: 'u2b', role: 'user', content: 'edited', timestamp: 99 } },
      surfaceOp: 'append',
    } as never)
    log.turn('rEdit', 'aEdit')

    const reader = readerOf(log.bytes())
    // 一页只要 2 条:朴素的实现会在看到编辑事件之后就停,于是 u2 之后那些
    // 本该消失的消息会照旧出现。
    const page = foldEventPageBackward(reader, { limit: 2, chunkSize: 128 })
    expect(page.messages).toEqual(foldTail(log, 2))
    const wide = foldEventPageBackward(reader, { limit: 40 })
    expect(wide.messages.map(m => m.id)).toEqual(['u1', 'a1', 'u2b', 'aEdit'])
  })

  it('a session/cleared is the head — nothing before it is visible', () => {
    const log = conversation(5)
    log.push({ type: 'session/cleared', data: { reason: 'cleared' } } as never)
    log.user('u9')
    log.turn('r9', 'a9')

    const page = foldEventPageBackward(readerOf(log.bytes()), { limit: 40 })
    expect(page.messages.map(m => m.id)).toEqual(['u9', 'a9'])
    expect(page.reachedHead).toBe(true)
    expect(page.hasMoreBefore).toBe(false)
    // 它就是头 —— 再往前读一条都没有必要。
    expect(page.scannedEvents).toBeLessThan(log.events.length)
  })
})

describe('event pager: 分页响应与游标', () => {
  it('walks the whole history backwards through cursors and lands on the fold', () => {
    const log = conversation(10)
    const reader = readerOf(log.bytes())
    const sessionId = 's1'
    const collected: string[] = []

    let response = pageEventMessages(reader, { sessionId, anchor: 'tail', limit: 4 })
    expect(response.success).toBe(true)
    collected.unshift(...(response.messages ?? []).map(m => m.id))

    while (response.hasMoreBefore && response.nextCursor) {
      response = pageEventMessages(reader, { sessionId, cursor: response.nextCursor, direction: 'older', limit: 4 })
      expect(response.success).toBe(true)
      collected.unshift(...(response.messages ?? []).map(m => m.id))
    }

    expect(collected).toEqual(projectChatMessages(log.events).messages.map(m => m.id))
  })

  it('pages forward again with the backwards cursor', () => {
    const log = conversation(6)
    const reader = readerOf(log.bytes())
    const sessionId = 's1'
    const first = pageEventMessages(reader, { sessionId, anchor: 'tail', limit: 4 })
    const older = pageEventMessages(reader, { sessionId, cursor: first.nextCursor!, direction: 'older', limit: 4 })
    const back = pageEventMessages(reader, { sessionId, cursor: older.backwardsCursor!, direction: 'newer', limit: 4 })
    expect(back.messages?.[0].id).toBe(older.messages?.[older.messages.length - 1].id)
  })

  it('fills seq with the eventSeq and only reports totalCount when it really counted', () => {
    const small = conversation(2)
    const page = pageEventMessages(readerOf(small.bytes()), { sessionId: 's1', anchor: 'tail', limit: 40 })
    expect(page.totalCount).toBe(4)
    expect(page.messages?.map(m => m.seq)).toEqual(
      projectChatMessages(small.events).messages.map(m => m.eventSeq),
    )

    const big = conversation(20)
    const partial = pageEventMessages(readerOf(big.bytes()), { sessionId: 's1', anchor: 'tail', limit: 4 })
    expect(partial.totalCount).toBeUndefined()
    expect(partial.hasMoreBefore).toBe(true)
  })

  it('rejects a foreign or offset-less cursor', () => {
    const reader = readerOf(conversation(3).bytes())
    expect(pageEventMessages(reader, { sessionId: 's1', cursor: JSON.stringify({ sessionId: 'other', seq: 1, includeAnchor: false, offset: 0 }) }).success).toBe(false)
    expect(pageEventMessages(reader, { sessionId: 's1', cursor: JSON.stringify({ sessionId: 's1', seq: 1, includeAnchor: false }) }).success).toBe(false)
    expect(pageEventMessages(reader, { sessionId: 's1', cursor: 'not json' }).success).toBe(false)
  })
})

describe('event pager: 跳转索引与用户锚点', () => {
  it('jumps to a message by id through the in-memory index', () => {
    const log = conversation(10)
    const reader = readerOf(log.bytes())
    const index = buildSessionEventJumpIndex(reader)
    const all = projectChatMessages(log.events).messages

    const page = pageEventMessages(reader, {
      sessionId: 's1',
      anchor: { messageId: 'u5', before: 2, after: 2 },
    }, { resolveAnchor: anchor => (anchor.messageId ? index.byMessageId.get(anchor.messageId) : undefined) })

    const at = all.findIndex(message => message.id === 'u5')
    expect(page.messages?.map(m => m.id)).toEqual(all.slice(at - 2, at + 3).map(m => m.id))
  })

  it('reports a missing anchor instead of guessing', () => {
    const reader = readerOf(conversation(3).bytes())
    const page = pageEventMessages(reader, { sessionId: 's1', anchor: { messageId: 'nope' } }, { resolveAnchor: () => undefined })
    expect(page).toEqual({ success: false, error: 'Anchor message not found' })
  })

  it('lists user markers with eventSeq coordinates', () => {
    const log = conversation(4)
    const markers = listEventUserMessageMarkers(readerOf(log.bytes()))
    const users = projectChatMessages(log.events).messages.filter(m => m.role === 'user')
    expect(markers.map(m => m.id)).toEqual(users.map(m => m.id))
    expect(markers.map(m => m.seq)).toEqual(users.map(m => m.eventSeq))
  })
})
