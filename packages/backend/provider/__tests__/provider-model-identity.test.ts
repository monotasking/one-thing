/**
 * 模型认亲黄金表(批 3 §6.3)。夹具是一份**精简的 models.dev 快照**(按缓存文件的 `data`
 * 形状手写,不下载):九家第一方 + openrouter 总表 + 五家会与第一方同名的聚合 / 云站。
 */
import { describe, expect, it } from 'vitest'
import type { OnethingModelsDevModel, OnethingModelsDevResponse } from '../provider-model-registry.js'
import {
  buildModelIdentityIndex,
  modelIdentityIndexOf,
  modelParameterSuggestionOf,
  normalizeModelId,
  resolveModelTwin,
} from '../provider-model-identity.js'

function m(
  id: string,
  over: Partial<OnethingModelsDevModel> = {},
): OnethingModelsDevModel {
  return { id, name: id, ...over }
}

function provider(id: string, ids: Array<string | OnethingModelsDevModel>, name = id) {
  const models: Record<string, OnethingModelsDevModel> = {}
  for (const item of ids) {
    const model = typeof item === 'string' ? m(item) : item
    models[model.id] = model
  }
  return { id, name, models }
}

const SNAPSHOT: OnethingModelsDevResponse = {
  openai: provider('openai', [
    m('gpt-5.5', {
      limit: { context: 400000, output: 128000 },
      tool_call: true,
      reasoning: true,
      modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    }),
    'gpt-5.5-mini',
    'gpt-4o',
    'o3',
  ], 'OpenAI'),
  anthropic: provider('anthropic', [
    m('claude-fable-5-1', { limit: { context: 200000, output: 64000 }, tool_call: true }),
    'claude-opus-4-5-20251101',
    'claude-sonnet-4-5',
    'claude-haiku-4-5-20251001',
  ], 'Anthropic'),
  google: provider('google', ['gemini-2.5-pro', 'gemini-2.5-flash']),
  deepseek: provider('deepseek', ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v3.2', 'deepseek-v3.2-exp']),
  moonshotai: provider('moonshotai', ['kimi-k2-thinking']),
  'moonshotai-cn': provider('moonshotai-cn', ['kimi-k2-thinking']),
  xai: provider('xai', ['grok-4', 'grok-4-fast']),
  zhipuai: provider('zhipuai', ['glm-4.6']),
  zai: provider('zai', ['glm-4.6']),
  alibaba: provider('alibaba', ['qwen3-max', 'qwen3-coder-plus']),
  mistral: provider('mistral', ['mistral-large-2411']),
  openrouter: provider('openrouter', [
    'openai/gpt-5.5',
    'deepseek/deepseek-v3.2',
    'meta-llama/llama-3.3-70b-instruct',
    'anthropic/claude-sonnet-4.5',
  ]),
  azure: provider('azure', ['gpt-5.5', 'gpt-4o']),
  'github-copilot': provider('github-copilot', ['gpt-5.5', 'claude-fable-5-1']),
  groq: provider('groq', ['llama-3.3-70b-versatile']),
  cerebras: provider('cerebras', ['llama-3.3-70b-versatile']),
  siliconflow: provider('siliconflow', ['deepseek-ai/DeepSeek-V3.2', 'deepseek-chat']),
  deepinfra: provider('deepinfra', ['deepseek-ai/DeepSeek-V3.2']),
}

const index = buildModelIdentityIndex(SNAPSHOT)

/** 30+ 个真实转发站 / 本地框架会报出来的 id → 该认成谁。 */
const GOLDEN: Array<[string, string, string, 'prefix' | 'exact' | 'normalized']> = [
  ['openai/gpt-5.5', 'openai', 'gpt-5.5', 'prefix'],
  ['anthropic/claude-fable-5-1', 'anthropic', 'claude-fable-5-1', 'prefix'],
  ['deepseek-ai/DeepSeek-V3.2', 'deepseek', 'deepseek-v3.2', 'normalized'],
  ['claude-fable-5-1', 'anthropic', 'claude-fable-5-1', 'exact'],
  ['deepseek-chat', 'deepseek', 'deepseek-chat', 'exact'],
  ['DeepSeek-V3.2-Exp', 'deepseek', 'deepseek-v3.2-exp', 'normalized'],
  ['qwen3-max:free', 'alibaba', 'qwen3-max', 'normalized'],
  ['gpt-5.5', 'openai', 'gpt-5.5', 'exact'],
  ['gpt-4o', 'openai', 'gpt-4o', 'exact'],
  ['o3', 'openai', 'o3', 'exact'],
  ['claude-sonnet-4-5', 'anthropic', 'claude-sonnet-4-5', 'exact'],
  ['claude-opus-4-5-20251101', 'anthropic', 'claude-opus-4-5-20251101', 'exact'],
  ['claude-opus-4-5', 'anthropic', 'claude-opus-4-5-20251101', 'normalized'],
  ['claude-haiku-4-5-20251001', 'anthropic', 'claude-haiku-4-5-20251001', 'exact'],
  ['gemini-2.5-pro', 'google', 'gemini-2.5-pro', 'exact'],
  ['google/gemini-2.5-flash', 'google', 'gemini-2.5-flash', 'prefix'],
  ['gemini-2.5-pro-preview', 'google', 'gemini-2.5-pro', 'normalized'],
  ['deepseek-reasoner', 'deepseek', 'deepseek-reasoner', 'exact'],
  ['moonshotai/kimi-k2-thinking', 'moonshotai', 'kimi-k2-thinking', 'prefix'],
  ['kimi-k2-thinking', 'moonshotai', 'kimi-k2-thinking', 'exact'],
  ['x-ai/grok-4', 'xai', 'grok-4', 'prefix'],
  ['grok-4-fast', 'xai', 'grok-4-fast', 'exact'],
  ['z-ai/glm-4.6', 'zhipuai', 'glm-4.6', 'prefix'],
  ['glm-4.6', 'zhipuai', 'glm-4.6', 'exact'],
  ['qwen/qwen3-max', 'alibaba', 'qwen3-max', 'prefix'],
  ['Qwen3-Coder-Plus', 'alibaba', 'qwen3-coder-plus', 'normalized'],
  ['mistralai/mistral-large-2411', 'mistral', 'mistral-large-2411', 'prefix'],
  ['meta-llama/llama-3.3-70b-instruct', 'openrouter', 'meta-llama/llama-3.3-70b-instruct', 'prefix'],
  ['gpt_4o', 'openai', 'gpt-4o', 'normalized'],
  ['gpt-5.5-latest', 'openai', 'gpt-5.5', 'normalized'],
  ['openai/gpt-5.5-mini', 'openai', 'gpt-5.5-mini', 'prefix'],
  ['deepseek-v3.2', 'deepseek', 'deepseek-v3.2', 'exact'],
]

/** 必须答 null 的五类。 */
const MUST_BE_NULL: Array<[string, string]> = [
  ['my-finetune-v2', '自己的微调:目录里没有'],
  ['gpt', '厂牌名不是型号'],
  ['chat', '通用词'],
  ['llama-3.3-70b-versatile', '同名多家、没有一家是第一方'],
  ['claude-haiku-4-5-20250301', '日期尾不同 = 不同版本'],
]

describe('resolveModelTwin — 黄金表', () => {
  it.each(GOLDEN)('%s → %s · %s(%s)', (input, providerKey, id, level) => {
    expect(resolveModelTwin(input, index)).toEqual({ twin: { provider: providerKey, id }, level })
  })

  it.each(MUST_BE_NULL)('%s → null(%s)', (input) => {
    expect(resolveModelTwin(input, index)).toBeNull()
  })

  it('黄金表至少 30 条', () => {
    expect(GOLDEN.length).toBeGreaterThanOrEqual(30)
  })
})

describe('normalizeModelId', () => {
  it('小写 / 去厂牌路径 / 去尾缀 / 去日期尾 / _ 与 - 同视', () => {
    expect(normalizeModelId('Qwen/Qwen3_Max:free')).toEqual({ norm: 'qwen3-max' })
    expect(normalizeModelId('claude-x-preview-20260118')).toEqual({ norm: 'claude-x', date: '20260118' })
    expect(normalizeModelId('gpt-5.5-2026-01-18')).toEqual({ norm: 'gpt-5.5', date: '20260118' })
    expect(normalizeModelId('gemini-2.5-pro-latest')).toEqual({ norm: 'gemini-2.5-pro' })
  })
})

describe('modelIdentityIndexOf — memo 按 fetchedAt 失效', () => {
  it('同一份快照只建一次;fetchedAt 变了重建', () => {
    const first = modelIdentityIndexOf({ data: SNAPSHOT, fetchedAt: 1 })
    expect(modelIdentityIndexOf({ data: SNAPSHOT, fetchedAt: 1 })).toBe(first)
    expect(modelIdentityIndexOf({ data: SNAPSHOT, fetchedAt: 2 })).not.toBe(first)
  })
})

describe('modelParameterSuggestionOf — 只在不知道的格上给', () => {
  const allGaps = {
    contextLength: true,
    maxOutput: true,
    capabilities: { tools: true, vision: true, reasoning: true, imageOutput: true, fileInput: true },
  }

  it('手填 gpt-5.5:上下文 / 输出 / 支持的能力全给,不支持的不给,来源带 models.dev 的名字', () => {
    const found = modelParameterSuggestionOf({ modelId: 'gpt-5.5', index, gaps: allGaps })
    expect(found?.suggestion).toEqual({
      from: { provider: 'openai', id: 'gpt-5.5', providerName: 'OpenAI' },
      contextLength: 400000,
      maxOutput: 128000,
      capabilities: { tools: true, vision: true, reasoning: true, fileInput: true },
    })
  })

  it('已知的格不给(上下文接口报了 → 只给输出与能力)', () => {
    const found = modelParameterSuggestionOf({
      modelId: 'claude-fable-5-1',
      index,
      gaps: { ...allGaps, contextLength: false },
    })
    expect(found?.suggestion).toEqual({
      from: { provider: 'anthropic', id: 'claude-fable-5-1', providerName: 'Anthropic' },
      maxOutput: 64000,
      capabilities: { tools: true },
    })
  })

  it('没有缺口、认不出、或认出来的那一型什么都没说 → undefined', () => {
    const noGaps = {
      contextLength: false,
      maxOutput: false,
      capabilities: { tools: false, vision: false, reasoning: false, imageOutput: false, fileInput: false },
    }
    expect(modelParameterSuggestionOf({ modelId: 'gpt-5.5', index, gaps: noGaps })).toBeUndefined()
    expect(modelParameterSuggestionOf({ modelId: 'my-finetune-v2', index, gaps: allGaps })).toBeUndefined()
    expect(modelParameterSuggestionOf({ modelId: 'o3', index, gaps: allGaps })).toBeUndefined()
  })
})
