import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderInfo, SpaceProviderSettings } from '@shared/ipc/providers'
import type { AppSettings } from '@shared/ipc/settings'
import type { SpaceRecord } from '@shared/ipc/spaces'
import { configureProviderSettingsPort } from '../../data/provider-settings-port'
import type { ProviderSettingsPort } from '../../data/provider-settings-port'
import { configureSpacesPort } from '../../data/spaces-port'
import { useWorkspaceStore } from '../../workspace/store'
import { DEFAULT_SPACE_ID } from '../../workspace/types'
import { useProviderSettings } from '../store'
import {
  composeSpaceSettings,
  resolveSpaceProviderSettings,
  splitSpaceProviderSettings,
} from '../space-settings'
import { resolveModelSelection } from '../../data/models-source'
import { providerModelPrefs } from '../../data/__fixtures__/models'
import { fakeProviderPort } from './fake-port'

/**
 * 「模型服务面跟着工作区走」的判据(09-01「真切换」批)。
 *
 * 这一组守的是**六条口打在哪个空间上**,以及切换那一刻屏幕上不许剩下什么。
 * 为什么是硬要求而不是锦上添花:引擎起流读的是**会话归属那个空间**的凭证与
 * provider 设置(`resolveSessionProviderCredential` / `getSessionSettings`),
 * 设置页写偏一格 = 用户看到「配好了」、引擎看到「什么都没有」。
 */

const DEFAULT: SpaceRecord = { id: DEFAULT_SPACE_ID, name: '默认', createdAt: 0 }
const WORK: SpaceRecord = { id: 'ws-work', name: '工作', createdAt: 100 }

const ROSTER: ProviderInfo[] = [
  {
    id: 'claude',
    name: 'Claude',
    description: '',
    defaultBaseUrl: '',
    defaultModel: 'm',
    icon: 'claude',
    supportsCustomBaseUrl: true,
    requiresApiKey: true,
  },
]

/**
 * 全局那一半:只剩全空间共享的两格,外加**迁移标记** —— 这一组演的是「已经
 * 迁移过的机器」,provider 那一半的真相在各空间自己的文件里(未迁移那条路
 * 由 `space-settings` 的用例点名测)。
 */
function globalSettings(): AppSettings {
  return {
    ai: { temperature: 0.7, modelCatalog: {} },
    storage: { spaceProviderSettingsMigratedAt: 1 },
  } as unknown as AppSettings
}

/** 两个空间各一套 provider 设置 —— 这正是「两套完整独立的设置」那句话的样子。 */
const SPACE_AI: Record<string, SpaceProviderSettings> = {
  [DEFAULT_SPACE_ID]: {
    provider: 'claude',
    providers: { claude: { model: 'claude-opus-5', selectedModels: ['claude-opus-5'] } },
    customProviders: [],
  } as unknown as SpaceProviderSettings,
  'ws-work': {
    provider: 'claude',
    providers: { claude: { model: 'claude-haiku-4-5', selectedModels: ['claude-haiku-4-5'] } },
    customProviders: [],
  } as unknown as SpaceProviderSettings,
}

/** 两个空间各一把钥匙,尾号不同 —— 「串没串空间」一眼就看得出来。 */
const PREVIEW: Record<string, string> = { [DEFAULT_SPACE_ID]: '…aaaa', 'ws-work': '…bbbb' }

function credentialsOf(spaceId: string) {
  return {
    success: true as const,
    credentials: {
      providers: {
        claude: {
          policy: 'single',
          entries: [
            {
              id: 'e0',
              label: '',
              authType: 'apiKey' as const,
              hasApiKey: true,
              apiKeyPreview: PREVIEW[spaceId] ?? '…????',
              source: 'manual',
            },
          ],
        },
      },
    },
  }
}

function installPort(overrides: Partial<ProviderSettingsPort> = {}): ProviderSettingsPort {
  const port = fakeProviderPort({
    listProviders: vi.fn(async () => ({ success: true, providers: ROSTER })),
    listModels: vi.fn(async () => ({ success: true, models: [] })),
    readSettings: vi.fn(async () => ({ success: true, settings: globalSettings() })),
    readProviderSettings: vi.fn(async (spaceId: string) => ({
      success: true,
      ai: SPACE_AI[spaceId] ?? { provider: '', providers: {}, customProviders: [] },
    })),
    writeProviderSettings: vi.fn(async (request) => ({ success: true, ai: request.ai })),
    readCredentials: vi.fn(async (spaceId: string) => credentialsOf(spaceId)),
    ...overrides,
  })
  configureProviderSettingsPort(port)
  return port
}

