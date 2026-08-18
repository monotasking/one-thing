import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceStore } from '../workspace'
import {
  rebuildFromLegacyTabs,
  rebuildWorkspace,
  serializeWorkspace,
  serializeWorkspaceArchive,
  splitWorkspaceArchive,
  type PersistedWorkspace,
  type PersistedWorkspaceSpaceEntry,
  type PersistedWorkspaceV4,
  type PersistedWorkspaceV5,
} from '../workspace-persistence'
import type { WorkspaceSplit } from '../workspace-tree'
import { platformApi } from '@/platform'

const mocks = vi.hoisted(() => ({
  sessionsStore: {
    isLoading: false,
    // `room-1` 是一间房 —— 形态判定靠 kind(房 → 协作,其余 → 对话)。
    // `workspaceId` 缺席 = default 空间(零迁移的读取端缺省)。
    sessions: [
      { id: 'session-1' },
      { id: 'session-2' },
      { id: 'session-3' },
      { id: 'room-1', kind: 'room' },
      { id: 'room-2', kind: 'room' },
      { id: 'work-1', workspaceId: 'work' },
      { id: 'work-2', workspaceId: 'work' },
      { id: 'work-room', kind: 'room', workspaceId: 'work' },
    ] as Array<{ id: string; kind?: string; workspaceId?: string }>,
    getSessionItem(id: string) { return mocks.sessionsStore.sessions.find(item => item.id === id) },
    switchSession: vi.fn(),
    clearCurrentSession: vi.fn(),
    isNewChatDraftId: (sessionId: string) => sessionId.startsWith('draft:'),
  },
}))

vi.mock('@/platform', () => ({
  platformApi: {
    capabilities: { collabRooms: true },
    saveUIState: vi.fn().mockResolvedValue({ success: true }),
  },
}))

vi.mock('../sessions', () => ({
  useSessionsStore: () => mocks.sessionsStore,
}))

const valid = (id: string) => mocks.sessionsStore.sessions.some(s => s.id === id)

const memoryStore = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memoryStore.get(key) ?? null,
  setItem: (key: string, value: string) => { memoryStore.set(key, value) },
  removeItem: (key: string) => { memoryStore.delete(key) },
  clear: () => { memoryStore.clear() },
})

beforeEach(() => {
  vi.clearAllMocks()
  memoryStore.clear()
  mocks.sessionsStore.sessions = [
    { id: 'session-1' },
    { id: 'session-2' },
    { id: 'session-3' },
    { id: 'room-1', kind: 'room' },
    { id: 'room-2', kind: 'room' },
    { id: 'work-1', workspaceId: 'work' },
    { id: 'work-2', workspaceId: 'work' },
    { id: 'work-room', kind: 'room', workspaceId: 'work' },
  ]
  setActivePinia(createPinia())
})

describe('workspace store: 一格一条会话', () => {
  it('starts as one empty leaf ("main") — the empty-workspace state', () => {
    const store = useWorkspaceStore()
    expect(store.leaves.map(l => l.id)).toEqual(['main'])
    expect(store.hasAnySession).toBe(false)
    expect(store.activeSessionId).toBe('')
  })

  /**
   * U2:多页签退役后 `openSession` 是**换靶子**,不是"追加一张签"。
   * 见 docs/design/product-two-forms-chatgpt-shell.md D4。
   */
  it('openSession 换掉这一格里坐着的那条会话(不再叠加)', () => {
    const store = useWorkspaceStore()
    store.openSession('session-1')
    store.openSession('session-2')

    expect(store.activeSessionIdOf('main')).toBe('session-2')
    expect(store.activeSessionId).toBe('session-2')
    expect([...store.openSessionIds]).toEqual(['session-2'])
  })

  it('openSession is a no-op when the session is already seated (no persist churn)', () => {
    const store = useWorkspaceStore()
    store.openSession('session-1')
    store.openSession('session-1')
    expect(store.activeSessionIdOf('main')).toBe('session-1')
    expect(store.leaves).toHaveLength(1)
  })

  it('同一条会话可以同时坐在两个分栏里', () => {
    const store = useWorkspaceStore()
    store.openSession('session-1')
    const leafId = store.splitLeaf('main', 'session-1', 'right')!
    expect(store.activeSessionIdOf('main')).toBe('session-1')
    expect(store.activeSessionIdOf(leafId)).toBe('session-1')
    expect([...store.openSessionIds]).toEqual(['session-1'])
  })
})

