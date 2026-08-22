// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RightWorkbenchPanel from '../RightWorkbenchPanel.vue'

const mocks = vi.hoisted(() => ({
  editorWorkspace: {
    setWorkspaceRoot: vi.fn().mockResolvedValue(undefined),
    openFile: vi.fn().mockResolvedValue(undefined),
  },
  openSession: vi.fn(),
  electronAPI: {
    listVariables: vi.fn(),
  },
  // terminal 域已迁到通用 RPC 通道(P4 终态批 D2):面板经 store 用的是壳外客户端
  // `@/platform/terminal-client`,不再是 platformApi 上的 listTerminals/createTerminal。
  terminalApi: {
    list: vi.fn(),
    create: vi.fn(),
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    attach: vi.fn(),
    ack: vi.fn(),
  },
}))

vi.mock('@/composables/useEditorWorkspace', () => ({
  useEditorWorkspace: () => mocks.editorWorkspace,
}))

vi.mock('@/platform/terminal-client', () => ({ terminalApi: mocks.terminalApi }))

vi.mock('@/components/terminal/TerminalView.vue', () => ({
  default: { name: 'TerminalView', props: ['terminalId'], template: '<div class="mock-terminal-view" />' },
}))

vi.mock('../ThreadChatDetail.vue', () => ({
  default: { name: 'ThreadChatDetail', props: ['sessionId'], template: '<div class="mock-thread" />' },
}))

vi.mock('@/components/editor/EditorWorkbench.vue', () => ({
  default: { name: 'EditorWorkbench', props: ['workspaceRoot'], template: '<div class="mock-editor" />' },
}))

// 面板契约只有两条:绑哪间房、停在哪一层。里面那两层的行为由
// MembersWorkbench 自己的单测盯住。
vi.mock('@/components/agents/AgentSpace.vue', () => ({
  default: {
    name: 'AgentSpace',
    props: ['agentId', 'showBack', 'backLabel', 'initialTab', 'work'],
    emits: ['back', 'open-session', 'open-file', 'open-thread'],
    template: `<div class="mock-agent-space">{{ agentId }}|{{ initialTab || '' }}
      <button class="mock-space-session" @click="$emit('open-session', 'sess-7')" /></div>`,
  },
}))

vi.mock('@/stores/agents', () => ({
  DEFAULT_AGENT_ID: 'default',
  useAgentsStore: () => ({
    displayAgent: (id: string) => ({ id, name: id === 'lin' ? '小林' : '已注销' }),
  }),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: () => ({ openSession: mocks.openSession }),
}))

vi.mock('../MembersWorkbench.vue', () => ({
  default: {
    name: 'MembersWorkbench',
    props: ['sessionId', 'focusAgentId'],
    emits: ['focus'],
    template: `
      <div class="mock-members">
        {{ sessionId }}|{{ focusAgentId }}
        <button class="mock-drill" @click="$emit('focus', 'lin')">drill</button>
        <button class="mock-back" @click="$emit('focus', '')">back</button>
      </div>
    `,
  },
}))

interface PanelApi {
  openMembers: (sessionId: string, agentId?: string, title?: string) => void
  openThread: (sessionId: string, title?: string) => void
  openAgentTab: (agentId: string, tab?: string | null) => void
}

async function settle() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

function mountPanel() {
  const wrapper = mount(RightWorkbenchPanel, { props: { sessionId: 'room-1', workspaceRoot: '/repo' } })
  return { wrapper, api: wrapper.vm as unknown as PanelApi }
}

describe('RightWorkbenchPanel — 成员 tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    mocks.electronAPI.listVariables.mockResolvedValue({ success: true, variables: [] })
    mocks.terminalApi.list.mockResolvedValue({ success: true, terminals: [] })
    Object.defineProperty(window, 'electronAPI', { value: mocks.electronAPI, configurable: true })
  })

  it('openMembers 开一个绑房的「成员」页签', async () => {
    const { wrapper, api } = mountPanel()
    api.openMembers('room-1')
    await settle()

    expect(wrapper.findAll('.mock-members')).toHaveLength(1)
    expect(wrapper.find('.mock-members').text()).toContain('room-1')
    expect(wrapper.find('.workbench-tab-label').text()).toContain('成员')
  })

  it('同一类型永不开出第二个:换房是换它的靶子,不是再加一条页签', async () => {
    const { wrapper, api } = mountPanel()
    api.openMembers('room-1')
    await settle()
    api.openMembers('room-2')
    await settle()

    expect(wrapper.findAll('.mock-members')).toHaveLength(1)
    expect(wrapper.find('.mock-members').text()).toContain('room-2')
  })

  it('带 agentId = 直接停在空间页;下钻不占第二个 tab 位', async () => {
    const { wrapper, api } = mountPanel()
    api.openMembers('room-1', 'lin', '空间')
    await settle()

    expect(wrapper.findAll('.mock-members')).toHaveLength(1)
    expect(wrapper.find('.mock-members').text()).toContain('room-1|lin')
    expect(wrapper.find('.workbench-tab-label').text()).toContain('空间')
  })

  it('面板里下钻/返回的落点写回 tab,关掉再开回来停在同一层', async () => {
    const { wrapper, api } = mountPanel()
    api.openMembers('room-1')
    await settle()

    await wrapper.find('.mock-drill').trigger('click')
    await settle()
    // 同一个 tab、同一份记忆 —— 重新派一次事件不该把它甩回列表以外的地方。
    api.openMembers('room-1', 'lin')
    await settle()
    expect(wrapper.findAll('.mock-members')).toHaveLength(1)
    expect(wrapper.find('.mock-members').text()).toContain('room-1|lin')

    await wrapper.find('.mock-back').trigger('click')
    await settle()
    api.openMembers('room-1')
    await settle()
    expect(wrapper.find('.mock-members').text()).toContain('room-1|')
  })

  it('成员与线程是两个页签,互不吞并', async () => {
    const { wrapper, api } = mountPanel()
    api.openMembers('room-1')
    await settle()
    api.openThread('work-1', '换核验证')
    await settle()

    expect(wrapper.findAll('.mock-members')).toHaveLength(1)
    expect(wrapper.findAll('.workbench-tab-label')).toHaveLength(2)
  })

  it('picker 里开不出空成员表(必须带着靶子进来)', async () => {
    const { wrapper } = mountPanel()
    await settle()
    const labels = wrapper.findAll('.empty-action').map(node => node.text())
    expect(labels).not.toContain('成员')
  })

  /* 房外的人(直聊助理 / 已退休同事)落在自己的页签上
     —— agent-space-workbench.md P1 的另一半分流。 */
  it('openAgentTab 开一个以 TA 命名的页签,同一个人反复点只聚焦', async () => {
    const { wrapper, api } = mountPanel()
    api.openAgentTab('lin')
    await settle()
    api.openAgentTab('lin', 'files')
    await settle()

    expect(wrapper.findAll('.mock-agent-space')).toHaveLength(1)
    expect(wrapper.find('.mock-agent-space').text()).toContain('lin|files')
    expect(wrapper.find('.workbench-tab-label').text()).toContain('小林')
  })

  it('空间页里的会话行在主区开页签,右栏原地不动', async () => {
    const { wrapper, api } = mountPanel()
    api.openAgentTab('lin')
    await settle()

    await wrapper.find('.mock-space-session').trigger('click')
    expect(mocks.openSession).toHaveBeenCalledWith('sess-7')
    expect(wrapper.findAll('.mock-agent-space')).toHaveLength(1)
  })
})
