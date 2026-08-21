/**
 * R1 软隔离验收(设计文档 §3.1 / §5 R1)。
 *
 * 三条验收:
 *   1. 一个 entry 永不 resolve 的插件不阻塞其他插件加载;
 *   2. 一个挂起的 promptContextProvider 不阻塞消息发送路径(提示词装配超时后返回);
 *   3. 连续失败的插件被自动禁用,且状态可查。
 */
import { pluginScope } from '@onething/core/plugins'
import { describe, expect, it, vi } from 'vitest'
import {
  CORE_PLUGIN_FAILURE_THRESHOLD,
  CorePluginHealthTracker,
  CorePluginLifecycleRegistry,
  CorePluginManager,
  CorePluginTimeoutError,
  createCorePluginAPI,
  disposeCorePluginState,
  getPluginEnabledFromSettings,
  isCorePluginTimeoutError,
  listPluginHealthFromSettings,
  runWithPluginTimeout,
  setPluginEnabledInSettings,
  setPluginHealthInSettings,
  type CorePluginDefinition,
  type CorePluginManagerHost,
  type CorePluginStateLike,
  type PluginSettings,
} from '@onething/core/plugins'

interface TestAPI {
  registerCommand(name: string): void
}
type TestEntry = (api: TestAPI) => void | Promise<void>
type TestDefinition = CorePluginDefinition<TestEntry>
interface TestCommand { name: string }
interface TestState extends CorePluginStateLike<TestCommand> { disposed: boolean }

function silentLogger() {
  return { log: () => {}, error: () => {} }
}

function createManagerHost(definitions: TestDefinition[]) {
  const disposed: string[] = []
  const states = new Map<string, TestState>()
  const host: CorePluginManagerHost<TestDefinition, TestEntry, TestAPI, TestState, TestCommand, { ready: true }> = {
    ensurePluginDirs() {},
    scanPlugins: () => definitions,
    loadPluginEntry: async definition => definition.entry ?? null,
    createPluginAPI(pluginId) {
      const state: TestState = { commands: new Map(), disposed: false }
      states.set(pluginId, state)
      return {
        state,
        api: {
          registerCommand(name) {
            state.commands.set(name, { name })
          },
        },
      }
    },
    disposePlugin(state) {
      state.disposed = true
      for (const [id, candidate] of states) {
        if (candidate === state) disposed.push(id)
      }
    },
    setPluginEnabled() {},
  }
  return { host, disposed, states }
}

/**
 * 测试里构造任意 scope 的口子。
 *
 * 生产代码只能用 `pluginScope.*` 工厂(品牌类型),但这些用例要验的正是
 * tracker 对**任意 scope 字符串**的行为,所以在测试里显式贴一次牌。
 */
const asScope = (scope: string) => scope as never

describe('R1 soft isolation — timeout budget', () => {
  it('rejects with a timeout error instead of hanging forever', async () => {
    await expect(runWithPluginTimeout('never', 20, () => new Promise(() => {})))
      .rejects.toBeInstanceOf(CorePluginTimeoutError)
    expect(isCorePluginTimeoutError(new CorePluginTimeoutError('x', 1))).toBe(true)
  })

  it('passes results through untouched when the call is fast', async () => {
    await expect(runWithPluginTimeout('fast', 1_000, () => 'ok')).resolves.toBe('ok')
  })
})

