import { describe, expect, it } from 'vitest'
import { createACPAgentProvider, type CoreACPPromptStreamEvent } from '@onething/runtime/agent-loop/providers'

async function* streamEvents(events: CoreACPPromptStreamEvent[]): AsyncGenerator<CoreACPPromptStreamEvent, void, void> {
  for (const event of events) yield event
}

describe('core ACP agent provider', () => {
  it('maps host ACP stream events to agent loop stream events', async () => {
    const provider = createACPAgentProvider({
      cwd: () => '/tmp/project',
      streamPrompt: (_model, options) => {
        expect(options.cwd).toBe('/tmp/project')
        expect(options.prompt).toBe('hello acp')
        return streamEvents([
          { type: 'warning', message: 'warming up' },
          {
            type: 'update',
            notification: {
              update: {
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text: 'thinking' },
              },
            },
          },
          {
            type: 'update',
            notification: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'answer' },
              },
            },
          },
          {
            type: 'finish',
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          },
        ])
      },
    })

    const events = []
    for await (const event of provider.streamTurn!({
      model: 'acp-test',
      messages: [{ role: 'user', content: 'hello acp' }],
      turn: 1,
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      { type: 'reasoning-delta', turn: 1, delta: 'warming up' },
      { type: 'reasoning-delta', turn: 1, delta: 'thinking' },
      { type: 'text-delta', turn: 1, delta: 'answer' },
      {
        type: 'finish',
        turn: 1,
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
    ])
  })
})
