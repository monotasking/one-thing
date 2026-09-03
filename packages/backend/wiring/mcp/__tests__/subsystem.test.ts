/**
 * `McpSubsystem` 的生命周期(C1,方案
 * `docs/design/backend-principal-and-mcp-lifecycle-2026-09.md` §2.2)。
 *
 * 这份文件问的是**一件事**:关门时在途的那趟 start 怎么办。审查第 2 条的孤儿
 * (壳起来两秒内退出,stdio 子进程已经拉起而 shutdown 还没登记)在结构上就死在
 * 这条断言下面 —— 去掉 `dispose()` 里那句 `await inFlight`,「start 途中 dispose →
 * shutdown 恰好一次且排在 initialize 之后」当场红。
 *
 * 依赖全是注入的替身,所以这里不起任何真 MCP:manager 是三件套,工具目录是一个计数,
 * capabilities 口是一个槽。
 */
import { describe, expect, it, vi } from 'vitest'
import type { MCPSettings } from '@onething/core/mcp'
import { getLogger } from '../../logging/index.js'
import { McpSubsystem, type McpSubsystemDeps } from '../subsystem.js'

const SETTINGS: MCPSettings = { enabled: true, servers: [] }

/** 可控的替身:`initialize` 悬在一只手动 resolve 的闸上,顺带记调用次序。 */
function makeDeps(
  options: { initializeGate?: Promise<void>; shutdownGate?: Promise<void>; disposeTimeoutMs?: number } = {},
) {
  const calls: string[] = []
  const capabilitiesSlot: { handler: ((serverId: string) => void) | null } = { handler: null }
  const manager = {
    initialize: vi.fn(async (settings: MCPSettings) => {
      calls.push('initialize')
      if (options.initializeGate) await options.initializeGate
      void settings
    }),
    updateSettings: vi.fn(async () => {
      calls.push('updateSettings')
    }),
    shutdown: vi.fn(async () => {
      calls.push('shutdown')
      if (options.shutdownGate) await options.shutdownGate
    }),
  }
  const registerTools = vi.fn(async () => {
    calls.push('registerTools')
  })
  const deps: McpSubsystemDeps = {
    manager,
    settings: () => SETTINGS,
    registerTools,
    onCapabilitiesChanged: handler => {
      capabilitiesSlot.handler = handler
    },
    disposeTimeoutMs: options.disposeTimeoutMs,
  }
  return { deps, manager, registerTools, calls, capabilitiesSlot }
}

