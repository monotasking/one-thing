import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '@shared/defaults/settings.js'

// Retain real settings composition and credential storage; unrelated session
// stores and usage lifecycle are covered by the Backend lifecycle regression.
vi.mock('../../../store.js', async () => {
  const settings = await import('../../../stores/settings.js')
  return { getSettings: settings.getSettings }
})
vi.mock('../../usage/index.js', () => ({ captureUsageRecorder: () => vi.fn() }))
vi.mock('../../auth/auth-service.js', () => ({ authService: {} }))
vi.mock('@onething/runtime/spaces/store', () => ({
  getSpacesStore: () => ({ list: () => [{ id: 'default', name: 'Default' }] }),
}))

import {
  configureSpaceCredentialsCrypto,
  getSpaceProviderCredentials,
  markSpaceCredentialCooldown,
  resetSpaceCredentialsCacheForTests,
  setSpaceProviderCredentialPool,
  spaceCredentialsFilePath,
  upsertSpaceProviderOAuthToken,
} from '@onething/runtime/spaces/credentials'
import { setRootDirForTests } from '@onething/runtime/spaces/persistence'
import {
  resetSpaceProviderSettingsCacheForTests,
  spaceProviderSettingsPath,
  writeSpaceProviderSettings,
} from '@onething/runtime/spaces/provider-settings'
import { getProviderApiKeyEnvCandidates } from '@onething/runtime/providers/env.wiring'
import {
  getSettings,
  invalidateSettingsCache,
  savePersistedSettings,
  updateSettingsInMemory,
} from '../../../stores/settings.js'
import { setSpaceProviderCredential } from '../../providers/space-credentials.js'
import { initializeRegistry } from '../../providers/registry.js'
import { createEvalsModelCaller, resolveEvalsCredentials } from '../provider-adapter.js'

let directory: string

beforeAll(() => initializeRegistry())

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-provider-credentials-'))
  vi.stubEnv('ONETHING_STORE_PATH', directory)
  for (const provider of ['openai', 'deepseek', 'codex', 'custom-fixture']) {
    for (const name of getProviderApiKeyEnvCandidates(provider)) vi.stubEnv(name, '')
  }
  setRootDirForTests(path.join(directory, 'workspaces'))
  invalidateSettingsCache()
  resetSpaceCredentialsCacheForTests()
  resetSpaceProviderSettingsCacheForTests()
  configureSpaceCredentialsCrypto(() => ({
    isEncryptionAvailable: () => true,
    encryptString: text => Buffer.from(text, 'utf8'),
    decryptString: data => data.toString('utf8'),
  }))
  savePersistedSettings({
    ...createDefaultSettings(),
    storage: { providerConfigMigratedAt: 1, spaceProviderSettingsMigratedAt: 1 },
  })
  writeSpaceProviderSettings('default', {
    provider: 'openai',
    providers: { openai: { model: 'fixture-model', selectedModels: ['fixture-model'] } },
    customProviders: [],
  })
})

afterEach(() => {
  configureSpaceCredentialsCrypto(undefined)
  setRootDirForTests(null)
  invalidateSettingsCache()
  resetSpaceCredentialsCacheForTests()
  resetSpaceProviderSettingsCacheForTests()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
})

function saveKey(providerId: string, apiKey: string, baseUrl?: string, spaceId = 'default') {
  setSpaceProviderCredential({ id: spaceId, providerId, apiKey, baseUrl })
}

