/**
 * End-to-end fence for the Claude thinking-block round trip across
 * persistence: provider-data chunk → executor apply (codex-only adapter +
 * core default plan) → session ordered part → history rebuild → replayed
 * thinking block in the next Claude request. Each hop is a separate module;
 * this test pins the chain so a filter added at any hop turns red here.
 */
import { describe, expect, it } from 'vitest'
import {
  applyAgentLoopProviderDataWithAdapters,
  getHistoryProviderData,
} from '@onething/core/engine'
import type { AgentMessage, AgentTurnRequest } from '@onething/core/agent-loop'
import { applyOnethingAgentLoopProviderData } from '../providers/provider-data.js'
import { createClaudeAgentProvider } from '../../providers/vendors/claude/agent-provider.js'

const CLAUDE_THINKING_DATA = {
  provider: 'claude',
  type: 'thinking',
  thinking: 'pondering deeply',
  signature: 'sig-abc',
}

describe('claude thinking persistence chain', () => {
  it('executor apply falls through the codex-only adapter into the core default persist', async () => {
    const orderedParts: Array<{ type: string } & Record<string, unknown>> = []
    const applied = await applyAgentLoopProviderDataWithAdapters({
      providerData: CLAUDE_THINKING_DATA,
      turnIndex: 2,
      model: 'claude-opus-4-8',
      sessionId: 's1',
      messageId: 'm1',
      content: { value: '' },
      orderedParts,
      emitter: { sendContentPart: () => {} },
      handleTextChunk: () => undefined,
      applyProviderData: options =>
        applyOnethingAgentLoopProviderData({
          ...options,
          saveMediaImage: () => {
            throw new Error('saveMediaImage must not run for claude thinking data')
          },
        }),
    })

    expect(applied).toBe(true)
    expect(orderedParts).toEqual([
      { type: 'provider-data', providerData: CLAUDE_THINKING_DATA, turnIndex: 2 },
    ])
  })

  it('history rebuild reads the persisted part back through the generic channel', () => {
    const providerData = getHistoryProviderData({
      role: 'assistant',
      content: 'answer',
      contentParts: [
        { type: 'text', content: 'answer' },
        { type: 'provider-data', providerData: CLAUDE_THINKING_DATA, turnIndex: 2 },
      ],
    } as never)

    expect(providerData).toEqual([CLAUDE_THINKING_DATA])
  })

  it('the rebuilt providerData replays as a leading thinking block on the next request', async () => {
    let captured: { messages: Array<{ role: string; content: unknown }> } | undefined
    const provider = createClaudeAgentProvider({
      apiKey: 'test',
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body)) as typeof captured
        return new Response(
          ['data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}', 'data: [DONE]', ''].join('\n\n'),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      },
    })

    const assistant: AgentMessage = {
      role: 'assistant',
      content: '',
      providerData: [CLAUDE_THINKING_DATA],
      toolCalls: [{ id: 'tool-1', name: 'read', arguments: '{}' }],
    }
    try {
      for await (const _event of provider.streamTurn!({
        turn: 1,
        model: 'claude-opus-4-8',
        messages: [
          { role: 'user', content: 'hi' },
          assistant,
          { role: 'tool', content: 'file contents', toolCallId: 'tool-1' },
        ],
        thinking: 'enabled',
      } as AgentTurnRequest)) {
        // drain
      }
    } catch {
      // Mocked SSE termination is irrelevant — the request body is captured.
    }

    const assistantMessage = captured?.messages.find(message => message.role === 'assistant')
    expect(assistantMessage?.content).toEqual([
      { type: 'thinking', thinking: 'pondering deeply', signature: 'sig-abc' },
      { type: 'tool_use', id: 'tool-1', name: 'read', input: {} },
    ])
  })

  it('never emits an assistant message that is only thinking blocks', async () => {
    let captured: { messages: Array<{ role: string; content: unknown }> } | undefined
    const provider = createClaudeAgentProvider({
      apiKey: 'test',
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body)) as typeof captured
        return new Response(['data: [DONE]', ''].join('\n\n'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })

    try {
      for await (const _event of provider.streamTurn!({
        turn: 1,
        model: 'claude-opus-4-8',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: '', providerData: [CLAUDE_THINKING_DATA] },
          { role: 'user', content: 'again' },
        ],
        thinking: 'enabled',
      } as AgentTurnRequest)) {
        // drain
      }
    } catch {
      // request body captured before stream parsing matters
    }

    const assistantMessage = captured?.messages.find(message => message.role === 'assistant')
    expect(assistantMessage?.content).toBe('')
  })
})
