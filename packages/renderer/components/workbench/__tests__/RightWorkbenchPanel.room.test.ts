// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RightWorkbenchPanel from '../RightWorkbenchPanel.vue'
import { OPEN_ROOM_SCHEDULE_EVENT } from '../room-schedule'

/**
 * 右栏收敛(2026-08-04,走查 F2c):**只有一套面板系统** —— 工作台页签。
 *
 * 从前这里钉的是"两形态分岔"(房里画 `RoomBackstagePanel`,其余画页签)。两套
 * 并存的代价是房里够不着页签那一层:群 folder 开出的 files 页签画在被盖住的那
 * 一面上,按钮点了、页签开了、用户什么也看不见(走查 F2)。背台整体退役。
 *
 * 这一份钉四件事:
 *  1. 进房自动备齐固定页签组(线程 / 成员 / 看板 / 调度),默认落在线程;
 *  2. 私聊房三条,**没有看板**;
 *  3. 四个外部入口各自打开对应的那一条;
 *  4. **群 folder → files 页签在房里真的看得见**(F2 的最终验收)。
 */
const mocks = vi.hoisted(() => ({
  editorWorkspace: {
    setWorkspaceRoot: vi.fn().mockResolvedValue(undefined),
    openFile: vi.fn().mockResolvedValue(undefined),
  },
  electronAPI: {
    listVariables: vi.fn(),
  },
  sessions: [] as Array<Record<string, unknown>>,
  generating: new Set<string>(),
  board: null as Record<string, unknown> | null,
  pendingAsks: new Set<string>(),
  unread: new Set<string>(),
  dmRooms: {} as Record<string, { id: string }>,
  coordinators: {} as Record<string, { deadLetterCount?: number }>,
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

vi.mock('@/stores/sessions', () => ({
  useSessionsStore: () => ({
    sessions: mocks.sessions,
    roomSessions: mocks.sessions.filter(session => session.kind === 'room'),
    findUserDmRoom: (agentId: string) => mocks.dmRooms[agentId],
    isUnreadSession: (id: string) => mocks.unread.has(id),
  }),
}))

/* 四颗状态点读的两本账(一个字段都不新增)。 */
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({ isSessionGenerating: (id: string) => mocks.generating.has(id) }),
}))

vi.mock('@/stores/collabBoard', () => ({
  useCollabBoardStore: () => ({
    ensureSubscribed: vi.fn(),
    load: vi.fn(),
    boardFor: () => mocks.board,
    hasPendingAsk: (id: string) => mocks.pendingAsks.has(id),
    coordinatorFor: (id: string) => mocks.coordinators[id] ?? null,
  }),
}))

/* 每一页的内容各有各的单测;这一层的契约是"有哪几条 / 在哪一条 / 亮不亮点"。 */
vi.mock('../RoomThreadsWorkbench.vue', () => ({
  default: {
    name: 'RoomThreadsWorkbench',
    props: ['roomSessionId', 'focusSessionId', 'grouped', 'backTo'],
    emits: ['focus', 'openFile', 'titleResolved'],
    template: '<div class="mock-threads">{{ roomSessionId }}|{{ focusSessionId }}|{{ grouped ? "grouped" : "flat" }}</div>',
  },
}))

vi.mock('../MembersWorkbench.vue', () => ({
  default: {
    name: 'MembersWorkbench',
    props: ['sessionId', 'focusAgentId', 'focusTab'],
    emits: ['focus', 'open-session', 'open-file', 'open-thread'],
    template: '<div class="mock-members">{{ sessionId }}|{{ focusAgentId }}</div>',
  },
}))

vi.mock('../RoomSchedulePanel.vue', () => ({
  default: {
    name: 'RoomSchedulePanel',
    props: ['roomSessionId', 'initialFilter', 'landingNonce'],
    template: '<div class="mock-schedule">{{ roomSessionId }}|{{ initialFilter }}|{{ landingNonce }}</div>',
  },
}))

/* 看板面板拖着整棵看板树;这一层只需要认出"开出了看板页"。 */
vi.mock('../CollabBoardPanel.vue', () => ({
  default: { name: 'CollabBoardPanel', template: '<div class="mock-board-panel" />' },
}))

