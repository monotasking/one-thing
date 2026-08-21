// @vitest-environment happy-dom
/**
 * 「当前空间的 provider 视图」—— 批 B7 的三态与跨窗口跟随。
 *
 * 这一片纠偏的是 B3 的路线:凭证解析后端早就是 per-space 的,但渲染层的编辑面与
 * 展示面还盯着全局 `settings.ai`。用户 08-15 的原话:「多空间的认证不是一个多余的
 * 新表单让你填,而是我切换 workspace 的时候,它就自动切换过去了」。
 *
 * 三条底线在这里钉住:
 *  1. default 空间 = 今天的行为,一字不差(零迁移)。
 *  2. 非 default 空间的凭证**严格隔离不回落**——全局有 key 也不算配好。
 *  3. 切空间(含别的窗口切的)视图整份换掉,不留上一份的残影。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AppSettings, ProviderInfo } from '@/types'
import { useSpacesStore } from '../spaces'
import { useSpaceProvidersStore } from '../spaceProviders'
import { useSpaceProviderView } from '@/composables/useSpaceProviderView'

// 全局 setup 里那份 localStorage 桩没有 `clear`,自己铺一份内存版
// (与 `projects-space.test.ts` 同一手法)。
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

const platform = vi.hoisted(() => ({
  list: vi.fn(),
  getCredentials: vi.fn(),
  getOverlay: vi.fn(),
  setOverlay: vi.fn(),
  getProviderSettings: vi.fn(),
  setProviderSettings: vi.fn(),
  // 批 B9-0:跨窗口广播的收件口。测试里把回调抓在手上,自己扮演主进程。
  onSpacesChanged: vi.fn((cb: (event: { spaceId: string; kind: string }) => void) => {
    spacesChangedListeners.push(cb)
    return () => {
      const at = spacesChangedListeners.indexOf(cb)
      if (at >= 0) spacesChangedListeners.splice(at, 1)
    }
  }),
}))

const spacesChangedListeners = vi.hoisted(() => [] as Array<(event: { spaceId: string; kind: string }) => void>)

/** 让 refresh 里的 Promise.all 走完(两条 IPC + 一次赋值)。 */
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function emitSpacesChanged(spaceId: string, kind: 'credentials' | 'overlay' | 'providers' = 'credentials') {
  for (const listener of [...spacesChangedListeners]) listener({ spaceId, kind })
}

vi.mock('@/platform', () => ({ platformApi: platform }))
// spaces 域已迁到通用 RPC 通道(结构债 P0.3):组件/store 引的是壳外客户端,
// 不再是 platformApi 上的方法,所以打桩打这个模块(方法名与签名沿用旧的)。
vi.mock('@/platform/spaces-client', () => ({ spacesApi: platform }))

const SPACES = [
  { id: 'default', name: '默认空间', createdAt: 0 },
  { id: 'work', name: '工作', createdAt: 1 },
  { id: 'side', name: '副业', createdAt: 2 },
]

const providers = [
  { id: 'deepseek', name: 'DeepSeek', requiresApiKey: true },
  { id: 'codex', name: 'Codex', requiresApiKey: false, requiresOAuth: true },
  { id: 'claude-code-agent', name: 'Claude Code', requiresApiKey: false },
] as unknown as ProviderInfo[]

function settings(): AppSettings {
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
        codex: { enabled: true, selectedModels: ['gpt-5.2-codex'] },
      },
    },
  } as unknown as AppSettings
}

const POOLS: Record<string, unknown> = {
  // C1:default 也是普通空间 —— 迁移把 settings 里那把 key 搬进了它自己的池。
  default: {
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
  },
  work: {
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
  },
  side: { providers: {} },
}

/**
 * C2:每个空间**整套** provider 设置(`workspaces/<id>/providers.json`)。
 * `side` 是一个空白空间 —— 无回落,它就是空的。
 */