async function loadSpaces(): Promise<void> {
  configureSpacesPort({
    ready: async () => undefined,
    list: vi.fn(async () => ({ success: true, spaces: [DEFAULT, WORK] })),
    create: vi.fn(async () => ({ success: false, error: 'not stubbed' })),
    update: vi.fn(async () => ({ success: true })),
    remove: vi.fn(async () => ({ success: true, removed: true })),
  })
  await useWorkspaceStore.getState().load()
}

/** 切一次并等那一发异步重拉落地。 */
async function switchTo(id: string): Promise<void> {
  useWorkspaceStore.getState().switchTo(id)
  await vi.waitFor(() =>
    expect(useProviderSettings.getState().settings?.ai.providers).toBeTruthy(),
  )
}

beforeEach(() => {
  useProviderSettings.getState().reset()
  useWorkspaceStore.getState().reset()
})

afterEach(() => {
  useProviderSettings.getState().reset()
  useWorkspaceStore.getState().reset()
})

describe('取数打在当前空间上', () => {
  it('开面读的是当前空间那一份(凭证 + provider 设置各一发,同一个 id)', async () => {
    await loadSpaces()
    useWorkspaceStore.getState().switchTo('ws-work')
    const port = installPort()
    await useProviderSettings.getState().start()

    expect(port.readCredentials).toHaveBeenCalledWith('ws-work')
    expect(port.readProviderSettings).toHaveBeenCalledWith('ws-work')
    const st = useProviderSettings.getState()
    expect(st.credentials.claude.entries[0].apiKeyPreview).toBe('…bbbb')
    expect(st.settings?.ai.providers.claude.model).toBe('claude-haiku-4-5')
  })

  it('切过去 = 换一整套:钥匙尾号与模型勾选一起换', async () => {
    await loadSpaces()
    const port = installPort()
    await useProviderSettings.getState().start()
    expect(useProviderSettings.getState().credentials.claude.entries[0].apiKeyPreview).toBe('…aaaa')
    expect(useProviderSettings.getState().settings?.ai.providers.claude.model).toBe('claude-opus-5')

    await switchTo('ws-work')
    expect(useProviderSettings.getState().credentials.claude.entries[0].apiKeyPreview).toBe('…bbbb')
    expect(useProviderSettings.getState().settings?.ai.providers.claude.model).toBe('claude-haiku-4-5')
    expect(port.readCredentials).toHaveBeenCalledWith('ws-work')
  })

  it('**名册与模型目录不重拉** —— 它们是机器级的事实,不跟空间走', async () => {
    await loadSpaces()
    const port = installPort()
    await useProviderSettings.getState().start()
    expect(port.listProviders).toHaveBeenCalledTimes(1)

    await switchTo('ws-work')
    expect(port.listProviders).toHaveBeenCalledTimes(1)
  })

  it('切换当场把上一个空间的凭证清掉 —— 别人的密钥尾号一帧都不许留在屏上', async () => {
    await loadSpaces()
    installPort()
    await useProviderSettings.getState().start()
    expect(useProviderSettings.getState().credentialsKnown).toBe(true)

    // 同步那一刻(重拉还没落地)看到的必须是「不知道」,不是上一个空间的答案。
    useWorkspaceStore.getState().switchTo('ws-work')
    const mid = useProviderSettings.getState()
    expect(mid.credentials).toEqual({})
    expect(mid.credentialsKnown).toBe(false)
    expect(mid.settings).toBeUndefined()
  })

  it('订阅用量问的是当前空间', async () => {
    await loadSpaces()
    useWorkspaceStore.getState().switchTo('ws-work')
    const port = installPort()
    await useProviderSettings.getState().start()
    await useProviderSettings.getState().loadUsage('claude')
    expect(port.getProviderUsage).toHaveBeenCalledWith('claude', 'ws-work')
  })
})

