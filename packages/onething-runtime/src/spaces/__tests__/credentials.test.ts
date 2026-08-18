import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildImportedSpaceCredentials,
  clearSpaceProviderCredentials,
  configureSpaceCredentialPluginStrategyHost,
  createSpaceCredentialEntryId,
  getSpaceCredentialEntry,
  getSpaceProviderCredentials,
  isPluginSpaceCredentialPolicy,
  isSpaceCredentialEntryCooling,
  isSpaceCredentialEntryUsable,
  normalizeSpaceCredentialPolicy,
  parseSpaceCredentialEntry,
  parseSpaceCredentialsFile,
  previewSpaceCredentialApiKey,
  readSpaceCredentials,
  removeSpaceProviderCredentialEntry,
  resetSpaceCredentialsCacheForTests,
  selectSpaceCredentialEntry,
  selectSpaceCredentialEntryDetailed,
  setSpaceProviderCredentialPool,
  upsertSpaceProviderOAuthToken,
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

/* ── OAuth entry(批 B6)────────────────────────────────────────────────────── */

const TOKEN = { accessToken: 'at', refreshToken: 'rt', expiresAt: 10_000, tokenType: 'Bearer' }

describe('OAuth entry 的存取(批 B6)', () => {
  it('entryId 缺席 = 追加一条(多账号是原始需求,不能定成覆盖)', () => {
    const first = upsertSpaceProviderOAuthToken('work', 'codex', { label: '工作号', token: TOKEN })
    const second = upsertSpaceProviderOAuthToken('work', 'codex', { label: '私人号', token: TOKEN })
    expect(first.entryId).not.toBe(second.entryId)

    const entries = getSpaceProviderCredentials('work', 'codex')?.entries ?? []
    expect(entries.map(entry => entry.label)).toEqual(['工作号', '私人号'])
    expect(entries.every(entry => entry.authType === 'oauth')).toBe(true)
  })

  it('entryId 在 = 改那一条,并顺手抹掉冷却(刚刷新成功的凭证不该坐冷板凳)', () => {
    const created = upsertSpaceProviderOAuthToken('work', 'codex', { label: '工作号', token: TOKEN })
    writeSpaceCredentials('work', {
      providers: {
        codex: {
          entries: [{
            id: created.entryId,
            label: '工作号',
            authType: 'oauth',
            oauthToken: TOKEN,
            source: 'user',
            cooldownUntil: Date.now() + 60_000,
          }],
          policy: 'single',
        },
      },
    })

    upsertSpaceProviderOAuthToken('work', 'codex', {
      entryId: created.entryId,
      token: { ...TOKEN, accessToken: 'at-2' },
    })
    const entry = getSpaceCredentialEntry('work', 'codex', created.entryId)
    expect((entry?.oauthToken as { accessToken: string }).accessToken).toBe('at-2')
    expect(entry?.cooldownUntil).toBeUndefined()
    expect(getSpaceProviderCredentials('work', 'codex')?.entries).toHaveLength(1)
  })

  it('删一条 entry 不动别的;删光了整段消失(= 该 provider 未配置)', () => {
    const a = upsertSpaceProviderOAuthToken('work', 'codex', { label: 'A', token: TOKEN })
    const b = upsertSpaceProviderOAuthToken('work', 'codex', { label: 'B', token: TOKEN })

    removeSpaceProviderCredentialEntry('work', 'codex', a.entryId)
    expect(getSpaceProviderCredentials('work', 'codex')?.entries.map(e => e.id)).toEqual([b.entryId])

    removeSpaceProviderCredentialEntry('work', 'codex', b.entryId)
    expect(getSpaceProviderCredentials('work', 'codex')).toBeUndefined()
  })

  it('「能用」的判据多了一种材料:oauth entry 有 token 就算数(批 B6)', () => {
    expect(isSpaceCredentialEntryUsable({
      id: 'a', label: 'a', authType: 'oauth', oauthToken: TOKEN, source: 'user',
    })).toBe(true)
    expect(isSpaceCredentialEntryUsable({
      id: 'a', label: 'a', authType: 'oauth', source: 'user',
    })).toBe(false)
    expect(isSpaceCredentialEntryUsable({
      id: 'a', label: 'a', authType: 'apiKey', apiKey: 'sk', source: 'user',
    })).toBe(true)
  })

  it('按鉴权形态过滤候选:OAuth 型 provider 不会挑到 apiKey entry', () => {
    const credentials = {
      entries: [
        { id: 'k', label: 'k', authType: 'apiKey' as const, apiKey: 'sk', source: 'user' },
        { id: 'o', label: 'o', authType: 'oauth' as const, oauthToken: TOKEN, source: 'user' },
      ],
      policy: 'single',
    }
    expect(selectSpaceCredentialEntryDetailed(credentials, { authType: 'oauth' }).entry?.id).toBe('o')
    expect(selectSpaceCredentialEntryDetailed(credentials, { authType: 'apiKey' }).entry?.id).toBe('k')
    // 不给形态 = 不过滤(批 D 之前的调用点行为一字未改)。
    expect(selectSpaceCredentialEntry(credentials)?.id).toBe('k')
  })

  it('OAuth 池全在冷却里 = exhausted(「等」),不是 no-entry(「去登录」)', () => {
    const until = Date.now() + 60_000
    const selection = selectSpaceCredentialEntryDetailed({
      entries: [
        { id: 'o1', label: 'o1', authType: 'oauth', oauthToken: TOKEN, source: 'user', cooldownUntil: until },
        { id: 'o2', label: 'o2', authType: 'oauth', oauthToken: TOKEN, source: 'user', cooldownUntil: until + 5 },
      ],
      policy: 'priority-failover',
    }, { authType: 'oauth' })
    expect(selection.entry).toBeUndefined()
    expect(selection.exhausted?.earliestRecoveryAt).toBe(until)
  })
})