describe('workspace store: session lifecycle', () => {
  it('closeSession removes the session everywhere and collapses emptied leaves', () => {
    const store = useWorkspaceStore()
    store.openSession('session-1')
    const leafId = store.splitLeaf('main', 'session-2', 'right')!

    store.closeSession('session-2')

    expect(store.leaves.map(l => l.id)).toEqual(['main'])
    expect(store.activeSessionIdOf('main')).toBe('session-1')
    expect(store.leafById(leafId)).toBeUndefined()
  })

  it('closeSession on the sole leaf leaves the empty-workspace state', () => {
    const store = useWorkspaceStore()
    store.openSession('session-1')
    store.closeSession('session-1')
    expect(store.leaves).toHaveLength(1)
    expect(store.hasAnySession).toBe(false)
    expect(store.activeSessionId).toBe('')
  })

  it('closeSession scoped to one leaf keeps the session open elsewhere', () => {
    const store = useWorkspaceStore()
    store.openSession('session-1')
    const leafId = store.splitLeaf('main', 'session-2', 'right')!
    store.openSession('session-2', { leafId: 'main' })

    store.closeSession('session-2', { onlyLeafId: 'main' })

    expect(store.activeSessionIdOf('main')).toBe('')
    expect(store.activeSessionIdOf(leafId)).toBe('session-2')
  })

  it('a draft needs no retargeting: the draft id IS the session id (方案 A)', () => {
    const store = useWorkspaceStore()
    // Draft ids are ordinary UUIDs; materialization persists the session
    // under the same id, so the leaf simply keeps pointing at it.
    store.openSession('11111111-2222-4333-8444-555555555555')
    expect(store.activeSessionId).toBe('11111111-2222-4333-8444-555555555555')
  })
})

describe('workspace store: the switch effect', () => {
  it('follows activeSessionId into switchSession once hydrated', async () => {
    const store = useWorkspaceStore()
    store.hydrate(null)
    store.openSession('session-1')
    await nextTick()
    expect(mocks.sessionsStore.switchSession).toHaveBeenCalledWith('session-1')

    store.openSession('session-2')
    await nextTick()
    expect(mocks.sessionsStore.switchSession).toHaveBeenCalledWith('session-2')
  })

  it('clears the current session when the workspace empties', async () => {
    const store = useWorkspaceStore()
    store.hydrate(null)
    store.openSession('session-1')
    await nextTick()

    store.closeSession('session-1')
    await nextTick()
    expect(mocks.sessionsStore.clearCurrentSession).toHaveBeenCalled()
  })

  it('stays silent before hydration', async () => {
    const store = useWorkspaceStore()
    store.openSession('session-1')
    await nextTick()
    expect(mocks.sessionsStore.switchSession).not.toHaveBeenCalled()
  })
})

