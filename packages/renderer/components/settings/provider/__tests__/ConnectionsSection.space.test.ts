// @vitest-environment happy-dom
/**
 * 连接区的**空间维度**(批 B7)。
 *
 * B3 把 per-space 凭证做成了一块独立面板;08-15 用户推翻了那条路线 ——
 * 「多空间的认证不是一个多余的新表单让你填,而是我切换 workspace 的时候,
 * 它就自动切换过去了」。所以连接区本身就是「当前空间的」连接区:
 *
 *  - default 空间:一字未改(settings 的 key 输入框 + 今天那套已配置判据)。
 *  - 非 default:已配置判据问凭证池,凭证区换成 `SpaceCredentialPool`。
 *  - 后端答不上话(web 降级):整条空间支路等于不存在,退回 default 那支。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { computed, nextTick, ref } from 'vue'
import ConnectionsSection from '../ConnectionsSection.vue'
import type { AppSettings, ProviderInfo } from '@/types'
import { useSpacesStore } from '@/stores/spaces'
import { useSpaceProvidersStore } from '@/stores/spaceProviders'
import { useSpaceProviderView } from '@/composables/useSpaceProviderView'

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
  providerSettings: null as any,
  providerUsage: null as any,
  platform: {
    list: vi.fn(),
    getCredentials: vi.fn(),
    getOverlay: vi.fn(),
    setOverlay: vi.fn(),
    setCredential: vi.fn(),
    setCredentialPool: vi.fn(),
    clearCredential: vi.fn(),
  },
}))

vi.mock('@/platform', () => ({ platformApi: mocks.platform }))
// spaces 域已迁到通用 RPC 通道(结构债 P0.3):组件/store 引的是壳外客户端,
// 不再是 platformApi 上的方法,所以打桩打这个模块(方法名与签名沿用旧的)。
vi.mock('@/platform/spaces-client', () => ({ spacesApi: mocks.platform }))
vi.mock('../useProviderSettings', () => ({
  useProviderSettings: () => mocks.providerSettings,
}))
vi.mock('../useProviderUsage', () => ({
  useProviderUsage: () => mocks.providerUsage,
}))

const providers = [
  { id: 'deepseek', name: 'DeepSeek', requiresApiKey: true, defaultBaseUrl: 'https://api.deepseek.com' },
] as unknown as ProviderInfo[]

function settings(): AppSettings {
  return {
    ai: {
      provider: 'deepseek',
      providers: {
        deepseek: {
          enabled: true,
          apiKey: 'sk-global-1234567890',
          baseUrl: '',
          selectedModels: ['deepseek-chat'],
          model: 'deepseek-chat',
        },
      },
      customProviders: [],
    },
  } as unknown as AppSettings
}

const DEFAULT_POOL = {
  providers: {
    deepseek: {
      policy: 'single',
      entries: [{
        id: 'd1',
        label: 'DeepSeek',
        authType: 'apiKey',
        hasApiKey: true,
        apiKeyPreview: 'sk-glo••••7890',
        source: 'user',
      }],
    },
  },
}

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

/**
 * `useProviderSettings` 整体被 mock 掉(它牵着 OAuth / env 探测 / 模型目录的一大串),
 * 但 `spaceView` 用的是**真的** —— 本片改的正是它与连接区之间那条缝。
 */