describe('写口打在当前空间上', () => {
  it('模型勾选写的是当前空间那一份,不是 saveSettings', async () => {
    await loadSpaces()
    const port = installPort()
    await useProviderSettings.getState().start()
    await switchTo('ws-work')

    await useProviderSettings.getState().toggleModel('claude', 'claude-opus-5', true)
    expect(port.saveSettings).not.toHaveBeenCalled()
    const sent = vi.mocked(port.writeProviderSettings).mock.calls[0][0]
    expect(sent.id).toBe('ws-work')
    expect(sent.ai.providers.claude.selectedModels).toEqual(['claude-haiku-4-5', 'claude-opus-5'])
  })

  it('写密钥落在当前空间的池上', async () => {
    await loadSpaces()
    const port = installPort()
    await useProviderSettings.getState().start()
    await switchTo('ws-work')

    await useProviderSettings.getState().saveApiKey('claude', 'sk-work')
    expect(vi.mocked(port.setCredential).mock.calls[0][0].id).toBe('ws-work')
  })
})

/* ── 两条纯换算 ────────────────────────────────────────────────────────── */

describe('composeSpaceSettings / splitSpaceProviderSettings', () => {
  it('合:全空间共享的两格来自全局,provider 那三格来自空间', () => {
    const merged = composeSpaceSettings(globalSettings(), SPACE_AI['ws-work'])
    expect(merged?.ai.modelCatalog).toEqual({})
    expect(merged?.ai.temperature).toBe(0.7)
    expect(merged?.ai.providers.claude.model).toBe('claude-haiku-4-5')
  })

  it('合:空间那一份缺席 = provider 三格是空的(**不去看全局那一份**)', () => {
    const merged = composeSpaceSettings(globalSettings(), undefined)
    expect(merged?.ai.providers).toEqual({})
    expect(merged?.ai.provider).toBe('')
    expect(merged?.ai.customProviders).toEqual([])
  })

  it('合:全局缺席 = 整份缺席(这块面本来就该说「读不到」)', () => {
    expect(composeSpaceSettings(undefined, SPACE_AI['ws-work'])).toBeUndefined()
  })

  it('拆:空间没表达过温度就**还是没表达过** —— 不替用户按下一次「就用这个温度」', () => {
    const merged = composeSpaceSettings(globalSettings(), SPACE_AI['ws-work'])!
    // 合过的那份里 temperature 是 0.7(全局顶上的);原样写回去就把它钉进了空间。
    expect(merged.ai.temperature).toBe(0.7)
    expect(splitSpaceProviderSettings(merged, SPACE_AI['ws-work']).temperature).toBeUndefined()
  })

  it('拆:空间**表达过**温度就带回去', () => {
    const expressed = { ...SPACE_AI['ws-work'], temperature: 0.2 }
    const merged = composeSpaceSettings(globalSettings(), expressed)!
    expect(merged.ai.temperature).toBe(0.2)
    expect(splitSpaceProviderSettings(merged, expressed).temperature).toBe(0.2)
  })
})

/* ── 未迁移态的回落(09-01 报障 ①)────────────────────────────────────────── */

describe('resolveSpaceProviderSettings —— 未迁移的机器', () => {
  const GLOBAL_WITH_PROVIDERS = {
    ai: {
      temperature: 0.6,
      modelCatalog: {},
      provider: 'deepseek',
      providers: { deepseek: { model: 'demo-model', selectedModels: ['demo-model'] } },
      customProviders: [],
    },
  } as unknown as AppSettings

  /**
   * 真机读数(探针 `probe-unmigrated`,同一个未迁移 store 上问两口):
   *   settings.getSettings().ai.provider          = "deepseek"(15 家)
   *   spaces.getProviderSettings('default').provider = ""(0 家)
   * 屏幕从前读后者,于是药丸写「Pick a model」、抽屉一家都列不出来 ——
   * 而这台机器明明配好了。
   */
  it('没有迁移标记 = 盘上还没有 per-space 文件 → 全局那份就是此刻的真相', () => {
    const out = resolveSpaceProviderSettings(
      { provider: '', providers: {}, customProviders: [] } as unknown as SpaceProviderSettings,
      GLOBAL_WITH_PROVIDERS,
    )
    expect(out?.provider).toBe('deepseek')
    expect(Object.keys(out?.providers ?? {})).toEqual(['deepseek'])
  })

  it('**温度不带过来** —— 带了会在第一次写回时把全局温度钉死在这个空间上', () => {
    const out = resolveSpaceProviderSettings(
      { provider: '', providers: {}, customProviders: [] } as unknown as SpaceProviderSettings,
      GLOBAL_WITH_PROVIDERS,
    )
    expect(out?.temperature).toBeUndefined()
  })

  it('迁移标记在 = **无回落**:空间是空的就是空的,不去看全局', () => {
    const migrated = {
      ...GLOBAL_WITH_PROVIDERS,
      storage: { spaceProviderSettingsMigratedAt: 1 },
    } as unknown as AppSettings
    const empty = { provider: '', providers: {}, customProviders: [] } as unknown as SpaceProviderSettings
    const out = resolveSpaceProviderSettings(empty, migrated)
    expect(out).toBe(empty)
  })

  it('迁移标记在时,别的空间一格都不会被全局灌回来(严格隔离没被这条修法撬开)', () => {
    const migrated = {
      ...GLOBAL_WITH_PROVIDERS,
      storage: { spaceProviderSettingsMigratedAt: 1 },
    } as unknown as AppSettings
    const spaceB = {
      provider: 'zhipu',
      providers: { zhipu: { model: 'glm-5', selectedModels: ['glm-5'] } },
      customProviders: [],
    } as unknown as SpaceProviderSettings
    expect(resolveSpaceProviderSettings(spaceB, migrated)).toBe(spaceB)
  })
})

