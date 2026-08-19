import path from 'path'
import { toLogger, type CompatLogger, type Logger } from '../logging/index.js'
import type { CorePluginDefinition } from './types.js'
import { describePluginPanelResultProblem } from './panel.js'
import {
  findPluginUpdate,
  type CorePluginMarketIndex,
  type InstallCorePluginPackageInput,
  type InstallCorePluginPackageResult,
} from './install.js'
import { unscopedPluginIdFromPackageName } from './loader.js'
import { describePluginSurface, pluginScope, type PluginFailureScope } from './policy.js'
import {
  CORE_PLUGIN_ENTRY_TIMEOUT_MS,
  CORE_PLUGIN_REQUEST_TIMEOUT_MS,
  runWithPluginTimeout,
  type CorePluginRuntimeHealth,
} from './runtime-guard.js'
import {
  CorePluginRequestRegistry,
  PLUGIN_REQUEST_ABORTED_ERROR,
  assertPluginPayloadSerializable,
  normalizePluginRequestAction,
  pluginRequestErrorMessage,
  type CorePluginRequestContext,
  type CorePluginRequestHandler,
  type CorePluginRequestInput,
  type CorePluginRequestResult,
} from './request-channel.js'

export interface CorePluginInfo<
  TEntry = unknown,
  TDefinition extends CorePluginDefinition<TEntry> = CorePluginDefinition<TEntry>,
> {
  definition: TDefinition
  loaded: boolean
  commands: string[]
  error?: string
  /** 运行期健康(加载后才产生的失败:钩子超时、事件 handler 抛错、熔断)。 */
  health?: CorePluginRuntimeHealth
}

export interface CorePluginStateLike<TCommand = unknown> {
  commands: Map<string, TCommand>
  /** 统一请求通道的分发表。宿主适配器由 createCorePluginAPI 提供。 */
  requestHandlers?: Map<string, CorePluginRequestHandler>
}

/** @deprecated 统一为 `Logger`(§8.3 区 ①);过渡期仍收老鸭子形状。 */
export type CorePluginManagerLogger = CompatLogger

export interface CorePluginBootstrapperOptions<TManager, TContext> {
  ensurePluginDirs?(): void
  createManager(): TManager
  initializeManager(manager: TManager, context: TContext): Promise<void>
  logger?: CorePluginManagerLogger
}

export interface CorePluginManagerHost<
  TDefinition extends CorePluginDefinition<TEntry>,
  TEntry,
  TApi,
  TState extends CorePluginStateLike<TCommand>,
  TCommand,
  TContext,
> {
  ensurePluginDirs(): void
  scanPlugins(): TDefinition[]
  /**
   * `reloadToken` 每次 enable 递增 —— 宿主拿它给 ESM 说明符加 cache-buster,
   * 于是 disable→enable 拿到的是新模块(热重载)。
   */
  loadPluginEntry(definition: TDefinition, reloadToken?: number): Promise<TEntry | null>
  createPluginAPI(pluginId: string, context: TContext): { api: TApi; state: TState }
  disposePlugin(state: TState): void
  setPluginEnabled(pluginId: string, enabled: boolean): void
  /** 运行期健康(app 层持有);getPlugins() 只是把它贴到插件信息上。 */
  getPluginHealth?(pluginId: string): CorePluginRuntimeHealth | undefined
  /**
   * 请求通道的失败/成功上报 —— 接 R1 的失败计数熔断。
   * scope 形如 `request:<action>`:同一个 action 连败达阈才熔断,
   * 与 promptContext / 生命周期钩子各记各的账。
   */
  /**
   * 用**属性签名**而不是方法简写:TS 的方法参数是双变的,方法写法下宿主从这条
   * 端口塞一个裸字符串不会红 —— 品牌类型在这里就漏了一个口。属性签名走逆变检查。
   */
  onRequestFailure?: (pluginId: string, scope: PluginFailureScope, error: unknown) => void
  onRequestSuccess?: (pluginId: string, scope: PluginFailureScope) => void
  /**
   * 某个界面是否处于降级态(R7)。宿主接健康账本;core 不持有它。
   * 不接这条线的宿主(headless / 测试替身)一律放行。
   */
  isSurfaceDegraded?(pluginId: string, surface: string): boolean
  /** 降级原因,给用户看的一句话。 */
  describeDegradedSurface?(pluginId: string, surface: string): string | undefined
  // ── R4:数据目录与卸载生命周期 ──
  /** 归档插件数据目录(移进 legacy-backup)。返回失败原因而不是抛。 */
  archivePluginData?(pluginId: string): { archived: boolean; archivePath?: string; error?: string }
  /** 删除用户插件的源目录(npm 形态 = npm uninstall,实现可以是异步)。 */
  removePluginSource?(definition: TDefinition): { removed: boolean; error?: string } | Promise<{ removed: boolean; error?: string }>
  /** 清掉 plugin-settings 里该插件的 enabled/config/health 三键。 */
  clearPluginSettings?(pluginId: string): void
  /**
   * 扫无主数据并归档;返回被归档的 pluginId。
   *
   * `scanTrusted` 为 false 时**必须什么都不做** —— 读不到插件目录不是
   * "一个插件都没装"。
   */
  archiveOrphanPluginData?(input: {
    knownPluginIds: string[]
    scanTrusted: boolean
    userPluginCount: number
  }): string[]
  /** 归档搬回原位(删源目录失败时的补偿)。 */
  restorePluginDataArchive?(pluginId: string, archivePath: string): { restored: boolean; error?: string }
  /** 一轮扫描的可信度与源目录实际条目(所有权判定用,不看能否加载)。 */
  getPluginSourceScan?(): { trusted: boolean; reason?: string; presentEntryNames: string[] }
  // ── P1:npm 生命周期(裁决 8:v1 面向开发者市场,依赖本机 npm)──
  /**
   * 装/更新一个 npm 包(spec = tarball URL 或 file: 路径)。
   * 脚手架、--ignore-scripts、零运行时依赖与 SRI 校验、回滚,全部在
   * 这条端口的实现里(core install.ts 提供了开箱的编排,宿主只需供 runNpm)。
   */
  installPluginPackage?(input: InstallCorePluginPackageInput): Promise<InstallCorePluginPackageResult>
  /** 读账本里某包当前的 spec —— update 回滚旧版用(版本真相在账本,不在 registry)。 */
  readInstalledPluginSpec?(pkg: string): string | undefined
  /** 拉市场索引;未配置/拉取失败 = null(更新通道整体关闭,checkPluginUpdates 返回 [])。 */
  fetchPluginMarketIndex?(): Promise<CorePluginMarketIndex | null>
}