function buildProviderSettings() {
  const viewingProvider = ref('deepseek')
  return {
    viewingProvider,
    spaceView: useSpaceProviderView({
      settings: () => settings(),
      providers: () => providers,
    }),
    isUserCustomProvider: vi.fn(() => false),
    isProviderEnabled: vi.fn(() => true),
    getProviderEnvStatus: vi.fn(() => undefined),
    providerUsesEnvApiKey: vi.fn(() => false),
    switchViewingProvider: vi.fn(async () => {}),
    initialize: vi.fn(),
    cleanup: vi.fn(),
    currentProviderName: computed(() => viewingProvider.value),
    isOAuthProvider: ref(false),
    isACPProvider: ref(false),
    oauthStatus: ref({ isLoggedIn: false }),
    isOAuthLoading: ref(false),
    deviceFlowInfo: ref(null),
    codeEntryInfo: ref(null),
    manualCode: ref(''),
    isSubmittingCode: ref(false),
    codeEntryError: ref(''),
    startOAuthLogin: vi.fn(),
    logoutOAuth: vi.fn(),
    submitManualCode: vi.fn(),
    setProvidersEnabled: vi.fn(),
    getDefaultBaseUrl: vi.fn(() => 'https://api.deepseek.com'),
    updateProviderApiKey: vi.fn(),
    updateProviderBaseUrl: vi.fn(),
    currentProviderUsesEnvApiKey: ref(false),
    currentProviderEnvVarName: ref(''),
    currentProviderEnvKeyPreview: ref(''),
    isZhipuProvider: ref(false),
    isQwenProvider: ref(false),
    isKimiProvider: ref(false),
    kimiRegionApplies: ref(false),
    currentZhipuApiMode: ref('standard'),
    currentQwenApiMode: ref('standard'),
    currentQwenRegion: ref('cn'),
    currentKimiApiMode: ref('standard'),
    currentKimiRegion: ref('cn'),
    updateZhipuApiMode: vi.fn(),
    updateQwenApiMode: vi.fn(),
    updateQwenRegion: vi.fn(),
    updateKimiApiMode: vi.fn(),
    updateKimiRegion: vi.fn(),
    availableModels: ref([]),
    filteredModels: ref([]),
    currentSelectedModels: computed(() => ['deepseek-chat']),
    modelSearchQuery: ref(''),
    newModelInput: ref(''),
    isLoadingModels: ref(false),
    modelError: ref(''),
    currentProviderMaxOutputs: ref({}),
    currentProviderContextLengths: ref({}),
    currentProviderModelCapabilities: ref({}),
    renameModel: vi.fn(),
    activeModelId: computed(() => 'deepseek-chat'),
    isModelSelected: vi.fn(() => true),
    hasVision: vi.fn(() => false),
    hasImageGeneration: vi.fn(() => false),
    hasTools: vi.fn(() => false),
    hasReasoning: vi.fn(() => false),
    formatContextLength: vi.fn(String),
    fetchModels: vi.fn(),
    toggleModelSelection: vi.fn(),
    addCustomModel: vi.fn(),
    updateModelMaxOutput: vi.fn(),
    updateModelContextLength: vi.fn(),
    updateModelCapability: vi.fn(),
    resetModelCapabilities: vi.fn(),
    setActiveModel: vi.fn(),
    currentACPAgent: ref(undefined),
    currentACPAgentState: ref(undefined),
    updateACPAgent: vi.fn(),
    updateACPArgs: vi.fn(),
    connectACPAgent: vi.fn(),
    disconnectACPAgent: vi.fn(),
    refreshACPAgent: vi.fn(),
  }
}

function mountSection() {
  mocks.providerSettings = buildProviderSettings()
  return mount(ConnectionsSection, {
    props: { settings: settings(), providers },
    global: {
      stubs: {
        ProviderIcon: { template: '<span class="provider-icon-stub" />' },
        AuthCard: { template: '<div class="auth-card-stub" />' },
        ProviderUsageCard: { template: '<div class="usage-card-stub" />' },
        ProviderModels: { template: '<div class="provider-models-stub" />' },
      },
    },
  })
}

/** 展开那张连接卡片 —— 凭证区在折叠面板里。 */
async function expand(wrapper: ReturnType<typeof mount>) {
  await wrapper.find('.conn-row').trigger('click')
  await nextTick()
  return wrapper
}

