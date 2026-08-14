// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSessionsStore } from '../sessions'
import { useChatStore } from '../chat'

const { electronApi } = vi.hoisted(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    },
  })
  return {
    electronApi: {
      createSession: vi.fn(),
      activateSession: vi.fn(),
      getSessionMessagesPage: vi.fn(),
      getSessionUserMarkers: vi.fn(),
      updateSessionAgent: vi.fn().mockResolvedValue({ success: true }),
      updateSessionPermissionMode: vi.fn().mockResolvedValue({ success: true }),
      updateSessionModel: vi.fn().mockResolvedValue({ success: true }),
      updateSessionWorkingDirectory: vi.fn().mockResolvedValue({ success: true }),
      onSystemThemeChanged: vi.fn(() => vi.fn()),
      getSettings: vi.fn().mockResolvedValue({ success: true, settings: {} }),
      // 域已迁到通用 RPC 通道(主线 T1 第二批):打那一条通道,按 domain.method 分发。
      rpcInvoke: vi.fn(async (request: { domain: string; method: string }) => {
        if (request.domain === 'agents' && request.method === 'list') {
          return { ok: true, data: { success: true, agents: [] } }
        }
        if (request.domain === 'providers' && request.method === 'list') {
          return { ok: true, data: { success: true, providers: [] } }
        }
        if (request.domain === 'models' && request.method === 'getNameAliases') {
          return { ok: true, data: { success: true, aliases: {} } }
        }
        return { ok: false, error: { message: `unstubbed RPC ${request.domain}.${request.method}` } }
      }),
    },
  }
})

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: electronApi,
  })
})

