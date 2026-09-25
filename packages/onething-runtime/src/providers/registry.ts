import { isCustomProvider } from './manifest.js'

export interface OnethingProviderRegistryInfo {
  requiresOAuth?: boolean
}

export interface OnethingProviderRegistryDefinition<
  TInfo extends OnethingProviderRegistryInfo = OnethingProviderRegistryInfo,
> {
  id: string
  info: TInfo
  requiresSystemMerge?: boolean
}

export interface OnethingProviderRegistryLogger {
  log(message?: unknown, ...optionalParams: unknown[]): void
  warn(message?: unknown, ...optionalParams: unknown[]): void
}

export interface OnethingProviderRegistry<
  TDefinition extends OnethingProviderRegistryDefinition,
> {
  initialize(definitions?: readonly TDefinition[]): void
  invalidateProviderCache(providerId?: string): void
  registerProvider(definition: TDefinition): void
  unregisterProvider(providerId: string): boolean
  getAvailableProviders(): Array<TDefinition['info']>
  getProviderInfo(providerId: string): TDefinition['info'] | undefined
  isProviderSupported(providerId: string): boolean
  requiresSystemMerge(providerId: string): boolean
  requiresOAuth(providerId: string): boolean
  getProviderDefinition(providerId: string): TDefinition | undefined
}

export function createProviderRegistry<
  TDefinition extends OnethingProviderRegistryDefinition,
>(
  initialProviders: readonly TDefinition[] = [],
  logger: OnethingProviderRegistryLogger = console,
): OnethingProviderRegistry<TDefinition> {
  const providers = new Map<string, TDefinition>()

  function invalidateProviderCache(providerId?: string): void {
    if (providerId) {
      logger.log(`[Provider] Cache invalidated for: ${providerId}`)
    } else {
      logger.log('[Provider] All caches invalidated')
    }
  }

  function registerProvider(definition: TDefinition): void {
    if (providers.has(definition.id)) {
      logger.warn(`Provider ${definition.id} is already registered. Overwriting.`)
    }
    providers.set(definition.id, definition)
  }

  return {
    initialize(definitions = initialProviders): void {
      for (const provider of definitions) {
        registerProvider(provider)
      }
    },

    invalidateProviderCache,

    registerProvider,

    unregisterProvider(providerId: string): boolean {
      return providers.delete(providerId)
    },

    getAvailableProviders(): Array<TDefinition['info']> {
      return Array.from(providers.values()).map(provider => provider.info)
    },

    getProviderInfo(providerId: string): TDefinition['info'] | undefined {
      return providers.get(providerId)?.info
    },

    isProviderSupported(providerId: string): boolean {
      // 自定义服务商不进这张 info 表,它们在 manifest 注册表里自述 `origin: 'custom'`(批 M)。
      return providers.has(providerId) || isCustomProvider(providerId)
    },

    requiresSystemMerge(providerId: string): boolean {
      const definition = providers.get(providerId)
      return definition?.requiresSystemMerge === true
    },

    requiresOAuth(providerId: string): boolean {
      const definition = providers.get(providerId)
      return definition?.info.requiresOAuth === true
    },

    getProviderDefinition(providerId: string): TDefinition | undefined {
      return providers.get(providerId)
    },
  }
}
