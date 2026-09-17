import { describe, expect, it } from 'vitest'
import type { AgentTurnRequest } from '@onething/core/agent-loop'
import { createAgentProviderFromRuntime, type AgentProviderRuntimeConfig } from '../factory.js'
import { drain, sseResponse } from './wire-snapshots/snapshot-harness.js'
import { projectOnethingThinkingLevels, resolveOnethingModelCapabilities } from '../../../providers/model-capability.js'

async function bodyFor(providerId: string, model: string, options: Partial<AgentTurnRequest> = {}, config: AgentProviderRuntimeConfig = {}) {
  let captured: Record<string, any> = {}
  const provider = createAgentProviderFromRuntime(providerId, {
    apiKey: 'test-key',
    ...(providerId === 'grok-oauth' ? { authContext: { kind: 'oauth', token: { accessToken: 'test-oauth-token' } } } : {}),
    ...config,
  }, {
    fetchImpl: (async (_input: unknown, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body))
      return sseResponse(providerId.startsWith('custom-')
        ? 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
        : providerId === 'claude' ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
        : 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_test","usage":{"input_tokens":1,"output_tokens":1}}}\n\n')
    }) as typeof fetch,
  })!
  await drain(provider.streamTurn!({ model, turn: 1, messages: [{ role: 'user', content: 'Hello' }], ...options }))
  return captured
}

