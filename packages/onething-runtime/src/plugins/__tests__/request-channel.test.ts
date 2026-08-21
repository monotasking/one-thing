/**
 * R2 验收:统一请求通道 / manifest contributes / minAppVersion / 自定义事件 /
 * 热重载 / 携带项(scheduler 闩、enable-disable 串行化)。
 *
 * 通道的分发与序列化语义全在 core,所以验收也打在 core 上 —— @main 与 http 只是
 * 薄接线,把它们拉进来只会让测试变慢而不会多证明什么。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  CorePluginManager,
  PLUGIN_REQUEST_ABORTED_ERROR,
  buildPluginEntryImportSpecifier,
  checkPluginMinAppVersion,
  compareCoreSemver,
  createCorePluginAPI,
  createScopedPluginScheduler,
  describeNonSerializable,
  disposeCorePluginState,
  parsePluginDirectory,
  validatePluginContributes,
  type CorePluginDefinition,
  type CorePluginManagerHost,
  type CorePluginRequestContext,
  type CorePluginRequestHandler,
  type CorePluginStateLike,
} from '@onething/core/plugins'

interface TestAPI {
  registerRequestHandler(action: string, handler: CorePluginRequestHandler): void
  events: { emit(name: string, payload?: unknown): void }
  registerCommand(name: string): void
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
 * 一个把 api 的请求登记口接到 state 上的最小宿主 —— 与真 app 层同构,
 * 只是省掉了 store/scheduler/EventBus。
 */
function createManager(
  definitions: TestDefinition[],
  overrides: Partial<CorePluginManagerHost<TestDefinition, TestEntry, TestAPI, TestState, TestCommand, { ready: true }>> = {},
) {
  const emitted: Array<{ pluginId: string; name: string; payload: unknown }> = []
  const host: CorePluginManagerHost<TestDefinition, TestEntry, TestAPI, TestState, TestCommand, { ready: true }> = {
    ensurePluginDirs() {},
    scanPlugins: () => definitions,
    loadPluginEntry: async definition => definition.entry ?? null,
    createPluginAPI(pluginId) {
      const state: TestState = { commands: new Map(), requestHandlers: new Map() }
      return {
        state,
        api: {
          registerRequestHandler(action, handler) {
            if (state.disposed) return
            state.requestHandlers.set(action, handler)
          },
          events: {
            emit(name, payload) {
              if (state.disposed) return
              emitted.push({ pluginId, name, payload })
            },
          },
          registerCommand(name) {
            state.commands.set(name, { name })
          },
        },
      }
    },
    disposePlugin(state) {
      state.disposed = true
      state.requestHandlers.clear()
      state.commands.clear()
    },
    setPluginEnabled() {},
    ...overrides,
  }
  const manager = new CorePluginManager<TestAPI, TestEntry, TestCommand, TestState, TestDefinition, { ready: true }>(
    host,
    silentLogger(),
  )
  return { manager, emitted }
}

function definition(id: string, entry: TestEntry, extra: Partial<TestDefinition> = {}): TestDefinition {
  return {
    id,
    manifest: { name: id, version: '1.0.0' },
    dirPath: `/plugins/${id}`,
    entryPath: `/plugins/${id}/plugin-entry.js`,
    enabled: true,
    entry,
    ...extra,
  }
}

