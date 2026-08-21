import { describe, expect, it, vi } from 'vitest'

const { testFetch } = vi.hoisted(() => ({
  testFetch: async () => new Response(''),
}))

vi.mock('../bound-fetch.js', () => ({
  createRequiredAppFetch: () => testFetch,
}))

import { builtinProviders } from '../builtin/index.js'
import { resolveProviderRuntimeRoute } from '../agent-runtime.js'

describe('provider agent runtime route', () => {
  it('routes every built-in provider through a native AgentProvider runtime', () => {
    const unsupportedRoutes = builtinProviders
      .map(provider => {
        const route = resolveProviderRuntimeRoute(provider.id, {
          apiKey: 'test-token',
          baseUrl: provider.info.defaultBaseUrl,
          model: provider.info.defaultModel,
        })
        return route.kind === 'unsupported' ? provider.id : undefined
      })
      .filter((providerId): providerId is string => Boolean(providerId))

    expect(unsupportedRoutes).toEqual([])
  })
})
