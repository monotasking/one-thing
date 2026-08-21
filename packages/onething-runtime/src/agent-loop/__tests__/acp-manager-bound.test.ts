import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ACPPromptStreamEvent, ACPPromptStreamOptions } from '@onething/runtime/acp'
import { createACPAgentProvider } from '../providers/acp-manager-bound.js'
import type { AgentTurnStreamEvent } from '@onething/core/agent-loop'

interface ACPStreamCall {
  agentId: string
  options: ACPPromptStreamOptions
}

const acpMocks = vi.hoisted(() => ({
  streamPrompt: vi.fn(),
}))

vi.mock('@onething/runtime/acp', () => ({
  ACPManager: {
    streamPrompt: acpMocks.streamPrompt,
  },
}))

function textUpdate(sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk', text: string): ACPPromptStreamEvent {
  return {
    type: 'update',
    notification: {
      sessionId: 'acp-session',
      update: {
        sessionUpdate,
        content: { type: 'text', text },
      },
    },
  }
}

async function* acpEvents(events: ACPPromptStreamEvent[]): AsyncGenerator<ACPPromptStreamEvent, void, void> {
  for (const event of events) {
    yield event
  }
}

describe('ACP agent provider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('streams ACP message, thought, warning, and finish events as agent turn events', async () => {
    const controller = new AbortController()
    const calls: ACPStreamCall[] = []
    acpMocks.streamPrompt.mockImplementation((agentId: string, options: ACPPromptStreamOptions) => {
      calls.push({ agentId, options })
      return acpEvents([
        textUpdate('agent_thought_chunk', 'thinking'),
        { type: 'warning', message: 'heads up' },
        textUpdate('agent_message_chunk', 'hello'),
        {
          type: 'finish',
          stopReason: 'end_turn',
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        },
      ])
    })

    const provider = createACPAgentProvider({
      workingDirectory: '/tmp/project',
      localSessionId: 'local-acp-session',
    })
    if (!provider.streamTurn) throw new Error('ACP provider did not expose streamTurn')

    const events: AgentTurnStreamEvent[] = []
    for await (const event of provider.streamTurn({
      model: 'claude-code',
      messages: [
        { role: 'system', content: 'project notes' },
        { role: 'user', content: 'run checks' },
      ],
      abortSignal: controller.signal,
      turn: 7,
    })) {
      events.push(event)
    }

    expect(calls).toEqual([{
      agentId: 'claude-code',
      options: {
        localSessionId: 'local-acp-session',
        prompt: 'run checks',
        cwd: '/tmp/project',
        abortSignal: controller.signal,
      },
    }])
    expect(events).toEqual([
      { type: 'reasoning-delta', turn: 7, delta: 'thinking' },
      { type: 'reasoning-delta', turn: 7, delta: 'heads up' },
      { type: 'text-delta', turn: 7, delta: 'hello' },
      {
        type: 'finish',
        turn: 7,
        finishReason: 'stop',
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      },
    ])
  })

  it('maps tool_call notifications to structured externally-executed tool events', async () => {
    acpMocks.streamPrompt.mockImplementation(() => acpEvents([
      {
        type: 'update',
        notification: {
          sessionId: 'acp-session',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-1',
            title: 'Run ls',
            kind: 'execute',
            status: 'pending',
            rawInput: { command: 'ls' },
          },
        },
      } as unknown as ACPPromptStreamEvent,
      {
        type: 'update',
        notification: {
          sessionId: 'acp-session',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc-1',
            content: [{ type: 'content', content: { type: 'text', text: 'file-a' } }],
          },
        },
      } as unknown as ACPPromptStreamEvent,
      {
        type: 'update',
        notification: {
          sessionId: 'acp-session',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc-1',
            status: 'completed',
          },
        },
      } as unknown as ACPPromptStreamEvent,
      // A second call that never reports completion: must settle on finish.
      {
        type: 'update',
        notification: {
          sessionId: 'acp-session',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-2',
            title: 'Edit file',
            kind: 'edit',
            status: 'in_progress',
          },
        },
      } as unknown as ACPPromptStreamEvent,
      { type: 'finish', stopReason: 'end_turn' },
    ]))

    const provider = createACPAgentProvider({ workingDirectory: '/tmp/project' })
    if (!provider.streamTurn) throw new Error('ACP provider did not expose streamTurn')

    const events: AgentTurnStreamEvent[] = []
    for await (const event of provider.streamTurn({
      model: 'claude-code',
      messages: [{ role: 'user', content: 'list files' }],
      turn: 1,
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      { type: 'tool-call-start', turn: 1, toolCallId: 'tc-1', toolName: 'execute' },
      {
        type: 'tool-call-done',
        turn: 1,
        toolCall: { id: 'tc-1', name: 'execute', arguments: '{"command":"ls"}', externallyExecuted: true },
      },
      {
        type: 'tool-metadata',
        turn: 1,
        toolCall: { id: 'tc-1', name: 'execute', arguments: '{"command":"ls"}', externallyExecuted: true },
        update: { title: 'Run ls' },
      },
      {
        type: 'tool-partial-result',
        turn: 1,
        toolCall: { id: 'tc-1', name: 'execute', arguments: '{"command":"ls"}', externallyExecuted: true },
        update: { content: [{ type: 'text', text: 'file-a' }] },
      },
      {
        type: 'tool-result',
        turn: 1,
        toolCall: { id: 'tc-1', name: 'execute', arguments: '{"command":"ls"}', externallyExecuted: true },
        result: { content: 'file-a' },
      },
      { type: 'tool-call-start', turn: 1, toolCallId: 'tc-2', toolName: 'edit' },
      {
        type: 'tool-call-done',
        turn: 1,
        toolCall: { id: 'tc-2', name: 'edit', arguments: '{}', externallyExecuted: true },
      },
      {
        type: 'tool-metadata',
        turn: 1,
        toolCall: { id: 'tc-2', name: 'edit', arguments: '{}', externallyExecuted: true },
        update: { title: 'Edit file' },
      },
      // Unreported completion settles before finish so steps reach a terminal state.
      {
        type: 'tool-result',
        turn: 1,
        toolCall: { id: 'tc-2', name: 'edit', arguments: '{}', externallyExecuted: true },
        result: { content: '' },
      },
      { type: 'finish', turn: 1, finishReason: 'stop', usage: undefined },
    ])
  })

  it('settles unfinished tool calls as aborted when the ACP turn is cancelled', async () => {
    acpMocks.streamPrompt.mockImplementation(() => acpEvents([
      {
        type: 'update',
        notification: {
          sessionId: 'acp-session',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-1',
            title: 'Slow command',
            kind: 'execute',
            status: 'in_progress',
          },
        },
      } as unknown as ACPPromptStreamEvent,
      { type: 'finish', stopReason: 'cancelled' },
    ]))

    const provider = createACPAgentProvider({ workingDirectory: '/tmp/project' })
    const events: AgentTurnStreamEvent[] = []
    for await (const event of provider.streamTurn!({
      model: 'claude-code',
      messages: [{ role: 'user', content: 'run slow thing' }],
      turn: 1,
    })) {
      events.push(event)
    }

    const result = events.find(event => event.type === 'tool-result')
    expect(result).toMatchObject({
      type: 'tool-result',
      result: { aborted: true, error: 'Tool call cancelled' },
    })
  })

  it('uses a deterministic default local session id and rejects empty prompts', async () => {
    acpMocks.streamPrompt.mockImplementation((agentId: string, options: ACPPromptStreamOptions) =>
      acpEvents([{
        type: 'finish',
        stopReason: 'max_tokens',
      }]),
    )

    const provider = createACPAgentProvider()
    if (!provider.streamTurn) throw new Error('ACP provider did not expose streamTurn')

    const events: AgentTurnStreamEvent[] = []
    for await (const event of provider.streamTurn({
      model: 'pi',
      messages: [{ role: 'user', content: '  hello acp  ' }],
      turn: 1,
    })) {
      events.push(event)
    }

    expect(acpMocks.streamPrompt).toHaveBeenCalledWith('pi', {
      localSessionId: 'acp-pi',
      prompt: 'hello acp',
      cwd: process.cwd(),
      abortSignal: undefined,
    })
    expect(events).toEqual([{ type: 'finish', turn: 1, finishReason: 'length', usage: undefined }])

    await expect(async () => {
      for await (const _event of provider.streamTurn!({
        model: 'pi',
        messages: [{ role: 'system', content: 'no user prompt' }],
        turn: 1,
      })) {
        // Exhaust generator to surface prompt validation.
      }
    }).rejects.toThrow('ACP prompt is empty')
  })
})