describe('R1 soft isolation — one bad plugin does not stall the queue', () => {
  it('loads the remaining plugins when an entry never resolves', async () => {
    const definitions: TestDefinition[] = [
      {
        id: 'hanging',
        manifest: { name: 'Hanging', version: '1.0.0' },
        dirPath: '/plugins/hanging',
        entryPath: '/plugins/hanging/plugin-entry.js',
        enabled: true,
        entry: () => new Promise<void>(() => {}),
      },
      {
        id: 'healthy',
        manifest: { name: 'Healthy', version: '1.0.0' },
        dirPath: '/plugins/healthy',
        entryPath: '/plugins/healthy/plugin-entry.js',
        enabled: true,
        entry: api => {
          api.registerCommand('/healthy')
        },
      },
    ]
    const { host, disposed } = createManagerHost(definitions)
    const manager = new CorePluginManager<TestAPI, TestEntry, TestCommand, TestState, TestDefinition, { ready: true }>(
      host,
      silentLogger(),
      { entryTimeoutMs: 30 },
    )

    const started = Date.now()
    await manager.initialize({ ready: true })
    const elapsed = Date.now() - started

    const byId = new Map(manager.getPlugins().map(info => [info.definition.id, info]))
    expect(byId.get('healthy')).toMatchObject({ loaded: true, commands: ['/healthy'] })
    expect(byId.get('hanging')?.loaded).toBe(false)
    expect(byId.get('hanging')?.error).toContain('exceeded 30ms')
    // 并行加载:总耗时是最慢一个的量级,不是所有插件的总和。
    expect(elapsed).toBeLessThan(1_000)
    // 装到一半的插件要被拆干净,不能把半截足迹留在注册表里。
    expect(disposed).toContain('hanging')
    // 展示序仍是扫描序 —— 并行不许打乱它。
    expect(manager.getPlugins().map(info => info.definition.id)).toEqual(['hanging', 'healthy'])
  })

  /**
   * 顶层 await 挂住的是 `import()` 本身,不是 entry(api)。
   * 只给 entry 加预算的话,refreshPlugins 的 Promise.all 永不 settle →
   * bootstrapPluginSystem 挂死 → skills 永不初始化。
   */
  it('does not deadlock bootstrap when a plugin module never finishes importing', async () => {
    const definitions: TestDefinition[] = [
      {
        id: 'top-level-await',
        manifest: { name: 'Hanging import', version: '1.0.0' },
        dirPath: '/plugins/top-level-await',
        entryPath: '/plugins/top-level-await/plugin-entry.js',
        enabled: true,
      },
      {
        id: 'healthy',
        manifest: { name: 'Healthy', version: '1.0.0' },
        dirPath: '/plugins/healthy',
        entryPath: '/plugins/healthy/plugin-entry.js',
        enabled: true,
        entry: api => {
          api.registerCommand('/healthy')
        },
      },
    ]
    const { host } = createManagerHost(definitions)
    const manager = new CorePluginManager<TestAPI, TestEntry, TestCommand, TestState, TestDefinition, { ready: true }>(
      {
        ...host,
        // 模块永远 import 不完。
        loadPluginEntry: definition => definition.entry
          ? Promise.resolve(definition.entry)
          : new Promise<TestEntry | null>(() => {}),
      },
      silentLogger(),
      { entryTimeoutMs: 30 },
    )

    // 关键断言:这个 await 会返回。挂死的话整条测试超时。
    await manager.initialize({ ready: true })

    const byId = new Map(manager.getPlugins().map(info => [info.definition.id, info]))
    expect(byId.get('healthy')).toMatchObject({ loaded: true, commands: ['/healthy'] })
    expect(byId.get('top-level-await')?.loaded).toBe(false)
    expect(byId.get('top-level-await')?.error).toContain('exceeded 30ms')
  })

  it('reuses the in-flight refresh instead of racing a second one', async () => {
    let scans = 0
    const definitions: TestDefinition[] = [{
      id: 'demo',
      manifest: { name: 'Demo', version: '1.0.0' },
      dirPath: '/plugins/demo',
      entryPath: '/plugins/demo/plugin-entry.js',
      enabled: true,
      entry: () => new Promise<void>(resolve => setTimeout(resolve, 20)),
    }]
    const { host } = createManagerHost(definitions)
    const manager = new CorePluginManager<TestAPI, TestEntry, TestCommand, TestState, TestDefinition, { ready: true }>(
      {
        ...host,
        scanPlugins: () => {
          scans += 1
          return definitions
        },
      },
      silentLogger(),
    )
    await manager.initialize({ ready: true })
    expect(scans).toBe(1)

    // 两次并发 refresh 只应扫描一次 —— 否则同一个插件目录会被并发 npm install。
    await Promise.all([manager.refreshPlugins(), manager.refreshPlugins()])
    expect(scans).toBe(2)
  })

  it('surfaces host-provided runtime health on the plugin info', async () => {
    const definitions: TestDefinition[] = [{
      id: 'demo',
      manifest: { name: 'Demo', version: '1.0.0' },
      dirPath: '/plugins/demo',
      entryPath: '/plugins/demo/plugin-entry.js',
      enabled: true,
      entry: () => {},
    }]
    const { host } = createManagerHost(definitions)
    const manager = new CorePluginManager<TestAPI, TestEntry, TestCommand, TestState, TestDefinition, { ready: true }>(
      { ...host, getPluginHealth: () => ({ status: 'degraded', consecutiveFailures: 2, lastError: 'boom' }) },
      silentLogger(),
    )
    await manager.initialize({ ready: true })

    expect(manager.getPlugins()[0].health).toMatchObject({ status: 'degraded', consecutiveFailures: 2 })
  })
})

// promptContextProvider 的超时验收住在产品层:
// packages/onething-runtime/src/prompts/__tests__/plugin-context-timeout.test.ts

