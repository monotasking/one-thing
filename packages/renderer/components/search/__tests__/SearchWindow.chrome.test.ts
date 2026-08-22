// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, nextTick, ref, type Ref } from 'vue'
import SearchWindow from '../SearchWindow.vue'
import type { SearchCategory, SearchResult, SearchWindowGuideState } from '@shared/ipc/search'

const searchWindowMock = vi.hoisted(() => ({
  useSearchWindow: vi.fn(),
}))

vi.mock('../useSearchWindow', () => ({
  useSearchWindow: searchWindowMock.useSearchWindow,
}))

// A1-a:关搜索窗与执行结果动作走宿主壳路由(searchWindowRouter)。桩仍是同一批
// vi.fn(),挂在下面那份 electronAPI 上 —— 组件从此经 `shellInvoke` 到达它们。
vi.mock('@/platform/search-window-client', () => ({
  searchWindowApi: {
    close: () => (window as any).electronAPI.closeSearchWindow(),
    executeAction: (request: { actionId: string }) =>
      (window as any).electronAPI.searchExecuteAction(request.actionId),
    toggle: vi.fn(),
    setAnchor: vi.fn(),
  },
}))

vi.mock('@/stores/themes', () => ({
  useThemeStore: () => ({
    initialize: vi.fn().mockResolvedValue(undefined),
  }),
}))

const tabs: Array<{ id: SearchCategory; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'chats', label: 'Chats' },
  { id: 'daily', label: 'Daily' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'files', label: 'Files' },
  { id: 'messages', label: 'Messages' },
  { id: 'actions', label: 'Actions' },
]

function createResult(overrides: Partial<SearchResult> & Pick<SearchResult, 'id' | 'type' | 'title'>): SearchResult {
  return overrides
}

function installSearchWindowState(options: {
  activeTab?: SearchCategory
  results?: SearchResult[]
} = {}) {
  const activeTab = ref<SearchCategory>(options.activeTab ?? 'all')
  const query = ref('')
  const selectedIndex = ref(0)
  const visibleResults = ref<SearchResult[]>(options.results ?? [])
  const doSearch = vi.fn().mockResolvedValue(undefined)
  const resetSearchWindow = vi.fn()
  const closeSearchWindow = vi.fn()
  const searchExecuteAction = vi.fn()
  let guideCallback: ((state: SearchWindowGuideState) => void) | null = null

  ;(window as unknown as {
    electronAPI: Record<string, unknown>
  }).electronAPI = {
    closeSearchWindow,
    searchExecuteAction,
    onSearchWindowShown: vi.fn(() => vi.fn()),
    onSearchWindowGuides: vi.fn((callback: (state: SearchWindowGuideState) => void) => {
      guideCallback = callback
      return vi.fn()
    }),
    createPrompt: vi.fn().mockResolvedValue({ success: true, prompt: { id: 'prompt-1' } }),
  }

  searchWindowMock.useSearchWindow.mockImplementation((_resultsRef: Ref<HTMLElement | null>) => ({
    settingsStore: {
      loadSettings: vi.fn().mockResolvedValue(undefined),
    },
    tabs: computed(() => tabs),
    activeTab,
    query,
    selectedIndex,
    isLoading: ref(false),
    searchError: ref(''),
    visibleResults,
    inputPlaceholder: computed(() => 'Search everything...'),
    emptyText: computed(() => 'Start typing, or use / for commands'),
    moveSelection: vi.fn((delta: number) => {
      if (!visibleResults.value.length) return
      selectedIndex.value = (selectedIndex.value + delta + visibleResults.value.length) % visibleResults.value.length
    }),
    cycleTab: vi.fn((direction: number) => {
      const currentIndex = tabs.findIndex(tab => tab.id === activeTab.value)
      activeTab.value = tabs[(currentIndex + direction + tabs.length) % tabs.length].id
    }),
    selectTabByShortcut: vi.fn((key: string) => {
      const tab = tabs[Number(key) - 1]
      if (!tab) return false
      activeTab.value = tab.id
      return true
    }),
    confirmSelectedResult: vi.fn(() => visibleResults.value[selectedIndex.value]),
    doSearch,
    resetSearchWindow,
  }))

  return {
    activeTab,
    query,
    selectedIndex,
    visibleResults,
    closeSearchWindow,
    searchExecuteAction,
    emitGuides: (state: SearchWindowGuideState) => guideCallback?.(state),
  }
}

