import { describe, expect, it } from 'vitest'
import {
  buildContextCompactCompletedContent,
  buildContextCompactFailedContent,
  buildContextCompactSummaryMessages,
  buildContextUsageSnapshot,
  createContextCompactMessage,
  estimateSessionInputTokens,
  estimateTextTokens,
  formatMessagesForSummary,
  normalizeContextCompactError,
  normalizeContextSummaryOutput,
  selectCompactPlan,
  shouldAutoCompactBeforeSend,
  summarizeContextInChunks,
} from '@onething/core/engine'
import type { CoreCompactMessage, CoreCompactSession } from '@onething/core/engine'

function message(index: number, role: 'user' | 'assistant'): CoreCompactMessage {
  return {
    id: `${role}-${index}`,
    role,
    content: `${role} ${index}`,
  }
}

function session(messages: CoreCompactMessage[], summaryUpToMessageId?: string): CoreCompactSession {
  return {
    id: 's1',
    messages,
    summary: summaryUpToMessageId ? 'Previous summary' : undefined,
    summaryUpToMessageId,
  }
}

describe('core context compact helpers', () => {
  it('builds stable context compact status messages in core', () => {
    expect(createContextCompactMessage({
      id: 'compact-1',
      timestamp: 123,
      compactedMessageCount: 4,
    })).toEqual({
      id: 'compact-1',
      role: 'system',
      timestamp: 123,
      content: JSON.stringify({
        type: 'context-compact',
        status: 'compacting',
        summary: '',
        compactedMessageCount: 4,
      }),
    })

    expect(JSON.parse(buildContextCompactCompletedContent('summary text', 3))).toEqual({
      type: 'context-compact',
      status: 'completed',
      summary: 'summary text',
      compactedMessageCount: 3,
    })

    expect(JSON.parse(buildContextCompactFailedContent('provider failed', 2))).toEqual({
      type: 'context-compact',
      status: 'failed',
      summary: '',
      error: 'provider failed',
      compactedMessageCount: 2,
    })

    expect(normalizeContextCompactError(new Error('bad json'))).toBe('bad json')
    expect(normalizeContextCompactError('nope')).toBe('Failed to compact context')
  })

  it('summarizes compact context chunks through an injected provider callback', async () => {
    const calls: Array<{ chunk: string; previousSummary?: string }> = []
    const summary = await summarizeContextInChunks({
      messages: 'aaabbbccc',
      maxChunkChars: 3,
      summarizeChunk: async (input) => {
        calls.push(input)
        return ` ${input.previousSummary ? `${input.previousSummary}+${input.chunk}` : input.chunk} `
      },
    })

    expect(calls).toEqual([
      { chunk: 'aaa', previousSummary: undefined },
      { chunk: 'bbb', previousSummary: 'aaa' },
      { chunk: 'ccc', previousSummary: 'aaa+bbb' },
    ])
    expect(summary).toBe('aaa+bbb+ccc')
  })

  it('builds context compact provider messages in core', () => {
    const messages = buildContextCompactSummaryMessages({
      chunk: 'user: hello',
      previousSummary: 'old summary',
    })

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({
      role: 'system',
    })
    // C5 双护栏:摘要请求喂的是一整段转录,里面全是指令和问句。
    expect(messages[0].content).toContain('context summarization assistant')
    expect(messages[0].content).toContain('Do NOT continue the conversation.')
    expect(messages[0].content).toContain('Do NOT respond to any questions in the conversation.')
    expect(messages[1]).toMatchObject({
      role: 'user',
    })
    expect(messages[1].content).toContain('<previous-summary>\nold summary\n</previous-summary>')
    expect(messages[1].content).toContain('<conversation>\nuser: hello\n</conversation>')
  })

  it('selects older messages while keeping the configured recent user turns', () => {
    const plan = selectCompactPlan(session([
      message(1, 'user'),
      message(2, 'assistant'),
      message(3, 'user'),
      message(4, 'assistant'),
      message(5, 'user'),
      message(6, 'assistant'),
      message(7, 'user'),
      message(8, 'assistant'),
    ]), 2)

    expect(plan?.cutoffMessage.id).toBe('assistant-4')
    expect(plan?.messagesToSummarize.map(item => item.id)).toEqual([
      'user-1',
      'assistant-2',
      'user-3',
      'assistant-4',
    ])
  })

  it('uses provider usage, local estimates, and hard-limit reserved output checks', async () => {
    const testSession = session([{ ...message(1, 'user'), content: 'x'.repeat(10000) }])

    await expect(shouldAutoCompactBeforeSend({
      session: testSession,
      modelContextLength: 100,
      thresholdPercent: 50,
    })).resolves.toBe(true)

    testSession.contextSize = 80
    await expect(shouldAutoCompactBeforeSend({
      session: testSession,
      modelContextLength: 100,
      thresholdPercent: 85,
      reservedOutputTokens: 25,
    })).resolves.toBe(true)
  })

  it('bases shared usage on built history instead of raw session tool results', () => {
    const hugeRawToolResult = 'x'.repeat(500000)
    const testSession = session([{
      ...message(1, 'assistant'),
      toolCalls: [{
        toolId: 'bash',
        toolName: 'bash',
        arguments: { cmd: 'cat huge.log' },
        status: 'completed',
        result: { output: hugeRawToolResult },
      }],
    }])
    testSession.contextSize = 52730
    testSession.lastInputTokens = 52730

    const builtHistory = [
      { role: 'user', content: 'short visible provider payload' },
    ]
    const usage = buildContextUsageSnapshot({
      session: testSession,
      historyMessages: builtHistory,
      modelContextLength: 272000,
      thresholdPercent: 85,
      reservedOutputTokens: 32768,
      providerId: 'codex',
      model: 'gpt-5.5',
    })

    expect(usage.visibleInputTokens).toBe(estimateTextTokens(JSON.stringify(builtHistory)))
    expect(usage.visibleInputTokens).toBeLessThan(1000)
    expect(usage.triggerReason).toBe('none')
    expect(estimateSessionInputTokens(testSession)).toBeGreaterThan(usage.visibleInputTokens * 10)
  })

  it('normalizes fenced markdown summaries and formats sanitized tool results', () => {
    // C5:合格 = 剥掉围栏后有 `## Goal` 标题(不再解析 JSON)。
    expect(normalizeContextSummaryOutput('```markdown\n## Goal\nShip compact\n```'))
      .toBe('## Goal\nShip compact')

    const summaryInput = formatMessagesForSummary([{
      ...message(1, 'assistant'),
      toolCalls: [{
        toolId: 'read',
        toolName: 'read',
        arguments: { path: '/tmp/large.txt' },
        status: 'completed',
        result: {
          output: 'important finding ' + 'x'.repeat(10000),
          originalContent: 'do not include rollback content',
        },
      }],
    }])

    expect(summaryInput).toContain('important finding')
    expect(summaryInput).toContain('[truncated')
    expect(summaryInput).not.toContain('do not include rollback content')
    expect(estimateSessionInputTokens(session([message(1, 'user')]))).toBeGreaterThan(0)
  })
})