export interface CorePluginUninstallResult {
  success: boolean
  /** 数据被归档到哪儿(成功与"归档成功但后续失败"两种情况都会带上)。 */
  archivePath?: string
  error?: string
}

export interface CorePluginInstallRequest {
  /** 包名(可带 scope);必须与包内 package.json 的 name 一致。 */
  pkg: string
  /** 市场通道:tarball URL。与 path 二选一。 */
  tarballUrl?: string
  /** file: 开发通道:本地目录或本地 .tgz。与 tarballUrl 二选一。 */
  path?: string
  /** 市场索引给的 sha512-SRI;file: 通道通常不给(跳过比对)。 */
  integrity?: string
}

export interface CorePluginInstallResult {
  success: boolean
  pluginId?: string
  error?: string
}

export interface CorePluginUpdateOffer {
  pluginId: string
  current: string
  latest: string
}

export interface CorePluginUpdateResult {
  success: boolean
  pluginId: string
  /** 装上的新版本(成功时)。 */
  version?: string
  /** 装后闸不通过时是否已回退旧版。 */
  rolledBack?: boolean
  error?: string
}

export interface CorePluginManagerOptions {
  /** entry(api) 的超时预算;<=0 关闭。 */
  entryTimeoutMs?: number
  /** 一次插件请求的超时预算;<=0 关闭(仅测试用)。 */
  requestTimeoutMs?: number
}

export class CorePluginManager<
  TApi = unknown,
  TEntry extends ((api: TApi) => void | Promise<void>) = (api: TApi) => void | Promise<void>,
  TCommand = unknown,
  TState extends CorePluginStateLike<TCommand> = CorePluginStateLike<TCommand>,
  TDefinition extends CorePluginDefinition<TEntry> = CorePluginDefinition<TEntry>,
  TContext = unknown,
