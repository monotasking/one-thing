/**
 * The product assembly factory: the single recipe that turns the @onething/backend
 * subsystems into a running onething backend.
 *
 * Every host (Electron desktop, React shell, CLI daemon, headless server) boots
 * through this recipe instead of hand-sequencing the initialize* steps — the
 * ordering constraints (variables before tools, engine before Permission, …)
 * live here and nowhere else. Host-specific surfaces arrive as one object
 * (`options.host`, see `host-ports.ts`) and through the hooks below; importing
 * this module (or any @onething/backend module) performs no configuration by
 * itself.
 *
 * A2(`docs/design/backend-composition-root-2026-09.md`):装配产物是一只
 * `OnethingBackend` **实例**的字段,不再是散在三个模块里的 `let`;关机是那只
 * 实例的 `dispose()`,而 `dispose()` 跑的是装配途中 `own()` 登记下来的清单 ——
 * 不再手抄第二份。一个进程里已有活实例时再装配一次,`assemble` 第一行就抛
 * `BackendAlreadyAssembledError`。
 */
import { initializeStores, flushAllPendingSaves } from './store.js'
import { flushSessionEventLedger } from './session/event-log.js'
import { scheduleSessionBlobGcOnStartup } from './session/blob-gc.js'
import { scheduleSessionListProjectionBackfillOnStartup } from './session/list-projection-backfill.js'
import { getSettings, initializeSettings } from './stores/settings.js'
import { applyDiagnosticsMode } from './wiring/logging/diagnostics.js'
import { initializeAgents } from './wiring/agents/index.js'
import { configureAppToolSandbox } from './wiring/tools/core/sandbox.js'
import { applyHostPorts, type OnethingHostPorts } from './host-ports.js'
import { configureAppBackgroundJobs } from '@onething/runtime/tools/background-jobs-bound'
import { configureAppProviderRegistry } from './wiring/providers/index.js'
import { configureAppSpaceCredentialsCrypto } from './wiring/providers/space-credentials.js'
import {
  migrateProviderConfigToDefaultSpace,
  upgradeSpaceCredentialsEncryptionAtRest,
} from './wiring/providers/space-config-migration.js'
import { configureAppPluginCredentialStrategyHost } from './wiring/providers/credential-strategy.js'
import { configureAppScheduler } from '@onething/runtime/scheduler/scheduler-bound'
import { configureAppRipgrep } from './utils/ripgrep.js'
import { configureAppSearchProviders } from './wiring/search/providers.js'
import { configureAppSkillManage } from './wiring/skills/manage.js'
import { configureAppSkillsLoader } from './wiring/skills/loader.js'
import { configureAppPermissionGrants } from './wiring/permission/permission-grants.js'
import { createEventSystem } from './events/index.js'
import { createSessionLayer } from './session/index.js'
import {
  installSessionPermissionEventRecorders,
  uninstallSessionPermissionEventRecorders,
} from './session/permission-events.js'
import {
  installSessionLedgerEventBroadcaster,
  uninstallSessionLedgerEventBroadcaster,
} from './session/event-broadcast.js'
import { createStreamEngineLayer, type MainOnethingRuntime } from './wiring/engine/index.js'
import type { PermissionMode } from '@shared/ipc.js'
import type { BindableStreamSender, StreamEngine } from './wiring/engine/stream-engine-bound.js'
import { registerBuiltinTriggers } from './wiring/engine/triggers/index.js'
import { initializeCollabV3Runtime, shutdownCollabV3Runtime } from './wiring/collab/index.js'
import { Permission } from './wiring/permission/index.js'
import { Interaction } from '@onething/core/interaction'
import { bootstrapVariableSystem } from './wiring/variables/index.js'
import { bootstrapGoalStreamBreakers } from './wiring/goals/runtime-hooks.js'
import { bootstrapProjectDirs } from './wiring/project-dirs/index.js'
import { configureToolkitMCPCapabilitiesChangedHandler } from '@onething/runtime/mcp/capabilities-changed'
import { buildToolkitCatalog, refreshToolkitMcpTools } from './wiring/toolkit/wiring.js'
import { registerAppRpcDomains } from './rpc/index.js'
import { initializeSessionSkills } from './wiring/skills/session-skills.js'
import { MCPManager, registerMCPTools } from '@onething/runtime/mcp/index.wiring'
import { DEFAULT_MCP_SETTINGS } from '@onething/core/mcp'
import { ACPManager } from '@onething/runtime/acp'
import { killTrackedDetachedChildren } from '@onething/runtime/tools/bash-executor'
import { killAllTerminals } from '@onething/runtime/terminal/service.wiring'
import { configureSessionHistoryBuilder, type SessionHistoryBuilder } from './session/reads.js'
import { buildHistoryMessages, historyProjectionRecipe } from './wiring/engine/stream/message-helpers.js'
import { getLogger } from './wiring/logging/index.js'
import {
  BackendAlreadyAssembledError,
  getCurrentBackendSafe,
  requireBackendField,
  setCurrentBackend,
  type BackendHandle,
  type BackendHandleParts,
} from './current.js'
import type { EventBus } from './events/event-bus.js'
import type { StreamChannel } from './events/stream-channel.js'
import type { SessionManager } from '@onething/core/session'