describe('McpSubsystem', () => {
  it('start() 幂等:第二次调返回同一只 promise,manager 只 initialize 一次', async () => {
    const { deps, manager } = makeDeps()
    const mcp = new McpSubsystem(deps)

    expect(mcp.state).toBe('idle')
    const first = mcp.start()
    const second = mcp.start()
    expect(second).toBe(first)
    expect(mcp.state).toBe('starting')

    await first
    expect(mcp.state).toBe('running')
    // 起好之后再调也还是同一只(不重连一遍)。
    expect(mcp.start()).toBe(first)
    expect(manager.initialize).toHaveBeenCalledTimes(1)
  })

  it('start 在途时 dispose:等 start 落地之后 shutdown 恰好一次', async () => {
    let openGate = (): void => {}
    const gate = new Promise<void>(resolve => {
      openGate = resolve
    })
    const { deps, manager, calls } = makeDeps({ initializeGate: gate })
    const mcp = new McpSubsystem(deps)

    void mcp.start()
    expect(manager.initialize).toHaveBeenCalledTimes(1)
    // 关键时刻:initialize 还挂在闸上(子进程已经拉起来了)。
    expect(manager.shutdown).not.toHaveBeenCalled()

    const disposed = mcp.dispose()
    // 还没放闸 → shutdown 一次都不许跑(否则就是"对着一台还在起的 MCP 关门")。
    await Promise.resolve()
    expect(manager.shutdown).not.toHaveBeenCalled()

    openGate()
    await disposed

    expect(manager.shutdown).toHaveBeenCalledTimes(1)
    // 次序是判据本身:shutdown 必须排在 initialize 之后。
    expect(calls).toEqual(['initialize', 'registerTools', 'shutdown'])
    expect(mcp.state).toBe('disposed')
  })

  it('start 在途失败也照样等它落地再 shutdown', async () => {
    let breakGate = (_error: Error): void => {}
    const gate = new Promise<void>((_resolve, reject) => {
      breakGate = reject
    })
    const { deps, manager } = makeDeps({ initializeGate: gate })
    const mcp = new McpSubsystem(deps)

    const started = mcp.start()
    started.catch(() => undefined)
    const disposed = mcp.dispose()
    breakGate(new Error('mcp server refused'))
    await disposed

    expect(manager.shutdown).toHaveBeenCalledTimes(1)
    expect(mcp.state).toBe('disposed')
  })

  it('从未 start 过的 dispose 不调 shutdown', async () => {
    const { deps, manager, capabilitiesSlot } = makeDeps()
    const mcp = new McpSubsystem(deps)

    await mcp.dispose()
    expect(manager.shutdown).not.toHaveBeenCalled()
    expect(mcp.state).toBe('disposed')
    // capabilities 那口单槽端口摘回 null —— 关掉的 backend 不该还挂在通知点上。
    expect(capabilitiesSlot.handler).toBeNull()
  })

  it('dispose 幂等:第二次不再 shutdown', async () => {
    const { deps, manager } = makeDeps()
    const mcp = new McpSubsystem(deps)
    await mcp.start()
    await mcp.dispose()
    await mcp.dispose()
    expect(manager.shutdown).toHaveBeenCalledTimes(1)
  })

  it('dispose 之后的 start 是 no-op(关门之后不许再开一台)', async () => {
    const { deps, manager } = makeDeps()
    const mcp = new McpSubsystem(deps)
    await mcp.dispose()
    await mcp.start()
    expect(manager.initialize).not.toHaveBeenCalled()
    expect(mcp.state).toBe('disposed')
  })

  it('applySettings = updateSettings + registerTools', async () => {
    const { deps, manager, registerTools, calls } = makeDeps()
    const mcp = new McpSubsystem(deps)

    await mcp.applySettings({ enabled: true, servers: [], flatToolThreshold: 3 })

    expect(manager.updateSettings).toHaveBeenCalledWith({ enabled: true, servers: [], flatToolThreshold: 3 })
    expect(registerTools).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['updateSettings', 'registerTools'])
  })

  it('构造时接一次 capabilities-changed,通知落到 registerTools 上', async () => {
    const { deps, registerTools, capabilitiesSlot } = makeDeps()
    const mcp = new McpSubsystem(deps)

    expect(capabilitiesSlot.handler).toBeTypeOf('function')
    capabilitiesSlot.handler?.('server-1')
    await Promise.resolve()
    expect(registerTools).toHaveBeenCalledTimes(1)
    await mcp.dispose()
  })

  it('start 失败之后可以重试(失败不粘住)', async () => {
    const { deps, manager } = makeDeps()
    manager.initialize.mockRejectedValueOnce(new Error('boom'))
    const mcp = new McpSubsystem(deps)

    await expect(mcp.start()).rejects.toThrow('boom')
    expect(mcp.state).toBe('idle')

    await mcp.start()
    expect(mcp.state).toBe('running')
    expect(manager.initialize).toHaveBeenCalledTimes(2)
  })

  /*
   * 收尾批(2026-09-03,用户裁定 b):**等待有界**。
   *
   * C1 的"dispose 等在途 start 落地"在一台握手挂死的 stdio 服务器上会把
   * `apps/server` 那 5s SIGTERM 预算吃干净(实测 5.06s +
   * `shutdown did not finish in time; pending session writes may be lost`)。
   * 上限压在 5s 底下,超时记 warn 并照常返回,把剩下的时间留给排在 dispose 链
   * 后面的会话账本 flush。反证:去掉 `raceDisposeTimeout` 里那只 deadline(或直接
   * `await work`)→ 下面第一条挂在 `dispose()` 上永不返回,超时红。
   */
  it('shutdown 挂住:dispose 在上限内返回,并记一行 warn', async () => {
    // 永不 resolve 的闸 = 真机上那台在握手上挂死的 stdio 服务器。
    const { deps, manager } = makeDeps({ shutdownGate: new Promise<void>(() => {}), disposeTimeoutMs: 30 })
    const warn = vi.spyOn(getLogger('app.mcp.subsystem'), 'warn').mockImplementation(() => {})
    const mcp = new McpSubsystem(deps)
    await mcp.start()

    const startedAt = Date.now()
    // 不加上限的话这一句永远不返回 —— 用例会被 vitest 的超时判红。
    await mcp.dispose()
    const elapsed = Date.now() - startedAt

    expect(manager.shutdown).toHaveBeenCalledTimes(1)
    expect(elapsed).toBeLessThan(2000)
    expect(mcp.state).toBe('disposed')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toBe('mcp shutdown timed out; continuing dispose')
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ servers: 0 })
    expect(typeof (warn.mock.calls[0]?.[1] as { elapsedMs?: unknown })?.elapsedMs).toBe('number')
    warn.mockRestore()
  })

  it('正常收尾:不触发上限,一个 warn 都不记', async () => {
    const { deps, manager } = makeDeps({ disposeTimeoutMs: 30 })
    const warn = vi.spyOn(getLogger('app.mcp.subsystem'), 'warn').mockImplementation(() => {})
    const mcp = new McpSubsystem(deps)
    await mcp.start()

    await mcp.dispose()

    expect(manager.shutdown).toHaveBeenCalledTimes(1)
    expect(mcp.state).toBe('disposed')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
