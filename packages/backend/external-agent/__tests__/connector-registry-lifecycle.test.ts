import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalAgentConnector } from '@onething/backend/external-agent'

const mocks = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  disposers: [] as ReturnType<typeof vi.fn>[],
  disposeWork: undefined as (() => Promise<void>) | undefined,
  interrupt: vi.fn(async () => {}),
  steer: vi.fn(() => 'steered'),
}))

// D202:连接器登记表是只读表 —— 连接器由装配组好递进 `bindExternalAgentConnectors({ connectors })`(无主那一档经
// 测试钩子递)。从前这里在连接器模块上打桩,现在替身直接作为那张表递进去;替身的身体一字未改。
// `hostMcp` 那一格从前是登记表自己接的,如今是装配(`backend.ts`)接,这里照装配的样子递。
function fakeCreateAcpConnector(options: Record<string, unknown>) {
  mocks.options.push(options)
  const work = mocks.disposeWork
  const dispose = vi.fn(async () => { await work?.() })
  mocks.disposers.push(dispose)
  return {
    id: 'acp', capabilities: { steer: true, interrupt: true },
    async *streamTurn() {}, interrupt: mocks.interrupt, steer: mocks.steer, dispose,
  }
}
const connectors = () => ({ acp: fakeCreateAcpConnector({ hostMcp: { port: 'host-mcp' } }) as unknown as ExternalAgentConnector })
vi.mock('@onething/backend/session', async importOriginal => ({
  ...await importOriginal<typeof import('@onething/backend/session')>(),
  getSession: () => undefined,
}))
vi.mock('@onething/backend/settings', async importOriginal => ({
  ...await importOriginal<typeof import('@onething/backend/settings')>(),
  getSettings: () => ({ network: {} }),
}))
vi.mock('@onething/backend/storage', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  getOnethingStorePath: () => '/tmp/onething-connector-registry-test',
}))
// D191:读者改从 logging 入口拿 `writeAppLog`,替身随之打在入口上(从前打在 `logging-configure`)。
vi.mock('@onething/backend/logging', async importOriginal => {
  const actual = await importOriginal<typeof import('@onething/backend/logging')>()
  const logger = {
    ns: 'test', trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
    isLevelEnabled: () => false, child: () => logger,
  }
  return { ...actual, getLogger: () => logger, consolePort: () => logger, writeAppLog: vi.fn() }
})
vi.mock('../external-agent-host-tools.js', () => ({ resolveHostToolSurface: vi.fn() }))

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
    const registry = await import('../external-agent-connector-registry.js')
    registry.installUnownedExternalAgentConnectorsForTests({ connectors })
    const first = registry.getExternalAgentConnectors()
    expect(registry.getExternalAgentConnectors()).toBe(first)
    expect(mocks.options[0]).toMatchObject({ hostMcp: { port: 'host-mcp' } })
    await registry.disposeExternalAgentConnectors()
    expect(mocks.disposers[0]).toHaveBeenCalledTimes(1)
    expect(registry.getExternalAgentConnectors()).not.toBe(first)
    await registry.disposeExternalAgentConnectors()
  })

  it('releases an unused configuration and keeps its closed generation from lazily reopening', async () => {
    const registry = await import('../external-agent-connector-registry.js')
    const a = registry.bindExternalAgentConnectors({ connectors })
    await a.ready
    await a.dispose()
    expect(() => registry.getExternalAgentConnectors()).toThrow('shutting down')
    expect(mocks.options).toHaveLength(0)
    const b = registry.bindExternalAgentConnectors({ connectors })
    await b.ready
    registry.getExternalAgentConnectors()
    expect(mocks.options).toHaveLength(1)
    await b.dispose()
  })

  it('an old disposer or quiesce callback cannot clear the new generation', async () => {
    const registry = await import('../external-agent-connector-registry.js')
    const a = registry.bindExternalAgentConnectors({ connectors })
    await a.ready
    registry.getExternalAgentConnectors()
    await a.dispose()
    const b = registry.bindExternalAgentConnectors({ connectors })
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
    const registry = await import('../external-agent-connector-registry.js')
    const a = registry.bindExternalAgentConnectors({ connectors })
    await a.ready
    registry.getExternalAgentConnectors()
    const closing = a.dispose()
    try {
      await entered.promise
      expect(a.dispose()).toBe(closing)
      expect(() => registry.bindExternalAgentConnectors({ connectors })).toThrow('not finished shutting down')
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
    const registry = await import('../external-agent-connector-registry.js')
    const a = registry.bindExternalAgentConnectors({ connectors })
    await a.ready
    registry.getExternalAgentConnectors()
    await expect(a.dispose()).rejects.toBe(error)
    await expect(a.dispose()).rejects.toBe(error)
    expect(() => registry.bindExternalAgentConnectors({ connectors })).toThrow('not finished shutting down')
    expect(() => registry.getExternalAgentConnectors()).toThrow('shutting down')
    expect(mocks.disposers[0]).toHaveBeenCalledTimes(1)
  })

  it('waits for a previous unowned registry and ignores its late global cleanup', async () => {
    const gate = deferred()
    const entered = deferred()
    mocks.disposeWork = async () => { entered.resolve(); await gate.promise }
    const registry = await import('../external-agent-connector-registry.js')
    registry.installUnownedExternalAgentConnectorsForTests({ connectors })
    registry.getExternalAgentConnectors()
    const oldClosing = registry.disposeExternalAgentConnectors()
    const next = registry.bindExternalAgentConnectors({ connectors })
    let ready = false
    void next.ready.then(() => { ready = true })
    try {
      await entered.promise
      expect(ready).toBe(false)
      expect(() => registry.getExternalAgentConnectors()).toThrow('initializing')
      expect(() => registry.bindExternalAgentConnectors({ connectors })).toThrow('not finished shutting down')
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
    const registry = await import('../external-agent-connector-registry.js')
    registry.installUnownedExternalAgentConnectorsForTests({ connectors })
    registry.getExternalAgentConnectors()
    const next = registry.bindExternalAgentConnectors({ connectors })
    await expect(next.ready).rejects.toBe(error)
    await expect(next.dispose()).rejects.toBe(error)
    expect(() => registry.getExternalAgentConnectors()).toThrow('initializing')
    expect(() => registry.bindExternalAgentConnectors({ connectors })).toThrow('not finished shutting down')
    expect(mocks.options).toHaveLength(1)
  })

  it('honors synchronous Backend admission closure before phased disposal starts', async () => {
    const registry = await import('../external-agent-connector-registry.js')
    let active = true
    const owner = registry.bindExternalAgentConnectors({ isAccepting: () => active, connectors })
    await owner.ready
    registry.getExternalAgentConnectors()
    active = false
    expect(() => registry.getExternalAgentConnectors()).toThrow('shutting down')
    expect(registry.takeExternalAgentSteering('s', 'late')).toBe(false)
    await owner.dispose()
  })
})
