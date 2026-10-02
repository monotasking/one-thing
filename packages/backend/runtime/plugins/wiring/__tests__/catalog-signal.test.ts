/**
 * 目录变更信号(R5 评审 A3)。
 *
 * 两个症状同一个成因:**目录变了没人说一声**。
 *  - 插件系统是 post-window 非阻塞装配的,renderer 在 boot 时拉的那一次很可能拉了
 *    个空清单,而后再没有任何推送能纠正它 —— 面板入口冷启动后可能永远不出现;
 *  - 设置窗启停插件不产生跨窗口信号,主窗的 nav 停在陈旧状态,点开报 "not active"。
 *
 * 所以 bootstrap 完成 / 启用 / 停用 / 刷新统一发一条 `kind: 'catalog-changed'`,
 * renderer 收到就重拉。信号是**机械的**(带 kind),不弹 toast。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const storeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onething-plugin-catalog-')))
const previousStorePath = process.env.ONETHING_STORE_PATH
process.env.ONETHING_STORE_PATH = storeRoot
const cleanups: Array<() => Promise<void>> = []
const agentLogStreams: fs.WriteStream[] = []
const createWriteStream = fs.createWriteStream
// Observe real streams without changing open/write/end behavior. Production
// shutdown must close them; the fixture must not finish them on its behalf.
const streamObserver = vi.spyOn(fs, 'createWriteStream').mockImplementation((...args) => {
  const stream = createWriteStream(...args)
  const file = args[0]
  if (typeof file === 'string' && path.dirname(file) === path.join(storeRoot, 'log')
    && /^agent-.*\.log$/.test(path.basename(file))) agentLogStreams.push(stream)
  return stream
})

afterAll(async () => {
  try {
    const results = await Promise.allSettled(cleanups.reverse().map(cleanup => Promise.resolve().then(cleanup)))
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length === 1) throw failures[0]!.reason
    if (failures.length > 1) throw new AggregateError(failures.map(result => result.reason), 'Plugin fixture shutdown failed')
    expect(agentLogStreams.length, 'the real log-monitor streams must be observed').toBeGreaterThan(0)
    expect(agentLogStreams.every(stream => stream.closed), 'production shutdown must await every real log stream close').toBe(true)
    fs.rmSync(storeRoot, { recursive: true, force: true })
  } finally {
    // Preserve the fixture directory when shutdown fails, but always restore
    // process state so the error cannot redirect later tests into this store.
    streamObserver.mockRestore()
    if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
    else process.env.ONETHING_STORE_PATH = previousStorePath
  }
})

interface Emitted {
  type: string
  kind?: string
  pluginId?: string
  panelId?: string
  message?: string
  level?: string
}

function stubEventBus(sink: Emitted[]) {
  return {
    emitGlobal: (event: Emitted) => { sink.push(event) },
    onGlobal: () => () => {},
    onAnySession: () => () => {},
    onAnySessionAny: () => () => {},
  }
}

describe('plugin catalog-changed signal', () => {
  // 真装配一次插件系统(读盘 + 加载内置插件)在负载下会逼近 vitest 的 5s 默认超时。
  // 给显式预算,免得 CI 上偶发红成为噪音。
  it('announces the catalog after bootstrap and on every enable/disable', { timeout: 20_000 }, async () => {
    const { PluginManager } = await import('../manager.js')
    const emitted: Emitted[] = []
    const manager = new PluginManager()
    cleanups.push(() => manager.shutdown())

    await manager.initialize({
      eventBus: stubEventBus(emitted) as never,
      streamEngine: {} as never,
    })

    const catalogSignals = (): Emitted[] => emitted.filter(event => event.kind === 'catalog-changed')

    // 装配完成才是 renderer 能看到真实清单的时刻。
    // 断言"至少一条"而不是恰好一条:装配内部还会走一次扫描,那同样是目录变更。
    expect(catalogSignals().length).toBeGreaterThanOrEqual(1)

    const builtin = manager.getPlugins()[0]
    expect(builtin, 'expected at least one built-in plugin').toBeTruthy()

    const afterBootstrap = catalogSignals().length
    await manager.disablePlugin(builtin.definition.id)
    expect(catalogSignals().length).toBe(afterBootstrap + 1)

    await manager.enablePlugin(builtin.definition.id)
    expect(catalogSignals().length).toBe(afterBootstrap + 2)

    // 机械信号:带 kind,所以 renderer 不会把它弹成 toast。
    for (const signal of catalogSignals()) {
      expect(signal.type).toBe('plugin:notification')
      expect(signal.level).toBe('info')
    }

    // 卸载同样改目录 —— R5 加 catalog-changed 正是为了让主窗撤掉入口,
    // 而卸载这条路径当时漏了(留着一个已卸载插件的面板入口)。
    const beforeUninstall = catalogSignals().length
    await manager.uninstallPlugin('definitely-not-installed')
    expect(catalogSignals().length).toBe(beforeUninstall + 1)

  })
})

describe('panel refresh fan-out', () => {
  it('coalesces a burst of ctx.refresh() into one signal per panel', async () => {
    // 插件在一次批量操作里对每个变化调一次 refresh 是完全合理的写法 ——
    // 但那是 N 条一模一样的信号,每条都会让 renderer 拉出同一棵树。
    const { createPluginAPI, disposePlugin, drainPlugin } = await import('../api.js')
    const emitted: Emitted[] = []
    const { api, state } = createPluginAPI(
      'demo',
      stubEventBus(emitted) as never,
      {} as never,
      { declaredPanelIds: ['main', 'other'] },
    )
    cleanups.push(async () => {
      disposePlugin(state)
      await drainPlugin(state)
    })

    let panelCtx: { refresh(): void } | undefined
    api.registerWorkspacePanel({
      id: 'main',
      render: (ctx: { refresh(): void }) => {
        panelCtx = ctx
        return { version: 1, body: { type: 'markdown', text: 'x' } }
      },
    })
    let otherCtx: { refresh(): void } | undefined
    api.registerWorkspacePanel({
      id: 'other',
      render: (ctx: { refresh(): void }) => {
        otherCtx = ctx
        return { version: 1, body: { type: 'markdown', text: 'y' } }
      },
    })

    const render = (action: string) => state.requestHandlers!.get(action)!(undefined, {
      requestId: 'r',
      abortSignal: new AbortController().signal,
      progress: () => {},
    })
    await render('panel:render:main')
    await render('panel:render:other')

    const refreshes = (): Emitted[] => emitted.filter(event => event.kind === 'panel-refresh')
    emitted.length = 0

    for (let i = 0; i < 20; i += 1) panelCtx?.refresh()
    expect(refreshes()).toHaveLength(1)

    // 去重是**按面板**的,不是全局的:另一个面板的刷新不该被顺手吃掉。
    otherCtx?.refresh()
    expect(refreshes()).toHaveLength(2)
    expect(refreshes().map(event => event.panelId)).toEqual(['main', 'other'])
  })
})
