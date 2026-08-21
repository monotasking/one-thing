// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import SchedulerPanelContent from '../SchedulerPanelContent.vue'

/**
 * P2: the task editor is `components/common/Dialog.vue`, which teleports to
 * `<body>` — so it is queried through the document, not through the wrapper.
 */
function editor(): HTMLElement | null {
  return document.querySelector('.app-dialog')
}

function editorButton(text: string): HTMLElement {
  const match = Array.from(editor()?.querySelectorAll('button') ?? [])
    .find(button => (button.textContent ?? '').includes(text))
  if (!match) throw new Error(`no button matching "${text}" in the task editor`)
  return match as HTMLElement
}

async function setEditorField(selector: string, value: string): Promise<void> {
  const field = editor()?.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement
  field.value = value
  field.dispatchEvent(new Event('input'))
  await nextTick()
}

const agentsStore = vi.hoisted(() => {
  const agent = {
    id: 'default',
    name: 'Default Agent',
    systemPrompt: '',
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
  }
  return {
    agents: [agent],
    // 执行者选择面只列在职的(agent-domain-model.md §3.2),署名走 displayAgent。
    activeAgents: [agent],
    retiredAgents: [] as Array<typeof agent>,
    defaultAgent: agent,
    displayAgent: (agentId?: string | null) =>
      agentId === agent.id ? agent : { id: agentId ?? '', name: '已注销', status: 'retired' },
    loadAgents: vi.fn(),
  }
})

vi.mock('@/stores/agents', () => ({
  useAgentsStore: () => agentsStore,
}))

const schedulerApi = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  runNow: vi.fn(),
  setEnabled: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  listRuns: vi.fn(),
  getRun: vi.fn(),
}))

// scheduler 域已迁到通用 RPC 通道(结构债 P4c):面板引的是壳外客户端
// `@/platform/scheduler-client`,不再是 platformApi 上的九个方法 —— 所以桩打这个
// 模块。会话那两条(归档 / 切换)仍在 platformApi 上,继续走 electronAPI。
vi.mock('@/platform/scheduler-client', () => ({ schedulerApi }))

