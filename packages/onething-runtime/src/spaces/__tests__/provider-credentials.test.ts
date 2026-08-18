import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetSpaceCredentialsCacheForTests,
  upsertSpaceProviderApiKey,
  writeSpaceCredentials,
} from '../credentials.js'
import { setRootDirForTests } from '../persistence.js'
import {
  applySpaceProviderCredential,
  resolveSpaceProviderCredential,
  toSpaceCredentialMarker,
} from '../provider-credentials.js'
import { DEFAULT_SPACE_ID } from '../types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-spaces-resolve-'))
  setRootDirForTests(tmpDir)
  resetSpaceCredentialsCacheForTests()
})

afterEach(async () => {
  setRootDirForTests(null)
  resetSpaceCredentialsCacheForTests()
  await fs.rm(tmpDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const oauthProviders = new Set(['codex', 'claude-code', 'kimi-code'])
const isOAuthProvider = (id: string): boolean => oauthProviders.has(id)

describe('两态解析(C1:default 也是普通空间)', () => {
  it('default space 走**同一条**路 —— 池里那条 entry 说了算,不再看 settings', () => {
    upsertSpaceProviderApiKey(DEFAULT_SPACE_ID, 'deepseek', { apiKey: 'sk-file' })
    const resolution = resolveSpaceProviderCredential({
      spaceId: DEFAULT_SPACE_ID,
      providerId: 'deepseek',
      isOAuthProvider,
    })
    expect(resolution).toMatchObject({ kind: 'entry', spaceId: DEFAULT_SPACE_ID })

    const next = applySpaceProviderCredential(
      { model: 'm', apiKey: 'sk-settings' },
      resolution,
      'deepseek',
    ) as Record<string, unknown>
    expect(next.apiKey).toBe('sk-file')
  })

  it('default space 池里没有 entry → 与别的空间一样报「未配置」(configured 闸不再豁免)', () => {
    const resolution = resolveSpaceProviderCredential({
      spaceId: DEFAULT_SPACE_ID,
      providerId: 'deepseek',
      isOAuthProvider,
    })
    expect(resolution).toMatchObject({ kind: 'unavailable', reason: 'no-entry' })
    const next = applySpaceProviderCredential(
      { model: 'm', apiKey: 'sk-settings' },
      resolution,
      'deepseek',
    ) as Record<string, unknown>
    // 迁移之前 settings 里可能还留着一把旧钥匙:抹掉,否则隔离对没迁完的机器不生效。
    expect(next.apiKey).toBeUndefined()
  })

  it('env key 机器级、全空间可见(C1 拍板 1)—— 不盖标记,交给 env 兜底', () => {
    for (const spaceId of [DEFAULT_SPACE_ID, 'work']) {
      const resolution = resolveSpaceProviderCredential({
        spaceId,
        providerId: 'deepseek',
        isOAuthProvider,
        hasEnvApiKey: () => ({ envVar: 'DEEPSEEK_API_KEY' }),
      })
      expect(resolution).toMatchObject({ kind: 'env', spaceId, envVar: 'DEEPSEEK_API_KEY' })
      const next = applySpaceProviderCredential(
        { model: 'm', apiKey: 'sk-stale' },
        resolution,
        'deepseek',
      ) as Record<string, unknown>
      // 不阻断(没有 spaceCredential 标记),但也不把旧 settings key 递过去。
      expect(next.spaceCredential).toBeUndefined()
      expect(next.apiKey).toBeUndefined()
    }
  })

  it('池里有 entry 时 env 不参与 —— 空间里配了钥匙却被环境变量顶掉是解释不清的一天', () => {
    upsertSpaceProviderApiKey('work', 'deepseek', { apiKey: 'sk-space' })
    const resolution = resolveSpaceProviderCredential({
      spaceId: 'work',
      providerId: 'deepseek',
      isOAuthProvider,
      hasEnvApiKey: () => true,
    })
    expect(resolution.kind).toBe('entry')
  })

  it('从不问凭证的 provider(ACP / 本地 agent)不是「未配置」', () => {
    const resolution = resolveSpaceProviderCredential({
      spaceId: 'work',
      providerId: 'acp',
      isOAuthProvider,
      isCredentialFreeProvider: id => id === 'acp',
    })
    expect(resolution).toMatchObject({ kind: 'credential-free', spaceId: 'work' })
    const config = { model: 'claude-code' }
    expect(applySpaceProviderCredential(config, resolution, 'acp')).toBe(config)
  })

  it('非 default + 有 entry → 覆盖 apiKey / baseUrl 并留下 entryId', () => {
    upsertSpaceProviderApiKey('work', 'deepseek', {
      apiKey: 'sk-work',
      baseUrl: 'https://proxy.test/v1',
    })
    const resolution = resolveSpaceProviderCredential({
      spaceId: 'work',
      providerId: 'deepseek',
      isOAuthProvider,
    })
    expect(resolution.kind).toBe('entry')

    const next = applySpaceProviderCredential(
      { model: 'm', apiKey: 'sk-global', baseUrl: 'https://api.deepseek.com' },
      resolution,
      'deepseek',
    ) as Record<string, unknown>
    expect(next.apiKey).toBe('sk-work')
    expect(next.baseUrl).toBe('https://proxy.test/v1')
    expect(next.spaceCredential).toMatchObject({ spaceId: 'work' })
    expect((next.spaceCredential as { entryId?: string }).entryId).toBeTruthy()
  })

  it('非 default + 无 entry → 结构化「未配置」,且钥匙被抹掉', () => {
    const resolution = resolveSpaceProviderCredential({
      spaceId: 'work',
      providerId: 'deepseek',
      isOAuthProvider,
      providerLabel: 'DeepSeek',
      spaceLabel: '工作',
    })
    expect(resolution).toMatchObject({ kind: 'unavailable', reason: 'no-entry' })
    if (resolution.kind !== 'unavailable') throw new Error('unreachable')
    expect(resolution.message).toContain('工作')
    expect(resolution.message).toContain('DeepSeek')
    expect(resolution.message).toContain('未配置')

    // 严格隔离:绝不静默沿用默认空间的 key。
    const next = applySpaceProviderCredential(
      { model: 'm', apiKey: 'sk-global', oauthToken: { accessToken: 'x' } },
      resolution,
      'deepseek',
    ) as Record<string, unknown>
    expect(next.apiKey).toBeUndefined()
    expect(next.oauthToken).toBeUndefined()
    expect((next.spaceCredential as { unavailable?: unknown }).unavailable).toBeTruthy()
  })
})

describe('OAuth 在非 default 空间:没登录才拒绝(批 B6)', () => {
  it('本空间没有 oauth entry = 未登录,文案指向「在本空间登录」而不是「换个空间」', () => {
    const resolution = resolveSpaceProviderCredential({
      spaceId: 'work',
      providerId: 'codex',
      isOAuthProvider,
      providerLabel: 'Codex',
      spaceLabel: '工作',
    })
    expect(resolution).toMatchObject({ kind: 'unavailable', reason: 'oauth' })
    if (resolution.kind !== 'unavailable') throw new Error('unreachable')
    expect(resolution.message).toContain('本空间登录')
    // B3/D 的临时闸(「请在默认空间使用」)已经拆掉 —— 出路变了,文案必须跟着变。
    expect(resolution.message).not.toContain('请在默认空间使用')
  })

  it('本空间登录过 → oauth-entry(带上那条 entry,标记 authType 为 oauth)', () => {
    writeSpaceCredentials('work', {
      providers: {
        codex: {
          entries: [{
            id: 'acc-1',
            label: '工作号',
            authType: 'oauth',
            oauthToken: { accessToken: 'at', expiresAt: Date.now() + 3_600_000, tokenType: 'Bearer' },
            source: 'user',
          }],
          policy: 'single',
        },
      },
    })
    const resolution = resolveSpaceProviderCredential({
      spaceId: 'work',
      providerId: 'codex',
      isOAuthProvider,
    })
    expect(resolution.kind).toBe('oauth-entry')
    expect(toSpaceCredentialMarker(resolution)).toEqual({
      spaceId: 'work',
      entryId: 'acc-1',
      authType: 'oauth',
    })
  })

  it('登录记录是个空壳(没有 token)= 未登录 —— 不让 401 去替我们说话', () => {
    writeSpaceCredentials('work', {
      providers: {
        codex: {
          entries: [{ id: 'acc-1', label: '空壳', authType: 'oauth', source: 'user' }],
          policy: 'single',
        },
      },
    })
    expect(resolveSpaceProviderCredential({
      spaceId: 'work',
      providerId: 'codex',
      isOAuthProvider,
    })).toMatchObject({ kind: 'unavailable', reason: 'oauth' })
  })

  it('OAuth 型 provider 的池里混进 apiKey entry:按形态过滤掉,不拿它去撞登录端点', () => {
    writeSpaceCredentials('work', {
      providers: {
        codex: {
          entries: [{ id: 'k', label: 'k', authType: 'apiKey', apiKey: 'sk-x', source: 'user' }],
          policy: 'single',
        },
      },
    })
    expect(resolveSpaceProviderCredential({
      spaceId: 'work',
      providerId: 'codex',
      isOAuthProvider,
    })).toMatchObject({ kind: 'unavailable', reason: 'oauth' })
  })

  it('把 oauth token 盖进 config 时,settings 的 apiKey 被抹掉(严格隔离)', () => {
    const token = { accessToken: 'at', expiresAt: Date.now() + 3_600_000, tokenType: 'Bearer' }
    writeSpaceCredentials('work', {
      providers: {
        codex: {
          entries: [{ id: 'acc-1', label: '工作号', authType: 'oauth', oauthToken: token, source: 'user' }],
          policy: 'single',
        },
      },
    })
    const resolution = resolveSpaceProviderCredential({
      spaceId: 'work',
      providerId: 'codex',
      isOAuthProvider,
    })
    const next = applySpaceProviderCredential(
      { apiKey: 'sk-from-settings', model: 'gpt-5' } as Record<string, unknown>,
      resolution,
      'codex',
    ) as Record<string, unknown>
    expect(next.apiKey).toBeUndefined()
    expect(next.oauthToken).toEqual(token)
  })

  // 非 OAuth 型 provider 的池里混进 oauth entry:那是配错了,仍然拒绝。
  it('provider 不是 OAuth 型,却在池里存了 oauth entry —— 一样拒绝', () => {
    writeSpaceCredentials('work', {
      providers: {
        openai: {
          entries: [{ id: 'o', label: 'o', authType: 'oauth', oauthToken: {}, source: 'user' }],
          policy: 'single',
        },
      },
    })
    expect(resolveSpaceProviderCredential({
      spaceId: 'work',
      providerId: 'openai',
      isOAuthProvider,
    })).toMatchObject({ kind: 'unavailable', reason: 'oauth' })
  })

  it('entry 存在但 apiKey 是空的 = 未配置(不让 401 去替我们说话)', () => {
    writeSpaceCredentials('work', {
      providers: {
        openai: {
          entries: [{ id: 'e', label: 'e', authType: 'apiKey', source: 'user' }],
          policy: 'single',
        },
      },
    })
    expect(resolveSpaceProviderCredential({
      spaceId: 'work',
      providerId: 'openai',
      isOAuthProvider,
    })).toMatchObject({ kind: 'unavailable', reason: 'no-entry' })
  })
})

describe('边角', () => {
  it('非法 space id 落回 default(id 是路径片段)', () => {
    expect(resolveSpaceProviderCredential({
      spaceId: '../evil',
      providerId: 'deepseek',
      isOAuthProvider,
    }).spaceId).toBe(DEFAULT_SPACE_ID)
  })

  it('entry 的 apiMode 落进 provider 自己的档位字段', () => {
    writeSpaceCredentials('work', {
      providers: {
        zhipu: {
          entries: [{
            id: 'z',
            label: 'z',
            authType: 'apiKey',
            apiKey: 'sk',
            apiMode: 'coding-plan',
            source: 'user',
          }],
          policy: 'single',
        },
      },
    })
    const resolution = resolveSpaceProviderCredential({
      spaceId: 'work',
      providerId: 'zhipu',
      isOAuthProvider,
    })
    const next = applySpaceProviderCredential({ model: 'm' }, resolution, 'zhipu') as Record<string, unknown>
    expect(next.zhipuApiMode).toBe('coding-plan')
  })

  it('marker: env / credential-free 不盖标记,其余各自成形', () => {
    expect(toSpaceCredentialMarker({ kind: 'env', spaceId: DEFAULT_SPACE_ID })).toBeUndefined()
    expect(toSpaceCredentialMarker({ kind: 'credential-free', spaceId: 'work' })).toBeUndefined()
    expect(toSpaceCredentialMarker({
      kind: 'unavailable',
      spaceId: 'work',
      reason: 'no-entry',
      message: 'm',
    })).toEqual({ spaceId: 'work', unavailable: { reason: 'no-entry', message: 'm' } })
  })

  it('providerConfig 缺席时不凭空造一个', () => {
    const resolution = resolveSpaceProviderCredential({
      spaceId: 'work',
      providerId: 'deepseek',
      isOAuthProvider,
    })
    expect(applySpaceProviderCredential(undefined, resolution, 'deepseek')).toBeUndefined()
  })
})
