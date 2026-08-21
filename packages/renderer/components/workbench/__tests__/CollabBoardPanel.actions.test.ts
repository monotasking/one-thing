// @vitest-environment happy-dom
/**
 * W16 panel behaviour: the card menu writes through COLLAB_BOARD_ACT, and the
 * W9b fields the board has carried since W9b (blockReason / haltedCount /
 * report.evidence) are finally on the card face.
 */
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollabBoard, CollabTask } from '@shared/ipc.js'
import CollabBoardPanel from '../CollabBoardPanel.vue'
import Tooltip from '@/components/common/Tooltip.vue'
import { useSessionsStore } from '@/stores/sessions'
import { useAgentsStore } from '@/stores/agents'
import { useCollabBoardStore } from '@/stores/collabBoard'

const mocks = vi.hoisted(() => ({
  platformApi: {
    onSessionEvent: vi.fn(() => () => {}),
    openPath: vi.fn(),
    getPendingPermissions: vi.fn(),
  },
  // collab 域已迁到通用 RPC 通道(P4a):方法名是 router 上的动词,入参是信封。
  collabApi: {
    boardGet: vi.fn(),
    boardAct: vi.fn(),
    roomSetFrozen: vi.fn(),
    roomSetBudgets: vi.fn(),
    // 群 folder 的根由后端答(F2):面板不读会话的 workingDirectory,也不拼路径。
    roomFolderList: vi.fn(),
  },
}))

// agents 域已迁到通用 RPC 通道(主线 T1 第二批):名册从壳外客户端来,不再挂在
// platformApi 上。桩打在客户端模块上,面板的 hydrate 才仍然被真的盯住。
const agentsApiMock = vi.hoisted(() => ({ listAgents: vi.fn() }))

vi.mock('@/platform', () => ({ platformApi: mocks.platformApi }))
vi.mock('@/platform/collab-client', () => ({ collabApi: mocks.collabApi }))
vi.mock('@/platform/agents-client', () => ({ agentsApi: agentsApiMock }))

const ROSTER = [
  { id: 'pm', name: '阿明', avatar: '📋' },
  { id: 'fe', name: '小李', avatar: '🔧' },
]

function card(patch: Partial<CollabTask> = {}): CollabTask {
  return {
    id: 'task-1',
    rev: 3,
    title: '写登录页',
    status: 'todo',
    createdBy: { type: 'user' },
    workSessionIds: [],
    rejections: 0,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }
}

function board(tasks: CollabTask[]): CollabBoard {
  return { version: 1, tasks }
}

async function settle() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

/**
 * `roomFolder` 走通道(F2):默认给一个 `/repo`,这正是「没设过工作目录的房也
 * 有 folder」的现场 —— 会话上**不**放 workingDirectory,面板照样拿得到根。
 * `roomFolder: null` 模拟 web 端 stub / 通道失败(降级:入口隐身)。
 */
async function mountPanel(tasks: CollabTask[], options: { roomFolder?: string | null } = {}) {
  mocks.collabApi.boardGet.mockResolvedValue({ success: true, board: board(tasks) })
  const folder = options.roomFolder === undefined ? '/repo' : options.roomFolder
  mocks.collabApi.roomFolderList.mockResolvedValue(
    folder === null
      ? { success: false, error: 'Not a room session' }
      : { success: true, folder, entries: [] },
  )
  const sessions = useSessionsStore()
  sessions.sessions = [{
    id: 'room-1',
    name: '产品群',
    kind: 'room',
    room: { memberAgentIds: ['pm', 'fe'], pmAgentId: 'pm' },
    messages: [],
    createdAt: 0,
    updatedAt: 0,
  }] as never
  const agents = useAgentsStore()
  agents.agents = ROSTER as never
  const wrapper = mount(CollabBoardPanel, { attachTo: document.body })
  await settle()
  return wrapper
}

/** Open the card's ⋯ menu and click the row whose label reads `label`. */
async function pick(wrapper: Awaited<ReturnType<typeof mountPanel>>, label: string) {
  await wrapper.find('.board-card-more').trigger('click')
  await settle()
  const row = document.querySelectorAll<HTMLButtonElement>('.app-context-item')
  const target = [...row].find(item => item.textContent?.trim() === label)
  expect(target, `menu row 「${label}」`).toBeTruthy()
  target?.click()
  await settle()
}

