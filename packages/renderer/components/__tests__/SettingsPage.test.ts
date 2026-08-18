// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsPage from '../SettingsPage.vue'

const mocks = vi.hoisted(() => ({
  settingsStore: null as any,
}))

// 标题栏那块「当前空间」标识(批 B7)不是这条测试线的题目 —— 给它一个
// 「后端答不上话」的空间 store,整块不画,壳子的断言一字不动。
vi.mock('@/stores/spaces', () => ({
  DEFAULT_SPACE_ID: 'default',
  useSpacesStore: () => ({
    available: false,
    spaces: [],
    currentSpace: { id: 'default', name: '默认空间', createdAt: 0 },
    currentSpaceId: 'default',
    load: vi.fn(async () => {}),
    switchTo: vi.fn(),
  }),
}))

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => mocks.settingsStore,
}))

function readSettingsPageSource() {
  return readFileSync(path.join(process.cwd(), 'packages/renderer/components/SettingsPage.vue'), 'utf8')
}

function appSettings() {
  return {
    theme: 'dark',
    general: {
      shortcuts: {},
      editor: {},
      dailyNotes: { enabled: true },
      todoPlan: { enabled: true },
    },
    chat: {},
    ai: {
      provider: 'openai',
      providers: {},
      customProviders: [],
    },
    tools: {
      enableToolCalls: true,
      tools: {},
    },
    network: {
      proxy: {
        enabled: false,
        url: '',
        bypassRules: '',
      },
    },
    channels: {
      wechat: { enabled: false },
    },
    mcp: { enabled: true, servers: [] },
    skills: { enableSkills: true, skills: {} },
  }
}

async function settle() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

function mountSettingsPage() {
  return mount(SettingsPage, {
    global: {
      stubs: {
        GeneralSettingsTab: { template: '<div class="stub-general">general tab</div>' },
        EditorSettingsTab: { template: '<div class="stub-editor">editor tab</div>' },
        AIProviderTab: { template: '<div class="stub-providers">providers tab</div>' },
        ToolsSettingsTab: { template: '<div class="stub-tools">tools tab</div>' },
        NetworkSettingsTab: { template: '<div class="stub-network">network tab</div>' },
        ChannelsSettingsTab: { template: '<div class="stub-channels">channels tab</div>' },
        ShortcutsSettingsTab: { template: '<div class="stub-shortcuts">shortcuts tab</div>' },
        MCPSettingsPanel: { template: '<div class="stub-mcp">mcp tab</div>' },
        SkillsSettingsPanel: { template: '<div class="stub-skills">skills tab</div>' },
        PromptsSettingsPanel: { template: '<div class="stub-prompts">prompts tab</div>' },
        PluginsSettingsTab: { template: '<div class="stub-plugins">plugins tab</div>' },
        UsageSettingsPanel: { template: '<div class="stub-usage">usage tab</div>' },
        CustomProviderDialog: { template: '<div />' },
      },
    },
  })
}

