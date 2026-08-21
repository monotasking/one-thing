/**
 * 拆除测试(CI 化)—— 设计文档 §4.2 宪法第 6 条 / R0 第 5 条。
 *
 * 对每个内置插件:enable → 记录它在各注册表(工具 / 命令 / 提示词 provider /
 * 技能根 / 生命周期钩子 / 事件订阅 / 调度任务)的足迹 → disable → 断言全部
 * 注册表回到基线。
 *
 * 判据是**快照对比**而不是"看起来没报错":soul-memory 的账单正是"卸载后宿主
 * 树里还留着东西",一次性人工验收挡不住回归,所以它必须是常设守卫。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-plugin-teardown-'))
const previousStorePath = process.env.ONETHING_STORE_PATH
process.env.ONETHING_STORE_PATH = storeRoot

type LoadedModules = Awaited<ReturnType<typeof loadModules>>

async function loadModules() {
  const [loader, api, tools, promptContext, skillRoots, lifecycle, inputIntercept, toolCallIntercept, toolResultIntercept, scheduler, variables, connectors, deepLinks, credentialStrategies] = await Promise.all([
    import('../loader.js'),
    import('../api.js'),
    import('@onething/runtime/toolkit'),
    import('../../engine/prompt/plugin-context.js'),
    import('@onething/runtime/skills/plugin-roots.wiring'),
    import('@onething/runtime/plugins/lifecycle.wiring'),
    import('@onething/runtime/plugins/input-intercept-bound'),
    import('@onething/runtime/plugins/tool-call-intercept-bound'),
    import('@onething/runtime/plugins/tool-result-intercept-bound'),
    import('@onething/runtime/scheduler/scheduler-bound'),
    import('../../variables/index.js'),
    import('../../../channel/connector-registry.js'),
    import('../../deeplink/registry.js'),
    import('../../providers/credential-strategy.js'),
  ])
  return { loader, api, tools, promptContext, skillRoots, lifecycle, inputIntercept, toolCallIntercept, toolResultIntercept, scheduler, variables, connectors, deepLinks, credentialStrategies }
}

/**
 * 游离定时器计数(§5.1 第 10 条:数据/资源侧足迹)。
 *
 * 注册表快照看不见"插件启用期间起了一个 setInterval 却没在 dispose 里清掉" ——
 * log-monitor 的 flush 定时器就是这一类的活样本(R0 期抓到过它的 WriteStream)。
 * 这里数的是**净增的活句柄**:enable 期间创建、dispose 之后仍未清除的那些。
 */
function trackLiveTimers() {
  const live = new Set<unknown>()
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout

  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = realSetInterval(...args)
    live.add(handle)
    return handle
  }) as typeof setInterval
  globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
    live.delete(handle)
    return realClearInterval(handle)
  }) as typeof clearInterval
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const handle = realSetTimeout(...args)
    live.add(handle)
    return handle
  }) as typeof setTimeout
  globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
    live.delete(handle)
    return realClearTimeout(handle)
  }) as typeof clearTimeout

  return {
    liveCount: () => live.size,
    restore: () => {
      for (const handle of live) realClearTimeout(handle as Parameters<typeof clearTimeout>[0])
      live.clear()
      globalThis.setInterval = realSetInterval
      globalThis.clearInterval = realClearInterval
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
    },
  }
}

interface RegistrySnapshot {
  toolIds: string[]
  promptContextProviders: number
  skillRoots: number
  lifecycleHooks: { beforeContextCompact: number; afterAssistantResponse: number }
  eventSubscriptions: number
  schedulerTaskIds: string[]
  /** 注册表之外的残留:note-skills 经 onVariableChange 挂的真订阅。 */
  variableSubscriptions: number
  /** R7 开放的第一个既有注册表 —— 开一个就要进快照,否则守卫覆盖不到它。 */
  imConnectorIds: string[]
  /** H4 开放的第三个注册表(深链动作)。同一条规矩:开一个就要进快照。 */
  deepLinkActionAddresses: string[]
  /** 批 E 开放的第四个注册表(凭证策略)。同一条规矩:开一个就要进快照。 */
  credentialStrategyPolicies: string[]
  /** N2 的干预型钩子:开一个钩子点就要进快照,同一条"开一个漏一个"的规矩。 */
  inputInterceptHooks: number
  /** N4 的干预型钩子:同上。fail-closed 让漏拆的代价更大 —— 一条被遗忘的
   *  拦截会继续挡工具,而它的插件已经不在了。 */
  toolCallInterceptHooks: number
  /** N5 的干预型钩子:同上。fail-open,漏拆的代价较轻(一条被遗忘的改写会继续
   *  改结果),但"开一个漏一个"的规矩一样适用。 */
  toolResultInterceptHooks: number
}

/** Counting EventBus stand-in: subscriptions are a registry too, and a leaked
 *  listener is exactly the kind of residue git diff never sees. */