describe('R2 request channel — round trip', () => {
  it('dispatches by pluginId + action and returns the handler result', async () => {
    const { manager } = createManager([definition('echo', api => {
      api.registerRequestHandler('greet', (payload: any) => ({ hello: payload?.name, at: 'plugin' }))
    })])
    await manager.initialize({ ready: true })

    await expect(manager.handleRequest({ pluginId: 'echo', action: 'greet', payload: { name: 'yi' } }))
      .resolves.toMatchObject({ success: true, result: { hello: 'yi', at: 'plugin' } })

    expect(manager.getRequestActions('echo')).toEqual(['greet'])
  })

  it('reports unknown plugin and unknown action distinctly', async () => {
    const { manager } = createManager([definition('echo', api => {
      api.registerRequestHandler('greet', () => 'ok')
    })])
    await manager.initialize({ ready: true })

    await expect(manager.handleRequest({ pluginId: 'nope', action: 'greet' }))
      .resolves.toMatchObject({ success: false, error: expect.stringContaining('Unknown plugin') })
    await expect(manager.handleRequest({ pluginId: 'echo', action: 'nope' }))
      .resolves.toMatchObject({ success: false, error: expect.stringContaining('no request handler') })
  })

  it('delivers progress with the requestId that addressed the call', async () => {
    const { manager } = createManager([definition('worker', api => {
      api.registerRequestHandler('run', async (_payload, ctx: CorePluginRequestContext) => {
        ctx.progress({ step: 1 })
        ctx.progress({ step: 2 })
        return { done: true }
      })
    })])
    await manager.initialize({ ready: true })

    const progress: unknown[] = []
    const result = await manager.handleRequest({
      pluginId: 'worker',
      action: 'run',
      requestId: 'req-1',
      onProgress: input => progress.push(input),
    })

    expect(result).toMatchObject({ success: true, result: { done: true } })
    expect(progress).toEqual([
      { requestId: 'req-1', pluginId: 'worker', action: 'run', payload: { step: 1 } },
      { requestId: 'req-1', pluginId: 'worker', action: 'run', payload: { step: 2 } },
    ])
  })

  it('aborts a running handler: ctx.abortSignal fires and the caller gets an aborted result', async () => {
    let sawAbort = false
    const { manager } = createManager([definition('slow', api => {
      api.registerRequestHandler('wait', (_payload, ctx: CorePluginRequestContext) => new Promise(resolve => {
        ctx.abortSignal.addEventListener('abort', () => {
          sawAbort = true
          resolve('stopped early')
        })
      }))
    })])
    await manager.initialize({ ready: true })

    const pending = manager.handleRequest({ pluginId: 'slow', action: 'wait', requestId: 'req-abort' })
    // 让 handler 先跑起来再撤销。
    await Promise.resolve()
    expect(manager.abortRequest('req-abort')).toBe(true)

    await expect(pending).resolves.toEqual({
      success: false,
      requestId: 'req-abort',
      error: PLUGIN_REQUEST_ABORTED_ERROR,
      aborted: true,
    })
    expect(sawAbort).toBe(true)
    // 撤销一个不存在的 requestId 是 false,不是抛。
    expect(manager.abortRequest('req-abort')).toBe(false)
  })

  it('aborts the plugin in-flight requests when it is disabled', async () => {
    let sawAbort = false
    const { manager } = createManager([definition('slow', api => {
      api.registerRequestHandler('wait', (_payload, ctx: CorePluginRequestContext) => new Promise(resolve => {
        ctx.abortSignal.addEventListener('abort', () => {
          sawAbort = true
          resolve(null)
        })
      }))
    })])
    await manager.initialize({ ready: true })

    const pending = manager.handleRequest({ pluginId: 'slow', action: 'wait' })
    await Promise.resolve()
    await manager.disablePlugin('slow')

    await expect(pending).resolves.toMatchObject({ aborted: true })
    expect(sawAbort).toBe(true)
  })

  it('refuses non-serializable payloads and results at the boundary', async () => {
    const { manager } = createManager([definition('leaky', api => {
      api.registerRequestHandler('fn', () => ({ callback: () => 'nope' }))
      api.registerRequestHandler('ok', () => ({ fine: true }))
    })])
    await manager.initialize({ ready: true })

    await expect(manager.handleRequest({ pluginId: 'leaky', action: 'ok', payload: { fn: () => {} } }))
      .resolves.toMatchObject({ success: false, error: expect.stringContaining('JSON-serializable') })
    await expect(manager.handleRequest({ pluginId: 'leaky', action: 'fn' }))
      .resolves.toMatchObject({ success: false, error: expect.stringContaining('JSON-serializable') })
    await expect(manager.handleRequest({ pluginId: 'leaky', action: 'ok' }))
      .resolves.toMatchObject({ success: true })
  })

  it('describes the shapes that cannot cross the line', () => {
    expect(describeNonSerializable({ a: 1, b: 'x', c: [1, 2] })).toBeNull()
    expect(describeNonSerializable({ fn: () => {} })).toContain('function')
    expect(describeNonSerializable({ m: new Map() })).toContain('Map')
    expect(describeNonSerializable({ s: new Set() })).toContain('Set')
    expect(describeNonSerializable(new (class Thing {})())).toContain('class instance')
  })
})

