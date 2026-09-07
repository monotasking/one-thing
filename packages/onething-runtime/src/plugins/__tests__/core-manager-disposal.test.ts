import { describe, expect, it, vi } from 'vitest'
import {
  CorePluginManager,
  type CorePluginDefinition,
  type CorePluginManagerHost,
  type CorePluginStateLike,
} from '@onething/core/plugins'

interface State extends CorePluginStateLike {
  pluginId: string
  serial: number
  disposed: boolean
}
interface API { state: State }
type Entry = (api: API) => void | Promise<void>
type Definition = CorePluginDefinition<Entry>

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

function fixture(options: {
  ids?: string[]
  create?: (pluginId: string) => void
  entry?: Entry
  dispose?: (state: State) => void | Promise<void>
  drain?: (state: State) => Promise<void>
} = {}) {
  const states: State[] = []
  const definitions: Definition[] = (options.ids ?? ['first', 'second']).map(id => ({
    id, manifest: { name: id, version: '1.0.0' }, enabled: true,
    dirPath: `/plugins/${id}`, entryPath: `/plugins/${id}/entry.js`,
    entry: options.entry ?? (() => {}),
  }))
  const dispose = vi.fn((state: State) => {
    state.disposed = true
    return options.dispose?.(state)
  })
  const drain = vi.fn((state: State) => options.drain?.(state) ?? Promise.resolve())
  const host: CorePluginManagerHost<Definition, Entry, API, State, unknown, { ready: true }> = {
    ensurePluginDirs() {},
    scanPlugins: () => definitions,
    loadPluginEntry: async definition => definition.entry ?? null,
    createPluginAPI(pluginId) {
      options.create?.(pluginId)
      const state: State = { pluginId, serial: states.length + 1, commands: new Map(), disposed: false }
      states.push(state)
      return { state, api: { state } }
    },
    disposePlugin: dispose,
    drainPlugin: drain,
    setPluginEnabled(pluginId, enabled) {
      const definition = definitions.find(item => item.id === pluginId)
      if (definition) definition.enabled = enabled
    },
  }
  const manager = new CorePluginManager<API, Entry, unknown, State, Definition, { ready: true }>(host)
  return { manager, states, dispose, drain }
}

async function expectPending(work: Promise<void>) {
  let settled = false
  void work.then(() => { settled = true }, () => { settled = true })
  // Let any early rejection propagate. Resource completion is controlled by
  // the explicit barriers, never inferred from this event-loop turn.
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(settled).toBe(false)
}