const PROVIDER_SETTINGS: Record<string, unknown> = {
  default: {
    provider: 'deepseek',
    providers: {
      deepseek: {
        enabled: true,
        model: 'deepseek-chat',
        selectedModels: ['deepseek-chat', 'deepseek-reasoner'],
      },
      codex: { enabled: true, selectedModels: ['gpt-5.2-codex'] },
    },
    customProviders: [],
  },
  work: {
    provider: 'deepseek',
    providers: {
      deepseek: { enabled: true, model: 'deepseek-chat', selectedModels: ['deepseek-reasoner'] },
    },
    customProviders: [],
  },
  side: { provider: '', providers: {}, customProviders: [] },
}

function makeView() {
  return useSpaceProviderView({
    settings: () => settings(),
    providers: () => providers,
  })
}

beforeEach(async () => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  memory.clear()
  spacesChangedListeners.length = 0
  platform.list.mockResolvedValue({ success: true, spaces: SPACES })
  platform.getCredentials.mockImplementation(async ({ id }: { id: string }) => ({
    success: true,
    credentials: POOLS[id] ?? { providers: {} },
  }))
  platform.getOverlay.mockImplementation(async () => ({ success: true, overlay: {} }))
  platform.setOverlay.mockImplementation(async (request: any) => ({
    success: true,
    overlay: request.overlay,
  }))
  platform.getProviderSettings.mockImplementation(async ({ id }: { id: string }) => ({
    success: true,
    ai: JSON.parse(JSON.stringify(PROVIDER_SETTINGS[id] ?? { provider: '', providers: {}, customProviders: [] })),
  }))
  platform.setProviderSettings.mockImplementation(async (request: any) => ({
    success: true,
    ai: request.ai,
  }))
})

