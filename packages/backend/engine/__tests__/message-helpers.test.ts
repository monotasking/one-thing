import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/ipc.js'
import {
  buildHistoryMessages,
  collapseSupersededGoalDrives,
  filterHistoryForNonToolAPI,
  sanitizeToolResultForAI,
} from '../stream/message-helpers.js'

function message(index: number, role: 'user' | 'assistant'): ChatMessage {
  return {
    id: `${role}-${index}`,
    role,
    content: `${role} ${index}`,
    timestamp: index,
  }
}

describe('collapseSupersededGoalDrives', () => {
  function goalDrive(index: number, content = 'Continue working toward the active session goal. <long template>'): ChatMessage {
    return {
      id: `goal-${index}`,
      role: 'user',
      content,
      timestamp: index,
      origin: { transport: 'api', source: 'goal', receivedAt: index },
    } as ChatMessage
  }

  it('keeps only the newest goal drive verbatim and shrinks older ones to a marker', () => {
    const messages = [
      message(1, 'user'),
      message(2, 'assistant'),
      goalDrive(3),
      message(4, 'assistant'),
      goalDrive(5),
      message(6, 'assistant'),
      goalDrive(7),
    ]

    const collapsed = collapseSupersededGoalDrives(messages)

    expect(collapsed[2].content).toContain('superseded')
    expect(collapsed[4].content).toContain('superseded')
    expect(collapsed[6].content).toBe(goalDrive(7).content)
    // Roles preserved so provider role alternation stays intact.
    expect(collapsed.map(m => m.role)).toEqual(messages.map(m => m.role))
    // Non-goal messages untouched.
    expect(collapsed[0]).toBe(messages[0])
    expect(collapsed[1]).toBe(messages[1])
  })

  it('returns the array unchanged when no goal drives exist', () => {
    const messages = [message(1, 'user'), message(2, 'assistant')]
    expect(collapseSupersededGoalDrives(messages)).toBe(messages)
  })
})

describe('buildHistoryMessages', () => {
  it('uses summary plus recent messages when the summary anchor exists', () => {
    const history = buildHistoryMessages(
      [
        message(1, 'user'),
        message(2, 'assistant'),
        message(3, 'user'),
      ],
      {
        id: 's1',
        summary: 'Earlier context',
        summaryUpToMessageId: 'assistant-2',
      },
    )

    // C5(2026-08-14):注入是**单条** user(带 <summary> 标签),伪造的
    // assistant 握手已删 —— 交替归 provider 适配层的相邻同角色合并。
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('<summary>\nEarlier context\n</summary>'),
    })
    expect(history[1]).toMatchObject({ role: 'user', content: 'user 3' })
  })

  it('does not use a summary when the summary anchor is missing', () => {
    const history = buildHistoryMessages(
      [
        message(1, 'user'),
        message(2, 'assistant'),
      ],
      {
        id: 's1',
        summary: 'Stale context',
        summaryUpToMessageId: 'missing-message',
      },
    )

    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({ role: 'user', content: 'user 1' })
    expect(history[1]).toMatchObject({ role: 'assistant', content: 'assistant 2' })
  })

  it('labels user history with trusted channel actor without mutating stored content', () => {
    const stored = {
      ...message(1, 'user'),
      content: 'Can you summarize the thread?',
      origin: {
        transport: 'im',
        source: 'slack',
        actor: {
          externalUserId: 'u-1',
          displayName: 'Alice',
          handle: 'alice',
        },
        conversation: {
          connector: 'slack',
          externalConversationId: 'c-1',
          type: 'thread',
        },
        receivedAt: 123,
      },
    } satisfies ChatMessage

    const history = buildHistoryMessages([stored])

    expect(stored.content).toBe('Can you summarize the thread?')
    expect(history[0]).toMatchObject({
      role: 'user',
      content: 'Alice said:\nCan you summarize the thread?',
    })
  })

  it('keeps the full compacted tail without budget trimming', () => {
    // Budget trimming of the compacted tail was tried and deliberately
    // removed: degraded mode shrank assistants but not users, so a fat user
    // message could be dropped while its assistant reply survived — breaking
    // user/assistant alternation. Every retained message ships whole.
    const history = buildHistoryMessages(
      [
        message(1, 'user'),
        message(2, 'assistant'),
        { ...message(3, 'user'), content: `old retained ${'a'.repeat(140_000)}` },
        { ...message(4, 'assistant'), content: `middle retained ${'b'.repeat(140_000)}` },
        { ...message(5, 'user'), content: `latest retained ${'c'.repeat(140_000)}` },
      ],
      {
        id: 's1',
        summary: 'Earlier context',
        summaryUpToMessageId: 'assistant-2',
      },
    )

    const joined = JSON.stringify(history)
    expect(joined).toContain('old retained')
    expect(joined).toContain('middle retained')
    expect(joined).toContain('latest retained')
  })

  it('summarizes oversized tool results in compacted retained history', () => {
    const history = buildHistoryMessages(
      [
        message(1, 'user'),
        message(2, 'assistant'),
        {
          ...message(3, 'assistant'),
          toolCalls: [{
            id: 'call_1',
            toolId: 'read',
            toolName: 'read',
            arguments: { path: '/tmp/large.txt' },
            status: 'completed',
            result: {
              title: 'Read large file',
              output: 'x'.repeat(80_000),
            },
            timestamp: 3,
          }],
        },
      ],
      {
        id: 's1',
        summary: 'Earlier context',
        summaryUpToMessageId: 'assistant-2',
      },
    )

    const toolMessage = history.find(item => item.role === 'tool')
    expect(toolMessage).toBeDefined()
    expect(JSON.stringify(toolMessage)).not.toContain('x'.repeat(10_000))
    expect(toolMessage).toMatchObject({
      role: 'tool',
      content: [{
        result: {
          truncated: true,
          title: 'Read large file',
          originalChars: expect.any(Number),
        },
      }],
    })
  })

  it('summarizes oversized failed tool results in compacted retained history', () => {
    const history = buildHistoryMessages(
      [
        message(1, 'user'),
        message(2, 'assistant'),
        {
          ...message(3, 'assistant'),
          toolCalls: [{
            id: 'call_failed',
            toolId: 'web_search',
            toolName: 'web_search',
            arguments: { query: 'docs' },
            status: 'failed',
            error: 'x'.repeat(80_000),
            timestamp: 3,
          }],
        },
      ],
      {
        id: 's1',
        summary: 'Earlier context',
        summaryUpToMessageId: 'assistant-2',
      },
    )

    const toolMessage = history.find(item => item.role === 'tool')
    expect(JSON.stringify(toolMessage)).not.toContain('x'.repeat(10_000))
    expect(toolMessage).toMatchObject({
      role: 'tool',
      content: [{
        result: {
          truncated: true,
          originalChars: expect.any(Number),
        },
      }],
    })
  })
})

