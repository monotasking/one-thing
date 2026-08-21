// @vitest-environment happy-dom
/**
 * ctx 仪表明细浮层验收(E4,docs/design/composer-bands-2026-08.md §3.2 勘误)。
 *
 * 裁决是「增强既有仪表」而不是造新控件:仪表还在工具条驾驶舱,hover 的既有
 * Tooltip 不动,多出来的只有点击展开的一张明细 —— 而明细里**只许有真拿得到
 * 的数**(窗口 / 本轮送入 / 累计 / 计费),编不出来的分项一行都不画。
 */
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import InputBox from '../InputBox.vue'
import { createDefaultSettings } from '@shared/defaults/settings'
import { executeCommand } from '@/services/commands'

// skills 域已迁到通用 RPC 通道(结构债 P4c 第二批):取技能表走壳外客户端。
vi.mock('@/platform/skills-client', () => ({
  skillsApi: { getAll: vi.fn().mockResolvedValue({ success: true, skills: [] }) },
}))


const mocks = vi.hoisted(() => ({
  settingsStore: null as any,
  sessionsStore: null as any,
  chatStore: null as any,
  voiceStore: null as any,
  promptsStore: null as any,
  musicStore: null as any,
}))

// 结果提示走全局 ToastHost;这里不需要真的挂 overlay 宿主(它还带深链确认卡,
// 要 Pinia),只要 toasts 队列可断言。
vi.mock("@/services/ui-overlay-host", () => ({
	ensureUiOverlayHost: vi.fn(),
	destroyUiOverlayHost: vi.fn(),
}));

