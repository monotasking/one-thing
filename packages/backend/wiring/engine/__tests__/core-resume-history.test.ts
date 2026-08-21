import { describe, expect, it } from 'vitest'
import {
  buildCompactedToolResultContent,
  buildHistoryMessages,
  buildResumeHistoryAfterToolConfirmation,
  filterHistoryForNonToolAPI,
  getHistoryProviderData,
  getMessageReasoningContent,
  historyMessagesForLog,
  sanitizeToolResultForAI,
  type CoreHistoryMessage,
  type CoreHistoryChatMessage,
} from '@onething/core/engine'
import { providerDataFromOnethingContentPart } from '@onething/runtime/agent-loop/providers'

describe('core resume history', () => {
  it('appends the paused assistant tool call and confirmed tool result messages', () => {
    const history: CoreHistoryMessage[] = [
      { role: 'user', content: 'delete tmp' },
    ]

    expect(buildResumeHistoryAfterToolConfirmation(history, {
      content: 'I need to run a command.',
      reasoning: 'The user asked for cleanup.',
      toolCalls: [
        {
          id: 'call_1',
          toolId: 'bash',
          toolName: 'Bash',
          arguments: { cmd: 'rm -rf tmp' },
          status: 'completed',
          result: { output: 'removed', originalContent: 'secret' },
        },
        {
          id: 'call_2',
          toolId: 'write',
          toolName: 'Write',
          arguments: { path: '/tmp/a.txt' },
          status: 'failed',
          error: 'Denied',
        },
      ],
    })).toEqual([
      { role: 'user', content: 'delete tmp' },
      {
        role: 'assistant',
        content: 'I need to run a command.',
        reasoningContent: 'The user asked for cleanup.',
        toolCalls: [
          {
            toolCallId: 'call_1',
            toolName: 'bash',
            args: { cmd: 'rm -rf tmp' },
          },
          {
            toolCallId: 'call_2',
            toolName: 'write',
            args: { path: '/tmp/a.txt' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'bash',
            result: { output: 'removed' },
          },
          {
            type: 'tool-result',
            toolCallId: 'call_2',
            toolName: 'write',
            // status marks the tool_result as an error for providers that
            // carry an explicit failure flag (Anthropic is_error).
            result: { error: 'Denied', status: 'failed' },
          },
        ],
      },
    ])
  })

  it('sanitizes internal diff payload fields recursively', () => {
    expect(sanitizeToolResultForAI({
      ok: true,
      originalContent: 'before',
      nested: {
        originalContentHash: 'hash',
        value: 'kept',
      },
    })).toEqual({
      ok: true,
      nested: {
        value: 'kept',
      },
    })
  })

  it('summarizes oversized tool results in compacted content', () => {
    const result = buildCompactedToolResultContent([{
      id: 'call_1',
      toolId: 'read',
      toolName: 'read',
      arguments: { path: '/tmp/large.txt' },
      status: 'completed',
      result: {
        title: 'Read large file',
        output: 'x'.repeat(80_000),
      },
    }])

    expect(result).toMatchObject([{
      toolCallId: 'call_1',
      toolName: 'read',
      result: {
        truncated: true,
        title: 'Read large file',
        originalChars: expect.any(Number),
      },
    }])
  })

  it('extracts reasoning fragments and strips tool messages for non-tool APIs', () => {
    expect(getHistoryProviderData({
      id: 'm1',
      role: 'assistant',
      contentParts: [
        { type: 'provider-data', providerData: { provider: 'codex', type: 'encrypted-reasoning', encryptedContent: 'secret' } },
      ],
    })).toEqual([{ provider: 'codex', type: 'encrypted-reasoning', encryptedContent: 'secret' }])

    expect(getHistoryProviderData({
      id: 'm1-legacy',
      role: 'assistant',
      contentParts: [
        { type: 'provider-data', provider: 'codex', encryptedReasoning: 'legacy-secret' },
      ],
    }, {
      providerDataFromContentPart: providerDataFromOnethingContentPart,
    })).toEqual([{ provider: 'codex', type: 'encrypted-reasoning', encryptedContent: 'legacy-secret' }])

    expect(getMessageReasoningContent({
      id: 'm2',
      role: 'assistant',
      reasoning: 'think',
      contentParts: [
        { type: 'reasoning', content: 'think' },
        { type: 'reasoning', content: 'more' },
      ],
    })).toBe('think\n\nmore')

    expect(filterHistoryForNonToolAPI([
      { role: 'user', content: 'hello' },
      { role: 'tool', content: [] },
      { role: 'assistant', content: 'hi', reasoningContent: 'because' },
    ])).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi', reasoningContent: 'because' },
    ])

    expect(historyMessagesForLog([
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: 'working',
        reasoningContent: 'because',
        toolCalls: [{ toolCallId: 'call_1', toolName: 'read', args: { path: '/tmp/a.txt' } }],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'read', result: { output: 'ok' } }],
      },
    ])).toEqual([
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: 'working',
        reasoningContent: 'because',
        toolCalls: [{ toolCallId: 'call_1', toolName: 'read', args: { path: '/tmp/a.txt' } }],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'read', result: { output: 'ok' } }],
      },
    ])
  })

  it('builds provider history with reasoning and tool result context in core', () => {
    const messages: CoreHistoryChatMessage[] = [
      { id: 'u1', role: 'user', content: 'hello' },
      { id: 'skip-streaming', role: 'assistant', content: 'typing', isStreaming: true },
      { id: 'skip-empty', role: 'assistant', content: '' },
      {
        id: 'a1',
        role: 'assistant',
        content: 'I will read it.',
        reasoning: 'Need file contents.',
        contentParts: [
          { type: 'provider-data', provider: 'codex', encryptedReasoning: 'encrypted' },
        ],
        toolCalls: [
          {
            id: 'call_1',
            toolId: 'read',
            toolName: 'Read',
            arguments: { path: '/tmp/a.txt' },
            status: 'completed',
            result: { output: 'ok', originalContent: 'hidden' },
          },
          {
            id: 'call_2',
            toolId: 'bash',
            toolName: 'Bash',
            arguments: { cmd: 'false' },
            status: 'failed',
            error: 'Nope',
          },
        ],
      },
    ]

    expect(buildHistoryMessages(messages, undefined, {
      buildMessageContent: message => `content:${message.id}`,
      getAIToolName: name => `ai:${name}`,
      failureResultForAI: toolCall => ({ error: `failed:${toolCall.error}` }),
      providerDataFromContentPart: providerDataFromOnethingContentPart,
    })).toEqual([
      { role: 'user', content: 'content:u1' },
      {
        role: 'assistant',
        content: 'content:a1',
        reasoningContent: 'Need file contents.',
        providerData: [{ provider: 'codex', type: 'encrypted-reasoning', encryptedContent: 'encrypted' }],
        toolCalls: [
          { toolCallId: 'call_1', toolName: 'ai:read', args: { path: '/tmp/a.txt' } },
          { toolCallId: 'call_2', toolName: 'ai:bash', args: { cmd: 'false' } },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'call_1', toolName: 'ai:read', result: { output: 'ok' } },
          { type: 'tool-result', toolCallId: 'call_2', toolName: 'ai:bash', result: { error: 'failed:Nope' } },
        ],
      },
    ])
  })

  it('builds compacted provider history and reports retained-message metadata in core', () => {
    const messages: CoreHistoryChatMessage[] = [
      { id: 'u1', role: 'user', content: 'old' },
      { id: 'a1', role: 'assistant', content: 'anchor' },
      {
        id: 'a2',
        role: 'assistant',
        content: 'recent',
        contentParts: [
          { type: 'provider-data', provider: 'codex', encryptedReasoning: 'kept-only-on-latest' },
        ],
      },
    ]
    const compactedLogs: unknown[] = []

    const history = buildHistoryMessages(messages, {
      id: 's1',
      summary: 'Earlier summary',
      summaryUpToMessageId: 'a1',
    }, {
      buildMessageContent: message => `content:${message.id}`,
      providerDataFromContentPart: providerDataFromOnethingContentPart,
      onCompactedHistory: details => compactedLogs.push(details),
    })

    expect(history).toEqual([
      // C5(2026-08-14):注入只剩这一条 user。伪造的 assistant 握手已删 ——
      // 交替风险归 provider 适配层的相邻同角色合并。
      {
        role: 'user',
        content: 'The conversation history before this point was compacted into the following summary:\n\n<summary>\nEarlier summary\n</summary>',
      },
      {
        role: 'assistant',
        content: 'content:a2',
        providerData: [{ provider: 'codex', type: 'encrypted-reasoning', encryptedContent: 'kept-only-on-latest' }],
      },
    ])
    expect(compactedLogs).toHaveLength(1)
    expect(compactedLogs[0]).toMatchObject({
      sessionId: 's1',
      summaryUpToMessageId: 'a1',
      summaryIndex: 1,
      totalSessionMessages: 3,
      recentSessionMessages: 1,
      retainedRecentMessages: 1,
      droppedRecentMessages: 0,
      summaryChars: 'Earlier summary'.length,
    })
  })

  it('C5:摘要注入是单条 user + <summary> 标签,没有伪造的 assistant 握手', () => {
    const history = buildHistoryMessages([
      { id: 'u1', role: 'user', content: 'old' },
      { id: 'a1', role: 'assistant', content: 'anchor' },
      { id: 'u2', role: 'user', content: 'continue please' },
    ], {
      id: 's1',
      summary: '## Goal\nShip C5',
      summaryUpToMessageId: 'a1',
    }, {
      buildMessageContent: message => `content:${message.id}`,
      providerDataFromContentPart: providerDataFromOnethingContentPart,
    })

    expect(history[0]).toEqual({
      role: 'user',
      content: 'The conversation history before this point was compacted into the following summary:\n\n<summary>\n## Goal\nShip C5\n</summary>',
    })
    // 握手已删:注入之后紧接着的就是被保留的最近一轮真消息。连续两条 user 的
    // 交替风险由 provider 适配层的相邻同角色合并兜底,不在历史里造假消息。
    expect(history[1]).toEqual({ role: 'user', content: 'content:u2' })
    expect(JSON.stringify(history)).not.toContain('Understood')
  })
})
