/**
 * 发送路查 `enabled`(设计正本 provider-settings-rework §2.3)。
 *
 * 停用的 provider 按「未配置」**同一条失败路**走:抹钥匙 + `unavailable` 标记 →
 * 鉴权点必败 → 引擎经 `describeMissingCredentials` 报「{name} 已停用」。
 * 开没开的判据是 `@shared/provider-families` 的 `isProviderEnabledIn`
 * (与设置页 / 模型选择器同一份,含家族派生),读的是会话所在空间的 providers。
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  providersBySpace: {} as Record<string, Record<string, { enabled?: boolean }>>,
  sessions: new Map<string, { workspaceId?: string }>(),
  oauthProviders: new Set<string>(),
  credentialFreeProviders: new Set<string>(),
}))

vi.mock('../../../stores/settings.js', () => ({
  getSettings: () => ({}),
  getSpaceSettings: () => ({}),
}))

vi.mock('../space-ai-settings.js', async () => {
  const { DEFAULT_SPACE_ID } = await import('@onething/runtime/spaces/types')
  return {
    getSessionSettings: (id: string | undefined | null) => {
      const spaceId = (id && mocks.sessions.get(id)?.workspaceId) || DEFAULT_SPACE_ID
      return { ai: { providers: mocks.providersBySpace[spaceId] ?? {} } }
    },
  }
})

vi.mock('@onething/runtime/providers/env.wiring', () => ({
  getProviderEnvStatus: () => ({ detectedEnvVar: undefined }),
}))

vi.mock('../../../stores/sessions.js', async () => {
  const { DEFAULT_SPACE_ID, isValidSpaceId } = await import('@onething/runtime/spaces/types')
  return {
    resolveSessionSpaceId: (id: string | undefined | null) => {
      const workspaceId = id ? mocks.sessions.get(id)?.workspaceId : undefined
      return workspaceId && isValidSpaceId(workspaceId) ? workspaceId : DEFAULT_SPACE_ID
    },
  }
})

vi.mock('../registry.js', () => ({
  requiresOAuth: (id: string) => mocks.oauthProviders.has(id),
  getProviderInfo: (id: string) => ({
    id,
    name: id.toUpperCase(),
    ...(mocks.credentialFreeProviders.has(id) ? { requiresApiKey: false } : {}),
  }),
}))

vi.mock('@onething/runtime/spaces/store', () => ({
  getSpacesStore: () => ({ list: () => [{ id: 'default', name: '默认空间', createdAt: 0 }] }),
}))

vi.mock('../../auth/auth-service.js', () => ({
  authService: { resolveProviderAuth: async () => null },
}))

import {
  resetSpaceCredentialsCacheForTests,
  upsertSpaceProviderApiKey,
} from '@onething/runtime/spaces/credentials'
import { setRootDirForTests } from '@onething/runtime/spaces/persistence'
import { createOnethingStreamProviderAdapter } from '@onething/runtime/providers/stream-provider-adapter'
import { applySessionProviderGates } from '../space-credentials.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-provider-gate-'))
  setRootDirForTests(tmpDir)
  resetSpaceCredentialsCacheForTests()
  mocks.providersBySpace = {}
  mocks.sessions = new Map([['s1', {}]])
  mocks.oauthProviders = new Set(['codex', 'claude-code'])
  mocks.credentialFreeProviders = new Set()
})

afterEach(() => {
  setRootDirForTests(null)
  resetSpaceCredentialsCacheForTests()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function marker(config: unknown): { unavailable?: { reason: string; message: string } } | undefined {
  return (config as { spaceCredential?: { unavailable?: { reason: string; message: string } } })
    .spaceCredential
}

describe('applySessionProviderGates', () => {
  it('停用 = 抹钥匙 + unavailable 标记,话是「{name} 已停用」', () => {
    upsertSpaceProviderApiKey('default', 'deepseek', { apiKey: 'sk-pool' })
    mocks.providersBySpace.default = { deepseek: { enabled: false } }

    const next = applySessionProviderGates('s1', 'deepseek', {
      model: 'm',
      apiKey: 'sk-global',
    }) as Record<string, unknown>

    expect(next.apiKey).toBeUndefined()
    expect(marker(next)?.unavailable).toEqual({ reason: 'disabled', message: 'DEEPSEEK 已停用' })
  })

  it('开着(含「没设过 = 开着」)就照常走凭证池', () => {
    upsertSpaceProviderApiKey('default', 'deepseek', { apiKey: 'sk-pool' })
    mocks.providersBySpace.default = { deepseek: {} }

    const next = applySessionProviderGates('s1', 'deepseek', { model: 'm' }) as Record<string, unknown>
    expect(next.apiKey).toBe('sk-pool')
    expect(marker(next)?.unavailable).toBeUndefined()
  })

  it('家族读法:API 成员关着、订阅成员自己开着 = 订阅成员可用(遗留覆盖)', () => {
    mocks.providersBySpace.default = {
      openai: { enabled: false },
      codex: { enabled: true },
    }
    const codex = applySessionProviderGates('s1', 'codex', { model: 'gpt' })
    expect(marker(codex)?.unavailable?.reason).not.toBe('disabled')

    const openai = applySessionProviderGates('s1', 'openai', { model: 'gpt' })
    expect(marker(openai)?.unavailable?.reason).toBe('disabled')
  })

  it('家族读法:家族开关(API 成员)关着、订阅成员自己也关着 = 停用', () => {
    mocks.providersBySpace.default = { claude: { enabled: false }, 'claude-code': { enabled: false } }
    const next = applySessionProviderGates('s1', 'claude-code', { model: 'x' })
    expect(marker(next)?.unavailable).toEqual({ reason: 'disabled', message: 'CLAUDE-CODE 已停用' })
  })

  it('读的是会话所在空间那一份 providers', () => {
    mocks.sessions.set('s-work', { workspaceId: 'work' })
    upsertSpaceProviderApiKey('work', 'deepseek', { apiKey: 'sk-work' })
    mocks.providersBySpace.default = { deepseek: { enabled: false } }
    mocks.providersBySpace.work = { deepseek: { enabled: true } }

    const next = applySessionProviderGates('s-work', 'deepseek', { model: 'm' }) as Record<string, unknown>
    expect(next.apiKey).toBe('sk-work')
  })

  it('从不问凭证的那几只(ACP / 本地 agent)不过这道闸 —— 它们没有开关可拨', () => {
    mocks.credentialFreeProviders.add('claude-code-agent')
    mocks.providersBySpace.default = { acp: { enabled: false }, 'claude-code-agent': { enabled: false } }
    expect(marker(applySessionProviderGates('s1', 'acp', { model: 'a' }))).toBeUndefined()
    expect(marker(applySessionProviderGates('s1', 'claude-code-agent', { model: 'c' }))).toBeUndefined()
  })
})

describe('发送路:停用与「未配置」同一条失败路', () => {
  function adapter() {
    return createOnethingStreamProviderAdapter({
      getSession: () => ({ lastProvider: 'deepseek', lastModel: 'deepseek-chat' }),
      applySpaceCredentials: applySessionProviderGates,
      isProviderSupported: () => true,
      isOAuthProvider: id => mocks.oauthProviders.has(id),
      resolveApiKey: (_id, config) => (config as { apiKey?: string } | undefined)?.apiKey ?? null,
      resolveOAuthAuth: async () => null,
      createApiKeyAuth: apiKey => ({ kind: 'api-key', apiKey }),
      generateTitle: async () => '',
    })
  }

  it('停用的 provider:鉴权解不出来,引擎拿到的原因是「{name} 已停用」', async () => {
    upsertSpaceProviderApiKey('default', 'deepseek', { apiKey: 'sk-pool' })
    mocks.providersBySpace.default = { deepseek: { enabled: false } }
    const settings = { ai: { provider: 'deepseek', providers: { deepseek: { model: 'deepseek-chat' } } } }

    const provider = adapter()
    const { providerId, providerConfig } = provider.getEffectiveConfig(settings, 's1', null)
    expect(providerId).toBe('deepseek')
    expect(await provider.resolveAuth(providerId, providerConfig)).toBeNull()
    expect(provider.describeMissingCredentials?.(providerId, providerConfig, 's1')).toBe('DEEPSEEK 已停用')
  })

  it('开着的 provider:鉴权照常拿到池里那把钥匙', async () => {
    upsertSpaceProviderApiKey('default', 'deepseek', { apiKey: 'sk-pool' })
    mocks.providersBySpace.default = { deepseek: { enabled: true } }
    const settings = { ai: { provider: 'deepseek', providers: { deepseek: { model: 'deepseek-chat' } } } }

    const provider = adapter()
    const { providerId, providerConfig } = provider.getEffectiveConfig(settings, 's1', null)
    expect(await provider.resolveAuth(providerId, providerConfig)).toEqual({ kind: 'api-key', apiKey: 'sk-pool' })
  })
})
