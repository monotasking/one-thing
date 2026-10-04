import { describe, expect, it, vi } from 'vitest'
import {
  createProviderRegistry,
  type OnethingProviderRegistryDefinition,
  type OnethingProviderRegistryInfo,
} from '../provider-registry.js'
import { registerCustomProvidersForTest } from './custom-manifest-fixture.js'
// 批 M:自定义服务商按 manifest 注册表认(不再看 id 前缀),单测不装配,这里直接登记。
registerCustomProvidersForTest(["custom-local"])


interface TestProviderInfo extends OnethingProviderRegistryInfo {
  id: string
  name: string
}

type TestProviderDefinition = OnethingProviderRegistryDefinition<TestProviderInfo> & {
  extra?: string
}

function provider(
  id: string,
  overrides: Partial<TestProviderDefinition> = {},
): TestProviderDefinition {
  return {
    id,
    info: {
      id,
      name: id,
      requiresOAuth: false,
    },
    ...overrides,
  }
}

describe('onething provider registry', () => {
  it('registers and looks up provider metadata', () => {
    const registry = createProviderRegistry<TestProviderDefinition>([
      provider('deepseek'),
      provider('codex', {
        info: { id: 'codex', name: 'Codex', requiresOAuth: true },
        requiresSystemMerge: true,
      }),
    ])

    registry.initialize()

    expect(registry.getAvailableProviders()).toEqual([
      { id: 'deepseek', name: 'deepseek', requiresOAuth: false },
      { id: 'codex', name: 'Codex', requiresOAuth: true },
    ])
    expect(registry.getProviderInfo('codex')).toMatchObject({ name: 'Codex' })
    expect(registry.getProviderDefinition('codex')?.requiresSystemMerge).toBe(true)
    expect(registry.requiresOAuth('codex')).toBe(true)
    expect(registry.requiresSystemMerge('codex')).toBe(true)
  })

  it('supports runtime registration, unregistration, and custom providers', () => {
    const registry = createProviderRegistry<TestProviderDefinition>()

    registry.registerProvider(provider('openai'))

    expect(registry.isProviderSupported('openai')).toBe(true)
    expect(registry.isProviderSupported('custom-local')).toBe(true)
    expect(registry.unregisterProvider('openai')).toBe(true)
    expect(registry.isProviderSupported('openai')).toBe(false)
  })

  it('logs cache invalidation and duplicate registration through the supplied logger', () => {
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
    }
    const registry = createProviderRegistry<TestProviderDefinition>([], logger)

    registry.registerProvider(provider('deepseek'))
    registry.registerProvider(provider('deepseek'))
    registry.invalidateProviderCache('deepseek')
    registry.invalidateProviderCache()

    expect(logger.warn).toHaveBeenCalledWith('Provider deepseek is already registered. Overwriting.')
    expect(logger.log).toHaveBeenCalledWith('[Provider] Cache invalidated for: deepseek')
    expect(logger.log).toHaveBeenCalledWith('[Provider] All caches invalidated')
  })
})