describe('批 E:插件策略在分叉点上的落点', () => {
  const POOL = {
    entries: [
      { id: 'a', label: 'a', authType: 'apiKey' as const, apiKey: 'k1', source: 'user' },
      { id: 'b', label: 'b', authType: 'apiKey' as const, apiKey: 'k2', source: 'user' },
      { id: 'c', label: 'c', authType: 'apiKey' as const, apiKey: 'k3', source: 'user' },
    ],
    policy: 'plugin:balancer:least-used',
  }

  afterEach(() => {
    configureSpaceCredentialPluginStrategyHost(null)
  })

  it('认得 plugin:<id>:<name> 的形状,且它与三个内置名物理分家', () => {
    expect(isPluginSpaceCredentialPolicy('plugin:balancer:least-used')).toBe(true)
    for (const builtin of ['single', 'priority-failover', 'round-robin']) {
      expect(isPluginSpaceCredentialPolicy(builtin)).toBe(false)
    }
    expect(isPluginSpaceCredentialPolicy('plugin:p:Bad Name')).toBe(false)
    expect(isPluginSpaceCredentialPolicy(undefined)).toBe(false)
  })

  it('规范化**放行**合法的插件策略 —— 批 D 时它会被压成 single,那样根本存不进去', () => {
    expect(normalizeSpaceCredentialPolicy('plugin:balancer:least-used'))
      .toBe('plugin:balancer:least-used')
    expect(normalizeSpaceCredentialPolicy('priority-failover')).toBe('priority-failover')
    // 形状不认识的仍然退回最保守的那一条,而不是猜。
    expect(normalizeSpaceCredentialPolicy('whatever')).toBe('single')
    expect(normalizeSpaceCredentialPolicy(undefined)).toBe('single')
  })

  it('整池写能把插件策略落盘(不是被规范化掉)', async () => {
    upsertSpaceProviderApiKey('work', 'deepseek', { apiKey: 'sk-1' })
    setSpaceProviderCredentialPool('work', 'deepseek', {
      entryIds: getSpaceProviderCredentials('work', 'deepseek')!.entries.map(e => e.id),
      policy: 'plugin:balancer:least-used',
    })
    resetSpaceCredentialsCacheForTests()
    expect(getSpaceProviderCredentials('work', 'deepseek')?.policy)
      .toBe('plugin:balancer:least-used')
  })

  it('宿主没装裁决口 = 回落 priority-failover(不是错误,是默认答案)', () => {
    const selection = selectSpaceCredentialEntryDetailed(POOL, {
      spaceId: 'work', providerId: 'deepseek',
    })
    expect(selection.entry?.id).toBe('a')
    expect(selection.pluginPolicy).toEqual({
      policy: 'plugin:balancer:least-used', applied: false,
    })
  })

  it('裁决口给出候选集里的 id = 用它,并把上下文原样递过去', () => {
    const seen: unknown[] = []
    configureSpaceCredentialPluginStrategyHost({
      decide(input) { seen.push(input); return 'c' },
    })
    const selection = selectSpaceCredentialEntryDetailed(POOL, {
      spaceId: 'work', providerId: 'deepseek', now: 1_700_000_000_000,
    })
    expect(selection.entry?.id).toBe('c')
    expect(selection.pluginPolicy).toEqual({
      policy: 'plugin:balancer:least-used', applied: true,
    })
    expect(seen).toEqual([{
      policy: 'plugin:balancer:least-used',
      spaceId: 'work',
      providerId: 'deepseek',
      candidates: POOL.entries,
      now: 1_700_000_000_000,
    }])
  })

  it('裁决口给出不认识的 id = 回落,起流不受影响', () => {
    configureSpaceCredentialPluginStrategyHost({ decide: () => 'nope' })
    const selection = selectSpaceCredentialEntryDetailed(POOL, {
      spaceId: 'work', providerId: 'deepseek',
    })
    expect(selection.entry?.id).toBe('a')
    expect(selection.pluginPolicy?.applied).toBe(false)
  })

  it('裁决口给出**冷却中**的 id = 回落 —— 候选集里本来就没有它', () => {
    const now = Date.now()
    configureSpaceCredentialPluginStrategyHost({
      decide: input => {
        // 候选集必须是已剔冷却的那一份,否则策略就有了绕过冷却的口子。
        expect(input.candidates.map(entry => entry.id)).toEqual(['b', 'c'])
        return 'a'
      },
    })
    const selection = selectSpaceCredentialEntryDetailed({
      ...POOL,
      entries: [{ ...POOL.entries[0], cooldownUntil: now + 60_000 }, ...POOL.entries.slice(1)],
    }, { spaceId: 'work', providerId: 'deepseek', now })
    expect(selection.entry?.id).toBe('b')
    expect(selection.pluginPolicy?.applied).toBe(false)
  })

  it('全池冷却仍然先判 exhausted —— 策略压根不该被问到', () => {
    const now = Date.now()
    const decide = vi.fn(() => 'a')
    configureSpaceCredentialPluginStrategyHost({ decide })
    const selection = selectSpaceCredentialEntryDetailed({
      ...POOL,
      entries: POOL.entries.map(entry => ({ ...entry, cooldownUntil: now + 60_000 })),
    }, { spaceId: 'work', providerId: 'deepseek', now })
    expect(selection.entry).toBeUndefined()
    expect(selection.exhausted?.earliestRecoveryAt).toBe(now + 60_000)
    expect(decide).not.toHaveBeenCalled()
  })

  it('内置三策略一个字都不看裁决口(批 D 之前的行为一字未改)', () => {
    const decide = vi.fn(() => 'c')
    configureSpaceCredentialPluginStrategyHost({ decide })
    for (const policy of ['single', 'priority-failover', 'round-robin']) {
      expect(selectSpaceCredentialEntryDetailed({ ...POOL, policy }, {
        spaceId: 'work', providerId: 'deepseek', cursorKey: `k-${policy}`,
      }).entry?.id).toBe('a')
    }
    expect(decide).not.toHaveBeenCalled()
  })
})
