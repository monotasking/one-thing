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
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'practice-backend-')))
  previous = process.env.ONETHING_STORE_PATH
  process.env.ONETHING_STORE_PATH = path.join(directory, 'a')
  vi.resetModules()
})
afterEach(async () => {
  releases.splice(0).forEach(release => release())
  await backend?.dispose()
  backend = undefined
  vi.restoreAllMocks()
  if (previous === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previous
  await fs.rm(directory, { recursive: true, force: true })
})

async function assemble(storePath: string) {
  const { createOnethingBackend } = await import('../backend.js')
  return createOnethingBackend({ storePath, owner: 'daemon', toolRegistry: 'headless', host: {
    storePath: {}, sandbox: {}, auth: null, logging: null, shell: null, voice: null,
    terminal: null, skillsEnvironment: null, todoPlan: null, scratchpad: null, plugins: null,
    gateway: null, settings: null, evals: null, mcp: null, localTrust: null,
  } })
}

it('holds the actual lease through config and ledger IO, then isolates old service, ledger and tool adapters from Backend B', { timeout: 60000 }, async () => {
  const storeA = path.join(directory, 'a')
  const storeB = path.join(directory, 'b')
  backend = await assemble(storeA)
  const practice = await import('@onething/runtime/practice/service.wiring')
  const { practiceAdapters } = await import('../wiring/toolkit/adapters.js')
  const { inspectStoreLock } = await import('@onething/runtime/storage/store-lock')
  const oldService = backend.practice
  const oldLedger = practice.getPracticeLedger()
  const oldTool = practiceAdapters()
  const events = vi.fn()
  practice.configurePracticeEventBroadcaster(events)
  await practice.startPractice({ kind: 'pomodoro', category: 'reading' })

  const configEntered = barrier()
  const configRelease = barrier()
  const ledgerEntered = barrier()
  const ledgerRelease = barrier()
  releases.push(configRelease.release, ledgerRelease.release)
  const realWrite = fs.writeFile.bind(fs)
  const realAppend = fs.appendFile.bind(fs)
  vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
    if (String(args[0]) === path.join(storeA, 'practice', 'config.json')) {
      configEntered.release()
      await configRelease.promise
    }
    return realWrite(...args)
  })
  vi.spyOn(fs, 'appendFile').mockImplementation(async (...args) => {
    if (String(args[0]).startsWith(path.join(storeA, 'practice') + path.sep)) {
      ledgerEntered.release()
      await ledgerRelease.promise
    }
    return realAppend(...args)
  })
  // Changing ambient configuration after assembly must not redirect either writer.
  process.env.ONETHING_STORE_PATH = storeB
  const config = oldService.writePracticeConfig({ config: { pomodoro: { minutes: 39 } } })
  const logged = oldTool.log({ name: 'A only', exercise: { sets: 2 }, ts: Date.now() })
  await Promise.all([configEntered.promise, ledgerEntered.promise])
  process.env.ONETHING_STORE_PATH = storeA
  let disposed = false
  const stopping = backend.dispose().then(() => { disposed = true })
  await vi.waitFor(() => expect(() => oldService.getPracticeState()).toThrow('shutting down'))
  expect(inspectStoreLock({ storePath: storeA }).status).toBe('held')
  expect(disposed).toBe(false)
  ledgerRelease.release()
  await oldLedger.flush()
  expect(disposed).toBe(false)
  expect(inspectStoreLock({ storePath: storeA }).status).toBe('held')
  configRelease.release()
  await config
  await stopping
  expect(inspectStoreLock({ storePath: storeA }).status).toBe('absent')
  expect(events.mock.calls.at(-1)?.[0]).toMatchObject({ snapshot: { status: 'idle' }, settled: { kind: 'pomodoro', pomodoro: { completed: false } } })
  await expect(fs.readdir(path.join(storeB, 'practice'))).rejects.toMatchObject({ code: 'ENOENT' })
  const files = await fs.readdir(path.join(storeA, 'practice'))
  const records = (await Promise.all(files.filter(file => file.endsWith('.jsonl')).map(file => fs.readFile(path.join(storeA, 'practice', file), 'utf8'))))
    .join('').trim().split('\n').map(line => JSON.parse(line))
  expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ id: (await logged).id }), expect.objectContaining({ kind: 'pomodoro' })]))
  expect(records).toHaveLength(2)

  backend = await assemble(storeB)
  expect(backend.practice).not.toBe(oldService)
  expect(practice.getPracticeState()).toEqual({ status: 'idle' })
  expect((await practice.readPracticeConfig()).pomodoro.minutes).toBe(25)
  expect(() => oldService.logPractice({ name: 'old service', source: 'manual', exercise: {} })).toThrow('shutting down')
  expect(() => oldLedger.record({ kind: 'exercise', name: 'old ledger', source: 'manual' })).toThrow('shutting down')
  expect(() => oldTool.log({ name: 'old tool' })).toThrow('shutting down')
  practice.logPractice({ name: 'B only', source: 'manual', exercise: {} })
  expect((await practice.getRecentPracticeRecords()).map(record => record.name)).toEqual(['B only'])
  const count = events.mock.calls.length
  await practice.startPractice({ kind: 'kegel' })
  practice.stopPractice(true)
  expect(events).toHaveBeenCalledTimes(count)
})
