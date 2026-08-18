// @vitest-environment happy-dom
/**
 * 设置页两个「改默认 / 改开关」入口的**落点**(批 B9)。
 *
 * 用户 08-17 的两条裁决:「不同的空间,它的默认模型以及这个模型列表都是要不一样的」
 * 与「Provider 的开关也要是独立的」。所以:
 *
 *  - 模型总账的 ★(`useModelLedger.setDefault`)
 *  - provider 卡上的启用开关(`useProviderSettings.setProvidersEnabled`)
 *
 * **C1 起两条路合一**:所有空间(含 default)都写自己的文件;C2 起那份文件是
 * `workspaces/<id>/providers.json`(整套 provider 设置)。
 * 批 B9 时 default 走的是另一条(一次 settings 写),而那正是「默认模型不独立 /
 * 开关不独立」的病根 —— 两套形状,每个消费者都要分一次支。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AppSettings, ProviderInfo } from '@/types'
import { useSpacesStore } from '@/stores/spaces'
import { useSpaceProvidersStore } from '@/stores/spaceProviders'
import { useModelLedger } from '../useModelLedger'
import { useProviderSettings } from '../useProviderSettings'

const memory = vi.hoisted(() => {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
      clear: () => { store.clear() },
    },
  })
  return store
})

const mocks = vi.hoisted(() => ({
  platform: {
    spacesList: vi.fn(),
    spacesGetCredentials: vi.fn(),
    spacesGetOverlay: vi.fn(),
    spacesSetOverlay: vi.fn(),
    spacesGetProviderSettings: vi.fn(),
    spacesSetProviderSettings: vi.fn(),
    onSpacesChanged: vi.fn(() => () => {}),
    getProviderEnvStatus: vi.fn(async () => ({ success: true })),
  },
  cachedModels: {} as Record<string, unknown[]>,
}))

vi.mock('@/platform', () => ({ platformApi: mocks.platform }))
vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({
    getCachedModels: (providerId: string) => mocks.cachedModels[providerId] ?? [],
    getModelDisplayName: (modelId: string) => modelId,
    preloadModels: vi.fn(async () => {}),
    addCustomModelToCache: vi.fn(),
    isCustomProvider: () => false,
    fetchModelsForProvider: vi.fn(async () => {}),
    settings: null,
  }),
}))

const providers = [
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'zhipu', name: 'Zhipu' },
] as unknown as ProviderInfo[]

function settings(): AppSettings {
  return {
    ai: {
      provider: 'deepseek',
      temperature: 0.7,
      providers: {
        deepseek: {
          enabled: true,
          apiKey: 'sk-1',
          baseUrl: '',
          selectedModels: ['deepseek-chat', 'deepseek-reasoner'],
          model: 'deepseek-chat',
        },
        zhipu: {
          enabled: true,
          apiKey: 'zp-1',
          baseUrl: '',
          selectedModels: ['glm-5'],
          model: 'glm-5',
        },
      },
      customProviders: [],
    },
  } as unknown as AppSettings
}

const SPACES = [
  { id: 'default', name: '默认空间', createdAt: 0 },
  { id: 'work', name: '工作', createdAt: 1 },
]

/** 当前空间的整套 provider 设置(C2)。逐个用例可改(在 beforeEach 之后)。 */
let SPACE_AI: Record<string, unknown> = {}

/** 写入是「先读后并」两跳 IPC —— 一个微任务不够。 */
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

async function enterDefaultSpace() {
  const spaces = useSpacesStore()
  await spaces.load()
  await useSpaceProvidersStore().refresh()
}

async function enterWorkSpace() {
  const spaces = useSpacesStore()
  await spaces.load()
  spaces.switchTo('work')
  await useSpaceProvidersStore().refresh()
}

beforeEach(async () => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  memory.clear()
  SPACE_AI = {
    provider: '',
    providers: {
      deepseek: { selectedModels: ['deepseek-chat', 'deepseek-reasoner'] },
      zhipu: { selectedModels: ['glm-5'] },
    },
    customProviders: [],
  }
  mocks.cachedModels = {}
  mocks.platform.spacesList.mockResolvedValue({ success: true, spaces: SPACES })
  mocks.platform.spacesGetCredentials.mockResolvedValue({
    success: true,
    credentials: {
      providers: {
        deepseek: {
          policy: 'single',
          entries: [{ id: 'e1', label: 'k', authType: 'apiKey', hasApiKey: true, source: 'user' }],
        },
      },
    },
  })
  mocks.platform.spacesGetOverlay.mockImplementation(async () => ({ success: true, overlay: {} }))
  mocks.platform.spacesSetOverlay.mockImplementation(async (request: { overlay: unknown }) =>
    ({ success: true, overlay: request.overlay }))
  mocks.platform.spacesGetProviderSettings.mockImplementation(async () =>
    ({ success: true, ai: JSON.parse(JSON.stringify(SPACE_AI)) }))
  mocks.platform.spacesSetProviderSettings.mockImplementation(async (request: { ai: unknown }) =>
    ({ success: true, ai: request.ai }))
})

