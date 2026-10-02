import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnethingTodoPlanStore, type TodoPlanChangedPayload } from '../store.js'

let root: string
let changed: TodoPlanChangedPayload[]

function createStore() {
  return new OnethingTodoPlanStore({
    getConfiguredDirectory: () => root,
    getDefaultStorePath: () => root,
    notifyChanged: payload => changed.push(payload),
  })
}

async function pathExists(filePath: string): Promise<boolean> {
  return Boolean(await stat(filePath).catch(() => null))
}

describe('OnethingTodoPlanStore', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'onething-todo-plan-store-'))
    changed = []
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('does not create the session AI todo while reading a snapshot', async () => {
    const snapshot = await createStore().readSnapshot({ sessionId: 'session-a' })

    expect(snapshot.sessionAiTodo).toBeUndefined()
    expect(await pathExists(path.join(root, 'sessions'))).toBe(false)
    expect(snapshot.userNotes).toHaveLength(1)
  })

  it('has no AI todo without a session', async () => {
    const snapshot = await createStore().readSnapshot({})

    expect(snapshot.sessionAiTodo).toBeUndefined()
  })

  it('rejects an AI todo update with no session', async () => {
    await expect(createStore().updateDocument({
      scope: 'session-ai-todo',
      content: '# AI Todo\n\n## Now\n- [ ] Real work\n',
    })).rejects.toThrow('sessionId is required')
  })

  it('rejects empty session AI todo creation', async () => {
    await expect(createStore().updateDocument({
      scope: 'session-ai-todo',
      sessionId: 'session-a',
      content: '# AI Todo\n\n## Now\n\n',
    })).rejects.toThrow('session-ai-todo content is empty')

    expect(await pathExists(path.join(root, 'sessions'))).toBe(false)
  })

  it('treats a watcher event as our own echo only while the file still holds what we wrote', async () => {
    const store = createStore()
    const document = await store.updateDocument({
      scope: 'session-ai-todo',
      sessionId: 'session-a',
      content: '- [ ] one\n',
    })
    expect(store.wasSelfWrite(document.filePath)).toBe(true)
    // Another writer (an AI tool) lands inside the old 2-second window: that is not our echo.
    await writeFile(document.filePath, '- [ ] one\n- [ ] two\n')
    expect(store.wasSelfWrite(document.filePath)).toBe(false)
    expect(store.wasSelfWrite(path.join(root, 'sessions', 'other', 'ai-todo.md'))).toBe(false)
  })

  it('creates the session AI todo only when it is written with content', async () => {
    const store = createStore()

    const document = await store.updateDocument({
      scope: 'session-ai-todo',
      sessionId: 'session-a',
      content: '# AI Todo\n\n## Now\n- [ ] Real work\n',
    })

    expect(document.scope).toBe('session-ai-todo')
    expect(await readFile(document.filePath, 'utf-8')).toContain('Real work')
    expect(changed).toEqual([
      expect.objectContaining({ scope: 'session-ai-todo', sessionId: 'session-a' }),
    ])

    const snapshot = await store.readSnapshot({ sessionId: 'session-a' })
    expect(snapshot.sessionAiTodo?.content).toContain('Real work')
  })

  // Session and note ids arrive over IPC and land straight in a file path. The
  // permission policy auto-allows writes under the todo directory, so a path
  // that escapes it would escape that trust too.
  describe('rejects ids that would escape the todo directory', () => {
    const escapes = ['../../../../etc/hosts', '..', '.', 'a/b', '/etc/hosts', '']

    it.each(escapes)('rejects sessionId %j', async (sessionId) => {
      await expect(createStore().updateDocument({
        scope: 'session-ai-todo',
        sessionId,
        content: '# AI Todo\n\n- [ ] Escape\n',
      })).rejects.toThrow(/Invalid sessionId|sessionId is required/)
    })

    it.each(['../../../../etc/hosts', 'a/b'])('rejects note id %j', async (id) => {
      await expect(createStore().updateDocument({
        scope: 'user-note',
        id,
        content: '# Note\n',
      })).rejects.toThrow(/Invalid note id/)
    })

    it('leaves nothing behind outside the todo directory', async () => {
      await createStore().updateDocument({
        scope: 'session-ai-todo',
        sessionId: '../escaped',
        content: '# AI Todo\n\n- [ ] Escape\n',
      }).catch(() => {})

      expect(await pathExists(path.join(root, '..', 'escaped'))).toBe(false)
    })
  })

  // The regression this whole change exists for: the AI todo used to be keyed by
  // working directory, so two sessions sharing one directory — or any two
  // sessions with no directory at all — read and wrote the same file.
  it('keeps two sessions apart even in the same working directory', async () => {
    const store = createStore()

    await store.updateDocument({
      scope: 'session-ai-todo',
      sessionId: 'session-a',
      content: '# AI Todo\n\n- [ ] Session A work\n',
    })
    await store.updateDocument({
      scope: 'session-ai-todo',
      sessionId: 'session-b',
      content: '# AI Todo\n\n- [ ] Session B work\n',
    })

    const a = await store.readSnapshot({ sessionId: 'session-a' })
    const b = await store.readSnapshot({ sessionId: 'session-b' })

    expect(a.sessionAiTodo?.content).toContain('Session A work')
    expect(a.sessionAiTodo?.content).not.toContain('Session B work')
    expect(b.sessionAiTodo?.content).toContain('Session B work')
    expect(b.sessionAiTodo?.content).not.toContain('Session A work')
  })
})