beforeEach(async () => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  memory.clear()
  mocks.providerUsage = {
    shouldShow: ref(false),
    response: ref(null),
    isLoading: ref(false),
    error: ref(''),
    refresh: vi.fn(),
  }
  mocks.platform.list.mockResolvedValue({
    success: true,
    spaces: [
      { id: 'default', name: '默认空间', createdAt: 0 },
      { id: 'work', name: '工作', createdAt: 1 },
      { id: 'side', name: '副业', createdAt: 2 },
    ],
  })
  mocks.platform.getCredentials.mockImplementation(async ({ id }: { id: string }) => ({
    success: true,
    // C1:default 也是普通空间 —— 迁移把 settings 里那把 key 搬进了它的池。
    credentials: id === 'work' ? WORK_POOL : id === 'default' ? DEFAULT_POOL : { providers: {} },
  }))
  mocks.platform.getOverlay.mockResolvedValue({ success: true, overlay: {} })
})

describe('ConnectionsSection —— 当前空间口径(批 B7)', () => {
  it('C1:默认空间也读自己的池,凭证区就是那一个池编辑器(单路化)', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    await useSpaceProvidersStore().refresh()

    const wrapper = await expand(mountSection())
    expect(wrapper.find('.conn-status-dot').classes()).toContain('on')
    expect(wrapper.find('.conn-summary').text()).toContain('sk-glo••••7890')
    // C1 之前这里断言的是「settings 的两个输入框还在、池编辑器不出现」——
    // 那正是两套形状在界面上的样子。
    expect(wrapper.findComponent({ name: 'SpaceCredentialPool' }).exists()).toBe(true)
    wrapper.unmount()
  })

  it('非默认空间且没配:全局有 key 也判「未配置」——严格隔离不回落', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    spaces.switchTo('side')
    await useSpaceProvidersStore().refresh()

    const wrapper = mountSection()
    await nextTick()
    expect(wrapper.find('.conn-status-dot').classes()).toContain('off')
    expect(wrapper.find('.conn-summary').text()).toContain('本空间未配置')
    wrapper.unmount()
  })

  it('非默认空间:换的是数据源,不是外观 —— 同一组行、同一组 aria-label', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    spaces.switchTo('work')
    await useSpaceProvidersStore().refresh()

    const wrapper = await expand(mountSection())
    expect(wrapper.find('.conn-summary').text()).toContain('sk-wor••••4321')
    // 落盘通道换成了凭证池……
    expect(wrapper.findComponent({ name: 'SpaceCredentialPool' }).exists()).toBe(true)
    // ……但**外观一格没变**(用户 08-18:「切空间只换数据、不换外观」)。
    // B3/B7 那阵子这里断言的是「两个输入框不再出现」—— 那正是被推翻的东西。
    expect(wrapper.findComponent({ name: 'ProviderCredentialRows' }).exists()).toBe(true)
    expect(wrapper.findAll('input').some(i => i.attributes('aria-label') === 'API key')).toBe(true)
    expect(wrapper.findAll('input').some(i => i.attributes('aria-label') === 'Base URL')).toBe(true)
    // 单条态里不该出现只在这一支存在的措辞。
    expect(wrapper.text()).not.toContain('本空间 ·')
    expect(wrapper.text()).not.toContain('凭证池')
    wrapper.unmount()
  })

  it('后端答不上话(web 降级):整条空间支路等于不存在,退回默认空间那支', async () => {
    mocks.platform.list.mockResolvedValue({ success: false })
    const spaces = useSpacesStore()
    await spaces.load()
    // 列表降级时 store 会把当前空间拨回 default —— 这里再显式确认一次口径。
    expect(spaces.available).toBe(false)

    const wrapper = await expand(mountSection())
    expect(wrapper.findComponent({ name: 'SpaceCredentialPool' }).exists()).toBe(false)
    expect(wrapper.findAll('input').some(i => i.attributes('aria-label') === 'API key')).toBe(true)
    wrapper.unmount()
  })
})
