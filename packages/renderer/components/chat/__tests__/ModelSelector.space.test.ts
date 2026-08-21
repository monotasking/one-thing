// @vitest-environment happy-dom
/**
 * 模型选择器的**空间维度**(批 B7)。
 *
 * 用户要的是「切 workspace 的时候它就自动切换过去」:选择器只列**当前空间配好的**
 * provider,模型清单也按当前空间取。默认空间下这两条恒等于今天的行为(零回归)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, ref } from 'vue'
import ModelSelector from '../ModelSelector.vue'
import { useSpacesStore } from '@/stores/spaces'
import { useSpaceProvidersStore } from '@/stores/spaceProviders'

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
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: ResizeObserverStub,
  })
  return store
})

const mocks = vi.hoisted(() => ({
  platform: {
    list: vi.fn(),
    getCredentials: vi.fn(),
    getOverlay: vi.fn(),
    setOverlay: vi.fn(),
    getProviderSettings: vi.fn(),
    setProviderSettings: vi.fn(),
    onSpacesChanged: vi.fn(() => () => {}),
  },
  settingsStore: null as any,
}))

vi.mock('@/platform', () => ({ platformApi: mocks.platform }))
// spaces 域已迁到通用 RPC 通道(结构债 P0.3):组件/store 引的是壳外客户端,
// 不再是 platformApi 上的方法,所以打桩打这个模块(方法名与签名沿用旧的)。
vi.mock('@/platform/spaces-client', () => ({ spacesApi: mocks.platform }))
vi.mock('@/stores/settings', () => ({ useSettingsStore: () => mocks.settingsStore }))
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: () => ({ getSessionItem: () => null }),
}))
vi.mock('@/composables/useSessionAgentModel', () => ({
  useSessionAgentModel: () => ref(null),
}))

const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'zhipu', name: 'Zhipu' },
]

function settings() {
  return {
    ai: {
      provider: 'deepseek',
      providers: {
        deepseek: {
          enabled: true,
          apiKey: 'sk-global-1234567890',
          selectedModels: ['deepseek-chat', 'deepseek-reasoner'],
          model: 'deepseek-chat',
        },
        zhipu: {
          enabled: true,
          apiKey: 'zp-global-1234567890',
          selectedModels: ['glm-5'],
          model: 'glm-5',
        },
      },
    },
  }
}

/** 当前空间的整套 provider 设置(C2)。逐个用例可改(在 beforeEach 之后)。 */
let SPACE_AI: Record<string, unknown> = {}

/** default 空间的池(C1:迁移把 settings 里那两把 key 搬了进来)。 */
const DEFAULT_POOL = {
  providers: {
    deepseek: {
      policy: 'single',
      entries: [{ id: 'd1', label: 'DeepSeek', authType: 'apiKey', hasApiKey: true, source: 'user' }],
    },
    zhipu: {
      policy: 'single',
      entries: [{ id: 'z1', label: 'Zhipu', authType: 'apiKey', hasApiKey: true, source: 'user' }],
    },
  },
}

/** work 空间只给 deepseek 配了钥匙,zhipu 一把都没有。 */
const WORK_POOL = {
  providers: {
    deepseek: {
      policy: 'single',
      entries: [{
        id: 'e1',
        label: '工作 key',
        authType: 'apiKey',
        hasApiKey: true,
        apiKeyPreview: 'sk-wor••••4321',
        source: 'user',
      }],
    },
  },
}

function mountSelector() {
  return mount(ModelSelector, {
    props: { sessionId: undefined },
    global: {
      stubs: {
        ProviderIcon: { template: '<span />' },
        // 浮层几何不参演:直接把内容画出来,断言列表本身。
        Popover: { template: '<div><slot /></div>' },
        ComposerExtensionPanel: {
          template: '<div><slot name="subheader" /><slot /></div>',
        },
      },
    },
  })
}

function providerCells(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll('.provider-cell')
    .map(cell => cell.text())
    .filter(text => !text.startsWith('All'))
}

