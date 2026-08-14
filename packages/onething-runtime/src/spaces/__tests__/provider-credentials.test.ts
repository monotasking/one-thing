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

describe('三态解析', () => {
  it('default space → settings 源(一个字节都不改)', () => {
    // 就算 default 的 credentials.json 里真有东西也不看它:默认空间的凭证层
    // 就是 settings.ai,这不是回落而是身份定义。
    upsertSpaceProviderApiKey(DEFAULT_SPACE_ID, 'deepseek', { apiKey: 'sk-file' })
    const resolution = resolveSpaceProviderCredential({
      spaceId: DEFAULT_SPACE_ID,
      providerId: 'deepseek',
      isOAuthProvider,
    })
    expect(resolution.kind).toBe('settings')

    const config = { model: 'm', apiKey: 'sk-settings' }
    expect(applySpaceProviderCredential(config, resolution, 'deepseek')).toBe(config)
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

describe('OAuth 在非 default 空间一律拒绝', () => {
  it('provider 本身是 OAuth/订阅型时,连查池都不查', () => {
    const resolution = resolveSpaceProviderCredential({
      spaceId: 'work',
      providerId: 'codex',
      isOAuthProvider,
      providerLabel: 'Codex',
      spaceLabel: '工作',
    })
    expect(resolution).toMatchObject({ kind: 'unavailable', reason: 'oauth' })
    if (resolution.kind !== 'unavailable') throw new Error('unreachable')
    expect(resolution.message).toContain('默认空间')
  })

  it('池里存的是 oauth entry 也一样拒绝', () => {
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
    }).kind).toBe('settings')
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

  it('marker: default 不盖标记,其余两态各自成形', () => {
    expect(toSpaceCredentialMarker({ kind: 'settings', spaceId: DEFAULT_SPACE_ID })).toBeUndefined()
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
