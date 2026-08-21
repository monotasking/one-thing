/**
 * 一次性迁移 —— `settings.ai` → 空间层(C1 凭证 + C2 整套 provider 设置)。
 *
 * 这条测试盯的是**不可逆的那几步**:备份在不在、旧字段清没清、标记写没写、
 * 失败时有没有留下半场、C1 版本已经跑过的机器上第二段能不能单独补跑。
 * 迁移只跑一次,跑坏了用户手上就没有第二次机会。
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  saved: [] as unknown[],
  storeRoot: '',
  spaces: [] as Array<{ id: string; name: string; createdAt: number }>,
}))

vi.mock('../../stores/settings.js', () => ({
  getPersistedSettings: () => mocks.settings,
  savePersistedSettings: (value: unknown) => {
    mocks.saved.push(value)
  },
}))

vi.mock('../../stores/paths.js', () => ({
  getStorePath: () => mocks.storeRoot,
  getSettingsPath: () => path.join(mocks.storeRoot, 'settings.json'),
}))

vi.mock('../registry.js', () => ({
  getProviderInfo: (id: string) => ({ id, name: id.toUpperCase() }),
}))

vi.mock('@onething/runtime/auth/host-ports', () => ({
  getAuthHostPorts: () => ({}),
}))

vi.mock('@onething/runtime/spaces/store', () => ({
  getSpacesStore: () => ({ list: () => mocks.spaces }),
}))

import {
  readSpaceCredentials,
  resetSpaceCredentialsCacheForTests,
} from '@onething/runtime/spaces/credentials'
import {
  readSpaceOverlay,
  resetSpaceOverlayCacheForTests,
} from '@onething/runtime/spaces/overlay'
import {
  readSpaceProviderSettings,
  resetSpaceProviderSettingsCacheForTests,
} from '@onething/runtime/spaces/provider-settings'
import { setRootDirForTests } from '@onething/runtime/spaces/persistence'
import {
  buildMigratedCredentialEntries,
  buildSpaceProviderSettings,
  migrateProviderConfigToDefaultSpace,
  stripMigratedOverlayFields,
  stripMigratedProviderFields,
} from '../space-config-migration.js'

let tmpDir: string
let previousStorePath: string | undefined

/**
 * 直接往 `space.json` 上写一份**旧形状**的 overlay。
 *
 * 不能用 `writeSpaceOverlay` —— C2 起它**已经不写** provider 那三格了(读得进、
 * 写不出,正是一次性迁移收尾的形状)。测的是「盘上留着旧数据的机器」,所以造
 * 数据也得按盘上的样子造。
 */
function writeLegacyOverlay(spaceId: string, overlay: Record<string, unknown>): void {
  const dir = path.join(tmpDir, 'workspaces', spaceId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'space.json'), JSON.stringify({ overlay }, null, 2), 'utf-8')
  resetSpaceOverlayCacheForTests()
}

function legacySettings(): Record<string, unknown> {
  return {
    ai: {
      provider: 'deepseek',
      temperature: 0.7,
      providers: {
        deepseek: {
          apiKey: 'sk-d',
          model: 'deepseek-chat',
          selectedModels: ['deepseek-chat', 'deepseek-reasoner'],
          enabled: true,
          // C2:逐模型覆盖也是 per-space 的了 —— 它必须跟着搬进 providers.json。
          contextLengthByModel: { 'deepseek-chat': 128000 },
          // 目录缓存留全局(抬进 ai.modelCatalog)。
          models: { 'deepseek-chat': { id: 'deepseek-chat' } },
          modelsLastFetched: 111,
        },
        kimi: {
          apiKey: 'sk-k',
          kimiApiMode: 'coding-plan',
          kimiRegion: 'intl',
          model: 'k2',
          selectedModels: [],
          enabled: false,
        },
        // 一把 key 都没有:不该在池里堆一条空壳。
        gemini: { apiKey: '', model: 'g', selectedModels: [], enabled: false },
      },
      customProviders: [
        { id: 'custom-x', name: 'X', apiType: 'openai', apiKey: 'sk-x', baseUrl: 'https://x/v1' },
      ],
    },
    theme: 'dark',
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-c2-migration-'))
  // 双保险:模块级的 `getOnethingStorePath()`(不经宿主端口)也必须落在临时目录
  // 里。2026-08-18 实测教训 —— 少了这一行,迁移的 token 清空那一步会打在真实的
  // `~/.onething/oauth-tokens.json` 上,把用户的登录态一次性抹掉。
  previousStorePath = process.env.ONETHING_STORE_PATH
  process.env.ONETHING_STORE_PATH = tmpDir
  mocks.storeRoot = tmpDir
  mocks.saved = []
  mocks.settings = legacySettings()
  mocks.spaces = [{ id: 'default', name: '默认空间', createdAt: 1 }]
  setRootDirForTests(path.join(tmpDir, 'workspaces'))
  resetSpaceCredentialsCacheForTests()
  resetSpaceOverlayCacheForTests()
  resetSpaceProviderSettingsCacheForTests()
  fs.writeFileSync(
    path.join(tmpDir, 'settings.json'),
    JSON.stringify(mocks.settings, null, 2),
    'utf-8',
  )
})

