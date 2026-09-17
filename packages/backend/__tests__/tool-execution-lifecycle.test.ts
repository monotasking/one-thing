import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

let directory: string
let previous: string | undefined
let backend: Awaited<ReturnType<typeof import('../backend.js')['createOnethingBackend']>> | undefined
const releases: Array<() => void> = []
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-lifecycle-'))
  previous = process.env.ONETHING_STORE_PATH
  process.env.ONETHING_STORE_PATH = directory
  vi.resetModules()
})
afterEach(async () => {
  releases.splice(0).forEach(release => release())
  await backend?.dispose()
  backend = undefined
  if (previous === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previous
  await fs.rm(directory, { recursive: true, force: true })
})

async function assemble() {
  const { createOnethingBackend } = await import('../backend.js')
  return createOnethingBackend({ storePath: directory, owner: 'daemon', toolRegistry: 'headless', host: {
    storePath: {}, sandbox: {}, auth: null, logging: null, shell: null, voice: null,
    terminal: null, skillsEnvironment: null, todoPlan: null, scratchpad: null, plugins: null,
    gateway: null, settings: null, evals: null, mcp: null, localTrust: null, speechOutput: null,
  } })
}

it('holds the actual Backend lease through tool cleanup and isolates a captured registry from a new Backend', { timeout: 60000 }, async () => {
  backend = await assemble()
  const store = await import('../stores/sessions.js')
  store.createSession('session', 'Session')
  const first = backend.toolExecutions
  const cleanup = barrier()
  const aborted = barrier()
  releases.push(cleanup.release)
  const input = { sessionId: 'session', toolCallId: 'reused-id', executionContext: { userId: 'local-user', workspaceId: 'default' } }
  const running = first.run(input, async control => {
    control.track(cleanup.promise)
    control.signal.addEventListener('abort', aborted.release, { once: true })
    await aborted.promise
  })
  const stopping = backend.dispose()
  await aborted.promise
  await running
  const { inspectStoreLock } = await import('@onething/runtime/storage/store-lock')
  expect(inspectStoreLock({ storePath: directory }).status).toBe('held')
  const { getCurrentBackendSafe } = await import('../current.js')
  expect(getCurrentBackendSafe()).toBe(backend)
  cleanup.release()
  await stopping
  expect(inspectStoreLock({ storePath: directory }).status).toBe('absent')
  backend = await assemble()
  const replacement = barrier()
  releases.push(replacement.release)
  let newSignal: AbortSignal | undefined
  const active = backend.toolExecutions.run(input, async control => {
    newSignal = control.signal
    await control.track(replacement.promise)
  })
  await expect(first.cancel({ toolCallId: input.toolCallId }, input.executionContext)).resolves.toBe(false)
  expect(newSignal?.aborted).toBe(false)
  await expect(first.run(input, async () => {})).rejects.toMatchObject({ name: 'AbortError' })
  const cancel = backend.toolExecutions.cancel({ toolCallId: input.toolCallId }, input.executionContext)
  expect(newSignal?.aborted).toBe(true)
  replacement.release()
  await expect(cancel).resolves.toBe(true)
  await active
})
