import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DurableMailbox } from '@onething/core/actors'
import type { OnethingBackend } from '../backend.js'

let directory: string
let previous: string | undefined
let backend: OnethingBackend | undefined
const releases: Array<() => void> = []

beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'backend-mailbox-failure-')))
  previous = process.env.ONETHING_STORE_PATH
  process.env.ONETHING_STORE_PATH = directory
  vi.resetModules()
})
afterEach(async () => {
  releases.splice(0).forEach(release => release())
  // These tests end on a failed but fully drained Backend. Only remove the
  // isolated fixture after all cleanup has settled.
  await backend?.dispose().catch(() => {})
  backend = undefined
  vi.restoreAllMocks()
  if (previous === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previous
  await fs.rm(directory, { recursive: true, force: true })
})

async function assemble() {
  const { createOnethingBackend } = await import('../backend.js')
  backend = await createOnethingBackend({ storePath: directory, owner: 'daemon', collab: true, toolRegistry: 'headless', host: {
    storePath: {}, sandbox: {}, auth: null, logging: null, shell: null, voice: null,
    terminal: null, skillsEnvironment: null, todoPlan: null, scratchpad: null, plugins: null,
    gateway: null, settings: null, evals: null, mcp: null, localTrust: null, speechOutput: null, dialog: null,
  } })
  const agents = await import('../wiring/agents/index.js')
  const runtime = await import('../wiring/collab/actors/runtime.js')
  const core = await import('@onething/core/actors')
  const { inspectStoreLock } = await import('@onething/runtime/storage/store-lock')
  const event = (id: string) => core.createActorEvent({
    id, at: 1, type: 'probe', from: { kind: 'room', id: 'room' }, to: { kind: 'agent', id: 'failure-agent' },
    payload: { type: 'probe' },
  })
  return { instance: backend, agents, runtime, core, inspectStoreLock, event }
}

async function breakAppend(mailbox: DurableMailbox) {
  await fs.rename(mailbox.logPath, `${mailbox.logPath}.saved`)
  await fs.mkdir(mailbox.logPath)
}

it.each(['append', 'cursor'] as const)('reports a real %s save failure, continues other cleanup and still hands the store back', { timeout: 60000 }, async kind => {
  const { instance, agents, runtime, core, inspectStoreLock, event } = await assemble()
  agents.createAgent({ id: 'failure-agent', name: 'Failure agent' })
  agents.createAgent({ id: 'healthy-agent', name: 'Healthy agent' })
  const opened = vi.spyOn(core.DurableMailbox, 'open')
  await runtime.warmCollabV3Agents()
  const mailboxes = await Promise.all(opened.mock.results.map(result => result.value as Promise<DurableMailbox>))
  const failed = mailboxes.find(mailbox => mailbox.ownerId === 'failure-agent')!
  const healthy = mailboxes.find(mailbox => mailbox.ownerId === 'healthy-agent')!
  const healthyActor = runtime.peekCollabV3Agent('healthy-agent')!
  expect(healthyActor.running).toBe(true)
  let persistenceFailure: unknown
  if (kind === 'append') {
    await breakAppend(failed)
    persistenceFailure = await failed.append(event('failed')).catch(error => error)
    expect(persistenceFailure).toMatchObject({ code: 'EISDIR' })
  } else {
    await fs.mkdir(failed.cursorPath)
    const ack = vi.spyOn(failed, 'ack')
    await failed.append(event('cursor-failure'))
    // The real actor consumes the event and hits the actual atomic cursor IO.
    await vi.waitFor(() => expect(ack.mock.results.some(result => result.type === 'throw')).toBe(true))
    persistenceFailure = ack.mock.results.find(result => result.type === 'throw')!.value
  }
  await expect(failed.flush()).rejects.toBe(persistenceFailure)
  const cleaned = vi.fn()
  const flushed = vi.fn()
  const released = vi.fn()
  instance.own(cleaned, 'independent cleanup', 'resources')
  instance.own(flushed, 'independent flush', 'flush')
  instance.own(released, 'release runs regardless', 'release')
  const failure = await instance.dispose().catch(error => error)
  expect(failure).toMatchObject({ name: 'BackendShutdownError', timedOut: false })
  const collab = failure.failures.find((item: { step: string }) => item.step === 'collab')
  expect(collab.cause).toBeInstanceOf(AggregateError)
  expect(collab.cause.errors).toContain(persistenceFailure)
  expect(cleaned).toHaveBeenCalledOnce()
  expect(flushed).toHaveBeenCalledOnce()
  // The failure is reported, but the process exits behind this: a lock kept
  // past the last writer only locks the next launch out.
  expect(released).toHaveBeenCalledOnce()
  expect(healthyActor.running).toBe(false)
  await expect(healthy.append(event('after-close'))).rejects.toThrow('after close')
  expect(inspectStoreLock({ storePath: directory }).status).toBe('absent')
  await expect(instance.dispose()).rejects.toBe(failure)
})

it('reports a failed save from a real mailbox whose open finishes after shutdown begins', { timeout: 60000 }, async () => {
  const { instance, agents, runtime, core, inspectStoreLock, event } = await assemble()
  agents.createAgent({ id: 'failure-agent', name: 'Late agent' })
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  releases.push(release)
  const open = core.DurableMailbox.open.bind(core.DurableMailbox)
  let mailbox!: DurableMailbox
  vi.spyOn(core.DurableMailbox, 'open').mockImplementation(async options => {
    const actual = await open(options)
    if (options.ownerId === 'failure-agent') {
      mailbox = actual
      entered()
      await held
    }
    return actual
  })
  const warming = runtime.warmCollabV3Agents().catch(error => error)
  await started
  // Keep the actual initialized mailbox at the factory handoff while a real
  // filesystem write fails. Its flush must remain visible after it is rejected
  // as an uninstalled resource, rather than disappearing with roomPending.
  await breakAppend(mailbox)
  const persistenceFailure = await mailbox.append(event('late-failure')).catch(error => error)
  expect(persistenceFailure).toMatchObject({ code: 'EISDIR' })
  let settled = false
  const stopping = instance.dispose().then(() => { settled = true; return undefined }, error => { settled = true; return error })
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(settled).toBe(false)
  expect(inspectStoreLock({ storePath: directory }).status).toBe('held')
  release()
  await warming
  const failure = await stopping
  expect(failure).toMatchObject({ name: 'BackendShutdownError', timedOut: false })
  const collab = failure.failures.find((item: { step: string }) => item.step === 'collab')
  expect(collab.cause.errors).toContain(persistenceFailure)
  expect(runtime.peekCollabV3Agent('failure-agent')).toBeUndefined()
  await expect(mailbox.append(event('closed'))).rejects.toThrow('after close')
  expect(inspectStoreLock({ storePath: directory }).status).toBe('absent')
})

it('owns a deleted room cleanup through its delayed real mailbox failure before shutting down the Backend', { timeout: 60000 }, async () => {
  const { instance, runtime, core, inspectStoreLock, event } = await assemble()
  const sessions = await import('../stores/sessions.js')
  sessions.createSession('room', 'Room being deleted')
  sessions.updateSessionCollab('room', { kind: 'room', room: { memberAgentIds: [] } })
  const opened = vi.spyOn(core.DurableMailbox, 'open')
  await runtime.postCollabV3RoomMessage('room', {
    id: 'room-message', role: 'user', content: 'A real room mailbox.', timestamp: Date.now(),
  })
  const mailboxes = await Promise.all(opened.mock.results.map(result => result.value as Promise<DurableMailbox>))
  const mailbox = mailboxes.find(candidate => candidate.ownerId === 'room')!
  expect(runtime.peekCollabV3Room('room')).toBeDefined()
  await breakAppend(mailbox)
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  releases.push(release)
  const appendFile = fs.appendFile.bind(fs)
  vi.spyOn(fs, 'appendFile').mockImplementation(async (...args) => {
    if (String(args[0]) === mailbox.logPath) { entered(); await held }
    return appendFile(...args)
  })
  const appending = mailbox.append(event('late-room-save')).catch(error => error)
  await started
  const flushing = vi.spyOn(mailbox, 'flush')
  const context = { userId: 'local-user', workspaceId: 'default' }
  await instance.sessionLayer.deletion.delete('room', ['room'], ids => {
    instance.sessionLayer.access.resolveAll(context, ids, 'delete')
  })
  // The real deletion listener has removed the room from the actor map, but
  // its captured cleanup promise must remain in the Backend's drain set.
  await vi.waitFor(() => expect(flushing).toHaveBeenCalled())
  expect(sessions.getSession('room')).toBeUndefined()
  expect(runtime.peekCollabV3Room('room')).toBeUndefined()
  const cleaned = vi.fn()
  const released = vi.fn()
  instance.own(cleaned, 'cleanup after deleted room failure', 'resources')
  instance.own(released, 'release after failed room cleanup', 'release')
  let settled = false
  const stopping = instance.dispose().then(() => { settled = true; return undefined }, error => { settled = true; return error })
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(settled).toBe(false)
  expect(inspectStoreLock({ storePath: directory }).status).toBe('held')
  release()
  const persistenceFailure = await appending
  expect(persistenceFailure).toMatchObject({ code: 'EISDIR' })
  const failure = await stopping
  expect(failure).toMatchObject({ name: 'BackendShutdownError', timedOut: false })
  const collab = failure.failures.find((item: { step: string }) => item.step === 'collab')
  expect(collab.cause.errors).toContain(persistenceFailure)
  expect(cleaned).toHaveBeenCalledOnce()
  expect(released).toHaveBeenCalledOnce()
  await expect(mailbox.append(event('after-deleted-room-close'))).rejects.toThrow('after close')
  expect(inspectStoreLock({ storePath: directory }).status).toBe('absent')
})
