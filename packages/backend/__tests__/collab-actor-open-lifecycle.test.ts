import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

async function readIfExists(filePath: string): Promise<string | null> {
  try { return await fs.readFile(filePath, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

let root: string
let previous: string | undefined
let backend: Awaited<ReturnType<typeof import('../backend.js')['createOnethingBackend']>> | undefined
const releases: Array<() => void> = []

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'collab-open-lifecycle-')))
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

async function assemble(storePath: string) {
  process.env.ONETHING_STORE_PATH = storePath
  const { createOnethingBackend } = await import('../backend.js')
  return createOnethingBackend({ storePath, owner: 'daemon', collab: true, toolRegistry: 'headless', host: {
    storePath: {}, sandbox: {}, auth: null, logging: null, shell: null, voice: null,
    terminal: null, skillsEnvironment: null, todoPlan: null, scratchpad: null, plugins: null,
    gateway: null, settings: null, evals: null, mcp: null, localTrust: null, speechOutput: null, dialog: null,
  } })
}

it.each(['agent', 'room'] as const)('drains a board-triggered real %s mailbox open before releasing the Backend lease and reinstalling the same agent', { timeout: 60000 }, async kind => {
  const firstPath = path.join(root, 'first')
  const secondPath = path.join(root, 'second')
  backend = await assemble(firstPath)
  const agents = await import('../wiring/agents/index.js')
  agents.createAgent({ id: 'same-agent', name: 'First agent' })
  const sessions = await import('../stores/sessions.js')
  sessions.createSession('room', 'Room')
  sessions.updateSessionCollab('room', { kind: 'room', room: { memberAgentIds: ['same-agent'] } })
  const runtime = await import('../wiring/collab/actors/runtime.js')
  const board = await import('../wiring/collab/board-store.js')
  const { DurableMailbox } = await import('@onething/core/actors')
  const close = vi.spyOn(DurableMailbox.prototype, 'close')
  const read = fs.readFile.bind(fs)
  const entered = barrier()
  const finishRead = barrier()
  releases.push(finishRead.release)
  const inbox = kind === 'agent'
    ? path.join(firstPath, 'agents-v3', 'same-agent', 'inbox.jsonl')
    : path.join(firstPath, 'collab', 'room', 'actors', 'inbox.jsonl')
  // The mailbox uses its real mkdir/create/read path; delay completion of this
  // one filesystem read, without substituting a mailbox or actor implementation.
  const readSpy = vi.spyOn(fs, 'readFile').mockImplementation(((...args: Parameters<typeof fs.readFile>) => {
    const operation = read(...args)
    if (String(args[0]) !== inbox) return operation
    entered.release()
    return finishRead.promise.then(() => operation)
  }) as typeof fs.readFile)

  const result = await board.applyBoardAction('room', kind === 'agent'
    ? { action: 'start', title: 'Work' }
    : { action: 'create', title: 'Work', assigneeAgentId: 'same-agent' }, { type: 'agent', agentId: 'same-agent' })
  expect(result.error).toBeUndefined()
  await vi.waitFor(() => expect(readSpy).toHaveBeenCalledWith(inbox), { timeout: 5000 })
  await entered.promise
  expect(runtime.peekCollabV3Agent('same-agent')).toBeUndefined()
  expect(runtime.peekCollabV3Room('room')).toBeUndefined()
  let stopped = false
  const stopping = backend.dispose().then(() => { stopped = true })
  const { inspectStoreLock } = await import('@onething/runtime/storage/store-lock')
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(stopped).toBe(false)
  expect(inspectStoreLock({ storePath: firstPath }).status).toBe('held')
  finishRead.release()
  await stopping
  expect(close).toHaveBeenCalled()
  expect(inspectStoreLock({ storePath: firstPath }).status).toBe('absent')
  await expect(fs.stat(path.join(firstPath, 'agents-v3', 'same-agent', 'state.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(fs.stat(path.join(firstPath, 'collab', 'room', 'actors', 'room.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  readSpy.mockRestore()

  backend = await assemble(secondPath)
  expect(agents.findAgent('same-agent')).toBeNull()
  agents.createAgent({ id: 'same-agent', name: 'Second agent' })
  await runtime.warmCollabV3Agents()
  const replacement = runtime.peekCollabV3Agent('same-agent')
  expect(replacement?.running).toBe(true)
  const secondAccount = path.join(secondPath, 'agents-v3', 'same-agent', 'state.json')
  const before = await readIfExists(secondAccount)
  await new Promise(resolve => setTimeout(resolve, 40))
  expect(runtime.peekCollabV3Agent('same-agent')).toBe(replacement)
  expect(await readIfExists(secondAccount)).toBe(before)
  await expect(fs.stat(path.join(secondPath, 'collab', 'room'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(fs.stat(path.join(firstPath, 'agents-v3', 'same-agent', 'state.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('binds an installed actor account to its creating Backend and rejects a late account write after reinstall', { timeout: 60000 }, async () => {
  backend = await assemble(path.join(root, 'first'))
  const agents = await import('../wiring/agents/index.js')
  const runtime = await import('../wiring/collab/actors/runtime.js')
  const accountModule = await import('@onething/runtime/collab/actors/agent-mailbox')
  // Observe the actual store injected into actor construction; no replacement
  // store implementation or manual cache reset is used on either Backend.
  const accountStores = vi.spyOn(accountModule, 'createCollabAgentAccountFileStore')
  agents.createAgent({ id: 'same-agent', name: 'First agent' })
  await runtime.warmCollabV3Agents()
  const oldActor = runtime.peekCollabV3Agent('same-agent')!
  const oldAccountStore = accountStores.mock.results.at(-1)!.value as ReturnType<typeof accountModule.createCollabAgentAccountFileStore>
  expect(oldActor.running).toBe(true)
  await backend.dispose()
  expect(oldActor.running).toBe(false)
  backend = await assemble(path.join(root, 'second'))
  expect(agents.findAgent('same-agent')).toBeNull()
  agents.createAgent({ id: 'same-agent', name: 'Second agent' })
  await runtime.warmCollabV3Agents()
  const replacement = runtime.peekCollabV3Agent('same-agent')!
  const newAccountStore = accountStores.mock.results.at(-1)!.value as ReturnType<typeof accountModule.createCollabAgentAccountFileStore>
  newAccountStore.save(replacement.account)
  const accountPath = path.join(root, 'second', 'agents-v3', 'same-agent', 'state.json')
  const before = await fs.readFile(accountPath, 'utf8')
  expect(() => oldAccountStore.save(oldActor.account)).toThrow('Collab runtime is no longer owned')
  expect(await fs.readFile(accountPath, 'utf8')).toBe(before)
  expect(runtime.peekCollabV3Agent('same-agent')).not.toBe(oldActor)
})
