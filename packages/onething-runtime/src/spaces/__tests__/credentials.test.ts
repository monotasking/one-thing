import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildImportedSpaceCredentials,
  clearSpaceProviderCredentials,
  createSpaceCredentialEntryId,
  getSpaceProviderCredentials,
  isSpaceCredentialEntryCooling,
  parseSpaceCredentialEntry,
  parseSpaceCredentialsFile,
  previewSpaceCredentialApiKey,
  readSpaceCredentials,
  resetSpaceCredentialsCacheForTests,
  selectSpaceCredentialEntry,
  spaceCredentialsFilePath,
  upsertSpaceProviderApiKey,
  writeSpaceCredentials,
} from '../credentials.js'
import { setRootDirForTests } from '../persistence.js'
import { DEFAULT_SPACE_ID } from '../types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-spaces-creds-'))
  setRootDirForTests(tmpDir)
  resetSpaceCredentialsCacheForTests()
})

afterEach(async () => {
  setRootDirForTests(null)
  resetSpaceCredentialsCacheForTests()
  await fs.rm(tmpDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('credentials.json schema parsing', () => {
  it('accepts the design-doc shape verbatim', () => {
    const parsed = parseSpaceCredentialsFile({
      providers: {
        deepseek: {
          entries: [{
            id: 'e1',
            label: 'work',
            authType: 'apiKey',
            apiKey: 'sk-1',
            source: 'user',
            cooldownUntil: 0,
          }],
          policy: 'single',
        },
      },
    })
    expect(parsed?.providers.deepseek.policy).toBe('single')
    expect(parsed?.providers.deepseek.entries[0]).toMatchObject({
      id: 'e1',
      label: 'work',
      authType: 'apiKey',
      apiKey: 'sk-1',
      source: 'user',
    })
    // cooldownUntil: 0 是"没在冷却",不是"没这个字段" —— 但 0 也不该被当成脏值丢掉。
    expect(parsed?.providers.deepseek.entries[0].cooldownUntil).toBe(0)
  })

  it('keeps the pool shape even when the UI only ever writes one entry', () => {
    const parsed = parseSpaceCredentialsFile({
      providers: {
        openai: {
          entries: [
            { id: 'a', label: 'a', authType: 'apiKey', apiKey: 'k1', source: 'user' },
            { id: 'b', label: 'b', authType: 'apiKey', apiKey: 'k2', source: 'plugin:x' },
          ],
          policy: 'round-robin',
        },
      },
    })
    expect(parsed?.providers.openai.entries).toHaveLength(2)
    expect(parsed?.providers.openai.policy).toBe('round-robin')
  })

  it('defaults a missing policy to single and a missing label to the id', () => {
    const parsed = parseSpaceCredentialsFile({
      providers: { qwen: { entries: [{ id: 'x', authType: 'apiKey', source: 'user' }] } },
    })
    expect(parsed?.providers.qwen.policy).toBe('single')
    expect(parsed?.providers.qwen.entries[0].label).toBe('x')
  })

  it('treats a missing providers key as an empty pool, not as corruption', () => {
    expect(parseSpaceCredentialsFile({})).toEqual({ providers: {} })
  })

  it('discards the WHOLE file when any entry is structurally wrong', () => {
    // 缺 id
    expect(parseSpaceCredentialsFile({
      providers: { a: { entries: [{ authType: 'apiKey', source: 'user' }] } },
    })).toBeNull()
    // authType 不在枚举里
    expect(parseSpaceCredentialsFile({
      providers: { a: { entries: [{ id: 'x', authType: 'magic', source: 'user' }] } },
    })).toBeNull()
    // 缺 source(批 F 依赖它做卸载归档,不能当可选)
    expect(parseSpaceCredentialsFile({
      providers: { a: { entries: [{ id: 'x', authType: 'apiKey' }] } },
    })).toBeNull()
    // entries 根本不是数组
    expect(parseSpaceCredentialsFile({ providers: { a: { entries: {} } } })).toBeNull()
    // 整份不是对象
    expect(parseSpaceCredentialsFile('nope')).toBeNull()
    expect(parseSpaceCredentialsFile({ providers: [] })).toBeNull()
  })

  it('drops duplicate entry ids instead of failing the file', () => {
    const parsed = parseSpaceCredentialsFile({
      providers: {
        a: {
          entries: [
            { id: 'dup', authType: 'apiKey', apiKey: '1', source: 'user' },
            { id: 'dup', authType: 'apiKey', apiKey: '2', source: 'user' },
          ],
        },
      },
    })
    expect(parsed?.providers.a.entries).toHaveLength(1)
  })

  it('parses oauth entries (schema-level) even though B3 refuses to use them', () => {
    const entry = parseSpaceCredentialEntry({
      id: 'o',
      authType: 'oauth',
      oauthToken: { accessToken: 'x' },
      source: 'user',
    })
    expect(entry?.authType).toBe('oauth')
    expect(entry?.oauthToken).toEqual({ accessToken: 'x' })
  })
})

describe('credentials.json storage', () => {
  it('lives next to space.json but in its own file', () => {
    expect(spaceCredentialsFilePath('work')).toBe(path.join(tmpDir, 'work', 'credentials.json'))
  })

  it('falls back to default for an illegal space id (id is a path segment)', () => {
    expect(spaceCredentialsFilePath('../evil')).toBe(
      path.join(tmpDir, DEFAULT_SPACE_ID, 'credentials.json'),
    )
  })

  it('round-trips through write/read', () => {
    writeSpaceCredentials('work', {
      providers: {
        deepseek: {
          entries: [{ id: 'e', label: 'e', authType: 'apiKey', apiKey: 'sk', source: 'user' }],
          policy: 'single',
        },
      },
    })
    resetSpaceCredentialsCacheForTests()
    expect(readSpaceCredentials('work').providers.deepseek.entries[0].apiKey).toBe('sk')
  })

  it('treats a corrupt file as an empty pool and says so once', async () => {
    await fs.mkdir(path.join(tmpDir, 'work'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'work', 'credentials.json'), '{ not json', 'utf-8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(readSpaceCredentials('work')).toEqual({ providers: {} })
    expect(warn).toHaveBeenCalled()
  })

  it('treats a schema-invalid file as an empty pool — never a half pool', async () => {
    await fs.mkdir(path.join(tmpDir, 'work'), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir, 'work', 'credentials.json'),
      JSON.stringify({ providers: { a: { entries: [{ id: 'ok', authType: 'apiKey', source: 'user' }] }, b: 3 } }),
      'utf-8',
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(readSpaceCredentials('work')).toEqual({ providers: {} })
  })

  it('missing file = empty pool = "this space configured nothing"', () => {
    expect(readSpaceCredentials('nowhere')).toEqual({ providers: {} })
  })
})

describe('single-entry upsert (the only write the B3 UI makes)', () => {
  it('creates then replaces the apiKey entry, keeping its id', () => {
    upsertSpaceProviderApiKey('work', 'deepseek', { apiKey: 'sk-1', label: 'DeepSeek' })
    const first = getSpaceProviderCredentials('work', 'deepseek')?.entries[0]
    upsertSpaceProviderApiKey('work', 'deepseek', { apiKey: 'sk-2' })
    const second = getSpaceProviderCredentials('work', 'deepseek')?.entries[0]
    expect(second?.apiKey).toBe('sk-2')
    // id 与内容无关:换 key 不换 id,账本归因才连得上。
    expect(second?.id).toBe(first?.id)
    expect(getSpaceProviderCredentials('work', 'deepseek')?.entries).toHaveLength(1)
  })

  it('leaves other pool entries alone (batch D inherits them without migration)', () => {
    writeSpaceCredentials('work', {
      providers: {
        openai: {
          entries: [
            { id: 'plugin-1', label: 'from plugin', authType: 'oauth', source: 'plugin:x' },
            { id: 'mine', label: 'mine', authType: 'apiKey', apiKey: 'old', source: 'user' },
          ],
          policy: 'priority-failover',
        },
      },
    })
    upsertSpaceProviderApiKey('work', 'openai', { apiKey: 'new' })
    const pool = getSpaceProviderCredentials('work', 'openai')
    expect(pool?.entries).toHaveLength(2)
    expect(pool?.entries.find(e => e.id === 'plugin-1')?.source).toBe('plugin:x')
    expect(pool?.entries.find(e => e.id === 'mine')?.apiKey).toBe('new')
    expect(pool?.policy).toBe('priority-failover')
  })

  it('stores the optional baseUrl override', () => {
    upsertSpaceProviderApiKey('work', 'openai', { apiKey: 'k', baseUrl: 'https://proxy.test/v1' })
    expect(getSpaceProviderCredentials('work', 'openai')?.entries[0].baseUrl)
      .toBe('https://proxy.test/v1')
  })

  it('clear removes the whole provider segment', () => {
    upsertSpaceProviderApiKey('work', 'openai', { apiKey: 'k' })
    clearSpaceProviderCredentials('work', 'openai')
    expect(getSpaceProviderCredentials('work', 'openai')).toBeUndefined()
  })

  it('entry ids are content-independent', () => {
    expect(createSpaceCredentialEntryId(1)).not.toBe(createSpaceCredentialEntryId(1))
  })
})

describe('policy: single', () => {
  it('picks the first entry that is not cooling down', () => {
    const now = 1_000
    const pool = {
      policy: 'single',
      entries: [
        { id: 'cold', label: 'cold', authType: 'apiKey' as const, apiKey: 'a', source: 'user', cooldownUntil: 2_000 },
        { id: 'hot', label: 'hot', authType: 'apiKey' as const, apiKey: 'b', source: 'user' },
      ],
    }
    expect(isSpaceCredentialEntryCooling(pool.entries[0], now)).toBe(true)
    expect(selectSpaceCredentialEntry(pool, now)?.id).toBe('hot')
  })

  it('returns undefined for an absent or fully-cooling pool', () => {
    expect(selectSpaceCredentialEntry(undefined)).toBeUndefined()
    expect(selectSpaceCredentialEntry({
      policy: 'single',
      entries: [{ id: 'a', label: 'a', authType: 'apiKey', apiKey: 'x', source: 'user', cooldownUntil: 9_999 }],
    }, 1)).toBeUndefined()
  })
})

describe('import snapshot (new-space wizard)', () => {
  it('copies apiKey providers and reports the OAuth ones it skipped', () => {
    const result = buildImportedSpaceCredentials([
      { providerId: 'deepseek', apiKey: 'sk-d', label: 'DeepSeek' },
      { providerId: 'openai', apiKey: 'sk-o', baseUrl: 'https://x/v1' },
      { providerId: 'codex', apiKey: 'ignored', oauth: true },
      { providerId: 'gemini' },
    ], { makeEntryId: index => `id-${index}` })

    expect(result.imported).toEqual(['deepseek', 'openai'])
    expect(result.skipped).toEqual([
      { providerId: 'codex', reason: 'oauth' },
      { providerId: 'gemini', reason: 'no-api-key' },
    ])
    expect(result.file.providers.deepseek.entries[0]).toMatchObject({
      id: 'id-0',
      apiKey: 'sk-d',
      authType: 'apiKey',
      source: 'user',
    })
    expect(result.file.providers.openai.entries[0].baseUrl).toBe('https://x/v1')
    // OAuth 型一条都不进文件 —— 悄悄导入一个用不了的 token 比直说跳过更糟。
    expect(result.file.providers.codex).toBeUndefined()
  })

  it('is a copy, not a reference: later global edits do not reach the space', () => {
    const source = { providerId: 'deepseek', apiKey: 'sk-1' }
    const result = buildImportedSpaceCredentials([source])
    source.apiKey = 'sk-changed'
    expect(result.file.providers.deepseek.entries[0].apiKey).toBe('sk-1')
  })
})

describe('preview', () => {
  it('never returns the raw key', () => {
    expect(previewSpaceCredentialApiKey('sk-abcdef0123456789')).toBe('sk-abc••••6789')
    expect(previewSpaceCredentialApiKey('short')).toBe('short••••')
    expect(previewSpaceCredentialApiKey('  ')).toBeUndefined()
    expect(previewSpaceCredentialApiKey(undefined)).toBeUndefined()
  })
})
