/**
 * R5 验收:声明式面板。
 *
 * 两条裁决都在这里被钉住:
 *  1. **静态存在感走 manifest** —— 面板入口只由 `contributes.panels` 决定,
 *     `registerWorkspacePanel` 只绑定行为;id 对不上就当场拒绝。
 *  2. **UI 永不执行插件代码** —— 插件交出的是一棵纯数据描述树,函数成员当场被拒。
 *
 * 渲染与动作都跑在 R2 的统一请求通道上(action = `panel:render:<id>` /
 * `panel:action:<id>`),所以它们免费继承预算、abort 与熔断账 —— 这份验收也就
 * 打在通道上,而不是打在某个具体宿主的接线上。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  CorePluginManager,
  PLUGIN_PANEL_INVOKE_ACTION,
  PLUGIN_PANEL_PROTOCOL_VERSION,
  PLUGIN_PANEL_RENDER_ACTION,
  MAX_PANEL_DEPTH,
  createCorePluginAPI,
  describeNonSerializable,
  describePluginSurface,
  disposeCorePluginState,
  validatePluginPanelTree,
  type CorePluginDefinition,
  type CorePluginManagerHost,
  type CorePluginPanelContext,
  type CorePluginPanelRegistration,
  type CorePluginRequestHandler,
  type CorePluginStateLike,
  type PluginPanelTree,
} from '@onething/core/plugins'

interface TestAPI {
  registerWorkspacePanel(registration: CorePluginPanelRegistration): void
}
type TestEntry = (api: TestAPI) => void | Promise<void>
type TestDefinition = CorePluginDefinition<TestEntry>
interface TestCommand { name: string }
interface TestState extends CorePluginStateLike<TestCommand> {
  requestHandlers: Map<string, CorePluginRequestHandler>
  disposed?: boolean
}

function silentLogger() {
  return { log: () => {}, error: () => {} }
}

/**
 * 最小宿主 —— 与 app 层同构,但用真的 `createCorePluginAPI` 造 api,
 * 因为 `registerWorkspacePanel` 的清单校验与通道登记恰恰活在那里面。
 */
function createManager(
  definitions: TestDefinition[],
  hostOverrides: Partial<CorePluginManagerHost<TestDefinition, TestEntry, TestAPI, TestState, TestCommand, { ready: true }>> = {},
) {
  const errors: string[] = []
  const failures: Array<{ pluginId: string; scope: string }> = []
  const refreshes: Array<{ pluginId: string; panelId: string }> = []

  const host: CorePluginManagerHost<TestDefinition, TestEntry, TestAPI, TestState, TestCommand, { ready: true }> = {
    ensurePluginDirs() {},
    scanPlugins: () => definitions,
    loadPluginEntry: async definition => definition.entry ?? null,
    createPluginAPI(pluginId) {
      // 声明来自 manifest —— 与 app 层 manager 的取法逐字相同。
      const declaredPanelIds = definitions
        .find(item => item.id === pluginId)
        ?.manifest.contributes?.panels?.map(panel => panel.id) ?? []
      const created = (createCorePluginAPI as any)({
        pluginId,
        declaredPanelIds,
        scheduler: { schedule: () => {}, cancel: () => {} } as any,
        store: { get: () => undefined, set: () => {}, delete: () => {}, keys: () => [] } as any,
        host: {
          emitPanelRefresh(id: string, panelId: string) {
            refreshes.push({ pluginId: id, panelId })
          },
        } as any,
        logger: { log: () => {}, error: (message: string) => errors.push(message) },
        onPluginFailure: (input: { pluginId: string; scope: string }) =>
          failures.push({ pluginId: input.pluginId, scope: input.scope }),
      })
      // state 用 core 造的那一份 —— 通道查的就是它,自造一个只会两边对不上。
      return { state: created.state as unknown as TestState, api: created.api as unknown as TestAPI }
    },
    disposePlugin(state) {
      disposeCorePluginState(state as any)
    },
    setPluginEnabled() {},
    ...hostOverrides,
  }

  const manager = new CorePluginManager<TestAPI, TestEntry, TestCommand, TestState, TestDefinition, { ready: true }>(
    host,
    silentLogger(),
  )
  return { manager, errors, failures, refreshes }
}

