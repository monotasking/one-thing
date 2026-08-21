import { describe, expect, it } from 'vitest'
import {
  resolveAgentLoopStreamRoute,
  shouldUseAgentLoopStream,
} from '@onething/core/engine'

describe('core agent-loop stream selection', () => {
  const TEST_AGENT_LOOP_STREAM_ENV = 'HEADLESS_AGENT_LOOP_STREAM'

  it('routes supported providers through the agent-loop stream by default', () => {
    const route = resolveAgentLoopStreamRoute({
      providerId: 'deepseek',
      supportedProviderIds: ['deepseek', 'acp'],
    })

    expect(route).toMatchObject({
      enabled: true,
      enabledBy: 'default',
      providerSupported: true,
      active: true,
      supportedProviderIds: ['deepseek', 'acp'],
    })
    expect(shouldUseAgentLoopStream({
      providerId: 'deepseek',
      supportedProviderIds: ['deepseek'],
    })).toBe(true)
  })

  it('records whether settings or env activated the route while preserving provider support as the final gate', () => {
    expect(resolveAgentLoopStreamRoute({
      providerId: 'deepseek',
      settings: { chat: { agentLoopStream: true } },
      supportedProviderIds: ['deepseek'],
    }).enabledBy).toBe('settings')

    expect(resolveAgentLoopStreamRoute({
      providerId: 'unsupported',
      env: { [TEST_AGENT_LOOP_STREAM_ENV]: '1' },
      envFlagName: TEST_AGENT_LOOP_STREAM_ENV,
      supportedProviderIds: ['deepseek'],
    })).toMatchObject({
      enabledBy: 'env',
      providerSupported: false,
      active: false,
    })
  })

  it('allows the host to inject custom support logic', () => {
    expect(resolveAgentLoopStreamRoute({
      providerId: 'custom-provider',
      supportedProviderIds: ['deepseek'],
      isProviderSupported: providerId => providerId.startsWith('custom-'),
    })).toMatchObject({
      providerSupported: true,
      active: true,
      supportedProviderIds: ['deepseek'],
    })
  })
})
