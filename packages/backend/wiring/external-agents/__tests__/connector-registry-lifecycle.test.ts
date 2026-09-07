import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeCodeConnectorOptions } from '@onething/runtime/external-agents/claude-code-connector'

const mocks = vi.hoisted(() => ({
  options: [] as ClaudeCodeConnectorOptions[],
  disposers: [] as ReturnType<typeof vi.fn>[],
  disposeWork: undefined as (() => Promise<void>) | undefined,
  interrupt: vi.fn(async () => {}),
  steer: vi.fn(() => 'steered'),
}))

vi.mock('@onething/runtime/external-agents', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  createClaudeCodeConnector: (options: ClaudeCodeConnectorOptions) => {
    mocks.options.push(options)
    const work = mocks.disposeWork
    const dispose = vi.fn(async () => { await work?.() })
    mocks.disposers.push(dispose)
    return {
      id: 'claude-code-agent', capabilities: { steer: true, interrupt: true },
      async *streamTurn() {}, interrupt: mocks.interrupt, steer: mocks.steer, dispose,
    }
  },
}))
vi.mock('../../../store.js', () => ({ getSession: () => undefined, getSettings: () => ({ network: {} }) }))
vi.mock('@onething/runtime/storage', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  getOnethingStorePath: () => '/tmp/onething-connector-registry-test',
}))
vi.mock('../../logging/index.js', () => {
  const logger = {
    ns: 'test', trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
    isLevelEnabled: () => false, child: () => logger,
  }
  return { writeAppLog: vi.fn(), getLogger: () => logger, consolePort: () => logger }
})
vi.mock('../host-tools.js', () => ({ resolveClaudeCodeHostToolSurface: vi.fn() }))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.resetModules()
  mocks.options.length = 0
  mocks.disposers.length = 0
  mocks.disposeWork = undefined
  vi.clearAllMocks()
})
afterEach(() => { vi.restoreAllMocks() })