describe('形态:一个形态一个工作现场(D7)', () => {
  it('默认落协作(桌面端),两棵树各自独立', () => {
    const store = useWorkspaceStore()
    expect(store.formMode).toBe('collab')
    expect(store.availableFormModes).toEqual(['chat', 'collab'])
  })

  /** 这是用户报的那个 bug:切形态时主区必须跟着换,不能停在上一个形态的内容上。 */
  it('切形态 = 换整个工作现场:主区那条会话跟着换,切回来原样还在', () => {
    const store = useWorkspaceStore()
    store.hydrate(null)

    store.openSession('room-1')
    expect(store.formMode).toBe('collab')
    expect(store.activeSessionId).toBe('room-1')

    store.setFormMode('chat')
    // 对话形态还没开过东西 → 空态屏,而不是继续显示那间房。
    expect(store.activeSessionId).toBe('')
    expect(store.hasAnySession).toBe(false)

    store.openSession('session-1')
    expect(store.activeSessionId).toBe('session-1')

    store.setFormMode('collab')
    expect(store.activeSessionId).toBe('room-1')
    store.setFormMode('chat')
    expect(store.activeSessionId).toBe('session-1')
  })

  it('分栏布局也是每形态各一份 —— 切走再切回来分屏还在', () => {
    const store = useWorkspaceStore()
    store.openSession('session-1')
    store.splitLeaf('main', 'session-2', 'right')
    expect(store.leaves).toHaveLength(2)

    store.setFormMode('collab')
    expect(store.leaves).toHaveLength(1)

    store.setFormMode('chat')
    expect(store.leaves).toHaveLength(2)
    expect(store.leaves.map(leaf => leaf.sessionId)).toEqual(['session-1', 'session-2'])
  })

  /** 打开一条房 = 落在协作那棵树上,而不是把房塞进对话形态。 */
  it('openSession 自己认形态 —— 所有入口都不用各写一遍跟随', () => {
    const store = useWorkspaceStore()
    store.setFormMode('chat')
    store.openSession('session-1')

    store.openSession('room-1')
    expect(store.formMode).toBe('collab')
    expect(store.activeSessionId).toBe('room-1')
    // 对话那棵树没被动过。
    store.setFormMode('chat')
    expect(store.activeSessionId).toBe('session-1')
  })

  it('草稿算对话形态(它在会话表里查不到,但一定是直聊)', () => {
    const store = useWorkspaceStore()
    store.openSession('room-1')
    store.openSession('draft:abc')
    expect(store.formMode).toBe('chat')
    expect(store.activeSessionId).toBe('draft:abc')
  })

  it('删会话要把两棵树都扫一遍,不在另一个形态里留空壳', () => {
    const store = useWorkspaceStore()
    store.openSession('room-1')
    store.openSession('session-1')

    store.closeSession('room-1')

    store.setFormMode('collab')
    expect(store.activeSessionId).toBe('')
    expect(store.hasAnySession).toBe(false)
  })

  it('形态落在 localStorage,重建 store 之后还停在那儿', () => {
    const store = useWorkspaceStore()
    store.setFormMode('chat')
    expect(memoryStore.get('onething:sidebar-form-mode')).toBe('chat')

    setActivePinia(createPinia())
    expect(useWorkspaceStore().formMode).toBe('chat')
  })
})

