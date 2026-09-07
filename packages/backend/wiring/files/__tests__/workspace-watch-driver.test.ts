import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceWatchDriver } from '../workspace-watch-driver.js'

const ports = vi.hoisted(() => ({ platform: vi.fn(), realpath: vi.fn(), watch: vi.fn() }))
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), platform: ports.platform }))
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), watch: ports.watch }))
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), realpath: ports.realpath }))

const flags = { HistoryDone: 0x10, MustScanSubDirs: 1, UserDropped: 2, KernelDropped: 4,
  EventIdsWrapped: 8, RootChanged: 0x20, ItemCreated: 0x100, ItemRemoved: 0x200,
  ItemRenamed: 0x800, ItemCloned: 0x400000, ItemModified: 0x1000 }
type NativeCallback = (path: string, flags: number, id: string) => void
let instances: Array<{ root: string; since: number; callback: NativeCallback; stop: ReturnType<typeof vi.fn> }>
let nativeWatch: ReturnType<typeof vi.fn>
let drivers: WorkspaceWatchDriver[]
let releases: Array<() => void>
let directories: string[]

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

function barrier() {
  const result = deferred()
  releases.push(() => result.resolve())
  return result
}

async function waitForRealChange(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([promise, new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error('No real file event arrived after native readiness')), 5_000)
    })])
  } finally { clearTimeout(timer) }
}

beforeEach(() => {
  vi.resetModules()
  drivers = []
  releases = []
  directories = []
  instances = []
  ports.platform.mockReset().mockReturnValue('darwin')
  ports.realpath.mockReset().mockResolvedValue('/physical/work')
  ports.watch.mockReset()
  nativeWatch = vi.fn((root: string, since: number, callback: NativeCallback) => {
    const stop = vi.fn().mockResolvedValue(undefined)
    instances.push({ root, since, callback, stop })
    return stop
  })
  vi.doMock('fsevents', () => ({ watch: nativeWatch, constants: flags }))
})

afterEach(async () => {
  releases.forEach(release => release())
  await Promise.allSettled(drivers.map(driver => driver.close()))
  vi.useRealTimers()
  await Promise.all(directories.map(directory => fs.rm(directory, { recursive: true, force: true })))
})

async function create(root = '/requested/work', change = vi.fn(), error = vi.fn()) {
  const { createWorkspaceWatchDriver } = await import('../workspace-watch-driver.js')
  const driver = createWorkspaceWatchDriver(root, change, error)
  drivers.push(driver)
  return { driver, change, error }
}

async function macStarted() { await vi.waitFor(() => expect(instances).toHaveLength(1)) }