vi.mock('@/components/editor/EditorWorkbench.vue', () => ({
  default: {
    name: 'EditorWorkbench',
    props: ['workspaceRoot', 'initialFilePath', 'active'],
    template: '<div class="mock-editor-workbench">{{ workspaceRoot }} {{ initialFilePath }}</div>',
  },
}))

vi.mock('@/components/terminal/TerminalView.vue', () => ({
  default: {
    name: 'TerminalView',
    props: ['terminalId'],
    template: '<div class="mock-terminal-view">{{ terminalId }}</div>',
  },
}))

const ROOM = { id: 'room-1', kind: 'room', room: { memberAgentIds: ['lin', 'che'] } }
const ROOM_2 = { id: 'room-2', kind: 'room', room: { memberAgentIds: ['lin'] } }
const DM_ROOM = { id: 'dm-1', kind: 'room', room: { dm: true, memberAgentIds: ['lin'] } }
const CHAT = { id: 'chat-1', kind: 'chat' }

type PanelApi = {
  openFile: (filePath: string) => Promise<void>
  openFolder: (root: string) => Promise<void>
  openThread: (sessionId: string, title?: string, roomSessionId?: string) => void
  openMembers: (roomSessionId: string, agentId?: string, title?: string) => void
  openBoard: () => void
  openRoomTabs: (roomSessionId: string, thread?: string, opts?: { dmAgentId?: string }) => void
  openAgentTab: (agentId: string) => void
}

async function settle() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

/** 页签条上的标签(顺序即页签顺序)。 */
function tabLabels(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll('.workbench-tab-label').map(label => label.text())
}

/** `v-show` 是内联 display:none —— 这一层用它判断"看得见的是哪一页"。 */
function visible(wrapper: ReturnType<typeof mount>, selector: string): boolean {
  const found = wrapper.find(selector)
  if (!found.exists()) return false
  let node: HTMLElement | null = found.element as HTMLElement
  while (node) {
    if (node.style.display === 'none') return false
    node = node.parentElement
  }
  return true
}