describe('当前空间的 provider 视图(批 B7)', () => {
  it('C1/C2:default 空间也走池 + providers.json,与别的空间同一条 IPC', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    const view = makeView()
    await useSpaceProvidersStore().refresh()

    expect(view.isDefaultSpace.value).toBe(true)
    expect(view.isConfigured('deepseek')).toBe(true)
    expect(view.credentialOf('deepseek').summary).toBe('sk-glo••••7890')
    expect(view.selectedModelsOf('deepseek')).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    // C1 之前这两句是 `not.toHaveBeenCalled()` —— 那条短路正是两套形状的入口。
    expect(platform.getCredentials).toHaveBeenCalledWith({ id: 'default' })
    expect(platform.getProviderSettings).toHaveBeenCalledWith({ id: 'default' })
  })

  it('env key 机器级、全空间可见(C1 拍板 1):池空也算配好,摘要是 Env', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    spaces.switchTo('side')
    await useSpaceProvidersStore().refresh()
    const view = useSpaceProviderView({
      settings: () => settings(),
      providers: () => providers,
      usesEnvApiKey: id => id === 'deepseek',
    })

    expect(view.isConfigured('deepseek')).toBe(true)
    expect(view.credentialOf('deepseek').summary).toBe('Env')
  })

  it('非 default 空间读凭证池,全局那把 key 不算数(严格隔离不回落)', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    spaces.switchTo('side')
    await useSpaceProvidersStore().refresh()
    const view = makeView()

    expect(view.isDefaultSpace.value).toBe(false)
    // settings.ai 里 deepseek 明明有 key —— 这个空间没配就是没配。
    expect(view.isConfigured('deepseek')).toBe(false)
    expect(view.credentialOf('deepseek').summary).toBe('本空间未配置')
    expect(view.credentialOf('codex').summary).toBe('本空间未登录')
  })

  it('配了池就报池里那把的预览,不报 settings 的', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    spaces.switchTo('work')
    await useSpaceProvidersStore().refresh()
    const view = makeView()

    expect(platform.getCredentials).toHaveBeenCalledWith({ id: 'work' })
    expect(view.isConfigured('deepseek')).toBe(true)
    expect(view.credentialOf('deepseek').summary).toBe('sk-wor••••4321')
  })

  it('自带 CLI 登录的本地 agent 两种空间下都算配好 —— 它从来不问密钥', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    spaces.switchTo('side')
    await useSpaceProvidersStore().refresh()
    expect(makeView().isConfigured('claude-code-agent')).toBe(true)
  })

  it('selectedModels 按空间取;**C2 起不回落** —— 空白空间就是空的', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    const store = useSpaceProvidersStore()

    spaces.switchTo('work')
    await store.refresh()
    expect(makeView().selectedModelsOf('deepseek')).toEqual(['deepseek-reasoner'])

    // side 是空白空间。C2 之前这里落回全局(B7 的设计),而那正是
    // 「我在这个空间没选过这个模型,它怎么在选择器里」的来源。
    spaces.switchTo('side')
    await store.refresh()
    expect(makeView().selectedModelsOf('deepseek')).toEqual([])
  })

  it('两个空间完整独立:A 的自定义 provider / 逐模型覆盖 / 默认模型在 B 看不见', async () => {
    PROVIDER_SETTINGS.work = {
      provider: 'custom-a',
      providers: {
        'custom-a': {
          enabled: true,
          model: 'a-pro',
          selectedModels: ['a-pro'],
          contextLengthByModel: { 'a-pro': 200000 },
        },
      },
      customProviders: [{ id: 'custom-a', name: 'A 家', apiType: 'openai' }],
    }
    const spaces = useSpacesStore()
    await spaces.load()
    const store = useSpaceProvidersStore()

    spaces.switchTo('work')
    await store.refresh()
    expect(store.providerSettings?.customProviders).toEqual([
      { id: 'custom-a', name: 'A 家', apiType: 'openai' },
    ])
    expect(store.configOf('custom-a')?.contextLengthByModel).toEqual({ 'a-pro': 200000 })
    expect(makeView().spaceDefault.value).toEqual({ provider: 'custom-a', model: 'a-pro' })

    spaces.switchTo('side')
    await store.refresh()
    expect(store.providerSettings?.customProviders).toEqual([])
    expect(store.configOf('custom-a')).toBeUndefined()
    expect(makeView().spaceDefault.value).toBeUndefined()

    PROVIDER_SETTINGS.work = {
      provider: 'deepseek',
      providers: {
        deepseek: { enabled: true, model: 'deepseek-chat', selectedModels: ['deepseek-reasoner'] },
      },
      customProviders: [],
    }
  })

  it('写模型选择走 providers.json 的先读后并(C1:default 也走这条)', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    const store = useSpaceProvidersStore()
    await store.refresh()

    // default 也写自己的那一份 —— C1 之前这条通道对它是关的。
    expect(await store.writeSelectedModels('deepseek', ['x'])).toBe(true)
    expect(platform.setProviderSettings.mock.calls[0][0].id).toBe('default')
    expect(store.configOf('deepseek')?.selectedModels).toEqual(['x'])
    // 同一个 provider 的别的格没被这次写抹掉(整层写由这里先读后并)。
    expect(store.configOf('deepseek')?.model).toBe('deepseek-chat')
    platform.setProviderSettings.mockClear()

    spaces.switchTo('work')
    await store.refresh()
    expect(await store.writeSelectedModels('deepseek', ['deepseek-chat'])).toBe(true)
    expect(platform.setProviderSettings.mock.calls[0][0].id).toBe('work')
    expect(makeView().selectedModelsOf('deepseek')).toEqual(['deepseek-chat'])
  })

  it('连续两次写:第二次的 payload 不能带 Vue reactive Proxy(IPC 结构化克隆会抛)', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    spaces.switchTo('work')
    const store = useSpaceProvidersStore()
    await store.refresh()

    // Electron 的 ipcRenderer.invoke 走结构化克隆:Proxy 一律 "could not be cloned"。
    // mock 里照样克隆一遍,把这条边界规则搬进单测。
    platform.setProviderSettings.mockImplementation(async (request: any) => {
      structuredClone(request)
      return { success: true, ai: request.ai }
    })

    // 第一次:previous 还是 undefined,payload 天然是 plain 的。
    expect(await store.writeSelectedModels('deepseek', ['deepseek-chat'])).toBe(true)
    // 第二次:previous 已是上次写回的 reactive 树 —— 这一步在修复前抛 DataCloneError → 回滚。
    expect(await store.writeSelectedModels('codex', ['gpt-5.2-codex', 'gpt-5.5'])).toBe(true)
    // 再从「已勾」里摘一个 —— 取消勾选走的也是同一条写通道。
    expect(await store.writeSelectedModels('codex', ['gpt-5.5'])).toBe(true)
    expect(makeView().selectedModelsOf('deepseek')).toEqual(['deepseek-chat'])
    expect(makeView().selectedModelsOf('codex')).toEqual(['gpt-5.5'])
  })

  it('写失败回滚,不留下界面上选着、盘上没有的模型', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    spaces.switchTo('work')
    const store = useSpaceProvidersStore()
    await store.refresh()

    platform.setProviderSettings.mockResolvedValue({ success: false, error: '磁盘满了' })
    expect(await store.writeSelectedModels('deepseek', ['deepseek-chat'])).toBe(false)
    expect(makeView().selectedModelsOf('deepseek')).toEqual(['deepseek-reasoner'])
  })

  it('切空间整份换掉 —— 上一个空间的凭证不会留在视图上', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    const store = useSpaceProvidersStore()
    const view = makeView()

    spaces.switchTo('work')
    await store.refresh()
    expect(view.isConfigured('deepseek')).toBe(true)

    spaces.switchTo('side')
    await store.refresh()
    expect(view.isConfigured('deepseek')).toBe(false)
    expect(view.spaceName.value).toBe('副业')
  })

  it('别的窗口切了空间,这个窗口跟着换(设置窗跟随主窗)', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    const store = useSpaceProvidersStore()
    const view = makeView()
    expect(view.spaceId.value).toBe('default')

    // `storage` 事件只在**别的**窗口触发 —— 这里模拟主窗切到 work。
    localStorage.setItem('onething:current-space', 'work')
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'onething:current-space',
      newValue: 'work',
    }))

    expect(view.spaceId.value).toBe('work')
    // 跟随之后视图自己去拉新空间那一份,不必等谁来手动刷新。
    await Promise.resolve()
    await Promise.resolve()
    expect(platform.getCredentials).toHaveBeenCalledWith({ id: 'work' })
    expect(store.spaceId).toBe('work')
  })
})