beforeEach(() => {
  SPACE_AI = {
    provider: '',
    providers: {
      deepseek: { selectedModels: ['deepseek-chat', 'deepseek-reasoner'] },
      zhipu: { selectedModels: ['glm-5'] },
    },
    customProviders: [],
  }
  setActivePinia(createPinia())
  vi.clearAllMocks()
  memory.clear()
  mocks.settingsStore = {
    settings: settings(),
    availableProviders: PROVIDERS,
    getCachedModels: () => [],
    getModelDisplayName: (id: string) => id,
    isCustomProvider: () => false,
    fetchModelsForProvider: vi.fn(async () => {}),
    saveAIProviderDefault: vi.fn(async () => {}),
  }
  mocks.platform.list.mockResolvedValue({
    success: true,
    spaces: [
      { id: 'default', name: '默认空间', createdAt: 0 },
      { id: 'work', name: '工作', createdAt: 1 },
    ],
  })
  mocks.platform.getCredentials.mockImplementation(async ({ id }: { id: string }) => ({
    success: true,
    credentials: id === 'work' ? WORK_POOL : id === 'default' ? DEFAULT_POOL : { providers: {} },
  }))
  mocks.platform.getOverlay.mockImplementation(async () => ({ success: true, overlay: {} }))
  mocks.platform.setOverlay.mockImplementation(async (request: any) =>
    ({ success: true, overlay: request.overlay }))
  mocks.platform.getProviderSettings.mockImplementation(async () =>
    ({ success: true, ai: JSON.parse(JSON.stringify(SPACE_AI)) }))
  mocks.platform.setProviderSettings.mockImplementation(async (request: any) =>
    ({ success: true, ai: request.ai }))
})

describe('ModelSelector —— 只列当前空间配好的 provider(批 B7)', () => {
  it('默认空间:两个 provider 都在(池里都有钥匙),模型来自这个空间的 providers.json', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    await useSpaceProvidersStore().refresh()

    const wrapper = mountSelector()
    await wrapper.find('.model-trigger').trigger('click')
    await nextTick()

    expect(providerCells(wrapper)).toEqual(['DeepSeek2', 'Zhipu1'])
    const models = wrapper.findAll('.model-row .model-name').map(n => n.text())
    expect(models).toEqual(['deepseek-chat', 'deepseek-reasoner', 'glm-5'])
    wrapper.unmount()
  })

  it('非默认空间:没配凭证的 provider 整个不列 —— 选了也起不了流', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    spaces.switchTo('work')
    await useSpaceProvidersStore().refresh()

    const wrapper = mountSelector()
    await wrapper.find('.model-trigger').trigger('click')
    await nextTick()

    // zhipu 在 settings 里有 key、有模型 —— 但这个空间没配,不该出现。
    expect(providerCells(wrapper)).toEqual(['DeepSeek2'])
    // 模型清单按空间取:work 的 overlay 只选了 reasoner。列表里多出来的
    // `deepseek-chat` 是**当前正在用的那个**(默认模型仍在全局层,批 B7 只搬
    // selectedModels)——「当前模型永远可见」是既有规则,藏起来才是说谎。
    expect(wrapper.findAll('.model-row .model-name').map(n => n.text()))
      .toEqual(['deepseek-chat', 'deepseek-reasoner'])
    wrapper.unmount()
  })
})

/* ── 批 B9:默认模型 + provider 开关也 per-space ─────────────────────────── */