function createCountingEventBus() {
  const handlers = new Map<string, Set<unknown>>()
  const subscribe = (key: string, handler: unknown): (() => void) => {
    const set = handlers.get(key) ?? new Set<unknown>()
    set.add(handler)
    handlers.set(key, set)
    return () => {
      set.delete(handler)
    }
  }
  return {
    get subscriptionCount(): number {
      let total = 0
      for (const set of handlers.values()) total += set.size
      return total
    },
    onAnySession(eventType: string, handler: unknown): () => void {
      return subscribe(eventType, handler)
    },
    // 全局面也进同一本账:消息态的级联订阅(session:deleted)挂在这里,
    // 漏退订同样是 git diff 看不见的残留。
    onGlobal(eventType: string, handler: unknown): () => void {
      return subscribe(`global:${eventType}`, handler)
    },
    emitGlobal(): void {},
  }
}

function createStreamEngineStub() {
  return {
    steerMessage(): void {},
    followUpMessage(): void {},
  }
}

let modules: LoadedModules
let eventBus: ReturnType<typeof createCountingEventBus>

function snapshot(mods: LoadedModules, bus: ReturnType<typeof createCountingEventBus>): RegistrySnapshot {
  let schedulerTaskIds: string[] = []
  try {
    schedulerTaskIds = mods.scheduler.getScheduler().list().map((task: { id: string }) => task.id).sort()
  } catch {
    schedulerTaskIds = []
  }
  // R7:新开放的注册表要进拆除快照,否则"开一个漏一个"—— 拆除测试的价值全在
  // 它是**自动覆盖新成员**的,清单漏登记就等于守卫失效。
  let imConnectorIds: string[] = []
  try {
    imConnectorIds = mods.connectors.listIMConnectorIds()
  } catch {
    imConnectorIds = []
  }
  let deepLinkActionAddresses: string[] = []
  try {
    deepLinkActionAddresses = mods.deepLinks
      .listPluginDeepLinkActions()
      .map((info: { address: string }) => info.address)
      .sort()
  } catch {
    deepLinkActionAddresses = []
  }
  let credentialStrategyPolicies: string[] = []
  try {
    credentialStrategyPolicies = mods.credentialStrategies
      .listPluginCredentialStrategies()
      .map((info: { policy: string }) => info.policy)
      .sort()
  } catch {
    credentialStrategyPolicies = []
  }
  let variableSubscriptions = 0
  try {
    variableSubscriptions = mods.variables.getVariablesStore().listenerCount()
  } catch {
    variableSubscriptions = 0
  }
  return {
    // R4b:工具足迹从旧注册表换成**目录**(插件工具 R3b 起就装在那里)。
    toolIds: (mods.tools.getToolkitCatalog()?.all() ?? [])
      .map((tool: { spec: { id: string } }) => tool.spec.id)
      .sort(),
    promptContextProviders: mods.promptContext.getPromptContextProviderCount(),
    skillRoots: mods.skillRoots.listPluginSkillRoots().length,
    lifecycleHooks: mods.lifecycle.getLifecycleHookCounts(),
    inputInterceptHooks: mods.inputIntercept.getInputInterceptHookCount(),
    toolCallInterceptHooks: mods.toolCallIntercept.getToolCallInterceptHookCount(),
    toolResultInterceptHooks: mods.toolResultIntercept.getToolResultInterceptHookCount(),
    eventSubscriptions: bus.subscriptionCount,
    schedulerTaskIds,
    variableSubscriptions,
    imConnectorIds,
    deepLinkActionAddresses,
    credentialStrategyPolicies,
  }
}

beforeAll(async () => {
  modules = await loadModules()
  eventBus = createCountingEventBus()
})