describe('R2 review fixes — requestId / hang / health / teardown', () => {
  it('refuses a second request that reuses an in-flight requestId', async () => {
    const { manager } = createManager([definition('slow', api => {
      api.registerRequestHandler('wait', (_p, ctx: CorePluginRequestContext) => new Promise(resolve => {
        ctx.abortSignal.addEventListener('abort', () => resolve(null))
      }))
    })])
    await manager.initialize({ ready: true })

    const first = manager.handleRequest({ pluginId: 'slow', action: 'wait', requestId: 'dup' })
    await Promise.resolve()
    // 撞号必须被拒:Map.set 静默覆盖会让第一条的 AbortController 失联,
    // 而先 settle 的一方会把另一条的登记也删掉。
    await expect(manager.handleRequest({ pluginId: 'slow', action: 'wait', requestId: 'dup' }))
      .resolves.toMatchObject({ success: false, error: expect.stringContaining('already in flight') })

    manager.abortRequest('dup')
    await expect(first).resolves.toMatchObject({ aborted: true })
  })

  it('generates unique ids for same-tick concurrent requests and returns them to the caller', async () => {
    const { manager } = createManager([definition('echo', api => {
      api.registerRequestHandler('id', (_p, ctx: CorePluginRequestContext) => ctx.requestId)
    })])
    await manager.initialize({ ready: true })

    const results = await Promise.all(
      Array.from({ length: 20 }, () => manager.handleRequest({ pluginId: 'echo', action: 'id' })),
    )
    const ids = results.map(result => result.requestId)
    // 回传的 id 就是 handler 看到的那个,而且 20 个同 tick 请求两两不同。
    expect(new Set(ids).size).toBe(20)
    for (const result of results) {
      expect(result).toMatchObject({ success: true, result: result.requestId })
    }
  })

  it('returns a timeout result when the handler ignores abortSignal and never settles', async () => {
    const { manager } = createManager(
      [definition('stubborn', api => {
        api.registerRequestHandler('hang', () => new Promise(() => {}))
      })],
    )
    ;(manager as unknown as { options: { requestTimeoutMs: number } }).options.requestTimeoutMs = 25
    await manager.initialize({ ready: true })

    // 关键断言:这个 await 会返回。无条件 await handler 的话 renderer 的 invoke
    // 永远 pending,登记簿条目也永久滞留。
    const result = await manager.handleRequest({ pluginId: 'stubborn', action: 'hang' })
    expect(result).toMatchObject({
      success: false,
      timedOut: true,
      error: expect.stringContaining('exceeded 25ms'),
    })
    // 登记必须已经注销,不能因为 handler 还在跑就滞留。
    expect(manager.abortRequest(result.requestId)).toBe(false)
  })

  it('feeds request failures and successes into the R1 breaker ledger', async () => {
    const failures: Array<{ pluginId: string; scope: string }> = []
    const successes: Array<{ pluginId: string; scope: string }> = []
    const { manager } = createManager([definition('flaky', api => {
      api.registerRequestHandler('boom', () => {
        throw new Error('handler exploded')
      })
      api.registerRequestHandler('fine', () => 'ok')
    })], {
      onRequestFailure: (pluginId, scope) => failures.push({ pluginId, scope }),
      onRequestSuccess: (pluginId, scope) => successes.push({ pluginId, scope }),
    })
    await manager.initialize({ ready: true })

    await manager.handleRequest({ pluginId: 'flaky', action: 'boom' })
    await manager.handleRequest({ pluginId: 'flaky', action: 'fine' })

    // scope 按 action 分车道,与 promptContext / 生命周期钩子各记各的账。
    expect(failures).toEqual([{ pluginId: 'flaky', scope: 'request:boom' }])
    expect(successes).toEqual([{ pluginId: 'flaky', scope: 'request:fine' }])
  })

  it('drops progress emitted after the request was aborted', async () => {
    let emitAfterAbort: (() => void) | undefined
    const { manager } = createManager([definition('chatty', api => {
      api.registerRequestHandler('run', (_p, ctx: CorePluginRequestContext) => new Promise(resolve => {
        ctx.progress({ step: 'before' })
        emitAfterAbort = () => {
          ctx.progress({ step: 'after' })
          resolve('done')
        }
      }))
    })])
    await manager.initialize({ ready: true })

    const progress: Array<{ payload: unknown }> = []
    const pending = manager.handleRequest({
      pluginId: 'chatty',
      action: 'run',
      requestId: 'req-progress',
      onProgress: input => progress.push({ payload: input.payload }),
    })
    await Promise.resolve()
    manager.abortRequest('req-progress')
    emitAfterAbort?.()

    await expect(pending).resolves.toMatchObject({ aborted: true })
    // abort 之后的 progress 不许再投:调用方那边已经收到终局结果了。
    expect(progress).toEqual([{ payload: { step: 'before' } }])
  })

  it('aborts in-flight requests on refresh and shutdown, not only on disable', async () => {
    let aborts = 0
    const { manager } = createManager([definition('slow', api => {
      api.registerRequestHandler('wait', (_p, ctx: CorePluginRequestContext) => new Promise(resolve => {
        ctx.abortSignal.addEventListener('abort', () => {
          aborts += 1
          resolve(null)
        })
      }))
    })])
    await manager.initialize({ ready: true })

    const pending = manager.handleRequest({ pluginId: 'slow', action: 'wait' })
    await Promise.resolve()
    await manager.refreshPlugins()

    await expect(pending).resolves.toMatchObject({ aborted: true })
    expect(aborts).toBe(1)
  })

  it('keeps the declaration-level block reason visible after a manual disable', async () => {
    const blocked = definition('blocked', () => {}, {
      loadBlockedReason: 'requires app >= 99.0.0 (current 1.1.0)',
    })
    const { manager } = createManager([blocked])
    await manager.initialize({ ready: true })
    expect(manager.getPlugins()[0].error).toContain('requires app >= 99.0.0')

    await manager.disablePlugin('blocked')
    // 阻断原因不是"上一次运行的错误",而是它当前为什么装不上 —— 不该被停用抹掉。
    expect(manager.getPlugins()[0].error).toContain('requires app >= 99.0.0')
  })

  it('does not resurrect a plugin disabled while a refresh was in flight', async () => {
    let releaseLoad: (() => void) | undefined
    const gate = new Promise<void>(resolve => {
      releaseLoad = resolve
    })
    const def = definition('racy', () => {})
    const { manager } = createManager([def], {
      loadPluginEntry: async definitionInput => {
        await gate
        return definitionInput.entry ?? null
      },
    })

    const refreshing = manager.initialize({ ready: true })
    await Promise.resolve()
    await manager.disablePlugin('racy')
    releaseLoad?.()
    await refreshing

    const info = manager.getPlugins()[0]
    // 这一轮 refresh 期间用户把它关了:落表前复查,不能得到 enabled=false 却
    // loaded=true 的插件。
    expect(info.definition.enabled).toBe(false)
    expect(info.loaded).toBe(false)
  })
})