describe('ModelSelector —— 默认与开关按空间(批 B9)', () => {
  it('默认空间:当前选中来自全局 settings.ai(零回归)', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    await useSpaceProvidersStore().refresh()

    const wrapper = mountSelector()
    expect(wrapper.find('.model-trigger').text()).toContain('deepseek-chat')
    wrapper.unmount()
  })

  it('非默认空间:当前选中来自这个空间的 providers.json,不是全局那一档', async () => {
    SPACE_AI = {
      provider: 'deepseek',
      providers: {
        deepseek: {
          model: 'deepseek-reasoner',
          selectedModels: ['deepseek-chat', 'deepseek-reasoner'],
        },
      },
      customProviders: [],
    }
    const spaces = useSpacesStore()
    await spaces.load()
    spaces.switchTo('work')
    await useSpaceProvidersStore().refresh()

    const wrapper = mountSelector()
    expect(wrapper.find('.model-trigger').text()).toContain('deepseek-reasoner')
    wrapper.unmount()
  })

  it('非默认空间:选一个模型写 providers.json,不写全局 settings', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    spaces.switchTo('work')
    await useSpaceProvidersStore().refresh()

    const wrapper = mountSelector()
    await wrapper.find('.model-trigger').trigger('click')
    await nextTick()
    await wrapper.findAll('.model-row')[1].trigger('click')
    await nextTick()

    expect(mocks.settingsStore.saveAIProviderDefault).not.toHaveBeenCalled()
    const payload = mocks.platform.setProviderSettings.mock.calls[0][0]
    expect(payload.id).toBe('work')
    expect(payload.ai.provider).toBe('deepseek')
    expect(payload.ai.providers.deepseek.model).toBe('deepseek-reasoner')
    wrapper.unmount()
  })

  it('C1:默认空间选一个模型也写自己的 providers.json,settings 一个字节都不动', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    await useSpaceProvidersStore().refresh()

    const wrapper = mountSelector()
    await wrapper.find('.model-trigger').trigger('click')
    await nextTick()
    await wrapper.findAll('.model-row')[1].trigger('click')
    await nextTick()

    expect(mocks.settingsStore.saveAIProviderDefault).not.toHaveBeenCalled()
    const payload = mocks.platform.setProviderSettings.mock.calls[0][0]
    expect(payload.id).toBe('default')
    expect(payload.ai.provider).toBe('deepseek')
    expect(payload.ai.providers.deepseek.model).toBe('deepseek-reasoner')
    wrapper.unmount()
  })

  /**
   * C1 方案 §5:默认空间**唯一**有意的可见变化 —— 配了模型但池里没钥匙的
   * provider 从选择器消失(它本来就发不出去)。
   */
  it('C1:默认空间也吃 configured 闸 —— 没钥匙的 provider 不再列出来', async () => {
    mocks.platform.getCredentials.mockImplementation(async ({ id }: { id: string }) => ({
      success: true,
      credentials: id === 'default' ? WORK_POOL : { providers: {} },
    }))
    const spaces = useSpacesStore()
    await spaces.load()
    await useSpaceProvidersStore().refresh()

    const wrapper = mountSelector()
    await wrapper.find('.model-trigger').trigger('click')
    await nextTick()

    expect(providerCells(wrapper)).toEqual(['DeepSeek2'])
    wrapper.unmount()
  })

  it('provider 开关按空间:空间里关掉的 provider 整个不列(全局仍开着)', async () => {
    SPACE_AI = {
      provider: '',
      providers: {
        deepseek: { selectedModels: ['deepseek-chat'] },
        zhipu: { selectedModels: ['glm-5'], enabled: false },
      },
      customProviders: [],
    }
    // 这一次两个 provider 在 work 空间都有钥匙 —— 把凭证这道闸让开,单看开关。
    mocks.platform.getCredentials.mockImplementation(async () => ({
      success: true,
      credentials: {
        providers: {
          deepseek: { policy: 'single', entries: [{ id: 'e1', label: 'k', authType: 'apiKey', hasApiKey: true, source: 'user' }] },
          zhipu: { policy: 'single', entries: [{ id: 'e2', label: 'k', authType: 'apiKey', hasApiKey: true, source: 'user' }] },
        },
      },
    }))
    const spaces = useSpacesStore()
    await spaces.load()
    spaces.switchTo('work')
    await useSpaceProvidersStore().refresh()

    const wrapper = mountSelector()
    await wrapper.find('.model-trigger').trigger('click')
    await nextTick()

    expect(providerCells(wrapper)).toEqual(['DeepSeek1'])
    wrapper.unmount()
  })
})