describe('workspace persistence', () => {
  it('round-trips 两棵树(v4)', () => {
    const store = useWorkspaceStore()
    store.setFormMode('chat')
    store.openSession('session-1')
    store.splitLeaf('main', 'session-2', 'right')
    store.setActiveLeaf('main')
    store.setFormMode('collab')
    store.openSession('room-1')

    const persisted = serializeWorkspace({
      chat: { root: store.rootOf('chat'), activeLeafId: store.activeLeafIdOf('chat') },
      collab: { root: store.rootOf('collab'), activeLeafId: store.activeLeafIdOf('collab') },
    }, () => false)
    expect(persisted.version).toBe(4)

    const rebuilt = rebuildWorkspace(persisted, valid, () => 'chat')
    const chatRoot = rebuilt.chat.root as WorkspaceSplit
    expect(chatRoot.type).toBe('split')
    expect(rebuilt.chat.activeLeafId).toBe('main')
    expect(rebuilt.collab.root).toMatchObject({ type: 'leaf', sessionId: 'room-1' })
  })

  it('does not serialize a draft (draft-ness comes from the injected predicate)', () => {
    const store = useWorkspaceStore()
    store.setFormMode('chat')
    store.openSession('draft-uuid')

    const persisted = serializeWorkspace({
      chat: { root: store.rootOf('chat'), activeLeafId: store.activeLeafIdOf('chat') },
      collab: { root: store.rootOf('collab'), activeLeafId: store.activeLeafIdOf('collab') },
    }, id => id === 'draft-uuid')
    expect(persisted.forms.chat?.root).toMatchObject({ type: 'leaf', session: '' })
  })

  it('rebuild drops unknown sessions and collapses empty leaves', () => {
    const persisted: PersistedWorkspaceSpaceEntry = {
      version: 4,
      forms: {
        chat: {
          activeLeafId: 'gone',
          root: {
            type: 'split',
            id: 'split-1',
            orientation: 'horizontal',
            size: 100,
            children: [
              { type: 'leaf', id: 'main', size: 50, session: 'session-1' },
              { type: 'leaf', id: 'gone', size: 50, session: 'deleted' },
            ],
          },
        },
      },
    }

    const rebuilt = rebuildWorkspace(persisted, valid, () => 'chat')
    expect(rebuilt.chat.root).toMatchObject({ type: 'leaf', id: 'main', sessionId: 'session-1' })
    expect(rebuilt.chat.activeLeafId).toBe('main')
    // 没存过的形态从空开始 —— 不是丢掉,是"那个形态还没被用过"。
    expect(rebuilt.collab.root).toMatchObject({ type: 'leaf', sessionId: '' })
  })

  /**
   * **迁移最要命的一条**:`hydrate` 若只认最新版本,老存档会静默清空整个工作区
   * 而且不报错(product-two-forms-chatgpt-shell.md §6.2)。
   */
  it('读得进 v3 单树:整棵认领给它当前会话所属的那个形态', () => {
    const persisted = {
      version: 3,
      activeLeafId: 'main',
      root: { type: 'leaf', id: 'main', size: 100, session: 'room-1' },
    } as unknown as PersistedWorkspaceSpaceEntry

    const rebuilt = rebuildWorkspace(persisted, valid, () => 'collab')
    expect(rebuilt.collab.root).toMatchObject({ type: 'leaf', sessionId: 'room-1' })
    expect(rebuilt.chat.root).toMatchObject({ type: 'leaf', sessionId: '' })
  })

  it('读得进 v2 存档:每格只留当时看得见的那一条', () => {
    const persisted = {
      version: 2,
      activeLeafId: 'main',
      root: {
        type: 'split',
        id: 'split-1',
        orientation: 'horizontal',
        size: 100,
        children: [
          { type: 'leaf', id: 'main', size: 50, sessions: ['session-1', 'session-2'], activeIndex: 1 },
          { type: 'leaf', id: 'side', size: 50, sessions: ['session-3'], activeIndex: 0 },
        ],
      },
    } as unknown as PersistedWorkspaceSpaceEntry

    const rebuilt = rebuildWorkspace(persisted, valid, () => 'chat')
    const root = rebuilt.chat.root as WorkspaceSplit
    const [main, side] = root.children
    if (main.type !== 'leaf' || side.type !== 'leaf') throw new Error('expected leaves')
    expect(main.sessionId).toBe('session-2')
    expect(side.sessionId).toBe('session-3')
  })

  it('v2 存档的 activeIndex 越界时夹回来,不整格丢掉', () => {
    const persisted = {
      version: 2,
      activeLeafId: 'main',
      root: { type: 'leaf', id: 'main', size: 100, sessions: ['session-1'], activeIndex: 7 },
    } as unknown as PersistedWorkspaceSpaceEntry

    const rebuilt = rebuildWorkspace(persisted, valid, () => 'chat')
    expect(rebuilt.chat.root).toMatchObject({ type: 'leaf', sessionId: 'session-1' })
  })

  it('hydrate 吃 v3 存档:房落进协作形态,主区就是那间房', () => {
    const store = useWorkspaceStore()
    store.hydrate({
      workspace: {
        version: 3,
        activeLeafId: 'main',
        root: { type: 'leaf', id: 'main', size: 100, session: 'room-1' },
      } as unknown as PersistedWorkspace,
    })
    expect(store.formMode).toBe('collab')
    expect(store.activeSessionId).toBe('room-1')
  })

  it('migrates v1 flat openTabs, keeping only the active entry', () => {
    const rebuilt = rebuildFromLegacyTabs(
      [
        { type: 'chat', sessionId: 'session-1' },
        { type: 'chat', sessionId: '' }, // v1 serialized drafts as ''
        { type: 'workbench' },
        { type: 'chat', sessionId: 'deleted' },
        { type: 'chat', sessionId: 'session-2' },
        { type: 'chat', sessionId: 'session-1' },
      ],
      1,
      valid,
    )
    expect(rebuilt.root).toMatchObject({ type: 'leaf', sessionId: 'session-2' })
  })

  it('hydrate falls back to currentSessionId, then to the empty workspace', () => {
    const store = useWorkspaceStore()
    store.hydrate({ currentSessionId: 'session-2' })
    expect(store.formMode).toBe('chat')
    expect(store.activeSessionId).toBe('session-2')
    expect(store.hydrated).toBe(true)

    setActivePinia(createPinia())
    const empty = useWorkspaceStore()
    empty.hydrate({ currentSessionId: 'deleted' })
    expect(empty.hasAnySession).toBe(false)
    expect(empty.hydrated).toBe(true)
  })

  it('hydrate is one-shot', () => {
    const store = useWorkspaceStore()
    store.hydrate({ currentSessionId: 'session-1' })
    store.hydrate({ currentSessionId: 'session-2' })
    expect(store.activeSessionId).toBe('session-1')
  })
})