/* ── 批 B9:默认选择 + provider 开关 ─────────────────────────────────────── */

describe('空间默认 provider/model(批 B9)', () => {
  it('default 空间的默认也住在它自己的 providers.json 里', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    await useSpaceProvidersStore().refresh()
    const view = makeView()

    expect(view.spaceDefault.value).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(view.defaultSelection.value).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('空白空间没表达过 → 就是没有(C2 起不回落)', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    spaces.switchTo('side')
    await useSpaceProvidersStore().refresh()
    const view = makeView()

    expect(view.spaceDefault.value).toBeUndefined()
    expect(view.defaultSelection.value).toEqual({ provider: '', model: '' })
  })

  it('写默认走 providers.json(C1:default 也走这条)', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    const store = useSpaceProvidersStore()
    const view = makeView()
    await store.refresh()

    expect(await view.setDefaultSelection('codex', 'gpt-5.2-codex')).toBe(true)
    platform.setProviderSettings.mockClear()

    spaces.switchTo('work')
    await store.refresh()
    expect(await view.setDefaultSelection('codex', 'gpt-5.2-codex')).toBe(true)
    const payload = platform.setProviderSettings.mock.calls[0][0]
    expect(payload.id).toBe('work')
    // 先读后并:这个空间原有的 selectedModels 必须还在。
    expect(payload.ai.providers.deepseek.selectedModels).toEqual(['deepseek-reasoner'])
    expect(payload.ai.provider).toBe('codex')
    expect(payload.ai.providers.codex.model).toBe('gpt-5.2-codex')
    expect(view.spaceDefault.value).toEqual({ provider: 'codex', model: 'gpt-5.2-codex' })
    expect(view.defaultSelection.value).toEqual({ provider: 'codex', model: 'gpt-5.2-codex' })
  })

  it('写失败回滚 —— 不留下界面上是一套、盘上是另一套', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    const store = useSpaceProvidersStore()
    spaces.switchTo('work')
    await store.refresh()

    platform.setProviderSettings.mockResolvedValue({ success: false, error: '磁盘满了' })
    expect(await store.writeDefaultSelection('codex', 'gpt-5.2-codex')).toBe(false)
    expect(makeView().spaceDefault.value).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })
})