describe('RightWorkbenchPanel — 右栏只有一套面板系统', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    mocks.sessions = [{ ...ROOM }, { ...ROOM_2 }, { ...DM_ROOM }, { ...CHAT }]
    mocks.generating = new Set()
    mocks.board = { tasks: [] }
    mocks.pendingAsks = new Set()
    mocks.unread = new Set()
    mocks.dmRooms = {}
    mocks.coordinators = {}
    mocks.electronAPI.listVariables.mockResolvedValue({ success: true, variables: [] })
    mocks.terminalApi.list.mockResolvedValue({ success: true, terminals: [] })
    Object.defineProperty(window, 'electronAPI', { value: mocks.electronAPI, configurable: true })
  })

  it('背台已退役:房里画的就是工作台页签,没有第二套面板', async () => {
    const wrapper = mount(RightWorkbenchPanel, { props: { sessionId: 'room-1' } })
    await settle()
    expect(wrapper.find('.room-backstage').exists()).toBe(false)
    expect(wrapper.find('.seg-cell').exists()).toBe(false)
    expect(wrapper.find('.right-workbench-tabs').exists()).toBe(true)
  })

  it('进房自动备齐固定页签组(线程/成员/看板/调度),默认落在线程的列表层', async () => {
    const wrapper = mount(RightWorkbenchPanel, { props: { sessionId: 'room-1' } })
    await settle()
    expect(tabLabels(wrapper)).toEqual(['线程', '成员', '看板', '调度'])
    // 空的是内容,不是入口:一条线程都没有也有这一页
    expect(visible(wrapper, '.mock-threads')).toBe(true)
    expect(wrapper.find('.mock-threads').text()).toBe('room-1||grouped')
  })

  it('私聊房三条:线程 / 空间 / 调度 —— 没有看板', async () => {
    const wrapper = mount(RightWorkbenchPanel, { props: { sessionId: 'dm-1' } })
    await settle()
    expect(tabLabels(wrapper)).toEqual(['线程', '空间', '调度'])

    // 「空间」直接停在那一个人身上(一对一没有成员表)
    ;(wrapper.vm as unknown as PanelApi).openMembers('dm-1', 'lin')
    await settle()
    expect(wrapper.find('.mock-members').text()).toBe('dm-1|lin')

    // 私聊房请求看板 → 原地不动,不把人甩到 TA 没要的视图上
    ;(wrapper.vm as unknown as PanelApi).openBoard()
    await settle()
    expect(tabLabels(wrapper)).toEqual(['线程', '空间', '调度'])
  })

  it('群房切私聊房:看板那一条随形态撤掉,不留对不上号的页签', async () => {
    const wrapper = mount(RightWorkbenchPanel, { props: { sessionId: 'room-1' } })
    await settle()
    expect(tabLabels(wrapper)).toContain('看板')

    await wrapper.setProps({ sessionId: 'dm-1' })
    await settle()
    expect(tabLabels(wrapper)).toEqual(['线程', '空间', '调度'])
  })

  /**
   * 非房会话不备固定组 —— 判据只剩「是不是一间房」。外壳形态那道门(classic 下
   * 房里也不备)已随 shellMode 于 2026-08-05 退役,见
   * docs/design/product-two-forms-chatgpt-shell.md D2。
   */
  it('直聊不备固定组,只有既有工具页签', async () => {
    const wrapper = mount(RightWorkbenchPanel, {
      props: { sessionId: 'chat-1' },
    })
    await settle()
    expect(tabLabels(wrapper)).toEqual([])
    expect(wrapper.find('.workbench-empty-state').exists()).toBe(true)
  })

  it('换房 = 换靶子不是再开一页,并回线程的列表层', async () => {
    const wrapper = mount(RightWorkbenchPanel, { props: { sessionId: 'room-1' } })
    const api = wrapper.vm as unknown as PanelApi

    api.openThread('work-9', undefined, 'room-1')
    await settle()
    expect(wrapper.find('.mock-threads').text()).toContain('work-9')

    await wrapper.setProps({ sessionId: 'room-2' })
    await settle()
    expect(tabLabels(wrapper)).toEqual(['线程', '成员', '看板', '调度'])
    expect(wrapper.find('.mock-threads').text()).toBe('room-2||grouped')
  })

  it('四个外部入口各自打开对应的那一条', async () => {
    const wrapper = mount(RightWorkbenchPanel, { props: { sessionId: 'room-1' } })
    const api = wrapper.vm as unknown as PanelApi

    api.openMembers('room-1', 'lin')
    await settle()
    expect(visible(wrapper, '.mock-members')).toBe(true)
    expect(wrapper.find('.mock-members').text()).toBe('room-1|lin')

    api.openBoard()
    await settle()
    expect(visible(wrapper, '.mock-board-panel')).toBe(true)

    api.openThread('work-1', '换核验证', 'room-1')
    await settle()
    expect(visible(wrapper, '.mock-threads')).toBe(true)
    expect(wrapper.find('.mock-threads').text()).toContain('work-1')

    api.openRoomTabs('room-1')
    await settle()
    expect(wrapper.find('.mock-threads').text()).toBe('room-1||grouped')

    // 房外的人也走「成员/空间」页的下钻层,不另开一条
    api.openAgentTab('outsider')
    await settle()
    expect(wrapper.find('.mock-members').text()).toBe('room-1|outsider')
    expect(tabLabels(wrapper)).toEqual(['线程', '成员', '看板', '调度'])
  })

  /** 状态条那颗死信红点的落点(契约见 `room-schedule.ts`)。 */
  it('调度入口(死信红点)打开调度页并带上过滤;再点一次能重放', async () => {
    const wrapper = mount(RightWorkbenchPanel, { props: { sessionId: 'room-1' } })

    window.dispatchEvent(new CustomEvent(OPEN_ROOM_SCHEDULE_EVENT, {
      detail: { roomSessionId: 'room-1', filter: 'dead-letter' },
    }))
    await settle()
    expect(visible(wrapper, '.mock-schedule')).toBe(true)
    expect(wrapper.find('.mock-schedule').text()).toBe('room-1|dead-letter|1')

    window.dispatchEvent(new CustomEvent(OPEN_ROOM_SCHEDULE_EVENT, {
      detail: { roomSessionId: 'room-1', filter: 'dead-letter' },
    }))
    await settle()
    expect(wrapper.find('.mock-schedule').text()).toBe('room-1|dead-letter|2')

    // 别的房的红点管不到这一面
    window.dispatchEvent(new CustomEvent(OPEN_ROOM_SCHEDULE_EVENT, {
      detail: { roomSessionId: 'room-2', filter: '' },
    }))
    await settle()
    expect(wrapper.find('.mock-schedule').text()).toBe('room-1|dead-letter|2')
  })

  /**
   * 走查 F2 的最终验收。从前这一条**在房里够不着**:files 页签画在被房间背台
   * 盖住的那一层,于是"点了群 folder 什么也没发生"。
   */
  it('群 folder → files 页签在房里真的看得见(F2 端到端)', async () => {
    const wrapper = mount(RightWorkbenchPanel, { props: { sessionId: 'room-1' } })
    await (wrapper.vm as unknown as PanelApi).openFolder('/store/rooms/room-1')
    await settle()

    expect(tabLabels(wrapper)).toEqual(['线程', '成员', '看板', '调度', 'Files'])
    expect(visible(wrapper, '.mock-editor-workbench')).toBe(true)
    expect(wrapper.find('.mock-editor-workbench').text()).toContain('/store/rooms/room-1')
    expect(mocks.editorWorkspace.setWorkspaceRoot).toHaveBeenCalledWith('/store/rooms/room-1')
  })

  /**
   * 已经开着的按需页签**留在原地**(页签条的次序是 `Tabs.vue` 的注册次序,
   * 重排数组也搬不动它);这间房那几条补在后面,而且**看得见的是线程**。
   */
  it('进房补齐固定组,已开的按需页签留在原地,落座落在线程', async () => {
    const wrapper = mount(RightWorkbenchPanel, { props: { sessionId: 'chat-1' } })
    await (wrapper.vm as unknown as PanelApi).openFile('/repo/src/a.ts')
    await settle()
    expect(tabLabels(wrapper)).toEqual(['a.ts'])

    await wrapper.setProps({ sessionId: 'room-1' })
    await settle()
    expect(tabLabels(wrapper)).toEqual(['a.ts', '线程', '成员', '看板', '调度'])
    expect(visible(wrapper, '.mock-threads')).toBe(true)
    expect(visible(wrapper, '.mock-editor-workbench')).toBe(false)
  })

  /** 切走再切回来,按需页签的状态不许丢(不是销毁重建)。 */
  it('切到房再切回直聊:原来那个文件页签还是同一个 DOM 节点', async () => {
    const wrapper = mount(RightWorkbenchPanel, { props: { sessionId: 'chat-1' } })
    await (wrapper.vm as unknown as PanelApi).openFile('/repo/src/a.ts')
    await settle()
    const before = wrapper.find('.mock-editor-workbench').element

    await wrapper.setProps({ sessionId: 'room-1' })
    await settle()
    await wrapper.setProps({ sessionId: 'chat-1' })
    await settle()

    expect(wrapper.text()).toContain('a.ts')
    expect(wrapper.find('.mock-editor-workbench').element).toBe(before)
  })

  it('状态点长在页签上:线程绿 / 成员墨 / 看板橙 / 调度红,而且不显示计数', async () => {
    mocks.sessions = [
      { ...ROOM },
      { id: 'work-1', kind: 'work', agentId: 'lin', collab: { roomSessionId: 'room-1' } },
      { id: 'work-2', kind: 'work', agentId: 'che', collab: { roomSessionId: 'room-1' } },
    ]
    mocks.generating = new Set(['work-1', 'work-2'])
    mocks.board = {
      tasks: [{ id: 'a', status: 'blocked', workSessionIds: [], updatedAt: 1, rev: 1, title: 'x', rejections: 0 }],
    }
    mocks.dmRooms = { lin: { id: 'dm-lin' } }
    mocks.unread = new Set(['dm-lin'])
    mocks.coordinators = { 'room-1': { deadLetterCount: 3 } }

    const wrapper = mount(RightWorkbenchPanel, { props: { sessionId: 'room-1' } })
    await settle()
    const dots = wrapper.findAll('.workbench-tab-label').map(label => {
      const dot = label.find('.workbench-tab-dot')
      return dot.exists() ? dot.classes().find(name => name.startsWith('is-')) : null
    })
    expect(dots).toEqual(['is-run', 'is-new', 'is-wait', 'is-fault'])

    // 两条线程在跑、三封信炸了,但页签上都只有一颗点 —— 有没有,不是几个
    expect(wrapper.find('.right-workbench-tabs').text()).not.toContain('2')
    expect(wrapper.find('.right-workbench-tabs').text()).not.toContain('3')
  })
})