describe('Backend external connector registry ownership', () => {
  it('retains lazy unowned callers and the existing connector ports', async () => {
    const registry = await import('../index.js')
    const first = registry.getExternalAgentConnectors()
    expect(registry.getExternalAgentConnectors()).toBe(first)
    expect(mocks.options[0]).toMatchObject({
      permissionHandler: registry.askExternalAgentPermission,
      interactionHandler: registry.askExternalAgentInteraction,
      resolveSpawnEnv: registry.resolveExternalAgentSpawnEnv,
      hostToolSurface: registry.resolveClaudeCodeHostToolSurface,
      observer: expect.any(Object), logger: expect.any(Object),
    })
    await registry.disposeExternalAgentConnectors()
    expect(mocks.disposers[0]).toHaveBeenCalledTimes(1)
    expect(registry.getExternalAgentConnectors()).not.toBe(first)
    await registry.disposeExternalAgentConnectors()
  })

  it('releases an unused configuration and keeps its closed generation from lazily reopening', async () => {
    const registry = await import('../index.js')
    const a = registry.bindExternalAgentConnectors()
    await a.ready
    await a.dispose()
    expect(() => registry.getExternalAgentConnectors()).toThrow('shutting down')
    expect(mocks.options).toHaveLength(0)
    const b = registry.bindExternalAgentConnectors()
    await b.ready
    registry.getExternalAgentConnectors()
    expect(mocks.options).toHaveLength(1)
    await b.dispose()
  })

  it('an old disposer or quiesce callback cannot clear the new generation', async () => {
    const registry = await import('../index.js')
    const a = registry.bindExternalAgentConnectors()
    await a.ready
    registry.getExternalAgentConnectors()
    await a.dispose()
    const b = registry.bindExternalAgentConnectors()
    await b.ready
    const second = registry.getExternalAgentConnectors()
    a.quiesce()
    await a.dispose()
    expect(registry.getExternalAgentConnectors()).toBe(second)
    expect(mocks.disposers[0]).toHaveBeenCalledTimes(1)
    expect(mocks.disposers[1]).not.toHaveBeenCalled()
    await b.dispose()
  })

  it('does not allow another owner or a lazy rebuild while real disposal is pending', async () => {
    const gate = deferred()
    const entered = deferred()
    mocks.disposeWork = async () => { entered.resolve(); await gate.promise }
    const registry = await import('../index.js')
    const a = registry.bindExternalAgentConnectors()
    await a.ready
    registry.getExternalAgentConnectors()
    const closing = a.dispose()
    try {
      await entered.promise
      expect(a.dispose()).toBe(closing)
      expect(() => registry.bindExternalAgentConnectors()).toThrow('not finished shutting down')
      expect(() => registry.getExternalAgentConnectors()).toThrow('shutting down')
      expect(registry.takeExternalAgentSteering('s', 'late')).toBe(false)
      await registry.interruptExternalAgentSessions('s')
      expect(mocks.interrupt).toHaveBeenCalledWith('s')
    } finally {
      gate.resolve()
      await closing
    }
  })

  it('preserves a failed owner and its first disposal error instead of silently replacing it', async () => {
    const error = new Error('accepted writer failed')
    mocks.disposeWork = async () => { throw error }
    const registry = await import('../index.js')
    const a = registry.bindExternalAgentConnectors()
    await a.ready
    registry.getExternalAgentConnectors()
    await expect(a.dispose()).rejects.toBe(error)
    await expect(a.dispose()).rejects.toBe(error)
    expect(() => registry.bindExternalAgentConnectors()).toThrow('not finished shutting down')
    expect(() => registry.getExternalAgentConnectors()).toThrow('shutting down')
    expect(mocks.disposers[0]).toHaveBeenCalledTimes(1)
  })

  it('waits for a previous unowned registry and ignores its late global cleanup', async () => {
    const gate = deferred()
    const entered = deferred()
    mocks.disposeWork = async () => { entered.resolve(); await gate.promise }
    const registry = await import('../index.js')
    registry.getExternalAgentConnectors()
    const oldClosing = registry.disposeExternalAgentConnectors()
    const next = registry.bindExternalAgentConnectors()
    let ready = false
    void next.ready.then(() => { ready = true })
    try {
      await entered.promise
      expect(ready).toBe(false)
      expect(() => registry.getExternalAgentConnectors()).toThrow('initializing')
      expect(() => registry.bindExternalAgentConnectors()).toThrow('not finished shutting down')
      mocks.disposeWork = undefined
      gate.resolve()
      await oldClosing
      await next.ready
      registry.getExternalAgentConnectors()
      expect(mocks.options).toHaveLength(2)
    } finally {
      gate.resolve()
      await oldClosing
      await next.dispose()
    }
  })

  it('keeps the new owner observable when legacy disposal fails during ready', async () => {
    const error = new Error('legacy child failed to close')
    mocks.disposeWork = async () => { throw error }
    const registry = await import('../index.js')
    registry.getExternalAgentConnectors()
    const next = registry.bindExternalAgentConnectors()
    await expect(next.ready).rejects.toBe(error)
    await expect(next.dispose()).rejects.toBe(error)
    expect(() => registry.getExternalAgentConnectors()).toThrow('initializing')
    expect(() => registry.bindExternalAgentConnectors()).toThrow('not finished shutting down')
    expect(mocks.options).toHaveLength(1)
  })

  it('honors synchronous Backend admission closure before phased disposal starts', async () => {
    const registry = await import('../index.js')
    let active = true
    const owner = registry.bindExternalAgentConnectors({ isAccepting: () => active })
    await owner.ready
    registry.getExternalAgentConnectors()
    active = false
    expect(() => registry.getExternalAgentConnectors()).toThrow('shutting down')
    expect(registry.takeExternalAgentSteering('s', 'late')).toBe(false)
    await owner.dispose()
  })
})
