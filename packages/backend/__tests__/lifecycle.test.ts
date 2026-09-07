import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackendResources, BackendShutdownError, BackendShuttingDownError } from '../lifecycle.js'

afterEach(() => vi.useRealTimers())

function deferred() {
  let resolve!: () => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('Backend resource shutdown', () => {
  it('stops ingress before draining and saves before clearing endpoints and releasing the lease', async () => {
    const resources = new BackendResources()
    const calls: string[] = []
    const own = (name: string, phase: Parameters<BackendResources['own']>[2]) => resources.own(() => { calls.push(name) }, name, phase)
    own('lease', 'release')
    own('host ports', 'restore')
    own('journal', 'flush')
    own('pending saves', 'flush')
    own('older resource', 'resources')
    own('newer resource', 'resources')
    own('ingress', 'quiesce')
    own('executions', 'drain')
    own('discovery', 'endpoints')
    await resources.dispose()
    expect(calls).toEqual(['ingress', 'executions', 'newer resource', 'older resource', 'pending saves', 'journal', 'discovery', 'lease', 'host ports'])
    expect(resources.labels()).toEqual([])
  })

  it('reports a failure and still hands the store back', async () => {
    const resources = new BackendResources()
    const failure = new Error('child process remains alive')
    const save = vi.fn()
    const release = vi.fn()
    const restore = vi.fn()
    resources.own(release, 'lease', 'release')
    resources.own(restore, 'host ports', 'restore')
    resources.own(save, 'save', 'flush')
    resources.own(() => { throw failure }, 'child')
    await expect(resources.dispose('SIGTERM')).rejects.toMatchObject({
      name: 'BackendShutdownError', reason: 'SIGTERM', timedOut: false,
      failures: [{ step: 'child', cause: failure }],
    })
    expect(save).toHaveBeenCalledOnce()
    // The process exits right behind this: a retained lock directory and
    // discovery file would only lock the next launch out.
    expect(release).toHaveBeenCalledOnce()
    expect(restore).toHaveBeenCalledOnce()
  })

  it('shares one promise for repeated shutdown requests and closes ingress synchronously', async () => {
    const resources = new BackendResources()
    const gate = deferred()
    const close = vi.fn(() => gate.promise)
    resources.own(close)
    const first = resources.dispose('window')
    expect(resources.dispose('SIGTERM')).toBe(first)
    expect(() => resources.assertActive()).toThrow(BackendShuttingDownError)
    gate.resolve()
    await first
    expect(close).toHaveBeenCalledOnce()
  })

  it('waits for a late resource before releasing the lease', async () => {
    const resources = new BackendResources()
    const child = deferred()
    const lease = vi.fn()
    resources.own(lease, 'lease', 'release')
    resources.own(() => { resources.own(() => child.promise, 'late child') }, 'spawn completion')
    const closing = resources.dispose()
    await Promise.resolve()
    expect(lease).not.toHaveBeenCalled()
    child.resolve()
    await closing
    expect(lease).toHaveBeenCalledOnce()
  })

  it('includes late disposer errors in the exit result and still releases', async () => {
    const resources = new BackendResources()
    const child = deferred()
    const lease = vi.fn()
    resources.own(lease, 'lease', 'release')
    resources.own(() => { resources.own(() => child.promise, 'late child') })
    const closing = resources.dispose()
    const assertion = expect(closing).rejects.toMatchObject({ failures: [{ step: 'late child' }] })
    await Promise.resolve()
    child.reject(new Error('late cleanup failed'))
    await assertion
    expect(lease).toHaveBeenCalledOnce()
  })

  it('abandons a hung writer at the deadline and releases the lease anyway', async () => {
    vi.useFakeTimers()
    const resources = new BackendResources(100)
    const writer = deferred()
    const lease = vi.fn()
    const restore = vi.fn()
    resources.own(lease, 'lease', 'release')
    resources.own(restore, 'host ports', 'restore')
    resources.own(() => writer.promise, 'writer')
    const closing = resources.dispose()
    // The writer is reported as still pending; the store is handed back regardless.
    const assertion = expect(closing).rejects.toMatchObject({ timedOut: true, pending: ['writer'] })
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    writer.resolve()
    await Promise.resolve()
    expect(lease).toHaveBeenCalledOnce()
    expect(restore).toHaveBeenCalledOnce()
    expect(resources.dispose()).toBe(closing)
  })

  it('releases the lease after a resources disposer hangs past the deadline', async () => {
    vi.useFakeTimers()
    const resources = new BackendResources(100)
    const hung = deferred()
    const order: string[] = []
    resources.own(() => { order.push('restore') }, 'host ports', 'restore')
    resources.own(() => { order.push('release') }, 'lease', 'release')
    resources.own(() => { order.push('endpoints') }, 'discovery', 'endpoints')
    resources.own(() => hung.promise, 'hung resource')
    const closing = resources.dispose()
    const assertion = expect(closing).rejects.toMatchObject({
      timedOut: true, pending: ['hung resource', 'discovery'],
      failures: [{ step: 'deadline' }],
    })
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    // Endpoints are sacrificed to the deadline; release and restore are not.
    expect(order).toEqual(['release', 'restore'])
    hung.resolve()
  })

  it('releases the lease after a resources disposer throws, and still rejects', async () => {
    const resources = new BackendResources()
    const failure = new Error('watcher would not close')
    const order: string[] = []
    resources.own(() => { order.push('restore') }, 'host ports', 'restore')
    resources.own(() => { order.push('release') }, 'lease', 'release')
    resources.own(() => { throw failure }, 'watcher')
    await expect(resources.dispose()).rejects.toMatchObject({
      name: 'BackendShutdownError', timedOut: false, failures: [{ step: 'watcher', cause: failure }],
    })
    expect(order).toEqual(['release', 'restore'])
  })

  it('runs ownership arriving after shutdown immediately and returns the failure', async () => {
    const failures = vi.fn()
    const resources = new BackendResources(100, failures)
    await resources.dispose()
    const error = new Error('post-shutdown cleanup')
    const cleanup = vi.fn(() => { throw error })
    await expect(resources.own(cleanup, 'late')).rejects.toBe(error)
    expect(cleanup).toHaveBeenCalledOnce()
    expect(failures).toHaveBeenCalledWith({ step: 'late', cause: error })
  })

  it('preserves all distinct failure causes', async () => {
    const resources = new BackendResources()
    const first = new Error('first')
    const second = new Error('second')
    resources.own(() => { throw first }, 'one')
    resources.own(async () => { throw second }, 'two')
    const failure = await resources.dispose().catch(error => error)
    expect(failure).toBeInstanceOf(BackendShutdownError)
    expect(failure.errors).toEqual([second, first])
  })
})
