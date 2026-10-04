import { describe, expect, it } from 'vitest'
import { getAgentLoopTransientTail, runAgentLoopAfterTurnWithAdapters, runAgentLoopBeforeTurnWithAdapters } from '@onething/backend/agent-loop'
import { buildPendingAgentLoopMessageInjections, resolvePendingAgentLoopMessages } from '../agent-loop-runtime-turn.js'

describe('core agent-loop runtime helpers', () => {
  it('keeps the current in-memory tool turn tail when rebuilding compacted messages', () => {
    expect(getAgentLoopTransientTail([
      { role: 'system', content: 'summary' },
      { role: 'user', content: 'question' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'read', arguments: '{"path":"a"}' }],
      },
      { role: 'tool', toolCallId: 'call_1', content: 'file text' },
    ])).toEqual([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'read', arguments: '{"path":"a"}' }],
      },
      { role: 'tool', toolCallId: 'call_1', content: 'file text' },
    ])
  })

  it('builds pending steering/follow-up message injections without store or event bus', () => {
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'original question' },
    ]

    expect(buildPendingAgentLoopMessageInjections(messages, [])).toBeUndefined()

    let nextId = 0
    const resolvedPendingMessages = resolvePendingAgentLoopMessages([
      {
        content: 'please @skill continue',
        timestamp: 100,
      },
      {
        content: 'and summarize',
        timestamp: 200,
      },
    ], {
      createId: () => `message-${++nextId}`,
      resolvePromptReferences: content => ({
        modelContent: content.replace('@skill ', ''),
        contentParts: [{ type: 'text', content }],
      }),
    })

    expect(resolvedPendingMessages).toEqual([
      {
        id: 'message-1',
        modelContent: 'please continue',
        timestamp: 100,
        contentParts: [{ type: 'text', content: 'please @skill continue' }],
      },
      {
        id: 'message-2',
        modelContent: 'and summarize',
        timestamp: 200,
        contentParts: [{ type: 'text', content: 'and summarize' }],
      },
    ])

    const injection = buildPendingAgentLoopMessageInjections(messages, resolvedPendingMessages)

    expect(injection?.messages).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'original question' },
      { role: 'user', content: 'please continue' },
      { role: 'user', content: 'and summarize' },
    ])
    expect(injection?.messages[0]).not.toBe(messages[0])
    expect(injection?.chatMessages).toEqual([
      {
        id: 'message-1',
        role: 'user',
        content: 'please continue',
        timestamp: 100,
        contentParts: [{ type: 'text', content: 'please @skill continue' }],
      },
      {
        id: 'message-2',
        role: 'user',
        content: 'and summarize',
        timestamp: 200,
        contentParts: [{ type: 'text', content: 'and summarize' }],
      },
    ])
  })

  it('injects already-persisted steering messages without persisting them again', async () => {
    const persisted: unknown[] = []

    const replacement = await runAgentLoopBeforeTurnWithAdapters({
      ctx: {
        sessionId: 's1',
        providerId: 'deepseek',
        providerConfig: { model: 'deepseek-chat' },
        settings: {},
      },
      turn: 1,
      messages: [{ role: 'user', content: 'original question' }],
      budget: {
        modelContextLength: 1000,
        reservedOutputTokens: 100,
        thresholdPercent: 80,
      },
      compactEnabled: false,
      keepRecentTurns: 3,
      rebuildMessages: async messages => messages as Array<{ role: string; content: string }>,
      adapters: {
        createPendingMessageId: () => 'unused-id',
        resolvePromptReferences: content => ({
          modelContent: `resolved:${content}`,
          contentParts: [{ type: 'text', content }],
        }),
        persistInjectedChatMessage: message => {
          persisted.push(message)
        },
        drainSteeringMessages: () => [{
          content: 'raw steer text',
          timestamp: 123,
          id: 'steer-message-id',
          modelContent: 'resolved steer text',
          contentParts: [{ type: 'text', content: 'raw steer text' }],
          persisted: true,
        }],
        getSession: () => ({
          contextSize: 0,
          lastInputTokens: 0,
          messages: [],
        }),
        compactSessionContext: async () => ({
          success: true,
          retainedContextSize: 0,
        }),
        emitEvent: async () => undefined,
        logger: {},
      },
    })

    expect(persisted).toEqual([])
    expect(replacement).toEqual({
      startNewResponse: true,
      messages: [
        { role: 'user', content: 'original question' },
        { role: 'user', content: 'resolved steer text' },
      ],
    })
  })

  it('runs before-turn steering injection before context compaction in core', async () => {
    let session = {
      contextSize: 95,
      lastInputTokens: 95,
      messages: [],
    }
    const persisted: unknown[] = []
    const rebuildInputs: unknown[] = []
    const compactCalls: unknown[] = []
    const originalContent = 'x'.repeat(360)

    const replacement = await runAgentLoopBeforeTurnWithAdapters({
      ctx: {
        sessionId: 's1',
        providerId: 'deepseek',
        providerConfig: { model: 'deepseek-chat' },
        settings: {},
      },
      turn: 2,
      messages: [{ role: 'user', content: originalContent }],
      budget: {
        modelContextLength: 100,
        reservedOutputTokens: 10,
        thresholdPercent: 80,
      },
      compactEnabled: true,
      keepRecentTurns: 3,
      rebuildMessages: async messages => {
        rebuildInputs.push(messages)
        return [{ role: 'user', content: 'rebuilt' }]
      },
      adapters: {
        createPendingMessageId: () => 'steering-message',
        resolvePromptReferences: content => ({
          modelContent: content.toUpperCase(),
          contentParts: [{ type: 'text', content }],
        }),
        persistInjectedChatMessage: message => {
          persisted.push(message)
        },
        drainSteeringMessages: () => [{ content: 'steer', timestamp: 123 }],
        getSession: () => session,
        compactSessionContext: async input => {
          compactCalls.push(input)
          session = {
            contextSize: 20,
            lastInputTokens: 20,
            messages: [],
          }
          return {
            success: true,
            retainedContextSize: 20,
          }
        },
        emitEvent: async () => undefined,
        logger: {},
      },
    })

    expect(persisted).toEqual([{
      id: 'steering-message',
      role: 'user',
      content: 'STEER',
      timestamp: 123,
      contentParts: [{ type: 'text', content: 'steer' }],
    }])
    expect(compactCalls).toHaveLength(1)
    expect(rebuildInputs).toEqual([[
      { role: 'user', content: originalContent },
      { role: 'user', content: 'STEER' },
    ]])
    expect(replacement).toEqual({
      startNewResponse: true,
      messages: [{ role: 'user', content: 'rebuilt' }],
    })
  })

  it('runs after-turn steering before follow-up messages in core', async () => {
    let followUpDrained = false
    const persisted: unknown[] = []

    const replacement = await runAgentLoopAfterTurnWithAdapters({
      messages: [{ role: 'assistant', content: 'done' }],
      adapters: {
        createPendingMessageId: () => 'after-steering-message',
        resolvePromptReferences: content => ({
          modelContent: content,
        }),
        persistInjectedChatMessage: message => {
          persisted.push(message)
        },
        drainSteeringMessages: () => [{ content: 'steer after', timestamp: 456 }],
        drainFollowUpMessages: () => {
          followUpDrained = true
          return [{ content: 'follow up', timestamp: 789 }]
        },
      },
    })

    expect(followUpDrained).toBe(false)
    expect(persisted).toEqual([{
      id: 'after-steering-message',
      role: 'user',
      content: 'steer after',
      timestamp: 456,
      contentParts: undefined,
    }])
    expect(replacement).toEqual([
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'steer after' },
    ])
  })
})
