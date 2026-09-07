import { mkdtemp, readFile, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let root: string
let runtime: import('../store.js').TodoPlanRuntime | undefined
vi.mock('../../../current.js', () => ({
  getCurrentBackendInstance: () => runtime ? { todoPlans: runtime } : null,
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
  shell: {
    openPath: vi.fn(),
  },
}))

vi.mock('../../../stores/settings.js', () => ({
  getSettings: () => ({
    general: {
      todoPlan: {
        directory: root,
      },
    },
  }),
}))

vi.mock('@onething/runtime/storage', () => ({
  getOnethingStorePath: () => root,
}))

let activeSessionId = ''
vi.mock('../../../stores/app-state.js', () => ({
  getCurrentSessionId: () => activeSessionId,
}))

async function pathExists(filePath: string): Promise<boolean> {
  return Boolean(await stat(filePath).catch(() => null))
}

describe('todo-plan store', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'todo-plan-store-'))
    activeSessionId = ''
    const { TodoPlanRuntime } = await import('../store.js')
    runtime = new TodoPlanRuntime({ storePath: root, assertActive() {} })
  })

  afterEach(async () => {
    await runtime?.drain()
    runtime?.dispose()
    runtime = undefined
    await rm(root, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('does not create the session AI todo while reading a snapshot', async () => {
    const { readTodoPlanSnapshot } = await import('../store.js')

    const snapshot = await readTodoPlanSnapshot({ sessionId: 'session-a' })

    expect(snapshot.sessionAiTodo).toBeUndefined()
    expect(await pathExists(path.join(root, 'sessions'))).toBe(false)
    expect(snapshot.userNotes).toHaveLength(1)
  })

  it('rejects empty session AI todo creation', async () => {
    const { updateTodoPlanDocument } = await import('../store.js')

    await expect(updateTodoPlanDocument({
      scope: 'session-ai-todo',
      sessionId: 'session-a',
      content: '# AI Todo\n\n## Now\n\n',
    })).rejects.toThrow('session-ai-todo content is empty')

    expect(await pathExists(path.join(root, 'sessions'))).toBe(false)
  })

  it('creates the session AI todo only when it is written with content', async () => {
    const { readTodoPlanSnapshot, updateTodoPlanDocument } = await import('../store.js')

    const document = await updateTodoPlanDocument({
      scope: 'session-ai-todo',
      sessionId: 'session-a',
      content: '# AI Todo\n\n## Now\n- [ ] Real work\n',
    })

    expect(document.scope).toBe('session-ai-todo')
    expect(await readFile(document.filePath, 'utf-8')).toContain('Real work')

    const snapshot = await readTodoPlanSnapshot({ sessionId: 'session-a' })
    expect(snapshot.sessionAiTodo?.content).toContain('Real work')
  })

  // The detached todo window has no session of its own: it omits the session id
  // and means "whichever one is active", which only the host can resolve.
  describe('active-session fallback', () => {
    it('reads the active session AI todo when no session is given', async () => {
      const { readTodoPlanSnapshot, updateTodoPlanDocument } = await import('../store.js')

      await updateTodoPlanDocument({
        scope: 'session-ai-todo',
        sessionId: 'session-a',
        content: '# AI Todo\n\n- [ ] Session A work\n',
      })

      activeSessionId = 'session-a'
      const snapshot = await readTodoPlanSnapshot({})

      expect(snapshot.sessionId).toBe('session-a')
      expect(snapshot.sessionAiTodo?.content).toContain('Session A work')
    })

    it('follows the active session when it changes', async () => {
      const { readTodoPlanSnapshot, updateTodoPlanDocument } = await import('../store.js')

      await updateTodoPlanDocument({
        scope: 'session-ai-todo',
        sessionId: 'session-a',
        content: '# AI Todo\n\n- [ ] Session A work\n',
      })
      await updateTodoPlanDocument({
        scope: 'session-ai-todo',
        sessionId: 'session-b',
        content: '# AI Todo\n\n- [ ] Session B work\n',
      })

      activeSessionId = 'session-b'
      const snapshot = await readTodoPlanSnapshot({})

      expect(snapshot.sessionId).toBe('session-b')
      expect(snapshot.sessionAiTodo?.content).toContain('Session B work')
      expect(snapshot.sessionAiTodo?.content).not.toContain('Session A work')
    })

    it('writes to the active session when no session is given', async () => {
      const { readTodoPlanSnapshot, updateTodoPlanDocument } = await import('../store.js')

      activeSessionId = 'session-a'
      await updateTodoPlanDocument({
        scope: 'session-ai-todo',
        content: '# AI Todo\n\n- [ ] Typed in the detached window\n',
      })

      const snapshot = await readTodoPlanSnapshot({ sessionId: 'session-a' })
      expect(snapshot.sessionAiTodo?.content).toContain('Typed in the detached window')
    })

    // An explicit session id always wins; the side panel passes one.
    it('does not let the active session override an explicit one', async () => {
      const { readTodoPlanSnapshot, updateTodoPlanDocument } = await import('../store.js')

      await updateTodoPlanDocument({
        scope: 'session-ai-todo',
        sessionId: 'session-a',
        content: '# AI Todo\n\n- [ ] Session A work\n',
      })

      activeSessionId = 'session-b'
      const snapshot = await readTodoPlanSnapshot({ sessionId: 'session-a' })

      expect(snapshot.sessionId).toBe('session-a')
      expect(snapshot.sessionAiTodo?.content).toContain('Session A work')
    })
  })
})