describe('模型药丸的回落链(报障 ① 的另一半:它本来就是对的)', () => {
  /*
   * 真机探针 `probe-chip` 四格读数,两种环境各两档会话:
   *   A 空环境:绑过模型 →「glm-5」 / 没绑过 →「Pick a model」
   *   B 有目录:绑过模型 →「glm-5」 / 没绑过 →「deepseek-chat」
   * 也就是说**回落链本身没坏**:绑过模型的会话,无论有没有目录都写得出模型名。
   * 报障里那两种表现的差别不在代码里,在**盘上有没有那份 provider 设置** ——
   * 而那正是上面那条未迁移回落修掉的东西。这一组把结论钉住,免得下次又去改链子。
   */
  it('会话绑过模型 → 写模型名;目录有没有都一样', () => {
    const session = { provider: 'zhipu', model: 'glm-5' }
    expect(resolveModelSelection({}, 's1', session, null, { defaultProvider: '', configs: {} })).toEqual({
      provider: 'zhipu',
      model: 'glm-5',
    })
  })

  it('会话没绑过 → 落到这个空间的默认;空间也没有 = null(药丸写「选择模型」,不编)', () => {
    const none = { provider: null, model: null }
    expect(resolveModelSelection({}, 's1', none, null, { defaultProvider: '', configs: {} })).toBeNull()
    expect(
      resolveModelSelection({}, 's1', none, null, {
        defaultProvider: 'deepseek',
        configs: { deepseek: providerModelPrefs({ model: 'demo-model' }) },
      }),
    ).toEqual({ provider: 'deepseek', model: 'demo-model' })
  })
})

describe('两个条件同时成立才回落(gate 第 10 步抓到的那个洞)', () => {
  const GLOBAL_UNMIGRATED = {
    ai: {
      temperature: 0.6,
      modelCatalog: {},
      provider: 'deepseek',
      providers: { deepseek: { model: 'demo-model', selectedModels: ['demo-model'] } },
      customProviders: [],
    },
  } as unknown as AppSettings

  it('没迁移过、但这个空间**已经有东西** → 以空间那份为准,不被全局盖掉', () => {
    /*
     * 这正是门里那种 store:种子走 `spaces.setProviderSettings` 写出了 per-space
     * 文件,却没有迁移标记(那个标记只有后端那次整体搬迁才会盖)。
     * 修法第一版只看标记,于是把 zhipu 换成了全局的 deepseek —— 第 10 步当场红。
     */
    const spaceB = {
      provider: 'zhipu',
      providers: { zhipu: { model: 'glm-5', selectedModels: ['glm-5'] } },
      customProviders: [],
    } as unknown as SpaceProviderSettings
    expect(resolveSpaceProviderSettings(spaceB, GLOBAL_UNMIGRATED)).toBe(spaceB)
  })

  it('没迁移过、空间也是空的 → 才回落到全局(报障 ① 那台机器)', () => {
    const empty = { provider: '', providers: {}, customProviders: [] } as unknown as SpaceProviderSettings
    expect(resolveSpaceProviderSettings(empty, GLOBAL_UNMIGRATED)?.provider).toBe('deepseek')
  })
})
