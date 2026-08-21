// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  DEFAULT_SPACE_ID,
  currentSpaceId,
  sessionBelongsToSpace,
  useSpacesStore,
} from '../spaces'

const { electronApi, store: memory } = vi.hoisted(() => {
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
  return {
    store,
    electronApi: {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      getCredentials: vi.fn(),
      setCredential: vi.fn(),
      clearCredential: vi.fn(),
      importCredentials: vi.fn(),
      onSystemThemeChanged: vi.fn(() => vi.fn()),
    },
  }
})

// spaces 域已迁到通用 RPC 通道(结构债 P0.3):组件/store 引的是壳外客户端,
// 不再是 platformApi 上的方法,所以打桩打这个模块(方法名与签名沿用旧的)。
vi.mock('@/platform/spaces-client', () => ({ spacesApi: electronApi }))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  memory.clear()
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: electronApi })
})

describe('spaces store', () => {
  it('starts on the default space and degrades to it when the host has no spaces API', async () => {
    electronApi.list.mockResolvedValue({ success: false, error: 'no route' })
    const store = useSpacesStore()
    await store.load()

    expect(store.spaces.map(space => space.id)).toEqual([DEFAULT_SPACE_ID])
    expect(store.currentSpaceId).toBe(DEFAULT_SPACE_ID)
    // 后端答不上话 = 切换器整行不画,而不是画一个点不动的控件。
    expect(store.available).toBe(false)
    expect(store.showSwitcher).toBe(false)
  })

  it('loads the real list and shows the switcher', async () => {
    electronApi.list.mockResolvedValue({
      success: true,
      spaces: [
        { id: DEFAULT_SPACE_ID, name: '默认空间', createdAt: 1 },
        { id: 'work', name: '工作', createdAt: 2 },
      ],
    })
    const store = useSpacesStore()
    await store.load()

    expect(store.spaces).toHaveLength(2)
    expect(store.showSwitcher).toBe(true)
    expect(store.currentSpace.id).toBe(DEFAULT_SPACE_ID)
  })

  it('persists the current space to localStorage — window 级状态,不进后端', async () => {
    electronApi.list.mockResolvedValue({
      success: true,
      spaces: [
        { id: DEFAULT_SPACE_ID, name: '默认空间', createdAt: 1 },
        { id: 'work', name: '工作', createdAt: 2 },
      ],
    })
    const store = useSpacesStore()
    await store.load()

    store.switchTo('work')
    expect(store.currentSpaceId).toBe('work')
    expect(memory.get('onething:current-space')).toBe('work')
    // 非组件调用点(建会话/建草稿)读的是同一份真相。
    expect(currentSpaceId()).toBe('work')
  })

  /**
   * 批 B10 任务 3:**设置窗打开即显示当前空间**。
   *
   * 判据是「store 创建那一刻就已经是对的」——`currentSpaceId` 的初值来自
   * `readStoredSpaceId()` 这个**同步**读法,不是某个 onMounted 里的异步补齐。
   * 只要它是异步的,设置窗就会先按 default 画一帧再跳,而那一帧里连接卡片读的是
   * 默认空间的凭证。这里不 `await` 任何东西,就是在钉这件事。
   */
  it('设置窗首帧就是主窗当前空间 —— 初值同步取自 localStorage,不先画一帧 default', () => {
    memory.set('onething:current-space', 'work')
    setActivePinia(createPinia())
    // 没有 load()、没有 await、没有 nextTick:这就是「首帧」。
    const store = useSpacesStore()
    expect(store.currentSpaceId).toBe('work')
    // 非组件调用点(spaceProviders 的 spaceId)读的是同一份真相。
    expect(currentSpaceId()).toBe('work')
  })

  it('falls back to default when the stored space is gone', async () => {
    memory.set('onething:current-space', 'ghost')
    setActivePinia(createPinia())
    electronApi.list.mockResolvedValue({
      success: true,
      spaces: [{ id: DEFAULT_SPACE_ID, name: '默认空间', createdAt: 1 }],
    })
    const store = useSpacesStore()
    expect(store.currentSpaceId).toBe('ghost')
    await store.load()
    expect(store.currentSpaceId).toBe(DEFAULT_SPACE_ID)
  })

  it('auto-names new spaces and reloads after create/rename/remove', async () => {
    electronApi.list.mockResolvedValue({
      success: true,
      spaces: [{ id: DEFAULT_SPACE_ID, name: '默认空间', createdAt: 1 }],
    })
    const store = useSpacesStore()
    await store.load()

    electronApi.create.mockResolvedValue({
      success: true,
      space: { id: 'space-2', name: '空间 2', createdAt: 5 },
    })
    const created = await store.create()
    expect(electronApi.create).toHaveBeenCalledWith({ name: '空间 2' })
    expect(created?.space.id).toBe('space-2')
    // 没选「导入凭证」就一次导入都不发 —— 空白开始必须真的空白。
    expect(electronApi.importCredentials).not.toHaveBeenCalled()

    electronApi.update.mockResolvedValue({ success: true, space: {} })
    expect(await store.rename('space-2', '  改名  ')).toBe(true)
    expect(electronApi.update).toHaveBeenCalledWith({ id: 'space-2', name: '改名' })
    // 空名字是撤销,不是清空。
    expect(await store.rename('space-2', '   ')).toBe(false)
  })

  it('keeps the backend refusal reason on lastError', async () => {
    electronApi.list.mockResolvedValue({
      success: true,
      spaces: [{ id: DEFAULT_SPACE_ID, name: '默认空间', createdAt: 1 }],
    })
    const store = useSpacesStore()
    await store.load()

    electronApi.remove.mockResolvedValue({
      success: false,
      error: '空间里还有 3 条会话,先清空再删',
      code: 'NOT_EMPTY',
    })
    expect(await store.remove('work')).toBe(false)
    expect(store.lastError).toContain('3 条会话')
  })
})

describe('sessionBelongsToSpace', () => {
  it('treats a missing workspaceId as the default space (零迁移)', () => {
    expect(sessionBelongsToSpace({}, DEFAULT_SPACE_ID)).toBe(true)
    expect(sessionBelongsToSpace({}, 'work')).toBe(false)
    expect(sessionBelongsToSpace({ workspaceId: 'work' }, 'work')).toBe(true)
    expect(sessionBelongsToSpace({ workspaceId: 'work' }, DEFAULT_SPACE_ID)).toBe(false)
  })
})
