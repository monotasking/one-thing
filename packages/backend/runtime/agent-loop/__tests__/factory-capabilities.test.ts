import { describe, expect, it } from 'vitest'
import { createAgentProviderFromRuntime } from '../providers/factory.js'

async function capabilitiesOf(providerId: string, config: Record<string, unknown>, model: string) {
  const provider = createAgentProviderFromRuntime(providerId, config)
  if (!provider?.getModelCapabilities) throw new Error('provider missing getModelCapabilities')
  return provider.getModelCapabilities(model)
}

describe('factory per-model capabilities', () => {
  it('answers per model instead of freezing the construction-time snapshot', async () => {
    const config = {
      apiKey: 'k',
      model: 'gpt-4o',
      models: {
        'gpt-4o': { supportsVision: true, supportsTools: true, supportsReasoning: false },
        'o3-mini': { supportsVision: false, supportsTools: true, supportsReasoning: true },
      },
    }

    const gpt4o = await capabilitiesOf('openai', config, 'gpt-4o')
    expect(gpt4o.supportsReasoning).toBe(false)
    expect(gpt4o.inputModalities).toContain('image')

    const o3mini = await capabilitiesOf('openai', config, 'o3-mini')
    expect(o3mini.supportsReasoning).toBe(true)
    expect(o3mini.inputModalities).not.toContain('image')
    expect(o3mini.capabilities).toContain('reasoning')
  })

  it('keeps the provider transport shape and applies ledger verdicts on top', async () => {
    const caps = await capabilitiesOf('claude', { apiKey: 'k' }, 'claude-opus-4-8')
    // Claude's own transport details survive the wrapper.
    expect(caps.capabilities).toContain('file-input')
    expect(caps.supportsStructuredToolResults).toBe(true)
    expect(caps.supportsReasoning).toBe(true)

    const stripped = await capabilitiesOf('claude', {
      apiKey: 'k',
      modelCapabilitiesByModel: { 'claude-opus-4-8': { reasoning: false, vision: false } },
    }, 'claude-opus-4-8')
    expect(stripped.supportsReasoning).toBe(false)
    expect(stripped.capabilities).not.toContain('reasoning')
    expect(stripped.inputModalities).not.toContain('image')
  })

  it('applies registry token limits per model', async () => {
    const caps = await capabilitiesOf('openai', {
      apiKey: 'k',
      models: { 'gpt-5.2': { contextLength: 400000, maxOutputTokens: 128000, supportsReasoning: true } },
    }, 'gpt-5.2')
    expect(caps.maxInputTokens).toBe(400000)
    expect(caps.maxOutputTokens).toBe(128000)
  })

  it('kind-level vision defaults hold when the registry is empty', async () => {
    const openai = await capabilitiesOf('openai', { apiKey: 'k' }, 'gpt-4o')
    expect(openai.inputModalities).toContain('image')

    const kimi = await capabilitiesOf('kimi', { apiKey: 'k' }, 'kimi-k2.5')
    expect(kimi.inputModalities).not.toContain('image')
  })
})
