import { afterEach, describe, expect, it } from 'vitest'
import { BUILTIN_PROVIDER_MANIFESTS, getBuiltinProviderManifest } from '../builtin-manifests.js'
import {
  getProviderManifest,
  getProviderManifestRegistry,
  isCustomProvider,
  isSubscriptionProvider,
  manifestOfCustomProvider,
  registerProviderManifest,
  resetProviderManifestRegistryForTests,
} from '../manifest.js'
import { ONETHING_CODEX_BASE_URL, ONETHING_CODEX_DEFAULT_MODEL, ONETHING_CODEX_PROVIDER_ID } from '../codex.js'
import { getAuthProviderDefinition } from '../../auth/registry.js'
import { getDialect } from '../../agent-loop/providers/base/index.js'
import '../../agent-loop/providers/dialects/index.js'
import { getOnethingModelsDevProviderId } from '../models-dev-catalog.js'

afterEach(() => resetProviderManifestRegistryForTests())

describe('builtin provider manifests', () => {
  it('declares the sixteen builtins, once each, in the historical order', () => {
    expect(BUILTIN_PROVIDER_MANIFESTS.map((manifest) => manifest.id)).toEqual([
      'openai', 'claude', 'deepseek', 'kimi', 'zhipu', 'qwen', 'openrouter', 'gemini',
      'claude-code', 'grok', 'grok-oauth', 'kimi-code', 'github-copilot', 'codex',
      'acp', 'claude-code-agent',
    ])
    expect(BUILTIN_PROVIDER_MANIFESTS.every((manifest) => manifest.origin === 'builtin')).toBe(true)
  })

  it('keeps the Codex literals equal to codex.ts (the manifest cannot import it: process.env)', () => {
    const codex = getBuiltinProviderManifest(ONETHING_CODEX_PROVIDER_ID)!
    expect(codex.defaultBaseUrl).toBe(ONETHING_CODEX_BASE_URL)
    expect(codex.defaultModel).toBe(ONETHING_CODEX_DEFAULT_MODEL)
  })

  it('names a registered dialect for every wire-speaking builtin', () => {
    for (const manifest of BUILTIN_PROVIDER_MANIFESTS) {
      if (manifest.dialect === 'external-agent') continue
      expect(getDialect(manifest.dialect), manifest.id).toBeDefined()
    }
  })

  it('agrees with the auth registry on every OAuth flow kind', () => {
    for (const manifest of BUILTIN_PROVIDER_MANIFESTS) {
      const definition = getAuthProviderDefinition(manifest.id)
      if (manifest.auth.kind === 'oauth') {
        expect(definition?.flowKind, manifest.id).toBe(manifest.auth.flow)
      } else {
        expect(definition, manifest.id).toBeUndefined()
      }
    }
  })

  it('pairs siblings both ways, subscription side carries the family tag', () => {
    for (const manifest of BUILTIN_PROVIDER_MANIFESTS) {
      if (!manifest.sibling) continue
      const sibling = getBuiltinProviderManifest(manifest.sibling)
      expect(sibling?.sibling, manifest.id).toBe(manifest.id)
      expect(new Set([manifest.billing, sibling?.billing])).toEqual(new Set(['api', 'subscription']))
      if (manifest.billing === 'subscription') expect(manifest.familyTag, manifest.id).toBeTruthy()
    }
  })

  it('bills the subscription providers as subscription (the old SUBSCRIPTION_PROVIDER_IDS + grok-oauth)', () => {
    const subscription = BUILTIN_PROVIDER_MANIFESTS.filter((m) => m.billing === 'subscription').map((m) => m.id)
    expect(subscription.sort()).toEqual(['claude-code', 'codex', 'github-copilot', 'grok-oauth', 'kimi-code'])
    expect(isSubscriptionProvider('codex')).toBe(true)
    expect(isSubscriptionProvider('openai')).toBe(false)
    expect(isSubscriptionProvider('never-registered')).toBe(false)
  })

  it('carries dials for exactly the three plan-switching providers', () => {
    expect(BUILTIN_PROVIDER_MANIFESTS.filter((m) => m.dials).map((m) => m.id).sort()).toEqual(['kimi', 'qwen', 'zhipu'])
  })

  it('answers the same models.dev catalog keys as before the manifest', () => {
    expect(getOnethingModelsDevProviderId('claude')).toBe('anthropic')
    expect(getOnethingModelsDevProviderId('gemini')).toBe('google')
    expect(getOnethingModelsDevProviderId('zhipu')).toBe('zhipuai')
    expect(getOnethingModelsDevProviderId('grok')).toBe('xai')
    expect(getOnethingModelsDevProviderId('grok-oauth')).toBe('xai')
    expect(getOnethingModelsDevProviderId('claude-code-agent')).toBe('anthropic')
    expect(getOnethingModelsDevProviderId('kimi-code')).toBe('kimi-for-coding')
    expect(getOnethingModelsDevProviderId('github-copilot')).toBe('github-copilot')
    expect(getOnethingModelsDevProviderId('qwen')).toBe('alibaba-cn')
    expect(getOnethingModelsDevProviderId('qwen', { qwenRegion: 'intl' })).not.toBe('alibaba-cn')
    expect(getOnethingModelsDevProviderId('custom-relay')).toBe('custom-relay')
  })
})

describe('provider manifest registry', () => {
  it('registers, answers and unregisters a custom provider', () => {
    const manifest = manifestOfCustomProvider({ id: 'custom-1', name: 'Relay', apiType: 'anthropic', baseUrl: 'https://r/v1' })
    expect(manifest).toMatchObject({
      origin: 'custom',
      dialect: 'custom-anthropic',
      auth: { kind: 'apiKey' },
      models: { kind: 'endpoint' },
      billing: 'api',
      modelRules: 'claude',
      defaultBaseUrl: 'https://r/v1',
    })
    expect(isCustomProvider('custom-1')).toBe(false)
    const unregister = registerProviderManifest(manifest)
    expect(isCustomProvider('custom-1')).toBe(true)
    expect(() => registerProviderManifest(manifest)).toThrow(/already registered/)
    unregister()
    expect(getProviderManifest('custom-1')).toBeUndefined()
  })

  it('maps a named dialect and borrows that builtin family\'s model rules', () => {
    expect(manifestOfCustomProvider({ id: 'custom-2', apiType: 'openai', dialect: 'openrouter' })).toMatchObject({
      dialect: 'openrouter',
      modelRules: 'openrouter',
    })
    expect(manifestOfCustomProvider({ id: 'custom-3' })).toMatchObject({ dialect: 'custom-openai', modelRules: 'openai' })
  })

  it('an old unregister cannot remove a newer registration of the same id', () => {
    const first = registerProviderManifest(manifestOfCustomProvider({ id: 'custom-4' }))
    first()
    const second = manifestOfCustomProvider({ id: 'custom-4', name: 'second' })
    registerProviderManifest(second)
    first()
    expect(getProviderManifest('custom-4')).toBe(second)
  })

  it('resetForTests restores exactly the builtins', () => {
    registerProviderManifest(manifestOfCustomProvider({ id: 'custom-5' }))
    resetProviderManifestRegistryForTests()
    expect(getProviderManifestRegistry().list().map((m) => m.id)).toEqual(BUILTIN_PROVIDER_MANIFESTS.map((m) => m.id))
  })
})
