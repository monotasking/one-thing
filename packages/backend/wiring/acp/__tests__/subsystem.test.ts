/**
 * `AcpSubsystem` 的生命周期(C1,方案
 * `docs/design/backend-principal-and-mcp-lifecycle-2026-09.md` §2.2)。
 *
 * 与 `wiring/mcp/__tests__/subsystem.test.ts` 同型的精简版:ACP 的 `initialize` 是
 * 同步的,所以"在途"那段窗口靠一只 async 的替身造出来 —— 判的仍然是同一件事
 * (dispose 必须等在途的 start 落地,再 shutdown 恰好一次)。
 */
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ACPSettings, AcpSessionState } from '@shared/contracts/acp'
import { getLogger } from '../../logging/index.js'
import { AcpAgentRegistry } from '../registry.js'
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

/*
 * A1-a:子系统持有名册。管家吃的是名册的生效配置,不再是设置原样;模型目录与 `getAgents`
 * 的行也从名册来。种子目录用仓里真的 `resources/acp-agents`(种子是数据,不是夹具),探测注入。
 */
describe('AcpSubsystem × 名册', () => {
  const seedDir = path.resolve(__dirname, '../../../../../resources/acp-agents')

  function makeRosterDeps(settings: ACPSettings, installed: string[]) {
    const { deps, manager } = makeDeps()
    const setAgentAliases = vi.fn()
    const registry = new AcpAgentRegistry({
      seedDir: () => seedDir,
      cachePath: () => path.join(seedDir, '__no_cache__.json'),
      settings: () => settings,
      locate: manifest => ({ installed: installed.includes(manifest.id), checkedAt: 1 }),
      detect: async manifest => ({ installed: installed.includes(manifest.id), checkedAt: 1 }),
    })
    const acp = new AcpSubsystem({ ...deps, manager: { ...manager, setAgentAliases }, settings: () => settings, registry })
    return { acp, manager, setAgentAliases }
  }

  it('start / applySettings 喂给管家的是「启用且起得来」的生效配置,用户条目照样在', async () => {
    const settings: ACPSettings = {
      enabled: true,
      agents: [{ id: 'fake', name: 'Fake', enabled: true, command: process.execPath, args: ['fake.mjs'] }],
    }
    const { acp, manager, setAgentAliases } = makeRosterDeps(settings, ['claude-code'])
    await acp.start()
    const fed = manager.initialize.mock.calls[0]?.[0] as ACPSettings
    expect(fed.enabled).toBe(true)
    expect(fed.agents.map(agent => agent.id).sort()).toEqual(['claude-code', 'fake'])
    expect(fed.agents.find(agent => agent.id === 'claude-code')).toMatchObject({ command: 'claude-agent-acp', enabled: true })
    // 旧 id 表来自种子数据,交给管家。
    expect(setAgentAliases).toHaveBeenCalledWith(expect.objectContaining({ 'codex-cli': 'codex', 'kimi-code': 'kimi' }))

    await acp.applySettings({ ...settings, enabled: false })
    const calls = manager.updateSettings.mock.calls as unknown as Array<[ACPSettings]>
    const next = calls.at(-1)?.[0] as ACPSettings
    expect(next.enabled).toBe(false)
    await acp.dispose()
  })

  it('模型目录列种子(没装的也列)与用户条目;getAgents 的行带 manifest / 来处 / 探测', async () => {
    const settings: ACPSettings = { enabled: true, agents: [] }
    const { acp } = makeRosterDeps(settings, ['gemini'])
    const models = acp.modelAgents().map(agent => agent.id)
    expect(models).toEqual(expect.arrayContaining(['claude-code', 'codex', 'gemini', 'copilot', 'kimi', 'pi']))

    const gemini = acp.agentStates().find(row => row.config.id === 'gemini')!
    expect(gemini.source).toBe('builtin')
    expect(gemini.manifest?.configPaths).toEqual(['~/.gemini'])
    expect(gemini.detect?.installed).toBe(true)
    expect(gemini.status).toBe('disconnected')
    expect(gemini.config).toMatchObject({ command: 'gemini', args: ['--acp'], enabled: true })
  })
})

describe('AcpSubsystem 会话状态投影(A2-b)', () => {
  it('构造时逐只订上;一只抛了不连累别的;dispose 退订并 dispose 每一只', async () => {
    const sessionListeners = new Set<(state: AcpSessionState) => void>()
    const manager = {
      initialize: vi.fn(),
      updateSettings: vi.fn(),
      shutdown: vi.fn(async () => {}),
      onSessionStateChanged: (listener: (state: AcpSessionState) => void) => {
        sessionListeners.add(listener)
        return () => { sessionListeners.delete(listener) }
      },
      onAgentStateChanged: () => () => {},
    }
    const seen: string[] = []
    const broken = { label: 'broken', observe: vi.fn(() => { throw new Error('boom') }), dispose: vi.fn() }
    const good = { label: 'good', observe: vi.fn((state: AcpSessionState) => { seen.push(state.localSessionId) }), dispose: vi.fn() }
    const subsystem = new AcpSubsystem({ manager, settings: () => SETTINGS, projections: [broken, good] })
    // 广播器 + 两只投影。
    expect(sessionListeners.size).toBe(3)

    const state = { localSessionId: 's1', agentId: 'fake', configOptions: [], commands: [], notices: [], process: { status: 'connected' } } as AcpSessionState
    for (const listener of sessionListeners) listener(state)
    expect(broken.observe).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['s1'])

    await subsystem.dispose()
    expect(sessionListeners.size).toBe(0)
    expect(broken.dispose).toHaveBeenCalledTimes(1)
    expect(good.dispose).toHaveBeenCalledTimes(1)
  })
})
