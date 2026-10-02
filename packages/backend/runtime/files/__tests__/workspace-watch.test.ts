import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceWatchService, type WorkspaceWatchService } from '../workspace-watch.js'
import type { createWorkspaceWatchDriver } from '../workspace-watch-driver.js'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

let root: string
let services: Map<WorkspaceWatchService, boolean>
let release: Array<() => void>

function driver() {
  const ready = deferred()
  const closed = deferred()
  const entered = deferred()
  release.push(() => { ready.resolve(); closed.resolve() })
  let change!: Parameters<typeof createWorkspaceWatchDriver>[1]
  let error!: Parameters<typeof createWorkspaceWatchDriver>[2]
  const close = vi.fn(() => {
    ready.reject(new Error('Canceled before ready'))
    return closed.promise
  })
  const create = vi.fn<typeof createWorkspaceWatchDriver>((_root, notify, fail) => {
    change = notify
    error = fail
    entered.resolve()
    return { ready: ready.promise, close }
  })
  return { ready, closed, entered, create, close,
    change: (path: string, kind = 'change') => change(path, kind),
    error: (failure: unknown) => error(failure) }
}

function owner(createDriver: typeof createWorkspaceWatchDriver) {
  const service = createWorkspaceWatchService({ createDriver })
  services.set(service, false)
  return service
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'workspace-watch-owner-'))
  services = new Map()
  release = []
})

afterEach(async () => {
  release.forEach(finish => finish())
  const results = await Promise.allSettled([...services].map(async ([service, expectedFailure]) => {
    try { await service.close() }
    catch (error) { if (!expectedFailure) throw error }
  }))
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length) throw new AggregateError(errors, 'Owner cleanup did not complete')
  await rm(root, { recursive: true })
})

