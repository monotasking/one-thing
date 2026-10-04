import { describe, expect, it, vi } from 'vitest'
import type { AgentProvider } from '@onething/backend/agent-loop'
import {
  createOnethingUtilityAgentProvider,
  isOnethingACPProviderRuntime,
  resolveOnethingProviderRuntimeRoute,
} from '../provider-agent-runtime-route.js'

const fakeProvider = { id: 'fake' } as AgentProvider

describe('onething provider runtime route', () => {
  it('reserves only ACP — every other id is an ordinary agent provider', () => {
    expect(isOnethingACPProviderRuntime('acp')).toBe(true)
    expect(isOnethingACPProviderRuntime('openai')).toBe(false)
    // deepseek used to be reserved alongside acp. Its route existed only to
    // infer thinking from the model name, which deepseek.ts owns now.
    expect(isOnethingACPProviderRuntime('deepseek')).toBe(false)
  })

  it('builds a utility provider for everything except ACP', () => {
    const createAgentProvider = vi.fn(() => fakeProvider)

    expect(createOnethingUtilityAgentProvider('acp', { model: 'local' }, { createAgentProvider })).toBeUndefined()
    expect(createOnethingUtilityAgentProvider('deepseek', {
      apiKey: 'key',
      model: 'deepseek-chat',
    }, { createAgentProvider })).toBe(fakeProvider)
    expect(createOnethingUtilityAgentProvider('openai', {
      apiKey: 'key',
      baseUrl: 'https://api.test',
      model: 'gpt-test',
    }, { createAgentProvider })).toBe(fakeProvider)

    expect(createAgentProvider).toHaveBeenCalledTimes(2)
    expect(createAgentProvider).toHaveBeenLastCalledWith('openai', {
      apiKey: 'key',
      baseUrl: 'https://api.test',
      providerOptions: undefined,
      model: 'gpt-test',
      apiType: undefined,
      oauthToken: undefined,
      authContext: undefined,
      modelCapabilitiesByModel: undefined,
      models: undefined,
    })
  })

  it('forwards the provider-private options bag without opening it', () => {
    const createAgentProvider = vi.fn(() => fakeProvider)
    createOnethingUtilityAgentProvider('zhipu', {
      model: 'glm-5.2',
      providerOptions: { zhipuApiMode: 'coding-plan' },
    }, { createAgentProvider })

    expect(createAgentProvider).toHaveBeenCalledWith(
      'zhipu',
      expect.objectContaining({ providerOptions: { zhipuApiMode: 'coding-plan' } }),
    )
  })

  it('resolves route kinds', () => {
    const createAgentProvider = vi.fn((providerId: string) =>
      providerId === 'missing' ? undefined : fakeProvider)
    const adapters = { createAgentProvider }

    expect(resolveOnethingProviderRuntimeRoute('acp', { model: 'local' }, adapters)).toEqual({ kind: 'acp' })
    expect(resolveOnethingProviderRuntimeRoute('deepseek', { model: 'deepseek-chat' }, adapters)).toEqual({
      kind: 'agent',
      provider: fakeProvider,
    })
    expect(resolveOnethingProviderRuntimeRoute('openai', { model: 'gpt-test' }, adapters)).toEqual({
      kind: 'agent',
      provider: fakeProvider,
    })
    expect(resolveOnethingProviderRuntimeRoute('missing', { model: 'none' }, adapters)).toEqual({ kind: 'unsupported' })
  })
})
