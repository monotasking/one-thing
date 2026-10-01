/**
 * 千问 endpoint matrix. The four hosts are not interchangeable — a Token Plan
 * key (`sk-sp-`) 401s against the pay-as-you-go host and vice versa, and the
 * 国内/海外 pair are separate accounts entirely. So the thing worth pinning is
 * that mode x region resolves to the right host and the right models.dev key,
 * and that a hand-typed base URL is never silently overwritten.
 */
import { describe, expect, it } from 'vitest'
import {
  ONETHING_QWEN_CODING_PLAN_CN_BASE_URL,
  ONETHING_QWEN_CODING_PLAN_INTL_BASE_URL,
  ONETHING_QWEN_STANDARD_CN_BASE_URL,
  ONETHING_QWEN_STANDARD_INTL_BASE_URL,
  ONETHING_QWEN_TOKEN_PLAN_CN_BASE_URL,
  ONETHING_QWEN_TOKEN_PLAN_INTL_BASE_URL,
  normalizeOnethingQwenApiMode,
  resolveOnethingQwenBaseUrl,
  resolveOnethingQwenModelsDevProviderId,
} from '../qwen.js'
import { resolveOnethingProviderBaseUrl } from '../endpoint.js'
import { getOnethingModelsDevProviderId } from '../model-registry.js'
import { resolveOnethingModelCapabilities } from '../model-capability.js'

describe('qwen endpoint matrix', () => {
  it('resolves all six host combinations', () => {
    expect(resolveOnethingQwenBaseUrl({ qwenApiMode: 'standard', qwenRegion: 'cn' }))
      .toBe(ONETHING_QWEN_STANDARD_CN_BASE_URL)
    expect(resolveOnethingQwenBaseUrl({ qwenApiMode: 'standard', qwenRegion: 'intl' }))
      .toBe(ONETHING_QWEN_STANDARD_INTL_BASE_URL)
    expect(resolveOnethingQwenBaseUrl({ qwenApiMode: 'token-plan', qwenRegion: 'cn' }))
      .toBe(ONETHING_QWEN_TOKEN_PLAN_CN_BASE_URL)
    expect(resolveOnethingQwenBaseUrl({ qwenApiMode: 'token-plan', qwenRegion: 'intl' }))
      .toBe(ONETHING_QWEN_TOKEN_PLAN_INTL_BASE_URL)
    expect(resolveOnethingQwenBaseUrl({ qwenApiMode: 'coding-plan', qwenRegion: 'cn' }))
      .toBe(ONETHING_QWEN_CODING_PLAN_CN_BASE_URL)
    expect(resolveOnethingQwenBaseUrl({ qwenApiMode: 'coding-plan', qwenRegion: 'intl' }))
      .toBe(ONETHING_QWEN_CODING_PLAN_INTL_BASE_URL)
  })

  it('keeps Coding Plan on its bare /v1 path', () => {
    // Every other host is /compatible-mode/v1 — an over-eager "normalization"
    // here would 404 the whole plan.
    for (const url of [
      ONETHING_QWEN_CODING_PLAN_CN_BASE_URL,
      ONETHING_QWEN_CODING_PLAN_INTL_BASE_URL,
    ]) {
      expect(url.endsWith('/v1')).toBe(true)
      expect(url).not.toContain('compatible-mode')
    }
  })

  it('falls back to pay-as-you-go for an unknown mode', () => {
    expect(normalizeOnethingQwenApiMode('coding-plan')).toBe('coding-plan')
    expect(normalizeOnethingQwenApiMode('nonsense')).toBe('standard')
    expect(normalizeOnethingQwenApiMode(undefined)).toBe('standard')
  })

  it('defaults to 国内版 pay-as-you-go when unconfigured', () => {
    expect(resolveOnethingQwenBaseUrl(undefined)).toBe(ONETHING_QWEN_STANDARD_CN_BASE_URL)
    expect(resolveOnethingQwenBaseUrl({})).toBe(ONETHING_QWEN_STANDARD_CN_BASE_URL)
  })

  it('keeps a custom base URL but re-derives a stale one we own', () => {
    expect(resolveOnethingQwenBaseUrl({ baseUrl: 'https://proxy.internal/v1' }))
      .toBe('https://proxy.internal/v1')
    // Switching region leaves the previous known host behind in settings; the
    // mode/region pair has to win or the user silently keeps calling Beijing.
    expect(resolveOnethingQwenBaseUrl({
      baseUrl: ONETHING_QWEN_STANDARD_CN_BASE_URL,
      qwenRegion: 'intl',
    })).toBe(ONETHING_QWEN_STANDARD_INTL_BASE_URL)
  })

  it('routes through the shared provider base-url dispatcher', () => {
    expect(resolveOnethingProviderBaseUrl('qwen', { qwenApiMode: 'token-plan', qwenRegion: 'intl' }))
      .toBe(ONETHING_QWEN_TOKEN_PLAN_INTL_BASE_URL)
    // Non-qwen providers keep their old behaviour.
    expect(resolveOnethingProviderBaseUrl('openai', { baseUrl: 'https://x/v1' }))
      .toBe('https://x/v1')
  })

  it('picks the models.dev catalog matching region + plan', () => {
    expect(resolveOnethingQwenModelsDevProviderId({ qwenApiMode: 'standard', qwenRegion: 'cn' }))
      .toBe('alibaba-cn')
    expect(resolveOnethingQwenModelsDevProviderId({ qwenApiMode: 'standard', qwenRegion: 'intl' }))
      .toBe('alibaba')
    expect(resolveOnethingQwenModelsDevProviderId({ qwenApiMode: 'token-plan', qwenRegion: 'cn' }))
      .toBe('alibaba-token-plan-cn')
    expect(resolveOnethingQwenModelsDevProviderId({ qwenApiMode: 'token-plan', qwenRegion: 'intl' }))
      .toBe('alibaba-token-plan')
    expect(resolveOnethingQwenModelsDevProviderId({ qwenApiMode: 'coding-plan', qwenRegion: 'cn' }))
      .toBe('alibaba-coding-plan-cn')
    expect(resolveOnethingQwenModelsDevProviderId({ qwenApiMode: 'coding-plan', qwenRegion: 'intl' }))
      .toBe('alibaba-coding-plan')
    // Config-less lookups still land on a real catalog, not the literal id.
    expect(getOnethingModelsDevProviderId('qwen')).toBe('alibaba-cn')
    expect(getOnethingModelsDevProviderId('qwen', { qwenRegion: 'intl' })).toBe('alibaba')
  })
})

