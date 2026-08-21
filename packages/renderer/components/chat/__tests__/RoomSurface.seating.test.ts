// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RoomSurface from '../room/RoomSurface.vue'

/**
 * 进房落座 —— 房面对右栏说的唯一一句话。
 *
 * **2026-08-02 重写**:这个文件原来守的是两条已经被推翻的纪律,两条断言红、
 * 第三条假绿(它断言"什么都不发",而新契约下那两个旧事件本来就再也不会发):
 *
 *  - 旧:私聊派 `OPEN_MEMBERS_EVENT`、群聊派 `onething:open-thread`,两个事件。
 *    新:合并成一个 `onething:room-workbench`,detail 带
 *    `{ roomSessionId, workSessionId?, dmAgentId? }` —— 右栏自己决定落在哪一页。
 *  - 旧:右栏收着就不落座(不许由房面把右栏顶开)。
 *    新:照发。理由写在 `seatDefaultThread` 的注释里,是真机走查换来的:
 *    那道闸与"看板上没有在跑的卡就不派事件"叠起来,让线程**永远不出现**,
 *    用户第一句话就是"我看不到线程"。开合仍归右栏自己的窗宽策略管。
 *
 * 所以这里守的是新契约的三件事:事件只有一个、靶子拿得到就带上、拿不到也照发。
 */
const mocks = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  board: undefined as unknown,
  inspectorOpen: true,
}))

vi.mock('@/platform', () => ({
  platformApi: { emitCommand: vi.fn() },
}))
vi.mock('@/platform/collab-client', () => ({
  collabApi: { messageReact: vi.fn() },
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
  useSessionsStore: () => ({ currentSessionId: 'room-1', sessions: [mocks.session] }),
}))

vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({
    get inspectorOpen() { return mocks.inspectorOpen },
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
  useCollabBoardStore: () => ({ ensureSubscribed: vi.fn(), boardFor: () => mocks.board }),
}))

vi.mock('@/stores/agents', () => ({
  useAgentsStore: () => ({
    displayAgent: (agentId?: string | null) => ({ id: agentId || '', name: '小林' }),
    openAgentSpace: vi.fn(),
  }),
}))

vi.mock('@/composables/useChatSession', () => ({
  useChatSession: () => ({
    messages: ref([]),
    isLoading: ref(false),
    isGenerating: ref(false),
    sendMessage: vi.fn(),
    steerMessage: vi.fn(),
    queueFollowUpMessage: vi.fn(),
    stopGeneration: vi.fn(),
  }),
}))

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

const ROOM_WORKBENCH_EVENT = 'onething:room-workbench'

function capture() {
  const seated: unknown[] = []
  const onSeat = (event: Event) => seated.push((event as CustomEvent).detail)
  window.addEventListener(ROOM_WORKBENCH_EVENT, onSeat)
  return {
    seated,
    stop() {
      window.removeEventListener(ROOM_WORKBENCH_EVENT, onSeat)
    },
  }
}

describe('RoomSurface — 右栏默认落座', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.inspectorOpen = true
    mocks.board = undefined
  })

  it('私聊:带上那位同事的 id,右栏据此落到空间页', () => {
    mocks.session = { id: 'room-1', name: '小林', kind: 'room', room: { memberAgentIds: ['a1'], dm: true } }
    const seen = capture()
    const wrapper = mount(RoomSurface, { props: { sessionId: 'room-1' } })
    seen.stop()

    expect(seen.seated).toEqual([
      { roomSessionId: 'room-1', workSessionId: undefined, dmAgentId: 'a1' },
    ])
    wrapper.unmount()
  })

  it('群聊:带上在跑那张卡的工作会话,不带 dmAgentId', () => {
    mocks.session = { id: 'room-1', name: '浏览器重构', kind: 'room', room: { memberAgentIds: ['a1', 'a2'] } }
    mocks.board = {
      tasks: [{ id: 'task-abcdefgh', title: '换核验证', status: 'doing', workSessionIds: ['w1'], updatedAt: 1 }],
    }
    const seen = capture()
    const wrapper = mount(RoomSurface, { props: { sessionId: 'room-1' } })
    seen.stop()

    expect(seen.seated).toEqual([
      { roomSessionId: 'room-1', workSessionId: 'w1', dmAgentId: undefined },
    ])
    wrapper.unmount()
  })

  /**
   * 这一条是那次真机走查的结论,拿测试钉住:**靶子拿不到也要照发**。
   * 从前"看板上没有在跑且开过工作台的卡就不派事件",于是一间还没跑过活的房,
   * 右栏里一条线程都没有。空线程是个真答案 —— ThreadWorkbench 自己会说
   * "还没有执行记录"，而一个什么都不显示的右栏只会让人以为功能坏了。
   */
  it('群聊 · 看板还是空的:照样落座,只是没有靶子', () => {
    mocks.session = { id: 'room-1', name: '浏览器重构', kind: 'room', room: { memberAgentIds: ['a1', 'a2'] } }
    mocks.board = { tasks: [] }
    const seen = capture()
    const wrapper = mount(RoomSurface, { props: { sessionId: 'room-1' } })
    seen.stop()

    expect(seen.seated).toEqual([
      { roomSessionId: 'room-1', workSessionId: undefined, dmAgentId: undefined },
    ])
    wrapper.unmount()
  })

  /**
   * 右栏开合归右栏自己的窗宽策略(`resolveInspectorDefaultOpen`)管,房面不看它。
   * 旧纪律"右栏收着就不落座"已推翻——它与上一条那道闸叠起来,是线程永远不出现的
   * 直接原因。
   */
  it('右栏收着也照发 —— 开不开不是房面的事', () => {
    mocks.inspectorOpen = false
    mocks.session = { id: 'room-1', name: '小林', kind: 'room', room: { memberAgentIds: ['a1'], dm: true } }
    const seen = capture()
    const wrapper = mount(RoomSurface, { props: { sessionId: 'room-1' } })
    seen.stop()

    expect(seen.seated).toHaveLength(1)
    wrapper.unmount()
  })
})
