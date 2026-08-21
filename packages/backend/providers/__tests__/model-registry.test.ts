import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, ModelCapabilityEntry } from '@shared/ipc.js'
import { createDefaultSettings } from '@shared/defaults/settings.js'

const state = vi.hoisted(() => ({
  settings: {} as AppSettings,
  saveSettings: vi.fn(),
}))

vi.mock('../../stores/settings.js', () => ({
  getSettings: () => state.settings,
  saveSettings: state.saveSettings,
}))

const {
  getModelById,
  getModelContextLength,
  getModelMaxOutputTokens,
  modelSupportsImageGeneration,
} = await import('../model-registry.js')

function entry(
  id: string,
  provider: string,
  contextLength: number,
  maxOutputTokens: number,
): ModelCapabilityEntry {
  return {
    id,
    name: id,
    provider,
    contextLength,
    maxOutputTokens,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsImageOutput: false,
    supportsTemperature: true,
    inputModalities: ['text'],
    outputModalities: ['text'],
    pricing: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  }
}

describe('model registry metadata lookups', () => {
  beforeEach(() => {
    state.saveSettings.mockReset()
    state.settings = createDefaultSettings()
    state.settings.ai.provider = 'openai'
    state.settings.ai.temperature = 0.7
    state.settings.ai.providers.openai = {
      model: 'shared-model',
      selectedModels: ['shared-model'],
      models: {
        'shared-model': entry('shared-model', 'openai', 32000, 4096),
      },
    }
    state.settings.ai.providers.custom = {
      model: 'shared-model',
      selectedModels: ['shared-model'],
      models: {
        'shared-model': entry('shared-model', 'custom', 64000, 8192),
      },
    }
  })

  it('prefers the current provider when model ids collide', async () => {
    await expect(getModelContextLength('shared-model', 'custom')).resolves.toBe(64000)
    await expect(getModelMaxOutputTokens('shared-model', 'custom')).resolves.toBe(8192)
    await expect(getModelContextLength('shared-model', 'openai')).resolves.toBe(32000)
  })

  it('does not fall back to another provider when a scoped lookup misses', async () => {
    state.settings.ai.providers.openai.models!['openai-only'] = entry('openai-only', 'openai', 1050000, 128000)

    await expect(getModelContextLength('openai-only', 'custom')).resolves.toBe(128000)
    await expect(getModelById('openai-only', 'custom')).resolves.toBeUndefined()
  })

  it('uses provider-scoped capability metadata when model ids collide', async () => {
    state.settings.ai.providers.openai.models!['shared-model'].supportsReasoning = true
    state.settings.ai.providers.openai.models!['shared-model'].supportsImageOutput = true
    state.settings.ai.providers.custom.models!['shared-model'].supportsReasoning = false
    state.settings.ai.providers.custom.models!['shared-model'].supportsImageOutput = false

    // Reasoning scoping moved to model-capability.test.ts (runtime package).
    await expect(modelSupportsImageGeneration('shared-model', 'custom')).resolves.toBe(false)
    await expect(modelSupportsImageGeneration('shared-model', 'openai')).resolves.toBe(true)
  })

  it('uses provider-direct fallback metadata when models are not in settings', async () => {
    await expect(getModelContextLength('gpt-4.1', 'github-copilot')).resolves.toBe(1000000)
    await expect(getModelMaxOutputTokens('gpt-5.3-codex', 'codex')).resolves.toBe(65536)
    await expect(getModelById('gpt-5.3-codex', 'codex')).resolves.toMatchObject({
      context_length: 192000,
    })
  })
})
