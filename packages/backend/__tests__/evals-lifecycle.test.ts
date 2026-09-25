import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import type { OnethingBackend } from '../backend.js'

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

it('aborts the real eval HTTP request and holds the Backend lease until its file cleanup settles', { timeout: 60000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-lifecycle-'))
  const previous = process.env.ONETHING_STORE_PATH
  const received = barrier()
  const cleaning = barrier()
  const cleanup = barrier()
  let requests = 0
  const authorizationHeaders: Array<string | undefined> = []
  const server = http.createServer((request, _response) => {
    requests++
    authorizationHeaders.push(request.headers.authorization)
    received.release()
  })
  let backend: OnethingBackend | undefined
  try {
    process.env.ONETHING_STORE_PATH = directory
    vi.resetModules()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const { createOnethingBackend } = await import('../backend.js')
    const { getEvalsTaskOwner } = await import('../wiring/evals/task-owner.js')
    const { createEvalsModelCaller } = await import('../wiring/evals/provider-adapter.js')
    const { setSpaceProviderCredential } = await import('../wiring/providers/space-credentials.js')
    const { inspectStoreLock } = await import('@onething/runtime/storage/store-lock')
    const assemble = () => createOnethingBackend({ storePath: directory, owner: 'daemon', toolRegistry: 'headless', host: {
      storePath: {}, sandbox: {}, auth: null, logging: null, shell: null, voice: null,
      terminal: null, skillsEnvironment: null, todoPlan: null, scratchpad: null, plugins: null,
      gateway: null, settings: null, evals: null, mcp: null, localTrust: null, speechOutput: null, dialog: null,
    } })
    backend = await assemble()
    setSpaceProviderCredential({
      id: 'default', providerId: 'openai', apiKey: 'fixture-key',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    })
    const owner = getEvalsTaskOwner()
    let capturedCaller: ReturnType<typeof createEvalsModelCaller> | undefined
    let requestError: unknown
    const running = owner.start('run', async signal => {
      capturedCaller = createEvalsModelCaller('openai', 'fixture-model', { signal })
      try { await capturedCaller({ model: 'fixture-model', messages: [{ role: 'user', content: 'fixture' }] }) }
      catch (error) { requestError = error; throw error }
      finally {
        cleaning.release()
        await cleanup.promise
        await fs.writeFile(path.join(directory, 'eval-cleanup.txt'), 'settled')
      }
    }).then(() => undefined, error => error as Error)
    await Promise.race([
      received.promise,
      cleaning.promise.then(() => { throw requestError ?? new Error('Eval request ended before reaching the test provider') }),
    ])
    expect(authorizationHeaders).toEqual(['Bearer fixture-key'])
    let disposed = false
    const stopping = backend.dispose().then(() => { disposed = true })
    await cleaning.promise
    expect(owner.has('run')).toBe(true)
    expect(inspectStoreLock({ storePath: directory }).status).toBe('held')
    expect(disposed).toBe(false)
    expect(() => owner.start('incident:new', async () => {})).toThrow('shutting down')
    cleanup.release()
    expect((await running)?.name).toBe('AbortError')
    await stopping
    expect(await fs.readFile(path.join(directory, 'eval-cleanup.txt'), 'utf8')).toBe('settled')
    expect(inspectStoreLock({ storePath: directory }).status).toBe('absent')
    backend = await assemble()
    const replacement = getEvalsTaskOwner()
    expect(replacement).not.toBe(owner)
    await expect(replacement.start('run', async () => 'new-owner')).resolves.toBe('new-owner')
    await expect(capturedCaller!({ model: 'fixture-model', messages: [{ role: 'user', content: 'late' }] })).rejects.toMatchObject({ name: 'AbortError' })
    expect(requests).toBe(1)
    expect(() => owner.start('run', async () => {})).toThrow('shutting down')
  } finally {
    cleanup.release()
    await backend?.dispose()
    await new Promise<void>(resolve => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
    if (previous === undefined) delete process.env.ONETHING_STORE_PATH
    else process.env.ONETHING_STORE_PATH = previous
    await fs.rm(directory, { recursive: true, force: true })
  }
})
