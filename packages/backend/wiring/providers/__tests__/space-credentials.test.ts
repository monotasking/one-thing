import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  sessions: new Map<string, { workspaceId?: string }>(),
  oauthProviders: new Set<string>(),
  credentialFreeProviders: new Set<string>(),
  spaces: [] as Array<{ id: string; name: string; createdAt: number }>,
  resolveAuthImpl: (async () => null) as
    (providerId: string, apiKey: string | undefined, target: unknown) => Promise<unknown>,
}))

vi.mock('../../../stores/settings.js', () => ({
  getSettings: () => mocks.settings,
}))

// Pool behavior must not depend on credentials present in the test host's environment.
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
  getSpacesStore: () => ({ list: () => mocks.spaces }),
}))

vi.mock('../../auth/auth-service.js', () => ({
  authService: {
    resolveProviderAuth: (providerId: string, apiKey: string | undefined, target: unknown) =>
      mocks.resolveAuthImpl(providerId, apiKey, target),
  },
}))

import {
  resetSpaceCredentialsCacheForTests,
  upsertSpaceProviderApiKey,
} from '@onething/runtime/spaces/credentials'
import { setRootDirForTests } from '@onething/runtime/spaces/persistence'
import {
  applySessionSpaceCredentials,
  credentialTargetFromMarker,
  getSpaceCredentialsSummary,
  importDefaultSpaceCredentials,
  markSpaceOAuthRefreshFailure,
  removeSpaceProviderOAuthEntry,
  resolveSessionCredentialId,
  resolveSessionSpaceOAuthAuth,
} from '../space-credentials.js'
import {
  getSpaceProviderCredentials,
  upsertSpaceProviderOAuthToken,
  writeSpaceCredentials,
} from '@onething/runtime/spaces/credentials'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-app-space-creds-'))
  setRootDirForTests(tmpDir)
  resetSpaceCredentialsCacheForTests()
  mocks.settings = {}
  mocks.sessions = new Map()
  mocks.oauthProviders = new Set(['codex'])
  mocks.credentialFreeProviders = new Set()
  mocks.spaces = [
    { id: 'default', name: '默认空间', createdAt: 0 },
    { id: 'work', name: '工作', createdAt: 1 },
  ]
  mocks.resolveAuthImpl = async () => null
})