describe('sanitizeToolResultForAI', () => {
  it('removes file rollback content and hashes recursively', () => {
    const result = sanitizeToolResultForAI({
      title: 'Edited file',
      metadata: {
        originalContent: 'secret file contents',
        originalContentHash: 'sha256',
        diff: 'diff text',
        nested: {
          originalContent: 'nested secret',
          originalContentHash: 'nested hash',
          keep: true,
        },
      },
      list: [
        {
          originalContent: 'array secret',
          originalContentHash: 'array hash',
          keep: 'value',
        },
      ],
    })

    expect(result).toEqual({
      title: 'Edited file',
      metadata: {
        diff: 'diff text',
        nested: {
          keep: true,
        },
      },
      list: [
        {
          keep: 'value',
        },
      ],
    })
  })
})

describe('filterHistoryForNonToolAPI', () => {
  it('keeps user and assistant messages through the runtime sessions facade', () => {
    expect(filterHistoryForNonToolAPI([
      { role: 'user', content: 'hello' },
      {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'read',
          result: { output: 'ok' },
        }],
      },
      { role: 'assistant', content: 'done', reasoningContent: 'read completed' },
    ])).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'done', reasoningContent: 'read completed' },
    ])
  })
})

describe('faithful multi-completion rebuild', () => {
  function multiTurnAssistant(overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
      id: 'assistant-multi',
      role: 'assistant',
      content: 'restoring the map\n\nall clean now',
      timestamp: 10,
      contentParts: [
        { type: 'text', content: 'restoring the map', turnIndex: 1 },
        { type: 'reasoning', content: 'checking results', turnIndex: 2 },
        { type: 'text', content: 'all clean now', turnIndex: 2 },
      ],
      steps: [
        { id: 's1', type: 'tool-call', title: 'grep', status: 'completed', timestamp: 1, toolCallId: 'call_1', turnIndex: 1 },
        { id: 's2', type: 'tool-call', title: 'edit', status: 'completed', timestamp: 2, toolCallId: 'call_2', turnIndex: 1 },
        { id: 's3', type: 'tool-call', title: 'bash', status: 'completed', timestamp: 3, toolCallId: 'call_3', turnIndex: 2 },
      ],
      toolCalls: [
        { id: 'call_1', toolName: 'bash', arguments: { command: 'grep x' }, status: 'completed', result: { output: 'line 7' } },
        { id: 'call_2', toolName: 'edit', arguments: { filePath: 'a.lua' }, status: 'failed', error: 'Could not find' },
        { id: 'call_3', toolName: 'bash', arguments: { command: 'luac -p' }, status: 'completed', result: { output: 'PASS' } },
      ],
      ...overrides,
    } as unknown as ChatMessage
  }

  it('replays each completion as its own assistant/tool element pair', () => {
    const history = buildHistoryMessages([message(1, 'user'), multiTurnAssistant()])

    expect(history.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool'])

    const first = history[1] as Extract<typeof history[number], { role: 'assistant' }>
    expect(first.content).toBe('restoring the map')
    expect(first.toolCalls?.map(c => c.toolCallId)).toEqual(['call_1', 'call_2'])
    expect(first.reasoningContent).toBeUndefined()

    const firstResults = history[2] as Extract<typeof history[number], { role: 'tool' }>
    expect(firstResults.content.map(r => r.toolCallId)).toEqual(['call_1', 'call_2'])

    const second = history[3] as Extract<typeof history[number], { role: 'assistant' }>
    expect(second.content).toBe('all clean now')
    expect(second.reasoningContent).toBe('checking results')
    expect(second.toolCalls?.map(c => c.toolCallId)).toEqual(['call_3'])

    const secondResults = history[4] as Extract<typeof history[number], { role: 'tool' }>
    expect(secondResults.content.map(r => r.toolCallId)).toEqual(['call_3'])
  })

  it('keeps failed tool calls paired with their failure results in the right turn', () => {
    const history = buildHistoryMessages([message(1, 'user'), multiTurnAssistant()])
    const firstResults = history[2] as Extract<typeof history[number], { role: 'tool' }>
    const failed = firstResults.content.find(r => r.toolCallId === 'call_2')
    expect(JSON.stringify(failed?.result)).toContain('Could not find')
  })

  it('falls back to the collapsed shape when parts lack turnIndex (legacy messages)', () => {
    const legacy = multiTurnAssistant({
      contentParts: [
        { type: 'text', content: 'restoring the map' },
        { type: 'text', content: 'all clean now' },
      ],
    } as Partial<ChatMessage>)
    const history = buildHistoryMessages([message(1, 'user'), legacy])

    expect(history.map(m => m.role)).toEqual(['user', 'assistant', 'tool'])
    const assistant = history[1] as Extract<typeof history[number], { role: 'assistant' }>
    expect(assistant.toolCalls?.length).toBe(3)
  })

  it('falls back to the collapsed shape when a tool call has no step mapping', () => {
    const orphan = multiTurnAssistant({
      steps: [
        { id: 's1', type: 'tool-call', title: 'grep', status: 'completed', timestamp: 1, toolCallId: 'call_1', turnIndex: 1 },
        { id: 's3', type: 'tool-call', title: 'bash', status: 'completed', timestamp: 3, toolCallId: 'call_3', turnIndex: 2 },
      ],
    } as Partial<ChatMessage>)
    const history = buildHistoryMessages([message(1, 'user'), orphan])

    expect(history.map(m => m.role)).toEqual(['user', 'assistant', 'tool'])
  })

  it('keeps single-completion messages on the collapsed path unchanged', () => {
    const single = multiTurnAssistant({
      contentParts: [{ type: 'text', content: 'restoring the map', turnIndex: 1 }],
      steps: [
        { id: 's1', type: 'tool-call', title: 'grep', status: 'completed', timestamp: 1, toolCallId: 'call_1', turnIndex: 1 },
        { id: 's2', type: 'tool-call', title: 'edit', status: 'completed', timestamp: 2, toolCallId: 'call_2', turnIndex: 1 },
        { id: 's3', type: 'tool-call', title: 'bash', status: 'completed', timestamp: 3, toolCallId: 'call_3', turnIndex: 1 },
      ],
      content: 'restoring the map',
    } as Partial<ChatMessage>)
    const history = buildHistoryMessages([message(1, 'user'), single])

    expect(history.map(m => m.role)).toEqual(['user', 'assistant', 'tool'])
    const results = history[2] as Extract<typeof history[number], { role: 'tool' }>
    expect(results.content.map(r => r.toolCallId)).toEqual(['call_1', 'call_2', 'call_3'])
  })
})