describe('sessions draft New Chat', () => {
  it('opens a Today draft without creating a persisted session', () => {
    const store = useSessionsStore()
    const yesterday = Date.now() - 86_400_000
    store.sessions.push({
      id: 'old-empty',
      name: 'New Chat',
      createdAt: yesterday,
      updatedAt: yesterday,
      messageCount: 0,
    })

    const draft = store.openNewChatDraft('New Chat')

    expect(draft.draftKind).toBe('new-chat-draft')
    // The draft id is the future session id: a plain v4 UUID (the exact
    // format the main process accepts for client-supplied ids).
    expect(draft.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    expect(store.currentSessionId).toBe(draft.id)
    expect(store.currentSession?.id).toBe(draft.id)
    expect(store.sidebarSessions[0].id).toBe(draft.id)
    expect(store.filteredSessions[0].id).toBe('old-empty')
    expect(store.sessions.some(session => session.id === draft.id)).toBe(false)
    expect(electronApi.createSession).not.toHaveBeenCalled()
  })

  it('updates draft chat settings locally without calling session IPC', async () => {
    const store = useSessionsStore()
    const draft = store.openNewChatDraft('New Chat')

    await expect(store.updateSessionAgent(draft.id, 'agent-research')).resolves.toEqual({ success: true })
    await expect(store.updateSessionPermissionMode(draft.id, 'auto-accept-edits')).resolves.toEqual({ success: true })
    await expect(store.updateSessionModel(draft.id, 'codex', 'gpt-5.5')).resolves.toEqual({ success: true })

    expect(store.currentSession).toMatchObject({
      id: draft.id,
      agentId: 'agent-research',
      permissionMode: 'auto-accept-edits',
      lastProvider: 'codex',
      lastModel: 'gpt-5.5',
    })
    expect(electronApi.updateSessionAgent).not.toHaveBeenCalled()
    expect(electronApi.updateSessionPermissionMode).not.toHaveBeenCalled()
    expect(electronApi.updateSessionModel).not.toHaveBeenCalled()
  })

  it('creates another draft when current draft already has composer text', () => {
    const store = useSessionsStore()
    const chatStore = useChatStore()
    const first = store.openNewChatDraft('New Chat')
    chatStore.setComposerDraft(first.id, {
      messageInput: 'unfinished prompt',
      quotedText: '',
      attachments: [],
    })

    const second = store.openNewChatDraft('New Chat')

    expect(second.id).not.toBe(first.id)
    expect(store.currentSessionId).toBe(second.id)
    expect(store.newChatDrafts.map(item => item.id)).toEqual([second.id, first.id])
    expect(chatStore.getComposerDraft(first.id)?.messageInput).toBe('unfinished prompt')
    expect(electronApi.createSession).not.toHaveBeenCalled()
  })

  it('keeps draft and composer text when switching to another chat', async () => {
    const store = useSessionsStore()
    const chatStore = useChatStore()
    const now = Date.now()
    store.sessions.push({
      id: 'real-existing',
      name: 'Existing Chat',
      createdAt: now,
      updatedAt: now,
      messageCount: 1,
    })
    const draft = store.openNewChatDraft('New Chat')
    chatStore.setComposerDraft(draft.id, {
      messageInput: 'keep this draft',
      quotedText: '',
      attachments: [],
    })
    electronApi.activateSession.mockResolvedValue({
      success: true,
      session: {
        id: 'real-existing',
        name: 'Existing Chat',
        createdAt: now,
        updatedAt: now,
        messageCount: 1,
      },
    })
    electronApi.getSessionMessagesPage.mockResolvedValue({
      success: true,
      messages: [],
      pageState: {
        nextCursor: null,
        backwardsCursor: null,
        hasMoreBefore: false,
        hasMoreAfter: false,
        totalCount: 0,
      },
    })

    await store.switchSession('real-existing')

    expect(store.currentSessionId).toBe('real-existing')
    expect(store.newChatDrafts.map(item => item.id)).toContain(draft.id)
    expect(store.sidebarSessions[0].id).toBe(draft.id)
    expect(chatStore.getComposerDraft(draft.id)?.messageInput).toBe('keep this draft')
    expect(electronApi.createSession).not.toHaveBeenCalled()
  })

  it('materializes the draft on first send instead of reusing an old empty session', async () => {
    const store = useSessionsStore()
    const yesterday = Date.now() - 86_400_000
    store.sessions.push({
      id: 'old-empty',
      name: 'New Chat',
      createdAt: yesterday,
      updatedAt: yesterday,
      messageCount: 0,
    })
    const draft = store.openNewChatDraft('New Chat')
    await store.updateSessionAgent(draft.id, 'agent-research')
    await store.updateSessionPermissionMode(draft.id, 'dangerously-allow-all')
    await store.updateSessionModel(draft.id, 'codex', 'gpt-5.5')

    // The main process persists the session under the client-supplied id
    // (the draft's own id) — echo it back like the real handler does.
    electronApi.createSession.mockImplementation(
      async (name: string, options?: { sessionId?: string }) => ({
        success: true,
        session: {
          id: options?.sessionId ?? 'fresh-id',
          name,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messageCount: 0,
        },
      }),
    )
    electronApi.activateSession.mockImplementation(async (sessionId: string) => ({
      success: true,
      session: {
        id: sessionId,
        name: 'New Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: 0,
      },
    }))
    electronApi.getSessionMessagesPage.mockResolvedValue({
      success: true,
      messages: [],
      pageState: {
        nextCursor: null,
        backwardsCursor: null,
        hasMoreBefore: false,
        hasMoreAfter: false,
        totalCount: 0,
      },
    })

    const materialized = await store.materializeNewChatDraft(draft.id, 'New Chat')

    // Identity is stable: the session persists under the draft's own id.
    expect(materialized?.id).toBe(draft.id)
    // 归属空间随草稿一路走到落盘(B1);没切过空间就是 default。
    expect(electronApi.createSession).toHaveBeenCalledWith('New Chat', {
      sessionId: draft.id,
      workspaceId: 'default',
    })
    expect(store.newChatDrafts).toEqual([])
    expect(store.currentSessionId).toBe(draft.id)
    expect(store.sessions[0].id).toBe(draft.id)
    expect(electronApi.updateSessionAgent).toHaveBeenCalledWith(draft.id, 'agent-research')
    expect(electronApi.updateSessionPermissionMode).toHaveBeenCalledWith(draft.id, 'dangerously-allow-all')
    expect(electronApi.updateSessionModel).toHaveBeenCalledWith(draft.id, 'codex', 'gpt-5.5')
    expect(store.sessions[0]).toMatchObject({
      agentId: 'agent-research',
      permissionMode: 'dangerously-allow-all',
      lastProvider: 'codex',
      lastModel: 'gpt-5.5',
    })
  })
})