describe('模型总账的 ★(useModelLedger.setDefault,批 B9)', () => {
  it('C1:default 空间也写自己的 providers.json,settings 一个字节都不动', async () => {
    await enterDefaultSpace()
    const updates: AppSettings[] = []
    const ledger = useModelLedger({ settings: settings(), providers }, (_e, value) => updates.push(value))

    ledger.setDefault(ledger.rows.value.find(row => row.modelId === 'glm-5')!)
    await flush()

    expect(updates).toEqual([])
    const payload = mocks.platform.spacesSetProviderSettings.mock.calls[0][0] as {
      id: string
      ai: { provider: string; providers: Record<string, { model?: string }> }
    }
    expect(payload.id).toBe('default')
    expect(payload.ai.provider).toBe('zhipu')
    expect(payload.ai.providers.zhipu.model).toBe('glm-5')
  })

  it('非 default 空间:写 providers.json,settings 一个字节都不动', async () => {
    await enterWorkSpace()
    const updates: AppSettings[] = []
    const ledger = useModelLedger({ settings: settings(), providers }, (_e, value) => updates.push(value))

    ledger.setDefault(ledger.rows.value.find(row => row.modelId === 'deepseek-reasoner')!)
    await flush()

    expect(updates).toEqual([])
    const payload = mocks.platform.spacesSetProviderSettings.mock.calls[0][0] as {
      id: string
      ai: { provider: string; providers: Record<string, { model?: string }> }
    }
    expect(payload.id).toBe('work')
    expect(payload.ai.provider).toBe('deepseek')
    expect(payload.ai.providers.deepseek.model).toBe('deepseek-reasoner')
  })

  it('★ 打在**当前空间的**默认那一行', async () => {
    SPACE_AI = {
      provider: 'deepseek',
      providers: {
        deepseek: { model: 'deepseek-reasoner', selectedModels: ['deepseek-chat', 'deepseek-reasoner'] },
      },
      customProviders: [],
    }
    await enterWorkSpace()
    const ledger = useModelLedger({ settings: settings(), providers }, () => {})

    expect(ledger.rows.value.filter(row => row.isDefault).map(row => row.key))
      .toEqual(['deepseek::deepseek-reasoner'])
  })

  it('空间里关掉的 provider 不进总账(开关也 per-space)', async () => {
    SPACE_AI = {
      provider: '',
      providers: {
        deepseek: { selectedModels: ['deepseek-chat'] },
        zhipu: { selectedModels: ['glm-5'], enabled: false },
      },
      customProviders: [],
    }
    await enterWorkSpace()
    const ledger = useModelLedger({ settings: settings(), providers }, () => {})

    expect(ledger.rows.value.map(row => row.providerId)).toEqual(['deepseek'])
  })
})

describe('provider 卡上的启用开关(useProviderSettings.setProvidersEnabled,批 B9)', () => {
  it('C1:default 空间的开关也写它自己的 providers.json', async () => {
    await enterDefaultSpace()
    const updates: AppSettings[] = []
    const ps = useProviderSettings({ settings: settings(), providers }, (_e, value) => updates.push(value))

    ps.setProvidersEnabled(['zhipu'], false)
    await flush()

    expect(updates).toEqual([])
    const payload = mocks.platform.spacesSetProviderSettings.mock.calls[0][0] as {
      id: string
      ai: { providers: Record<string, { enabled?: boolean }> }
    }
    expect(payload.id).toBe('default')
    expect(payload.ai.providers.zhipu.enabled).toBe(false)
  })

  it('非 default 空间:写 providers.json 的 enabled,全局那份一动不动', async () => {
    await enterWorkSpace()
    const updates: AppSettings[] = []
    const ps = useProviderSettings({ settings: settings(), providers }, (_e, value) => updates.push(value))

    ps.setProvidersEnabled(['zhipu'], false)
    await flush()

    expect(updates).toEqual([])
    const payload = mocks.platform.spacesSetProviderSettings.mock.calls[0][0] as {
      id: string
      ai: { providers: Record<string, { enabled?: boolean; selectedModels?: string[] }> }
    }
    expect(payload.id).toBe('work')
    expect(payload.ai.providers.zhipu.enabled).toBe(false)
    // 先读后并:同一条记录里别的格没被这次写抹掉。
    expect(payload.ai.providers.zhipu.selectedModels).toEqual(['glm-5'])
  })

  it('家族卡一次写两个成员(顺序写会互相覆盖 —— 这条规矩在空间层也成立)', async () => {
    await enterWorkSpace()
    const ps = useProviderSettings({ settings: settings(), providers }, () => {})

    ps.setProvidersEnabled(['kimi', 'kimi-code'], false)
    await flush()

    const payload = mocks.platform.spacesSetProviderSettings.mock.calls[0][0] as {
      id: string
      ai: { providers: Record<string, { enabled?: boolean }> }
    }
    expect(payload.id).toBe('work')
    expect(payload.ai.providers.kimi.enabled).toBe(false)
    expect(payload.ai.providers['kimi-code'].enabled).toBe(false)
  })

  it('读也按空间:空间里关掉之后 isProviderEnabled 为假,default 空间不受影响', async () => {
    SPACE_AI = {
      provider: '',
      providers: { zhipu: { enabled: false }, deepseek: {} },
      customProviders: [],
    }
    await enterWorkSpace()
    const ps = useProviderSettings({ settings: settings(), providers }, () => {})

    expect(ps.isProviderEnabled('zhipu')).toBe(false)
    expect(ps.isProviderEnabled('deepseek')).toBe(true)
  })
})