function definition(id: string, entry: TestEntry, panels: Array<{ id: string; label: string }>): TestDefinition {
  return {
    id,
    manifest: { name: id, version: '1.0.0', contributes: { panels } },
    dirPath: `/plugins/${id}`,
    entryPath: `/plugins/${id}/plugin-entry.js`,
    enabled: true,
    entry,
  }
}

function simpleTree(text: string): PluginPanelTree {
  return {
    version: PLUGIN_PANEL_PROTOCOL_VERSION,
    body: {
      type: 'stack',
      children: [
        { type: 'markdown', text },
        { type: 'button', label: 'Refresh', actionId: 'refresh' },
      ],
    },
  }
}

describe('R5 declarative panels — manifest declares, code binds', () => {
  it('renders a declared panel through the unified request channel', async () => {
    const { manager } = createManager([
      definition('logs', api => {
        api.registerWorkspacePanel({ id: 'main', render: () => simpleTree('hello from the plugin') })
      }, [{ id: 'main', label: 'Logs' }]),
    ])
    await manager.initialize({ ready: true })

    const result = await manager.handleRequest({
      pluginId: 'logs',
      action: `${PLUGIN_PANEL_RENDER_ACTION}:main`,
    })

    expect(result.success).toBe(true)
    const tree = (result as { result: PluginPanelTree }).result
    expect(tree.body).toMatchObject({ type: 'stack' })
    // 两个 action 都登记在同一条通道上 —— 没有第二套投递机制。
    expect(manager.getRequestActions('logs')).toEqual(['panel:render:main', 'panel:action:main'])
  })

  it('round-trips an action: actionId + payload in, result out', async () => {
    const seen: Array<{ actionId: string; payload?: unknown }> = []
    const { manager } = createManager([
      definition('logs', api => {
        api.registerWorkspacePanel({
          id: 'main',
          render: () => simpleTree('idle'),
          onAction(input) {
            seen.push(input)
            return { refresh: true, notice: `did ${input.actionId}` }
          },
        })
      }, [{ id: 'main', label: 'Logs' }]),
    ])
    await manager.initialize({ ready: true })

    const result = await manager.handleRequest({
      pluginId: 'logs',
      action: `${PLUGIN_PANEL_INVOKE_ACTION}:main`,
      payload: { actionId: 'cleanup', payload: { days: 7 } },
    })

    expect(result).toMatchObject({ success: true, result: { refresh: true, notice: 'did cleanup' } })
    expect(seen).toEqual([{ actionId: 'cleanup', payload: { days: 7 } }])
  })

  it('pushes ctx.refresh() through the existing notification rail, not a new one', async () => {
    const { manager, refreshes } = createManager([
      definition('logs', api => {
        api.registerWorkspacePanel({
          id: 'main',
          render: (ctx: CorePluginPanelContext) => {
            // 插件在渲染之外也能调 —— 这里借渲染时机验证它接到了宿主。
            ctx.refresh()
            return simpleTree('idle')
          },
        })
      }, [{ id: 'main', label: 'Logs' }]),
    ])
    await manager.initialize({ ready: true })

    await manager.handleRequest({ pluginId: 'logs', action: `${PLUGIN_PANEL_RENDER_ACTION}:main` })

    expect(refreshes).toEqual([{ pluginId: 'logs', panelId: 'main' }])
  })

  it('rejects a panel id that no manifest declared — declaration comes first', async () => {
    const { manager, errors, failures } = createManager([
      definition('logs', api => {
        api.registerWorkspacePanel({ id: 'sneaky', render: () => simpleTree('nope') })
      }, [{ id: 'main', label: 'Logs' }]),
    ])
    await manager.initialize({ ready: true })

    expect(manager.getRequestActions('logs')).toEqual([])
    expect(errors.join('\n')).toContain('does not match any panel declared in contributes.panels')
    expect(failures).toEqual([{ pluginId: 'logs', scope: 'register:WorkspacePanel' }])
  })

  it('surfaces a render failure as a failed request instead of taking the shell down', async () => {
    const { manager } = createManager([
      definition('logs', api => {
        api.registerWorkspacePanel({
          id: 'main',
          render: () => { throw new Error('log dir vanished') },
        })
      }, [{ id: 'main', label: 'Logs' }]),
    ])
    await manager.initialize({ ready: true })

    await expect(manager.handleRequest({ pluginId: 'logs', action: `${PLUGIN_PANEL_RENDER_ACTION}:main` }))
      .resolves.toMatchObject({ success: false, error: expect.stringContaining('log dir vanished') })
  })

  it('rejects a tree carrying a function member — closures cannot cross the line', async () => {
    const { manager } = createManager([
      definition('logs', api => {
        api.registerWorkspacePanel({
          id: 'main',
          render: () => ({
            version: PLUGIN_PANEL_PROTOCOL_VERSION,
            // 插件想塞回调:IPC 上它会被静默丢弃,用户点了毫无反应 —— 当场拒掉。
            body: { type: 'button', label: 'Go', actionId: 'go', onClick: () => {} },
          }) as unknown as PluginPanelTree,
        })
      }, [{ id: 'main', label: 'Logs' }]),
    ])
    await manager.initialize({ ready: true })

    await expect(manager.handleRequest({ pluginId: 'logs', action: `${PLUGIN_PANEL_RENDER_ACTION}:main` }))
      .resolves.toMatchObject({ success: false, error: expect.stringContaining('onClick is a function') })
  })

  it('rejects a function buried deeper than the request channel scans', async () => {
    // 关键用例:list 的 items 恰好落在请求通道默认深度(4)之外。
    // 面板校验必须自己扫得更深,否则 "禁函数成员" 只覆盖最外两层节点 ——
    // 而 `items[].payload` 正是插件最常放东西的地方。
    const deep = {
      version: PLUGIN_PANEL_PROTOCOL_VERSION,
      body: {
        type: 'stack',
        children: [{
          type: 'list',
          items: [{ id: 'a', title: 'A', payload: { nested: { onPick: () => {} } } }],
        }],
      },
    } as unknown as PluginPanelTree

    // 先证明"通道那道浅校验确实漏了它" —— 否则这条用例可能是被别的守卫顺手挡下的。
    expect(describeNonSerializable(deep, 'tree')).toBeNull()
    expect(validatePluginPanelTree(deep)).toContain('is a function')

    const { manager } = createManager([
      definition('logs', api => {
        api.registerWorkspacePanel({ id: 'main', render: () => deep })
      }, [{ id: 'main', label: 'Logs' }]),
    ])
    await manager.initialize({ ready: true })

    await expect(manager.handleRequest({ pluginId: 'logs', action: `${PLUGIN_PANEL_RENDER_ACTION}:main` }))
      .resolves.toMatchObject({ success: false, error: expect.stringContaining('is a function') })
  })

  it('caps nesting at 12 levels so a runaway tree fails loudly instead of hanging the renderer', () => {
    const build = (levels: number): PluginPanelTree => {
      let node: Record<string, unknown> = { type: 'markdown', text: 'leaf' }
      for (let i = 0; i < levels; i += 1) node = { type: 'stack', children: [node] }
      return { version: PLUGIN_PANEL_PROTOCOL_VERSION, body: node as never }
    }
    expect(MAX_PANEL_DEPTH).toBe(12)
    expect(validatePluginPanelTree(build(MAX_PANEL_DEPTH))).toBeNull()
    expect(validatePluginPanelTree(build(MAX_PANEL_DEPTH + 1))).toContain('nested deeper than 12 levels')
  })

  it('validates the action result too: notice must be a string, refresh a boolean', async () => {
    const { manager } = createManager([
      definition('logs', api => {
        api.registerWorkspacePanel({
          id: 'main',
          render: () => simpleTree('idle'),
          // notice 直接进 toast —— 传个对象过去用户会看到 "[object Object]"。
          onAction: () => ({ refresh: true, notice: { text: 'nope' } }) as never,
        })
      }, [{ id: 'main', label: 'Logs' }]),
    ])
    await manager.initialize({ ready: true })

    await expect(manager.handleRequest({
      pluginId: 'logs',
      action: `${PLUGIN_PANEL_INVOKE_ACTION}:main`,
      payload: { actionId: 'go' },
    })).resolves.toMatchObject({ success: false, error: expect.stringContaining('"notice" must be a string') })
  })

  it('reserves the panel: namespace — a plugin cannot shadow the host wrapper', async () => {
    const { manager, errors, failures } = createManager([
      definition('logs', api => {
        api.registerWorkspacePanel({ id: 'main', render: () => simpleTree('real') })
        // 直接登记同名 action:不挡的话它会顶掉宿主装好的那层,
        // 而它的返回值不经过任何校验就直通 renderer。
        ;(api as unknown as { registerRequestHandler(action: string, handler: unknown): void })
          .registerRequestHandler(`${PLUGIN_PANEL_RENDER_ACTION}:main`, () => ({ hijacked: true }))
      }, [{ id: 'main', label: 'Logs' }]),
    ])
    await manager.initialize({ ready: true })

    expect(errors.join('\n')).toContain('action namespace')
    expect(errors.join('\n')).toContain('belong to the host')
    expect(failures).toContainEqual({ pluginId: 'logs', scope: 'register:RequestHandler' })

    const result = await manager.handleRequest({ pluginId: 'logs', action: `${PLUGIN_PANEL_RENDER_ACTION}:main` })
    expect(result).toMatchObject({ success: true })
    expect(JSON.stringify((result as { result: unknown }).result)).toContain('real')
  })

  it('refuses a second registration of the same panel id instead of silently replacing it', async () => {
    const { manager, errors, failures } = createManager([
      definition('logs', api => {
        api.registerWorkspacePanel({ id: 'main', render: () => simpleTree('first') })
        api.registerWorkspacePanel({ id: 'main', render: () => simpleTree('second') })
      }, [{ id: 'main', label: 'Logs' }]),
    ])
    await manager.initialize({ ready: true })

    expect(errors.join('\n')).toContain('was already registered')
    expect(failures).toContainEqual({ pluginId: 'logs', scope: 'register:WorkspacePanel' })
    const result = await manager.handleRequest({ pluginId: 'logs', action: `${PLUGIN_PANEL_RENDER_ACTION}:main` })
    expect(JSON.stringify((result as { result: unknown }).result)).toContain('first')
  })

  it('validates the tree shape: buttons address actions by id, not by callback', () => {
    expect(validatePluginPanelTree(simpleTree('ok'))).toBeNull()
    expect(validatePluginPanelTree({
      version: PLUGIN_PANEL_PROTOCOL_VERSION,
      body: { type: 'button', label: 'Go' },
    })).toContain('actionId')
    expect(validatePluginPanelTree({
      version: PLUGIN_PANEL_PROTOCOL_VERSION + 1,
      body: { type: 'markdown', text: 'x' },
    })).toContain('newer than this host supports')
  })

  it('a second plugin adds a panel without any host file learning its name', async () => {
    // 宿主侧没有任何"面板名单":加一个面板 = 改插件的 plugin.json + 一行注册。
    const { manager } = createManager([
      definition('logs', api => {
        api.registerWorkspacePanel({ id: 'main', render: () => simpleTree('logs') })
      }, [{ id: 'main', label: 'Logs' }]),
      definition('notes', api => {
        api.registerWorkspacePanel({ id: 'inbox', render: () => simpleTree('notes') })
        api.registerWorkspacePanel({ id: 'archive', render: () => simpleTree('old notes') })
      }, [{ id: 'inbox', label: 'Inbox' }, { id: 'archive', label: 'Archive' }]),
    ])
    await manager.initialize({ ready: true })

    expect(manager.getRequestActions('notes')).toEqual([
      'panel:render:inbox',
      'panel:action:inbox',
      'panel:render:archive',
      'panel:action:archive',
    ])
    await expect(manager.handleRequest({ pluginId: 'notes', action: `${PLUGIN_PANEL_RENDER_ACTION}:archive` }))
      .resolves.toMatchObject({ success: true })
  })

  it('drops panel handlers when the plugin is disposed', async () => {
    const { manager } = createManager([
      definition('logs', api => {
        api.registerWorkspacePanel({ id: 'main', render: () => simpleTree('logs') })
      }, [{ id: 'main', label: 'Logs' }]),
    ])
    await manager.initialize({ ready: true })
    expect(manager.getRequestActions('logs')).toHaveLength(2)

    await manager.disablePlugin('logs')

    await expect(manager.handleRequest({ pluginId: 'logs', action: `${PLUGIN_PANEL_RENDER_ACTION}:main` }))
      .resolves.toMatchObject({ success: false })
  })
})