> {
  private plugins = new Map<string, CorePluginInfo<TEntry, TDefinition>>()
  private pluginStates = new Map<string, TState>()
  private context: TContext | null = null
  private refreshInFlight: Promise<void> | null = null
  private generation = 0
  private readonly toggleQueues = new Map<string, Promise<void>>()
  private readonly reloadTokens = new Map<string, number>()
  /**
   * 进程内单调的热重载计数 —— 令牌**永不重复使用**。
   *
   * 曾经是每插件 +1,于是两条路都能发出一个用过的令牌:uninstall 把计数删回 0,
   * 而安装/更新根本不动计数。宿主拿令牌做 ESM cache-buster(`?v=<token>`),
   * 令牌重复 = 说明符重复 = **模块缓存命中**:磁盘上换成了新代码,进程里跑的
   * 还是旧模块,而 manifest(现读磁盘)已经是新版本 —— 版本号变了、行为没变,
   * 直到重启 app。tps-meter 1.0.2 的验收就撞在这里(装完那一轮仍跑 1.0.1 的
   * 纯内存实现,记录一条都没落盘)。
   */
  private reloadCounter = 0
  private readonly requests = new CorePluginRequestRegistry()

  constructor(
    private readonly host: CorePluginManagerHost<TDefinition, TEntry, TApi, TState, TCommand, TContext>,
    private readonly injectedLogger?: CorePluginManagerLogger,
    private readonly options: CorePluginManagerOptions = {},
  ) {
    this.log = toLogger(injectedLogger)
  }

  /** 注入的 logger 归一化后的样子(缺省 noop —— core 不再默认打 console)。 */
  private readonly log: Logger

  async initialize(context: TContext): Promise<void> {
    // 重新装配:把拆除闩放开,否则 shutdown 之后再 initialize 会一个插件也装不上。
    this.shuttingDown = false
    this.context = context
    await this.refreshPlugins()
  }

  /**
   * per-plugin 串行化。
   *
   * 熔断的自动禁用是 fire-and-forget,用户手上的开关是另一条线 —— 两者撞在一起
   * 时,"先 dispose 后 load" 与 "先 load 后 dispose" 结果完全不同(后者留下一个
   * 已注册但被标记为关闭的插件)。同一个插件的 enable/disable 排成一队。
   */
  private runExclusive<T>(pluginId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.toggleQueues.get(pluginId) ?? Promise.resolve()
    const next = previous.then(task, task)
    // 队列只用于排序,不传播失败:一次失败的 disable 不该毒死后续所有操作。
    this.toggleQueues.set(pluginId, next.then(() => undefined, () => undefined))
    return next
  }

  async disablePlugin(pluginId: string): Promise<void> {
    return this.runExclusive(pluginId, async () => this.disablePluginNow(pluginId))
  }

  private disablePluginNow(pluginId: string): void {
    // 该插件名下所有在飞请求先中止 —— 否则它们会在一个已经被拆掉的插件里跑完。
    this.requests.abortForPlugin(pluginId)

    const state = this.pluginStates.get(pluginId)
    if (state) {
      this.host.disposePlugin(state)
      this.pluginStates.delete(pluginId)
    }

    const info = this.plugins.get(pluginId)
    if (info) {
      info.definition.enabled = false
      info.loaded = false
      info.commands = []
      // 声明层的阻断原因(minAppVersion / 非法 contributes)不随手动停用消失:
      // 那不是"上一次运行的错误",而是这个插件当前**为什么装不上**。
      info.error = info.definition.loadBlockedReason
    }

    this.host.setPluginEnabled(pluginId, false)
    this.log.debug(`[PluginManager] Disabled plugin: ${pluginId}`)
  }

  async enablePlugin(pluginId: string): Promise<void> {
    return this.runExclusive(pluginId, async () => {
      const info = this.plugins.get(pluginId)
      if (!info) return
      if (info.loaded) this.disablePluginNow(pluginId)
      info.definition.enabled = true
      this.host.setPluginEnabled(pluginId, true)
      // 重新启用要拿新模块:改完插件代码 disable→enable 就该生效,不必重启 app。
      this.bumpReloadToken(pluginId)
      await this.loadPlugin(info.definition)
    })
  }

  /**
   * 每插件的**加载轮次**。
   *
   * generation 只区分"哪一轮 refresh",区分不了同一轮里同一个插件的两次加载。
   * 而 refresh 在飞时 disable→enable 恰好会产生两次:refresh 的 loadPlugin 还在
   * await,enable 又发起一次并先落表;refresh 那次回来时只查了 `enabled === false`
   * (此刻是 true),于是把自己的 state 盖上去 —— enable 那份成了**永远拆不掉的
   * 孤儿**(事件双份处理、停用后仍写盘、注册的连接器无人撤下)。
   * 战役里修过反方向(refresh 在飞时被 disable),正方向一直没修。
   */
  private loadTokens = new Map<string, number>()

  /**
   * 拆除闩。
   *
   * shutdown 只做 disposeAll + clear 是不够的:在飞的 doRefreshPlugins 跑完后
   * `stale()` 为假(generation 没动)、`plugins.get(id)?.definition.enabled` 是
   * undefined(`undefined === false` 不成立),于是照常落表 —— 插件在拆除之后
   * 被复活,状态永不 dispose。R7 刚把 shutdownPlugins 接进 beforeQuit,而插件
   * 装配是 post-window 非阻塞的,两者的窗口天然重叠。
   */
  private shuttingDown = false

  /** 热重载令牌 —— 宿主的 importEntry 拿它做 ESM cache-buster。 */
  getReloadToken(pluginId: string): number {
    return this.reloadTokens.get(pluginId) ?? 0
  }

  /**
   * 发一个**从没用过**的热重载令牌。
   *
   * 判据不是"这个插件重载过几次",而是"这个说明符在本进程里 import 过没有" ——
   * 所以计数是全局单调的,不按插件计、也不随 uninstall 归零。磁盘上的代码换了
   * 就必须换令牌(安装/更新/重新启用三处),否则新代码要等下次重启才生效。
   */
  private bumpReloadToken(pluginId: string): void {
    this.reloadCounter += 1
    this.reloadTokens.set(pluginId, this.reloadCounter)
  }

  // ── 统一请求通道 ──────────────────────────────

  /**
   * 按 pluginId + action 分发一次请求。
   *
   * 分发逻辑住在 core:四个宿主(Electron / server / CLI daemon / 将来的子进程)
   * 共用同一份寻址与序列化语义,@main 只做薄接线。
   */
  async handleRequest(input: CorePluginRequestInput): Promise<CorePluginRequestResult> {
    const action = normalizePluginRequestAction(input.action)
    // requestId 由 core 统一生成(带单调序列号)。宿主预生成的 `Date.now()` 在
    // 同毫秒并发下会撞号,而撞号意味着两个请求共用一个 AbortController 地址。
    const requestId = input.requestId || this.requests.nextRequestId(input.pluginId)
    const scope = pluginScope.request(action)

    const fail = (error: string, extra: { aborted?: boolean; timedOut?: boolean } = {}): CorePluginRequestResult => ({
      success: false,
      requestId,
      error,
      ...extra,
    })

    const state = this.pluginStates.get(input.pluginId)
    if (!state) {
      const info = this.plugins.get(input.pluginId)
      return fail(info
        ? `Plugin "${input.pluginId}" is not active${info.error ? ` (${info.error})` : ''}`
        : `Unknown plugin "${input.pluginId}"`)
    }

    const handler = state.requestHandlers?.get(action)
    if (!handler) {
      return fail(`Plugin "${input.pluginId}" has no request handler for action "${action}"`)
    }

    /*
     * 降级闸(R7)。**这一步是"降级"这个罚则的全部牙齿。**
     *
     * 没有它的话,把 request:* 从 disable-plugin 改成 degrade-surface 的净效果
     * 就是**取消了这个命名空间的熔断**:一个必败的面板 action 照常一次次进插件、
     * 一次次跑满 30s 预算,而用户只看到一个徽章。§5.2 第 1 条把请求通道纳入
     * 熔断账的理由正是"UI 轮询必败 action 会无限连败",不能在这里丢掉。
     */
    const surface = describePluginSurface(action.startsWith('request:') ? action : `request:${action}`)
    if (!input.bypassDegraded && this.host.isSurfaceDegraded?.(input.pluginId, surface)) {
      const reason = this.host.describeDegradedSurface?.(input.pluginId, surface)
      return {
        success: false,
        requestId,
        error: reason
          ? `"${surface}" is disabled after repeated failures: ${reason}`
          : `"${surface}" is disabled after repeated failures.`,
        degraded: true,
        surface,
      }
    }

    try {
      assertPluginPayloadSerializable(input.payload, 'request payload')
    } catch (error) {
      return fail(pluginRequestErrorMessage(error))
    }

    const controller = this.requests.begin(requestId, input.pluginId)
    if (!controller) {
      return fail(`Request id "${requestId}" is already in flight`)
    }

    // 失败要进 R1 的熔断账。没有这一步的话,R3/R5 的 UI 轮询一个必败 action
    // 会无限连败而插件永远显示 Active —— 那正是 R1 要治的"运行期错误不可见"。
    const reportFailure = (error: unknown): void => {
      this.host.onRequestFailure?.(input.pluginId, scope, error)
    }

    const ctx: CorePluginRequestContext = {
      requestId,
      abortSignal: controller.signal,
      progress: payload => {
        // 撤销之后(或登记已被清掉之后)再报进度,调用方那边已经收到终局结果 ——
        // 继续投递等于给一个已经结束的 requestId 发消息。静默丢弃。
        if (controller.signal.aborted || !this.requests.has(requestId)) return
        try {
          assertPluginPayloadSerializable(payload, 'progress payload')
        } catch (error) {
          this.log.error(`[PluginManager] Dropping non-serializable progress from "${input.pluginId}":`, undefined, error)
          return
        }
        input.onProgress?.({ requestId, pluginId: input.pluginId, action, payload })
      },
    }

    const timeoutMs = this.options.requestTimeoutMs ?? CORE_PLUGIN_REQUEST_TIMEOUT_MS
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    /**
     * 不配合的 handler 兜底。
     *
     * 无条件 `await handler(...)` 的话,一个写了 `await new Promise(()=>{})`
     * 又不理 abortSignal 的 handler 会让 renderer 的 invoke 永远 pending。
     * 这里用 race:abort 或超时一到就**立刻**给调用方终局结果并注销登记,
     * handler 那侧继续跑到底(JS 杀不掉它),它晚到的结果被丢弃并记一次日志。
     */
    const settleEarly = new Promise<CorePluginRequestResult>(resolve => {
      const onAbort = (): void => {
        settled = true
        this.requests.end(requestId)
        resolve(fail(PLUGIN_REQUEST_ABORTED_ERROR, { aborted: true }))
      }
      if (controller.signal.aborted) onAbort()
      else controller.signal.addEventListener('abort', onAbort, { once: true })

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return
          settled = true
          this.requests.end(requestId)
          const message = `Plugin request "${input.pluginId}/${action}" exceeded ${timeoutMs}ms`
          this.log.error(`[PluginManager] ${message}`, undefined)
          reportFailure(new Error(message))
          resolve(fail(message, { timedOut: true }))
        }, timeoutMs)
        ;(timer as unknown as { unref?: () => void }).unref?.()
      }
    })

    const run = (async (): Promise<CorePluginRequestResult> => {
      try {
        const result = await handler(input.payload, ctx)
        if (settled || controller.signal.aborted) {
          this.log.debug(`[PluginManager] Dropping late result for "${input.pluginId}/${action}" (${requestId})`)
          return fail(PLUGIN_REQUEST_ABORTED_ERROR, { aborted: true })
        }
        assertPluginPayloadSerializable(result, 'request result')
        // panel:* 的结果多过一道形状校验。守卫钉在通道上而不是注册包装里 ——
        // 包装可以被绕开(直接写 requestHandlers),通道不能。
        const panelProblem = describePluginPanelResultProblem(action, result)
        if (panelProblem) throw new Error(panelProblem)
        this.host.onRequestSuccess?.(input.pluginId, scope)
        return { success: true, requestId, result: result ?? null }
      } catch (error) {
        if (settled || controller.signal.aborted) {
          this.log.debug(`[PluginManager] Dropping late failure for "${input.pluginId}/${action}" (${requestId})`)
          return fail(PLUGIN_REQUEST_ABORTED_ERROR, { aborted: true })
        }
        this.log.error(`[PluginManager] Request "${input.pluginId}/${action}" failed:`, undefined, error)
        reportFailure(error)
        return fail(pluginRequestErrorMessage(error))
      } finally {
        settled = true
        this.requests.end(requestId)
      }
    })()
    // handler 那侧可能永远不 settle;race 输掉的一方不能变成 unhandled rejection。
    run.catch(() => undefined)

    try {
      return await Promise.race([run, settleEarly])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  // ── 卸载生命周期(R4) ────────────────────────

  /**
   * 真卸载 —— 在 R4 之前,"卸载"只有用户手删目录这一条路,宿主全程无感知。
   *
   * 顺序是 **停用(完整 dispose + 中止在飞)→ 归档数据 → 删源目录 → 清设置键**:
   * 先归档再删源目录,任何一步失败都不会让数据先没了;设置键最后清,
   * 因为它是"这个插件还存在过"的最后凭据。
   *
   * 内置插件没有卸载(它和 app 同一份构建)。
   */
  async uninstallPlugin(pluginId: string): Promise<CorePluginUninstallResult> {
    const info = this.plugins.get(pluginId)
    if (!info) {
      return { success: false, error: `Unknown plugin "${pluginId}"` }
    }
    if (info.definition.source === 'builtin') {
      return { success: false, error: `"${pluginId}" is a built-in plugin and cannot be uninstalled` }
    }

    return this.runExclusive(pluginId, async () => {
      const definition = info.definition
      this.disablePluginNow(pluginId)

      const archive = this.host.archivePluginData?.(pluginId) ?? { archived: false }
      if (archive.error) {
        // 数据还在原地 —— 报出来,不要接着删源目录造成"代码没了数据还在"。
        this.log.error(`[PluginManager] Uninstall aborted for "${pluginId}": ${archive.error}`)
        const failed = this.plugins.get(pluginId)
        if (failed) failed.error = `Uninstall failed while archiving data: ${archive.error}`
        return { success: false, error: archive.error, archivePath: archive.archivePath }
      }

      const removal = (await this.host.removePluginSource?.(definition)) ?? { removed: false }
      if (removal.error) {
        this.log.error(`[PluginManager] Uninstall could not remove source for "${pluginId}": ${removal.error}`)
        // 补偿:数据已经搬走但插件还在 —— 把它搬回原位,否则用户看到的是
        // 一个"还装着但数据全没了"的插件。
        let message = `Uninstall failed while removing the plugin directory: ${removal.error}`
        if (archive.archivePath) {
          const restored = this.host.restorePluginDataArchive?.(pluginId, archive.archivePath)
            ?? { restored: false, error: 'no restore hook on this host' }
          if (restored.restored) {
            message += '; its data was restored to the plugin data directory'
          } else {
            // 搬不回去时,归档路径必须一路带到调用方(它会进 toast)——
            // 只写进 info.error 的话,下一次 refresh 就把它蒸发了。
            message += `; its data is archived at ${archive.archivePath} (restore failed: ${restored.error})`
          }
        }
        const failed = this.plugins.get(pluginId)
        if (failed) failed.error = message
        return { success: false, error: message, archivePath: archive.archivePath }
      }

      this.host.clearPluginSettings?.(pluginId)
      this.plugins.delete(pluginId)
      // 删掉只是不再持有;重装时 bumpReloadToken 会从全局计数取一个新号,
      // 不会退回 0(退回 0 = 重装后命中旧模块缓存,曾经的真实 bug)。
      this.reloadTokens.delete(pluginId)
      this.log.debug(`[PluginManager] Uninstalled plugin: ${pluginId}`)

      return { success: true, archivePath: archive.archivePath }
    })
  }

  /**
   * 生命周期命令与 refreshPlugins 共用单飞(P1 拍板)。
   *
   * npm 对 package.json 没有跨进程原子性;refresh 撞上写了一半的
   * node_modules 会把半成品按加载失败记熔断账。占位期间到来的
   * refreshPlugins() 直接复用这张票 —— 因此 fn 内部必须调
   * doRefreshPlugins() 而不是 refreshPlugins(),否则自我等待死锁。
   */
  private async runLifecycleExclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.refreshInFlight) {
      try {
        await this.refreshInFlight
      } catch {
        // 上一轮失败不挡新一轮生命周期命令。
      }
    }
    const task = fn()
    const slot: Promise<void> = task.then(() => undefined, () => undefined)
    this.refreshInFlight = slot
    try {
      return await task
    } finally {
      if (this.refreshInFlight === slot) this.refreshInFlight = null
    }
  }

  /**
   * 安装一个插件(npm 形态;与 uninstallPlugin 对称)。
   *
   * 命令链:脚手架 → npm install(--ignore-scripts)→ 装后校验(零运行时
   * 依赖 / SRI)→ 全量刷新。失败时 npm 状态已在 installCorePluginPackage
   * 里回滚,错误原样透传。新装插件默认 enabled(settings 无行 = 默认开)。
   */
  async installPlugin(input: CorePluginInstallRequest): Promise<CorePluginInstallResult> {
    if (!this.host.installPluginPackage) {
      return { success: false, error: 'This host does not support plugin installation' }
    }
    const spec = input.tarballUrl ?? (input.path ? `file:${path.resolve(input.path)}` : undefined)
    if (!spec) {
      return { success: false, error: 'installPlugin needs either a tarballUrl or a path' }
    }
    // 防撞闸:包名去 scope 后的 id 撞上内置时,扫描的 seen 集是内置先占位
    // (loader.scanCorePlugins)—— npm 包装得上、账也记了,却永远不会出现
    // 在插件表里。付了钱买空气不如装前明说。(已装的用户插件同 id 不拦:
    // 那是设计好的重装路径。)
    const incomingId = unscopedPluginIdFromPackageName(input.pkg)
    const existing = this.plugins.get(incomingId)
    if (existing?.definition.source === 'builtin') {
      return { success: false, error: `"${incomingId}" is a built-in plugin id; user plugins cannot shadow built-ins` }
    }
    return this.runLifecycleExclusive(async () => {
      const result = await this.host.installPluginPackage!({
        pkg: input.pkg,
        spec,
        integrity: input.integrity,
      })
      if (!result.ok) {
        return { success: false, pluginId: result.pluginId, error: result.error }
      }
      // 磁盘上的代码刚被换掉 —— 必须换令牌,否则下面这次加载会命中模块缓存
      // 拿到旧模块(重装同 id 时尤其致命:uninstall 曾把令牌归零)。
      this.bumpReloadToken(result.pluginId ?? incomingId)
      // 让全量扫描把插件装进表(含 catalog-changed 广播,R5 的通道直接复用)。
      await this.doRefreshPlugins()
      return { success: true, pluginId: result.pluginId }
    })
  }

  /**
   * 更新一个插件:从市场索引取最新 tarball URL,重新走安装链。
   *
   * 不能用 `npm update` —— URL 形式的依赖它解析不了(npm 已知限制),
   * 而且我们的版本真相在市场索引,不在任何 registry。
   * minAppVersion 等声明层闸在装后重校,不够则回退旧版并明示。
   */
  async updatePlugin(pluginId: string): Promise<CorePluginUpdateResult> {
    const info = this.plugins.get(pluginId)
    if (!info) {
      return { success: false, pluginId, error: `Unknown plugin "${pluginId}"` }
    }
    if (info.definition.source === 'builtin') {
      return { success: false, pluginId, error: `"${pluginId}" is a built-in plugin and cannot be updated` }
    }
    if (!this.host.installPluginPackage || !this.host.fetchPluginMarketIndex) {
      return { success: false, pluginId, error: 'This host does not support plugin updates' }
    }
    return this.runLifecycleExclusive(async () => {
      const index = await this.host.fetchPluginMarketIndex!()
      if (!index) {
        return { success: false, pluginId, error: 'The plugin market index is unavailable' }
      }
      const current = info.definition.manifest.version ?? '0.0.0'
      const update = findPluginUpdate(index, pluginId, current)
      if (!update) {
        return { success: false, pluginId, error: `No update available for "${pluginId}" (current ${current})` }
      }
      const entry = update.entry
      // 回滚保险:装前记下账本里的旧 spec —— 装后闸不通过时拿它退回旧版。
      const previousSpec = this.host.readInstalledPluginSpec?.(entry.pkg)
      const result = await this.host.installPluginPackage!({
        pkg: entry.pkg,
        spec: entry.tarballUrl,
        integrity: entry.integrity,
      })
      if (!result.ok) {
        return { success: false, pluginId, error: result.error }
      }
      // 新代码已落盘 —— 换令牌,否则这次刷新加载的还是旧模块(版本号会变、
      // 行为不变,直到重启 app)。
      this.bumpReloadToken(pluginId)
      await this.doRefreshPlugins()

      // 装后重校:tarball 自带的 plugin.json 才是版本闸的事实源。
      const blocked = this.plugins.get(pluginId)?.definition.loadBlockedReason
      if (blocked) {
        let rolledBack = false
        if (previousSpec) {
          const undo = await this.host.installPluginPackage!({ pkg: entry.pkg, spec: previousSpec })
          rolledBack = undo.ok
          if (undo.ok) {
            // 回滚也是一次换代码 —— 令牌同样要动,否则回滚后跑的是刚刚被回滚掉的那份。
            this.bumpReloadToken(pluginId)
            await this.doRefreshPlugins()
          }
        }
        return {
          success: false,
          pluginId,
          rolledBack,
          error: `Updated "${pluginId}" to ${entry.version} but it is blocked (${blocked}); `
            + (rolledBack
              ? 'rolled back to the previous version'
              : 'automatic rollback failed — reinstall the previous version manually'),
        }
      }
      return { success: true, pluginId, version: entry.version }
    })
  }

  /**
   * 已装版本(node_modules/<pkg>/package.json)vs 市场索引版本 ——
   * 设置页"有更新"徽标的数据源。纯查询,不进互斥锁。
   */
  async checkPluginUpdates(): Promise<CorePluginUpdateOffer[]> {
    if (!this.host.fetchPluginMarketIndex) return []
    const index = await this.host.fetchPluginMarketIndex()
    if (!index) return []
    const offers: CorePluginUpdateOffer[] = []
    for (const [id, info] of this.plugins) {
      // 内置插件没有更新通道(它和 app 同一份构建)。
      if (info.definition.source === 'builtin') continue
      const current = info.definition.manifest.version ?? '0.0.0'
      const update = findPluginUpdate(index, id, current)
      if (update) offers.push({ pluginId: id, current, latest: update.latest })
    }
    return offers
  }

  abortRequest(requestId: string): boolean {
    return this.requests.abort(requestId)
  }

  /** 某插件当前登记的 action 列表(设置页/调试用)。 */
  getRequestActions(pluginId: string): string[] {
    return [...(this.pluginStates.get(pluginId)?.requestHandlers?.keys() ?? [])]
  }

  /**
   * 逐插件隔离加载。
   *
   * 原先是 `for (…) await loadPlugin(def)`:一个 entry 挂住,排在它后面的插件
   * 全部装不上,连带把明文排在 plugin bootstrap 之后的 skills 一起卡死。现在
   * 每个插件各跑各的(各自带 entry 超时),一个坏插件只坏自己。
   *
   * 先按扫描顺序占位再并行加载 —— Map 的插入序即 UI 的展示序,不能被竞速打乱。
   */
  async refreshPlugins(): Promise<void> {
    // 单飞。
    //
    // 一轮 refresh 里带 npm install 的插件会占住最长 120s 的窗口;这段时间里
    // 再来一次 refresh(设置页的 Refresh 按钮、启用某插件)就会对同一个目录并发
    // 跑 npm install,而旧那一轮迟到的 loadPlugin 还会把 state 写进新一轮的表 ——
    // 事件订阅从此双份。第二个调用者直接复用在飞的那一次。
    if (this.refreshInFlight) return this.refreshInFlight

    // finally 里要**认自己**再清槽位:shutdown 会把 refreshInFlight 置 null,
    // 若随后的 initialize 已经开了新的一轮,旧那次的 finally 会把**新**那次的
    // 槽位清掉 —— 去重失效,两轮 refresh 并发跑同一个目录。
    const inFlight: Promise<void> = this.doRefreshPlugins().finally(() => {
      if (this.refreshInFlight === inFlight) this.refreshInFlight = null
    })
    this.refreshInFlight = inFlight
    return inFlight
  }

  private async doRefreshPlugins(): Promise<void> {
    this.disposeAll()
    this.plugins.clear()
    // 代次推进:这一轮之前发出的 loadPlugin 迟到回来时会看到代次已变,自行退场。
    const generation = ++this.generation

    this.host.ensurePluginDirs()
    const definitions = this.host.scanPlugins()

    this.log.debug(`[PluginManager] Found ${definitions.length} plugin(s)`)

    for (const def of definitions) {
      this.plugins.set(def.id, { definition: def, loaded: false, commands: [] })
    }

    // 孤儿数据在加载之前扫:手删 `<store>/plugins/<id>/` 是真实存在的卸载路径,
    // 宿主对它零感知,数据就永远躺在 plugin-data 里。
    //
    // 所有权判定**与"能否加载"解耦**:源目录还在就是有主,哪怕 entry 缺失、
    // plugin.json 坏了、或者它是个 symlink。只有源目录真的没了才算无主。
    try {
      const scan = this.host.getPluginSourceScan?.() ?? { trusted: true, presentEntryNames: [] }
      const known = new Set<string>([
        ...definitions.map(def => def.id),
        ...scan.presentEntryNames,
      ])
      const archived = this.host.archiveOrphanPluginData?.({
        knownPluginIds: [...known],
        scanTrusted: scan.trusted,
        userPluginCount: definitions.filter(def => def.source !== 'builtin').length,
      }) ?? []
      if (archived.length > 0) {
        this.log.debug(`[PluginManager] Archived orphaned plugin data: ${archived.join(', ')}`)
      }
      if (!scan.trusted) {
        this.log.error(
          `[PluginManager] Plugin directory scan is not trustworthy (${scan.reason ?? 'unknown'}); `
          + 'skipped orphaned-data archiving this round.',
        )
      }
    } catch (error) {
      this.log.error('[PluginManager] Orphan plugin data scan failed:', undefined, error)
    }

    await Promise.all(definitions.map(def => this.loadPlugin(def, generation)))
  }

  getPlugins(): Array<CorePluginInfo<TEntry, TDefinition>> {
    return Array.from(this.plugins.values()).map(info => {
      const health = this.host.getPluginHealth?.(info.definition.id)
      return health ? { ...info, health } : info
    })
  }

  getPluginCommands(): Map<string, TCommand> {
    const all = new Map<string, TCommand>()
    for (const state of this.pluginStates.values()) {
      for (const [name, command] of state.commands) {
        all.set(name, command)
      }
    }
    return all
  }

  getCommandHandler(commandName: string): TCommand | undefined {
    for (const state of this.pluginStates.values()) {
      if (state.commands.has(commandName)) {
        return state.commands.get(commandName)
      }
    }
    return undefined
  }

  shutdown(): void {
    // 闩 + 推进代次:在飞的加载回来时一律作废,不许再落表。
    this.shuttingDown = true
    this.generation += 1
    // 在飞的 refresh 不再被复用,也不再有人等它;它自己的写回会被闩挡掉。
    this.refreshInFlight = null
    this.loadTokens.clear()
    this.disposeAll()
    this.plugins.clear()
  }

  protected getPluginState(pluginId: string): TState | undefined {
    return this.pluginStates.get(pluginId)
  }

  protected setPluginInfo(pluginId: string, info: CorePluginInfo<TEntry, TDefinition>): void {
    this.plugins.set(pluginId, info)
  }

  private async loadPlugin(def: TDefinition, generation = this.generation): Promise<void> {
    // 领一个加载号:同一个插件后发起的加载会拿到更大的号,先发起的那次在写回时
    // 发现自己已被超过,就自己拆掉而不是盖上去。
    const loadToken = (this.loadTokens.get(def.id) ?? 0) + 1
    this.loadTokens.set(def.id, loadToken)

    /** 旧一轮迟到的加载不许写进新一轮的表。 */
    const stale = (): boolean => {
      if (this.shuttingDown) {
        this.log.debug(`[PluginManager] Dropping load of "${def.id}": the plugin system is shutting down`)
        return true
      }
      if (generation === this.generation) return false
      this.log.debug(`[PluginManager] Dropping stale load of "${def.id}" (generation ${generation} → ${this.generation})`)
      return true
    }

    if (!def.enabled) {
      if (stale()) return
      this.plugins.set(def.id, {
        definition: def,
        loaded: false,
        commands: [],
      })
      return
    }

    // 声明层闸门:非法 contributes / minAppVersion 不满足 —— 一行插件代码都不跑。
    if (def.loadBlockedReason) {
      this.log.error(`[PluginManager] Plugin "${def.id}" blocked: ${def.loadBlockedReason}`)
      this.plugins.set(def.id, {
        definition: def,
        loaded: false,
        commands: [],
        error: def.loadBlockedReason,
      })
      return
    }

    this.log.debug(`[PluginManager] Loading plugin: ${def.id}`)

    const entryTimeoutMs = this.options.entryTimeoutMs ?? CORE_PLUGIN_ENTRY_TIMEOUT_MS
    let entry: TEntry | null = null
    try {
      // **模块加载也要进预算。**
      //
      // 只包 entry(api) 是不够的:插件模块顶层写一句 `await new Promise(()=>{})`,
      // 挂住的是 `import()` 本身,refreshPlugins 的 Promise.all 于是永不 settle,
      // bootstrapPluginSystem 挂死,排在它后面的 skills 永不初始化 —— 正是这一期
      // 声称治好的那个病。
      //
      // 预算是固定的 entry 预算:运行时依赖安装已随 legacy 目录插件一起退役
      // (npm 形态的包自带全部依赖),加载期不再有分钟级的合法慢路径。
      entry = await runWithPluginTimeout(
        `load:${def.id}`,
        entryTimeoutMs,
        () => this.host.loadPluginEntry(def, this.reloadTokens.get(def.id) ?? 0),
      )
    } catch (error) {
      if (stale()) return
      this.log.error(`[PluginManager] Plugin "${def.id}" module load failed:`, undefined, error)
      this.plugins.set(def.id, {
        definition: def,
        loaded: false,
        commands: [],
        error: error instanceof Error ? error.message : 'Failed to load entry module',
      })
      return
    }

    if (stale()) return

    if (!entry) {
      this.plugins.set(def.id, {
        definition: def,
        loaded: false,
        commands: [],
        error: 'Failed to load entry module',
      })
      return
    }

    if (!this.context) {
      this.plugins.set(def.id, {
        definition: def,
        loaded: false,
        commands: [],
        error: 'Plugin manager is not initialized',
      })
      return
    }

    const { api, state } = this.host.createPluginAPI(def.id, this.context)
    try {
      // entry(api) 无超时是"一个坏插件卡住整队"的最后一环。超时不取消插件那一
      // 侧的工作,但宿主不再等它 —— 晚到的注册由 state 的 disposed 闸拦住。
      await runWithPluginTimeout(
        `entry:${def.id}`,
        entryTimeoutMs,
        () => entry!(api),
      )

      if (stale()) {
        this.host.disposePlugin(state)
        return
      }
      // 被更晚的一次加载超过了:那一次已经(或即将)落表,这一份必须自己拆掉,
      // 否则就是一个谁也不认识、谁也不会 dispose 的孤儿。
      if (this.loadTokens.get(def.id) !== loadToken) {
        this.log.debug(`[PluginManager] Dropping superseded load of "${def.id}"`)
        this.host.disposePlugin(state)
        return
      }
      // 落表前复查最新的启停意图:这一轮 refresh 在飞期间用户可能把它关了,
      // 直接落表会得到一个 enabled=false 却 loaded=true 的插件。
      // 注意读的是表里那份 info(可能与 def 是同一个对象,也可能已被替换),
      // 不是函数入口处那个已被 TS 收窄为 true 的 def.enabled。
      if (this.plugins.get(def.id)?.definition.enabled === false) {
        this.log.debug(`[PluginManager] Plugin "${def.id}" was disabled while loading; dropping the load`)
        this.host.disposePlugin(state)
        return
      }

      // 兜底:万一还是有人占着这个位置,先把它拆掉再覆盖 —— Map.set 静默覆盖
      // 的那一份不会有任何人再来 dispose。
      const previous = this.pluginStates.get(def.id)
      if (previous && previous !== state) {
        this.log.error(`[PluginManager] Replacing an orphaned state for "${def.id}"`, undefined)
        try {
          this.host.disposePlugin(previous)
        } catch (error) {
          this.log.error(`[PluginManager] Error disposing orphaned state for "${def.id}":`, undefined, error)
        }
      }
      this.pluginStates.set(def.id, state)
      this.plugins.set(def.id, {
        definition: def,
        loaded: true,
        commands: Array.from(state.commands.keys()),
      })

      // 版本进这一行:排障时"装没装上"和"装的是哪一版"是同一个问题,
      // 少了版本号就得回去翻账本才能判断新包到底生效没有。
      const version = def.manifest.version ? `@${def.manifest.version}` : ''
      this.log.debug(
        `[PluginManager] Plugin "${def.id}${version}" loaded successfully (${state.commands.size} commands)`,
      )
    } catch (error) {
      this.log.error(`[PluginManager] Plugin "${def.id}" failed:`, undefined, error)
      // 装到一半的注册要收掉,否则失败的插件仍在工具表/事件总线上留着半截足迹。
      // dispose 同时落下 disposed 闩:超时后恢复的 entry 再注册也进不来了。
      try {
        this.host.disposePlugin(state)
      } catch (disposeError) {
        this.log.error(`[PluginManager] Error disposing half-loaded plugin "${def.id}":`, undefined, disposeError)
      }
      if (stale()) return
      this.plugins.set(def.id, {
        definition: def,
        loaded: false,
        commands: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  private disposeAll(): void {
    // refresh / shutdown 也要清登记簿:否则在飞请求会在一个已经被拆掉的插件里
    // 跑完,再把结果发回给调用方(disablePlugin 那条路径早就 abortForPlugin 了,
    // 这条路径此前是漏的)。
    const aborted = this.requests.abortAll()
    if (aborted > 0) {
      this.log.debug(`[PluginManager] Aborted ${aborted} in-flight plugin request(s) during teardown`)
    }
    for (const [id, state] of this.pluginStates) {
      try {
        this.host.disposePlugin(state)
      } catch (error) {
        this.log.error(`[PluginManager] Error disposing plugin "${id}":`, undefined, error)
      }
    }
    this.pluginStates.clear()
  }
}

export class CorePluginBootstrapper<TManager, TContext> {
  private bootstrapped = false
  private manager: TManager | null = null

  constructor(private readonly options: CorePluginBootstrapperOptions<TManager, TContext>) {}

  async bootstrap(context: TContext): Promise<TManager> {
    if (this.bootstrapped && this.manager) {
      return this.manager
    }

    this.options.ensurePluginDirs?.()
    const manager = this.options.createManager()
    this.manager = manager
    this.bootstrapped = true

    try {
      await this.options.initializeManager(manager, context)
    } catch (error) {
      this.options.logger?.error?.('[PluginManager] Bootstrap failed:', undefined, error)
    }

    return manager
  }

  getManager(): TManager | null {
    return this.manager
  }

  isBootstrapped(): boolean {
    return this.bootstrapped
  }

  resetForTests(): void {
    this.bootstrapped = false
    this.manager = null
  }
}