describe('R2 custom events', () => {
  it('namespaces emitted events and no-ops after dispose', async () => {
    const { manager, emitted } = createManager([definition('notes', api => {
      api.registerRequestHandler('ping', () => {
        api.events.emit('pinged', { at: 1 })
        return 'ok'
      })
    })])
    await manager.initialize({ ready: true })

    await manager.handleRequest({ pluginId: 'notes', action: 'ping' })
    expect(emitted).toEqual([{ pluginId: 'notes', name: 'pinged', payload: { at: 1 } }])

    await manager.disablePlugin('notes')
    // 拆除之后再调 —— 插件已经不在活状态,请求本身就被拒。
    await expect(manager.handleRequest({ pluginId: 'notes', action: 'ping' }))
      .resolves.toMatchObject({ success: false })
    expect(emitted).toHaveLength(1)
  })

  it('rejects non-serializable event payloads and latches out after dispose', () => {
    const emitted: Array<{ name: string; payload: unknown }> = []
    const { api, state } = createCorePluginAPI<
      {
        events: { emit(name: string, payload?: unknown): void }
        registerRequestHandler(action: string, handler: CorePluginRequestHandler): void
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
      pluginId: 'evented',
      store: {},
      scheduler: {},
      logger: silentLogger(),
      host: {
        registerTool: () => {},
        subscribeEvent: () => () => {},
        steer: () => {},
        followUp: () => {},
        notify: () => {},
        registerPromptContextProvider: () => () => {},
        registerBeforeContextCompactHook: () => () => {},
        registerAfterAssistantResponseHook: () => () => {},
        registerSkillRoot: () => () => {},
        emitPluginEvent: (_id, name, payload) => emitted.push({ name, payload }),
      },
    })

    api.events.emit('ok', { a: 1 })
    api.events.emit('bad', { fn: () => {} })
    expect(emitted).toEqual([{ name: 'ok', payload: { a: 1 } }])

    api.registerRequestHandler('before', () => 'x')
    expect(state.requestHandlers.size).toBe(1)

    disposeCorePluginState(state)
    api.events.emit('after-dispose', { a: 2 })
    api.registerRequestHandler('after', () => 'y')
    expect(emitted).toHaveLength(1)
    expect(state.requestHandlers.size).toBe(0)
  })
})