describe('R7 degradation gate — 降级必须有牙齿', () => {
  it('short-circuits the channel once a surface is degraded, and says why', async () => {
    /*
     * **这是"降级"这个罚则的全部牙齿。**
     *
     * 没有短路的话,把 request:* 从 disable-plugin 改成 degrade-surface 的净效果
     * 就是取消了这个命名空间的熔断:必败的面板 action 照常一次次进插件、一次次
     * 跑满 30s 预算,用户只看到一个徽章。§5.2 第 1 条把请求通道纳入熔断账的理由
     * 正是"UI 轮询必败 action 会无限连败"。
     */
    let calls = 0
    const degradedSurfaces = new Set<string>()
    const { manager } = createManager([
      definition('logs', api => {
        api.registerWorkspacePanel({
          id: 'main',
          render: () => { calls += 1; throw new Error('always broken') },
        })
      }, [{ id: 'main', label: 'Logs' }]),
    ], {
      isSurfaceDegraded: (_pluginId: string, surface: string) => degradedSurfaces.has(surface),
      describeDegradedSurface: () => '3 consecutive failures',
      onRequestFailure: (_pluginId: string, scope: string) => {
        // 模拟熔断账:第三次失败把 surface 标红。
        if (calls >= 3) degradedSurfaces.add(describePluginSurface(scope))
      },
    })
    await manager.initialize({ ready: true })

    const render = () => manager.handleRequest({ pluginId: 'logs', action: `${PLUGIN_PANEL_RENDER_ACTION}:main` })
    for (let i = 0; i < 3; i += 1) await render()
    expect(calls).toBe(3)

    // 第四次:插件**根本没被调用**。
    const blocked = await render()
    expect(calls).toBe(3)
    expect(blocked).toMatchObject({ success: false, degraded: true, surface: 'panel:main' })
    expect((blocked as { error: string }).error).toContain('3 consecutive failures')
  })

  it('lets an explicit user retry through the gate exactly once', async () => {
    let calls = 0
    const { manager } = createManager([
      definition('logs', api => {
        api.registerWorkspacePanel({ id: 'main', render: () => { calls += 1; return simpleTree('back') } })
      }, [{ id: 'main', label: 'Logs' }]),
    ], {
      isSurfaceDegraded: () => true,
      describeDegradedSurface: () => 'broken',
    })
    await manager.initialize({ ready: true })

    // 普通调用被挡。
    await expect(manager.handleRequest({ pluginId: 'logs', action: `${PLUGIN_PANEL_RENDER_ACTION}:main` }))
      .resolves.toMatchObject({ degraded: true })
    expect(calls).toBe(0)

    // 用户点"Try once more":放行**这一次**。成功之后 recordSuccess 会把界面放回来
    // (那一段在 CorePluginHealthTracker 的用例里钉着)。
    const retried = await manager.handleRequest({
      pluginId: 'logs',
      action: `${PLUGIN_PANEL_RENDER_ACTION}:main`,
      bypassDegraded: true,
    })
    expect(retried).toMatchObject({ success: true })
    expect(calls).toBe(1)
  })

  it('leaves a healthy surface of the same plugin untouched', async () => {
    const { manager } = createManager([
      definition('notes', api => {
        api.registerWorkspacePanel({ id: 'inbox', render: () => simpleTree('inbox') })
        api.registerWorkspacePanel({ id: 'archive', render: () => simpleTree('archive') })
      }, [{ id: 'inbox', label: 'Inbox' }, { id: 'archive', label: 'Archive' }]),
    ], {
      isSurfaceDegraded: (_pluginId: string, surface: string) => surface === 'panel:inbox',
    })
    await manager.initialize({ ready: true })

    await expect(manager.handleRequest({ pluginId: 'notes', action: `${PLUGIN_PANEL_RENDER_ACTION}:inbox` }))
      .resolves.toMatchObject({ degraded: true })
    // 同一个插件的另一个面板照常 —— 降级的粒度是界面,不是插件。
    await expect(manager.handleRequest({ pluginId: 'notes', action: `${PLUGIN_PANEL_RENDER_ACTION}:archive` }))
      .resolves.toMatchObject({ success: true })
  })
})