const log = getLogger('app.backend')


/**
 * Wire the runtime-package adapters that used to be import-time side effects.
 * Explicit and idempotent: hosts (and tests) may call it directly; the
 * factory always runs it first.
 */
export function configureAppRuntimeAdapters(): void {
  configureAppToolSandbox()
  configureAppBackgroundJobs()
  configureAppProviderRegistry()
  configureAppSpaceCredentialsCrypto()
  configureAppPluginCredentialStrategyHost()
  configureAppScheduler()
  configureAppRipgrep()
  configureAppSearchProviders()
  configureAppSkillManage()
  configureAppSkillsLoader()
  configureAppPermissionGrants()
  // S2b step C:`sliceForHistory` 的模型历史构造。两条路都用真机那份历史构造
  // (消息侧 `buildHistoryMessages`、事件侧 `historyProjectionRecipe` →
  // `projectModelHistory`),但它们身后是整棵 provider 树,`reads.ts` 不能静态
  // 引用(会拖垮上游轻量单测),所以在这里装进读门面。
  const sessionHistoryBuilder: SessionHistoryBuilder = {
    fromMessages: (messages, session) => buildHistoryMessages([...messages], session),
    recipe: session => historyProjectionRecipe(session),
  }
  configureSessionHistoryBuilder(sessionHistoryBuilder)
}

/**
 * 宿主插进装配序列里的三步。
 *
 * A3:三个钩子都**收到那只正在装配的实例**作为参数。理由是关机对称
 * (方案 §2.4「谁起的,谁 `own()`」):钩子里起的东西(桌面的 todo / 草稿纸
 * watcher)也得有地方登记收尾,而钩子跑的时候 `createOnethingBackend(...)`
 * **还没返回**,宿主自己那个 `let desktopBackend` 还是 null —— 拿不到实例就
 * 只能把收尾再手抄一份到别处,而那正是这一期要消掉的东西。
 *
 * 参数是**实例本身**而不是一个窄的 `{ own }`:钩子里已经有人在读装配产物
 * (`getEventBus()` / `getStreamEngine()`),把整只交出去让那些读法有朝一日
 * 能改成显式的 `backend.eventBus`,而不是又多一个只能 own 的把手。
 */
export interface OnethingBackendHooks {
  /** Runs right after settings are loaded (desktop: shortcuts, network proxy). */
  afterSettings?: (backend: OnethingBackend) => void | Promise<void>
  /** Runs after the engine + triggers are up, before Permission/tools. */
  afterEngine?: (backend: OnethingBackend) => void | Promise<void>
  /** Runs after the tool registry is ready (desktop: IPC, todo watcher). */
  afterTools?: (backend: OnethingBackend) => void | Promise<void>
}