describe('CollabBoardPanel card actions (W16)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    // The panel hydrates the agent roster on setup — an empty reply here would
    // overwrite the seeded names and every menu row would fall back to the id.
    agentsApiMock.listAgents.mockResolvedValue({ success: true, agents: ROSTER })
    mocks.platformApi.onSessionEvent.mockReturnValue(() => {})
    mocks.collabApi.boardAct.mockResolvedValue({ success: true, board: board([]) })
    mocks.platformApi.getPendingPermissions.mockResolvedValue({ success: true, pending: [] })
    mocks.collabApi.roomSetFrozen.mockResolvedValue({ success: true })
    mocks.collabApi.roomSetBudgets.mockResolvedValue({ success: true })
  })

  it('moves a card through the IPC with the rev the user saw', async () => {
    const wrapper = await mountPanel([card()])
    await pick(wrapper, '移到 完成')
    expect(mocks.collabApi.boardAct).toHaveBeenCalledWith({
      roomSessionId: 'room-1',
      action: {
        action: 'move',
        taskId: 'task-1',
        status: 'done',
        expectedRev: 3,
      },
    })
  })

  it('assigns to a room member picked by name', async () => {
    const wrapper = await mountPanel([card()])
    await pick(wrapper, '指派给 🔧 小李')
    expect(mocks.collabApi.boardAct).toHaveBeenCalledWith({
      roomSessionId: 'room-1',
      action: {
        action: 'assign',
        taskId: 'task-1',
        assigneeAgentId: 'fe',
        expectedRev: 3,
      },
    })
  })

  it('re-queues a blocked card back to todo (the W9b.1 requeue signal)', async () => {
    const wrapper = await mountPanel([card({ status: 'blocked', assigneeAgentId: 'fe', rev: 5 })])
    await pick(wrapper, '重新排队')
    expect(mocks.collabApi.boardAct).toHaveBeenCalledWith({
      roomSessionId: 'room-1',
      action: {
        action: 'move',
        taskId: 'task-1',
        status: 'todo',
        expectedRev: 5,
      },
    })
  })

  it('repaints from the returned board and says so on a rev conflict', async () => {
    const wrapper = await mountPanel([card()])
    mocks.collabApi.boardAct.mockResolvedValue({
      success: false,
      error: 'Task task-1 changed (rev 7) — re-read the board (action:"list") and retry with the current rev',
      board: board([card({ rev: 7, title: '写登录页(已被改名)', status: 'doing' })]),
    })
    await pick(wrapper, '移到 完成')
    expect(wrapper.find('.board-hint').text()).toBe('看板已被他人更新,已刷新')
    expect(wrapper.text()).toContain('写登录页(已被改名)')
  })

  it('shows a non-conflict refusal verbatim instead of the refresh line', async () => {
    const wrapper = await mountPanel([card()])
    mocks.collabApi.boardAct.mockResolvedValue({ success: false, error: 'Not a room session' })
    await pick(wrapper, '移到 完成')
    expect(wrapper.find('.board-hint').text()).toBe('Not a room session')
  })

  /**
   * 写路径经 store action(架构收敛 C4 §4)。
   *
   * 桩掉 action 之后桥应该一次都不被碰到 —— 这就是"回填约定有落点"的可执行
   * 证据:面板不再自己知道写完要 applySnapshot,新加一个写入点也漏不掉。
   */
  it('writes through the board store action, not the bridge', async () => {
    const boardStore = useCollabBoardStore()
    const actBoard = vi.spyOn(boardStore, 'actBoard')
      .mockResolvedValue({ success: true, board: board([]) } as never)
    const wrapper = await mountPanel([card()])

    await pick(wrapper, '移到 完成')

    expect(actBoard).toHaveBeenCalledWith('room-1', {
      action: 'move',
      taskId: 'task-1',
      status: 'done',
      expectedRev: 3,
    })
    expect(mocks.collabApi.boardAct).not.toHaveBeenCalled()
  })

  it('stops a running card through the board store action', async () => {
    const boardStore = useCollabBoardStore()
    const stopTask = vi.spyOn(boardStore, 'stopTask')
      .mockResolvedValue({ success: true, stopped: true } as never)
    const wrapper = await mountPanel([card({ status: 'doing', assigneeAgentId: 'fe', workSessionIds: ['work-1'] })])

    await pick(wrapper, '停止执行')

    expect(stopTask).toHaveBeenCalledWith('room-1', 'task-1')
  })
})

