import { describe, expect, it } from 'vitest'
import { effectiveModelFactsOf, onethingModelOverrideFactsOf } from '../provider-effective-model.js'
import { createOnethingManualModelEntry } from '../provider-manual-models.js'
import type { OnethingModelCapabilityEntry } from '../provider-model-registry.js'

function entry(overrides: Partial<OnethingModelCapabilityEntry> = {}): OnethingModelCapabilityEntry {
  return {
    id: 'm',
    name: 'M',
    provider: 'p',
    contextLength: 200_000,
    maxOutputTokens: 32_000,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsImageOutput: false,
    supportsTemperature: true,
    inputModalities: ['text', 'pdf'],
    outputModalities: ['text'],
    pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  }
}

describe('effectiveModelFactsOf (§5.5)', () => {
  it('models.dev entry → catalog for every fact', () => {
    const facts = effectiveModelFactsOf({ entry: entry() })
    expect(facts).toMatchObject({
      contextLength: 200_000,
      maxOutput: 32_000,
      capabilities: { tools: true, vision: false, reasoning: true, imageOutput: false, fileInput: true },
      reasoningProfile: null,
      source: { contextLength: 'catalog', maxOutput: 'catalog' },
    })
    expect(Object.values(facts.source.capabilities)).toEqual(Array(5).fill('catalog'))
  })

  it('endpoint entry → endpoint, but a field the endpoint left at 0 is unknown', () => {
    const facts = effectiveModelFactsOf({ entry: entry({ source: 'endpoint', maxOutputTokens: 0 }) })
    expect(facts.source.contextLength).toBe('endpoint')
    expect(facts.maxOutput).toBeNull()
    expect(facts.source.maxOutput).toBe('unknown')
    expect(facts.source.capabilities.tools).toBe('endpoint')
  })

  it('override wins field by field, and says so', () => {
    const facts = effectiveModelFactsOf({
      entry: entry(),
      override: { contextLength: 64_000, capabilities: { vision: true, tools: false } },
    })
    expect(facts.contextLength).toBe(64_000)
    expect(facts.source.contextLength).toBe('override')
    expect(facts.maxOutput).toBe(32_000)
    expect(facts.source.maxOutput).toBe('catalog')
    expect(facts.capabilities).toMatchObject({ vision: true, tools: false, reasoning: true })
    expect(facts.source.capabilities).toMatchObject({ vision: 'override', tools: 'override', reasoning: 'catalog' })
  })

  it('manual entry says nothing: only overrides are known (09-10 regression shape)', () => {
    const manual = createOnethingManualModelEntry('deepseek', 'foo-1')
    const bare = effectiveModelFactsOf({ entry: manual })
    expect(bare.contextLength).toBeNull()
    expect(bare.source.contextLength).toBe('unknown')
    expect(Object.values(bare.capabilities)).toEqual(Array(5).fill(null))

    const overridden = effectiveModelFactsOf({ entry: manual, override: { contextLength: 200_000 } })
    expect(overridden.contextLength).toBe(200_000)
    expect(overridden.source.contextLength).toBe('override')
  })

  it('no entry and no override → every fact unknown, never a made-up 128k', () => {
    const facts = effectiveModelFactsOf({})
    expect(facts.contextLength).toBeNull()
    expect(facts.maxOutput).toBeNull()
    expect(facts.source).toEqual({
      contextLength: 'unknown',
      maxOutput: 'unknown',
      capabilities: { tools: 'unknown', vision: 'unknown', reasoning: 'unknown', imageOutput: 'unknown', fileInput: 'unknown' },
    })
  })

  it('passes the resolved reasoning profile through untouched', () => {
    const profile = { efforts: ['low', 'high'] }
    expect(effectiveModelFactsOf({ reasoningProfile: profile }).reasoningProfile).toBe(profile)
  })
})

describe('onethingModelOverrideFactsOf', () => {
  it('reads the three per-model tables with the engine ruler (positive finite numbers, booleans)', () => {
    const config = {
      contextLengthByModel: { a: 100, b: 0, c: Number.NaN },
      maxOutputByModel: { a: 10.7, b: -1 },
      modelCapabilitiesByModel: { a: { tools: true } },
    }
    expect(onethingModelOverrideFactsOf(config, 'a')).toEqual({
      contextLength: 100,
      maxOutput: 10,
      capabilities: { tools: true },
    })
    expect(onethingModelOverrideFactsOf(config, 'b')).toEqual({})
    expect(onethingModelOverrideFactsOf(config, 'c')).toEqual({})
    expect(onethingModelOverrideFactsOf(undefined, 'a')).toEqual({})
  })
})