export interface OnethingBackendOptions {
  /**
   * 这个宿主交出来的**全部**宿主独有能力(A1,`host-ports.ts`)。必填,且每一
   * 项都要写 —— 没有那件能力就显式 `null`。漏写一项是 `tsc` 错误,不是运行期
   * 某个能力静默变成降级路。
   */
  host: OnethingHostPorts
  /**
   * 'full' registers every builtin tool (desktop); 'headless' the reduced set;
   * 'readonly' only tools with zero local side effects (server degradation).
   */
  toolRegistry?: 'full' | 'headless' | 'readonly'
  /** Initialize promptVersion from the minimal prompt scene (evals stamping). */
  promptVersion?: boolean
  /** Load session skills during assembly (hosts deferring to plugin bootstrap skip this). */
  sessionSkills?: boolean
  /**
   * Multi-agent collab rooms (docs/design/multi-agent-collab.md): coordinator +
   * roster prompt provider. Desktop opts in; headless hosts without room UI
   * leave it off — the room ingress gate still refuses uncoordinated streams.
   */
  collab?: boolean
  /** Initialize MCP + ACP inline during assembly (hosts may instead do it post-window). */
  mcpAcp?: boolean
  /** Engine sender to bind; hosts that observe the EventBus directly can omit it. */
  sender?: BindableStreamSender
  hooks?: OnethingBackendHooks
}

/**
 * 装配的产物 —— 一只实例,不再是一张摊在模块全局里的桌子。
 *
 * 五个字段是 **getter**:装配把自己第一时间装进进程当前实例槽(方案 §5 风险 1
 * —— `installSessionLedgerEventBroadcaster()` / `registerBuiltinTriggers()` /
 * `createMainStreamEngineRuntime()` 都在装配**中途**调 `getEventBus()`),而还
 * 没建到的那一格读起来抛 `BackendNotAssembledError('engine')`,与 A2 之前
 * "未初始化就抛"逐字同义。
 */
export class OnethingBackend implements BackendHandle {
  private readonly parts: BackendHandleParts = {}
  private readonly disposers: Array<{ label: string; run: () => void | Promise<void> }> = []
  private disposing: Promise<void> | null = null

  readonly options: Readonly<OnethingBackendOptions>

  private constructor(options: OnethingBackendOptions) {
    this.options = options
  }

  get eventBus(): EventBus {
    return requireBackendField(this.parts, 'eventBus')
  }

  get streamChannel(): StreamChannel {
    return requireBackendField(this.parts, 'streamChannel')
  }

  get sessionManager(): SessionManager {
    return requireBackendField(this.parts, 'sessionManager')
  }

  get engine(): StreamEngine {
    return requireBackendField(this.parts, 'engine')
  }

  get runtime(): MainOnethingRuntime {
    return requireBackendField(this.parts, 'runtime')
  }

  /**
   * 谁起了一件会留尾巴的东西,谁把收尾登记进来。`dispose()` 按**登记逆序**跑。
   *
   * 宿主在装配之后起的东西(内嵌 HTTP 面、用户调度器、todo/草稿纸 watcher、
   * MCP)也从这个口登记 —— 那是 A3 的活,A2 只把口开出来。
   */
  own(disposer: () => void | Promise<void>, label = 'anonymous'): void {
    this.disposers.push({ label, run: disposer })
  }

  /**
   * 幂等;逆序跑完 `own()` 登记的全部 disposer,再清掉进程当前实例槽。
   *
   * 每个 disposer 单独 try/catch 并记 error:一个失败不许挡住后面的 —— 关机链
   * 上排在最后的是**落盘**,让它被前面某个 shutdown 的异常吞掉是这条链最坏的
   * 失败形态。
   */
  async dispose(): Promise<void> {
    if (this.disposing) return this.disposing
    this.disposing = (async () => {
      for (let i = this.disposers.length - 1; i >= 0; i -= 1) {
        const disposer = this.disposers[i]!
        try {
          await disposer.run()
        } catch (error) {
          log.error('backend disposer failed', { step: disposer.label }, error)
        }
      }
      this.disposers.length = 0
      // 只清自己那一格:别人已经装了新实例的话,清掉等于替他关门。
      if (getCurrentBackendSafe() === this) setCurrentBackend(null)
    })()
    return this.disposing
  }

  /**
   * 已登记的收尾标签,**登记序**(`dispose()` 按它的逆序跑)。
   *
   * 只读快照,给两类调用方:A0 的生命周期门要断言"宿主起的那几件真的登记进来了"
   * (`process.getActiveResourcesInfo()` 数定时器在满载 vitest 下抖得没法当判据,
   * 见 `assembly-lifecycle.test.ts` ⑨),以及排障时想知道这只实例到底owned了什么。
   * 返回的是拷贝 —— 没人能从这里改清单。
   */
  ownedLabels(): readonly string[] {
    return this.disposers.map(disposer => disposer.label)
  }

