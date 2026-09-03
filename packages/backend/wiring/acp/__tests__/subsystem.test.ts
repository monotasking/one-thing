/**
 * `AcpSubsystem` 的生命周期(C1,方案
 * `docs/design/backend-principal-and-mcp-lifecycle-2026-09.md` §2.2)。
 *
 * 与 `wiring/mcp/__tests__/subsystem.test.ts` 同型的精简版:ACP 的 `initialize` 是
 * 同步的,所以"在途"那段窗口靠一只 async 的替身造出来 —— 判的仍然是同一件事
 * (dispose 必须等在途的 start 落地,再 shutdown 恰好一次)。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ACPSettings } from '@onething/runtime/acp'
import { getLogger } from '../../logging/index.js'
import { AcpSubsystem, type AcpSubsystemDeps } from '../subsystem.js'

const SETTINGS: ACPSettings = { enabled: true, agents: [] }

function makeDeps(
  options: { initializeGate?: Promise<void>; shutdownGate?: Promise<void>; disposeTimeoutMs?: number } = {},
) {
  const calls: string[] = []
  const manager = {
    initialize: vi.fn(async (settings: ACPSettings) => {
      calls.push('initialize')
      if (options.initializeGate) await options.initializeGate
      void settings
    }),
    updateSettings: vi.fn(() => {
      calls.push('updateSettings')
    }),
    shutdown: vi.fn(async () => {
      calls.push('shutdown')
      if (options.shutdownGate) await options.shutdownGate
    }),
  }
  const deps: AcpSubsystemDeps = {
    manager,
    settings: () => SETTINGS,
    disposeTimeoutMs: options.disposeTimeoutMs,
  }
  return { deps, manager, calls }
}

describe('AcpSubsystem', () => {
  it('start() 幂等:第二次调返回同一只 promise', async () => {
    const { deps, manager } = makeDeps()
    const acp = new AcpSubsystem(deps)

    expect(acp.state).toBe('idle')
    const first = acp.start()
    expect(acp.start()).toBe(first)
    await first
    expect(acp.state).toBe('running')
    expect(manager.initialize).toHaveBeenCalledTimes(1)
  })

  it('start 在途时 dispose:等 start 落地之后 shutdown 恰好一次', async () => {
    let openGate = (): void => {}
    const gate = new Promise<void>(resolve => {
      openGate = resolve
    })
    const { deps, manager, calls } = makeDeps({ initializeGate: gate })
    const acp = new AcpSubsystem(deps)

    void acp.start()
    expect(manager.initialize).toHaveBeenCalledTimes(1)

    const disposed = acp.dispose()
    await Promise.resolve()
    expect(manager.shutdown).not.toHaveBeenCalled()

    openGate()
    await disposed

    expect(manager.shutdown).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['initialize', 'shutdown'])
    expect(acp.state).toBe('disposed')
  })

  it('从未 start 过的 dispose 不调 shutdown', async () => {
    const { deps, manager } = makeDeps()
    const acp = new AcpSubsystem(deps)
    await acp.dispose()
    expect(manager.shutdown).not.toHaveBeenCalled()
    expect(acp.state).toBe('disposed')
  })

  it('dispose 幂等,且 dispose 之后 start 是 no-op', async () => {
    const { deps, manager } = makeDeps()
    const acp = new AcpSubsystem(deps)
    await acp.start()
    await acp.dispose()
    await acp.dispose()
    await acp.start()
    expect(manager.shutdown).toHaveBeenCalledTimes(1)
    expect(manager.initialize).toHaveBeenCalledTimes(1)
  })

  it('applySettings 转给 manager.updateSettings', async () => {
    const { deps, manager } = makeDeps()
    const acp = new AcpSubsystem(deps)
    await acp.applySettings({ enabled: false, agents: [] })
    expect(manager.updateSettings).toHaveBeenCalledWith({ enabled: false, agents: [] })
  })

  /*
   * 收尾批(2026-09-03,用户裁定 b):等待有界,与 MCP 同型。理由见
   * `wiring/mcp/__tests__/subsystem.test.ts` 末尾那两条。
   */
  it('shutdown 挂住:dispose 在上限内返回,并记一行 warn', async () => {
    const { deps, manager } = makeDeps({ shutdownGate: new Promise<void>(() => {}), disposeTimeoutMs: 30 })
    const warn = vi.spyOn(getLogger('app.acp.subsystem'), 'warn').mockImplementation(() => {})
    const acp = new AcpSubsystem(deps)
    await acp.start()

    const startedAt = Date.now()
    await acp.dispose()

    expect(manager.shutdown).toHaveBeenCalledTimes(1)
    expect(Date.now() - startedAt).toBeLessThan(2000)
    expect(acp.state).toBe('disposed')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toBe('acp shutdown timed out; continuing dispose')
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ agents: 0 })
    warn.mockRestore()
  })

  it('正常收尾:不触发上限,一个 warn 都不记', async () => {
    const { deps, manager } = makeDeps({ disposeTimeoutMs: 30 })
    const warn = vi.spyOn(getLogger('app.acp.subsystem'), 'warn').mockImplementation(() => {})
    const acp = new AcpSubsystem(deps)
    await acp.start()

    await acp.dispose()

    expect(manager.shutdown).toHaveBeenCalledTimes(1)
    expect(acp.state).toBe('disposed')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
