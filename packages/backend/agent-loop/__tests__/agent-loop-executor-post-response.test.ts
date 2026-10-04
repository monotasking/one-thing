import { describe, expect, it } from 'vitest'
import { lastUserMessageText, runAgentLoopPostResponseHooksWithAdapters } from '@onething/backend/agent-loop'
import { buildAgentLoopPostResponseContexts, enabledToolNames } from '../agent-loop-executor-post-response.js'

describe('core agent-loop executor helpers', () => {
  it('builds post-response context helpers', () => {
    expect(enabledToolNames({ toolNames: ['read'], mcpToolNames: ['mcp_search'] })).toEqual([
      'read',
      'mcp_search',
    ])
    expect(lastUserMessageText([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: [{ type: 'text', text: 'latest' }] },
    ])).toBe('latest')

    const contexts = buildAgentLoopPostResponseContexts({
      session: {
        id: 's1',
        name: 'Session',
        messages: [{ id: 'm1', role: 'user', content: 'latest' }],
      },
      sessionId: 's1',
      assistantMessageId: 'a1',
      lastAssistantMessage: 'assistant answer',
      historyMessages: [
        { role: 'user', content: 'first' },
        { role: 'user', content: [{ type: 'text', text: 'latest' }] },
      ],
      providerId: 'deepseek',
      providerConfig: { model: 'deepseek-chat' },
      settings: { ai: { provider: 'deepseek' } },
      toolIterations: 2,
      skillManageCalled: true,
      prepared: { toolNames: ['read'], mcpToolNames: ['mcp_search'] },
    })

    expect(contexts?.triggerContext).toMatchObject({
      sessionId: 's1',
      lastUserMessage: 'latest',
      lastAssistantMessage: 'assistant answer',
      providerId: 'deepseek',
      toolIterations: 2,
      skillManageCalled: true,
      enabledToolNames: ['read', 'mcp_search'],
    })
    expect(contexts?.afterAssistantResponseContext).toMatchObject({
      assistantMessageId: 'a1',
      lastAssistantMessage: 'assistant answer',
    })
    expect(buildAgentLoopPostResponseContexts({
      session: undefined,
      sessionId: 's1',
      assistantMessageId: 'a1',
      lastAssistantMessage: 'assistant answer',
      historyMessages: [],
      providerId: 'deepseek',
      providerConfig: {},
      settings: {},
      toolIterations: 0,
      skillManageCalled: false,
      prepared: { toolNames: [], mcpToolNames: [] },
    })).toBeNull()
  })

  it('runs post-response trigger and plugin hooks through core adapters', () => {
    const triggerCalls: unknown[] = []
    const afterCalls: unknown[] = []
    const errors: Array<{ source: string; message: string }> = []

    const contexts = runAgentLoopPostResponseHooksWithAdapters({
      sessionId: 's1',
      assistantMessageId: 'a1',
      lastAssistantMessage: 'assistant answer',
      historyMessages: [{ role: 'user', content: 'latest request' }],
      providerId: 'deepseek',
      providerConfig: { model: 'deepseek-chat' },
      settings: { ai: { provider: 'deepseek' } },
      toolIterations: 1,
      skillManageCalled: false,
      prepared: { toolNames: ['read'], mcpToolNames: [] },
      getSession: () => ({
        id: 's1',
        messages: [{ id: 'u1', role: 'user', content: 'latest request' }],
      }),
      runTriggerContext: context => {
        triggerCalls.push(context)
      },
      runAfterAssistantResponse: context => {
        afterCalls.push(context)
      },
      onError: (source, error) => {
        errors.push({ source, message: error instanceof Error ? error.message : String(error) })
      },
    })

    expect(contexts?.triggerContext).toMatchObject({
      sessionId: 's1',
      lastUserMessage: 'latest request',
      enabledToolNames: ['read'],
    })
    expect(triggerCalls).toHaveLength(1)
    expect(afterCalls).toHaveLength(1)
    expect(afterCalls[0]).toMatchObject({ assistantMessageId: 'a1' })
    expect(errors).toEqual([])

    expect(runAgentLoopPostResponseHooksWithAdapters({
      sessionId: 'missing',
      assistantMessageId: 'a1',
      lastAssistantMessage: 'assistant answer',
      historyMessages: [],
      providerId: 'deepseek',
      providerConfig: {},
      settings: {},
      toolIterations: 0,
      skillManageCalled: false,
      prepared: { toolNames: [], mcpToolNames: [] },
      getSession: () => undefined,
      runTriggerContext: () => {
        throw new Error('should not run')
      },
      runAfterAssistantResponse: () => {
        throw new Error('should not run')
      },
      onError: (source, error) => {
        errors.push({ source, message: error instanceof Error ? error.message : String(error) })
      },
    })).toBeNull()

    runAgentLoopPostResponseHooksWithAdapters({
      sessionId: 's1',
      assistantMessageId: 'a1',
      lastAssistantMessage: 'assistant answer',
      historyMessages: [],
      providerId: 'deepseek',
      providerConfig: {},
      settings: {},
      toolIterations: 0,
      skillManageCalled: false,
      prepared: { toolNames: [], mcpToolNames: [] },
      getSession: () => ({ messages: [] }),
      runTriggerContext: () => {
        throw new Error('trigger failed')
      },
      runAfterAssistantResponse: () => {
        throw new Error('after failed')
      },
      onError: (source, error) => {
        errors.push({ source, message: error instanceof Error ? error.message : String(error) })
      },
    })

    expect(errors).toEqual([
      { source: 'trigger', message: 'trigger failed' },
      { source: 'afterAssistantResponse', message: 'after failed' },
    ])
  })
})
