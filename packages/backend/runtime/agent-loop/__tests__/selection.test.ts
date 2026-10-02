import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ONETHING_AGENT_LOOP_STREAM_ENV,
  resolveOnethingAgentLoopStreamRoute,
  shouldUseOnethingAgentLoopStream,
} from '../selection.js'
import { getSupportedAgentProviderRuntimeIds } from '../providers/index.js'

describe('onething agent-loop stream selection', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('owns the onething default provider support and env flag', () => {
    const route = resolveOnethingAgentLoopStreamRoute({ providerId: 'deepseek' })

    expect(route.enabled).toBe(true)
    expect(route.enabledBy).toBe('default')
    expect(route.providerSupported).toBe(true)
    expect(route.active).toBe(true)
    expect(route.supportedProviderIds).toEqual(expect.arrayContaining(['deepseek', 'acp']))
    expect(shouldUseOnethingAgentLoopStream({ providerId: 'deepseek' })).toBe(true)
  })

  it('keeps every registered agent provider runtime active by default', () => {
    const inactiveProviderIds = getSupportedAgentProviderRuntimeIds()
      .filter(providerId => !resolveOnethingAgentLoopStreamRoute({ providerId }).active)

    expect(inactiveProviderIds).toEqual([])
  })

  it('tracks settings and env activation while provider support remains the final gate', () => {
    expect(resolveOnethingAgentLoopStreamRoute({
      providerId: 'deepseek',
      settings: { chat: { agentLoopStream: true } },
    })).toMatchObject({
      enabledBy: 'settings',
      providerSupported: true,
      active: true,
    })

    vi.stubEnv(ONETHING_AGENT_LOOP_STREAM_ENV, '1')
    expect(resolveOnethingAgentLoopStreamRoute({
      providerId: 'unsupported-provider',
      settings: { chat: { agentLoopStream: false } },
    })).toMatchObject({
      enabledBy: 'env',
      providerSupported: false,
      active: false,
    })
  })
})