vi.mock('@/stores/settings', () => ({ useSettingsStore: () => mocks.settingsStore }))
vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => mocks.sessionsStore }))
vi.mock('@/stores/chat', () => ({ useChatStore: () => mocks.chatStore }))
vi.mock('@/stores/voice', () => ({ useVoiceStore: () => mocks.voiceStore }))
vi.mock('@/stores/prompts', () => ({ usePromptsStore: () => mocks.promptsStore }))
vi.mock('@/stores/music', () => ({ useMusicStore: () => mocks.musicStore }))
vi.mock('@/stores/collabBoard', () => ({
  useCollabBoardStore: () => ({ isRoomTurnActive: () => false }),
}))
// 草稿纸:这些用例走的是输入框本身,给一个只读空壳。
vi.mock('@/stores/scratchpad', () => ({
  useScratchpadStore: () => ({
    getRecord: () => null,
    setContent: vi.fn(),
    load: vi.fn().mockResolvedValue(undefined),
    flushNow: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    adopt: vi.fn().mockResolvedValue(undefined),
    noteConsumed: vi.fn(),
    consumedOffset: () => null,
    pendingText: () => '',
  }),
}))
vi.mock('@/stores/agents', () => ({
  useAgentsStore: () => ({ getAgent: () => null }),
}))
vi.mock('@/stores/browser', () => ({
  useBrowserStore: () => ({
    tabs: [],
    activeTabId: null,
    activeTab: null,
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('@/services/commands', () => ({
  findCommand: vi.fn(() => undefined),
  getCommands: vi.fn(() => []),
  refreshPluginCommands: vi.fn().mockResolvedValue([]),
  executeCommand: vi.fn().mockResolvedValue({ success: true, message: 'Context compacted' }),
}))

vi.mock('@/editor/TextEditor.vue', () => ({
  default: {
    name: 'TextEditor',
    props: ['modelValue'],
    emits: ['update:modelValue', 'paste', 'keydown', 'focus', 'blur', 'heightChange', 'selectionChange', 'transaction', 'compositionstart', 'compositionend'],
    template: '<textarea class="composer-input" :value="modelValue" />',
    methods: {
      focus() {},
      scrollToTop() {},
      getSelection() { return { from: 0, to: 0 } },
      replaceRange() {},
      setValue() {},
    },
  },
}))

async function settle() {
  await nextTick()
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
}

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 30; i += 1) {
    await settle()
    if (predicate()) return
  }
  throw new Error('Timed out waiting for condition')
}

const mounted: VueWrapper[] = []

function mountInputBox() {
  const wrapper = mount(InputBox, {
    attachTo: document.body,
    props: { sessionId: 'session-1' },
    global: {
      stubs: {
        QuotedContext: { template: '<div />' },
        CommandPicker: { template: '<div />' },
        SkillPicker: { template: '<div />' },
        FilePicker: { template: '<div />' },
        PathPicker: { template: '<div />' },
        ModelSelector: { template: '<div />' },
        ThinkToggle: { template: '<div />' },
        Transition: false,
        TransitionGroup: false,
      },
    },
  })
  mounted.push(wrapper)
  return wrapper
}

beforeEach(() => {

  // 空间层(批 B9)从 ModelSelector / ThinkToggle / InputBox 一路读到这里,

  // 它住在 pinia 里 —— 独立挂载的组件测试也得有一个 pinia。

  setActivePinia(createPinia())
  const settings = createDefaultSettings()
  settings.ai.provider = 'openai'
  settings.ai.providers.openai.model = 'gpt-x'
  mocks.settingsStore = reactive({
    settings,
    saveSettings: vi.fn(),
    getCachedModels: vi.fn(() => [{ id: 'gpt-x', context_length: 200_000 }]),
  })
  mocks.sessionsStore = reactive({
    currentSessionId: 'session-1',
    sessionVariables: new Map(),
    sessions: [{
      id: 'session-1',
      workingDirectory: '/repo',
      contextSize: 82_000,
      totalInputTokens: 310_000,
      totalOutputTokens: 41_000,
      totalTokens: 351_000,
    }],
    getSessionItem: vi.fn((id: string) => mocks.sessionsStore.sessions.find((s: any) => s.id === id)),
    updateSessionPermissionMode: vi.fn(async () => ({ success: true })),
  })
  mocks.chatStore = reactive({
    sessionMessages: new Map(),
    isSessionGenerating: vi.fn(() => false),
    setComposerDraft: vi.fn(),
    getComposerDraft: vi.fn(() => null),
    clearComposerDraft: vi.fn(),
    isComposerDraftEmpty: vi.fn(() => true),
  })
  mocks.voiceStore = reactive({ isEnabled: false, isRecording: false, status: 'idle', stop: vi.fn() })
  mocks.promptsStore = reactive({ prompts: [], loadPrompts: vi.fn().mockResolvedValue([]) })
  mocks.musicStore = reactive({
    nowPlaying: null,
    radio: { active: false, intent: '', programmeLength: 0, canResume: false },
    livePosition: 0,
    progressRatio: 0,
    playerBackend: 'mpv',
    currentLyricLine: '',
    initialize: vi.fn().mockResolvedValue(undefined),
    useClock: vi.fn(() => () => {}),
    sendCommand: vi.fn().mockResolvedValue({ success: true }),
    setPlayer: vi.fn().mockResolvedValue({ success: true }),
  })

  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('window', Object.assign(window, {
    electronAPI: {
      listVariables: vi.fn().mockResolvedValue({ success: true, variables: [] }),
      getSessionUsage: vi.fn().mockResolvedValue({ apiCostUSD: 0, subscriptionCostUSD: 0 }),
    },
  }))
})

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('ctx 仪表 · 明细浮层', () => {
  it('仪表留在驾驶舱,收起时没有明细浮层', async () => {
    const wrapper = mountInputBox()
    await settle()

    expect(wrapper.find('.toolbar-left .context-meter').exists()).toBe(true)
    expect(document.body.querySelector('.context-detail-body')).toBeNull()
  })

  it('点击展开:窗口进度 + 真数字分项 + 自动压缩阈值 + 立即压缩', async () => {
    const wrapper = mountInputBox()
    await settle()

    await wrapper.find('.context-meter').trigger('click')
    await settle()

    const detail = document.body.querySelector('.context-detail-body')
    expect(detail).not.toBeNull()
    expect(detail?.querySelector('.context-detail-track')).not.toBeNull()
    const text = detail?.textContent ?? ''
    expect(text).toContain('200k 窗口')
    expect(text).toContain('82k / 200k')
    expect(text).toContain('本轮送入')
    expect(text).toContain('累计输入')
    expect(text).toContain('累计输出')
    expect(text).toContain('达到 85% 时自动压缩')
    expect(detail?.querySelector('.context-detail-action')).not.toBeNull()

    // 数据缺口如实呈现:没有按来源分账的口径,就不画那四行。
    for (const fake of ['历史消息', '工具定义', '附件与引用', '系统提示']) {
      expect(text).not.toContain(fake)
    }
  })

  it('「立即压缩」走既有 /compact 出口,不另开命令通道', async () => {
    vi.mocked(executeCommand).mockResolvedValue({ success: true, message: 'Context compacted' })
    const wrapper = mountInputBox()
    await settle()
    await wrapper.find('.context-meter').trigger('click')
    await settle()

    const action = document.body.querySelector('.context-detail-action') as HTMLElement
    action.click()
    await settle()

    expect(vi.mocked(executeCommand)).toHaveBeenCalledWith('compact', { sessionId: 'session-1' })
    // 压缩完浮层自己收起来。
    await waitFor(() => document.body.querySelector('.context-detail-body') === null)
  })

  it('自动压缩关掉时,阈值行说的是"已关闭"而不是编一个数', async () => {
    mocks.settingsStore.settings.chat.contextCompactEnabled = false
    const wrapper = mountInputBox()
    await settle()
    await wrapper.find('.context-meter').trigger('click')
    await settle()

    expect(document.body.querySelector('.context-detail-body')?.textContent).toContain('自动压缩已关闭')
  })
})
