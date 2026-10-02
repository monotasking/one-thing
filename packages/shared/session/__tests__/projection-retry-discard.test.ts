/**
 * 批 6(`docs/design/provider-settings-rework-2026-09.md` §9.3 留账 ②):**流到一半失败、换凭证
 * 重试**时,失败那一次已经落账的半句不许与重试那一遍连成一段。
 *
 * 记录器在 `auto-retry` 那一刻把失败尝试的段收齐落账,再在 `request/error` 上点名
 * (`discardParts`);折叠据它摘掉那几段。缺席(老文件 / 失败前一个字都没出)= 什么都不摘。
 */
import { describe, expect, it } from 'vitest'
import { projectChatMessages } from '../projection/chat-messages.js'
import type { SessionLogEventRecord } from '../events/types.js'

function events(withDiscard: boolean): SessionLogEventRecord[] {
  const list: Record<string, unknown>[] = [
    { seq: 1, time: 1, type: 'user/message', data: { message: { id: 'u1', role: 'user', content: '问', timestamp: 1 } }, surfaceOp: 'append' },
    { seq: 2, time: 2, type: 'run/start', data: { runId: 'r1', kind: 'send', assistantMessageId: 'a1', timestamp: 2 }, surfaceOp: 'append' },
    { seq: 3, time: 3, type: 'request/start', data: { runId: 'r1', requestIndex: 1, messageId: 'a1' } },
    // 失败那一次:流了半句。
    { seq: 4, time: 4, type: 'assistant/chunks', data: { runId: 'r1', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text', turnIndex: 1, time0: 4, dt: [0, 1], text: ['半截', '回答'] } },
    { seq: 5, time: 5, type: 'assistant/part-end', data: { runId: 'r1', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text', len: 4, hash: 'x', turnIndex: 1 } },
    {
      seq: 6, time: 6, type: 'request/error',
      data: { runId: 'r1', requestIndex: 1, error: { message: '换凭证重试' }, willRetry: true, attempt: 1, ...(withDiscard ? { discardParts: [0] } : {}) },
    },
    // 重试那一遍:新段。
    { seq: 7, time: 7, type: 'assistant/chunks', data: { runId: 'r1', requestIndex: 1, messageId: 'a1', partIndex: 1, kind: 'text', turnIndex: 1, time0: 7, dt: [0], text: ['完整回答'] } },
    { seq: 8, time: 8, type: 'assistant/part-end', data: { runId: 'r1', requestIndex: 1, messageId: 'a1', partIndex: 1, kind: 'text', len: 4, hash: 'y', turnIndex: 1 } },
    { seq: 9, time: 9, type: 'request/end', data: { runId: 'r1', requestIndex: 1, stopReason: 'stop' } },
    { seq: 10, time: 10, type: 'run/end', data: { runId: 'r1', outcome: 'completed' } },
  ]
  return list as unknown as SessionLogEventRecord[]
}

describe('request/error.discardParts:重试作废失败尝试的输出', () => {
  it('点名的段被摘掉,回答只剩重试那一遍', () => {
    const { messages } = projectChatMessages(events(true))
    expect(messages[1].content).toBe('完整回答')
  })

  it('老文件(没有 discardParts)照旧两段都留 —— 修复前的行为不回写', () => {
    const { messages } = projectChatMessages(events(false))
    expect(messages[1].content).toBe('半截回答完整回答')
  })
})