describe('空间 provider 开关(批 B9)', () => {
  it('C1:default 空间的开关也写它自己的 providers.json', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    await useSpaceProvidersStore().refresh()
    const view = makeView()

    expect(view.isProviderEnabled('deepseek')).toBe(true)
    expect(await view.setProvidersEnabled(['deepseek'], false)).toBe(true)
    const payload = platform.setProviderSettings.mock.calls[0][0]
    expect(payload.id).toBe('default')
    expect(payload.ai.providers.deepseek.enabled).toBe(false)
    expect(view.isProviderEnabled('deepseek')).toBe(false)
  })

  it('非 default 空间:写自己那份,读按空间 —— 别的空间一动不动', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    const store = useSpaceProvidersStore()
    spaces.switchTo('work')
    await store.refresh()
    const view = makeView()

    expect(view.isProviderEnabled('deepseek')).toBe(true)
    expect(await view.setProvidersEnabled(['deepseek'], false)).toBe(true)
    const payload = platform.setProviderSettings.mock.calls[0][0]
    expect(payload.id).toBe('work')
    expect(payload.ai.providers.deepseek).toMatchObject({
      enabled: false,
      // 先读后并:同一条记录里别的格没被抹掉。
      selectedModels: ['deepseek-reasoner'],
    })
    expect(view.isProviderEnabled('deepseek')).toBe(false)
    // 这个空间没配过 codex —— 缺省是「开着但没凭证」,与 default 无关。
    expect(view.isProviderEnabled('codex')).toBe(true)
  })

  it('家族卡两个成员一次写(顺序写会互相覆盖)', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    const store = useSpaceProvidersStore()
    spaces.switchTo('work')
    await store.refresh()

    expect(await store.writeProvidersEnabled(['kimi', 'kimi-code'], false)).toBe(true)
    expect(store.configOf('kimi')?.enabled).toBe(false)
    expect(store.configOf('kimi-code')?.enabled).toBe(false)
  })
})

describe('跨窗口缓存过期(批 B9-0)', () => {
  it('收到本空间的变更 → 重拉(设置窗配好 key,主窗立刻看得见)', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    const store = useSpaceProvidersStore()
    spaces.switchTo('side')
    await store.refresh()
    const view = makeView()
    expect(view.isConfigured('deepseek')).toBe(false)

    // 设置窗那边写盘成功 → 主进程广播。这一侧的池此刻已经有条目了。
    POOLS.side = POOLS.work
    emitSpacesChanged('side')
    await flush()

    expect(view.isConfigured('deepseek')).toBe(true)
    POOLS.side = { providers: {} }
  })

  it("C2:kind:'providers' 同样触发重拉(设置窗改了模型选择,主窗立刻看得见)", async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    const store = useSpaceProvidersStore()
    spaces.switchTo('work')
    await store.refresh()
    expect(store.configOf('deepseek')?.selectedModels).toEqual(['deepseek-reasoner'])

    // 设置窗那边整层写回了 providers.json → 主进程广播 kind:'providers'。
    PROVIDER_SETTINGS.work = {
      provider: 'deepseek',
      providers: { deepseek: { enabled: true, model: 'deepseek-chat', selectedModels: ['deepseek-chat'] } },
      customProviders: [],
    }
    emitSpacesChanged('work', 'providers')
    await flush()

    expect(store.configOf('deepseek')?.selectedModels).toEqual(['deepseek-chat'])
    PROVIDER_SETTINGS.work = {
      provider: 'deepseek',
      providers: {
        deepseek: { enabled: true, model: 'deepseek-chat', selectedModels: ['deepseek-reasoner'] },
      },
      customProviders: [],
    }
  })

  it('别的空间的变更不重拉(与我无关)', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    const store = useSpaceProvidersStore()
    spaces.switchTo('side')
    await store.refresh()
    platform.getCredentials.mockClear()

    emitSpacesChanged('work')
    await flush()
    expect(platform.getCredentials).not.toHaveBeenCalled()
  })

  it('C1:default 空间也在广播里 —— 它同样有池和 providers.json', async () => {
    const spaces = useSpacesStore()
    await spaces.load()
    const store = useSpaceProvidersStore()
    await store.refresh()
    platform.getCredentials.mockClear()

    emitSpacesChanged('default')
    await flush()
    expect(platform.getCredentials).toHaveBeenCalledWith({ id: 'default' })
  })
})
