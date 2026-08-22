// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RoomSurface from '../room/RoomSurface.vue'

/**
 * 权限账页栏位在房面上的**语义等价**(§8 铁律 1:一个像素、一个字段都不许变)。
 *
 * 钉的是"新面自带审批,而且自带的是同一个东西":
 *  1. 栏位就在 composer 上方(中栏底部),不在右栏;
 *  2. 字段行 tool / target / scope 与旧壳同名同序;collab 会话只给 once;
 *  3. ALLOW 走 `command:permission-respond` + **toolCallId**(耐久相关键);
 *  4. REJECT 开拒绝理由框,写了理由就带理由发;
 *  5. Enter = 允许一次,Esc/D = 拒绝(与旧壳同一个 composable)。
 */
const mocks = vi.hoisted(() => ({
  messages: [] as any[],
  // 命令总线是 `session-command` RPC 域(结构债 P4c 第四批),不再是 platformApi 上的属性。
  emit: vi.fn().mockResolvedValue({ success: true }),
}))

vi.mock('@/platform', () => ({ platformApi: {} }))
vi.mock('@/platform/session-command-client', () => ({
  sessionCommands: { emit: mocks.emit },
}))
vi.mock('@/platform/collab-client', () => ({
  collabApi: { messageReact: vi.fn().mockResolvedValue({ success: true }) },
}))

// 房面只在 workbench 下挂载;这里给排版退让闸(shouldUseSayTypography)喂一份
// 出厂默认的设置——用户没有显式排版选择,聊天面档因此生效。真 store 在模块
// 作用域读 localStorage,测试里不能直接引。
vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({
    settings: { ui: { shellMode: 'workbench' }, general: {}, chat: {} },
  }),
}))

vi.mock('@/stores/sessions', () => ({
  useSessionsStore: () => ({
    currentSessionId: 'room-1',
    sessions: [{ id: 'room-1', name: '浏览器重构', kind: 'room', messageCount: mocks.messages.length }],
  }),
}))

vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({
    getSessionPageState: () => undefined,
    getScrollVersion: () => 0,
    getSnapshot: () => null,
    saveSnapshot: vi.fn(),
    loadInitialMessagePage: vi.fn(),
    loadOlderMessages: vi.fn().mockResolvedValue(false),
    loadNewerMessages: vi.fn().mockResolvedValue(false),
  }),
}))

// 提问账本(E2):composer 上方那条提问栏位自己读它,房面只给 sessionId。
vi.mock('@/stores/interactions', () => ({
  useInteractionsStore: () => ({
    ensureForSession: vi.fn(),
    pendingFor: () => [],
    respond: vi.fn(),
    decline: vi.fn(),
  }),
}))
vi.mock('@/stores/collabBoard', () => ({
  useCollabBoardStore: () => ({ ensureSubscribed: vi.fn(), boardFor: () => undefined }),
}))

vi.mock('@/stores/agents', () => ({
  useAgentsStore: () => ({
    displayAgent: (agentId?: string | null) => ({ id: agentId || '', name: '小林' }),
    openAgentSpace: vi.fn(),
  }),
}))

vi.mock('@/composables/useChatSession', () => ({
  useChatSession: () => ({
    messages: ref(mocks.messages),
    isLoading: ref(false),
    isGenerating: ref(false),
    sendMessage: vi.fn(),
    steerMessage: vi.fn(),
    queueFollowUpMessage: vi.fn(),
    stopGeneration: vi.fn(),
  }),
}))

// 只画的壳件全部打桩:这一组只关心审批栏位。
vi.mock('../say/SayChatFlow.vue', () => ({
  default: { name: 'SayChatFlow', template: '<div class="mock-say-flow" />' },
}))
vi.mock('../InputBox.vue', () => ({
  default: {
    name: 'InputBox',
    setup(_props: unknown, { expose }: { expose: (api: Record<string, unknown>) => void }) {
      expose({
        focus: vi.fn(),
        insertPromptReference: vi.fn(),
        clearInput: vi.fn(),
        restoreSnapshot: vi.fn(),
        getMessageInput: () => '',
        getQuotedText: () => '',
        getAttachments: () => [],
      })
      return {}
    },
    template: '<div class="mock-input-box" />',
  },
}))
vi.mock('../CollabTypingLine.vue', () => ({
  default: { name: 'CollabTypingLine', template: '<div class="mock-typing" />' },
}))
vi.mock('../BackgroundJobsStatusBar.vue', () => ({
  default: { name: 'BackgroundJobsStatusBar', template: '<div class="mock-jobs" />' },
}))
vi.mock('../ComposerReplyBar.vue', () => ({
  default: { name: 'ComposerReplyBar', template: '<div class="mock-reply" />' },
}))

