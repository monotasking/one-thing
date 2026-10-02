import { describe, expect, it } from 'vitest'
import {
  normalizeOnethingReasoningProfileOverride,
  projectOnethingThinkingLevels,
  resolveOnethingModelCapabilities,
  validateOnethingProviderReasoningSettings,
} from '../model-capability.js'
import { pickOnethingProviderOptions } from '../provider-options.js'
import { normalizeSpaceProviderSettings } from '../../spaces/provider-settings.js'

describe('declarative reasoning profiles', () => {
  it('merges provider defaults with model levels and exposes the same labels to the picker', () => {
    const caps = resolveOnethingModelCapabilities({
      providerId: 'custom-lab', modelId: 'new-model',
      providerReasoningProfile: {
        toggleable: false, defaultOn: true, efforts: ['low', 'high'], defaultEffort: 'high',
        effortLabels: { low: 'Quick' },
        custom: { effortPath: 'thinking.budget_tokens', effortValues: { low: 2048, high: 8192 } },
      },
      override: { reasoningProfile: { efforts: ['low'], defaultEffort: 'high', effortLabels: { high: 'Deep' } } },
    })
    expect(caps.reasoning).toBe(true)
    expect(caps.reasoningProfile).toMatchObject({ wire: 'custom', defaultEffort: 'low', toggleable: false })
    expect(projectOnethingThinkingLevels(caps.reasoningProfile)).toMatchObject({
      thinkingLevels: ['low'], thinkingToggleable: false, thinkingDefaultLevel: 'low',
      thinkingLevelLabels: { low: 'Quick', high: 'Deep' },
    })
  })

  it('keeps an explicit unsupported capability authoritative over provider defaults', () => {
    expect(resolveOnethingModelCapabilities({ providerId: 'grok', modelId: 'grok-4.6',
      providerReasoningProfile: { defaultEffort: 'low' }, override: { reasoning: false },
    }).reasoningProfile).toBeUndefined()
  })

  it.each([
    ['grok-4.6', ['low', 'medium', 'high', 'xhigh'], false, 'high', 'low'],
    ['grok-4.5', ['low', 'medium', 'high'], false, 'high', 'low'],
    ['grok-4.3', ['low', 'medium', 'high'], true, 'low', undefined],
    ['grok-3-mini', ['low', 'high'], false, 'low', 'low'],
    ['grok-4.20-multi-agent', ['low', 'medium', 'high', 'xhigh'], false, 'high', 'low'],
    ['grok-4.20-0309-reasoning', [], false, 'high', undefined],
    ['grok-4', [], false, 'high', undefined],
  ])('projects documented Grok settings for %s on both auth routes', (modelId, levels, toggleable, defaultLevel, disabledLevel) => {
    for (const providerId of ['grok', 'grok-oauth']) {
      const projection = projectOnethingThinkingLevels(resolveOnethingModelCapabilities({ providerId, modelId: String(modelId) }).reasoningProfile)
      expect(projection.thinkingLevels).toEqual(levels)
      expect(projection.thinkingToggleable).toBe(toggleable)
      expect(projection.thinkingDefaultLevel).toBe(defaultLevel)
      expect(projection.thinkingDisabledLevel).toBe(disabledLevel)
    }
  })

  it.each([
    { defaultEffort: 'infinite' },
    { wire: 'custom' },
    { custom: { effortPath: 'reasoning.__proto__.polluted' } },
    { custom: { effortPath: 'constructor.prototype.polluted' } },
    { custom: { effortPath: 'thinking.budget', effortValues: { high: Infinity } } },
    { custom: { effortPath: 'reasoning.effort', enabledBody: { '__proto__.polluted': true } } },
    { custom: { effortPath: 'reasoning.effort', disabledBody: [] } },
    { custom: { effortPath: 'reasoning.effort', disabledValue: {} } },
    { custom: { effortPath: 'reasoning.effort', enabledBody: JSON.parse('{"reasoning":{"__proto__":{"polluted":true}}}') } },
  ])('rejects malformed or unsafe custom configuration', profile => {
    expect(normalizeOnethingReasoningProfileOverride(profile)).toBeUndefined()
    expect(() => resolveOnethingModelCapabilities({ providerId: 'grok', modelId: 'grok-4.6', providerReasoningProfile: profile })).toThrow('Invalid reasoning profile')
    expect(() => validateOnethingProviderReasoningSettings({ providers: { grok: { modelCapabilitiesByModel: { 'grok-4.6': { reasoningProfile: profile } } } } })).toThrow('Invalid reasoning profile at grok.grok-4.6.reasoningProfile')
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
  })

  it('preserves space settings and packs provider profiles beside request options and private dials', () => {
    const reasoningProfile = { defaultEffort: 'low' as const, custom: { effortPath: 'reasoning.effort', effortValues: { low: 'quick' } } }
    const stored = { qwenApiMode: 'standard', qwenRegion: 'intl', providerOptions: { reasoningProfile, request: { verbosity: 'low' } }, modelCapabilitiesByModel: { model: { audio: true, reasoningProfile: { efforts: ['low'] } } } }
    const persisted = normalizeSpaceProviderSettings({ provider: 'qwen', providers: { qwen: stored } }).providers.qwen
    expect(persisted).toEqual(stored)
    expect(pickOnethingProviderOptions('qwen', persisted)).toMatchObject({ qwenApiMode: 'standard', qwenRegion: 'intl', reasoningProfile, request: { verbosity: 'low' } })
  })
})
