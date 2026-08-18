// @vitest-environment happy-dom
/**
 * 右栏「Context」页签 —— 承自 `components/chat/__tests__/ChatSidePanel.test.ts`
 * 的后三段(System prompt / Todo / Variables)那几组用例(L3)。
 */
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SessionContextWorkbench from '../SessionContextWorkbench.vue'

const settingsStore = vi.hoisted(() => ({
  settings: {
    general: {
      todoPlan: {
        enabled: true,
      },
    },
  },
}))

const sessionsStore = vi.hoisted(() => ({
  isNewChatDraftId: vi.fn((sessionId: string) => sessionId.startsWith('draft:')),
  getSessionItem: vi.fn((sessionId: string) => ({
    id: sessionId,
    workingDirectory: '/repo',
    agentId: 'agent-1',
    lastProvider: 'claude',
    lastModel: 'opus',
  })),
}))

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => settingsStore,
}))

vi.mock('@/stores/sessions', () => ({
  useSessionsStore: () => sessionsStore,
}))

vi.mock('../SystemPromptPanel.vue', () => ({
  default: {
    name: 'SystemPromptPanel',
    props: ['sessionId', 'workingDirectory', 'agentId', 'lastProvider', 'lastModel'],
    template: '<div class="mock-system-prompt-panel" :data-workdir="workingDirectory" />',
    methods: {
      refreshSnapshot: vi.fn(),
    },
  },
}))

vi.mock('../TodoProgressPanel.vue', () => ({
  default: {
    name: 'TodoProgressPanel',
    template: '<div class="mock-todo-progress-panel" />',
  },
}))

vi.mock('../VariablesPanel.vue', () => ({
  default: {
    name: 'VariablesPanel',
    template: '<div class="mock-variables-panel" />',
  },
}))

async function settle() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

function focusedSections(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('.sctx-sec.focus').map(section =>
    section.find('.sctx-sum-title').text(),
  )
}