describe('workspace watcher driver ownership', () => {
  it('holds ready until HistoryDone, excludes history, maps live physical paths and requests rescans', async () => {
    const { driver, change } = await create()
    const ready = vi.fn()
    void driver.ready.then(ready)
    await macStarted()
    const instance = instances[0]
    expect([instance.root, instance.since]).toEqual(['/physical/work', 0])
    instance.callback('/physical/work/historical.txt', flags.ItemCreated, '1')
    await Promise.resolve()
    expect(ready).not.toHaveBeenCalled()
    expect(change).not.toHaveBeenCalled()
    instance.callback('/ignored-sentinel-path', flags.HistoryDone, '2')
    await driver.ready
    instance.callback('/physical/work/nested/live.txt', flags.ItemCreated, '3')
    instance.callback('/physical/workspace/outside.txt', flags.ItemCreated, '4')
    instance.callback('/physical/work/../outside.txt', flags.ItemModified, '5')
    instance.callback('relative.txt', flags.ItemModified, '6')
    instance.callback('/not-a-precise-path', flags.KernelDropped | flags.MustScanSubDirs, '7')
    instance.callback('/renamed-root', flags.RootChanged, '0')
    expect(change.mock.calls).toEqual([
      ['/requested/work/nested/live.txt', 'rename'], ['/requested/work', 'change'], ['/requested/work', 'change'],
    ])
  })

  it('closes synchronously before queued initialization without opening a native stream', async () => {
    const { createWorkspaceWatchDriver } = await import('../workspace-watch-driver.js')
    const error = vi.fn()
    const driver = createWorkspaceWatchDriver('/requested/work', vi.fn(), error)
    drivers.push(driver)
    const close = driver.close()
    await expect(driver.ready).rejects.toMatchObject({ code: 'WORKSPACE_WATCH_CLOSED' })
    await close
    expect(nativeWatch).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('owns a late dynamic import and never opens a stream after cancellation', async () => {
    const imported = barrier()
    const entered = deferred()
    vi.doMock('fsevents', async () => {
      entered.resolve()
      await imported.promise
      return { watch: nativeWatch, constants: flags }
    })
    const { driver } = await create()
    await entered.promise
    let closed = false
    const closing = driver.close().then(() => { closed = true })
    await expect(driver.ready).rejects.toMatchObject({ code: 'WORKSPACE_WATCH_CLOSED' })
    await Promise.resolve()
    expect(closed).toBe(false)
    imported.resolve()
    await closing
    expect(nativeWatch).not.toHaveBeenCalled()
  })

  it('owns a late realpath operation and does not start after close', async () => {
    const resolving = deferred<string>()
    releases.push(() => resolving.resolve('/physical/work'))
    ports.realpath.mockReturnValue(resolving.promise)
    const { driver } = await create()
    await vi.waitFor(() => expect(ports.realpath).toHaveBeenCalledOnce())
    const closed = vi.fn()
    const closing = driver.close().then(closed)
    await Promise.resolve()
    expect(closed).not.toHaveBeenCalled()
    resolving.resolve('/physical/work')
    await closing
    expect(nativeWatch).not.toHaveBeenCalled()
  })

  it('shares the first real native stop, rejects pending ready and blocks already queued callbacks', async () => {
    const stopping = barrier()
    const { driver, change, error } = await create()
    await macStarted()
    instances[0].stop.mockReturnValue(stopping.promise)
    const closing = driver.close()
    expect(driver.close()).toBe(closing)
    await expect(driver.ready).rejects.toMatchObject({ code: 'WORKSPACE_WATCH_CLOSED' })
    await vi.waitFor(() => expect(instances[0].stop).toHaveBeenCalledOnce())
    const closed = vi.fn()
    void closing.then(closed)
    instances[0].callback('', flags.HistoryDone, '1')
    instances[0].callback('/physical/work/late.txt', flags.ItemCreated, '2')
    await Promise.resolve()
    expect(change).not.toHaveBeenCalled()
    expect(closed).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    stopping.resolve()
    await closing
    expect(driver.close()).toBe(closing)
  })

  it('retains a startup timeout through slow cleanup and a later stop failure', async () => {
    vi.useFakeTimers()
    const stopping = deferred()
    releases.push(() => stopping.resolve())
    const { driver, error } = await create()
    await vi.waitFor(() => expect(instances).toHaveLength(1))
    instances[0].stop.mockReturnValue(stopping.promise)
    await vi.advanceTimersByTimeAsync(15_000)
    const first = await driver.ready.catch(failure => failure)
    expect(first).toMatchObject({ code: 'WORKSPACE_WATCH_START_TIMEOUT' })
    expect(error).toHaveBeenCalledExactlyOnceWith(first)
    let settled = false
    const closing = driver.close()
    void closing.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    stopping.reject(new Error('later native stop failure'))
    await expect(closing).rejects.toBe(first)
    await expect(driver.close()).rejects.toBe(first)
  })

  it('rejects missing macOS native code without silently using fs.watch', async () => {
    const failure = new Error('native addon not installed')
    vi.doMock('fsevents', () => { throw failure })
    const { driver, error } = await create()
    const first = await driver.ready.catch(value => value)
    expect(first).toBeInstanceOf(Error)
    expect(error).toHaveBeenCalledExactlyOnceWith(first)
    await expect(driver.close()).rejects.toBe(first)
    expect(ports.watch).not.toHaveBeenCalled()
  })

  it('checks every native flag used for readiness, path invalidation and event mapping', async () => {
    vi.doMock('fsevents', () => ({ watch: nativeWatch, constants: { ...flags, RootChanged: undefined } }))
    const { driver, error } = await create()
    const failure = await driver.ready.catch(value => value)
    expect(failure).toMatchObject({ code: 'WORKSPACE_WATCH_NATIVE_UNAVAILABLE' })
    await expect(driver.close()).rejects.toBe(failure)
    expect(error).toHaveBeenCalledExactlyOnceWith(failure)
    expect(nativeWatch).not.toHaveBeenCalled()
    expect(ports.watch).not.toHaveBeenCalled()
  })

  it('does not accept a synchronous ready sentinel from a native module lacking its close function', async () => {
    nativeWatch.mockImplementationOnce((_root: string, _since: number, callback: NativeCallback) => {
      callback('', flags.HistoryDone, '1')
      return undefined
    })
    const { driver } = await create()
    const failure = await driver.ready.catch(value => value)
    expect(failure).toMatchObject({ code: 'WORKSPACE_WATCH_NATIVE_UNAVAILABLE' })
    await expect(driver.close()).rejects.toBe(failure)
    expect(ports.watch).not.toHaveBeenCalled()
  })

  it('rejects a realpath failure and a synchronous native start failure', async () => {
    const first = new Error('root no longer exists')
    ports.realpath.mockRejectedValueOnce(first)
    const one = await create()
    await expect(one.driver.ready).rejects.toBe(first)
    await expect(one.driver.close()).rejects.toBe(first)
    expect(nativeWatch).not.toHaveBeenCalled()
    const second = new Error('native start failed')
    nativeWatch.mockImplementationOnce(() => { throw second })
    const two = await create()
    await expect(two.driver.ready).rejects.toBe(second)
    await expect(two.driver.close()).rejects.toBe(second)
  })

  it('keeps independent subscriptions for the same physical root', async () => {
    const one = await create()
    const two = await create()
    await vi.waitFor(() => expect(instances).toHaveLength(2))
    instances.forEach(instance => instance.callback('', flags.HistoryDone, '1'))
    await Promise.all([one.driver.ready, two.driver.ready])
    await one.driver.close()
    instances.forEach(instance => instance.callback('/physical/work/live.txt', flags.ItemModified, '2'))
    expect(one.change).not.toHaveBeenCalled()
    expect(two.change).toHaveBeenCalledExactlyOnceWith('/requested/work/live.txt', 'change')
    expect(instances[1].stop).not.toHaveBeenCalled()
  })

  it('preserves the first delivery failure while closing and contains a throwing error observer', async () => {
    const failure = new Error('SSE delivery failed')
    const { driver, error } = await create('/requested/work', vi.fn(() => { throw failure }), vi.fn(() => { throw new Error('observer failed') }))
    await macStarted()
    instances[0].callback('', flags.HistoryDone, '1')
    await driver.ready
    instances[0].callback('/physical/work/live.txt', flags.ItemModified, '2')
    await expect(driver.close()).rejects.toBe(failure)
    expect(error).toHaveBeenCalledExactlyOnceWith(failure)
    expect(instances[0].stop).toHaveBeenCalledOnce()
  })

  it('waits for the actual non-macOS close event and retains recursive fallback', async () => {
    ports.platform.mockReturnValue('linux')
    const watcher = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> }
    watcher.close = vi.fn()
    releases.push(() => watcher.emit('close'))
    ports.watch.mockImplementationOnce(() => { throw new Error('recursive not supported') }).mockReturnValue(watcher)
    const { driver, change } = await create()
    await driver.ready
    expect(ports.watch.mock.calls.map(call => call[1])).toEqual([{ recursive: true }, { recursive: false }])
    const listener = ports.watch.mock.calls[1][2]
    listener('change', 'file.txt')
    listener('change', '../outside.txt')
    expect(change).toHaveBeenCalledExactlyOnceWith('/requested/work/file.txt', 'change')
    let closed = false
    const closing = driver.close().then(() => { closed = true })
    await vi.waitFor(() => expect(watcher.close).toHaveBeenCalledOnce())
    listener('change', 'late.txt')
    expect(change).toHaveBeenCalledOnce()
    expect(closed).toBe(false)
    watcher.emit('close')
    await closing
    expect(ports.realpath).not.toHaveBeenCalled()
  })

  it('exposes an asynchronous fs watcher error but still waits for its actual close', async () => {
    ports.platform.mockReturnValue('linux')
    const watcher = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> }
    watcher.close = vi.fn()
    releases.push(() => watcher.emit('close'))
    ports.watch.mockReturnValue(watcher)
    const { driver, error } = await create()
    await driver.ready
    const failure = new Error('watcher I/O failed')
    watcher.emit('error', failure)
    expect(error).toHaveBeenCalledExactlyOnceWith(failure)
    let settled = false
    const closing = driver.close()
    void closing.catch(() => { settled = true })
    await vi.waitFor(() => expect(watcher.close).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    watcher.emit('close')
    await expect(closing).rejects.toBe(failure)
  })

  it('surfaces native stop failure even after ready has succeeded', async () => {
    const { driver, error } = await create()
    await macStarted()
    instances[0].callback('', flags.HistoryDone, '1')
    await driver.ready
    const failure = new Error('native stop failed')
    instances[0].stop.mockRejectedValue(failure)
    await expect(driver.close()).rejects.toBe(failure)
    await expect(driver.close()).rejects.toBe(failure)
    expect(error).toHaveBeenCalledExactlyOnceWith(failure)
    expect(instances[0].stop).toHaveBeenCalledOnce()
  })

  it('retains a synchronous fs close failure while draining the native close already in progress', async () => {
    ports.platform.mockReturnValue('linux')
    const watcher = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> }
    const failure = new Error('close reported I/O failure')
    watcher.close = vi.fn(() => { throw failure })
    releases.push(() => watcher.emit('close'))
    ports.watch.mockReturnValue(watcher)
    const { driver, error } = await create()
    await driver.ready
    let settled = false
    const closing = driver.close()
    void closing.catch(() => { settled = true })
    await vi.waitFor(() => expect(watcher.close).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    expect(error).toHaveBeenCalledExactlyOnceWith(failure)
    watcher.emit('close')
    await expect(closing).rejects.toBe(failure)
    watcher.emit('error', new Error('queued after real close'))
    expect(error).toHaveBeenCalledOnce()
  })

  it('captures one real file write after ready and closes the actual platform watcher', { timeout: 30_000 }, async () => {
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    const actualPromises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const actualOs = await vi.importActual<typeof import('node:os')>('node:os')
    ports.platform.mockImplementation(actualOs.platform)
    ports.realpath.mockImplementation(actualPromises.realpath)
    ports.watch.mockImplementation(actualFs.watch)
    vi.doUnmock('fsevents')
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-watch-driver-'))
    directories.push(directory)
    const target = path.join(directory, 'single-write.txt')
    const observed = deferred()
    const failures: unknown[] = []
    let eventsAfterClose = 0
    let closed = false
    const { createWorkspaceWatchDriver } = await import('../workspace-watch-driver.js')
    const driver = createWorkspaceWatchDriver(directory, changedPath => {
      if (closed) eventsAfterClose++
      if (changedPath === target) observed.resolve()
    }, error => { failures.push(error); observed.reject(error) })
    drivers.push(driver)
    await driver.ready
    await fs.writeFile(target, 'single write after native readiness\n', { flag: 'wx' })
    await waitForRealChange(observed.promise)
    await driver.close()
    closed = true
    await fs.rm(directory, { recursive: true })
    expect(failures).toEqual([])
    expect(eventsAfterClose).toBe(0)
  })

  it.runIf(process.platform !== 'win32')('watches a real read-only directory without writing a readiness file', { timeout: 30_000 }, async () => {
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    const actualPromises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const actualOs = await vi.importActual<typeof import('node:os')>('node:os')
    ports.platform.mockImplementation(actualOs.platform)
    ports.realpath.mockImplementation(actualPromises.realpath)
    ports.watch.mockImplementation(actualFs.watch)
    vi.doUnmock('fsevents')
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-watch-readonly-'))
    directories.push(directory)
    const target = path.join(directory, 'existing.txt')
    await fs.writeFile(target, 'initial fixture content\n')
    await fs.chmod(directory, 0o500)
    const observed = deferred()
    const { createWorkspaceWatchDriver } = await import('../workspace-watch-driver.js')
    const driver = createWorkspaceWatchDriver(directory, changed => {
      if (changed === target) observed.resolve()
    }, error => observed.reject(error))
    drivers.push(driver)
    try {
      await driver.ready
      expect(await fs.readdir(directory)).toEqual(['existing.txt'])
      // The existing file remains writable; only creating/deleting directory entries is forbidden.
      await fs.writeFile(target, 'one real update after native readiness\n')
      await waitForRealChange(observed.promise)
      await driver.close()
    } finally {
      await driver.close().catch(() => {})
      await fs.chmod(directory, 0o700)
    }
  })
})