describe('workspace store: panels', () => {
  it('splitLeaf focuses the new leaf; closeLeaf reports released sessions', () => {
    const store = useWorkspaceStore()
    store.openSession('session-1')
    const leafId = store.splitLeaf('main', 'session-2', 'right')!
    expect(store.activeLeafId).toBe(leafId)
    expect(store.activeSessionId).toBe('session-2')

    const result = store.closeLeaf(leafId)
    expect(result?.releasedSessionIds).toEqual(['session-2'])
    expect(store.leaves.map(l => l.id)).toEqual(['main'])
    expect(store.activeLeafId).toBe('main')
  })

  it('closeLeaf keeps sessions that are still open in another leaf out of the released list', () => {
    const store = useWorkspaceStore()
    store.openSession('session-1')
    const leafId = store.splitLeaf('main', 'session-1', 'right')!
    const result = store.closeLeaf(leafId)
    expect(result?.releasedSessionIds).toEqual([])
  })

  /**
   * 已读水位吃的是"看得见"(agent-im-dm.md P4)。U2 之后没有后台页签,
   * 「开着」与「看得见」恒等 —— 两个名字都留着,因为读它们的两处问的是
   * 不同的问题。
   */
  it('openSessionIds 与 visibleSessionIds 一格一条之后恒等', () => {
    const store = useWorkspaceStore()
    store.openSession('session-1')
    store.splitLeaf('main', 'session-3', 'right')
    expect([...store.openSessionIds].sort()).toEqual(['session-1', 'session-3'])
    expect([...store.visibleSessionIds].sort()).toEqual(['session-1', 'session-3'])
  })
})

// ── 空间(批 B5:分栏树 per-space × per-form,v4 → v5)────────────────────────