describe('qwen model capabilities', () => {
  function resolve(modelId: string) {
    return resolveOnethingModelCapabilities({ providerId: 'qwen', modelId })
  }

  it('gives qwen3.8-max the only effort ladder the API accepts', () => {
    // No registryEntry on purpose: models.dev has not added qwen3.8-max to the
    // pay-as-you-go catalogs yet, so the rules table is the only thing standing
    // between the flagship and a wrong (or missing) thinking profile.
    const caps = resolve('qwen3.8-max')
    expect(caps.reasoning).toBe(true)
    expect(caps.source.reasoning).toBe('pattern')
    expect(caps.tools).toBe(true)
    expect(caps.vision).toBe(true)
    expect(caps.reasoningProfile).toMatchObject({
      toggleable: true,
      defaultOn: true,
      efforts: ['low', 'medium', 'xhigh'],
      wire: 'qwen-thinking',
    })
  })

  it('drops the fake Off on the 3.8 preview, which has no thinking toggle', () => {
    const preview = resolve('qwen3.8-max-preview')
    expect(preview.reasoning).toBe(true)
    expect(preview.reasoningProfile).toMatchObject({
      toggleable: false,
      efforts: ['low', 'medium', 'xhigh'],
      wire: 'qwen-thinking',
    })
    // The GA model keeps its toggle — the preview row must not swallow it.
    expect(resolve('qwen3.8-max').reasoningProfile?.toggleable).toBe(true)
  })

  it('gives resold GLM / DeepSeek the vendor high|max pair', () => {
    expect(resolve('glm-5.2').reasoningProfile).toMatchObject({
      efforts: ['high', 'max'],
      wire: 'qwen-thinking',
    })
    expect(resolve('deepseek-v4-pro').reasoningProfile).toMatchObject({
      efforts: ['high', 'max'],
      wire: 'qwen-thinking',
    })
  })

  it('exposes budget-driven hybrids as a plain on/off toggle', () => {
    const plus = resolve('qwen3.7-plus')
    expect(plus.reasoning).toBe(true)
    expect(plus.vision).toBe(true)
    expect(plus.reasoningProfile).toMatchObject({
      toggleable: true,
      defaultOn: true,
      efforts: [],
      wire: 'qwen-thinking',
    })

    // Older hybrids do not think unless asked.
    expect(resolve('qwen3-32b').reasoningProfile).toMatchObject({ defaultOn: false })
  })

  it('marks always-thinking Kimi coder models as untoggleable', () => {
    expect(resolve('kimi-k2.7-code').reasoningProfile).toMatchObject({
      toggleable: false,
      wire: 'none',
    })
    expect(resolve('kimi-k2.6').reasoningProfile).toMatchObject({
      toggleable: true,
      wire: 'qwen-thinking',
    })
  })

  it('leaves non-thinking models alone', () => {
    const ocr = resolve('qwen-vl-ocr')
    expect(ocr.reasoning).toBe(false)
    expect(ocr.vision).toBe(true)
    expect(ocr.reasoningProfile).toBeUndefined()
  })
})
