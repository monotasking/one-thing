/**
 * Provider Registry
 *
 * Central registry for all AI providers. Manages registration,
 * lookup, and instantiation of providers.
 */

import { builtinProviders } from './builtin/index.js'
import { createProviderRegistry } from '@onething/runtime/providers'
import type { ProviderDefinition, ProviderInfo } from './types.js'

const registry = createProviderRegistry<ProviderDefinition>(builtinProviders)

/**
 * Invalidate provider cache for a specific provider or all providers
 */
export function invalidateProviderCache(providerId?: string): void {
  registry.invalidateProviderCache(providerId)
}

/**
 * Initialize the registry with built-in providers
 */
export function initializeRegistry(): void {
  registry.initialize()
}

/**
 * Register a provider definition
 */
export function registerProvider(definition: ProviderDefinition): void {
  registry.registerProvider(definition)
}

/**
 * Unregister a provider
 */
export function unregisterProvider(providerId: string): boolean {
  return registry.unregisterProvider(providerId)
}

/**
 * Get all registered provider info (for UI display)
 */
export function getAvailableProviders(): ProviderInfo[] {
  return registry.getAvailableProviders()
}

/**
 * Get provider info by ID
 */
export function getProviderInfo(providerId: string): ProviderInfo | undefined {
  return registry.getProviderInfo(providerId)
}

/**
 * Check if a provider is registered
 * Note: Custom providers (IDs starting with 'custom-') are dynamically supported
 */
export function isProviderSupported(providerId: string): boolean {
  return registry.isProviderSupported(providerId)
}

/**
 * Check if a provider requires system messages to be merged into user messages
 * Some APIs (like Zhipu) don't support system role when using tools
 */
export function requiresSystemMerge(providerId: string): boolean {
  return registry.requiresSystemMerge(providerId)
}

/**
 * Check if a provider requires OAuth
 */
export function requiresOAuth(providerId: string): boolean {
  return registry.requiresOAuth(providerId)
}

/**
 * Get the provider definition
 */
export function getProviderDefinition(providerId: string): ProviderDefinition | undefined {
  return registry.getProviderDefinition(providerId)
}

// Export types for convenience
export type { ProviderDefinition, ProviderInfo, ProviderConfig } from './types.js'