describe('workspace 存档 v5:每空间 × 每形态一棵树', () => {
  const v4Archive = (): PersistedWorkspaceSpaceEntry => ({
    version: 4,
    forms: {
      chat: { activeLeafId: 'main', root: { type: 'leaf', id: 'main', size: 100, session: 'session-1' } },
      collab: { activeLeafId: 'main', root: { type: 'leaf', id: 'main', size: 100, session: 'room-1' } },
    },
  })

  it('读到 v4:整份归 default 空间', () => {
    const archive = splitWorkspaceArchive(v4Archive() as PersistedWorkspace, 'default')
    expect(Object.keys(archive)).toEqual(['default'])
    expect(archive.default).toMatchObject({ version: 4 })
  })

  it('读到 v4:其他空间没有树(不是复制一份给每个空间)', () => {
    const archive = splitWorkspaceArchive(v4Archive() as PersistedWorkspace, 'default')
    expect(archive.work).toBeUndefined()

    const rebuilt = rebuildWorkspace(
      archive.work ?? { version: 4, forms: {} },
      valid,
      () => 'chat',
    )
    expect(rebuilt.chat.root).toMatchObject({ type: 'leaf', sessionId: '' })
    expect(rebuilt.collab.root).toMatchObject({ type: 'leaf', sessionId: '' })
  })

  it('v5 往返:拆开再合上,每个空间的树一模一样', () => {
    const written = serializeWorkspaceArchive({
      default: v4Archive() as PersistedWorkspaceV4,
      work: {
        version: 4,
        forms: {
          chat: { activeLeafId: 'main', root: { type: 'leaf', id: 'main', size: 100, session: 'work-1' } },
        },
      },
    })
    expect(written.version).toBe(5)
    expect(Object.keys(written.spaces).sort()).toEqual(['default', 'work'])

    const archive = splitWorkspaceArchive(written, 'default')
    expect(Object.keys(archive).sort()).toEqual(['default', 'work'])
    const back = rebuildWorkspace(archive.work, valid, () => 'chat')
    expect(back.chat.root).toMatchObject({ type: 'leaf', sessionId: 'work-1' })
    // 那个空间没存过协作形态 —— 从空开始,不是"丢了"。
    expect(back.collab.root).toMatchObject({ type: 'leaf', sessionId: '' })
  })

  it('认不出的版本号 → 空表(与 hydrate 的版本白名单同一口径)', () => {
    expect(splitWorkspaceArchive({ version: 99 } as unknown as PersistedWorkspace, 'default')).toEqual({})
    expect(splitWorkspaceArchive(undefined, 'default')).toEqual({})
  })
})