describe('eval credentials use the normal space credential store', () => {
  it('resolves a formally saved encrypted key and its endpoint after reloading the pool', () => {
    saveKey('openai', 'fixture-space-key', 'https://fixture.invalid/v1')
    resetSpaceCredentialsCacheForTests()

    expect(resolveEvalsCredentials('openai')).toEqual({
      ok: true, apiKey: 'fixture-space-key', baseUrl: 'https://fixture.invalid/v1',
    })
    expect(getSettings().ai.providers.openai.apiKey).toBeUndefined()
    expect(fs.readFileSync(spaceProviderSettingsPath('default'), 'utf8')).not.toContain('fixture-space-key')
    expect(fs.readFileSync(spaceCredentialsFilePath('default'), 'utf8')).not.toContain('fixture-space-key')
  })

  it('does not read a legacy in-memory key or borrow another space credential', () => {
    saveKey('openai', 'other-space-key', 'https://other.invalid/v1', 'work')
    const initial = getSettings()
    updateSettingsInMemory({ ...initial, ai: { ...initial.ai, providers: {
      ...initial.ai.providers,
      openai: { apiKey: 'legacy-key', model: 'fixture-model', selectedModels: [] },
    } } })

    expect(resolveEvalsCredentials('openai')).toEqual({
      ok: false, reason: 'No API key configured for provider "openai"',
    })
  })

  it('uses the environment only when the pool has no usable key, with the provider default URL', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-env-key')
    expect(resolveEvalsCredentials('deepseek')).toMatchObject({
      ok: true, apiKey: 'fixture-env-key', baseUrl: 'https://api.deepseek.com',
    })
    saveKey('deepseek', 'fixture-pool-key', 'https://pool.invalid/v1')
    expect(resolveEvalsCredentials('deepseek')).toMatchObject({
      ok: true, apiKey: 'fixture-pool-key', baseUrl: 'https://pool.invalid/v1',
    })
  })

  it('keeps the configured endpoint when the chosen key has no endpoint override', () => {
    writeSpaceProviderSettings('default', {
      provider: 'custom-fixture',
      providers: { 'custom-fixture': { model: 'fixture-model', selectedModels: [], baseUrl: 'https://custom.invalid/v1' } },
      customProviders: [],
    })
    saveKey('custom-fixture', 'fixture-custom-key')
    expect(resolveEvalsCredentials('custom-fixture')).toMatchObject({
      ok: true, apiKey: 'fixture-custom-key', baseUrl: 'https://custom.invalid/v1',
    })
  })

  it('uses the normal pool selection and keeps exhausted pools from falling back to an environment key', () => {
    vi.stubEnv('OPENAI_API_KEY', 'fixture-env-key')
    saveKey('openai', 'first-key', 'https://first.invalid/v1')
    saveKey('openai', 'second-key', 'https://second.invalid/v1')
    const entries = getSpaceProviderCredentials('default', 'openai')!.entries
    setSpaceProviderCredentialPool('default', 'openai', { entryIds: entries.map(entry => entry.id), policy: 'priority-failover' })
    markSpaceCredentialCooldown('default', 'openai', entries[0].id, Date.now() + 600_000)
    expect(resolveEvalsCredentials('openai')).toMatchObject({
      ok: true, apiKey: 'second-key', baseUrl: 'https://second.invalid/v1',
    })
    markSpaceCredentialCooldown('default', 'openai', entries[1].id, Date.now() + 600_000)
    expect(resolveEvalsCredentials('openai')).toMatchObject({ ok: false, reason: expect.stringContaining('冷却') })
  })

  it('reports OAuth as unsupported both before login and with a stored token', () => {
    expect(resolveEvalsCredentials('codex')).toMatchObject({ ok: false, reason: expect.stringContaining('uses OAuth') })
    upsertSpaceProviderOAuthToken('default', 'codex', {
      token: { accessToken: 'fixture-token', tokenType: 'Bearer', expiresAt: Date.now() + 600_000 },
    })
    expect(resolveEvalsCredentials('codex')).toMatchObject({ ok: false, reason: expect.stringContaining('uses OAuth') })
  })

  it('routes a replay to the origin provider using its saved key, URL and model', async () => {
    saveKey('openai', 'fallback-key', 'https://fallback.invalid/v1')
    saveKey('deepseek', 'origin-key', 'https://origin.invalid/v1')
    const fetcher = vi.fn(async () => Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }))
    vi.stubGlobal('fetch', fetcher)
    const caller = createEvalsModelCaller('openai', 'fallback-model')
    await caller({ provider: 'deepseek', model: 'origin-model', messages: [{ role: 'user', content: 'fixture' }] })
    expect(fetcher).toHaveBeenCalledWith('https://origin.invalid/v1/chat/completions', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer origin-key' }),
      body: expect.stringContaining('"model":"origin-model"'),
    }))
  })

  it('keeps the binding provider and model when the origin has no usable credential', async () => {
    saveKey('openai', 'fallback-key', 'https://fallback.invalid/v1')
    const fetcher = vi.fn(async () => Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }))
    vi.stubGlobal('fetch', fetcher)
    const caller = createEvalsModelCaller('openai', 'fallback-model')
    await caller({ provider: 'deepseek', model: 'origin-model', messages: [{ role: 'user', content: 'fixture' }] })
    expect(fetcher).toHaveBeenCalledWith('https://fallback.invalid/v1/chat/completions', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer fallback-key' }),
      body: expect.stringContaining('"model":"fallback-model"'),
    }))
  })
})