describe('R2 manifest contributes', () => {
  it('accepts a well-formed contributes block', () => {
    expect(validatePluginContributes(undefined)).toBeNull()
    expect(validatePluginContributes({
      commands: [{ name: '/notes', description: 'x' }],
      panels: [{ id: 'notes', label: 'Notes' }],
      settings: { title: 'Notes', schema: { type: 'object' } },
      permissions: ['files:read'],
      activation: { events: ['onCommand:/notes'] },
    })).toBeNull()
  })

  it('names the offending field for every malformed shape', () => {
    expect(validatePluginContributes('nope')).toContain('must be an object')
    expect(validatePluginContributes({ commands: {} })).toContain('commands must be an array')
    expect(validatePluginContributes({ commands: [{}] })).toContain('commands[0].name')
    expect(validatePluginContributes({ panels: [{ id: 'x' }] })).toContain('panels[0].label')
    expect(validatePluginContributes({ settings: { schema: 'x' } })).toContain('JSON Schema')
    expect(validatePluginContributes({ permissions: [1] })).toContain('array of strings')
    expect(validatePluginContributes({ activation: { events: 'x' } })).toContain('array of strings')
  })

  it('puts a plugin with invalid contributes into error state without running its code', async () => {
    let ran = false
    const blocked = definition('bad-manifest', () => {
      ran = true
    }, { loadBlockedReason: 'invalid plugin.json: contributes must be an object' })

    const { manager } = createManager([blocked])
    await manager.initialize({ ready: true })

    expect(ran).toBe(false)
    expect(manager.getPlugins()[0]).toMatchObject({
      loaded: false,
      error: 'invalid plugin.json: contributes must be an object',
    })
  })

  it('parses contributes off disk and drops the illegal block instead of the plugin', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-contributes-'))
    try {
      const good = path.join(root, 'good')
      fs.mkdirSync(good, { recursive: true })
      fs.writeFileSync(path.join(good, 'plugin.json'), JSON.stringify({
        name: 'good',
        version: '1.0.0',
        contributes: { panels: [{ id: 'p', label: 'Panel' }], permissions: ['x'] },
      }))
      fs.writeFileSync(path.join(good, 'plugin-entry.js'), 'export default () => {}')

      const parsed = parsePluginDirectory({ id: 'good', dirPath: good, enabled: true })
      expect(parsed?.manifest.contributes?.panels).toEqual([{ id: 'p', label: 'Panel' }])
      expect(parsed?.loadBlockedReason).toBeUndefined()

      const bad = path.join(root, 'bad')
      fs.mkdirSync(bad, { recursive: true })
      fs.writeFileSync(path.join(bad, 'plugin.json'), JSON.stringify({
        name: 'bad',
        version: '1.0.0',
        contributes: { panels: 'not-an-array' },
      }))
      fs.writeFileSync(path.join(bad, 'plugin-entry.js'), 'export default () => {}')

      const parsedBad = parsePluginDirectory({ id: 'bad', dirPath: bad, enabled: true })
      // 插件本身仍被扫描出来(不是消失),只是被标了原因、且 contributes 被丢弃。
      expect(parsedBad).not.toBeNull()
      expect(parsedBad?.manifest.contributes).toBeUndefined()
      expect(parsedBad?.loadBlockedReason).toContain('contributes.panels must be an array')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('R2 minAppVersion', () => {
  it('compares semver without a dependency', () => {
    expect(compareCoreSemver('1.2.3', '1.2.3')).toBe(0)
    expect(compareCoreSemver('1.3.0', '1.2.9')).toBeGreaterThan(0)
    expect(compareCoreSemver('1.2.0', '1.10.0')).toBeLessThan(0)
    expect(compareCoreSemver('v2.0.0-beta.1', '2.0.0')).toBe(0)
  })

  it('blocks only when the host is genuinely older', () => {
    expect(checkPluginMinAppVersion({ minAppVersion: '1.0.0' }, '1.1.0')).toBeNull()
    expect(checkPluginMinAppVersion({ minAppVersion: '2.0.0' }, '1.1.0')).toContain('requires app >= 2.0.0')
    // 版本未知不是拒绝加载的理由。
    expect(checkPluginMinAppVersion({ minAppVersion: '2.0.0' }, undefined)).toBeNull()
    expect(checkPluginMinAppVersion({}, '1.0.0')).toBeNull()
  })

  it('marks a too-new plugin at scan time so its code never runs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-minapp-'))
    try {
      const dir = path.join(root, 'future')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
        name: 'future',
        version: '1.0.0',
        minAppVersion: '99.0.0',
      }))
      fs.writeFileSync(path.join(dir, 'plugin-entry.js'), 'export default () => {}')

      const parsed = parsePluginDirectory({ id: 'future', dirPath: dir, enabled: true, appVersion: '1.1.0' })
      expect(parsed?.loadBlockedReason).toBe('requires app >= 99.0.0 (current 1.1.0)')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('R2 hot reload', () => {
  it('builds a cache-busted file URL specifier', () => {
    const plain = buildPluginEntryImportSpecifier('/plugins/demo/plugin-entry.js')
    expect(plain.startsWith('file://')).toBe(true)
    expect(plain).not.toContain('?v=')

    const busted = buildPluginEntryImportSpecifier('/plugins/demo/plugin-entry.js', 3)
    expect(busted).toBe(`${plain}?v=3`)
    expect(buildPluginEntryImportSpecifier('builtin://demo/entry.js', 2)).toBe('builtin://demo/entry.js?v=2')
  })

  it('re-imports the module on disable → enable so edited plugin code takes effect', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-hot-reload-'))
    const entryPath = path.join(root, 'plugin-entry.mjs')
    try {
      const write = (marker: string): void => {
        fs.writeFileSync(entryPath, `export default function plugin(api) { api.registerRequestHandler('version', () => '${marker}') }\n`)
      }
      write('v1')

      const specifiers: string[] = []
      const def = definition('hot', () => {}, { entry: undefined, entryPath, dirPath: root })
      const { manager } = createManager([def], {
        async loadPluginEntry(definitionInput, reloadToken) {
          const specifier = buildPluginEntryImportSpecifier(definitionInput.entryPath, reloadToken)
          specifiers.push(specifier)
          const mod = await import(/* @vite-ignore */ specifier)
          return mod.default as TestEntry
        },
      })

      await manager.initialize({ ready: true })
      await expect(manager.handleRequest({ pluginId: 'hot', action: 'version' }))
        .resolves.toMatchObject({ result: 'v1' })

      // 改写磁盘上的插件代码,然后 disable → enable。
      write('v2')
      await manager.disablePlugin('hot')
      await manager.enablePlugin('hot')

      await expect(manager.handleRequest({ pluginId: 'hot', action: 'version' }))
        .resolves.toMatchObject({ result: 'v2' })
      // 第二次的说明符必须不同 —— 相同的话命中的就是 ESM 模块缓存。
      expect(specifiers[1]).not.toBe(specifiers[0])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('R2 carried-over fixes', () => {
  it('latches scheduler.register out after dispose', () => {
    const registered: string[] = []
    let disposed = false
    const disposeCallbacks: Array<() => void> = []
    const scheduler = createScopedPluginScheduler({
      pluginId: 'sched',
      isDisposed: () => disposed,
      disposeCallbacks,
      scheduler: {
        register: task => {
          registered.push(task.id)
          return {
            id: task.id,
            unregister: () => {},
            refresh: () => undefined,
            getStatus: () => undefined,
            runNow: async () => ({} as never),
            setEnabled: () => undefined,
          }
        },
        getStatus: () => undefined,
        list: () => [],
        refresh: () => undefined,
        runNow: async () => ({} as never),
        setEnabled: () => undefined,
      },
    })

    scheduler.register({ id: 'before', run: () => {} } as never)
    expect(registered).toEqual(['plugin:sched:before'])

    disposed = true
    const handle = scheduler.register({ id: 'after', run: () => {} } as never)
    // 晚到的注册不落进全局调度器 —— 那会是一个没人能停掉的孤儿任务。
    expect(registered).toEqual(['plugin:sched:before'])
    expect(handle.id).toBe('after')
    expect(handle.getStatus()).toBeUndefined()
    expect(() => handle.unregister()).not.toThrow()
  })

  it('serializes concurrent enable/disable so the last call wins deterministically', async () => {
    const order: string[] = []
    const { manager } = createManager([definition('racy', () => {
      order.push('load')
    })])
    await manager.initialize({ ready: true })
    order.length = 0

    // 熔断的 fire-and-forget disable 与用户手动 enable 撞在一起。
    await Promise.all([
      manager.disablePlugin('racy'),
      manager.enablePlugin('racy'),
      manager.disablePlugin('racy'),
    ])

    // 串行化的判据:最后一次操作说了算,插件不会停在"已注册但被标记为关闭"。
    const info = manager.getPlugins()[0]
    expect(info.loaded).toBe(false)
    expect(info.definition.enabled).toBe(false)
    await expect(manager.handleRequest({ pluginId: 'racy', action: 'anything' }))
      .resolves.toMatchObject({ success: false })
  })

  it('keeps queued toggles running after one of them throws', async () => {
    const { manager } = createManager([definition('demo', () => {})])
    await manager.initialize({ ready: true })

    const failing = vi.fn().mockImplementationOnce(() => {
      throw new Error('setPluginEnabled exploded')
    })
    ;(manager as unknown as { host: { setPluginEnabled: unknown } }).host.setPluginEnabled = failing

    await expect(manager.disablePlugin('demo')).rejects.toThrow('setPluginEnabled exploded')
    // 队列只排序不传播失败:下一次操作照常执行。
    await expect(manager.enablePlugin('demo')).resolves.toBeUndefined()
  })
})
