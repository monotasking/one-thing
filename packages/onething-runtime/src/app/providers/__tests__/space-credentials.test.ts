import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  sessions: new Map<string, { workspaceId?: string }>(),
  oauthProviders: new Set<string>(),
  spaces: [] as Array<{ id: string; name: string; createdAt: number }>,
}))

vi.mock('../../stores/settings.js', () => ({
  getSettings: () => mocks.settings,
}))

vi.mock('../../stores/sessions.js', async () => {
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
  getProviderInfo: (id: string) => ({ id, name: id.toUpperCase() }),
}))

vi.mock('@onething/runtime/spaces/store', () => ({
  getSpacesStore: () => ({ list: () => mocks.spaces }),
}))

import {
  resetSpaceCredentialsCacheForTests,
  upsertSpaceProviderApiKey,
} from '@onething/runtime/spaces/credentials'
import { setRootDirForTests } from '@onething/runtime/spaces/persistence'
import {
  applySessionSpaceCredentials,
  getSpaceCredentialsSummary,
  importDefaultSpaceCredentials,
  resolveSessionCredentialId,
} from '../space-credentials.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-app-space-creds-'))
  setRootDirForTests(tmpDir)
  resetSpaceCredentialsCacheForTests()
  mocks.settings = {}
  mocks.sessions = new Map()
  mocks.oauthProviders = new Set(['codex'])
  mocks.spaces = [
    { id: 'default', name: '默认空间', createdAt: 0 },
    { id: 'work', name: '工作', createdAt: 1 },
  ]
})

afterEach(() => {
  setRootDirForTests(null)
  resetSpaceCredentialsCacheForTests()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('按「会话归属的 space」解析,不是「当前 space」', () => {
  it('default 空间的会话:配置原样透传', () => {
    mocks.sessions.set('s-default', {})
    const config = { model: 'm', apiKey: 'sk-global' }
    expect(applySessionSpaceCredentials('s-default', 'deepseek', config)).toBe(config)
    expect(resolveSessionCredentialId('s-default', 'deepseek')).toBeUndefined()
  })

  it('非 default 空间的会话:用本空间的 entry 覆盖,并写得出 credentialId', () => {
    mocks.sessions.set('s-work', { workspaceId: 'work' })
    upsertSpaceProviderApiKey('work', 'deepseek', { apiKey: 'sk-work' })

    const next = applySessionSpaceCredentials('s-work', 'deepseek', {
      model: 'm',
      apiKey: 'sk-global',
    }) as Record<string, unknown>
    expect(next.apiKey).toBe('sk-work')

    const credentialId = resolveSessionCredentialId('s-work', 'deepseek')
    expect(credentialId).toBeTruthy()
    expect((next.spaceCredential as { entryId?: string }).entryId).toBe(credentialId)
  })

  it('非 default 空间没配这个 provider:钥匙被抹掉,错误文案带上空间名', () => {
    mocks.sessions.set('s-work', { workspaceId: 'work' })
    const next = applySessionSpaceCredentials('s-work', 'deepseek', {
      model: 'm',
      apiKey: 'sk-global',
    }) as Record<string, unknown>
    expect(next.apiKey).toBeUndefined()
    const marker = next.spaceCredential as { unavailable?: { message: string; reason: string } }
    expect(marker.unavailable?.reason).toBe('no-entry')
    expect(marker.unavailable?.message).toContain('工作')
    expect(resolveSessionCredentialId('s-work', 'deepseek')).toBeUndefined()
  })

  it('OAuth 型 provider 在非 default 空间一律拒绝', () => {
    mocks.sessions.set('s-work', { workspaceId: 'work' })
    const next = applySessionSpaceCredentials('s-work', 'codex', { model: 'm' }) as Record<string, unknown>
    const marker = next.spaceCredential as { unavailable?: { reason: string; message: string } }
    expect(marker.unavailable?.reason).toBe('oauth')
    expect(marker.unavailable?.message).toContain('默认空间')
  })

  it('拿不到 sessionId 时按 default 处理(诚实降级,不去猜"用户现在在看哪个空间")', () => {
    const config = { model: 'm', apiKey: 'sk-global' }
    expect(applySessionSpaceCredentials('', 'deepseek', config)).toBe(config)
  })
})

describe('摘要投影', () => {
  it('只给 hasApiKey + 预览,密钥原文永不出后端', () => {
    upsertSpaceProviderApiKey('work', 'deepseek', { apiKey: 'sk-abcdef0123456789' })
    const summary = getSpaceCredentialsSummary('work')
    const entry = summary.providers.deepseek.entries[0]
    expect(entry.hasApiKey).toBe(true)
    expect(entry.apiKeyPreview).toBe('sk-abc••••6789')
    expect(JSON.stringify(summary)).not.toContain('sk-abcdef0123456789')
  })
})

describe('从默认空间导入凭证(新建向导)', () => {
  beforeEach(() => {
    mocks.settings = {
      ai: {
        provider: 'deepseek',
        providers: {
          deepseek: { apiKey: 'sk-d', model: 'deepseek-chat' },
          openai: { apiKey: 'sk-o', baseUrl: 'https://proxy/v1' },
          codex: { apiKey: 'should-not-matter' },
          gemini: { model: 'g' },
        },
      },
    }
  })

  it('复制快照:导入后改全局不影响这个空间', () => {
    const result = importDefaultSpaceCredentials('work')
    expect(result.imported.sort()).toEqual(['deepseek', 'openai'])

    const providers = (mocks.settings.ai as { providers: Record<string, { apiKey?: string }> }).providers
    providers.deepseek.apiKey = 'sk-changed'
    resetSpaceCredentialsCacheForTests()
    expect(getSpaceCredentialsSummary('work').providers.deepseek.entries[0].apiKeyPreview)
      .toBe('sk-d••••')
  })

  it('OAuth 型跳过并如实报出;没配 key 的不吵用户', () => {
    const result = importDefaultSpaceCredentials('work')
    expect(result.skipped).toEqual([{ providerId: 'codex', reason: 'oauth' }])
    expect(result.credentials.providers.codex).toBeUndefined()
    expect(result.credentials.providers.gemini).toBeUndefined()
  })

  it('不吃环境变量兜底 —— 只快照 settings 里写着的原文', () => {
    const previous = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = 'sk-from-env'
    try {
      mocks.settings = { ai: { provider: 'deepseek', providers: { deepseek: { model: 'm' } } } }
      const result = importDefaultSpaceCredentials('work')
      expect(result.imported).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previous
    }
  })
})
