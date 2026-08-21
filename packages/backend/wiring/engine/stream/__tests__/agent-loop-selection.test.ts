import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resolveAgentLoopStreamRoute,
  shouldUseAgentLoopStream,
} from '../agent-loop-selection.js'
import { builtinProviders } from '../../../providers/builtin/index.js'

describe('agent loop stream selection', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses the agent-loop route by default for supported providers', () => {
    const route = resolveAgentLoopStreamRoute({ providerId: 'deepseek' })

    expect(route.enabled).toBe(true)
    expect(route.enabledBy).toBe('default')
    expect(route.providerSupported).toBe(true)
    expect(route.active).toBe(true)
    expect(route.supportedProviderIds).toEqual(expect.arrayContaining(['deepseek', 'acp']))
    expect(shouldUseAgentLoopStream({ providerId: 'deepseek' })).toBe(true)
  })

  it('activates agent-loop by default for every built-in provider runtime', () => {
    const inactiveProviderIds = builtinProviders
      .map(provider => provider.id)
      .filter(providerId => !resolveAgentLoopStreamRoute({ providerId }).active)

    expect(inactiveProviderIds).toEqual([])
  })

  it('keeps supported providers active when explicitly enabled from settings', () => {
    const route = resolveAgentLoopStreamRoute({
      providerId: 'deepseek',
      settings: { chat: { agentLoopStream: true } },
    })

    expect(route.enabled).toBe(true)
    expect(route.enabledBy).toBe('settings')
    expect(route.providerSupported).toBe(true)
    expect(route.active).toBe(true)
    expect(shouldUseAgentLoopStream({
      providerId: 'deepseek',
      settings: { chat: { agentLoopStream: true } },
    })).toBe(true)
  })

  it('keeps supported providers active when legacy settings explicitly disable it', () => {
    const route = resolveAgentLoopStreamRoute({
      providerId: 'deepseek',
      settings: { chat: { agentLoopStream: false } },
    })

    expect(route.enabled).toBe(true)
    expect(route.enabledBy).toBe('default')
    expect(route.providerSupported).toBe(true)
    expect(route.active).toBe(true)
    expect(shouldUseAgentLoopStream({
      providerId: 'deepseek',
      settings: { chat: { agentLoopStream: false } },
    })).toBe(true)
  })

  it('allows the environment flag to activate supported providers', () => {
    vi.stubEnv('ONETHING_AGENT_LOOP_STREAM', '1')

    const route = resolveAgentLoopStreamRoute({
      providerId: 'acp',
      settings: { chat: { agentLoopStream: false } },
    })

    expect(route.enabled).toBe(true)
    expect(route.enabledBy).toBe('env')
    expect(route.providerSupported).toBe(true)
    expect(route.active).toBe(true)
  })

  it('does not activate unsupported providers even when enabled', () => {
    const route = resolveAgentLoopStreamRoute({
      providerId: 'unsupported-provider',
      settings: { chat: { agentLoopStream: true } },
    })

    expect(route.enabled).toBe(true)
    expect(route.enabledBy).toBe('settings')
    expect(route.providerSupported).toBe(false)
    expect(route.active).toBe(false)
    expect(shouldUseAgentLoopStream({
      providerId: 'unsupported-provider',
      settings: { chat: { agentLoopStream: true } },
    })).toBe(false)
  })
})
