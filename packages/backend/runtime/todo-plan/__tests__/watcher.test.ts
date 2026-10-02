import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OnethingTodoPlanStore, type TodoPlanChangedPayload } from '../store.js'
import { OnethingTodoPlanWatcher } from '../watcher.js'

let root: string
let changed: TodoPlanChangedPayload[]
let store: OnethingTodoPlanStore
let watcher: OnethingTodoPlanWatcher

// The watcher debounces, and the OS delivers events asynchronously — on macOS
// through FSEvents, which has real latency and gets starved when the whole suite
// runs in parallel. Wait generously; a slow machine is not a failure.
async function waitForChange(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

// fs.watch is not guaranteed to be delivering events the instant start() returns.
async function settleWatcher(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 150))
}

describe('OnethingTodoPlanWatcher', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'onething-todo-watch-'))
    changed = []
    store = new OnethingTodoPlanStore({
      getConfiguredDirectory: () => root,
      getDefaultStorePath: () => root,
    })
    watcher = new OnethingTodoPlanWatcher({
      store,
      notifyChanged: payload => changed.push(payload),
    })
    await watcher.start()
    await settleWatcher()
  })

  afterEach(async () => {
    await watcher.drain()
    await rm(root, { recursive: true, force: true })
  })

  // This is the whole reason the watcher exists: the AI writes ai-todo.md with
  // the plain write/edit tools, which never touch the store.
  it('reports an AI todo written directly on disk, attributed to its session', async () => {
    const file = path.join(root, 'sessions', 'session-a', 'ai-todo.md')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, '# AI Todo\n\n- [ ] Written by the AI\n', 'utf-8')

    await waitForChange(() => changed.length > 0)

    expect(changed).toContainEqual({ scope: 'session-ai-todo', sessionId: 'session-a' })
  }, 20_000)

  it('reports a user note edit as a global change', async () => {
    const file = path.join(root, 'user-notes', 'errands.md')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, '# Errands\n\n- [ ] Milk\n', 'utf-8')

    await waitForChange(() => changed.length > 0)

    expect(changed).toContainEqual({ scope: 'global-user' })
  }, 20_000)

  // The store already broadcasts its own writes; without suppression the panel
  // would get a second event and reload on top of itself.
  it('does not re-report a write the store made itself', async () => {
    await store.updateDocument({
      scope: 'session-ai-todo',
      sessionId: 'session-a',
      content: '# AI Todo\n\n- [ ] Saved through the store\n',
    })

    await new Promise(resolve => setTimeout(resolve, 600))

    expect(changed).toEqual([])
  })
})
