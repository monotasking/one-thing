import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer, type ServerResponse } from 'node:http'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const control = vi.hoisted(() => ({
  url: '', signals: [] as AbortSignal[],
  auth: async () => {},
  onUsage: undefined as ((usage: { inputTokens: number; outputTokens: number; totalTokens: number }) => void) | undefined,
}))
vi.mock('../wiring/engine/stream/provider-helpers.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../wiring/engine/stream/provider-helpers.js')>()
  return { ...actual,
    getEffectiveProviderConfig: () => ({ providerId: 'custom-digest', model: 'digest-local', providerConfig: {
      model: 'digest-local', selectedModels: ['digest-local'], apiKey: 'local-test-only', apiType: 'openai', baseUrl: control.url,
    } }),
    resolveProviderAuth: async (...args: Parameters<typeof actual.resolveProviderAuth>) => {
      await control.auth()
      return actual.resolveProviderAuth(...args)
    },
  }
})
vi.mock('../wiring/providers/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../wiring/providers/index.js')>()
  return { ...actual,
    generateChatResponse: (...args: Parameters<typeof actual.generateChatResponse>) => {
      control.onUsage = args[3]?.onUsage
      return actual.generateChatResponse(...args)
    },
  }
})
vi.mock('../provider-binding/bound-fetch.js', async importOriginal => ({
  ...await importOriginal<typeof import('../provider-binding/bound-fetch.js')>(),
  // Real provider serializer, parser and TCP. Ignore transport cancellation to
  // exercise the underlying promise, rather than an already-settled abort race.
  createRequiredAppFetch: () => (url: string | URL | Request, init?: RequestInit) => {
    if (init?.signal) control.signals.push(init.signal)
    return fetch(url, { ...init, signal: undefined })
  },
}))

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
let directory: string
let previousStore: string | undefined
let backend: Awaited<ReturnType<typeof import('../backend.js')['createOnethingBackend']>> | undefined
const cleanups: Array<() => void | Promise<void>> = []
beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'digest-backend-')))
  previousStore = process.env.ONETHING_STORE_PATH
  process.env.ONETHING_STORE_PATH = path.join(directory, 'a')
  control.signals = []
  control.auth = async () => {}
  control.onUsage = undefined
  // The importOriginal partial mocks above keep their actual provider facade.
  // Keep Backend assembly in that same module graph so each new owner rebinds
  // the registry those provider functions read, just as production does.
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  await backend?.dispose()
  backend = undefined
  vi.restoreAllMocks()
  if (previousStore === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStore
  await fs.rm(directory, { recursive: true, force: true })
})
async function assemble(storePath: string) {
  process.env.ONETHING_STORE_PATH = storePath
  const { createOnethingBackend } = await import('../backend.js')
  return createOnethingBackend({ storePath, owner: 'daemon', toolRegistry: 'headless', host: {
    storePath: {}, sandbox: {}, auth: null, logging: null, shell: null, voice: null,
    terminal: null, skillsEnvironment: null, todoPlan: null, scratchpad: null, plugins: null,
    gateway: null, settings: null, evals: null, mcp: null, localTrust: null,
  } })
}
async function room(id = 'room') {
  const sessions = await import('../stores/sessions.js')
  sessions.createSession(id, 'Digest room')
  sessions.updateSessionCollab(id, { kind: 'room', room: { memberAgentIds: [], context: { historyDays: 1, historyTailCount: 0 } } })
  const timestamp = Date.now() - 3 * 86400_000
  backend!.sessionLayer.commands.appendMessage(id, { message: {
    id: id + '-fact', role: 'user', content: 'The room agreed to ship the migration tomorrow.', timestamp,
  } })
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
async function provider() {
  const entered = barrier()
  let response: ServerResponse | undefined
  const requests: Array<Record<string, unknown>> = []
  const server = createServer(async (request, reply) => {
    let body = ''
    for await (const chunk of request) body += chunk.toString()
    requests.push(JSON.parse(body))
    response = reply
    entered.release()
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
  control.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  const respond = (summary = 'The migration will ship tomorrow.') => {
    if (!response || response.writableEnded) return
    response?.writeHead(200, { 'content-type': 'text/event-stream' }).end([
      `data: ${JSON.stringify({ id: 'local', choices: [{ index: 0, delta: { content: summary }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'local', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 } })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''))
  }
  cleanups.push(() => { respond(); server.closeAllConnections(); server.close() })
  const waitForRequest = async (work: Promise<void>) => {
    // An early provider failure must not turn into a minute waiting for TCP.
    // This only observes work; its real promise remains owned by the Backend.
    await Promise.race([entered.promise, work.then(() => {
      throw new Error('Digest work settled before the local provider received its request')
    })])
  }
  return { entered, requests, respond, waitForRequest }
}
async function usage(storePath: string) {
  const files = await fs.readdir(path.join(storePath, 'usage')).catch(() => [])
  return (await Promise.all(files.filter(file => file.endsWith('.jsonl')).map(file => fs.readFile(path.join(storePath, 'usage', file), 'utf8'))))
    .join('').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

it('keeps the real auth promise and lease until it settles; shutdown blocks the next provider action and old runner after reinstall', { timeout: 60000 }, async () => {
  const local = await provider()
  backend = await assemble(path.join(directory, 'a'))
  const day = await room()
  const oldRunner = backend.collabDigests
  const entered = barrier()
  const release = barrier()
  cleanups.unshift(release.release)
  control.auth = async () => { entered.release(); await release.promise }
  const work = oldRunner.ensureCollabDigests('room', [day])
  await entered.promise
  let disposed = false
  const stopping = backend.dispose().then(() => { disposed = true })
  await vi.waitFor(() => expect(() => oldRunner.ensureCollabDigests('room', [day])).toThrow('shutting down'))
  const { inspectStoreLock } = await import('@onething/runtime/storage/store-lock')
  expect(inspectStoreLock({ storePath: path.join(directory, 'a') }).status).toBe('held')
  expect(disposed).toBe(false)
  expect(local.requests).toHaveLength(0)
  release.release()
  await work
  await stopping
  expect(local.requests).toHaveLength(0)
  expect(inspectStoreLock({ storePath: path.join(directory, 'a') }).status).toBe('absent')
  backend = await assemble(path.join(directory, 'b'))
  expect(() => oldRunner.ensureCollabDigestsForRoom('room')).toThrow('shutting down')
  await expect(fs.stat(path.join(directory, 'b', 'collab', 'room', 'digests.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('drains the real delayed model response under the A lease, bills A, and cannot save a late digest or bill B', { timeout: 60000 }, async () => {
  const local = await provider()
  const storeA = path.join(directory, 'a')
  const storeB = path.join(directory, 'b')
  backend = await assemble(storeA)
  const day = await room()
  const oldRunner = backend.collabDigests
  const work = oldRunner.ensureCollabDigestsForRoom('room')
  await local.waitForRequest(work)
  expect(JSON.stringify(local.requests[0])).toContain('ship the migration tomorrow')
  let disposed = false
  const stopping = backend.dispose().then(() => { disposed = true })
  await vi.waitFor(() => expect(control.signals.at(-1)?.aborted).toBe(true))
  const { inspectStoreLock } = await import('@onething/runtime/storage/store-lock')
  expect(inspectStoreLock({ storePath: storeA }).status).toBe('held')
  expect(disposed).toBe(false)
  // A provider may report billed usage before its ignored cancellation resolves.
  // The real wire may instead discard its final event after abort; both paths
  // must keep this captured callback bound to A until the actual call settles.
  control.onUsage?.({ inputTokens: 21, outputTokens: 7, totalTokens: 28 })
  local.respond()
  await work
  await stopping
  expect(inspectStoreLock({ storePath: storeA }).status).toBe('absent')
  expect(await usage(storeA)).toEqual([expect.objectContaining({ source: 'collab-digest', sessionId: 'room' })])
  await expect(fs.stat(path.join(storeA, 'collab', 'room', 'digests.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  backend = await assemble(storeB)
  await room()
  expect(() => oldRunner.ensureCollabDigests('room', [day])).toThrow('shutting down')
  control.onUsage?.({ inputTokens: 999, outputTokens: 999, totalTokens: 1998 })
  await backend.dispose()
  expect(await usage(storeB)).toEqual([])
  expect(await usage(storeA)).toHaveLength(1)
  await expect(fs.stat(path.join(storeB, 'collab', 'room', 'digests.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('uses the same provider module after A disposes and B sends a real model request to its own store', { timeout: 60000 }, async () => {
  const storeA = path.join(directory, 'a')
  const storeB = path.join(directory, 'b')
  const localA = await provider()
  backend = await assemble(storeA)
  const dayA = await room()
  const runnerA = backend.collabDigests
  const workA = runnerA.ensureCollabDigestsForRoom('room')
  await localA.waitForRequest(workA)
  localA.respond('Backend A completed its migration review.')
  await workA
  await backend.dispose()
  const digestAPath = path.join(storeA, 'collab', 'room', 'digests.json')
  const digestA = await fs.readFile(digestAPath, 'utf8')
  expect(JSON.parse(digestA).days[dayA].summary).toBe('Backend A completed its migration review.')
  const usageA = await usage(storeA)
  expect(usageA).toEqual([expect.objectContaining({ source: 'collab-digest', sessionId: 'room' })])

  // No resetModules: the same provider factory must now read B's live registry.
  const localB = await provider()
  backend = await assemble(storeB)
  const dayB = await room()
  expect(() => runnerA.ensureCollabDigests('room', [dayA])).toThrow('shutting down')
  const workB = backend.collabDigests.ensureCollabDigestsForRoom('room')
  await localB.waitForRequest(workB)
  expect(JSON.stringify(localB.requests[0])).toContain('ship the migration tomorrow')
  localB.respond('Backend B completed its separate migration review.')
  await workB
  await backend.dispose()

  expect(localA.requests).toHaveLength(1)
  expect(localB.requests).toHaveLength(1)
  const digestB = JSON.parse(await fs.readFile(path.join(storeB, 'collab', 'room', 'digests.json'), 'utf8'))
  expect(digestB.days[dayB].summary).toBe('Backend B completed its separate migration review.')
  expect(await usage(storeB)).toEqual([expect.objectContaining({ source: 'collab-digest', sessionId: 'room' })])
  expect(await fs.readFile(digestAPath, 'utf8')).toBe(digestA)
  expect(await usage(storeA)).toEqual(usageA)
})

it('preserves folded-day selection, request deduplication, parsing, usage and the room opt-out on the real provider path', { timeout: 60000 }, async () => {
  const local = await provider()
  backend = await assemble(path.join(directory, 'a'))
  const day = await room()
  expect(backend.collabDigests.collabFoldedDays('room', Date.now())).toEqual([day])
  const work = backend.collabDigests.ensureCollabDigestsForRoom('room')
  await local.waitForRequest(work)
  await backend.collabDigests.ensureCollabDigests('room', [day, day])
  expect(local.requests).toHaveLength(1)
  local.respond('  The migration will ship tomorrow.  ')
  await work
  const { getUsageLedger } = await import('../wiring/usage/index.js')
  await getUsageLedger().flush()
  expect(await usage(path.join(directory, 'a'))).toEqual([expect.objectContaining({ source: 'collab-digest', sessionId: 'room' })])
  const digests = await import('@onething/runtime/collab/digest-store')
  expect(digests.getCollabDigests('room')).toEqual([expect.objectContaining({ day, summary: 'The migration will ship tomorrow.', messageCount: 1 })])
  await backend.collabDigests.ensureCollabDigestsForRoom('room')
  expect(local.requests).toHaveLength(1)
  const sessions = await import('../stores/sessions.js')
  sessions.updateSessionCollab('room', { room: { memberAgentIds: [], context: { dailyDigest: false } } })
  digests.forgetCollabDigests('room')
  await backend.collabDigests.ensureCollabDigests('room', [day])
  expect(local.requests).toHaveLength(1)
})

it('does not release or repeat a timed-out model while the underlying provider response is still pending', { timeout: 60000 }, async () => {
  const local = await provider()
  backend = await assemble(path.join(directory, 'a'))
  const day = await room()
  const { createCollabDigestRunner } = await import('../wiring/collab/digest-runner.js')
  const { createCollabDigestStore } = await import('@onething/runtime/collab/digest-store')
  const { captureUsageRecorder } = await import('../wiring/usage/index.js')
  const runner = createCollabDigestRunner({
    store: createCollabDigestStore({ storePath: path.join(directory, 'a') }),
    access: backend.sessionLayer.access, assertOwned: () => {}, recordUsage: captureUsageRecorder(), timeoutMs: 30,
  })
  backend.own(() => runner.quiesce(), 'testDigestAdmission', 'quiesce')
  backend.own(() => runner.drain(), 'testDigestDrain', 'drain')
  const work = runner.ensureCollabDigests('room', [day])
  await local.waitForRequest(work)
  await vi.waitFor(() => expect(control.signals.at(-1)?.aborted).toBe(true))
  await runner.ensureCollabDigests('room', [day])
  expect(local.requests).toHaveLength(1)
  let disposed = false
  const stopping = backend.dispose().then(() => { disposed = true })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(disposed).toBe(false)
  local.respond()
  await work
  await stopping
  await expect(fs.stat(path.join(directory, 'a', 'collab', 'room', 'digests.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['auth', 'model'] as const)('rechecks the captured room identity after a delayed %s and prevents the next write or request', { timeout: 60000 }, async phase => {
  const local = await provider()
  backend = await assemble(path.join(directory, 'a'))
  const day = await room()
  const entered = barrier()
  const release = barrier()
  cleanups.unshift(release.release)
  if (phase === 'auth') control.auth = async () => { entered.release(); await release.promise }
  const work = backend.collabDigests.ensureCollabDigests('room', [day])
  await (phase === 'auth' ? entered.promise : local.waitForRequest(work))
  const sessions = await import('../stores/sessions.js')
  const ownerPatch = { name: 'New owner room', ownerUserId: 'new-owner' }
  sessions.patchSessionFields('room', ownerPatch, meta => { Object.assign(meta, { ownerUserId: 'new-owner' }) })
  release.release()
  if (phase === 'model') local.respond()
  await work
  expect(local.requests).toHaveLength(phase === 'auth' ? 0 : 1)
  expect(() => backend!.collabDigests.ensureCollabDigests('room', [day])).toThrow('Session not found')
  await expect(fs.stat(path.join(directory, 'a', 'collab', 'room', 'digests.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('waits for a real room digest when deleting that room and keeps the late result from recreating its files', { timeout: 60000 }, async () => {
  const local = await provider()
  backend = await assemble(path.join(directory, 'a'))
  const day = await room()
  const work = backend.collabDigests.ensureCollabDigests('room', [day])
  await local.waitForRequest(work)
  const context = { userId: 'local-user', workspaceId: 'default' }
  const access = backend.sessionLayer.access
  let removed = false
  const removing = backend.sessionLayer.deletion.delete('room', ['room'], ids => { access.resolveAll(context, ids, 'delete') })
    .then(() => { removed = true })
  await vi.waitFor(() => expect(control.signals.at(-1)?.aborted).toBe(true))
  expect(removed).toBe(false)
  expect(() => backend!.collabDigests.ensureCollabDigests('room', [day])).toThrow('closing or deleted')
  local.respond()
  await work
  await removing
  const sessions = await import('../stores/sessions.js')
  expect(sessions.getSession('room')).toBeUndefined()
  await expect(fs.stat(path.join(directory, 'a', 'collab', 'room', 'digests.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('registers a production MindPort follow-up before the room turn returns, so immediate shutdown owns its pending auth', { timeout: 60000 }, async () => {
  const local = await provider()
  backend = await assemble(path.join(directory, 'a'))
  await room()
  const agents = await import('../wiring/agents/index.js')
  agents.createAgent({ id: 'digest-agent', name: 'Digest agent' })
  const sessions = await import('../stores/sessions.js')
  sessions.createSession('exec', 'Agent execution')
  const { createCollabActorAuthorization } = await import('../wiring/collab/actors/execution-authorization.js')
  const authorization = createCollabActorAuthorization({ access: backend.sessionLayer.access, isAccepting: () => !backend!.isShuttingDown })
  authorization.activateRoom('room', backend.sessionLayer.access.resolve({ userId: 'local-user', workspaceId: 'default' }, 'room', 'write'))
  const { createCollabEngineMindPort } = await import('../wiring/collab/actors/engine-mind-port.js')
  const mind = createCollabEngineMindPort({ authorization })
  vi.spyOn(backend.engine, 'hasCommandTarget').mockReturnValue(true)
  const { SESSION_COMMAND_TYPES, SESSION_EVENT_TYPES } = await import('@shared/events/index.js')
  const realEmit = backend.eventBus.emit.bind(backend.eventBus)
  vi.spyOn(backend.eventBus, 'emit').mockImplementation(async (id, event, ...rest) => {
    if (event.type === SESSION_COMMAND_TYPES.SEND_MESSAGE && id === 'exec') {
      await realEmit(id, { type: SESSION_EVENT_TYPES.STREAM_START, messageId: 'turn', assistantMessageId: 'turn' })
      return realEmit(id, { type: SESSION_EVENT_TYPES.STREAM_COMPLETE, data: {} })
    }
    return realEmit(id, event, ...rest)
  })
  const release = barrier()
  let authStarted = false
  cleanups.unshift(release.release)
  control.auth = async () => { authStarted = true; await release.promise }
  const result = await mind.runConversationalTurn({
    roomSessionId: 'room', execSessionId: 'exec', agentId: 'digest-agent', driveContent: 'Read the room.',
    lease: { leaseId: 'lease', epoch: 1, roomId: 'room', agentId: 'digest-agent', issuedAt: Date.now() },
  })
  expect(result.outcome).toBe('complete')
  expect(authStarted).toBe(true)
  let disposed = false
  const stopping = backend.dispose().then(() => { disposed = true })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(disposed).toBe(false)
  release.release()
  await stopping
  expect(local.requests).toHaveLength(0)
})
