import { describe, expect, it } from 'vitest'
import type { AgentMessage, AgentTurnRequest, AgentTurnStreamEvent } from '@onething/backend/agent-loop/loop-primitives'
import { createClaudeAgentProvider } from '../vendors/claude/claude-agent-provider.js'
import { createGeminiAgentProvider } from '../vendors/gemini/gemini-agent-provider.js'
import {
  createOpenAICompatibleAgentProvider,
  type OpenAICompatibleAgentProviderOptions,
} from '../openai-compatible.js'

function sseResponse(lines: string[] = []): Response {
  const body = [
    ...lines,
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":1,"output_tokens":1}}',
    'data: [DONE]',
    '',
  ].join('\n\n')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function collect(events: AsyncIterable<AgentTurnStreamEvent>): Promise<AgentTurnStreamEvent[]> {
  const collected: AgentTurnStreamEvent[] = []
  try {
    for await (const event of events) collected.push(event)
  } catch {
    // Mocked SSE bodies may terminate abruptly; request capture already happened.
  }
  return collected
}

type CapturedBody = Record<string, unknown>

describe('claude thinking wire format', () => {
  async function claudeBody(request: Partial<AgentTurnRequest>): Promise<CapturedBody> {
    let captured: CapturedBody | undefined
    const provider = createClaudeAgentProvider({
      apiKey: 'test',
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body)) as CapturedBody
        return sseResponse()
      },
    })
    await collect(provider.streamTurn!({
      turn: 0,
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'hi' }],
      ...request,
    } as AgentTurnRequest))
    if (!captured) throw new Error('fetch was not called')
    return captured
  }

  it('sends adaptive thinking + effort on 4.6+ models', async () => {
    const body = await claudeBody({
      model: 'claude-opus-4-8',
      thinking: 'enabled',
      reasoningEffort: 'xhigh',
    })
    expect(body.thinking).toEqual({ type: 'adaptive' })
    expect(body.output_config).toEqual({ effort: 'xhigh' })
  })

  it('clamps xhigh to high on 4.6 and maps minimal to low', async () => {
    const body = await claudeBody({
      model: 'claude-opus-4-6',
      thinking: 'enabled',
      reasoningEffort: 'xhigh',
    })
    expect(body.output_config).toEqual({ effort: 'high' })

    const minimal = await claudeBody({
      model: 'claude-sonnet-4-6',
      thinking: 'enabled',
      reasoningEffort: 'minimal',
    })
    expect(minimal.output_config).toEqual({ effort: 'low' })
  })

  it('omits the thinking param on Fable but keeps effort', async () => {
    const body = await claudeBody({
      model: 'claude-fable-5',
      thinking: 'enabled',
      reasoningEffort: 'max',
    })
    expect(body.thinking).toBeUndefined()
    expect(body.output_config).toEqual({ effort: 'max' })
  })

  it('uses budget_tokens on pre-4.6 models and keeps max_tokens above it', async () => {
    const body = await claudeBody({
      model: 'claude-haiku-4-5',
      thinking: 'enabled',
      reasoningEffort: 'high',
      maxTokens: 4096,
    })
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 })
    expect(body.max_tokens as number).toBeGreaterThan(16384)
  })

  it('sends explicit disabled on adaptive models but never on Fable', async () => {
    const sonnet = await claudeBody({ model: 'claude-sonnet-5', thinking: 'disabled' })
    expect(sonnet.thinking).toEqual({ type: 'disabled' })

    const fable = await claudeBody({ model: 'claude-fable-5', thinking: 'disabled' })
    expect(fable.thinking).toBeUndefined()
  })

  it('drops temperature when thinking is on or the model removed sampling params', async () => {
    const thinkingOn = await claudeBody({
      model: 'claude-sonnet-4-6',
      thinking: 'enabled',
      temperature: 0.7,
    })
    expect(thinkingOn.temperature).toBeUndefined()

    const modern = await claudeBody({ model: 'claude-opus-4-8', temperature: 0.7 })
    expect(modern.temperature).toBeUndefined()

    const legacy = await claudeBody({ model: 'claude-sonnet-4-5', temperature: 0.7 })
    expect(legacy.temperature).toBe(0.7)
  })

  it('captures signed thinking blocks as provider-data and replays them', async () => {
    const provider = createClaudeAgentProvider({
      apiKey: 'test',
      fetchImpl: async () => sseResponse([
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"pondering"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig123"}}',
        'data: {"type":"content_block_stop","index":0}',
      ]),
    })
    const events = await collect(provider.streamTurn!({
      turn: 0,
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: 'enabled',
    } as AgentTurnRequest))

    expect(events).toContainEqual({ type: 'reasoning-delta', turn: 0, delta: 'pondering' })
    expect(events).toContainEqual({
      type: 'provider-data',
      turn: 0,
      providerData: { provider: 'claude', type: 'thinking', thinking: 'pondering', signature: 'sig123' },
    })

    // Replay: the captured provider data goes back out as a thinking block
    // ahead of the assistant text.
    let captured: CapturedBody | undefined
    const replayProvider = createClaudeAgentProvider({
      apiKey: 'test',
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body)) as CapturedBody
        return sseResponse()
      },
    })
    const assistant: AgentMessage = {
      role: 'assistant',
      content: 'answer',
      providerData: [
        { provider: 'claude', type: 'thinking', thinking: 'pondering', signature: 'sig123' },
      ],
    }
    await collect(replayProvider.streamTurn!({
      turn: 1,
      model: 'claude-opus-4-8',
      messages: [
        { role: 'user', content: 'hi' },
        assistant,
        { role: 'user', content: 'next' },
      ],
      thinking: 'enabled',
    } as AgentTurnRequest))

    const messages = captured?.messages as Array<{ role: string; content: unknown }>
    const assistantMessage = messages.find(message => message.role === 'assistant')
    expect(assistantMessage?.content).toEqual([
      { type: 'thinking', thinking: 'pondering', signature: 'sig123' },
      { type: 'text', text: 'answer' },
    ])

    // With thinking off the blocks stay out of the request.
    let disabledCaptured: CapturedBody | undefined
    const disabledProvider = createClaudeAgentProvider({
      apiKey: 'test',
      fetchImpl: async (_url, init) => {
        disabledCaptured = JSON.parse(String(init?.body)) as CapturedBody
        return sseResponse()
      },
    })
    await collect(disabledProvider.streamTurn!({
      turn: 1,
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'hi' }, assistant, { role: 'user', content: 'next' }],
    } as AgentTurnRequest))
    const disabledMessages = disabledCaptured?.messages as Array<{ role: string; content: unknown }>
    const disabledAssistant = disabledMessages.find(message => message.role === 'assistant')
    expect(disabledAssistant?.content).toEqual([{ type: 'text', text: 'answer' }])
  })
})