describe('R1 soft isolation — late registrations are latched out', () => {
  /**
   * 超时被拆掉的插件如果十分钟后恢复过来接着注册,那份 state 已经不在
   * pluginStates 里了 —— 注册进全局表的东西从此没有任何人能回收。
   */
  it('no-ops every registration entry point after dispose', () => {
    const registeredTools: string[] = []
    const subscribed: string[] = []
    const notified: string[] = []

    const { api, state } = createCorePluginAPI<
      {
        registerTool(tool: { name: string }): void
        on(eventType: string, handler: () => void): () => void
        registerCommand(name: string, options: object): void
        registerPromptContextProvider(id: string, provider: () => string): void
        beforeContextCompact(id: string, hook: () => void): void
        afterAssistantResponse(id: string, hook: () => void): void
        registerSkillRoot(provider: () => []): void
        onDispose(callback: () => void): void
        ui: { notify(message: string): void }
      },
      { name: string },
      () => void,
      TestCommand,
      object,
      () => string,
      () => void,
      () => void,
      () => [],
      object,
      object
    >({
      pluginId: 'late',
      store: {},
      scheduler: {},
      logger: silentLogger(),
      host: {
        registerTool: (_id, toolId) => { registeredTools.push(toolId) },
        subscribeEvent: (_id, eventType) => {
          subscribed.push(eventType)
          return () => {}
        },
        steer: () => {},
        followUp: () => {},
        notify: (_id, message) => { notified.push(message) },
        registerPromptContextProvider: () => () => {},
        registerBeforeContextCompactHook: () => () => {},
        registerAfterAssistantResponseHook: () => () => {},
        registerSkillRoot: () => () => {},
      },
    })

    api.registerTool({ name: 'before' })
    api.on('tool:result', () => {})
    expect(registeredTools).toEqual(['plugin:late:before'])
    expect(subscribed).toEqual(['tool:result'])

    disposeCorePluginState(state, { unregisterTool: () => {} })
    expect(state.disposed).toBe(true)

    // 晚到的注册一律 no-op。
    api.registerTool({ name: 'after' })
    api.on('stream:start', () => {})
    api.registerCommand('late', {})
    api.registerPromptContextProvider('late', () => 'x')
    api.beforeContextCompact('late', () => {})
    api.afterAssistantResponse('late', () => {})
    api.registerSkillRoot(() => [])
    api.onDispose(() => {})
    api.ui.notify('late')

    expect(registeredTools).toEqual(['plugin:late:before'])
    expect(subscribed).toEqual(['tool:result'])
    expect(notified).toEqual([])
    expect(state.commands.size).toBe(0)
    expect(state.toolIds).toEqual([])
    expect(state.disposeCallbacks).toEqual([])
  })
})

describe('R1 soft isolation — lifecycle hooks are budgeted', () => {
  it('times out a hanging beforeContextCompact hook and keeps going', async () => {
    const failures: string[] = []
    const registry = new CorePluginLifecycleRegistry({
      logger: { error: () => {} },
      timeoutMs: 25,
      onHookFailure: ({ pluginId, scope }) => failures.push(`${scope}:${pluginId}`),
    })
    const ran: string[] = []

    registry.registerBeforeContextCompactHook('hanging-plugin', 'stuck', () => new Promise(() => {}))
    registry.registerBeforeContextCompactHook('good-plugin', 'quick', () => {
      ran.push('good-plugin')
    })

    await registry.runBeforeContextCompactHooks({} as never)

    expect(ran).toEqual(['good-plugin'])
    expect(failures).toEqual(['beforeContextCompact:hanging-plugin'])
  })
})

