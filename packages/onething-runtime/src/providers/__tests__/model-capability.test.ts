import { describe, expect, it } from 'vitest'
import {
  resolveOnethingModelCapabilities,
  resolveOnethingProviderKind,
} from '../model-capability.js'

function resolve(providerId: string, modelId: string, extra: Record<string, unknown> = {}) {
  return resolveOnethingModelCapabilities({ providerId, modelId, ...extra })
}

describe('resolveOnethingProviderKind', () => {
  it('maps provider ids and custom apiType to kinds', () => {
    expect(resolveOnethingProviderKind('claude')).toBe('claude')
    expect(resolveOnethingProviderKind('claude-code')).toBe('claude')
    expect(resolveOnethingProviderKind('grok-oauth')).toBe('grok')
    expect(resolveOnethingProviderKind('github-copilot')).toBe('copilot')
    expect(resolveOnethingProviderKind('custom-abc', 'anthropic')).toBe('claude')
    expect(resolveOnethingProviderKind('custom-abc', 'openai')).toBe('openai')
    expect(resolveOnethingProviderKind('custom-abc')).toBe('openai')
    expect(resolveOnethingProviderKind('something-else')).toBe('unknown')
  })
})

describe('resolution priority', () => {
  it('override beats registry beats pattern', () => {
    // Pattern says gpt-5 reasons; registry says no; registry wins over pattern.
    expect(resolve('openai', 'gpt-5.2', {
      registryEntry: { supportsReasoning: false },
    })).toMatchObject({ reasoning: false, source: { reasoning: 'registry' } })

    // Override beats registry.
    expect(resolve('openai', 'gpt-5.2', {
      override: { reasoning: true },
      registryEntry: { supportsReasoning: false },
    })).toMatchObject({ reasoning: true, source: { reasoning: 'override' } })

    // Pattern fills in when no data exists.
    expect(resolve('openai', 'gpt-5.2')).toMatchObject({
      reasoning: true,
      source: { reasoning: 'pattern' },
    })
  })

  it('keeps provider-scoped override semantics (migrated from the deleted registry lookups)', () => {
    // The old onethingModelSupportsReasoningSync test: entry says no,
    // override says yes → yes.
    expect(resolve('custom-x', 'shared-model', {
      customApiType: 'openai',
      override: { reasoning: true },
      registryEntry: { supportsReasoning: false },
    }).reasoning).toBe(true)

    // Same model under another provider without the override follows its entry.
    expect(resolve('openai', 'shared-model', {
      registryEntry: { supportsReasoning: true },
    }).reasoning).toBe(true)
    expect(resolve('openai', 'shared-model', {
      registryEntry: { supportsReasoning: false },
    }).reasoning).toBe(false)
  })

  it('reads wire-shaped metadata when no storage entry exists', () => {
    const metadata = {
      supported_parameters: ['tools', 'reasoning', 'temperature'],
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    }
    const resolved = resolve('openrouter', 'some/model', { modelMetadata: metadata })
    expect(resolved).toMatchObject({
      reasoning: true,
      tools: true,
      vision: true,
      imageOutput: false,
      temperature: true,
      source: { reasoning: 'registry', vision: 'registry' },
    })
  })

  it('treats codex nativeTools image_generation as image output', () => {
    expect(resolve('codex', 'gpt-5.3-codex', {
      modelMetadata: { providerMetadata: { codex: { nativeTools: ['image_generation'] } } },
    }).imageOutput).toBe(true)
  })

  it('honours codex nativeTools on a cached registry entry that says supportsImageOutput:false', () => {
    // The real-machine shape: /codex/models/gpt-5.5 was written before the
    // entry generator knew that the native image_generation tool implies image
    // output, so its own boolean lies. The native tool wins.
    const resolved = resolve('codex', 'gpt-5.5', {
      registryEntry: {
        supportsImageOutput: false,
        providerMetadata: { codex: { nativeTools: ['image_generation'] } },
      },
    })
    expect(resolved.imageOutput).toBe(true)
    expect(resolved.source.imageOutput).toBe('registry')
  })

  it('says who serves the image output (in-loop vs dedicated-api vs unknown)', () => {
    // Codex native image_generation = produced inside the agent loop; the
    // dedicated image stream must not take over (see
    // onethingModelSupportsImageGeneration).
    expect(resolve('codex', 'gpt-5.5', {
      registryEntry: {
        supportsImageOutput: false,
        providerMetadata: { codex: { nativeTools: ['image_generation'] } },
      },
    }).imageOutputServedBy).toBe('in-loop')
    // A real image endpoint: the turn has to leave the loop. (The openai rules
    // table has no image row — the registry entry is what the ledger reads;
    // the name pattern only fires for unknown providers.)
    expect(resolve('openai', 'gpt-image-1', {
      registryEntry: { supportsImageOutput: true },
    }).imageOutputServedBy).toBe('dedicated-api')
    expect(resolve('whatever', 'gpt-image-1').imageOutputServedBy).toBe('dedicated-api')
    // OpenRouter is chat-completions all the way: the request declares
    // `modalities: ['text','image']` and the reply carries the image itself,
    // so an image-capable model there stays on the normal stream (P3-2).
    expect(resolve('openrouter', 'google/gemini-2.5-flash-image', {
      registryEntry: { supportsImageOutput: true },
    }).imageOutputServedBy).toBe('in-loop')
    // The same upstream model on Google's own endpoint is still a dedicated
    // API — GeminiWire does not parse inlineData output yet.
    expect(resolve('gemini', 'gemini-2.5-flash-image', {
      registryEntry: { supportsImageOutput: true },
    }).imageOutputServedBy).toBe('dedicated-api')
    // Plain text model: the ledger has nothing to say.
    expect(resolve('openai', 'gpt-5.2').imageOutputServedBy).toBeUndefined()
  })

  it('does not grant image output when the codex native tool table is empty', () => {
    const resolved = resolve('codex', 'gpt-5.5', {
      registryEntry: {
        supportsImageOutput: false,
        providerMetadata: { codex: { nativeTools: [] } },
      },
    })
    expect(resolved.imageOutput).toBe(false)
    expect(resolved.source.imageOutput).toBe('registry')
  })
})