  /** @deprecated 过渡别名 = `dispose()`。 */
  async shutdown(): Promise<void> {
    return this.dispose()
  }

  static async assemble(options: OnethingBackendOptions): Promise<OnethingBackend> {
    // 第一行就拒。A2 之前这条路静默返回第一份,而整次装配还是会在第 31 步
    // (RPC 域的重复挂载守卫)炸掉 —— 那时前 30 步已经又跑了一遍且不可回滚。
    if (getCurrentBackendSafe()) throw new BackendAlreadyAssembledError()

    const backend = new OnethingBackend(options)
    // 装配**中途**就得可见(方案 §5 风险 1)。
    setCurrentBackend(backend)
    try {
      await backend.assembleSteps()
      return backend
    } catch (error) {
      // 失败的装配不许在进程里留下一个半死的槽:逆序跑掉已经登记的收尾,清槽,
      // 再把**原来那个**错误抛出去(`dispose()` 自己每步 try/catch,不会盖掉它)。
      await backend.dispose()
      throw error
    }
  }

  private async assembleSteps(): Promise<void> {
    const options = this.options
    configureAppRuntimeAdapters()
    // 宿主能力先落位:它们是**输入**,装配的每一步都可能读到(sandbox 在工具目录
    // 之前、auth 在凭证升级之前、storePath 在 docs 目录之前)。一次性交出来的好处
    // 就在这里 —— 顺序问题只有这一个答案:全部,在最前面。
    //
    // B3 起 `applyHostPorts` 返回一个还原函数,里面只有 `localTrust` 那一格
    // (它是十五格里唯一带 restore 的端口;其余都是没有 restore 的单槽覆盖)。
    // 登记在这里 = dispose 之后这个进程回到"没有宿主声明过本机可信"。
    this.own(applyHostPorts(options.host), 'hostPorts')

    initializeStores()
    /*
     * 落盘是关机链上的**最后**两步,所以它们是最先登记的两件(逆序)。
     *
     * 顺序:`flushAllPendingSaves` 排的是 messages.jsonl 的 300ms 节流队列;
     * 事件账本有**自己**的每会话写队列(§15.12(a)(b)),必须排在它之后 ——
     * 抄本停写之后那就是唯一持久化,退出那一刻队列里剩什么就丢什么。
     * 账本那一步自带 2s 时限,超时记一行 warn 不阻退出。
     */
    this.own(async () => {
      await flushSessionEventLedger()
    }, 'flushSessionEventLedger')
    this.own(() => flushAllPendingSaves(), 'flushAllPendingSaves')

    await initializeSettings()
    // 「诊断模式」是设置里的一格,但生效面在日志系统(等级 spec + provider 转储)。
    // 落点就在读完 settings 的第一时间 —— 再晚一点,启动期的 debug 行就已经被
    // 默认等级滤掉了。之后每次保存设置由 `stores/settings.ts` 的同一个函数续上。
    applyDiagnosticsMode(getSettings().diagnostics?.enabled === true)
    // provider 配置迁进空间层(C1)。位置是**刚读完 settings、任何人问「这个
    // provider 配了没有」之前** —— 引擎、工具、插件都会问,而迁移之前那个答案
    // 还在旧形状里。幂等:标记在就是一次同步返回。迁移失败不写标记、不清旧字段,
    // 下次启动重跑;把整次装配拖垮才是更坏的结果,所以这里只记不抛。
    try {
      await migrateProviderConfigToDefaultSpace()
    } catch (error) {
      log.error('provider config migration failed, will retry next boot', {}, error)
    }
    // 盘上遗留的**明文**凭证池升级成密文(2026-08-31)。排在迁移之后:这一次真的
    // 迁了的话写出去的本来就是密文,这一步看一眼就过。它救的是雷已经炸过的机器
    // ——「没有加密能力的进程抢先当了 core」留下的 `encryption: 'none'`,以及
    // B3~B7 时期的无信封老明文。没有加密能力的宿主整个跳过(不会反向降级)。
    try {
      upgradeSpaceCredentialsEncryptionAtRest()
    } catch (error) {
      log.error('credentials re-encryption failed, will retry next boot', {}, error)
    }
    // Agents are read on every turn (and once per room member); warm the cache
    // here so nothing downstream pays a synchronous read + normalize.
    await initializeAgents()
    await options.hooks?.afterSettings?.(this)

    const { eventBus, streamChannel } = createEventSystem()
    this.parts.eventBus = eventBus
    this.parts.streamChannel = streamChannel
    this.own(() => {
      eventBus.shutdown()
      streamChannel.shutdown()
      log.info('event system shut down')
    }, 'eventSystem')

    const sessionLayer = createSessionLayer(eventBus, streamChannel)
    this.parts.sessionManager = sessionLayer.sessionManager
    this.own(() => sessionLayer.dispose(), 'sessionLayer')

    // B 期(§17.8):写入口每落一条事件,原样在总线上广播一份 —— 桌面 IPC 与
    // web SSE 都观察总线,于是"两个传输同步"是构造性的。必须在事件系统之后
    // (它要 `getEventBus()`),在任何一条事件被写下之前。
    installSessionLedgerEventBroadcaster()
    this.own(() => uninstallSessionLedgerEventBroadcaster(), 'sessionLedgerBroadcaster')

    const engineLayer = createStreamEngineLayer({ eventBus, streamChannel })
    this.parts.engine = engineLayer.engine
    this.parts.runtime = engineLayer.runtime
    /*
     * A3(方案 §2.5,(b) 类闩):内置触发器注册返回 disposer。
     *
     * `triggerManager` 是模块级单例,三只触发器里握着这一份装配的引擎与总线。
     * 从前那个单向闩让"装配 → dispose → 再装配"只在第一份里注册过 —— 第二份
     * 跑的是第一份的尸体。登记在这里(而不是并进下面那处显式反序块):触发器是
     * 被动的,谁先谁后都不影响关机语义。
     */
    this.own(registerBuiltinTriggers(), 'builtinTriggers')

    if (options.promptVersion) {
      // promptVersion stamps eval traces with the live minimal-scene output so
      // recorded incidents replay against the prompt that actually shipped.
      try {
        const { initPromptVersion, buildOnethingSystemPrompt } = await import('@onething/runtime')
        const { system, developer } = await buildOnethingSystemPrompt({ hasTools: false, skills: [] })
        initPromptVersion([system, ...developer].filter(Boolean).join('\n\n'))
      } catch (error) {
        log.warn('prompt version init failed', {}, error)
      }
    }

    await options.hooks?.afterEngine?.(this)

    Permission.initialize(
      eventBus,
      sessionId => engineLayer.engine.getChannel(sessionId),
      // 引擎归位到产品层之后返回裸 `string`(产品层读不到 @shared 的 `PermissionMode`
      // 联合);跨进程词汇的收敛点就在装配层这一行。
      sessionId => engineLayer.engine.getPermissionMode(sessionId) as PermissionMode,
    )

    // 提问链与审批链是两条并列的等待链,同一个接入点、同一个通道解析器
    // (claude-code-integration-v2 §4)。同样要求 engine 先在位——targetChannel
    // 是 ask 当场从 engine 取的。
    Interaction.initialize(
      eventBus,
      sessionId => engineLayer.engine.getChannel(sessionId),
    )

    // S1a(session-event-sourcing §10.2 的"权限/交互层"):两条等待链的时刻与
    // 决定进会话事件日志。必须在两个 initialize 之后 —— 它接的是同一对单例。
    installSessionPermissionEventRecorders()
    // A3:`uninstall*` 自 S1a 起就存在却零调用者 —— 它把 core 那两个 recorder
    // 槽置回 null。不摘的后果:dispose 之后 `Permission`/`Interaction`(core 的
    // 进程级单例,不随 backend 走)手里还攥着指向**已关掉的**事件账本的回调,
    // 而第二份装配会用自己的那对把它们盖掉,于是这条只在"关了但还没再装"的
    // 窗口里咬人 —— 正是最难查的那种。
    this.own(() => uninstallSessionPermissionEventRecorders(), 'sessionPermissionRecorders')

    /*
     * 三件的登记**放在一处并显式反序**,而不是各自"起的那一行紧接着 own()"。
     *
     * 理由是逆序登记登不出今天的关机顺序:引擎建在 Permission / Interaction
     * **之前**,而关机链是「引擎 → Permission → Interaction」。A2 只改"这份
     * 清单由谁记",不改关机语义,所以这里显式把三件按今天的顺序反着登记进去,
     * `dispose()` 跑出来与 A2 之前逐字相同。
     */
    this.own(() => Interaction.shutdown(), 'interaction')
    this.own(() => Permission.shutdown(), 'permission')
    this.own(() => engineLayer.dispose(), 'streamEngine')

    // Variables must precede the tool registry (the variable tool reads a
    // populated registry); goal breakers and project dirs are order-free but
    // belong before the first stream.
    // A3:三件都改成"注册返回 disposer"(方案 §2.5)。变量注册表撞 id 会抛
    // PROVIDER_CONFLICT、目标断路器的五条订阅挂在这一份的总线上 —— 闩放回去而
    // 不摘干净,第二次装配不是"重跑"而是"抛错"或"挂在死总线上"。
    this.own(bootstrapVariableSystem(), 'variableSystem')
    this.own(bootstrapGoalStreamBreakers(), 'goalStreamBreakers')
    this.own(bootstrapProjectDirs(), 'projectDirs')

    // 缝 4 —— 三档目录。R4b 之后它是**唯一**一本工具册子(旧注册表已删)。
    //
    // `feature_*` 与插件工具**不在这里**:前者由 self-evolution feature 在 mount 时
    // 自己装进目录,后者由 `api.registerTool` 装 —— 两者的寿命都不是"一档目录"的寿命。
    buildToolkitCatalog(options.toolRegistry ?? 'headless')
    // §13.7 裁定 5:服务器工具面变了就重算目录。挂在既有的唯一通知点上,
    // 不顶掉宿主自己那个 handler(它注册的是另一个口子)。
    configureToolkitMCPCapabilitiesChangedHandler(() => refreshToolkitMcpTools())

    /*
     * 工具跑出去的进程要收回来。挂在工具目录这一步:没有目录就没有工具,也就
     * 没有这两件尾巴。两条都是"没起过就是 no-op",所以无条件登记。
     * (登记顺序反着写 —— 关机链上是 `killTrackedDetachedChildren` 先、
     * `killAllTerminals` 后。)
     */
    this.own(() => killAllTerminals(), 'killAllTerminals')
    this.own(() => killTrackedDetachedChildren(), 'killTrackedDetachedChildren')

    // RPC domains go up BEFORE afterTools: that hook is where the Electron host
    // runs initializeIPC() and mounts the `rpc:invoke` adapter, so the table it
    // dispatches into must already be complete. Registration itself is pure
    // bookkeeping (closures into a Map) — the handlers resolve their
    // dependencies lazily, per call.
    const disposeRpcDomains = await registerAppRpcDomains()

    await options.hooks?.afterTools?.(this)

    if (options.sessionSkills) {
      await initializeSessionSkills()
    }

    if (options.collab) {
      // Room prompts are assembled as persona-only system prompts inside the
      // prompt build path (engine/prompt/system-prompt.ts collabRoomOverrides)
      // — no plugin prompt provider involved. Static import (top of file): a
      // dynamic import here left the collab modules bundled INSIDE the desktop
      // entry chunk (the ingress gate references them statically), and the CLI
      // daemon's dynamic load then pulled the whole electron entry into Node.
      //
      // D6-a(docs/design/collab-actor-v3.md §6):协作的生产路径从 v2 协调器换成
      // v3 actor 运行时。boot 里那一趟 marker 门控的迁移住在它里面 —— 单向门只有
      // 一个触发点,而这里是唯一一个会在启动时走到它的地方。
      //
      // `await`:迁移与房账续播都要落盘,而它们必须排在第一条用户消息之前 ——
      // 一间还没续播完的房收到 posted,会把上一条命没投完的广播与新消息交错投出去。
      await initializeCollabV3Runtime()
    }

    if (options.mcpAcp) {
      const settings = getSettings()
      await MCPManager.initialize(settings.mcp || DEFAULT_MCP_SETTINGS)
      await registerMCPTools()
      ACPManager.initialize(settings.acp || { enabled: true, agents: [] })
    }

    /*
     * ── 关机链的**头**六件,一处登记、显式反序 ──
     *
     * 这六件的关机顺序有真实约束,而那个顺序**不是**装配顺序的逆:
     *  · RPC 面第一个下(不再接新调用),但它建在第 31 步;
     *  · `abortAll` 必须排在 MCP/ACP 收摊**之前**(先停我们这侧的流,再拆它
     *    要用的服务器),而引擎建在第 14 步;
     *  · 插件与 MCP/ACP 在桌面上根本不是装配起的(宿主在窗口之后起),这里
     *    的登记是**无条件、幂等**的兜底 —— A3 会把它们交回各自的宿主 `own()`。
     * 所以这六件按今天 `shutdown()` 里的顺序反着登记在这一处,`dispose()` 跑
     * 出来与 A2 之前逐字相同。
     */
    this.own(async () => {
      /*
       * 插件系统必须在**事件系统之前**拆。
       *
       * 插件 dispose 会往总线上发 cleared(R6 的状态清扫)、发 catalog-changed;
       * 总线先关的话那些事件发进一个已经没人听的地方,而账本里留着记录。
       *
       * 动态 import:装配层的静态图里不该多一条只在收摊时才用得上的边
       * (`import-side-effect-free` 那条纪律)。
       */
      const plugins = await import('./wiring/plugins/manager.js')
      plugins.getPluginManager()?.shutdown()
    }, 'pluginManager')
    this.own(async () => {
      if (!options.mcpAcp) return
      await ACPManager.shutdown()
      await MCPManager.shutdown()
    }, 'mcpAcp')
    this.own(async () => {
      /**
       * 外部执行体跟着收摊(E4/G10)。`abortAll` 停的是我们这一侧的流,外部 agent
       * 的进程要它自己的 dispose 才会走 —— 漏了它,退出之后 CLI 子进程还活着。
       *
       * 无条件调:连接器是懒建的,没建过就是一次 no-op。桌面端另有一条
       * `shutdownACP` 也会调到它,dispose 本身幂等(表清空后再调直接返回)。
       */
      const externalAgents = await import('./wiring/external-agents/index.js')
      await externalAgents.disposeExternalAgentConnectors()
    }, 'externalAgents')
    this.own(() => engineLayer.engine.abortAll(), 'engineAbortAll')
    this.own(async () => {
      if (!options.collab) return
      await shutdownCollabV3Runtime()
    }, 'collab')
    // Reversible registration: a second assemble in the same process (tests,
    // host restarts) must not trip the duplicate-domain guard.
    this.own(() => disposeRpcDomains(), 'rpcDomains')

    if (options.sender) {
      engineLayer.engine.bind(options.sender)
    }

    // S3w-4:blob 孤儿的启动后延迟治理。**默认不跑** —— `ONETHING_SESSION_BLOB_GC`
    // 没设就直接返回 undefined,这一行在缺省档上是纯声明。定时器 unref,所以
    // 它自己留不住进程。
    const cancelBlobGc = scheduleSessionBlobGcOnStartup()
    this.own(() => cancelBlobGc?.(), 'sessionBlobGc')

    /*
     * E2:会话列表投影的**存量回填**。E 批把 `messageCount` / `lastMessagePreview`
     * 挂在写侧("不回填、下次写自愈"),对存量库等于功能不存在 —— 真机 439 条
     * 会话里 0 条带摘要格。这一趟把写侧本该留下的两格补上,读面纪律不动。
     *
     * 装在这里 = 两端都装:桌面与 standalone server 走的是同一个装配配方,而这
     * 件事属于装配层(它只关心"这个 store 的索引里缺格"),不是哪个宿主特有的。
     * 定时器 unref + 判据幂等,所以短命的 CLI daemon 顶多跑几条就随进程走。
     */
    const cancelListBackfill = scheduleSessionListProjectionBackfillOnStartup({
      // 正在流式中的会话本轮跳过:它的账本此刻在长,而写侧本来就会把格盖上。
      isSessionBusy: sessionId => engineLayer.engine.getActiveSessionIds().includes(sessionId),
    })
    this.own(() => cancelListBackfill?.(), 'sessionListBackfill')
  }
}

/**
 * 过渡别名。四个宿主的调用点先不改名 —— 改名是 A4 文档期顺手的事,而这一期
 * 已经动了 `backend.ts` 与四个宿主的关机路。
 */
export function createOnethingBackend(
  options: OnethingBackendOptions,
): Promise<OnethingBackend> {
  return OnethingBackend.assemble(options)
}
