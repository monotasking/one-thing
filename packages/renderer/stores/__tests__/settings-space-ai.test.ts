// @vitest-environment happy-dom
/**
 * 设置 store 的**换源**(C2)—— `settings.ai` = 当前空间的 `providers.json`
 * + 全局目录缓存。
 *
 * 这一片钉三件事:
 *  1. 加载时用**这个窗口的**空间重新合成(后端回的是 default 空间那一份);
 *  2. 保存时拆两半 —— per-space 走 spaces 通道,全局那一半才发给 `saveSettings`;
 *  3. 切空间(或别的窗口写盘后重拉)`settings.ai` 跟着换,不留上一个空间的残影。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createDefaultSettings } from '@shared/defaults/settings'
import type { AppSettings, SpaceProviderSettings } from '@shared/ipc'

const SPACE_AI: Record<string, SpaceProviderSettings> = {
  default: {
    provider: 'deepseek',
    providers: {
      deepseek: { model: 'deepseek-chat', selectedModels: ['deepseek-chat'], enabled: true },
    } as never,
    customProviders: [],
  },
  work: {
    provider: 'custom-a',
    providers: { 'custom-a': { model: 'a-pro', selectedModels: ['a-pro'], enabled: true } } as never,
    customProviders: [{ id: 'custom-a', name: 'A 家', apiType: 'openai' } as never],
  },
}

function installLocalStorage() {
  const values = new Map<string, string>()
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, String(value)) }),
    removeItem: vi.fn((key: string) => { values.delete(key) }),
    clear: vi.fn(() => { values.clear() }),
  }
  vi.stubGlobal('localStorage', storage)
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage })
  return storage
}

/** 保存时递过去的**快照**。mock 记的是引用,而 store 保存完会就地改写它。 */
const savedGlobalPayloads: AppSettings[] = []

function installElectronAPI() {
  const globalSettings: AppSettings = {
    ...createDefaultSettings(),
    // 后端 `getSettings()` 回的是 **default 空间**合成出来的那一份。
    ai: {
      ...createDefaultSettings().ai,
      provider: 'deepseek',
      temperature: 0.5,
      modelCatalog: { deepseek: { modelsLastFetched: 7 } },
    },
    storage: { spaceProviderSettingsMigratedAt: 1000 },
  }
  const api = {
    getSettings: vi.fn().mockResolvedValue({ success: true, settings: globalSettings }),
    rpcInvoke: vi.fn(async (request: { domain: string; method: string }) => {
      if (request.domain === 'providers' && request.method === 'list') {
        return { ok: true, data: { success: true, providers: [] } }
      }
      if (request.domain === 'models' && request.method === 'getNameAliases') {
        return { ok: true, data: { success: true, aliases: {} } }
      }
      return { ok: false, error: { message: `unstubbed RPC ${request.domain}.${request.method}` } }
    }),
    saveSettings: vi.fn().mockImplementation((s: AppSettings) => {
      savedGlobalPayloads.push(JSON.parse(JSON.stringify(s)) as AppSettings)
      return Promise.resolve({ success: true, settings: s })
    }),
    getSystemTheme: vi.fn().mockResolvedValue({ success: true, theme: 'dark' }),
    onSystemThemeChanged: vi.fn(),
    onSpacesChanged: vi.fn(() => () => {}),
    applyTheme: vi.fn().mockResolvedValue({ success: true, cssVariables: {} }),
    spacesList: vi.fn().mockResolvedValue({
      success: true,
      spaces: [
        { id: 'default', name: '默认空间', createdAt: 0 },
        { id: 'work', name: '工作', createdAt: 1 },
      ],
    }),
    spacesGetCredentials: vi.fn().mockResolvedValue({ success: true, credentials: { providers: {} } }),
    spacesGetProviderSettings: vi.fn(async (id: string) => ({
      success: true,
      ai: JSON.parse(JSON.stringify(SPACE_AI[id] ?? { provider: '', providers: {}, customProviders: [] })),
    })),
    spacesSetProviderSettings: vi.fn(async (request: { id: string; ai: SpaceProviderSettings }) => ({
      success: true,
      ai: request.ai,
    })),
  }
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: api })
  return api
}

async function loadStores() {
  const settings = await import('../settings')
  const spaces = await import('../spaces')
  return { useSettingsStore: settings.useSettingsStore, useSpacesStore: spaces.useSpacesStore }
}

describe('settings store —— per-space provider 设置的换源(C2)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    savedGlobalPayloads.length = 0
    setActivePinia(createPinia())
  })

  it('加载时用当前空间重新合成:default 空间读到自己那一份 + 全局目录缓存', async () => {
    installLocalStorage()
    installElectronAPI()
    const { useSettingsStore } = await loadStores()
    const store = useSettingsStore()
    await store.loadSettings()

    expect(store.settings.ai.provider).toBe('deepseek')
    expect(store.settings.ai.providers.deepseek.selectedModels).toEqual(['deepseek-chat'])
    // 目录缓存全空间共享 —— 合成时叠回每个 provider 上。
    expect(store.settings.ai.providers.deepseek.modelsLastFetched).toBe(7)
    // 别的空间的自定义 provider 不在这里。
    expect(store.settings.ai.customProviders).toEqual([])
  })

  it('切空间 → `settings.ai` 整份换掉,不留上一个空间的残影', async () => {
    installLocalStorage()
    installElectronAPI()
    const { useSettingsStore, useSpacesStore } = await loadStores()
    const store = useSettingsStore()
    await store.loadSettings()
    expect(store.settings.ai.provider).toBe('deepseek')

    const spaces = useSpacesStore()
    await spaces.load()
    spaces.switchTo('work')
    for (let i = 0; i < 12; i += 1) await Promise.resolve()

    expect(store.settings.ai.provider).toBe('custom-a')
    expect(store.settings.ai.customProviders).toEqual([
      { id: 'custom-a', name: 'A 家', apiType: 'openai' },
    ])
    expect(store.settings.ai.providers.deepseek?.enabled).toBe(false)
  })

  it('保存时拆两半:per-space 走 spaces 通道,发给 saveSettings 的只剩全局那一半', async () => {
    installLocalStorage()
    const api = installElectronAPI()
    const { useSettingsStore } = await loadStores()
    const store = useSettingsStore()
    await store.loadSettings()

    const next = JSON.parse(JSON.stringify(store.settings)) as AppSettings
    next.ai.providers.deepseek.selectedModels = ['deepseek-chat', 'deepseek-reasoner']
    await store.saveSettings(next)

    const spacePayload = api.spacesSetProviderSettings.mock.calls.at(-1)![0]
    expect(spacePayload.id).toBe('default')
    expect(spacePayload.ai.providers.deepseek.selectedModels)
      .toEqual(['deepseek-chat', 'deepseek-reasoner'])

    // 用快照断言:store 保存完会把返回的那份接回 `settings.value` 再重新合成,
    // 直接看 mock 记的引用会看见**合成之后**的样子。
    const globalPayload = savedGlobalPayloads.at(-1)!
    // 后端只收全局那一半 —— `ai.providers` 缺席 = 「这次不表达 per-space」。
    expect(globalPayload.ai.providers).toBeUndefined()
    expect(globalPayload.ai.provider).toBeUndefined()
    expect(globalPayload.ai.modelCatalog.deepseek.modelsLastFetched).toBe(7)
  })
})