describe('reasoning profiles per provider', () => {
  it('claude: adaptive wire on 4.6+, budget wire before, defaultOn only for sonnet-5/fable', () => {
    const opus = resolve('claude', 'claude-opus-4-8')
    expect(opus.reasoning).toBe(true)
    expect(opus.reasoningProfile).toMatchObject({ wire: 'anthropic-adaptive', defaultOn: false })

    const haiku = resolve('claude', 'claude-haiku-4-5')
    expect(haiku.reasoningProfile).toMatchObject({ wire: 'anthropic-budget' })

    const sonnet5 = resolve('claude', 'claude-sonnet-5')
    expect(sonnet5.reasoningProfile).toMatchObject({ wire: 'anthropic-adaptive', defaultOn: true })

    const fable = resolve('claude', 'claude-fable-5')
    expect(fable.reasoningProfile).toMatchObject({ toggleable: false, defaultOn: true })
  })

  it('claude: legacy dated ids read their real generation, modern ids are untouched', () => {
    // #11 —— 「版本在前、日期在后」的老式 id 曾被 `sonnet-20250219` 那一段
    // 读成 major=20250219,于是 3.x 全被判成 adaptive + samplingRemoved。
    const sonnet37 = resolve('claude', 'claude-3-7-sonnet-20250219')
    expect(sonnet37.reasoningProfile).toMatchObject({ wire: 'anthropic-budget' })
    expect(sonnet37.temperature).toBe(true)

    const haiku35 = resolve('claude', 'claude-3-5-haiku-20241022')
    expect(haiku35.reasoningProfile).toMatchObject({ wire: 'anthropic-budget' })
    expect(haiku35.temperature).toBe(true)

    // 没有日期后缀的老式 id 同样得读对。
    expect(resolve('claude', 'claude-3-opus-latest').reasoningProfile)
      .toMatchObject({ wire: 'anthropic-budget' })

    // 现代 id 的判定一个字没变。
    expect(resolve('claude', 'claude-sonnet-5').reasoningProfile)
      .toMatchObject({ wire: 'anthropic-adaptive', defaultOn: true })
    expect(resolve('claude', 'claude-opus-4-6').reasoningProfile)
      .toMatchObject({ wire: 'anthropic-adaptive' })
    expect(resolve('claude', 'claude-opus-4-1').reasoningProfile)
      .toMatchObject({ wire: 'anthropic-budget' })
    expect(resolve('claude', 'claude-haiku-4-5').reasoningProfile)
      .toMatchObject({ wire: 'anthropic-budget' })
    // 带日期的现代 id 也不能被日期段带偏。
    expect(resolve('claude', 'claude-sonnet-4-5-20250929').reasoningProfile)
      .toMatchObject({ wire: 'anthropic-budget' })
  })

  it('forced tool use: zhipu never, kimi only on K3', () => {
    // #5b —— 智谱官方 `tool_choice` 只收 auto;Kimi 只有 K3 收 required。
    expect(resolve('zhipu', 'glm-5').forcedToolUse).toBe(false)
    expect(resolve('zhipu', 'glm-4.6').forcedToolUse).toBe(false)
    expect(resolve('kimi', 'kimi-k3').forcedToolUse).toBe(true)
    // Kimi Code 套餐给 K3 起的裸名字。
    expect(resolve('kimi-code', 'k3').forcedToolUse).toBe(true)
    expect(resolve('kimi', 'kimi-k2.6').forcedToolUse).toBe(false)
    expect(resolve('kimi', 'kimi-k2.7-code').forcedToolUse).toBe(false)
    expect(resolve('kimi', 'moonshot-v1-128k').forcedToolUse).toBe(false)
    // 账本对别家没话说 = provider 自己的传输声明说了算。
    expect(resolve('openai', 'gpt-5.5').forcedToolUse).toBeUndefined()
    expect(resolve('deepseek', 'deepseek-v4').forcedToolUse).toBeUndefined()
  })

  it('gemini: level wire on 3.x, budget wire on 2.5, none before 2.5', () => {
    expect(resolve('gemini', 'gemini-3-pro').reasoningProfile).toMatchObject({ wire: 'gemini-level' })
    expect(resolve('gemini', 'gemini-2.5-flash').reasoningProfile).toMatchObject({ wire: 'gemini-budget' })
    expect(resolve('gemini', 'gemini-2.0-flash').reasoning).toBe(false)
  })

  it('gemini efforts follow what each generation actually accepts', () => {
    expect(resolve('gemini', 'gemini-3-pro-preview').reasoningProfile?.efforts).toEqual(['low', 'high'])
    expect(resolve('gemini', 'gemini-3.1-pro-preview').reasoningProfile?.efforts).toEqual(['low', 'medium', 'high'])
    expect(resolve('gemini', 'gemini-3-flash-preview').reasoningProfile?.efforts)
      .toEqual(['minimal', 'low', 'medium', 'high'])
    expect(resolve('gemini', 'gemini-3.1-flash-lite-image').reasoningProfile?.efforts).toEqual(['minimal', 'high'])
    expect(resolve('gemini', 'gemini-2.5-pro').reasoningProfile?.efforts).toEqual(['low', 'medium', 'high'])
  })

  it('openai and grok reasoning cannot be toggled off', () => {
    expect(resolve('openai', 'gpt-5.2').reasoningProfile?.toggleable).toBe(false)
    expect(resolve('grok', 'grok-4.5').reasoningProfile?.toggleable).toBe(false)
    // Claude (non-Fable) and Gemini stay toggleable.
    expect(resolve('claude', 'claude-opus-4-8').reasoningProfile?.toggleable).toBe(true)
    expect(resolve('gemini', 'gemini-3-pro').reasoningProfile?.toggleable).toBe(true)
  })

  it('kimi families: k3 max-only, k2-code hidden knob, k2.5 plain toggle', () => {
    expect(resolve('kimi', 'kimi-k3').reasoningProfile).toMatchObject({ efforts: ['max'] })
    expect(resolve('kimi', 'kimi-k2.7-code').reasoningProfile).toMatchObject({
      toggleable: false,
      efforts: [],
    })
    expect(resolve('kimi', 'kimi-k2.5').reasoningProfile).toMatchObject({
      toggleable: true,
      efforts: [],
      wire: 'thinking-type',
    })
    expect(resolve('kimi', 'moonshot-v1-128k').reasoning).toBe(false)
  })

  it('deepseek: v4 exposes high/max, reasoner is always-on with no knob, chat has none', () => {
    expect(resolve('deepseek', 'deepseek-v4').reasoningProfile).toMatchObject({
      efforts: ['high', 'max'],
      // 官方原文:「思考模式默认打开,且 effort 默认为 high」(#6)。
      defaultOn: true,
    })
    expect(resolve('deepseek', 'deepseek-v4-flash').reasoningProfile?.defaultOn).toBe(true)
    expect(resolve('deepseek', 'deepseek-reasoner').reasoningProfile).toMatchObject({
      toggleable: false,
      efforts: [],
    })
    expect(resolve('deepseek', 'deepseek-chat').reasoning).toBe(false)
  })

  it('deepseek: only the vision-exp family takes image input', () => {
    // The vision row sits first but declares `vision` only — the v4 row below
    // it still owns `reasoning`, because each capability takes the first row
    // that gives it a boolean.
    expect(resolve('deepseek', 'deepseek-v4-flash-vision-exp').vision).toBe(true)
    expect(resolve('deepseek', 'deepseek-v4-flash-vision-exp').reasoning).toBe(true)
    expect(resolve('deepseek', 'deepseek-chat').vision).toBe(false)
    expect(resolve('deepseek', 'deepseek-v4').vision).toBe(false)
  })

  it('zhipu and grok gate by generation patterns', () => {
    expect(resolve('zhipu', 'glm-5.2').reasoningProfile).toMatchObject({ wire: 'zhipu-thinking', efforts: [] })
    expect(resolve('zhipu', 'glm-4').reasoning).toBe(false)
    expect(resolve('grok', 'grok-4.5').reasoningProfile).toMatchObject({ wire: 'grok-effort' })
    expect(resolve('grok', 'grok-2').reasoning).toBe(false)
  })

  it('openrouter profiles apply once the registry confirms reasoning', () => {
    expect(resolve('openrouter', 'anthropic/claude-sonnet-5').reasoning).toBe(false)
    const confirmed = resolve('openrouter', 'anthropic/claude-sonnet-5', {
      modelMetadata: { supported_parameters: ['reasoning'] },
    })
    expect(confirmed.reasoningProfile).toMatchObject({ wire: 'openrouter-reasoning' })
    expect(confirmed.reasoningProfile?.efforts).toContain('xhigh')
  })
})