describe('openai-compatible reasoning styles', () => {
  async function styleBody(
    // Derived, not re-listed: a new wire style must reach this helper without
    // an edit here, or the test silently stops covering it.
    reasoningStyle: NonNullable<OpenAICompatibleAgentProviderOptions['reasoningStyle']>,
    request: Partial<AgentTurnRequest>,
  ): Promise<CapturedBody> {
    let captured: CapturedBody | undefined
    const provider = createOpenAICompatibleAgentProvider({
      providerId: 'test-openai-compatible',
      apiKey: 'test',
      defaultBaseUrl: 'https://example.com/v1',
      reasoningStyle,
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body)) as CapturedBody
        return sseResponse()
      },
    })
    await collect(provider.streamTurn!({
      turn: 0,
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      ...request,
    } as AgentTurnRequest))
    if (!captured) throw new Error('fetch was not called')
    return captured
  }

  it('openai-effort sends clamped reasoning_effort and never thinking', async () => {
    const body = await styleBody('openai-effort', {
      model: 'gpt-5.2',
      thinking: 'enabled',
      reasoningEffort: 'max',
    })
    expect(body.reasoning_effort).toBe('high')
    expect(body.thinking).toBeUndefined()

    const minimal = await styleBody('openai-effort', {
      model: 'gpt-5.2',
      thinking: 'enabled',
      reasoningEffort: 'minimal',
    })
    expect(minimal.reasoning_effort).toBe('minimal')

    const off = await styleBody('openai-effort', { model: 'gpt-5.2', thinking: 'disabled' })
    expect(off.reasoning_effort).toBeUndefined()
    expect(off.thinking).toBeUndefined()
  })

  it('zhipu-thinking sends only thinking.type', async () => {
    const on = await styleBody('zhipu-thinking', { model: 'glm-5.2', thinking: 'enabled', reasoningEffort: 'high' })
    expect(on.thinking).toEqual({ type: 'enabled' })
    expect(on.reasoning_effort).toBeUndefined()

    const off = await styleBody('zhipu-thinking', { model: 'glm-5.2', thinking: 'disabled' })
    expect(off.thinking).toEqual({ type: 'disabled' })
  })

  it('grok-effort clamps to the model-supported range', async () => {
    const grok45 = await styleBody('grok-effort', {
      model: 'grok-4.5',
      thinking: 'enabled',
      reasoningEffort: 'xhigh',
    })
    expect(grok45.reasoning_effort).toBe('high')

    const multiAgent = await styleBody('grok-effort', {
      model: 'grok-4.20-multi-agent',
      thinking: 'enabled',
      reasoningEffort: 'xhigh',
    })
    expect(multiAgent.reasoning_effort).toBe('xhigh')

    const off = await styleBody('grok-effort', { model: 'grok-4.5', thinking: 'disabled' })
    expect(off.reasoning_effort).toBeUndefined()
  })

  it('openrouter-reasoning sends the unified reasoning object', async () => {
    const on = await styleBody('openrouter-reasoning', {
      model: 'anthropic/claude-sonnet-5',
      thinking: 'enabled',
      reasoningEffort: 'medium',
    })
    expect(on.reasoning).toEqual({ effort: 'medium' })

    const off = await styleBody('openrouter-reasoning', {
      model: 'anthropic/claude-sonnet-5',
      thinking: 'disabled',
    })
    expect(off.reasoning).toEqual({ enabled: false })
  })

  it('none never emits thinking params (github-copilot default)', async () => {
    const body = await styleBody('none', {
      model: 'gpt-5.2',
      thinking: 'enabled',
      reasoningEffort: 'high',
    })
    expect(body.thinking).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
    expect(body.reasoning).toBeUndefined()
  })

  it('qwen-thinking sends enable_thinking, and effort only where accepted', async () => {
    // qwen3.8-max is the one family that takes reasoning_effort (low|medium|xhigh).
    const max = await styleBody('qwen-thinking', {
      model: 'qwen3.8-max',
      thinking: 'enabled',
      reasoningEffort: 'max',
    })
    expect(max.enable_thinking).toBe(true)
    expect(max.reasoning_effort).toBe('xhigh')

    const maxLow = await styleBody('qwen-thinking', {
      model: 'qwen3.8-max',
      thinking: 'enabled',
      reasoningEffort: 'minimal',
    })
    expect(maxLow.reasoning_effort).toBe('low')

    // Resold GLM / DeepSeek keep the vendors' high|max pair.
    const glm = await styleBody('qwen-thinking', {
      model: 'glm-5.2',
      thinking: 'enabled',
      reasoningEffort: 'xhigh',
    })
    expect(glm.reasoning_effort).toBe('max')

    // Every other Qwen model is thinking_budget-driven: sending effort would
    // 400, so the toggle alone goes out.
    const plus = await styleBody('qwen-thinking', {
      model: 'qwen3.7-plus',
      thinking: 'enabled',
      reasoningEffort: 'high',
    })
    expect(plus.enable_thinking).toBe(true)
    expect(plus.reasoning_effort).toBeUndefined()

    const off = await styleBody('qwen-thinking', { model: 'qwen3.7-plus', thinking: 'disabled' })
    expect(off.enable_thinking).toBe(false)
    expect(off.reasoning_effort).toBeUndefined()

    // Untouched toggle must not change the request at all.
    const untouched = await styleBody('qwen-thinking', { model: 'qwen3.7-plus' })
    expect(untouched.enable_thinking).toBeUndefined()
  })

  it('thinking-type keeps the kimi/deepseek wire shape', async () => {
    const body = await styleBody('thinking-type', {
      model: 'kimi-k2.6',
      thinking: 'enabled',
      reasoningEffort: 'max',
    })
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('max')
  })
})