afterAll(async () => {
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  // fs.createWriteStream 的 open 是异步的:dispose 里 end() 之后,句柄可能还没
  // 落地。先让事件循环把它跑完再删目录,否则删的是"正在打开的文件"。
  await new Promise(resolve => setTimeout(resolve, 150))
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

describe('built-in plugin teardown leaves no residue', () => {
  it('enumerates the built-in plugins so a newly added one is covered automatically', () => {
    const builtins = modules.loader.scanPlugins().filter(def => def.source === 'builtin')
    expect(builtins.length).toBeGreaterThan(0)
  })

  it('restores every registry after disable', async () => {
    const builtins = modules.loader.scanPlugins().filter(def => def.source === 'builtin')

    for (const definition of builtins) {
      const before = snapshot(modules, eventBus)

      const { api, state } = modules.api.createPluginAPI(
        definition.id,
        eventBus as never,
        createStreamEngineStub() as never,
      )
      const entry = definition.entry
      expect(entry, `built-in plugin "${definition.id}" must carry a bundled entry`).toBeTypeOf('function')
      await entry!(api)

      const during = snapshot(modules, eventBus)
      const footprint = {
        tools: during.toolIds.filter(id => !before.toolIds.includes(id)),
        commands: [...state.commands.keys()],
        promptContextProviders: during.promptContextProviders - before.promptContextProviders,
        skillRoots: during.skillRoots - before.skillRoots,
        beforeContextCompact: during.lifecycleHooks.beforeContextCompact - before.lifecycleHooks.beforeContextCompact,
        afterAssistantResponse: during.lifecycleHooks.afterAssistantResponse - before.lifecycleHooks.afterAssistantResponse,
        eventSubscriptions: during.eventSubscriptions - before.eventSubscriptions,
        schedulerTasks: during.schedulerTaskIds.filter(id => !before.schedulerTaskIds.includes(id)),
        variableSubscriptions: during.variableSubscriptions - before.variableSubscriptions,
      }
      const totalFootprint = footprint.tools.length
        + footprint.commands.length
        + footprint.promptContextProviders
        + footprint.skillRoots
        + footprint.beforeContextCompact
        + footprint.afterAssistantResponse
        + footprint.eventSubscriptions
        + footprint.schedulerTasks.length
        + footprint.variableSubscriptions
      expect(
        totalFootprint,
        `built-in plugin "${definition.id}" registered nothing — the teardown assertion would be vacuous`,
      ).toBeGreaterThan(0)

      modules.api.disposePlugin(state)

      const after = snapshot(modules, eventBus)
      expect(after, `built-in plugin "${definition.id}" left residue after dispose`).toEqual(before)
      expect(state.commands.size).toBe(0)
    }
  })

  /**
   * 数据/资源侧足迹(§5.1 第 10 条)。
   *
   * 插件启用期间经 api.storage 写盘、并可能起定时器;dispose 之后:
   *  - 它写的数据**留在原地**(停用保留数据,只有卸载才归档);
   *  - 它起的定时器一个不剩(否则就是一个没人能停的游离句柄)。
   */
  it('leaves plugin data on disk but no live timers after dispose', async () => {
    const builtins = modules.loader.scanPlugins().filter(def => def.source === 'builtin')
    const timers = trackLiveTimers()
    try {
      for (const definition of builtins) {
        const baseline = timers.liveCount()
        const { api, state } = modules.api.createPluginAPI(
          definition.id,
          eventBus as never,
          createStreamEngineStub() as never,
        )
        await definition.entry!(api)

        // 插件在启用期间写一份自己的数据。
        api.storage.writeJson('teardown-probe.json', { wrote: definition.id })
        const dataFile = path.join(api.storage.dir(), 'teardown-probe.json')
        expect(fs.existsSync(dataFile)).toBe(true)

        modules.api.disposePlugin(state)

        // 停用保留数据 —— 归档是卸载的语义,不是停用的。
        expect(fs.existsSync(dataFile), `${definition.id} data must survive disable`).toBe(true)
        // 净增的活定时器必须归零。
        expect(
          timers.liveCount(),
          `built-in plugin "${definition.id}" left a live timer after dispose`,
        ).toBeLessThanOrEqual(baseline)
      }
    } finally {
      timers.restore()
    }
  })
})

describe('plugin tools cannot grant themselves an auto-execute pass', () => {
  it('forces every plugin-registered tool to permission-gated', async () => {
    /*
     * `permissionGuard: 'safe'` 落在 CORE_AUTO_EXECUTE 集里 —— 声明它的工具不弹
     * 权限提示、直接执行。上一版把这个字段交给插件自己填(宿主只提供缺省),
     * 于是任何插件写一行就绕过了整套权限系统,而 manifest 的
     * `contributes.permissions` 纯装饰、不参与任何判定 —— **示例插件正在教这个写法**。
     */
    const definitions = modules.loader.scanPlugins().filter(def => def.source === 'builtin')
    const catalogIds = () => (modules.tools.getToolkitCatalog()?.all() ?? [])
      .map((tool: { spec: { id: string } }) => tool.spec.id)
    const before = catalogIds()

    for (const definition of definitions) {
      const { api, state } = modules.api.createPluginAPI(
        definition.id,
        eventBus as never,
        createStreamEngineStub() as never,
      )
      const entry = definition.entry
      if (typeof entry !== 'function') continue
      await entry(api)

      const added = (modules.tools.getToolkitCatalog()?.all() ?? [])
        .filter((tool: { spec: { id: string } }) => !before.includes(tool.spec.id))
      for (const tool of added) {
        // R4b:`permissionGuard: 'permission-gated'` 这句话现在由 `plugin_exec`
        // 这条效果说出来(派生表的输入就是它),所以钉的是效果本身。
        expect(
          [...(tool as { spec: { effects: readonly string[] } }).spec.effects],
          `${(tool as { spec: { id: string } }).spec.id} must not be able to skip the permission prompt`,
        ).toEqual(['plugin_exec'])
      }
      modules.api.disposePlugin(state)
    }
  })
})