describe('temperature support', () => {
  it('claude 4.7+/Sonnet 5/Fable reject temperature even when the registry says otherwise', () => {
    expect(resolve('claude', 'claude-opus-4-8').temperature).toBe(false)
    expect(resolve('claude', 'claude-fable-5', {
      registryEntry: { supportsTemperature: true },
    }).temperature).toBe(false)
    expect(resolve('claude', 'claude-sonnet-4-6').temperature).toBe(true)
    expect(resolve('claude', 'claude-haiku-4-5').temperature).toBe(true)
  })

  it('other providers follow the registry with a permissive default', () => {
    expect(resolve('openai', 'o1-mini', {
      registryEntry: { supportsTemperature: false },
    }).temperature).toBe(false)
    expect(resolve('openai', 'gpt-4o').temperature).toBe(true)
  })
})

describe('copilot patterns (migrated from detectCopilotModelCapabilities)', () => {
  it('keeps the copilot heuristics', () => {
    expect(resolve('github-copilot', 'o3-mini')).toMatchObject({ reasoning: true, tools: true })
    expect(resolve('github-copilot', 'o1-mini')).toMatchObject({ reasoning: true, tools: false })
    expect(resolve('github-copilot', 'gpt-4o')).toMatchObject({ vision: true, reasoning: false })
    expect(resolve('github-copilot', 'dall-e-3')).toMatchObject({ imageOutput: true, tools: false })
    expect(resolve('github-copilot', 'claude-3.5-sonnet').vision).toBe(true)
  })
})

describe('generic fallbacks (migrated from the renderer heuristics)', () => {
  it('keeps the unknown-provider reasoning and image-generation patterns', () => {
    expect(resolve('unknown-provider', 'some-deepseek-r1-distill').reasoning).toBe(true)
    expect(resolve('unknown-provider', 'stable-diffusion-xl').imageOutput).toBe(true)
    expect(resolve('unknown-provider', 'plain-chat-model').reasoning).toBe(false)
  })

  it('wire parameter lists are positive-only; storage booleans are authoritative both ways', () => {
    // supported_parameters without 'reasoning' is weak evidence — name
    // patterns still apply (matches the old renderer display behavior).
    expect(resolve('unknown-provider', 'super-reasoner', {
      modelMetadata: { supported_parameters: ['tools'] },
    }).reasoning).toBe(true)
    // A persisted registry entry saying "no" is an explicit verdict and wins.
    expect(resolve('unknown-provider', 'super-reasoner', {
      registryEntry: { supportsReasoning: false },
    }).reasoning).toBe(false)
  })
})
