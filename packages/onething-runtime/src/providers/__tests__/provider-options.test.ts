import { describe, expect, it } from 'vitest'
import {
  pickOnethingProviderOptions,
  readOnethingQwenOptions,
} from '../provider-options.js'
import { getEffectiveProviderConfig, withResolvedProviderBaseUrl } from '../provider-config.js'
import type { CoreProviderConfigLike } from '../provider-config.js'
import {
  ONETHING_ZHIPU_CODING_PLAN_BASE_URL,
  ONETHING_ZHIPU_STANDARD_BASE_URL,
  normalizeOnethingZhipuApiMode,
} from '../vendors/zhipu/endpoint.js'

/**
 * These knobs used to travel as named fields through nine files, including
 * core's `Pick<>` whitelist — where a forgotten name is dropped silently with a
 * green typecheck, and the only symptom is a request going to the wrong host.
 * What follows is the guard for the bag that replaced them.
 */
describe('provider-private options', () => {
  it('packs only the dials the named provider actually owns', () => {
    expect(pickOnethingProviderOptions('zhipu', { zhipuApiMode: 'coding-plan' }))
      .toEqual({ zhipuApiMode: 'coding-plan' })
    expect(pickOnethingProviderOptions('qwen', { qwenApiMode: 'token-plan', qwenRegion: 'intl' }))
      .toEqual({ qwenApiMode: 'token-plan', qwenRegion: 'intl' })

    // A provider with no dials adds no key at all — the common case stays clean.
    expect(pickOnethingProviderOptions('openai', { zhipuApiMode: 'coding-plan' })).toBeUndefined()
    expect(pickOnethingProviderOptions('zhipu', undefined)).toBeUndefined()
  })

  it('rejects junk at the unpacking point rather than forwarding it', () => {
    // The bag is untyped by design, so narrowing is the factory's job.
    expect(normalizeOnethingZhipuApiMode('nonsense')).toBeUndefined()
    expect(normalizeOnethingZhipuApiMode(undefined)).toBeUndefined()
    expect(normalizeOnethingZhipuApiMode('coding-plan')).toBe('coding-plan')

    // qwen normalizes to its defaults instead, because its endpoint needs a pair.
    expect(readOnethingQwenOptions({ qwenApiMode: 'nonsense', qwenRegion: 'mars' }))
      .toEqual({ qwenApiMode: 'standard', qwenRegion: 'cn' })
  })

  it('packs the bag at the stored → runtime boundary', () => {
    const stored: CoreProviderConfigLike = { model: 'glm-5.2', zhipuApiMode: 'coding-plan' }
    const packed = withResolvedProviderBaseUrl('zhipu', stored)

    expect(packed?.providerOptions).toEqual({ zhipuApiMode: 'coding-plan' })
    // The endpoint is resolved here too, so the runtime never has to re-derive it.
    expect(packed?.baseUrl).toBe(ONETHING_ZHIPU_CODING_PLAN_BASE_URL)

    // Stored fields survive: the settings UI still edits them by name.
    expect(packed?.zhipuApiMode).toBe('coding-plan')
  })

  it('carries the bag through effective-config resolution for every branch', () => {
    const settings: { ai: { provider: string; providers: Record<string, CoreProviderConfigLike> } } = {
      ai: {
        provider: 'zhipu',
        providers: {
          zhipu: { model: 'glm-5.2', zhipuApiMode: 'coding-plan' },
          qwen: { model: 'qwen3.7-plus', qwenApiMode: 'coding-plan', qwenRegion: 'intl' },
        },
      },
    }

    // global branch
    expect(getEffectiveProviderConfig(settings).providerConfig?.providerOptions)
      .toEqual({ zhipuApiMode: 'coding-plan' })

    // session branch
    expect(
      getEffectiveProviderConfig(settings, { lastProvider: 'qwen', lastModel: 'qwen3.7-plus' })
        .providerConfig?.providerOptions,
    ).toEqual({ qwenApiMode: 'coding-plan', qwenRegion: 'intl' })

    // explicit override branch — the one the model picker uses
    expect(
      getEffectiveProviderConfig(settings, null, { providerId: 'qwen', model: 'qwen3.7-plus' })
        .providerConfig?.providerOptions,
    ).toEqual({ qwenApiMode: 'coding-plan', qwenRegion: 'intl' })
  })

  it('leaves a provider without dials untouched', () => {
    const stored: CoreProviderConfigLike = { model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' }
    // Same object back: no bag, no spread, no churn.
    expect(withResolvedProviderBaseUrl('openai', stored)).toBe(stored)
  })

  it('defaults zhipu to the standard host when no dial is stored', () => {
    const packed = withResolvedProviderBaseUrl('zhipu', { model: 'glm-5.2' } as CoreProviderConfigLike)
    expect(packed?.baseUrl).toBe(ONETHING_ZHIPU_STANDARD_BASE_URL)
    expect(packed?.providerOptions).toBeUndefined()
  })
})