async function mountSearchWindow() {
  const wrapper = mount(SearchWindow)
  await nextTick()
  await Promise.resolve()
  await nextTick()
  return wrapper
}

describe('SearchWindow reduced chrome layout', () => {
  beforeEach(() => {
    searchWindowMock.useSearchWindow.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders mixed results as one flat, result-first list without section or footer chrome', async () => {
    installSearchWindowState({
      activeTab: 'all',
      results: [
        createResult({ id: 'chat:1', type: 'chat', title: 'Project planning', subtitle: 'Today' }),
        createResult({ id: 'prompt:1', type: 'prompt', title: 'Review prompt', detail: 'Reusable critique prompt' }),
        createResult({ id: 'action:1', type: 'action', title: 'Create new chat', subtitle: 'chat · conversation · create', shortcut: '⌘N' }),
      ],
    })

    const wrapper = await mountSearchWindow()

    expect(wrapper.findAll('.search-result-item')).toHaveLength(3)
    expect(wrapper.find('.search-footer').exists()).toBe(false)
    expect(wrapper.find('.search-tabs').exists()).toBe(false)
    expect(wrapper.find('.search-result-group').exists()).toBe(false)
    expect(wrapper.find('.group-header').exists()).toBe(false)
    expect(wrapper.find('.scope-tabs').exists()).toBe(true)
    expect(wrapper.find('.scope-tabs').classes()).not.toContain('has-active-scope')
    expect(wrapper.find('.scope-tab.active.default-scope').exists()).toBe(true)
    expect(wrapper.find('.result-icon').exists()).toBe(false)
    expect(wrapper.findAll('.result-kind').map(node => node.text())).toEqual([
      'Chat',
      'Prompt',
      'Command',
    ])
    expect(wrapper.find('.result-shortcut').exists()).toBe(false)
    expect(wrapper.find('.result-time').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Reusable critique prompt')
    expect(wrapper.text()).not.toContain('chat · conversation · create')
    expect(wrapper.text()).not.toContain('⌘N')
  })

  it('hides category indicators inside scoped result views to avoid repeated chrome', async () => {
    installSearchWindowState({
      activeTab: 'chats',
      results: [
        createResult({ id: 'chat:1', type: 'chat', title: 'Project planning', timestamp: Date.now() }),
        createResult({ id: 'chat:2', type: 'chat', title: 'Launch notes', timestamp: Date.now() }),
      ],
    })

    const wrapper = await mountSearchWindow()

    expect(wrapper.findAll('.search-result-item')).toHaveLength(2)
    expect(wrapper.findAll('.result-kind')).toHaveLength(0)
    expect(wrapper.find('.scope-tabs').classes()).toContain('has-active-scope')
    expect(wrapper.find('.scope-tab.active.default-scope').exists()).toBe(false)
    expect(wrapper.find('.scope-tab.active').text()).toContain('Chats')
  })

  it('renders drag and resize guide lines from main-process guide state', async () => {
    const state = installSearchWindowState()
    const wrapper = await mountSearchWindow()

    expect(wrapper.find('.drag-guides').exists()).toBe(false)

    state.emitGuides({
      visible: true,
      centerX: true,
      defaultTop: false,
      defaultHeight: true,
      defaultBounds: false,
    })
    await nextTick()

    const guides = wrapper.find('.drag-guides')
    expect(guides.exists()).toBe(true)
    expect(guides.classes()).toContain('is-center-x')
    expect(guides.classes()).not.toContain('is-default-top')
    expect(guides.classes()).toContain('is-default-height')
    expect(wrapper.find('.resize-grip').exists()).toBe(true)
  })

  it('confirms the selected result on normal Enter', async () => {
    const state = installSearchWindowState({
      results: [
        createResult({ id: 'action:1', type: 'action', title: 'Open settings', actionId: 'settings:open' }),
      ],
    })
    const wrapper = await mountSearchWindow()

    await wrapper.find('input.search-input').trigger('keydown', { key: 'Enter' })

    expect(state.searchExecuteAction).toHaveBeenCalledWith('settings:open')
  })

  it('does not confirm the selected result when Enter commits IME composition', async () => {
    const state = installSearchWindowState({
      results: [
        createResult({ id: 'action:1', type: 'action', title: 'Open settings', actionId: 'settings:open' }),
      ],
    })
    const wrapper = await mountSearchWindow()
    const input = wrapper.find('input.search-input')

    await input.trigger('compositionstart')
    await input.trigger('keydown', { key: 'Enter' })

    expect(state.searchExecuteAction).not.toHaveBeenCalled()
  })
})