describe('CollabBoardPanel card face (W9b fields)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    // The panel hydrates the agent roster on setup — an empty reply here would
    // overwrite the seeded names and every menu row would fall back to the id.
    agentsApiMock.listAgents.mockResolvedValue({ success: true, agents: ROSTER })
    mocks.platformApi.onSessionEvent.mockReturnValue(() => {})
  })

  it('puts the block reason and the halt count on a blocked card', async () => {
    const wrapper = await mountPanel([card({
      status: 'blocked',
      blockReason: 'write/bash/edit 均返回 Tool not available',
      haltedCount: 2,
    })])
    const note = wrapper.find('.board-card-note')
    expect(note.text()).toBe('write/bash/edit 均返回 Tool not available')
    expect(wrapper.text()).toContain('受阻×2')
  })

  it('stamps the execution receipt on a done card', async () => {
    const wrapper = await mountPanel([card({
      status: 'done',
      report: { summary: '搞定了', evidence: { toolCounts: { write: 1, read: 2 } } },
    })])
    expect(wrapper.find('.board-card-note').text()).toBe('执行记录: read×2, write×1')
  })

  it('calls out a done card no tool call ever backed', async () => {
    const wrapper = await mountPanel([card({ status: 'done', report: { summary: '已验证文件存在' } })])
    expect(wrapper.find('.board-card-note').text()).toBe('无执行记录')
  })

  it('leaves an in-flight card face untouched', async () => {
    const wrapper = await mountPanel([card({ status: 'doing' })])
    expect(wrapper.find('.board-card-note').exists()).toBe(false)
  })
})