describe('workspace watch service ownership', () => {
  it('shares a pending start and reports success only after native ready', async () => {
    const native = driver()
    const service = owner(native.create)
    const start = service.start(root, root)
    expect(service.start(root, root)).toBe(start)
    await native.entered.promise
    const settled = vi.fn()
    void start.then(settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    native.ready.resolve()
    await expect(start).resolves.toEqual({ success: true })
    expect(native.create).toHaveBeenCalledTimes(1)
  })

  it('owns setup before stat and cannot install after immediate shutdown', async () => {
    const native = driver()
    const service = owner(native.create)
    const start = service.start(root, root)
    const closed = service.close()
    expect(service.close()).toBe(closed)
    await closed
    await expect(start).resolves.toMatchObject({ success: false })
    expect(native.create).not.toHaveBeenCalled()
    await expect(service.start(root, root)).resolves.toEqual({ success: false, error: 'Workspace watches are closed.' })
    expect(() => service.subscribe(root, vi.fn())).toThrow('Workspace watches are closed.')
  })

  it('cancels ready immediately but holds stop and start replies until actual close', async () => {
    const native = driver()
    const service = owner(native.create)
    const start = service.start(root, root)
    await native.entered.promise
    const stop = service.stop(root, root)
    expect(native.close).toHaveBeenCalledTimes(1)
    const stopped = vi.fn()
    const started = vi.fn()
    void stop.then(stopped)
    void start.then(started)
    await Promise.resolve()
    expect(stopped).not.toHaveBeenCalled()
    expect(started).not.toHaveBeenCalled()
    await expect(service.start(root, root)).resolves.toMatchObject({ success: false })
    native.closed.resolve()
    await expect(stop).resolves.toEqual({ success: true })
    await expect(start).resolves.toMatchObject({ success: false })
    expect(native.close).toHaveBeenCalledTimes(1)
  })

  it('keeps identical scopes in separate owners and rejects late notifications', async () => {
    const a = driver()
    const b = driver()
    a.ready.resolve(); b.ready.resolve()
    const ownerA = owner(a.create)
    const ownerB = owner(b.create)
    const eventsA = vi.fn()
    const eventsB = vi.fn()
    ownerA.subscribe(root, eventsA)
    ownerB.subscribe(root, eventsB)
    await Promise.all([ownerA.start(root, root), ownerB.start(root, root)])
    const closeA = ownerA.close()
    a.change(join(root, 'late.txt'))
    b.change(join(root, 'live.txt'))
    expect(eventsA).not.toHaveBeenCalled()
    expect(eventsB).toHaveBeenCalledWith({ root, path: join(root, 'live.txt'), eventType: 'change' })
    expect(b.close).not.toHaveBeenCalled()
    a.closed.resolve()
    await closeA
    b.change(join(root, 'another.txt'))
    expect(eventsB).toHaveBeenCalledTimes(2)
  })

  it('retains a failed close while still waiting for another real close', async () => {
    const a = driver()
    const b = driver()
    a.ready.resolve(); b.ready.resolve()
    await mkdir(join(root, 'second'))
    const service = owner(vi.fn<typeof createWorkspaceWatchDriver>((path, ...callbacks) =>
      (path === root ? a.create : b.create)(path, ...callbacks)))
    await Promise.all([service.start(root, root), service.start(root, join(root, 'second'))])
    const failure = new Error('native stop failed')
    services.set(service, true)
    const stop = service.stop(root, root)
    a.closed.reject(failure)
    await expect(stop).rejects.toBe(failure)
    const close = service.close()
    const finished = vi.fn()
    void close.then(finished, finished)
    await Promise.resolve()
    expect(finished).not.toHaveBeenCalled()
    b.closed.resolve()
    await expect(close).rejects.toBe(failure)
    expect(service.close()).toBe(close)
    await expect(service.close()).rejects.toBe(failure)
  })

  it('owns an asynchronous native error after ready and preserves it for shutdown', async () => {
    const native = driver()
    native.ready.resolve()
    const service = owner(native.create)
    const events = vi.fn()
    service.subscribe(root, events)
    await service.start(root, root)
    const failure = new Error('native stream failed')
    services.set(service, true)
    native.error(failure)
    expect(native.close).toHaveBeenCalledTimes(1)
    native.change(join(root, 'late.txt'))
    expect(events).not.toHaveBeenCalled()
    native.closed.reject(failure)
    await expect(service.close()).rejects.toBe(failure)
  })

  it('handles synchronous driver error during construction without orphaning ready', async () => {
    const ready = deferred()
    const closed = deferred()
    release.push(() => { ready.resolve(); closed.resolve() })
    const close = vi.fn(() => { ready.reject(new Error('canceled')); return closed.promise })
    const entered = deferred()
    const service = owner((_root, _change, error) => {
      error(new Error('synchronous native setup failure'))
      entered.resolve()
      return { ready: ready.promise, close }
    })
    const start = service.start(root, root)
    await entered.promise
    expect(close).toHaveBeenCalled()
    closed.resolve()
    await expect(start).resolves.toMatchObject({ success: false })
    await service.close()
  })

  it('rejects outside or missing roots before opening a driver and isolates subscribers', async () => {
    const native = driver()
    native.ready.resolve()
    const service = owner(native.create)
    await expect(service.start(root, join(root, '..', 'outside'))).resolves.toMatchObject({ success: false })
    await expect(service.start(root, join(root, 'missing'))).resolves.toEqual({
      success: false, error: 'Workspace watch root must be an existing directory.',
    })
    expect(native.create).not.toHaveBeenCalled()
    const other = vi.fn()
    service.subscribe(join(root, 'other-scope'), other)
    const bad = vi.fn(() => { throw new Error('subscriber failed') })
    const good = vi.fn()
    service.subscribe(root, bad)
    service.subscribe(root, good)
    await service.start(root, root)
    native.change(join(root, '..', 'outside'))
    expect(good).not.toHaveBeenCalled()
    native.change(join(root, 'inside.txt'))
    expect(good).toHaveBeenCalledTimes(1)
    expect(other).not.toHaveBeenCalled()
  })
})