function pendingToolCall(overrides: Record<string, unknown> = {}) {
  return {
    id: 'call-77',
    permissionId: 'perm-9',
    toolName: 'bash',
    toolId: 'bash',
    status: 'pending',
    requiresConfirmation: true,
    canRespond: true,
    arguments: { command: 'rm -rf .vite/deps && bun run dev' },
    ...overrides,
  }
}

function seedMessages(toolCalls: any[]) {
  mocks.messages.splice(0, mocks.messages.length, {
    id: 'm1',
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    toolCalls,
  })
}

/** 每个用例都要卸载:usePermissionShortcuts 挂的是 window 级监听,留一个就多一次应答。 */
const mounted: Array<{ unmount: () => void }> = []

function mountSurface() {
  const wrapper = mount(RoomSurface, { props: { sessionId: 'room-1' } })
  mounted.push(wrapper)
  return wrapper
}

async function settle() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

describe('RoomSurface 权限账页栏位', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedMessages([pendingToolCall()])
  })

  afterEach(() => {
    while (mounted.length) mounted.pop()?.unmount()
  })

  it('栏位在 composer 上方,字段与旧壳同名同序', async () => {
    const wrapper = mountSurface()
    await settle()

    const ledger = wrapper.find('.session-permission-panel')
    expect(ledger.exists()).toBe(true)

    const keys = ledger.findAll('.permission-key').map(node => node.text())
    expect(keys).toEqual(['tool', 'target', 'scope'])
    const values = ledger.findAll('.permission-row .permission-value').map(node => node.text())
    expect(values[0]).toBe('bash')
    expect(values[1]).toBe('rm -rf .vite/deps && bun run dev')

    // collab 会话:scope 只给 once(房间/任务维度的 grant 是 P2)。
    expect(ledger.findAll('.permission-scope-btn').map(node => node.text())).toEqual(['once'])

    // 位置:composer 容器里、InputBox 之前。
    const composer = wrapper.find('.room-composer')
    expect(composer.find('.session-permission-panel').exists()).toBe(true)
    const html = composer.html()
    expect(html.indexOf('session-permission-panel')).toBeLessThan(html.indexOf('mock-input-box'))
  })

  it('ALLOW 按 toolCallId 应答', async () => {
    const wrapper = mountSurface()
    await settle()

    await wrapper.find('.permission-btn.allow').trigger('click')
    await settle()

    expect(mocks.emit).toHaveBeenCalledWith({
      sessionId: 'room-1',
      command: {
        type: 'command:permission-respond',
        requestId: 'perm-9',
        toolCallId: 'call-77',
        decision: 'once',
      },
    })
  })

  it('REJECT 开拒绝理由框;写了理由就带理由发', async () => {
    const wrapper = mountSurface()
    await settle()

    await wrapper.find('.permission-btn.reject').trigger('click')
    await settle()
    // P2: the shell is `components/common/Dialog.vue`; only the body is local.
    const dialog = document.querySelector('.app-dialog') as HTMLElement | null
    expect(dialog).not.toBeNull()

    const textarea = document.querySelector('.reject-reason-input') as HTMLTextAreaElement
    textarea.value = '这条要先备份'
    textarea.dispatchEvent(new Event('input'))
    await settle()
    ;(document.querySelector('.reject-dialog-btn-confirm') as HTMLElement).click()
    await settle()

    expect(mocks.emit).toHaveBeenCalledWith({
      sessionId: 'room-1',
      command: {
        type: 'command:permission-respond',
        requestId: 'perm-9',
        toolCallId: 'call-77',
        decision: 'reject',
        rejectReason: '这条要先备份',
      },
    })
  })

  it('Enter = 允许一次(快捷键与旧壳同一条)', async () => {
    mountSurface()
    await settle()

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await settle()

    expect(mocks.emit).toHaveBeenCalledWith({
      sessionId: 'room-1',
      command: expect.objectContaining({
        toolCallId: 'call-77',
        decision: 'once',
      }),
    })
  })

  it('没有活的 prompt(canRespond=false)就不画栏位', async () => {
    seedMessages([pendingToolCall({ canRespond: false })])
    const wrapper = mountSurface()
    await settle()

    expect(wrapper.find('.session-permission-panel').exists()).toBe(false)
  })

  it('脚注报出排在后面的调用数', async () => {
    seedMessages([
      pendingToolCall(),
      { id: 'call-78', status: 'queued', toolName: 'read', toolId: 'read', arguments: {} },
      { id: 'call-79', status: 'queued', toolName: 'read', toolId: 'read', arguments: {} },
    ])
    const wrapper = mountSurface()
    await settle()

    expect(wrapper.find('.permission-hint').text()).toBe('2 queued behind this permission')
  })
})