describe('R5 declarative panels — the log-monitor demo', () => {
  it('declares its panel in the manifest — the entry needs no plugin code', async () => {
    const { ONETHING_LOG_MONITOR_MANIFEST } = await import('@onething/runtime/plugins')
    expect(ONETHING_LOG_MONITOR_MANIFEST.contributes.panels).toEqual([
      { id: 'logs', label: 'Agent logs' },
    ])
  })

  it('builds a real tree and round-trips its actions using only plugin APIs', async () => {
    const { registerOnethingLogMonitorPanel } = await import('@onething/runtime/plugins')

    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-panel-'))
    fs.writeFileSync(path.join(logDir, 'agent-2026-08-07.log'), 'line one\nline two\n')
    fs.writeFileSync(path.join(logDir, 'agent-2026-08-06.log'), 'older\n')
    // 非日志文件不该混进列表。
    fs.writeFileSync(path.join(logDir, 'notes.txt'), 'ignore me')

    const cleanupOldLogs = vi.fn()
    const registered: CorePluginPanelRegistration[] = []

    try {
      registerOnethingLogMonitorPanel(
        { registerWorkspacePanel: (registration: any) => registered.push(registration) } as any,
        {
          logDir,
          readConfig: () => ({ retentionDays: 7, flushIntervalMs: 1000, notifyOnErrors: true }),
          runtime: {
            buffer: { size: 3, clear: () => 3 },
            diskWriter: { cleanupOldLogs },
          } as any,
        },
      )

      expect(registered).toHaveLength(1)
      expect(registered[0].id).toBe('logs')

      const ctx: CorePluginPanelContext = {
        requestId: 'req-1',
        abortSignal: new AbortController().signal,
        refresh: () => {},
      }

      const tree = await registered[0].render(ctx)
      // 示范插件同样要过守卫,不享受特权。
      expect(validatePluginPanelTree(tree)).toBeNull()
      const rendered = JSON.stringify(tree)
      expect(rendered).toContain('agent-2026-08-07.log')
      expect(rendered).toContain('agent-2026-08-06.log')
      expect(rendered).not.toContain('notes.txt')

      // 选中一个文件 → 重渲染时多出尾部预览(状态活在插件里,宿主不知情)。
      await registered[0].onAction?.({ actionId: 'select-file', payload: { name: 'agent-2026-08-07.log' } }, ctx)
      const selected = await registered[0].render(ctx)
      expect(validatePluginPanelTree(selected)).toBeNull()
      expect(JSON.stringify(selected)).toContain('line two')

      // 日志里出现 ``` 会把 markdown 的代码围栏提前关掉,后面的内容当正文渲染 ——
      // 围栏长度必须让开内容里最长的那串反引号。
      fs.writeFileSync(path.join(logDir, 'agent-2026-08-05.log'), 'before\n```\nafter\n')
      await registered[0].onAction?.({ actionId: 'select-file', payload: { name: 'agent-2026-08-05.log' } }, ctx)
      const fenced = await registered[0].render(ctx)
      expect(validatePluginPanelTree(fenced)).toBeNull()
      const markdown = JSON.stringify(fenced)
      expect(markdown).toContain('````')
      // 回到原来选中的文件,后面的断言不受影响。
      await registered[0].onAction?.({ actionId: 'select-file', payload: { name: 'agent-2026-08-05.log' } }, ctx)

      const cleaned = await registered[0].onAction?.({ actionId: 'cleanup' }, ctx)
      expect(cleanupOldLogs).toHaveBeenCalledTimes(1)
      expect(cleaned).toMatchObject({ refresh: true })

      // payload 来自渲染进程,是**不可信输入**。不复核的话
      // `path.join(logDir, '../../../.ssh/id_rsa')` 会把任意文件读进面板 ——
      // 一个只读日志的插件变成任意文件读取。
      const escaped = await registered[0].onAction?.(
        { actionId: 'select-file', payload: { name: '../../../etc/passwd' } },
        ctx,
      )
      expect(escaped).toMatchObject({ notice: 'That is not a log file.' })
      const afterEscape = await registered[0].render(ctx)
      expect(JSON.stringify(afterEscape)).not.toContain('passwd')
      // 非日志文件同样进不来(它压根不在列表里,但 payload 可以硬塞)。
      await registered[0].onAction?.({ actionId: 'select-file', payload: { name: 'notes.txt' } }, ctx)
      expect(JSON.stringify(await registered[0].render(ctx))).not.toContain('ignore me')
    } finally {
      fs.rmSync(logDir, { recursive: true, force: true })
    }
  })
})
