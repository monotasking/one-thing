import { describe, expect, it } from 'vitest'
import type { AgentTurnRequest } from '@onething/backend/runtime/agent-loop/loop-primitives'
import { createClaudeAgentProvider } from '../agent-provider.js'

interface CapturedBody {
  system?: unknown
  tools?: Array<Record<string, unknown>>
  messages: Array<{ role: string; content: unknown }>
}

function sseResponse(): Response {
  const sse = [
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":1,"output_tokens":1}}',
    'data: [DONE]',
    '',
  ].join('\n\n')
  return new Response(sse, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function captureRequestBody(
  options: { promptCaching?: boolean },
  request: Partial<AgentTurnRequest>,
): Promise<CapturedBody> {
  let captured: CapturedBody | undefined
  const provider = createClaudeAgentProvider({
    apiKey: 'test',
    ...options,
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(String(init?.body)) as CapturedBody
      return sseResponse()
    },
  })
  for await (const _event of provider.streamTurn!({
    turn: 0,
    model: 'claude-sonnet-5',
    messages: [],
    ...request,
  } as AgentTurnRequest)) {
    // drain
  }
  if (!captured) throw new Error('fetch was not called')
  return captured
}

const baseMessages = [
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: 'hello' },
] as AgentTurnRequest['messages']

describe('claude prompt caching breakpoints', () => {
  it('marks the system tail and the conversation tail when enabled', async () => {
    const body = await captureRequestBody({ promptCaching: true }, { messages: baseMessages })

    const system = body.system as Array<Record<string, unknown>>
    expect(Array.isArray(system)).toBe(true)
    expect(system[system.length - 1].cache_control).toEqual({ type: 'ephemeral' })

    const lastMessage = body.messages[body.messages.length - 1]
    const blocks = lastMessage.content as Array<Record<string, unknown>>
    expect(blocks[blocks.length - 1].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('falls back to the last tool definition when there is no system prompt', async () => {
    const body = await captureRequestBody({ promptCaching: true }, {
      messages: [{ role: 'user', content: 'hi' }] as AgentTurnRequest['messages'],
      tools: [
        { name: 'a', description: '', parameters: { type: 'object' } },
        { name: 'b', description: '', parameters: { type: 'object' } },
      ] as unknown as AgentTurnRequest['tools'],
    })
    expect(body.tools?.[1].cache_control).toEqual({ type: 'ephemeral' })
    expect(body.tools?.[0].cache_control).toBeUndefined()
  })

  it('emits no cache_control at all when disabled (default)', async () => {
    const body = await captureRequestBody({}, { messages: baseMessages })
    expect(JSON.stringify(body)).not.toContain('cache_control')
    // Untouched shapes: system stays a plain string, content stays a string.
    expect(typeof body.system).toBe('string')
  })
})