describe('R1 soft isolation — failure counting circuit breaker', () => {
  it('auto-disables after consecutive failures and exposes the reason', () => {
    const tripped: Array<{ pluginId: string; reason?: string }> = []
    const tracker = new CorePluginHealthTracker({
      onTrip: (pluginId, health) => tripped.push({ pluginId, reason: health.disabledReason }),
    })

    for (let i = 0; i < CORE_PLUGIN_FAILURE_THRESHOLD - 1; i += 1) {
      tracker.recordFailure('flaky', asScope('promptContext:notes'), new Error('boom'))
    }
    expect(tracker.get('flaky')).toMatchObject({ status: 'degraded' })
    expect(tripped).toEqual([])

    tracker.recordFailure('flaky', asScope('promptContext:notes'), new Error('boom'))
    expect(tripped).toHaveLength(1)
    expect(tripped[0].pluginId).toBe('flaky')
    expect(tracker.get('flaky')).toMatchObject({
      status: 'disabled',
      consecutiveFailures: CORE_PLUGIN_FAILURE_THRESHOLD,
      lastError: 'boom',
      lastErrorScope: 'promptContext:notes',
    })
    expect(tracker.get('flaky')?.disabledReason).toContain('consecutive failures')

    // 熔断后再失败不重复触发禁用。
    tracker.recordFailure('flaky', asScope('promptContext:notes'), new Error('boom'))
    expect(tripped).toHaveLength(1)
  })

  it('counts consecutive failures only — one success in the same scope clears the tally', () => {
    const tracker = new CorePluginHealthTracker({ onTrip: () => {} })
    tracker.recordFailure('flaky', asScope('event:tool:result'), new Error('boom'))
    tracker.recordFailure('flaky', asScope('event:tool:result'), new Error('boom'))
    tracker.recordSuccess('flaky', asScope('event:tool:result'))
    expect(tracker.get('flaky')).toMatchObject({ status: 'healthy', consecutiveFailures: 0 })
  })

  // 这条是评审抓到的头号语义缺陷:计数键必须是 pluginId + scope。
  // 插件级混算的话,一个每回合都成功的 afterAssistantResponse 钩子会不停清掉
  // 同一插件里那个挂死的 promptContextProvider 的账 —— R1 的目标场景永不熔断。
  it('does not let a healthy scope clear another scope tally', () => {
    const tripped: string[] = []
    const tracker = new CorePluginHealthTracker({ onTrip: pluginId => tripped.push(pluginId) })

    for (let i = 0; i < CORE_PLUGIN_FAILURE_THRESHOLD; i += 1) {
      tracker.recordFailure('mixed', asScope('promptContext:notes'), new Error('hang'))
      // 同一插件的另一条车道每回合都成功 —— 它清不掉上面那条的账。
      tracker.recordSuccess('mixed', asScope('afterAssistantResponse:capture'))
    }

    expect(tripped).toEqual(['mixed'])
    expect(tracker.get('mixed')).toMatchObject({
      status: 'disabled',
      lastErrorScope: 'promptContext:notes',
    })
  })

  it('keeps per-scope tallies apart so a rare error in one lane never trips another', () => {
    const tripped: string[] = []
    const tracker = new CorePluginHealthTracker({ onTrip: pluginId => tripped.push(pluginId) })

    tracker.recordFailure('spread', asScope('event:a'), new Error('boom'))
    tracker.recordFailure('spread', asScope('event:b'), new Error('boom'))
    tracker.recordFailure('spread', asScope('event:c'), new Error('boom'))

    // 三条车道各败一次:插件级混算会在这里误禁,分车道则不会。
    expect(tripped).toEqual([])
    expect(tracker.get('spread')).toMatchObject({ status: 'degraded', consecutiveFailures: 1 })
  })

  it('restores a persisted disable reason without resurrecting the tally', () => {
    const tracker = new CorePluginHealthTracker({ onTrip: () => {} })
    tracker.restore('flaky', {
      status: 'disabled',
      consecutiveFailures: 0,
      lastError: 'boom',
      lastErrorScope: 'promptContext:notes',
      disabledReason: '3 consecutive failures in promptContext:notes (last: boom)',
    })
    expect(tracker.get('flaky')).toMatchObject({
      status: 'disabled',
      consecutiveFailures: 0,
      disabledReason: '3 consecutive failures in promptContext:notes (last: boom)',
    })
  })

  it('clears the breaker state on explicit re-enable', () => {
    const tracker = new CorePluginHealthTracker({ threshold: 1, onTrip: () => {} })
    tracker.recordFailure('flaky', asScope('entry'), new Error('boom'))
    expect(tracker.get('flaky')?.status).toBe('disabled')
    tracker.clear('flaky')
    expect(tracker.get('flaky')).toBeUndefined()
  })
})