describe('reasoning configuration reaches real request bodies', () => {
  it.each(['grok', 'grok-oauth'])('%s sends all 4.6 supported tiers and maps legacy disabled to low', async providerId => {
    for (const effort of ['low', 'medium', 'high', 'xhigh'] as const) {
      expect((await bodyFor(providerId, 'grok-4.6', { thinking: 'enabled', reasoningEffort: effort })).reasoning).toEqual({ effort })
    }
    const disabled = await bodyFor(providerId, 'grok-4.6', { thinking: 'disabled' })
    expect(disabled.reasoning).toEqual({ effort: 'low' })
    expect(disabled.reasoning_effort).toBeUndefined()
    expect(disabled.include).toContain('reasoning.encrypted_content')
    expect((await bodyFor(providerId, 'grok-4.6')).reasoning).toBeUndefined()
  })

  it('keeps 4.3 off distinct and clamps unsupported tiers using the model table', async () => {
    expect((await bodyFor('grok', 'grok-4.3', { thinking: 'disabled' })).reasoning).toEqual({ effort: 'none' })
    expect((await bodyFor('grok', 'grok-4.3', { thinking: 'enabled' })).reasoning).toEqual({ effort: 'low' })
    expect((await bodyFor('grok', 'grok-4.5', { thinking: 'enabled', reasoningEffort: 'xhigh' })).reasoning).toEqual({ effort: 'high' })
    expect((await bodyFor('grok', 'grok-3-mini', { thinking: 'enabled', reasoningEffort: 'medium' })).reasoning).toEqual({ effort: 'low' })
  })

  it.each(['grok-4', 'grok-4.20-0309-reasoning', 'grok-4-fast-non-reasoning', 'grok-3'])('%s receives no unsupported reasoning knob', async model => {
    for (const thinking of ['enabled', 'disabled'] as const) {
      const body = await bodyFor('grok', model, { thinking, reasoningEffort: 'high' })
      expect(body.reasoning).toBeUndefined()
      expect(body.reasoning_effort).toBeUndefined()
    }
  })

  it('uses a model default over a provider default in the native Grok encoder', async () => {
    const config = { providerOptions: { reasoningProfile: { defaultEffort: 'medium' } }, modelCapabilitiesByModel: { 'grok-4.6': { reasoningProfile: { defaultEffort: 'xhigh' as const } } } }
    expect((await bodyFor('grok-oauth', 'grok-4.6', {}, config)).reasoning).toEqual({ effort: 'xhigh' })
  })

  it('turns on a default-off native model when its configured policy cannot be disabled', async () => {
    const model = 'claude-sonnet-4-6'
    const reasoningProfile = { toggleable: false, defaultOn: false, defaultEffort: 'low' as const }
    const baseline = resolveOnethingModelCapabilities({ providerId: 'claude', modelId: model }).reasoningProfile
    expect(baseline?.defaultOn).toBe(false)
    const resolved = resolveOnethingModelCapabilities({ providerId: 'claude', modelId: model, override: { reasoningProfile } }).reasoningProfile
    expect(projectOnethingThinkingLevels(resolved)).toMatchObject({ thinkingToggleable: false, thinkingDefaultOn: true })
    const config: AgentProviderRuntimeConfig = { modelCapabilitiesByModel: { [model]: { reasoningProfile } } }
    for (const options of [{}, { thinking: 'disabled' as const }]) {
      const body = await bodyFor('claude', model, options, config)
      expect(body.thinking).toEqual({ type: 'adaptive' })
      expect(body.output_config).toEqual({ effort: 'low' })
    }
    config.modelCapabilitiesByModel![model]!.reasoningProfile = { ...reasoningProfile, wire: 'none' }
    expect((await bodyFor('claude', model, {}, config)).thinking).toBeUndefined()
  })

  it('honors explicit wire:none and rejects a wire unsupported by this transport', async () => {
    const config: AgentProviderRuntimeConfig = { providerOptions: { reasoningProfile: { wire: 'none' } } }
    expect((await bodyFor('grok', 'grok-4.6', { thinking: 'enabled' }, config)).reasoning).toBeUndefined()
    config.providerOptions = { reasoningProfile: { wire: 'gemini-level' } }
    await expect(bodyFor('grok', 'grok-4.6', { thinking: 'enabled' }, config)).rejects.toThrow("Reasoning wire 'gemini-level' is not supported")
  })

  it('uses an empty custom effort list as a pure on/off switch', async () => {
    const config: AgentProviderRuntimeConfig = { providerOptions: { reasoningProfile: {
      efforts: [], defaultOn: true, toggleable: true,
      custom: { effortPath: 'reasoning.effort', enabledBody: { enable_thinking: true }, disabledBody: { enable_thinking: false } },
    } } }
    const enabled = await bodyFor('custom-switch', 'lab', { thinking: 'enabled' }, config)
    expect(enabled.enable_thinking).toBe(true)
    expect(enabled.reasoning).toBeUndefined()
    expect((await bodyFor('custom-switch', 'lab', { thinking: 'disabled' }, config)).enable_thinking).toBe(false)
  })

  it('maps custom endpoint levels to strings or budgets and supports an explicit off body without mutating settings', async () => {
    const config: AgentProviderRuntimeConfig = {
      apiType: 'openai', baseUrl: 'https://example.test/v1',
      providerOptions: { reasoningProfile: {
        efforts: ['low', 'high'], defaultOn: true, defaultEffort: 'high', toggleable: true,
        custom: { effortPath: 'thinking.budget_tokens', effortValues: { low: 1024, high: 8192 }, enabledBody: { thinking: { type: 'enabled' } }, disabledBody: { thinking: { type: 'disabled' } }, disabledValue: 0 },
      } },
    }
    const original = structuredClone(config)
    expect((await bodyFor('custom-budget', 'lab-model', {}, config)).thinking).toEqual({ type: 'enabled', budget_tokens: 8192 })
    expect((await bodyFor('custom-budget', 'lab-model', { thinking: 'enabled', reasoningEffort: 'low' }, config)).thinking).toEqual({ type: 'enabled', budget_tokens: 1024 })
    expect((await bodyFor('custom-budget', 'lab-model', { thinking: 'disabled' }, config)).thinking).toEqual({ type: 'disabled', budget_tokens: 0 })
    expect(config).toEqual(original)
    config.modelCapabilitiesByModel = { 'lab-model': { reasoningProfile: { custom: { effortPath: 'reasoning.mode', effortValues: { low: 'fast', high: 'deep' } } } } }
    expect((await bodyFor('custom-budget', 'lab-model', { thinking: 'enabled', reasoningEffort: 'low' }, config)).reasoning).toEqual({ mode: 'fast' })
  })
})
