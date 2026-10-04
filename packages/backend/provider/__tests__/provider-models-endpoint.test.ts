/**
 * 直连拉目录(批 3 §6.2):四种形状、参数字段、失败原话,以及 `refreshOnethingProviderModels`
 * 按 manifest 分派到它、`unreported` 读成「不知道」。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  directModelsRequestHeaders,
  fetchProviderDirectModels,
  resolveModelsEndpointUrl,
} from '../provider-models-endpoint.js'
import {
  onethingModelSupportsTemperature,
  onethingModelSupportsTools,
  readsProviderDirectModels,
  refreshOnethingProviderModels,
  type OnethingModelRegistrySettingsLike,
} from '../provider-model-registry.js'
import { effectiveModelFactsOf } from '../provider-effective-model.js'
import { registerCustomProvidersForTest } from './custom-manifest-fixture.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function fakeFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
    calls.push({ url: input, headers: (init?.headers ?? {}) as Record<string, string> })
    return jsonResponse(body, status)
  })
  return { fetchImpl, calls }
}

describe('fetchProviderDirectModels — 四种形状', () => {
  it('{data:[{id}]} —— OpenAI 形', async () => {
    const { fetchImpl } = fakeFetch({ object: 'list', data: [{ id: 'gpt-5.5', owned_by: 'x' }, { id: 'o3' }] })
    const models = await fetchProviderDirectModels({ baseUrl: 'http://relay/v1', fetchImpl })
    expect(models.map(m => m.id)).toEqual(['gpt-5.5', 'o3'])
    expect(models[0]).toMatchObject({ name: 'gpt-5.5', source: 'endpoint', context_length: 0 })
  })

  it('{data:[{id,display_name}]} —— Anthropic 形,名字取 display_name', async () => {
    const { fetchImpl } = fakeFetch({ data: [{ id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1' }] })
    const [model] = await fetchProviderDirectModels({ baseUrl: 'http://relay/v1', fetchImpl })
    expect(model).toMatchObject({ id: 'claude-fable-5-1', name: 'Claude Fable 5.1' })
  })

  it('{models:[{name}]} —— Ollama /api/tags 形', async () => {
    const { fetchImpl } = fakeFetch({ models: [{ name: 'qwen3:8b', model: 'qwen3:8b' }, { name: 'llama3.3' }] })
    const models = await fetchProviderDirectModels({ baseUrl: 'http://localhost:11434', modelsUrl: '/api/tags', fetchImpl })
    expect(models.map(m => m.id)).toEqual(['qwen3:8b', 'llama3.3'])
  })

  it('纯字符串数组;重复 id 只留第一条,空串跳过', async () => {
    const { fetchImpl } = fakeFetch(['a', 'b', 'a', ''])
    const models = await fetchProviderDirectModels({ baseUrl: 'http://x', fetchImpl })
    expect(models.map(m => m.id)).toEqual(['a', 'b'])
  })
})

describe('fetchProviderDirectModels — 参数字段拿全', () => {
  it('OpenRouter 形:context_length / max_completion_tokens / 模态 / 参数表 / 价(每 token → 每百万)', async () => {
    const { fetchImpl } = fakeFetch({
      data: [{
        id: 'openai/gpt-5.5',
        name: 'OpenAI: GPT-5.5',
        context_length: 400000,
        top_provider: { context_length: 400000, max_completion_tokens: 128000 },
        architecture: { input_modalities: ['text', 'image', 'file'], output_modalities: ['text'] },
        supported_parameters: ['tools', 'reasoning', 'temperature'],
        pricing: { prompt: '0.00000125', completion: '0.00001' },
      }],
    })
    const [model] = await fetchProviderDirectModels({ baseUrl: 'http://x', fetchImpl })
    expect(model.context_length).toBe(400000)
    expect(model.top_provider.max_completion_tokens).toBe(128000)
    expect(model.architecture.input_modalities).toEqual(['text', 'image', 'file'])
    expect(model.supported_parameters).toEqual(['tools', 'reasoning', 'temperature'])
    expect(model.pricing).toMatchObject({ prompt: '1.25', completion: '10' })
    expect(model.unreported).toBeUndefined()
    expect(model.name).toBe('OpenAI: GPT-5.5')
  })

  it('vLLM 形:max_model_len 当上下文;没报的能力记进 unreported', async () => {
    const { fetchImpl } = fakeFetch({ data: [{ id: 'Qwen/Qwen3-32B', max_model_len: 32768 }] })
    const [model] = await fetchProviderDirectModels({ baseUrl: 'http://x', fetchImpl })
    expect(model.context_length).toBe(32768)
    expect(model.unreported).toEqual(['tools', 'reasoning', 'temperature', 'vision', 'fileInput', 'imageOutput'])
  })
})

describe('fetchProviderDirectModels — 地址与头', () => {
  it('地址:空 = baseUrl + /models;相对路径接在 baseUrl 后;绝对地址原样', () => {
    expect(resolveModelsEndpointUrl('http://x/v1/')).toBe('http://x/v1/models')
    expect(resolveModelsEndpointUrl('http://x/v1', 'catalog/list')).toBe('http://x/v1/catalog/list')
    expect(resolveModelsEndpointUrl('http://x/v1', '/models?all=1')).toBe('http://x/v1/models?all=1')
    expect(resolveModelsEndpointUrl('http://x/v1', 'https://y/list')).toBe('https://y/list')
  })

  it('头:{{apiKey}} 换成密钥 + 默认 Bearer;用户写了 Authorization 就让位', async () => {
    expect(directModelsRequestHeaders({ 'X-Test': 'k={{apiKey}}' }, 'sk-1')).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer sk-1',
      'X-Test': 'k=sk-1',
    })
    expect(directModelsRequestHeaders({ authorization: 'Token {{apiKey}}' }, 'sk-1')).toEqual({
      Accept: 'application/json',
      authorization: 'Token sk-1',
    })
    // 没有密钥:不发 Bearer,模板换成空串(不把字面 {{apiKey}} 发出网)。
    expect(directModelsRequestHeaders({ 'X-Test': '{{apiKey}}' }, undefined)).toEqual({
      Accept: 'application/json',
      'X-Test': '',
    })

    const { fetchImpl, calls } = fakeFetch({ data: [] })
    await fetchProviderDirectModels({
      baseUrl: 'http://x/v1',
      headers: { 'X-Test': '{{apiKey}}' },
      apiKey: 'sk-live',
      fetchImpl,
    })
    expect(calls[0]).toEqual({
      url: 'http://x/v1/models',
      headers: { Accept: 'application/json', Authorization: 'Bearer sk-live', 'X-Test': 'sk-live' },
    })
  })
})

describe('fetchProviderDirectModels — 失败带原话', () => {
  it('HTTP 非 2xx:状态码 + 响应原话', async () => {
    const { fetchImpl } = fakeFetch({ error: { message: 'invalid api key' } }, 401)
    await expect(fetchProviderDirectModels({ baseUrl: 'http://x', fetchImpl })).rejects.toThrow(
      /HTTP 401: .*invalid api key/,
    )
  })

  it('不是 JSON', async () => {
    const { fetchImpl } = fakeFetch('<html>gateway</html>')
    await expect(fetchProviderDirectModels({ baseUrl: 'http://x', fetchImpl })).rejects.toThrow(
      /not JSON: <html>gateway<\/html>/,
    )
  })

  it('形状认不出', async () => {
    const { fetchImpl } = fakeFetch({ result: { list: [] } })
    await expect(fetchProviderDirectModels({ baseUrl: 'http://x', fetchImpl })).rejects.toThrow(
      /Unrecognized model list response: \{"result"/,
    )
  })

  it('没有接口地址', async () => {
    const { fetchImpl } = fakeFetch({ data: [] })
    await expect(fetchProviderDirectModels({ baseUrl: ' ', fetchImpl })).rejects.toThrow(/No endpoint URL/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('refreshOnethingProviderModels — endpoint 家走直连', () => {
  let undo: (() => void) | undefined
  afterEach(() => {
    undo?.()
    undo = undefined
  })

  it('自定义服务商:问它自己的 /models,落 source:endpoint,手填条目保留', async () => {
    undo = registerCustomProvidersForTest(['custom-relay'])
    expect(readsProviderDirectModels('custom-relay')).toBe(true)
    // OAuth 的 endpoint 家(Codex)不走通用直连 —— 它有专属拉取器。
    expect(readsProviderDirectModels('codex')).toBe(false)
    // endpoint + catalogKey(Copilot)能力靠 models.dev 补,仍走目录那条。
    expect(readsProviderDirectModels('github-copilot')).toBe(false)

    const settings: OnethingModelRegistrySettingsLike = {
      ai: {
        providers: {
          'custom-relay': {
            models: { mine: { id: 'mine', name: 'mine', provider: 'custom-relay', source: 'manual' } },
          },
        },
      },
    }
    const fetchModelsDevData = vi.fn(async () => ({}))
    const fetchEndpointModels = vi.fn(async () =>
      fetchProviderDirectModels({
        baseUrl: 'http://relay/v1',
        fetchImpl: fakeFetch({ data: [{ id: 'gpt-5.5', context_length: 400000 }] }).fetchImpl,
      }),
    )
    await refreshOnethingProviderModels('custom-relay', {
      getSettings: () => settings,
      saveSettings: () => {},
      fetchModelsDevData,
      fetchEndpointModels,
      now: () => 7,
    })
    expect(fetchEndpointModels).toHaveBeenCalledWith('custom-relay')
    expect(fetchModelsDevData).not.toHaveBeenCalled()
    const models = settings.ai.providers['custom-relay']?.models ?? {}
    expect(models.mine).toMatchObject({ source: 'manual' })
    expect(models['gpt-5.5']).toMatchObject({
      source: 'endpoint',
      contextLength: 400000,
      unreported: ['tools', 'reasoning', 'temperature', 'vision', 'fileInput', 'imageOutput'],
    })
    expect(settings.ai.providers['custom-relay']?.modelsLastFetched).toBe(7)

    // 没报 = 不知道:工具 / 温度按「没有条目」放行,不被一个 `false` 关掉。
    expect(onethingModelSupportsTools(settings.ai.providers, 'gpt-5.5', 'custom-relay')).toBe(true)
    expect(onethingModelSupportsTemperature(settings.ai.providers, 'gpt-5.5', 'custom-relay')).toBe(true)
    const facts = effectiveModelFactsOf({ entry: models['gpt-5.5'] })
    expect(facts.source.contextLength).toBe('endpoint')
    expect(facts.source.maxOutput).toBe('unknown')
    expect(facts.source.capabilities.tools).toBe('unknown')
    expect(facts.capabilities.tools).toBeNull()
  })

  it('直连失败原样抛(原话),不动既有目录', async () => {
    undo = registerCustomProvidersForTest(['custom-relay'])
    const existing = { a: { id: 'a', name: 'a', provider: 'custom-relay', source: 'manual' as const } }
    const settings: OnethingModelRegistrySettingsLike = {
      ai: { providers: { 'custom-relay': { models: existing } } },
    }
    await expect(
      refreshOnethingProviderModels('custom-relay', {
        getSettings: () => settings,
        saveSettings: () => {},
        fetchModelsDevData: async () => ({}),
        fetchEndpointModels: async () => {
          throw new Error('HTTP 401: invalid api key')
        },
      }),
    ).rejects.toThrow('HTTP 401: invalid api key')
    expect(settings.ai.providers['custom-relay']?.models).toBe(existing)
  })
})
