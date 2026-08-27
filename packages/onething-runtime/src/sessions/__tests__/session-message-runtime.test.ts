import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CoreSessionMeta,
  CoreSessionTokenUsage,
  CoreSessionWithMessageList,
} from '@onething/core/session'
import { createOnethingSessionMessageRuntime } from '../session-message-runtime.js'

interface TestStep {
  id: string
  title?: string
  status?: string
  toolCallId?: string
  turnIndex?: number
  usage?: CoreSessionTokenUsage
}

interface TestContentPart {
  type: 'text'
  text: string
}

interface TestToolCall {
  id: string
  name: string
}

interface TestMessage {
  id: string
  role: string
  content?: string
  contentParts?: TestContentPart[]
  reasoning?: string
  timestamp: number
  provider?: string
  model?: string
  isStreaming?: boolean
  usage?: CoreSessionTokenUsage
  steps?: TestStep[]
  toolCalls?: TestToolCall[]
  thinkingTime?: number
  skillUsed?: string
  errorDetails?: string
}

interface TestSession extends CoreSessionWithMessageList<TestMessage> {
  id: string
  name: string
  createdAt: number
}

interface TestMeta extends CoreSessionMeta {}

function usage(inputTokens: number, outputTokens: number): CoreSessionTokenUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  }
}

function createSession(messages: TestMessage[] = []): TestSession {
  return {
    id: 's1',
    name: 'Session',
    createdAt: 1,
    updatedAt: 1,
    messages,
    totalInputTokens: messages.reduce((sum, message) => sum + (message.usage?.inputTokens ?? 0), 0),
    totalOutputTokens: messages.reduce((sum, message) => sum + (message.usage?.outputTokens ?? 0), 0),
    totalTokens: messages.reduce((sum, message) => sum + (message.usage?.totalTokens ?? 0), 0),
  }
}

function createMessage(id: string, overrides: Partial<TestMessage> = {}): TestMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    timestamp: 1,
    ...overrides,
  }
}

function createHarness(session = createSession()) {
  const sessions = new Map<string, TestSession>([[session.id, session]])
  const metas = new Map<string, TestMeta>([[
    session.id,
    {
      id: session.id,
      name: session.name,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    },
  ]])
  const saveSessionToFile = vi.fn((sessionId: string, nextSession: TestSession) => {
    sessions.set(sessionId, nextSession)
  })
  const sqlite = {
    isSessionReady: vi.fn(() => true),
    scheduleMigration: vi.fn(),
    syncMessage: vi.fn(),
    syncSessionMetadata: vi.fn(),
    syncSessionUsage: vi.fn(),
    deleteMessage: vi.fn(),
    deleteMessageAndAfter: vi.fn(),
    upsertMessageAndTruncate: vi.fn(),
  }
  const runtime = createOnethingSessionMessageRuntime<
    TestSession,
    TestMessage,
    TestMeta,
    TestStep,
    TestContentPart,
    TestToolCall
  >({
    repository: {
      getSession: sessionId => sessions.get(sessionId),
      getCachedSession: sessionId => sessions.get(sessionId),
      saveSessionToFile,
      syncSessionToSqliteIfReady: vi.fn(),
      updateSessionsIndexMeta: (sessionId, update) => {
        const meta = metas.get(sessionId)
        if (!meta) return false
        update(meta)
        return true
      },
    },
    sqlite,
    streamSyncThrottleMs: 100,
    now: () => 10,
    logger: {
      log: vi.fn(),
      error: vi.fn(),
    },
  })

  return {
    runtime,
    sessions,
    metas,
    saveSessionToFile,
    sqlite,
  }
}

describe('onething session message runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('throttles streaming SQLite message sync and flushes when streaming finishes', () => {
    const { runtime, sessions, sqlite } = createHarness()

    runtime.addMessage('s1', createMessage('m1', {
      content: 'partial',
      isStreaming: true,
      provider: 'deepseek',
      model: 'deepseek-chat',
    }))
    // §17.7 #8a:`updateMessageContent` / `updateMessageStreaming` 两个薄包装随
    // 那 15 个零调用端口一起删了,这里改走还活着的 `patchMessageFields` —— 它与
    // 那两口是同一条私有 `patchMessage` 路,节流验的也还是同一件事。
    runtime.patchMessageFields('s1', 'm1', { content: 'partial response' }, 'stream')

    expect(sqlite.syncMessage).not.toHaveBeenCalled()
    expect(sessions.get('s1')?.messages[0]).toMatchObject({
      content: 'partial response',
      isStreaming: true,
    })

    runtime.patchMessageFields('s1', 'm1', { isStreaming: false })
    vi.advanceTimersByTime(500)

    expect(sqlite.syncMessage).toHaveBeenCalledTimes(1)
    expect(sqlite.syncMessage).toHaveBeenCalledWith('s1', expect.objectContaining({
      id: 'm1',
      content: 'partial response',
      isStreaming: false,
    }), 1)
    expect(sqlite.syncSessionMetadata).toHaveBeenCalledTimes(1)
    expect(sqlite.scheduleMigration).not.toHaveBeenCalled()
  })

  it('owns delete, truncate, SQLite side effects, usage subtraction, and index timestamps', () => {
    const session = createSession([
      createMessage('m1', { role: 'user', content: 'hello', usage: usage(1, 0) }),
      createMessage('m2', { content: 'old answer', usage: usage(2, 3) }),
      createMessage('m3', { role: 'user', content: 'later', usage: usage(4, 0) }),
    ])
    const { runtime, sessions, metas, sqlite } = createHarness(session)

    expect(runtime.deleteMessage('s1', 'm1')).toBe(true)
    expect(sessions.get('s1')?.messages.map(message => message.id)).toEqual(['m2', 'm3'])
    expect(sqlite.deleteMessage).toHaveBeenCalledWith('s1', 'm1')
    expect(sqlite.syncSessionMetadata).toHaveBeenCalled()

    expect(runtime.updateMessageAndTruncate('s1', 'm2', 'edited answer')).toBe(true)
    expect(sessions.get('s1')?.messages).toEqual([
      expect.objectContaining({ id: 'm2', content: 'edited answer' }),
    ])
    expect(sessions.get('s1')).toMatchObject({
      totalInputTokens: 3,
      totalOutputTokens: 3,
      totalTokens: 6,
      updatedAt: 10,
    })
    expect(metas.get('s1')?.updatedAt).toBe(10)
    expect(sqlite.upsertMessageAndTruncate).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ id: 'm2', content: 'edited answer' }),
      1,
    )
    expect(sqlite.syncSessionUsage).toHaveBeenCalled()
  })

  /*
   * `owns content, tool, and step mutations behind host repository adapters`
   * —— **随那 15 个零调用端口一起删除**(§17.7 #8a,2026-08-28)。
   *
   * 它验的是 `addMessageContentPart` / `updateMessageToolCalls` /
   * `addMessageStep` / `updateMessageStep` / `updateStepsUsageByTurn` 这五口在
   * 本层的落法,而这五口(连同另外十口)在 c4-d 之后生产零调用、本批整批删除。
   * 落盘与 sqlite 那两条断言不因此失守:上面两只用例(流式节流 / delete+truncate)
   * 走的是同一个 `saveSessionToFile` 与同一组 sqlite 适配器。
   */
})
