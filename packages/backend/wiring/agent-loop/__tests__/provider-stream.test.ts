import { describe, expect, it } from 'vitest'
import {
  agentEventsToProviderStreamChunks,
  isCompleteAgentToolArguments,
  mapAgentProviderFinishReason,
  safeParseAgentToolArguments,
} from '@onething/core/agent-loop'
import type { AgentStreamEvent } from '@onething/core/agent-loop'

async function collect(events: AgentStreamEvent[]) {
  const chunks = []
  async function* source() {
    for (const event of events) yield event
  }
  for await (const chunk of agentEventsToProviderStreamChunks(source())) {
    chunks.push(chunk)
  }
  return chunks
}

describe('agent provider stream adapter', () => {
  it('maps text, reasoning, and finish events into provider stream chunks', async () => {
    await expect(collect([
      { type: 'turn-start', turn: 1 },
      { type: 'reasoning-delta', turn: 1, delta: 'think' },
      { type: 'text-delta', turn: 1, delta: 'hello' },
      {
        type: 'finish',
        turn: 1,
        finishReason: 'content_filter',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
    ])).resolves.toEqual([
      { type: 'turn-start', turnStart: { turn: 1 } },
      { type: 'reasoning', reasoning: 'think' },
      { type: 'text', text: 'hello' },
      {
        type: 'finish',
        finishReason: 'content-filter',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
    ])
  })

  it('emits tool input end when streamed arguments form a complete JSON object', async () => {
    await expect(collect([
      { type: 'tool-call-start', turn: 1, toolCallId: 'call_1', toolName: 'read' },
      {
        type: 'tool-call-delta',
        turn: 1,
        toolCallId: 'call_1',
        toolName: 'read',
        argumentsDelta: '{"path"',
      },
      {
        type: 'tool-call-delta',
        turn: 1,
        toolCallId: 'call_1',
        toolName: 'read',
        argumentsDelta: ':"a.txt"}',
      },
      {
        type: 'tool-call-done',
        turn: 1,
        toolCall: { id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' },
      },
    ])).resolves.toEqual([
      { type: 'tool-input-start', toolInputStart: { toolCallId: 'call_1', toolName: 'read' } },
      { type: 'tool-input-delta', toolInputDelta: { toolCallId: 'call_1', argsTextDelta: '{"path"' } },
      { type: 'tool-input-delta', toolInputDelta: { toolCallId: 'call_1', argsTextDelta: ':"a.txt"}' } },
      { type: 'tool-input-end', toolInputEnd: { toolCallId: 'call_1', finalizedBy: 'parse' } },
    ])
  })

  it('emits tool-input-end IMMEDIATELY when the completing delta arrives, before any later event', async () => {
    // Honesty contract: the receive-complete signal must ride the same
    // consumption step as the byte that completed the JSON — batching done
    // events to the end of the stream is the exact failure this guards.
    const chunks = await collect([
      { type: 'tool-call-start', turn: 1, toolCallId: 'call_1', toolName: 'read' },
      {
        type: 'tool-call-delta',
        turn: 1,
        toolCallId: 'call_1',
        toolName: 'read',
        argumentsDelta: '{"path":"a.txt"}',
      },
      { type: 'text-delta', turn: 1, delta: 'later text' },
      {
        type: 'tool-call-done',
        turn: 1,
        toolCall: { id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' },
      },
    ])
    const endIndex = chunks.findIndex(chunk => chunk.type === 'tool-input-end')
    const textIndex = chunks.findIndex(chunk => chunk.type === 'text')
    expect(endIndex).toBeGreaterThan(-1)
    expect(textIndex).toBeGreaterThan(-1)
    expect(endIndex).toBeLessThan(textIndex)
  })

  it('falls back to a tool-call chunk when streamed arguments never complete', async () => {
    await expect(collect([
      { type: 'tool-call-start', turn: 1, toolCallId: 'call_1', toolName: 'read' },
      {
        type: 'tool-call-delta',
        turn: 1,
        toolCallId: 'call_1',
        toolName: 'read',
        argumentsDelta: '{"path"',
      },
      {
        type: 'tool-call-done',
        turn: 1,
        toolCall: { id: 'call_1', name: 'read', arguments: '{"path":"fallback.txt"}' },
      },
    ])).resolves.toEqual([
      { type: 'tool-input-start', toolInputStart: { toolCallId: 'call_1', toolName: 'read' } },
      { type: 'tool-input-delta', toolInputDelta: { toolCallId: 'call_1', argsTextDelta: '{"path"' } },
      {
        type: 'tool-call',
        toolCall: {
          toolCallId: 'call_1',
          toolName: 'read',
          args: { path: 'fallback.txt' },
          finalizedBy: 'provider-done',
        },
      },
    ])
  })

  it('exposes parser and finish reason helpers for provider bridges', () => {
    expect(isCompleteAgentToolArguments('{"ok":true}')).toBe(true)
    expect(isCompleteAgentToolArguments('[]')).toBe(false)
    expect(safeParseAgentToolArguments('bad')).toEqual({})
    expect(mapAgentProviderFinishReason('tool_calls')).toBe('tool-calls')
    expect(mapAgentProviderFinishReason('max_turns')).toBe('other')
  })

  it('does not emit duplicate finish chunks when finish and turn-end arrive for the same turn', async () => {
    await expect(collect([
      { type: 'finish', turn: 1, finishReason: 'tool_calls' },
      { type: 'turn-end', turn: 1, finishReason: 'tool_calls' },
      { type: 'turn-end', turn: 2, finishReason: 'stop' },
    ])).resolves.toEqual([
      { type: 'finish', finishReason: 'tool-calls', usage: undefined },
      { type: 'finish', finishReason: 'stop', usage: undefined },
    ])
  })

  it('maps tool metadata and partial result events for stream executors', async () => {
    await expect(collect([
      {
        type: 'tool-metadata',
        turn: 1,
        toolCall: { id: 'call_1', name: 'edit', arguments: '{}' },
        update: { title: 'Preview edit', metadata: { path: '/tmp/a.txt' } },
      },
      {
        type: 'tool-partial-result',
        turn: 1,
        toolCall: { id: 'call_1', name: 'edit', arguments: '{}' },
        update: { content: [{ type: 'text', text: 'halfway' }] },
      },
    ])).resolves.toEqual([
      {
        type: 'tool-metadata',
        toolMetadata: {
          toolCallId: 'call_1',
          update: { title: 'Preview edit', metadata: { path: '/tmp/a.txt' } },
        },
      },
      {
        type: 'tool-partial-result',
        toolPartialResult: {
          toolCallId: 'call_1',
          update: { content: [{ type: 'text', text: 'halfway' }] },
        },
      },
    ])
  })

  it('passes provider data through for provider-specific stream features', async () => {
    await expect(collect([
      {
        type: 'provider-data',
        turn: 1,
        providerData: {
          provider: 'codex',
          type: 'encrypted-reasoning',
          encryptedContent: 'encrypted-payload',
        },
      },
      {
        type: 'provider-data',
        turn: 1,
        providerData: {
          provider: 'codex',
          type: 'image-generation-start',
          callId: 'img_1',
        },
      },
      {
        type: 'provider-data',
        turn: 1,
        providerData: {
          provider: 'codex',
          type: 'image-generation-result',
          callId: 'img_1',
          status: 'completed',
          revisedPrompt: 'better moon',
          result: 'base64-image',
        },
      },
    ])).resolves.toEqual([
      {
        type: 'provider-data',
        providerData: {
          provider: 'codex',
          type: 'encrypted-reasoning',
          encryptedContent: 'encrypted-payload',
        },
      },
      {
        type: 'provider-data',
        providerData: {
          provider: 'codex',
          type: 'image-generation-start',
          callId: 'img_1',
        },
      },
      {
        type: 'provider-data',
        providerData: {
          provider: 'codex',
          type: 'image-generation-result',
          callId: 'img_1',
          status: 'completed',
          revisedPrompt: 'better moon',
          result: 'base64-image',
        },
      },
    ])
  })
})
