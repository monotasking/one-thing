import { describe, expect, it } from 'vitest'
import { toJsonObject, type JsonObject, type JsonValue } from '@shared/json.js'
// 服务商自述试点 P2 第 4 批:这几个函数原是 `../codex.js` 对 runtime 的薄转手(生产零调用者),转手层删除,
// 断言改指 runtime 那一家的模块本身(`vendors/codex/models.ts`)。`prepareCodexCallOptions` 随
// 它唯一的去处(没有读者的 `prepareCallOptions` 一格)一起删除,只测它的那一条测试一并删。
import {
  buildOnethingCodexHeaders as buildCodexHeaders,
  buildOnethingCodexModelsUrl as buildCodexModelsUrl,
  ONETHING_CODEX_DEFAULT_MODEL as CODEX_DEFAULT_MODEL,
  codexModelInfoToOnethingOpenRouterModel as codexModelInfoToOpenRouterModel,
  ONETHING_CODEX_CLIENT_VERSION as CODEX_CLIENT_VERSION,
  getOnethingCodexFallbackModel as getCodexFallbackModel,
  getOnethingCodexFallbackModels as getCodexFallbackModels,
} from '@onething/backend/runtime/providers/vendors/codex/models'

function codexMetadata(model: { providerMetadata?: object | null } | null | undefined): JsonObject {
  return toJsonObject(toJsonObject(model?.providerMetadata).codex)
}

function jsonArrayField(object: JsonObject, key: string): JsonValue[] {
  const value = object[key]
  return Array.isArray(value) ? value : []
}

function fieldValues(items: JsonValue[], key: string): JsonValue[] {
  return items.map(item => toJsonObject(item)[key] ?? null)
}

describe('codex provider helpers', () => {
  it('builds ChatGPT subscription auth headers', () => {
    const headers = buildCodexHeaders({
      accessToken: 'access-token',
      expiresAt: Date.now() + 60_000,
      tokenType: 'Bearer',
      accountId: 'acct_123',
      isFedrampAccount: true,
    })

    expect(headers.Authorization).toBe('Bearer access-token')
    expect(headers.originator).toBe('codex_cli_rs')
    expect(headers.version).toBe(CODEX_CLIENT_VERSION)
    expect(headers['ChatGPT-Account-ID']).toBe('acct_123')
    expect(headers['X-OpenAI-Fedramp']).toBe('true')
  })

  it('adds the Codex client version query to model refreshes', () => {
    const url = new URL(buildCodexModelsUrl())

    expect(url.pathname).toBe('/backend-api/codex/models')
    expect(url.searchParams.get('client_version')).toBe(CODEX_CLIENT_VERSION)
  })

  it('provides a usable fallback model', () => {
    const models = getCodexFallbackModels()

    expect(models[0].id).toBe(CODEX_DEFAULT_MODEL)
    expect(models[0].supported_parameters).toContain('tools')
    expect(models[0].supported_parameters).toContain('reasoning')
    const metadata = codexMetadata(models[0])
    expect(metadata.defaultReasoningEffort).toBe('medium')
    expect(fieldValues(jsonArrayField(metadata, 'supportedReasoningEfforts'), 'effort')).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ])
    expect(jsonArrayField(metadata, 'nativeTools')).toContain('image_generation')

    const selectedFallback = getCodexFallbackModel('gpt-5.5')
    expect(selectedFallback.id).toBe('gpt-5.5')
    expect(selectedFallback.supported_parameters).toContain('tools')
    expect(selectedFallback.supported_parameters).toContain('reasoning')
    expect(selectedFallback.architecture.input_modalities).toContain('image')
  })

  it('parses Codex backend model metadata', () => {
    const model = codexModelInfoToOpenRouterModel({
      slug: 'gpt-5.4-codex',
      display_name: 'GPT-5.4 Codex',
      description: 'Next Codex model',
      context_window: 256000,
      input_modalities: ['text', 'image'],
      support_verbosity: true,
      default_reasoning_level: 'low',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast' },
        { effort: 'xhigh', description: 'Deep' },
      ],
      supports_reasoning_summaries: true,
      experimental_supported_tools: ['image_generation'],
      serviceTiers: [
        { id: 'fast', name: 'Fast', description: 'Priority processing.' },
        { id: 'flex', name: 'Flex', description: 'Flexible processing.' },
      ],
    })

    expect(model?.id).toBe('gpt-5.4-codex')
    expect(model?.name).toBe('GPT-5.4 Codex')
    expect(model?.context_length).toBe(256000)
    expect(model?.architecture.input_modalities).toEqual(['text', 'image'])
    expect(model?.supported_parameters).toContain('verbosity')
    expect(model?.supported_parameters).toContain('reasoning')
    const metadata = codexMetadata(model)
    expect(metadata.defaultReasoningEffort).toBe('low')
    expect(jsonArrayField(metadata, 'supportedReasoningEfforts')).toEqual([
      { effort: 'low', description: 'Fast' },
      { effort: 'xhigh', description: 'Deep' },
    ])
    expect(jsonArrayField(metadata, 'serviceTiers')).toEqual([
      { id: 'fast', name: 'Fast', description: 'Priority processing.' },
      { id: 'flex', name: 'Flex', description: 'Flexible processing.' },
    ])
    expect(jsonArrayField(metadata, 'nativeTools')).toEqual(['image_generation'])
  })

  it('respects explicit Codex model metadata when native image generation is absent', () => {
    const model = codexModelInfoToOpenRouterModel({
      slug: 'gpt-5.4-codex',
      input_modalities: ['text', 'image'],
      experimental_supported_tools: ['web_search'],
    })

    expect(jsonArrayField(codexMetadata(model), 'nativeTools')).toEqual([])
    expect(model?.architecture.output_modalities).toEqual(['text'])
  })

  it('parses deprecated Codex speed tiers as service tiers', () => {
    const model = codexModelInfoToOpenRouterModel({
      slug: 'gpt-5.5',
      display_name: 'GPT-5.5',
      additionalSpeedTiers: ['fast'],
    })

    expect(jsonArrayField(codexMetadata(model), 'serviceTiers')).toEqual([
      { id: 'fast', name: 'Fast', description: undefined },
    ])
    expect(model?.architecture.input_modalities).toEqual(['text', 'image'])
  })
})