afterEach(() => {
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  setRootDirForTests(null)
  resetSpaceCredentialsCacheForTests()
  resetSpaceOverlayCacheForTests()
  resetSpaceProviderSettingsCacheForTests()
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('凭证搬运(C1 那一段)', () => {
  it('apiKey / baseUrl / 档位 → default 池的一条 entry', async () => {
    const report = await migrateProviderConfigToDefaultSpace()
    expect(report.migrated).toBe(true)
    const pool = readSpaceCredentials('default')
    expect(pool.providers.deepseek.entries[0]).toMatchObject({
      authType: 'apiKey',
      apiKey: 'sk-d',
      source: 'user',
    })
    expect(pool.providers.kimi.entries[0]).toMatchObject({
      apiKey: 'sk-k',
      apiMode: 'coding-plan',
      region: 'intl',
    })
    // 自定义 provider 的凭证也进池 —— 定义归空间,钥匙归池。
    expect(pool.providers['custom-x'].entries[0]).toMatchObject({
      apiKey: 'sk-x',
      baseUrl: 'https://x/v1',
    })
  })

  it('空 key 且无 baseUrl 的不建 entry —— 池里不堆空壳', () => {
    const built = buildMigratedCredentialEntries(
      { gemini: { apiKey: '', model: 'g', selectedModels: [] } } as never,
      { providers: {} },
    )
    expect(built.migrated).toEqual([])
    expect(built.file.providers.gemini).toBeUndefined()
  })

  it('已有 entry 的 provider 不动 —— 重跑安全,不覆盖用户后来配的钥匙', () => {
    const built = buildMigratedCredentialEntries(
      { deepseek: { apiKey: 'sk-old', model: 'm', selectedModels: [] } } as never,
      {
        providers: {
          deepseek: {
            entries: [{ id: 'e1', label: 'l', authType: 'apiKey', apiKey: 'sk-new', source: 'user' }],
            policy: 'single',
          },
        },
      },
    )
    expect(built.migrated).toEqual([])
    expect(built.file.providers.deepseek.entries[0].apiKey).toBe('sk-new')
  })
})

describe('整体搬(C2)', () => {
  it('settings.ai 整份 → default 空间的 providers.json(去钥匙、去目录缓存)', async () => {
    const report = await migrateProviderConfigToDefaultSpace()
    expect(report.providerSettings).toEqual(['default'])

    const ai = readSpaceProviderSettings('default')
    expect(ai?.provider).toBe('deepseek')
    expect(ai?.providers.deepseek).toMatchObject({
      model: 'deepseek-chat',
      selectedModels: ['deepseek-chat', 'deepseek-reasoner'],
      enabled: true,
      // 逐模型覆盖跟着走 —— C2 起它也是 per-space 的。
      contextLengthByModel: { 'deepseek-chat': 128000 },
    })
    // 钥匙与目录缓存不进这份文件。
    expect(ai?.providers.deepseek.apiKey).toBeUndefined()
    expect(ai?.providers.deepseek.models).toBeUndefined()
    expect(ai?.providers.deepseek.modelsLastFetched).toBeUndefined()
    // 表达成空 ≠ 缺席:kimi 的空数组要活下来。
    expect(ai?.providers.kimi.selectedModels).toEqual([])
    expect(ai?.providers.kimi.enabled).toBe(false)
    // 自定义 provider 的**定义**也是 per-space 的,钥匙不在。
    expect(ai?.customProviders[0]).toMatchObject({ id: 'custom-x', name: 'X' })
    expect(ai?.customProviders[0].apiKey).toBeUndefined()
  })

  it('目录缓存抬进全局 ai.modelCatalog,`ai` 上三个键整删', async () => {
    const report = await migrateProviderConfigToDefaultSpace()
    expect(report.modelCatalog).toBe(1)
    const ai = mocks.settings.ai as Record<string, unknown>
    expect(ai.provider).toBeUndefined()
    expect(ai.providers).toBeUndefined()
    expect(ai.customProviders).toBeUndefined()
    expect(ai.temperature).toBe(0.7)
    expect(ai.modelCatalog).toEqual({
      deepseek: { models: { 'deepseek-chat': { id: 'deepseek-chat' } }, modelsLastFetched: 111 },
    })
  })

  it('overlay 那三格(B7/B9)并进 providers.json,并从 overlay 上清掉', async () => {
    // C1 版本跑过的机器:偏好住在 overlay 里,且比 settings 那份更具体。
    writeLegacyOverlay('default', {
      connectedDirectories: ['/tmp/keep'],
      providerEnabled: { kimi: true },
      selectedModels: { kimi: ['k2', 'k2-turbo'] },
      defaultSelection: { provider: 'kimi', model: 'k2-turbo' },
    })
    resetSpaceProviderSettingsCacheForTests()

    await migrateProviderConfigToDefaultSpace()

    const ai = readSpaceProviderSettings('default')
    expect(ai?.provider).toBe('kimi')
    expect(ai?.providers.kimi).toMatchObject({
      enabled: true,
      selectedModels: ['k2', 'k2-turbo'],
      model: 'k2-turbo',
    })

    const overlay = readSpaceOverlay('default')
    expect(overlay.connectedDirectories).toEqual(['/tmp/keep'])
    expect(overlay.providerEnabled).toBeUndefined()
    expect(overlay.selectedModels).toBeUndefined()
    expect(overlay.defaultSelection).toBeUndefined()
  })

  it('每个已登记的空间都拿到一份 —— 搬完之后各空间看见的与搬之前一样', async () => {
    mocks.spaces = [
      { id: 'default', name: '默认空间', createdAt: 1 },
      { id: 'work', name: '空间 2', createdAt: 2 },
    ]
    writeLegacyOverlay('work', { providerEnabled: { deepseek: false } })
    resetSpaceProviderSettingsCacheForTests()

    const report = await migrateProviderConfigToDefaultSpace()
    expect(report.providerSettings.sort()).toEqual(['default', 'work'])

    const work = readSpaceProviderSettings('work')
    // 全局那份作底(C2 之前非 default 空间除了三格以外全部回落全局)。
    expect(work?.providers.deepseek.model).toBe('deepseek-chat')
    // 这个空间自己表达过的那一格盖在上面。
    expect(work?.providers.deepseek.enabled).toBe(false)
  })

  it('buildSpaceProviderSettings:overlay 盖在 settings 之上', () => {
    const built = buildSpaceProviderSettings(
      {
        provider: 'zhipu',
        providers: { zhipu: { model: 'glm-5', enabled: true }, deepseek: { model: 'deepseek-chat' } },
      } as never,
      { providerEnabled: { zhipu: false }, defaultSelection: { provider: 'deepseek' } },
    )
    expect(built.provider).toBe('deepseek')
    expect(built.providers.zhipu.enabled).toBe(false)
    expect(built.providers.zhipu.model).toBe('glm-5')
  })

  it('stripMigratedOverlayFields 只摘 provider 三格,接入目录留着', () => {
    expect(
      stripMigratedOverlayFields({
        connectedDirectories: ['/a'],
        providerEnabled: { a: true },
        selectedModels: { a: [] },
        defaultSelection: { provider: 'a' },
      }),
    ).toEqual({ connectedDirectories: ['/a'] })
  })
})

describe('二段迁移(C1 版本已经跑过的机器)', () => {
  it('第一格在、第二格不在 → 只跑第二段:不再动凭证池', async () => {
    // 模拟 C1 跑完的状态:标记在,池里已经有 entry,偏好在 overlay 里。
    mocks.settings.storage = { providerConfigMigratedAt: 1000 }
    const legacy = mocks.settings.ai as { providers: Record<string, Record<string, unknown>> }
    delete legacy.providers.deepseek.apiKey
    writeLegacyOverlay('default', { selectedModels: { deepseek: ['deepseek-chat'] } })
    resetSpaceProviderSettingsCacheForTests()

    const report = await migrateProviderConfigToDefaultSpace()
    expect(report.migrated).toBe(true)
    expect(report.secondStageOnly).toBe(true)
    // 凭证那一段整个跳过 —— 再搬一次只会在池里堆重复 entry。
    expect(report.credentials).toEqual([])
    expect(readSpaceCredentials('default').providers.deepseek).toBeUndefined()

    expect(readSpaceProviderSettings('default')?.providers.deepseek.selectedModels)
      .toEqual(['deepseek-chat'])
    const saved = mocks.saved.at(-1) as Record<string, Record<string, unknown>>
    // 第一格的时间戳原样保留(它记的是 C1 那次)。
    expect(saved.storage.providerConfigMigratedAt).toBe(1000)
    expect(saved.storage.spaceProviderSettingsMigratedAt).toBe(report.migratedAt)
  })

  it('providers.json 已在 = 不覆盖(搬运只补不覆盖,重跑安全)', async () => {
    await migrateProviderConfigToDefaultSpace()
    // 手动改一格,再把标记删掉逼它重跑。
    const before = readSpaceProviderSettings('default')
    expect(before?.provider).toBe('deepseek')
    delete (mocks.settings.storage as Record<string, unknown>).spaceProviderSettingsMigratedAt

    const second = await migrateProviderConfigToDefaultSpace()
    expect(second.providerSettings).toEqual([])
  })
})

describe('OAuth token 搬运', () => {
  it('oauth-tokens.json 里的 token → default 池的 oauth entry,原文件清空并留备份', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'oauth-tokens.json'),
      JSON.stringify({
        codex: JSON.stringify({ accessToken: 'at', expiresAt: 4_000_000_000_000, tokenType: 'Bearer' }),
      }),
      'utf-8',
    )
    const report = await migrateProviderConfigToDefaultSpace()
    expect(report.oauthTokens).toEqual(['codex'])
    const entry = readSpaceCredentials('default').providers.codex.entries[0]
    expect(entry).toMatchObject({ authType: 'oauth' })
    expect((entry.oauthToken as { accessToken: string }).accessToken).toBe('at')

    // 原文件清空(不是删除:清空是它本来就有的合法状态)。
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, 'oauth-tokens.json'), 'utf-8'))).toEqual({})
    expect(report.backups.oauthTokens).toBeTruthy()
    expect(fs.existsSync(report.backups.oauthTokens as string)).toBe(true)
  })
})

