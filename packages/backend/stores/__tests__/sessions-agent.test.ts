import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_ID } from '@shared/ipc.js'
import type { ChatMessage } from '@shared/ipc.js'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
}))

vi.mock('../session-repository/sqlite-repository.js', () => ({
  deleteSqliteMessage: vi.fn(),
  deleteSqliteMessageAndAfter: vi.fn(),
  deleteSqliteSessions: vi.fn(),
  getSqliteMessagesPage: vi.fn(() => undefined),
  getSqliteSessionDetails: vi.fn(() => undefined),
  getSqliteUserMessageMarkers: vi.fn(() => undefined),
  importSessionIndexToSqlite: vi.fn(),
  isSqliteSessionReady: vi.fn(() => false),
  scheduleSessionSqliteMigration: vi.fn(),
  syncFullSessionToSqlite: vi.fn(),
  syncSqliteMessage: vi.fn(),
  syncSqliteSessionMetadata: vi.fn(),
  syncSqliteSessionUsage: vi.fn(),
  syncSqliteSessionVariables: vi.fn(),
  upsertSqliteMessageAndTruncate: vi.fn(),
}))

let previousHome: string | undefined
let tempHome: string
let loadedSessions: typeof import('../sessions.js') | null = null
let fixture: Awaited<ReturnType<typeof import('../../session/testing/store-layer.js').installStoreSessionLayerForTest>> | undefined

async function loadIsolatedStores(): Promise<{
  paths: typeof import('@onething/runtime/storage')
  sessions: typeof import('../sessions.js')
}> {
  vi.resetModules()
  const paths = await import('@onething/runtime/storage')
  const sessions = await import('../sessions.js')
  loadedSessions = sessions
  paths.ensureOnethingStoreDirs()
  fixture = await (await import('../../session/testing/store-layer.js')).installStoreSessionLayerForTest()
  return { paths, sessions }
}

function userMessage(id: string): ChatMessage {
  return {
    id,
    role: 'user',
    content: `message ${id}`,
    timestamp: 1,
  }
}

beforeEach(() => {
  previousHome = process.env.HOME
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-sessions-agent-test-'))
  process.env.HOME = tempHome
  loadedSessions = null
})

afterEach(async () => {
  await loadedSessions?.flushAllPendingSaves()
  await fixture?.dispose()
  fixture = undefined
  process.env.HOME = previousHome
  fs.rmSync(tempHome, { recursive: true, force: true })
})


// 默认格式已切到 jsonl:会话级字段落在 <id>/meta.json;legacy 格式仍兼容
function readStoredSessionMeta(paths: { getOnethingSessionPath(id: string): string; getOnethingSessionsDir(): string }, sessionId: string): { agentId?: string } {
  const metaPath = path.join(paths.getOnethingSessionsDir(), sessionId, 'meta.json')
  const target = fs.existsSync(metaPath) ? metaPath : paths.getOnethingSessionPath(sessionId)
  return JSON.parse(fs.readFileSync(target, 'utf-8'))
}

describe('session agent metadata', () => {
  it('defaults new sessions to Default Agent and persists agent switches', async () => {
    const { paths, sessions } = await loadIsolatedStores()

    const session = sessions.createSession('session-1', 'Agent Session')
    await sessions.flushSessionSave(session.id)

    expect(session.agentId).toBe(DEFAULT_AGENT_ID)
    expect(sessions.getSessionsList()[0].agentId).toBe(DEFAULT_AGENT_ID)
    expect(readStoredSessionMeta(paths, session.id).agentId).toBe(DEFAULT_AGENT_ID)

    expect(sessions.updateSessionAgent(session.id, 'agent-custom')).toBe(true)
    await sessions.flushSessionSave(session.id)

    expect(sessions.getSession(session.id)?.agentId).toBe('agent-custom')
    expect(sessions.getSessionDetails(session.id)?.agentId).toBe('agent-custom')
    expect(sessions.getSessionsList()[0].agentId).toBe('agent-custom')
    expect(readStoredSessionMeta(paths, session.id).agentId).toBe('agent-custom')
  })

  it('inherits the parent session Agent when branching', async () => {
    const { paths, sessions } = await loadIsolatedStores()

    const parent = sessions.createSession('parent', 'Parent')
    sessions.updateSessionAgent(parent.id, 'agent-branch')

    const branch = sessions.createBranchSession(
      'branch',
      'Branch',
      parent.id,
      'message-1',
      [userMessage('message-1')],
    )
    await sessions.flushAllPendingSaves()

    expect(branch.agentId).toBe('agent-branch')
    expect(sessions.getSessionDetails(branch.id)?.agentId).toBe('agent-branch')
    expect(readStoredSessionMeta(paths, branch.id).agentId).toBe('agent-branch')
  })
})
