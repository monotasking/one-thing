import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatSession } from '@shared/ipc.js'
import {
  estimateSessionInputTokens,
  formatMessagesForSummary,
  normalizeContextSummaryOutput,
  selectCompactPlan,
  shouldAutoCompactBeforeSend,
} from '../context-compact.js'

function message(index: number, role: 'user' | 'assistant'): ChatMessage {
  return {
    id: `${role}-${index}`,
    role,
    content: `${role} ${index}`,
    timestamp: index,
  }
}

function session(messages: ChatMessage[], summaryUpToMessageId?: string): ChatSession {
  return {
    id: 's1',
    name: 'Test',
    messages,
    createdAt: 0,
    updatedAt: 0,
    summary: summaryUpToMessageId ? 'Previous summary' : undefined,
    summaryUpToMessageId,
  }
}

describe('selectCompactPlan', () => {
  it('skips when the session does not exceed the retained recent turns', () => {
    const messages = [
      message(1, 'user'),
      message(2, 'assistant'),
      message(3, 'user'),
      message(4, 'assistant'),
    ]

    expect(selectCompactPlan(session(messages), session(messages).messages, 3)).toBeNull()
  })

  it('summarizes older messages and keeps recent turns intact', () => {
    const messages = [
      message(1, 'user'),
      message(2, 'assistant'),
      message(3, 'user'),
      message(4, 'assistant'),
      message(5, 'user'),
      message(6, 'assistant'),
      message(7, 'user'),
      message(8, 'assistant'),
    ]

    const plan = selectCompactPlan(session(messages), session(messages).messages, 2)

    expect(plan?.cutoffMessage.id).toBe('assistant-4')
    expect(plan?.messagesToSummarize.map(m => m.id)).toEqual([
      'user-1',
      'assistant-2',
      'user-3',
      'assistant-4',
    ])
  })

  it('does not compact again until messages pass the previous summary point', () => {
    const messages = [
      message(1, 'user'),
      message(2, 'assistant'),
      message(3, 'user'),
      message(4, 'assistant'),
      message(5, 'user'),
      message(6, 'assistant'),
    ]

    expect(selectCompactPlan(session(messages, 'assistant-4'), session(messages, 'assistant-4').messages, 1)).toBeNull()
  })

  it('ignores a stale summary when its anchor is no longer in the timeline', () => {
    const messages = [
      message(1, 'user'),
      message(2, 'assistant'),
      message(3, 'user'),
      message(4, 'assistant'),
      message(5, 'user'),
      message(6, 'assistant'),
      message(7, 'user'),
      message(8, 'assistant'),
    ]

    const plan = selectCompactPlan(session(messages, 'missing-message'), session(messages, 'missing-message').messages, 2)

    expect(plan?.previousSummary).toBeUndefined()
    expect(plan?.messagesToSummarize.map(m => m.id)).toEqual([
      'user-1',
      'assistant-2',
      'user-3',
      'assistant-4',
    ])
  })

  it('continues from the previous summary anchor when compact markers are in the timeline', () => {
    const compactMarker: ChatMessage = {
      id: 'compact-1',
      role: 'system',
      content: '{"type":"context-compact","status":"completed","summary":"Earlier"}',
      timestamp: 5,
    }
    const messages = [
      message(1, 'user'),
      message(2, 'assistant'),
      message(3, 'user'),
      message(4, 'assistant'),
      compactMarker,
      message(6, 'user'),
      message(7, 'assistant'),
      message(8, 'user'),
      message(9, 'assistant'),
      message(10, 'user'),
      message(11, 'assistant'),
    ]

    const plan = selectCompactPlan(session(messages, 'assistant-4'), session(messages, 'assistant-4').messages, 2)

    expect(plan?.previousSummary).toBe('Previous summary')
    expect(plan?.messagesToSummarize.map(m => m.id)).toEqual([
      'user-6',
      'assistant-7',
    ])
  })
})