describe('SchedulerPanelContent', () => {
  // The teleported editor outlives the wrapper unless the body is swept.
  afterEach(() => {
    document.body.innerHTML = ''
  })

  beforeEach(() => {
    vi.clearAllMocks()
    agentsStore.loadAgents.mockResolvedValue(agentsStore.agents)
    schedulerApi.list.mockResolvedValue({
      success: true,
      tasks: [
        {
          id: 'user:task-1',
          name: 'Morning news',
          kind: 'agent',
          source: 'user',
          readonly: false,
          agentId: 'default',
          prompt: 'Check the news',
          promptPreview: 'Check the news',
          enabled: true,
          schedule: { kind: 'cron', expr: '0 9 * * *' },
          tags: ['agent'],
          inFlight: false,
          runCount: 1,
          successCount: 1,
          failureCount: 0,
        },
      ],
    })
    schedulerApi.listRuns.mockResolvedValue({
      success: true,
      runs: [
        {
          runId: 'run-1',
          taskId: 'user:task-1',
          reason: 'manual',
          scheduledFor: 1,
          startedAt: 1,
          finishedAt: 1001,
          durationMs: 1000,
          ok: true,
          status: 'succeeded',
          resultPreview: 'Done',
          timeline: [{ id: 't1', timestamp: 1, type: 'run:finish', title: 'Done' }],
        },
      ],
    })
    schedulerApi.runNow.mockResolvedValue({ success: true })
    schedulerApi.setEnabled.mockResolvedValue({ success: true })
    schedulerApi.createTask.mockResolvedValue({
      success: true,
      task: {
        id: 'user:new-task',
        name: 'Morning digest',
        kind: 'agent',
        source: 'user',
        readonly: false,
        enabled: true,
        tags: ['agent'],
        inFlight: false,
        runCount: 0,
        successCount: 0,
        failureCount: 0,
      },
    })
    schedulerApi.updateTask.mockResolvedValue({
      success: true,
      task: {
        id: 'user:task-1',
        name: 'Morning news updated',
        kind: 'agent',
        source: 'user',
        readonly: false,
        enabled: true,
        tags: ['agent'],
        inFlight: false,
        runCount: 1,
        successCount: 1,
        failureCount: 0,
      },
    })
    Object.defineProperty(window, 'electronAPI', {
      value: {
        updateSessionArchived: vi.fn(),
        switchSession: vi.fn(),
      },
      configurable: true,
    })
  })

  it('shows tasks first and keeps run history folded until requested', async () => {
    const wrapper = mount(SchedulerPanelContent)
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('Morning news')
    })

    // P4: 列表头换成共享的 LedgerGroupHeader,分的是"我写的 / 系统内置"这条
    // 列表本来就在按 `readonly` 排的分界(启用状态那一维归控制条的筛选下拉)。
    expect(wrapper.find('.task-list-title').text()).toContain('我的任务')
    expect(schedulerApi.listRuns).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('Run detail')

    await wrapper.find('.history-toggle').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('Recent runs')
      expect(wrapper.text()).toContain('succeeded')
    })

    await wrapper.find('.run-row').trigger('click')
    expect(wrapper.text()).toContain('Run detail')
  })

  it('loads tasks when a lazily mounted panel becomes active', async () => {
    const wrapper = mount(SchedulerPanelContent, {
      props: { active: false },
    })

    await vi.waitFor(() => {
      expect(agentsStore.loadAgents).toHaveBeenCalled()
    })
    expect(schedulerApi.list).not.toHaveBeenCalled()

    await wrapper.setProps({ active: true })
    await vi.waitFor(() => {
      expect(schedulerApi.list).toHaveBeenCalledTimes(1)
      expect(wrapper.text()).toContain('Morning news')
    })
  })

  it('keeps task creation in a drawer instead of the main page hierarchy', async () => {
    const wrapper = mount(SchedulerPanelContent)
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('Morning news')
    })

    expect(wrapper.find('.editor-section').exists()).toBe(false)
    expect(editor()).toBeNull()

    await wrapper.findAll('button').find(button => button.text().includes('新建'))!.trigger('click')
    await vi.waitFor(() => {
      expect(editor()).not.toBeNull()
    })
    expect(wrapper.find('.tasks-layout').exists()).toBe(true)
    expect(wrapper.find('.editor-section').exists()).toBe(false)

    editorButton('close').click()
    await nextTick()
    expect(editor()).toBeNull()

    await wrapper.findAll('button').find(button => button.text().includes('新建'))!.trigger('click')
    await vi.waitFor(() => {
      expect(editor()).not.toBeNull()
    })

    await setEditorField('input[aria-label="Task name"]', 'Morning digest')
    await setEditorField('textarea[aria-label="Task prompt"]', 'Summarize the day ahead.')
    editorButton('create task').click()

    await vi.waitFor(() => {
      expect(schedulerApi.createTask).toHaveBeenCalled()
    })
    expect(schedulerApi.createTask).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'default',
      enabled: true,
      name: 'Morning digest',
      prompt: 'Summarize the day ahead.',
      schedule: expect.objectContaining({
        expr: '0 9 * * *',
        kind: 'cron',
      }),
    }))
  })

  it('edits an existing user task in the same drawer flow', async () => {
    const wrapper = mount(SchedulerPanelContent)
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('Morning news')
    })

    await wrapper.findAll('.overview-actions button').find(button => button.text().trim() === 'edit')!.trigger('click')
    await vi.waitFor(() => {
      expect(editor()).not.toBeNull()
    })
    expect(wrapper.find('.editor-section').exists()).toBe(false)
    expect(editor()!.textContent).toContain('Edit task')

    await setEditorField('input[aria-label="Task name"]', 'Morning news updated')
    editorButton('save changes').click()

    await vi.waitFor(() => {
      expect(schedulerApi.updateTask).toHaveBeenCalled()
    })
    expect(schedulerApi.updateTask).toHaveBeenCalledWith(expect.objectContaining({
      id: 'user:task-1',
      name: 'Morning news updated',
      prompt: 'Check the news',
      schedule: expect.objectContaining({
        expr: '0 9 * * *',
        kind: 'cron',
      }),
    }))
  })

  it('uses row switches for enablement', async () => {
    const wrapper = mount(SchedulerPanelContent)
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('Morning news')
    })

    const morningRow = wrapper.findAll('.task-row').find(row => row.text().includes('Morning news'))!
    expect(morningRow.exists()).toBe(true)
    const morningSwitch = morningRow.find('[role="switch"]')
    expect(morningSwitch.exists()).toBe(true)

    await morningSwitch.trigger('click')
    await vi.waitFor(() => {
      expect(schedulerApi.setEnabled).toHaveBeenCalledWith({
        id: 'user:task-1',
        enabled: false,
      })
    })
  })

  it('lays the row out on the shared 44px ledger shell', async () => {
    const wrapper = mount(SchedulerPanelContent)
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('Morning news')
    })

    const row = wrapper.findAll('.task-row').find(r => r.text().includes('Morning news'))!
    // 首列 38px mono 时间列:这条夹具没有 nextRunAt,推不出来就给破折号而不是留空
    expect(row.find('.plr-lead .task-time').text()).toBe('—')
    // 副行 = cron 原文 + 人话周期
    expect(row.find('.plr-meta').text()).toBe('0 9 * * * · Daily 09:00')
    // 行尾是开关,不再是自绘的墨点
    expect(row.find('.plr-trail [role="switch"]').exists()).toBe(true)
  })

  it('reports the schedule in the status bar and filters from the control bar', async () => {
    const wrapper = mount(SchedulerPanelContent)
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('Morning news')
    })

    expect(wrapper.find('.panel-shell-status').text()).toContain('1 个任务 · 无排期')

    await wrapper.find('.filter-search-input').setValue('nothing matches this')
    expect(wrapper.findAll('.task-row')).toHaveLength(0)
    expect(wrapper.text()).toContain('没有匹配的任务')
    expect(wrapper.find('.panel-shell-status').text()).toContain('0 个任务')

    // cron 原文也是可搜的
    await wrapper.find('.filter-search-input').setValue('0 9 * * *')
    expect(wrapper.findAll('.task-row')).toHaveLength(1)
  })

  it('does not render the retired Memory Dreaming configuration block', async () => {
    const wrapper = mount(SchedulerPanelContent)
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('Morning news')
    })

    expect(wrapper.text()).not.toContain('Memory Dreaming')
    expect(wrapper.find('.managed-section').exists()).toBe(false)
    expect(wrapper.find('input[aria-label="Dreaming cron"]').exists()).toBe(false)
  })
})