describe('CorePluginManager real cleanup promises', () => {
  it('starts every disposer synchronously and waits for a slow peer after another drain fails', async () => {
    const slow = barrier()
    const failure = new Error('first close failed')
    const { manager, dispose, drain } = fixture({
      drain: state => state.pluginId === 'first' ? Promise.reject(failure) : slow.promise,
    })
    await manager.initialize({ ready: true })
    const stopping = manager.shutdown()
    const outcome = stopping.catch(error => error)
    try {
      expect(dispose).toHaveBeenCalledTimes(2)
      await expectPending(stopping)
      expect(drain).toHaveBeenCalledTimes(2)
    } finally { slow.release() }
    expect(await outcome).toBe(failure)
    await expect(manager.shutdown()).rejects.toBe(failure)
    expect(dispose).toHaveBeenCalledTimes(2)
    expect(drain).toHaveBeenCalledTimes(2)
  })

  it.each(['throw', 'reject'] as const)('owns a host dispose %s and still drains that state and every peer', async mode => {
    const ownDrain = barrier()
    const peerDispose = barrier()
    const failure = new Error('dispose failed')
    const { manager, dispose, drain } = fixture({
      dispose: state => {
        if (state.pluginId === 'second') return peerDispose.promise
        if (mode === 'throw') throw failure
        return Promise.reject(failure)
      },
      drain: state => state.pluginId === 'first' ? ownDrain.promise : Promise.resolve(),
    })
    await manager.initialize({ ready: true })
    const stopping = manager.shutdown()
    const outcome = stopping.catch(error => error)
    try {
      expect(dispose).toHaveBeenCalledTimes(2)
      await expectPending(stopping)
      expect(drain).toHaveBeenCalledTimes(2)
      ownDrain.release()
      await expectPending(stopping)
    } finally {
      ownDrain.release()
      peerDispose.release()
    }
    expect(await outcome).toBe(failure)
    await expect(manager.shutdown()).rejects.toBe(failure)
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it('keeps a settled state failure visible to later disable, enable, refresh, shutdown and reassembly', async () => {
    const failure = new Error('durable close failed')
    const { manager, states, dispose, drain } = fixture({ ids: ['demo'], drain: () => Promise.reject(failure) })
    await manager.initialize({ ready: true })
    await expect(manager.disablePlugin('demo')).rejects.toBe(failure)
    await expect(manager.disablePlugin('demo')).rejects.toBe(failure)
    await expect(manager.enablePlugin('demo')).rejects.toBe(failure)
    await expect(manager.refreshPlugins()).rejects.toBe(failure)
    await expect(manager.shutdown()).rejects.toBe(failure)
    await expect(manager.initialize({ ready: true })).rejects.toBe(failure)
    expect(states).toHaveLength(1)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(drain).toHaveBeenCalledTimes(1)
  })

  it('reports all failed states only after the last cleanup settles, preserving original error objects', async () => {
    const slow = barrier()
    const first = new Error('first failure')
    const second = new Error('second failure')
    const { manager } = fixture({
      dispose: state => state.pluginId === 'first' ? Promise.reject(first) : undefined,
      // The same error forwarded by dispose and drain must not be counted twice.
      drain: state => state.pluginId === 'first' ? Promise.reject(first) : slow.promise.then(() => { throw second }),
    })
    await manager.initialize({ ready: true })
    const stopping = manager.shutdown()
    const outcome = stopping.catch(error => error)
    try { await expectPending(stopping) } finally { slow.release() }
    const failure = await outcome
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors).toEqual([first, second])
    await expect(manager.shutdown()).rejects.toMatchObject({ errors: [first, second] })
  })

  it('waits for both a loading and an installed state of the same plugin when disabling', async () => {
    const entry = barrier()
    const slowClose = barrier()
    const failure = new Error('loading-state close failed')
    const { manager, states, dispose } = fixture({
      ids: ['demo'],
      entry: api => api.state.serial === 1 ? entry.promise : undefined,
      drain: state => state.serial === 1 ? Promise.reject(failure) : slowClose.promise,
    })
    const initializing = manager.initialize({ ready: true })
    const initializationOutcome = initializing.catch(error => error)
    let disabling: Promise<void> | undefined
    let outcome: Promise<unknown> | undefined
    try {
      await vi.waitFor(() => expect(states).toHaveLength(1))
      await manager.enablePlugin('demo')
      expect(states).toHaveLength(2)
      disabling = manager.disablePlugin('demo')
      outcome = disabling.catch(error => error)
      await expectPending(disabling)
      expect(dispose).toHaveBeenCalledTimes(2)
    } finally {
      slowClose.release()
      entry.release()
      await initializationOutcome
    }
    expect(await outcome).toBe(failure)
    expect(await initializationOutcome).toBe(failure)
    await expect(manager.shutdown()).rejects.toBe(failure)
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it('registers cleanup before host code can reenter shutdown and disposes each state only once', async () => {
    const slow = barrier()
    let nested: Promise<void> | undefined
    const { manager, dispose } = fixture({
      dispose: state => {
        if (state.pluginId === 'first') {
          nested = manager.shutdown()
          return slow.promise
        }
      },
    })
    await manager.initialize({ ready: true })
    const stopping = manager.shutdown()
    try {
      expect(nested).toBeDefined()
      expect(dispose).toHaveBeenCalledTimes(2)
      await expectPending(stopping)
      await expectPending(nested!)
    } finally { slow.release() }
    await Promise.all([stopping, nested])
    await manager.shutdown()
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it('does not refill the catalog when shutdown overtakes a refresh waiting for old-state cleanup', async () => {
    const close = barrier()
    const { manager, states } = fixture({ ids: ['demo'], drain: () => close.promise })
    await manager.initialize({ ready: true })
    const refreshing = manager.refreshPlugins()
    const stopping = manager.shutdown()
    try {
      await expectPending(refreshing)
      expect(manager.getPlugins()).toEqual([])
    } finally { close.release() }
    await Promise.all([refreshing, stopping])
    expect(manager.getPlugins()).toEqual([])
    expect(states).toHaveLength(1)
    expect(states[0]!.disposed).toBe(true)
  })

  it('does not reopen after a later shutdown supersedes an initialize waiting for cleanup', async () => {
    const close = barrier()
    const { manager, states } = fixture({ ids: ['demo'], drain: () => close.promise })
    await manager.initialize({ ready: true })
    const firstStop = manager.shutdown()
    const reinitializing = manager.initialize({ ready: true })
    const laterStop = manager.shutdown()
    try { await expectPending(reinitializing) } finally { close.release() }
    await Promise.all([firstStop, reinitializing, laterStop])
    expect(manager.getPlugins()).toEqual([])
    expect(states).toHaveLength(1)
    expect(states[0]!.disposed).toBe(true)
  })

  it.each(['initialize', 'enable'] as const)('reports a half-loaded state cleanup failure to %s after ordinary entry failure', async operation => {
    const closeFailure = new Error('half-loaded state could not close')
    let failEntry = operation === 'initialize'
    const { manager } = fixture({
      ids: ['demo'],
      entry: () => { if (failEntry) throw new Error('entry failed') },
      drain: () => failEntry ? Promise.reject(closeFailure) : Promise.resolve(),
    })
    if (operation === 'initialize') {
      await expect(manager.initialize({ ready: true })).rejects.toBe(closeFailure)
    } else {
      await manager.initialize({ ready: true })
      await manager.disablePlugin('demo')
      failEntry = true
      await expect(manager.enablePlugin('demo')).rejects.toBe(closeFailure)
    }
    expect(manager.getPlugins().some(info => info.loaded)).toBe(false)
    await expect(manager.shutdown()).rejects.toBe(closeFailure)
  })

  it('waits for accepted cleanup after another API factory throws, then reports both failures', async () => {
    const close = barrier()
    const closeStarted = barrier()
    const factoryFailure = new Error('second API factory failed')
    const closeFailure = new Error('first state close failed')
    const { manager, dispose } = fixture({
      create: pluginId => { if (pluginId === 'second') throw factoryFailure },
      entry: () => { throw new Error('first entry failed') },
      drain: () => {
        closeStarted.release()
        return close.promise.then(() => { throw closeFailure })
      },
    })
    const initializing = manager.initialize({ ready: true })
    const outcome = initializing.catch(error => error)
    try {
      await closeStarted.promise
      expect(dispose).toHaveBeenCalledTimes(1)
      await expectPending(initializing)
    } finally { close.release() }
    const failure = await outcome
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors).toEqual([factoryFailure, closeFailure])
    await expect(manager.shutdown()).rejects.toBe(closeFailure)
  })
})