describe('shouldAutoCompactBeforeSend', () => {
  it('triggers when tracked context reaches the configured threshold', async () => {
    const testSession = session([message(1, 'user')])
    testSession.contextSize = 90

    await expect(shouldAutoCompactBeforeSend({
      session: testSession,
      modelContextLength: 100,
      thresholdPercent: 85,
    })).resolves.toBe(true)
  })

  // 2026-08-23:预留输出量不再是判据的一部分 —— 80/200 = 40% 不到 85%,
  // 从前那条 hard-limit 线(80 + 25 >= 100 − margin)整条删除,只剩百分比。
  it('does not count reserved output tokens toward the configured percentage', async () => {
    const testSession = session([message(1, 'user')])
    testSession.contextSize = 80

    await expect(shouldAutoCompactBeforeSend({
      session: testSession,
      modelContextLength: 200,
      thresholdPercent: 85,
    })).resolves.toBe(false)
  })

  it('does not trigger from a would-be hard limit when the percentage is not reached', async () => {
    const testSession = session([message(1, 'user')])
    testSession.contextSize = 80

    await expect(shouldAutoCompactBeforeSend({
      session: testSession,
      sessionMessages: testSession.messages,
      modelContextLength: 100,
      thresholdPercent: 85,
      inputTokens: 80,
    })).resolves.toBe(false)
  })

  it('does not trigger below threshold', async () => {
    const testSession = session([message(1, 'user')])
    testSession.contextSize = 40

    await expect(shouldAutoCompactBeforeSend({
      session: testSession,
      modelContextLength: 100,
      thresholdPercent: 85,
    })).resolves.toBe(false)
  })

  it('triggers from local message size when provider context is unknown', async () => {
    const testSession = session([{
      ...message(1, 'user'),
      content: 'x'.repeat(10000),
    }])

    await expect(shouldAutoCompactBeforeSend({
      session: testSession,
      sessionMessages: testSession.messages,
      modelContextLength: 100,
      thresholdPercent: 50,
    })).resolves.toBe(true)
  })

  it('ignores compacted tail size — compaction triggers on token usage only', async () => {
    // A tail-size (char count) trigger was tried and deliberately removed:
    // compaction does not shrink the tail's raw chars, so it re-fired every
    // turn — an infinite compact loop. A huge tail with low token usage must
    // NOT trigger; do not re-add a char-based trigger here.
    const anchor = message(1, 'assistant')
    const tail: ChatMessage[] = [anchor]
    for (let index = 2; index <= 11; index++) {
      tail.push({
        ...message(index, index % 2 === 0 ? 'user' : 'assistant'),
        content: 'z'.repeat(40_000),
      })
    }
    const testSession = session(tail, anchor.id)
    testSession.contextSize = 1_000

    await expect(shouldAutoCompactBeforeSend({
      session: testSession,
      modelContextLength: 1_000_000,
      thresholdPercent: 85,
      inputTokens: 1_000,
    })).resolves.toBe(false)
  })
})

describe('context compact summary helpers', () => {
  it('estimates mixed CJK and ASCII text without provider usage', () => {
    const testSession = session([{
      ...message(1, 'user'),
      content: 'hello '.repeat(100) + '你好'.repeat(50),
    }])

    expect(estimateSessionInputTokens(testSession, testSession.messages)).toBeGreaterThan(100)
  })

  it('normalizes a six-section summary returned inside a markdown fence', () => {
    const normalized = normalizeContextSummaryOutput(
      '```md\n## Goal\nShip compact\n\n## Next Steps\n1. Land C5\n```',
    )

    expect(normalized).toBe('## Goal\nShip compact\n\n## Next Steps\n1. Land C5')
  })

  it('returns the trimmed original when the output misses the `## Goal` heading', () => {
    // 不合格不代表要丢:一份没按格式写的摘要仍然比没有摘要好。
    expect(normalizeContextSummaryOutput('  Sure! Here is what happened.  '))
      .toBe('Sure! Here is what happened.')
    // 从前的 JSON 抽取兜底已删 —— JSON 进来就原样出去,不再被重排。
    expect(normalizeContextSummaryOutput('{"goal":"old"}')).toBe('{"goal":"old"}')
  })

  it('includes bounded tool result context for the summarizer', () => {
    const summaryInput = formatMessagesForSummary([{
      ...message(1, 'assistant'),
      toolCalls: [{
        id: 'call_1',
        toolId: 'read',
        toolName: 'read',
        arguments: { path: '/tmp/large.txt' },
        status: 'completed',
        result: {
          title: 'Read large file',
          output: 'important finding ' + 'x'.repeat(10000),
          originalContent: 'do not include rollback content',
        },
        timestamp: 1,
      }],
    }])

    expect(summaryInput).toContain('important finding')
    expect(summaryInput).toContain('[truncated')
    expect(summaryInput).not.toContain('do not include rollback content')
  })
})