afterEach(() => {
  setRootDirForTests(null)
  resetSpaceCredentialsCacheForTests()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('按「会话归属的 space」解析,不是「当前 space」', () => {
  it('default 空间的会话:C1 起也过池 —— 池里那条说了算,credentialId 不再恒缺席', () => {
    mocks.sessions.set('s-default', {})
    upsertSpaceProviderApiKey('default', 'deepseek', { apiKey: 'sk-default' })
    const next = applySessionSpaceCredentials('s-default', 'deepseek', {
      model: 'm',
      apiKey: 'sk-global',
    }) as Record<string, unknown>
    expect(next.apiKey).toBe('sk-default')
    expect(resolveSessionCredentialId('s-default', 'deepseek')).toBeTruthy()
  })

  it('default 空间没配这个 provider:与别的空间同一条 —— 钥匙抹掉、诚实拦住', () => {
    mocks.sessions.set('s-default', {})
    const next = applySessionSpaceCredentials('s-default', 'deepseek', {
      model: 'm',
      apiKey: 'sk-global',
    }) as Record<string, unknown>
    expect(next.apiKey).toBeUndefined()
    expect((next.spaceCredential as { unavailable?: { reason: string } }).unavailable?.reason)
      .toBe('no-entry')
  })

  it('从不问凭证的 provider(名录里 requiresApiKey === false)原样透传', () => {
    mocks.sessions.set('s-work', { workspaceId: 'work' })
    mocks.credentialFreeProviders = new Set(['claude-code-agent'])
    const config = { model: 'claude-code-agent' }
    expect(applySessionSpaceCredentials('s-work', 'claude-code-agent', config)).toBe(config)
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

  it('OAuth 型 provider 没在本空间登录过 = 未配置,文案指向「在本空间登录」(批 B6)', () => {
    mocks.sessions.set('s-work', { workspaceId: 'work' })
    const next = applySessionSpaceCredentials('s-work', 'codex', { model: 'm' }) as Record<string, unknown>
    const marker = next.spaceCredential as { unavailable?: { reason: string; message: string } }
    expect(marker.unavailable?.reason).toBe('oauth')
    expect(marker.unavailable?.message).toContain('本空间登录')
  })

  it('拿不到 sessionId 时按 default 处理(诚实降级,不去猜"用户现在在看哪个空间")', () => {
    upsertSpaceProviderApiKey('default', 'deepseek', { apiKey: 'sk-default' })
    const next = applySessionSpaceCredentials('', 'deepseek', {
      model: 'm',
      apiKey: 'sk-global',
    }) as Record<string, unknown>
    expect((next.spaceCredential as { spaceId?: string }).spaceId).toBe('default')
    expect(next.apiKey).toBe('sk-default')
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

  /**
   * 批 B10:档位/地区**不是密钥**,原样投影 —— 面板要画的就是「这条 key 用的是
   * 哪个档位、哪个地区」。给个 hasApiMode 布尔没有任何用处。
   */
  it('把 provider 专属旋钮原样送给面板', () => {
    upsertSpaceProviderApiKey('work', 'kimi', {
      apiKey: 'sk-k',
      apiMode: 'coding-plan',
      region: 'intl',
    })
    expect(getSpaceCredentialsSummary('work').providers.kimi.entries[0]).toMatchObject({
      apiMode: 'coding-plan',
      region: 'intl',
    })
  })
})

describe('从默认空间导入凭证(新建向导)', () => {
  // C1:源头是**default 空间的凭证池**,不再是 settings.ai —— 迁移之后 settings
  // 里已经没有 apiKey 这一格,继续读它只会导出一片空。
  beforeEach(() => {
    upsertSpaceProviderApiKey('default', 'deepseek', { apiKey: 'sk-d' })
    upsertSpaceProviderApiKey('default', 'openai', { apiKey: 'sk-o', baseUrl: 'https://proxy/v1' })
    upsertSpaceProviderApiKey('default', 'kimi', {
      apiKey: 'sk-k',
      apiMode: 'coding-plan',
      region: 'intl',
    })
    upsertSpaceProviderOAuthToken('default', 'codex', { token: { accessToken: 'at', expiresAt: 1 } })
  })

  it('复制快照:导入后改源空间不影响这个空间', () => {
    const result = importDefaultSpaceCredentials('work')
    expect(result.imported.sort()).toEqual(['deepseek', 'kimi', 'openai'])

    upsertSpaceProviderApiKey('default', 'deepseek', { apiKey: 'sk-changed' })
    resetSpaceCredentialsCacheForTests()
    expect(getSpaceCredentialsSummary('work').providers.deepseek.entries[0].apiKeyPreview)
      .toBe('sk-d••••')
  })

  /**
   * 批 B10:少带档位这两格,导入出来的 Kimi 会从「编程套餐」悄悄退回「开放平台
   * 按量」—— 那是**在订阅之外再扣一次钱**,不是一次外观走样。
   */
  it('档位与地区跟着密钥一起复制', () => {
    const result = importDefaultSpaceCredentials('work')
    expect(result.credentials.providers.kimi.entries[0]).toMatchObject({
      apiMode: 'coding-plan',
      region: 'intl',
    })
  })

  it('OAuth 型跳过并如实报出;没配 key 的不吵用户', () => {
    const result = importDefaultSpaceCredentials('work')
    expect(result.skipped).toEqual([{ providerId: 'codex', reason: 'oauth' }])
    expect(result.credentials.providers.codex).toBeUndefined()
    expect(result.credentials.providers.gemini).toBeUndefined()
  })

  it('不吃环境变量兜底 —— 只快照源空间池里写着的原文', () => {
    const previous = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = 'sk-from-env'
    try {
      const result = importDefaultSpaceCredentials('work', 'empty')
      expect(result.imported).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previous
    }
  })
})

/* ── per-space OAuth(批 B6)────────────────────────────────────────────────── */

const OAUTH_TOKEN = {
  accessToken: 'at-secret',
  refreshToken: 'rt-secret',
  expiresAt: Date.now() + 3_600_000,
  tokenType: 'Bearer',
  email: 'me@example.com',
}

describe('per-space OAuth(批 B6)', () => {
  it('本空间登录过 → 命中 oauth entry,标记带 authType 且账本归因连得上', () => {
    mocks.sessions.set('s-work', { workspaceId: 'work' })
    upsertSpaceProviderOAuthToken('work', 'codex', { entryId: undefined, label: '工作号', token: OAUTH_TOKEN })

    const next = applySessionSpaceCredentials('s-work', 'codex', { model: 'm', apiKey: 'sk-global' }) as Record<string, unknown>
    const marker = next.spaceCredential as { spaceId: string; entryId?: string; authType?: string }
    expect(marker.authType).toBe('oauth')
    expect(next.oauthToken).toEqual(OAUTH_TOKEN)
    // 严格隔离:默认空间的 key 不能顺着 config 漏进来当兜底。
    expect(next.apiKey).toBeUndefined()
    expect(resolveSessionCredentialId('s-work', 'codex')).toBe(marker.entryId)
  })

  it('摘要只报「登没登 / 什么时候过期 / 哪个账号」,token 原文永不出后端', () => {
    upsertSpaceProviderOAuthToken('work', 'codex', { label: '工作号', token: OAUTH_TOKEN })
    const summary = getSpaceCredentialsSummary('work')
    const entry = summary.providers.codex.entries[0]
    expect(entry.authType).toBe('oauth')
    expect(entry.hasOAuthToken).toBe(true)
    expect(entry.oauthAccount).toBe('me@example.com')
    expect(entry.oauthExpiresAt).toBe(OAUTH_TOKEN.expiresAt)
    expect(JSON.stringify(summary)).not.toContain('at-secret')
    expect(JSON.stringify(summary)).not.toContain('rt-secret')
  })

  it('写回目标从标记来:默认空间 = settings,非默认 = 那个空间的那条 entry', () => {
    expect(credentialTargetFromMarker(undefined)).toEqual({ kind: 'settings' })
    expect(credentialTargetFromMarker({ spaceId: 'default', entryId: 'x' })).toEqual({ kind: 'settings' })
    expect(credentialTargetFromMarker({ spaceId: 'work', entryId: 'x' }))
      .toEqual({ kind: 'space', spaceId: 'work', entryId: 'x' })
  })

  it('鉴权点按标记去取 token;默认空间那条路的目标仍是 settings(回归)', async () => {
    const seen: unknown[] = []
    mocks.resolveAuthImpl = async (_id, _key, target) => {
      seen.push(target)
      return { kind: 'oauth' }
    }
    await resolveSessionSpaceOAuthAuth('codex', undefined, undefined)
    await resolveSessionSpaceOAuthAuth('codex', undefined, { spaceId: 'work', entryId: 'e1' })
    expect(seen).toEqual([
      { kind: 'settings' },
      { kind: 'space', spaceId: 'work', entryId: 'e1' },
    ])
  })

  it('刷新被拒 → 给那条 entry 写 auth-invalid 冷却(下一轮解析会跳过它)', async () => {
    upsertSpaceProviderOAuthToken('work', 'codex', { entryId: 'acc-1', label: '工作号', token: OAUTH_TOKEN })
    const entryId = getSpaceProviderCredentials('work', 'codex')!.entries[0].id
    mocks.resolveAuthImpl = async () => {
      throw Object.assign(new Error('Token refresh failed: 401'), { statusCode: 401 })
    }

    await expect(
      resolveSessionSpaceOAuthAuth('codex', undefined, { spaceId: 'work', entryId }),
    ).rejects.toThrow('Token refresh failed: 401')

    resetSpaceCredentialsCacheForTests()
    const cooled = getSpaceProviderCredentials('work', 'codex')!.entries[0]
    expect(cooled.cooldownUntil).toBeGreaterThan(Date.now() + 23 * 60 * 60_000)
  })

  it('网络抖动不写冷却 —— 一次超时不该让好账号坐 24 小时冷板凳', () => {
    upsertSpaceProviderOAuthToken('work', 'codex', { entryId: 'acc-1', token: OAUTH_TOKEN })
    const entryId = getSpaceProviderCredentials('work', 'codex')!.entries[0].id
    expect(markSpaceOAuthRefreshFailure('codex', 'work', entryId, new Error('fetch failed'))).toBe(false)
    resetSpaceCredentialsCacheForTests()
    expect(getSpaceProviderCredentials('work', 'codex')!.entries[0].cooldownUntil).toBeUndefined()
  })

  it('退出登录只删那一条 entry,同 provider 的另一个账号还在', () => {
    writeSpaceCredentials('work', {
      providers: {
        codex: {
          entries: [
            { id: 'a', label: '账号 A', authType: 'oauth', oauthToken: OAUTH_TOKEN, source: 'user' },
            { id: 'b', label: '账号 B', authType: 'oauth', oauthToken: OAUTH_TOKEN, source: 'user' },
          ],
          policy: 'priority-failover',
        },
      },
    })
    const summary = removeSpaceProviderOAuthEntry('work', 'codex', 'a')
    expect(summary.providers.codex.entries.map(entry => entry.id)).toEqual(['b'])
  })
})