describe('R1 soft isolation — app wiring', () => {
  it('auto-disables the plugin through the host port and notifies the user', async () => {
    const health = await import('../health.js')
    health.resetPluginRuntimeHealthForTests()

    const disabled: string[] = []
    const notified: string[] = []
    health.configurePluginHealthHost({
      disablePlugin: pluginId => {
        disabled.push(pluginId)
      },
      notify: (pluginId, message) => {
        notified.push(`${pluginId}:${message}`)
      },
    })

    for (let i = 0; i < CORE_PLUGIN_FAILURE_THRESHOLD; i += 1) {
      health.reportPluginRuntimeFailure('flaky', pluginScope.promptContext('notes'), new Error('boom'))
    }
    await vi.waitFor(() => expect(disabled).toEqual(['flaky']))

    expect(notified[0]).toContain('disabled automatically')
    expect(health.getPluginRuntimeHealth('flaky')).toMatchObject({ status: 'disabled' })
    expect(health.listPluginRuntimeHealth()).toHaveLength(1)

    health.clearPluginRuntimeHealth('flaky')
    expect(health.getPluginRuntimeHealth('flaky')).toBeUndefined()
    health.configurePluginHealthHost(null)
  })

  /**
   * 全链集成:真 CorePluginManager(mock 掉 loader 与 settings 存储)
   * reportPluginRuntimeFailure ×3 → 自动禁用 → plugin-settings 落 enabled:false
   * 与原因 → 重启回灌后设置页仍能说明为什么关着。
   */
  it('runs the whole breaker chain: failures → disable → settings persisted → restored after restart', async () => {
    const health = await import('../health.js')
    health.resetPluginRuntimeHealthForTests()

    // plugin-settings 的替身(真实实现是 <store>/plugin-settings.json)。
    let settings: PluginSettings = {}
    const disposedPlugins: string[] = []

    const definitions: TestDefinition[] = [{
      id: 'flaky',
      manifest: { name: 'Flaky', version: '1.0.0' },
      dirPath: '/plugins/flaky',
      entryPath: '/plugins/flaky/plugin-entry.js',
      enabled: getPluginEnabledFromSettings(settings, 'flaky'),
      entry: api => {
        api.registerCommand('/flaky')
      },
    }]

    const host: CorePluginManagerHost<TestDefinition, TestEntry, TestAPI, TestState, TestCommand, { ready: true }> = {
      ensurePluginDirs() {},
      scanPlugins: () => definitions.map(def => ({
        ...def,
        enabled: getPluginEnabledFromSettings(settings, def.id),
      })),
      loadPluginEntry: async definition => definition.entry ?? null,
      createPluginAPI() {
        const state: TestState = { commands: new Map(), disposed: false }
        return {
          state,
          api: {
            registerCommand(name) {
              state.commands.set(name, { name })
            },
          },
        }
      },
      disposePlugin(state) {
        state.disposed = true
        disposedPlugins.push('flaky')
      },
      setPluginEnabled(pluginId, enabled) {
        settings = setPluginEnabledInSettings(settings, pluginId, enabled)
      },
      getPluginHealth: health.getPluginRuntimeHealth,
    }

    const manager = new CorePluginManager<TestAPI, TestEntry, TestCommand, TestState, TestDefinition, { ready: true }>(
      host,
      silentLogger(),
    )

    health.configurePluginHealthHost({
      disablePlugin: pluginId => manager.disablePlugin(pluginId),
      notify: () => {},
      persistHealth: (pluginId, persisted) => {
        settings = setPluginHealthInSettings(settings, pluginId, persisted)
      },
      loadPersistedHealth: () => listPluginHealthFromSettings(settings),
    })

    await manager.initialize({ ready: true })
    expect(manager.getPlugins()[0]).toMatchObject({ loaded: true, commands: ['/flaky'] })

    for (let i = 0; i < CORE_PLUGIN_FAILURE_THRESHOLD; i += 1) {
      health.reportPluginRuntimeFailure('flaky', pluginScope.promptContext('notes'), new Error('provider hung'))
    }
    await vi.waitFor(() => expect(settings.enabled?.flaky).toBe(false))

    // 1) 真的被拆掉了(不是只把开关拨了一下)。
    expect(disposedPlugins).toContain('flaky')
    expect(manager.getPlugins()[0]).toMatchObject({ loaded: false, commands: [] })
    // 2) 原因随 enabled 位一起落盘。
    expect(settings.health?.flaky).toMatchObject({
      status: 'disabled',
      lastErrorScope: 'promptContext:notes',
      lastError: 'provider hung',
    })
    expect(settings.health?.flaky.disabledReason).toContain('promptContext:notes')
    // 3) 插件信息把它带给 UI。
    expect(manager.getPlugins()[0].health).toMatchObject({ status: 'disabled' })

    // 4) 重启:进程内存清空,只有 plugin-settings 留着 —— 仍要说得出原因。
    health.resetPluginRuntimeHealthForTests()
    expect(health.getPluginRuntimeHealth('flaky')).toBeUndefined()
    health.restorePluginRuntimeHealth()
    expect(health.getPluginRuntimeHealth('flaky')).toMatchObject({
      status: 'disabled',
      consecutiveFailures: 0,
    })

    // 5) 用户重新启用 = 清账,盘上也不留。
    health.clearPluginRuntimeHealth('flaky')
    expect(health.getPluginRuntimeHealth('flaky')).toBeUndefined()
    expect(settings.health?.flaky).toBeUndefined()

    health.configurePluginHealthHost(null)
  })
})