describe('gemini thinkingConfig', () => {
  async function geminiBody(request: Partial<AgentTurnRequest>): Promise<CapturedBody> {
    let captured: CapturedBody | undefined
    const provider = createGeminiAgentProvider({
      apiKey: 'test',
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body)) as CapturedBody
        return sseResponse()
      },
    })
    await collect(provider.streamTurn!({
      turn: 0,
      model: 'gemini-3-pro',
      messages: [{ role: 'user', content: 'hi' }],
      ...request,
    } as AgentTurnRequest))
    if (!captured) throw new Error('fetch was not called')
    return captured
  }

  function thinkingConfigOf(body: CapturedBody): Record<string, unknown> | undefined {
    return (body.generationConfig as Record<string, unknown> | undefined)
      ?.thinkingConfig as Record<string, unknown> | undefined
  }

  it('sends thinkingLevel + includeThoughts on Gemini 3', async () => {
    const body = await geminiBody({
      model: 'gemini-3-pro',
      thinking: 'enabled',
      reasoningEffort: 'high',
    })
    expect(thinkingConfigOf(body)).toEqual({ includeThoughts: true, thinkingLevel: 'high' })
  })

  it('sends thinkingBudget on Gemini 2.5 and budget 0 to disable flash thinking', async () => {
    const enabled = await geminiBody({
      model: 'gemini-2.5-pro',
      thinking: 'enabled',
      reasoningEffort: 'medium',
    })
    expect(thinkingConfigOf(enabled)).toEqual({ includeThoughts: true, thinkingBudget: 8192 })

    const disabledFlash = await geminiBody({ model: 'gemini-2.5-flash', thinking: 'disabled' })
    expect(thinkingConfigOf(disabledFlash)).toEqual({ thinkingBudget: 0 })
  })

  it('sends nothing when the user has not configured thinking', async () => {
    const body = await geminiBody({ model: 'gemini-3-flash-preview' })
    expect(thinkingConfigOf(body)).toBeUndefined()
  })

  it('clamps levels to what the model accepts', async () => {
    // gemini-3-pro only takes low/high — medium clamps down to low.
    const medium = await geminiBody({
      model: 'gemini-3-pro',
      thinking: 'enabled',
      reasoningEffort: 'medium',
    })
    expect(thinkingConfigOf(medium)).toEqual({ includeThoughts: true, thinkingLevel: 'low' })

    // "Off" maps to the lowest level the model supports.
    const off = await geminiBody({ model: 'gemini-3-flash-preview', thinking: 'disabled' })
    expect(thinkingConfigOf(off)).toEqual({ thinkingLevel: 'minimal' })

    const proOff = await geminiBody({ model: 'gemini-3-pro', thinking: 'disabled' })
    expect(thinkingConfigOf(proOff)).toEqual({ thinkingLevel: 'low' })
  })
})