describe('CollabBoardPanel 交付物 (W17)', () => {
  function delivered(patch: Partial<CollabTask>, files: string[]): CollabTask {
    return card({
      status: 'done',
      ...patch,
      report: { summary: '交付', evidence: { toolCounts: { write: files.length }, files } },
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    agentsApiMock.listAgents.mockResolvedValue({ success: true, agents: ROSTER })
    mocks.platformApi.onSessionEvent.mockReturnValue(() => {})
    mocks.platformApi.openPath.mockResolvedValue('')
  })

  it('lists the card’s files by name, full path as the accessible name', async () => {
    const wrapper = await mountPanel([delivered({}, ['src/app/main.ts'])])
    const file = wrapper.find('.board-card-files .deliverable-file')
    expect(file.text()).toBe('main.ts')
    expect(file.attributes('aria-label')).toBe('/repo/src/app/main.ts')
  })

  it('caps the card face at three files and counts the rest', async () => {
    const wrapper = await mountPanel([delivered({}, ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'])])
    expect(wrapper.findAll('.board-card-files .deliverable-file')).toHaveLength(3)
    expect(wrapper.find('.board-card-files-more').text()).toBe('+2')
  })

  it('renders no file row for a pre-W17 card', async () => {
    const wrapper = await mountPanel([card({
      status: 'done',
      report: { summary: '搞定了', evidence: { toolCounts: { write: 1 } } },
    })])
    expect(wrapper.find('.board-card-files').exists()).toBe(false)
    // The W9b receipt is untouched by W17.
    expect(wrapper.find('.board-card-note').text()).toBe('执行记录: write×1')
  })

  it('opens the resolved absolute path from the card without opening the session', async () => {
    const wrapper = await mountPanel([delivered({ workSessionIds: ['work-1'] }, ['src/a.ts'])])
    await wrapper.find('.board-card-files .deliverable-file').trigger('click')
    await settle()
    expect(mocks.platformApi.openPath).toHaveBeenCalledWith('/repo/src/a.ts')
  })

  it('says so instead of guessing when the room folder cannot be read', async () => {
    const wrapper = await mountPanel([delivered({}, ['src/a.ts'])], { roomFolder: null })
    await wrapper.find('.board-card-files .deliverable-file').trigger('click')
    await settle()
    expect(mocks.platformApi.openPath).not.toHaveBeenCalled()
    expect(wrapper.find('.board-hint').text()).toContain('folder')
  })

  it('switches to a per-task deliverables view and back', async () => {
    const wrapper = await mountPanel([
      delivered({ id: 'task-1', title: '写登录页', updatedAt: 2 }, ['src/login.ts']),
      delivered({ id: 'task-2', title: '补文档', updatedAt: 1 }, ['docs/readme.md']),
      card({ id: 'task-3', title: '没产出' }),
    ])

    const toggle = wrapper.find('.board-view-toggle')
    expect(toggle.text()).toContain('2')  // distinct files across the board
    await toggle.trigger('click')
    await settle()

    expect(wrapper.find('.board-columns').exists()).toBe(false)
    const groups = wrapper.findAll('.deliverable-group')
    expect(groups).toHaveLength(2)
    expect(groups[0].find('.deliverable-task').text()).toBe('写登录页')
    expect(groups[0].find('.deliverable-name').text()).toBe('login.ts')
    expect(groups[0].find('.deliverable-dir').text()).toBe('src')
    expect(wrapper.text()).not.toContain('没产出')

    await wrapper.find('.board-view-toggle').trigger('click')
    await settle()
    expect(wrapper.find('.board-columns').exists()).toBe(true)
  })

  it('opens a file from the aggregate view too', async () => {
    const wrapper = await mountPanel([delivered({}, ['docs/readme.md'])])
    await wrapper.find('.board-view-toggle').trigger('click')
    await settle()
    await wrapper.find('.board-deliverables .deliverable-file').trigger('click')
    await settle()
    expect(mocks.platformApi.openPath).toHaveBeenCalledWith('/repo/docs/readme.md')
  })

  it('shows a one-line empty state when nothing has been produced yet', async () => {
    const wrapper = await mountPanel([card()])
    await wrapper.find('.board-view-toggle').trigger('click')
    await settle()
    expect(wrapper.find('.board-deliverables').text()).toContain('还没有交付物')
  })
})

/**
 * F2(真机走查 §4.4)——「群 folder」入口此前 `v-if` 在会话的 workingDirectory
 * 上,而自动分配的 folder 现算不落库,于是**默认房的按钮全体隐身**:群里明明
 * 有文件,工作台却给不出入口。根由后端答,渲染进程不拼 `<store>/rooms/<id>`。
 */
describe('CollabBoardPanel 群 folder 入口 (F2)', () => {
  /** 找出头部那枚「群 folder」按钮(它和预算共用 .board-budget 这一身皮)。 */
  function folderButton(wrapper: Awaited<ReturnType<typeof mountPanel>>) {
    return wrapper.findAll('.board-budget').find(button => button.text() === '群 folder')
  }

  /** 那枚按钮外面的 Tooltip —— 群 folder 的路径挂在它身上。 */
  function folderTooltip(wrapper: Awaited<ReturnType<typeof mountPanel>>) {
    return wrapper.findAllComponents(Tooltip).find(tip => tip.text() === '群 folder')
  }

  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    agentsApiMock.listAgents.mockResolvedValue({ success: true, agents: ROSTER })
    mocks.platformApi.onSessionEvent.mockReturnValue(() => {})
  })

  it('shows the entry for a default room whose folder was never configured', async () => {
    const wrapper = await mountPanel([card()], { roomFolder: '/store/rooms/room-1' })
    // 会话上没有 workingDirectory —— 这正是默认房。根来自通道的回答。
    expect(useSessionsStore().sessions[0].workingDirectory).toBeUndefined()
    expect(mocks.collabApi.roomFolderList).toHaveBeenCalledWith({ roomSessionId: 'room-1' })
    const button = folderButton(wrapper)
    expect(button).toBeTruthy()
    // 路径写在按钮的 Tooltip 上(P5:原生 title 已下线)。
    expect(folderTooltip(wrapper)?.props('text')).toBe('/store/rooms/room-1')
  })

  it('hands the channel’s folder to the files tab, not a renderer-built path', async () => {
    const wrapper = await mountPanel([card()], { roomFolder: '/store/rooms/room-1' })
    const seen: unknown[] = []
    const listener = (event: Event) => seen.push((event as CustomEvent).detail)
    window.addEventListener('onething:collab-open-folder', listener)
    await folderButton(wrapper)?.trigger('click')
    window.removeEventListener('onething:collab-open-folder', listener)
    expect(seen).toEqual([{ root: '/store/rooms/room-1' }])
  })

  it('hides the entry when the host cannot answer (web stub)', async () => {
    const wrapper = await mountPanel([card()], { roomFolder: null })
    expect(folderButton(wrapper)).toBeUndefined()
  })
})

/**
 * R6 / P1-4 — the two room-wide switches used to `.catch(() => {})` and reload
 * regardless, so a refused write repainted the control back to where it was
 * with nothing said. A brake that silently springs back is worse than one that
 * refuses out loud.
 */
describe('CollabBoardPanel 刹车反馈 (P1-4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    agentsApiMock.listAgents.mockResolvedValue({ success: true, agents: ROSTER })
    mocks.platformApi.onSessionEvent.mockReturnValue(() => {})
    mocks.platformApi.getPendingPermissions.mockResolvedValue({ success: true, pending: [] })
  })

  it('says so when the freeze is refused, and does not reload as if it worked', async () => {
    mocks.collabApi.roomSetFrozen.mockResolvedValue({
      success: false,
      error: 'Not a room session',
    })
    const wrapper = await mountPanel([card()])
    const sessions = useSessionsStore()
    const loadSessions = vi.spyOn(sessions, 'loadSessions').mockResolvedValue(undefined as never)

    await wrapper.find('.board-freeze').trigger('click')
    await settle()

    expect(wrapper.find('.board-hint').text()).toContain('Not a room session')
    expect(loadSessions).not.toHaveBeenCalled()
  })

  it('surfaces a thrown bridge error rather than swallowing it', async () => {
    mocks.collabApi.roomSetFrozen.mockRejectedValue(new Error('bridge down'))
    const wrapper = await mountPanel([card()])

    await wrapper.find('.board-freeze').trigger('click')
    await settle()

    expect(wrapper.find('.board-hint').text()).toContain('bridge down')
  })

  /**
   * 架构收敛 C4 §3:成功之后**不再**全量重拉会话表 —— 冻结开关的新位置由主进程
   * 的 `session:collab-updated` 推回来,会话列表就地合并那一行。
   *
   * 这一条因此从"成功要 reload"翻成"成功也不该 reload":为一个布尔字段重拉整张
   * 会话表是这次收敛拆掉的七处之一,而这里正是其中之一。
   */
  it('leaves no hint and does NOT reload the session list when the freeze lands', async () => {
    mocks.collabApi.roomSetFrozen.mockResolvedValue({ success: true })
    const wrapper = await mountPanel([card()])
    const sessions = useSessionsStore()
    const loadSessions = vi.spyOn(sessions, 'loadSessions').mockResolvedValue(undefined as never)

    await wrapper.find('.board-freeze').trigger('click')
    await settle()

    expect(wrapper.find('.board-hint').exists()).toBe(false)
    expect(loadSessions).not.toHaveBeenCalled()
  })

  it('reports a refused budget write on the same line', async () => {
    mocks.collabApi.roomSetBudgets.mockResolvedValue({
      success: false,
      error: 'Not a room session',
    })
    const wrapper = await mountPanel([card()])

    await wrapper.find('.board-budget').trigger('click')
    await settle()
    const input = wrapper.find('.board-budget-input')
    await input.setValue(12)
    await input.trigger('blur')
    await settle()

    expect(mocks.collabApi.roomSetBudgets).toHaveBeenCalledWith({ roomSessionId: 'room-1', dailyCostUSD: 12 })
    expect(wrapper.find('.board-hint').text()).toContain('Not a room session')
  })
})