describe('workspace store: 切空间 = 换树', () => {
  /**
   * 建 store 前先钉住当前空间与形态 —— 两个都是 window 级状态,localStorage
   * 即真相(存档里并不带"上次停在哪个形态")。
   */
  function storeInSpace(spaceId: string, form: 'chat' | 'collab' = 'chat') {
    memoryStore.set('onething:current-space', spaceId)
    memoryStore.set('onething:sidebar-form-mode', form)
    setActivePinia(createPinia())
    return useWorkspaceStore()
  }

  it('A 空间开的分栏切到 B 不可见,切回 A 原样恢复', () => {
    const store = storeInSpace('default')
    store.hydrate(null)
    store.setFormMode('chat')
    store.openSession('session-1')
    store.splitLeaf('main', 'session-2', 'right')
    expect(store.leaves.map(leaf => leaf.sessionId)).toEqual(['session-1', 'session-2'])

    store.setSpace('work')
    // B 空间从没开过东西 → 空树,而不是继承 A 的分栏。
    expect(store.spaceId).toBe('work')
    expect(store.leaves).toHaveLength(1)
    expect(store.activeSessionId).toBe('')

    store.openSession('work-1')
    expect(store.activeSessionId).toBe('work-1')

    store.setSpace('default')
    expect(store.leaves.map(leaf => leaf.sessionId)).toEqual(['session-1', 'session-2'])
    store.setSpace('work')
    expect(store.leaves.map(leaf => leaf.sessionId)).toEqual(['work-1'])
  })

  it('形态是全局的:切空间不动形态,每个空间自己存两棵树', () => {
    const store = storeInSpace('default')
    store.hydrate(null)
    store.openSession('room-1')
    expect(store.formMode).toBe('collab')

    store.setSpace('work')
    expect(store.formMode).toBe('collab')
    store.openSession('work-room')
    store.setFormMode('chat')
    store.openSession('work-1')

    store.setSpace('default')
    // 形态跟着人走(还停在对话),树跟着空间走(default 的对话形态是空的)。
    expect(store.formMode).toBe('chat')
    expect(store.activeSessionId).toBe('')
    store.setFormMode('collab')
    expect(store.activeSessionId).toBe('room-1')
  })

  it('切换前强制 flush:debounce 窗口里那一击不会随着换树丢掉', () => {
    const store = storeInSpace('default')
    store.hydrate(null)
    store.setFormMode('chat')
    store.openSession('session-1')

    const saveUIState = vi.mocked(platformApi.saveUIState!)
    // debounce 还挂着 —— 这时候换树,不 flush 就写成新空间的树了。
    saveUIState.mockClear()
    store.setSpace('work')

    expect(saveUIState).toHaveBeenCalled()
    const written = saveUIState.mock.calls[0][0] as { workspace: PersistedWorkspaceV5 }
    expect(written.workspace.version).toBe(5)
    expect(written.workspace.spaces.default?.forms?.chat?.root)
      .toMatchObject({ type: 'leaf', session: 'session-1' })
  })

  it('hydrate 吃 v5:当前空间上树,别的空间寄存着,切过去就在', () => {
    const store = storeInSpace('work')
    store.hydrate({
      workspace: {
        version: 5,
        spaces: {
          default: {
            forms: {
              chat: { activeLeafId: 'main', root: { type: 'leaf', id: 'main', size: 100, session: 'session-1' } },
            },
          },
          work: {
            forms: {
              chat: { activeLeafId: 'main', root: { type: 'leaf', id: 'main', size: 100, session: 'work-1' } },
            },
          },
        },
      } as PersistedWorkspace,
    })

    expect(store.formMode).toBe('chat')
    expect(store.activeSessionId).toBe('work-1')
    store.setSpace('default')
    expect(store.activeSessionId).toBe('session-1')
  })

  it('v4 存档在非 default 空间里开机:default 继承那棵树,本空间从空开始', () => {
    const store = storeInSpace('work')
    store.hydrate({
      workspace: {
        version: 4,
        forms: {
          chat: { activeLeafId: 'main', root: { type: 'leaf', id: 'main', size: 100, session: 'session-1' } },
        },
      } as PersistedWorkspace,
    })

    expect(store.activeSessionId).toBe('')
    store.setSpace('default')
    expect(store.formMode).toBe('chat')
    expect(store.activeSessionId).toBe('session-1')
  })

  /** 会话被挪去别的空间(或删掉)后,那一格走既有的无效叶清理路,不留空壳。 */
  it('树里引用了不属于本空间的会话 → 整格丢掉', () => {
    const store = storeInSpace('work')
    store.hydrate({
      workspace: {
        version: 5,
        spaces: {
          work: {
            forms: {
              chat: {
                activeLeafId: 'side',
                root: {
                  type: 'split',
                  id: 'split-1',
                  orientation: 'horizontal',
                  size: 100,
                  children: [
                    { type: 'leaf', id: 'main', size: 50, session: 'work-1' },
                    // default 空间的会话 —— 在这棵树里已经是幽灵。
                    { type: 'leaf', id: 'side', size: 50, session: 'session-1' },
                  ],
                },
              },
            },
          },
        },
      } as PersistedWorkspace,
    })

    expect(store.leaves.map(leaf => leaf.sessionId)).toEqual(['work-1'])
    expect(store.activeLeafId).toBe('main')
  })

  it('删会话要扫到寄存着的空间,不在那儿留空壳', () => {
    const store = storeInSpace('default')
    store.hydrate(null)
    store.setFormMode('chat')
    store.openSession('session-1')
    store.setSpace('work')
    store.openSession('work-1')

    store.closeSession('session-1')

    store.setSpace('default')
    expect(store.activeSessionId).toBe('')
    expect(store.hasAnySession).toBe(false)
  })

  it('setSpace 到同一个空间是 no-op(不空掉当前那棵树)', () => {
    const store = storeInSpace('work')
    store.hydrate(null)
    store.setFormMode('chat')
    store.openSession('work-1')
    store.setSpace('work')
    expect(store.activeSessionId).toBe('work-1')
  })
})
