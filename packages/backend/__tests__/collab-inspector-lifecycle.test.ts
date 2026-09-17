import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let root: string
let previous: string | undefined
let backend: Awaited<ReturnType<typeof import('../backend.js')['createOnethingBackend']>> | undefined
const releases: Array<() => void> = []

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'collab-inspector-life-')))
  previous = process.env.ONETHING_STORE_PATH
  vi.resetModules()
})

afterEach(async () => {
  releases.splice(0).forEach(release => release())
  await backend?.dispose()
  backend = undefined
  vi.restoreAllMocks()
  if (previous === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previous
  await fs.rm(root, { recursive: true, force: true })
})

async function assemble(name: string, collab = false) {
  const storePath = path.join(root, name)
  process.env.ONETHING_STORE_PATH = storePath
  const { createOnethingBackend } = await import('../backend.js')
  return backend = await createOnethingBackend({ storePath, owner: 'daemon', collab, toolRegistry: 'headless', host: {
    storePath: {}, sandbox: {}, auth: null, logging: null, shell: null, voice: null,
    terminal: null, skillsEnvironment: null, todoPlan: null, scratchpad: null, plugins: null,
    gateway: null, settings: null, evals: null, mcp: null, localTrust: null, speechOutput: null,
  } })
}

async function room() {
  const sessions = await import('../stores/sessions.js')
  sessions.createSession('room', 'Inspector room')
  sessions.updateSessionCollab('room', { kind: 'room', room: { memberAgentIds: [] } })
}

it.each([false, true])('owns pending room snapshots with collab=%s and rejects an already-queued A callback after B is installed', { timeout: 60000 }, async collab => {
  const first = await assemble('a', collab)
  await room()
  const inspector = await import('../wiring/collab/inspector.js')
  const old = inspector.getCollabInspector()!
  expect(old).not.toBeNull()
  old.forget('room')
  old.note('room', { kind: 'received' })
  const timer = vi.spyOn(globalThis, 'setTimeout')
  old.broadcast('room')
  expect(timer).toHaveBeenCalledTimes(1)
  const callback = timer.mock.calls[0][0] as () => void
  expect(timer.mock.calls[0][1]).toBeGreaterThan(0)
  expect(timer.mock.calls[0][1]).toBeLessThanOrEqual(1000)
  timer.mockRestore()
  await first.dispose()
  expect(inspector.getCollabInspector()).toBeNull()
  expect(old.build('room')).toBeNull()

  const second = await assemble('b', collab)
  await room()
  const current = inspector.getCollabInspector()!
  expect(current).not.toBe(old)
  current.forget('room')
  const events: unknown[] = []
  second.eventBus.onAny('room', envelope => {
    if (envelope.event.type === 'collab:coordinator-changed') events.push(envelope.event)
  })
  // Model a callback already dequeued when quiesce cleared its OS timer. It
  // must check its captured owner and room identity before reading any store.
  expect(() => callback()).not.toThrow()
  old.note('room', { kind: 'silent', agentId: 'old-agent' })
  old.typing('room', 'old-agent', true)
  old.broadcast('room')
  old.quiesce()
  await old.drain()
  expect(current.build('room')).toMatchObject({ seq: 0, log: [], typing: [] })
  await new Promise(resolve => setTimeout(resolve, 1100))
  expect(events).toEqual([])
  current.note('room', { kind: 'received' })
  await vi.waitFor(() => expect(events).toHaveLength(1))
  expect(current.build('room')).toMatchObject({ seq: 1, log: [{ kind: 'received' }] })
})

it('keeps the Backend lease until an already-started real EventBus emission completes', { timeout: 60000 }, async () => {
  const instance = await assemble('a')
  await room()
  const { getCollabInspector } = await import('../wiring/collab/inspector.js')
  const inspector = getCollabInspector()!
  inspector.forget('room')
  const entered = barrier()
  const finish = barrier()
  releases.push(finish.release)
  let emissions = 0
  instance.eventBus.intercept(async event => {
    if (event.type === 'collab:coordinator-changed') {
      emissions += 1
      entered.release()
      await finish.promise
    }
    return { suppress: false }
  })
  inspector.broadcast('room')
  await entered.promise
  const drain = vi.spyOn(inspector, 'drain')
  let stopped = false
  const stopping = instance.dispose().then(() => { stopped = true })
  await vi.waitFor(() => expect(drain).toHaveBeenCalled())
  const { inspectStoreLock } = await import('@onething/runtime/storage/store-lock')
  expect(inspectStoreLock({ storePath: path.join(root, 'a') }).status).toBe('held')
  expect(stopped).toBe(false)
  inspector.broadcast('room')
  expect(emissions).toBe(1)
  finish.release()
  await stopping
  expect(stopped).toBe(true)
  expect(inspectStoreLock({ storePath: path.join(root, 'a') }).status).toBe('absent')
})