describe('SettingsPage shell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.settingsStore = reactive({
      settings: appSettings(),
      availableProviders: [],
      loadSettings: vi.fn().mockResolvedValue(undefined),
      loadProviders: vi.fn().mockResolvedValue(undefined),
      saveSettings: vi.fn().mockResolvedValue(undefined),
    })
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        getTools: vi.fn().mockResolvedValue({ success: true, tools: [] }),
      },
    })
    window.close = vi.fn()
  })

  it('renders the compact settings shell and switches tabs', async () => {
    const wrapper = mountSettingsPage()
    await settle()

    expect(wrapper.find('.titlebar-title').text()).toBe('Settings')
    expect(wrapper.find('.content-header h1').text()).toBe('General')
    expect(wrapper.find('.settings-window').classes()).toContain('layout-container')
    expect(wrapper.find('.settings-layout').classes()).toContain('layout-container-body')
    expect(wrapper.find('.settings-traffic-lights-space').exists()).toBe(true)
    expect(wrapper.find('.settings-sidebar-inner').element.firstElementChild?.classList.contains('settings-traffic-lights-space')).toBe(true)

    expect(wrapper.find('.sidebar-nav').classes()).toContain('app-menu')
    const firstSubMenuTitle = wrapper.find('.sidebar-entry .app-sub-menu-title')
    expect(firstSubMenuTitle.element.children[0]?.classList.contains('app-sub-menu-chevron-hit')).toBe(true)
    expect(firstSubMenuTitle.element.children[1]?.classList.contains('app-sub-menu-icon')).toBe(true)

    await wrapper.find('[data-index="prompts"]').trigger('click')
    await settle()

    expect(wrapper.find('.content-header h1').text()).toBe('Prompts')
    expect(wrapper.find('.stub-prompts').exists()).toBe(true)

    await wrapper.find('[data-index="usage"]').trigger('click')
    await settle()

    expect(wrapper.find('.content-header h1').text()).toBe('Usage')
    expect(wrapper.find('.stub-usage').exists()).toBe(true)
  })

  it('filters navigation from the sidebar search', async () => {
    const wrapper = mountSettingsPage()
    await settle()

    await wrapper.find('.settings-search input').setValue('prompt')
    await settle()

    // "prompt" matches Prompts by label and Evals by its
    // "Prompt evaluation" hint.
    const labels = wrapper.findAll('.sidebar-label').map(label => label.text())
    expect(labels).toEqual(['Prompts', 'Evals'])
  })

  it('expands and collapses sidebar sections only via the chevron', async () => {
    const wrapper = mountSettingsPage()
    await settle()

    const subnavText = () => wrapper.findAll('.app-sub-menu-panel').map(nav => nav.text()).join(' ')
    const entryByLabel = (label: string) =>
      wrapper.findAll('.sidebar-entry').find(entry => entry.find('.sidebar-label').text() === label)!

    expect(subnavText()).not.toContain('Theme')
    expect(subnavText()).not.toContain('Text Editor')

    await entryByLabel('General').find('.app-sub-menu-chevron-hit').trigger('click')
    await settle()

    expect(subnavText()).toContain('Theme')
    expect(subnavText()).not.toContain('Text Editor')

    await entryByLabel('Editor').find('.app-sub-menu-chevron-hit').trigger('click')
    await settle()

    expect(subnavText()).toContain('Theme')
    expect(subnavText()).toContain('Text Editor')
    // Expanding via the chevron is sidebar-only: it must not navigate.
    expect(wrapper.find('.content-header h1').text()).toBe('General')

    await entryByLabel('General').find('.app-sub-menu-chevron-hit').trigger('click')
    await settle()

    expect(subnavText()).not.toContain('Theme')
    expect(subnavText()).toContain('Text Editor')
    expect(wrapper.find('.content-header h1').text()).toBe('General')
  })

  it('switches tabs on group title click without toggling expansion', async () => {
    const wrapper = mountSettingsPage()
    await settle()

    const subnavText = () => wrapper.findAll('.app-sub-menu-panel').map(nav => nav.text()).join(' ')
    const entryByLabel = (label: string) =>
      wrapper.findAll('.sidebar-entry').find(entry => entry.find('.sidebar-label').text() === label)!

    await entryByLabel('Editor').find('.app-sub-menu-title').trigger('click')
    await settle()

    expect(wrapper.find('.content-header h1').text()).toBe('Editor')
    expect(subnavText()).not.toContain('Text Editor')
  })

  it('renders single-section tabs as flat entries without a submenu', async () => {
    const wrapper = mountSettingsPage()
    await settle()

    const promptsEntry = wrapper.find('[data-index="prompts"]')
    expect(promptsEntry.exists()).toBe(true)
    expect(promptsEntry.classes()).not.toContain('app-sub-menu-title')

    const flatEntries = wrapper.findAll('.sidebar-entry-flat')
    expect(flatEntries.length).toBeGreaterThan(0)
    expect(flatEntries.some(entry => entry.find('.app-sub-menu-panel').exists())).toBe(false)
  })

  it('targets Container-owned layout regions through scoped deep selectors', () => {
    const source = readSettingsPageSource()

    expect(source).toContain('.settings-window :deep(.settings-titlebar)')
    expect(source).toContain('.settings-window :deep(.settings-sidebar)')
    expect(source).toContain('.settings-window :deep(.settings-content)')
  })
})