describe('SessionContextWorkbench', () => {
  beforeEach(() => {
    const storage: Record<string, string> = {}
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storage[key] = String(value)
      }),
      removeItem: vi.fn((key: string) => {
        delete storage[key]
      }),
    })
    settingsStore.settings.general.todoPlan.enabled = true
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders three elastic sections with the system prompt focused by default', async () => {
    const wrapper = mount(SessionContextWorkbench, { props: { sessionId: 'session-1' } })
    await settle()

    expect(wrapper.findAll('.sctx-sec')).toHaveLength(3)
    expect(focusedSections(wrapper)).toEqual(['System prompt'])
    // 子面板常驻挂载,未聚焦时也在(压成 0 高)
    expect(wrapper.find('.mock-system-prompt-panel').exists()).toBe(true)
    expect(wrapper.find('.mock-todo-progress-panel').exists()).toBe(true)
    expect(wrapper.find('.mock-variables-panel').exists()).toBe(true)
  })

  it('resolves the session from the store instead of taking it as props', async () => {
    const wrapper = mount(SessionContextWorkbench, { props: { sessionId: 'session-1' } })
    await settle()

    expect(sessionsStore.getSessionItem).toHaveBeenCalledWith('session-1')
    expect(wrapper.find('.mock-system-prompt-panel').attributes('data-workdir')).toBe('/repo')
  })

  it('moves focus on summary click and persists it', async () => {
    const wrapper = mount(SessionContextWorkbench, { props: { sessionId: 'session-1' } })
    await settle()

    const todoSummary = wrapper.findAll('.sctx-sum-main')
      .find(button => button.text().includes('Todo'))
    expect(todoSummary).toBeDefined()
    await todoSummary!.trigger('click')
    await settle()

    expect(focusedSections(wrapper)).toEqual(['Todo'])
    expect(localStorage.setItem).toHaveBeenCalledWith('workbenchContextSection', 'todo')
  })

  it('restores the persisted focused section', async () => {
    localStorage.setItem('workbenchContextSection', 'variables')

    const wrapper = mount(SessionContextWorkbench, { props: { sessionId: 'session-1' } })
    await settle()

    expect(focusedSections(wrapper)).toEqual(['Variables'])
  })

  it('drops the todo section when todo is disabled', async () => {
    settingsStore.settings.general.todoPlan.enabled = false
    localStorage.setItem('workbenchContextSection', 'todo')

    const wrapper = mount(SessionContextWorkbench, { props: { sessionId: 'session-1' } })
    await settle()

    expect(wrapper.findAll('.sctx-sec')).toHaveLength(2)
    expect(focusedSections(wrapper)).toEqual(['System prompt'])
  })

  it('does not mount session-backed prompt or todo panels for a new chat draft', async () => {
    const wrapper = mount(SessionContextWorkbench, { props: { sessionId: 'draft:one' } })
    await settle()

    expect(wrapper.find('.mock-system-prompt-panel').exists()).toBe(false)
    expect(wrapper.find('.mock-todo-progress-panel').exists()).toBe(false)
    expect(wrapper.find('.mock-variables-panel').exists()).toBe(false)
    expect(wrapper.findAll('.sctx-sec')).toHaveLength(1)
    expect(wrapper.find('.sctx-draft-state').text()).toBe('System prompt will appear after the chat starts.')
    expect(wrapper.find('.sctx-icon-button').attributes('disabled')).toBeDefined()
  })

  it('shows the todo live summary from panel progress events', async () => {
    const wrapper = mount(SessionContextWorkbench, { props: { sessionId: 'session-1' } })
    await settle()

    const todoPanel = wrapper.findComponent({ name: 'TodoProgressPanel' })
    todoPanel.vm.$emit('progressChange', { done: 4, total: 7, currentText: 'Fix crash recovery' })
    await settle()

    const todoSummary = wrapper.find('.sctx-todo-section .sctx-sum-live')
    expect(todoSummary.text()).toBe('4/7 · Fix crash recovery')
  })

  it('shows the variables live summary from panel summary events', async () => {
    const wrapper = mount(SessionContextWorkbench, { props: { sessionId: 'session-1' } })
    await settle()

    const variablesPanel = wrapper.findComponent({ name: 'VariablesPanel' })
    variablesPanel.vm.$emit('summaryChange', '5 · workdir')
    await settle()

    const variablesSummary = wrapper.find('.sctx-variables-section .sctx-sum-live')
    expect(variablesSummary.text()).toBe('5 · workdir')
  })

  it('falls back to the system prompt when variables focus is stored but session is a draft', async () => {
    localStorage.setItem('workbenchContextSection', 'variables')

    const wrapper = mount(SessionContextWorkbench, { props: { sessionId: 'draft:one' } })
    await settle()

    expect(focusedSections(wrapper)).toEqual(['System prompt'])
  })

  /** Todo 段只留入口不留编辑:清单本身归 Todo 窗 /「任务」页签。 */
  it('sends the todo section to the tasks panel instead of editing in place', async () => {
    const wrapper = mount(SessionContextWorkbench, { props: { sessionId: 'session-1' } })
    await settle()

    const todoSummary = wrapper.findAll('.sctx-sum-main')
      .find(button => button.text().includes('Todo'))
    await todoSummary!.trigger('click')
    await settle()

    const opened: Array<Event> = []
    const listener = (event: Event) => opened.push(event)
    window.addEventListener('todo-plan:web-window-action', listener)

    const entry = wrapper.find('.sctx-todo-section .sctx-icon-button')
    expect(entry.exists()).toBe(true)
    await entry.trigger('click')
    window.removeEventListener('todo-plan:web-window-action', listener)

    expect(opened).toHaveLength(1)
    expect((opened[0] as CustomEvent).detail).toEqual({ action: 'open' })
    // 面板本体不提供编辑入口(没有输入框 / 复选框)。
    expect(wrapper.find('.sctx-todo-section input').exists()).toBe(false)
  })
})