describe('备份 / 标记 / 清字段', () => {
  it('先备份 settings.json,再清旧字段,最后写标记', async () => {
    const report = await migrateProviderConfigToDefaultSpace()
    expect(report.backups.settings).toBeTruthy()
    const backup = JSON.parse(fs.readFileSync(report.backups.settings as string, 'utf-8'))
    // 备份里旧字段原封不动 —— 回滚就靠它。
    expect(backup.ai.providers.deepseek.apiKey).toBe('sk-d')
    expect(backup.ai.provider).toBe('deepseek')

    const saved = mocks.saved.at(-1) as Record<string, Record<string, unknown>>
    expect(saved.storage.spaceProviderSettingsMigratedAt).toBe(report.migratedAt)
  })

  it('标记在 = 幂等跳过(不再备份、不再改动)', async () => {
    await migrateProviderConfigToDefaultSpace()
    const backupsBefore = fs.readdirSync(path.join(tmpDir, 'backups')).length
    mocks.saved = []

    const second = await migrateProviderConfigToDefaultSpace()
    expect(second.migrated).toBe(false)
    expect(mocks.saved).toEqual([])
    expect(fs.readdirSync(path.join(tmpDir, 'backups')).length).toBe(backupsBefore)
  })

  it('中途失败 → 不写标记、不清字段(下次启动重跑)', async () => {
    // 让凭证落盘那一步真的失败:把 workspaces 根做成一个**文件**,`mkdir` 必炸。
    // ESM 下 `vi.spyOn(fs, 'writeFileSync')` 不可用(命名空间不可配置),而用
    // 真实的失败比造一个假的更接近「盘满了」那一刻。
    const wsRoot = path.join(tmpDir, 'blocked')
    fs.writeFileSync(wsRoot, 'not a directory', 'utf-8')
    setRootDirForTests(wsRoot)
    resetSpaceCredentialsCacheForTests()
    resetSpaceProviderSettingsCacheForTests()

    await expect(migrateProviderConfigToDefaultSpace()).rejects.toThrow()

    const ai = mocks.settings.ai as Record<string, Record<string, Record<string, unknown>>>
    expect(ai.providers.deepseek.apiKey).toBe('sk-d')
    expect((mocks.settings as Record<string, unknown>).storage).toBeUndefined()
    expect(mocks.saved).toEqual([])
  })
})

describe('stripMigratedProviderFields', () => {
  it('抬走目录缓存,整删三个键,其余一个不碰', () => {
    const settings = {
      ai: {
        provider: 'deepseek',
        temperature: 0.7,
        providers: {
          deepseek: { apiKey: 'k', model: 'm', models: { m: { id: 'm' } }, temperatureByModel: { m: 0.3 } },
        },
        customProviders: [{ id: 'custom-x' }],
      },
      theme: 'dark',
    }
    stripMigratedProviderFields(settings as never)
    expect(settings.ai).toEqual({
      temperature: 0.7,
      modelCatalog: { deepseek: { models: { m: { id: 'm' } } } },
    })
    expect(settings.theme).toBe('dark')
  })
})
