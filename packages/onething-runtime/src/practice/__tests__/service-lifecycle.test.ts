import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PracticeService } from '../service.wiring.js'

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

let directory: string
let service: PracticeService
const releases: Array<() => void> = []
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'practice-service-'))
  service = new PracticeService({ storePath: directory })
})
afterEach(async () => {
  releases.splice(0).forEach(release => release())
  vi.useRealTimers()
  await service.drain().catch(() => {})
  vi.restoreAllMocks()
  await fs.rm(directory, { recursive: true, force: true })
})

it('settles an active timer once, stops the ticker, and closes captured ledger admission', async () => {
  vi.useFakeTimers()
  const events = vi.fn()
  service.setBroadcaster(events)
  const ledger = service.getPracticeLedger()
  await service.startPractice({ kind: 'pomodoro', category: 'focus' })
  await vi.advanceTimersByTimeAsync(2000)
  expect(service.pausePractice().status).toBe('paused')
  expect(service.resumePractice().status).toBe('running')
  service.quiesce()
  expect(events.mock.calls.at(-1)?.[0]).toMatchObject({ snapshot: { status: 'idle' }, settled: { kind: 'pomodoro', pomodoro: { completed: false } } })
  const count = events.mock.calls.length
  await vi.advanceTimersByTimeAsync(5000)
  expect(events).toHaveBeenCalledTimes(count)
  expect(vi.getTimerCount()).toBe(0)
  expect(() => service.logPractice({ name: 'late', source: 'manual', exercise: {} })).toThrow('shutting down')
  expect(() => ledger.record({ kind: 'exercise', name: 'late', source: 'manual' })).toThrow('shutting down')
  await service.drain()
  const [file] = (await fs.readdir(path.join(directory, 'practice'))).filter(file => file.endsWith('.jsonl'))
  const records = (await fs.readFile(path.join(directory, 'practice', file!), 'utf8')).trim().split('\n')
  expect(records).toHaveLength(1)
})

it('waits for an accepted config read without allowing its pending start to resurrect the ticker', async () => {
  const entered = barrier()
  const release = barrier()
  releases.push(release.release)
  const original = fs.readFile.bind(fs)
  vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
    if (String(args[0]) === path.join(directory, 'practice', 'config.json')) {
      entered.release()
      await release.promise
    }
    return original(...args)
  })
  const pending = service.startPractice({ kind: 'kegel' })
  const rejected = expect(pending).rejects.toThrow('shutting down')
  await entered.promise
  let drained = false
  const closing = service.drain().then(() => { drained = true })
  await Promise.resolve()
  expect(drained).toBe(false)
  release.release()
  await rejected
  await closing
  await expect(fs.readdir(path.join(directory, 'practice'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('serializes concurrent config merges and reports actual ledger write failures at drain', async () => {
  await Promise.all([
    service.writePracticeConfig({ config: { kegel: { holdSec: 17 } } }),
    service.writePracticeConfig({ config: { pomodoro: { minutes: 42 } } }),
  ])
  expect(await service.readPracticeConfig()).toMatchObject({ kegel: { holdSec: 17 }, pomodoro: { minutes: 42 } })
  const ledger = service.getPracticeLedger()
  // An actual ENOTDIR, not a mocked success path or swallowed append error.
  await fs.rm(path.join(directory, 'practice'), { recursive: true })
  await fs.writeFile(path.join(directory, 'practice'), 'obstruct directory')
  service.logPractice({ name: 'cannot persist', source: 'manual', exercise: {} })
  await expect(service.drain()).rejects.toThrow()
  expect(ledger.getLastError()).toBeTruthy()
})
