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
import { initializeStores, flushAllPendingSaves, getSession } from './store.js'
import { acquireSessionEventLogStore, type SessionEventLogStoreHandle } from './session/event-log.js'
import { createStoreLease, getOnethingMediaIndexPath, getOnethingMediaImagesDir, getOnethingMediaFilesDir, getOnethingPetsDir, type StoreLease, type StoreLockOwner } from '@onething/runtime/storage'
import { MediaLibraryService } from '@onething/runtime/media'
import { configureMediaLibraryService } from '@onething/runtime/media/library-service-bound'
import { OnethingUsageLedger } from '@onething/runtime/usage'
import { configureUsageLedger, captureUsageRecorder } from './wiring/usage/index.js'
import { createCollabDigestStore, configureCollabDigestStore } from '@onething/runtime/collab/digest-store'
import { createCollabDigestRunner, type CollabDigestRunner } from './wiring/collab/digest-runner.js'
import { createCollabInspector, configureCollabInspector } from './wiring/collab/inspector.js'
import { PluginLlmService } from './wiring/plugins/llm.js'
import { CredentialStrategyService } from './wiring/providers/credential-strategy-lifetime.js'
import { disposeCredentialStrategyState } from './wiring/providers/credential-strategy.js'
import { TodoPlanRuntime } from './wiring/todo-plan/store.js'
import { BackendResources, type BackendShutdownPhase, type Quiescible } from './lifecycle.js'
import { PracticeService, configurePracticeService } from '@onething/runtime/practice/service.wiring'
import { MusicSubsystem } from './wiring/music/subsystem.js'
import { PetsSubsystem } from './wiring/pets/subsystem.js'
import { petChattinessOf, watchPetChattiness } from './wiring/pets/chattiness.js'
import { ModelMomentComposer } from './wiring/pets/model-composer.js'
import { createVoiceService, configureVoiceService } from './wiring/voice/service.js'
import { createTaskDispatchLayer, type TaskDispatchLayer } from './wiring/tasks/dispatch.js'
import { createSessionDeletionRecovery, type SessionDeletionRecovery } from '@onething/runtime/sessions'
import { getTracesDir } from '@onething/runtime/evals/trace-store'
import path from 'node:path'
import { scheduleSessionBlobGcOnStartup } from './session/blob-gc.js'
import { scheduleSessionListProjectionBackfillOnStartup } from './session/list-projection-backfill.js'
import { getSettings, initializeSettings, invalidateSettingsCache } from './stores/settings.js'
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
import { createSessionLayer, type SessionLayer } from './session/index.js'
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
import { createSessionTocTrigger } from './wiring/engine/triggers/session-toc.js'
import { initializeCollabV3Runtime, shutdownCollabV3Runtime } from './wiring/collab/index.js'
import { Permission } from './wiring/permission/index.js'
import { Interaction } from '@onething/core/interaction'
import { bootstrapVariableSystem } from './wiring/variables/index.js'
import { bootstrapGoalStreamBreakers } from './wiring/goals/runtime-hooks.js'
import { flushGoalRuntimeUsage, disposeGoalRuntimeState } from './wiring/goals/index.js'
import { bootstrapProjectDirs } from './wiring/project-dirs/index.js'
import { bootstrapNotes } from './wiring/notes/index.js'
import { bootstrapNoteVaultSkillRoots } from './wiring/skills/note-vault-roots.js'
import { migrateNotesSettings } from './wiring/notes/migration.js'
import type { NotesSubsystem } from './wiring/notes/index.js'
import { createAppSearchService } from './wiring/search/index.js'
import { configureToolkitMCPCapabilitiesChangedHandler } from '@onething/runtime/mcp/capabilities-changed'
import { buildToolkitCatalog, refreshToolkitMcpTools } from './wiring/toolkit/wiring.js'
import { createAppToolRunner, sessionWorkspaceRootFor } from './wiring/toolkit/runner.js'
import { createPermissionAuthorizer } from './wiring/toolkit/authorizer.js'
import { toolkitAuditSink } from './wiring/toolkit/audit-sink.js'
import {
  createResourceKernel,
  forwardResourceEventsToBus,
  mountBuiltinResources,
  mountMcpResources,
  syncResourceToolsIntoCatalog,
  ShellCommandDispatch,
  ShellMountRegistry,
} from './wiring/resource/index.js'
import type { ResourceKernel } from '@onething/core/resource'
import { ToolExecutionRegistry } from './wiring/toolkit/executions.js'
import { configureEvalsTaskOwner, EvalsTaskOwner } from './wiring/evals/task-owner.js'
import { registerAppRpcDomains } from './rpc/index.js'
import { initializeSessionSkills } from './wiring/skills/session-skills.js'
import { MCPManager, registerMCPTools } from '@onething/runtime/mcp/index.wiring'
import { DEFAULT_MCP_SETTINGS } from '@onething/core/mcp'
import { ACPManager } from '@onething/runtime/acp'
import { McpSubsystem } from './wiring/mcp/subsystem.js'
import { AcpSubsystem } from './wiring/acp/subsystem.js'
import { resolveExternalAgentSpawnEnv } from './wiring/external-agents/spawn-env.js'
import { killTrackedDetachedChildren } from '@onething/runtime/tools/bash-executor'
import { killAllTerminals } from '@onething/runtime/terminal/service.wiring'
import type { SessionHistoryBuilder } from './session/reads.js'
import { buildHistoryMessages, historyProjectionRecipe } from './wiring/engine/stream/message-helpers.js'
import { configureLogging, getLogger, shutdownAppLogging, type ConfigureLoggingOptions } from './wiring/logging/index.js'
import {
  BackendAlreadyAssembledError,
  BackendNotAssembledError,
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
}

function createSessionHistoryBuilder(): SessionHistoryBuilder {
  return {
    fromMessages: (messages, session) => buildHistoryMessages([...messages], session),
    recipe: session => historyProjectionRecipe(session),
  }
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
  /**
   * Give an owner and this Backend takes the store mutex; today only the CLI
   * daemon does. Omit it and the host takes **no lock** (2026-08-24 ruling,
   * 「store 不要锁」): the single writer is settled by `<store>/run/http.json` —
   * whoever already serves the store keeps it, and a newcomer defers instead of
   * racing for a lock file that a crash would leave behind.
   */
  owner?: StoreLockOwner
  storePath?: string
  shutdownTimeoutMs?: number
  /** File logging and its janitor start only after this Backend owns the store. */
  logging?: ConfigureLoggingOptions
  /**
   * 宠物宿主(`docs/design/pet-system-2026-09.md` §9.1)。React 壳与 server 传 `true`,
   * CLI 守护进程不传。**缺席 = 这台宿主没有宠物**:不建 `PetsSubsystem`、不订资源事件、
   * 不登记 `pet:`。
   */
  pets?: boolean
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
  private readonly lifecycle: BackendResources
  private lease: StoreLease | undefined
  private readonly activeTasks = new Map<Promise<unknown>, string>()
  private disposing: Promise<void> | null = null
  /**
   * `dispose()` 开跑了没有 —— **同步**的那一格。
   *
   * 不能只看 `disposing`:`this.disposing = (async () => { … })()` 里那只 IIFE 的
   * 函数体先跑到第一个 `await`(第一只 disposer)才把 promise 赋回来,于是"第一只
   * disposer 正在跑"那一段时间里 `disposing` 还是 `null`。而 R1 要挡的正是那一段:
   * 一个 disposer 里(或它 await 的东西里)冒出来的 `own()` 若被推进表,循环下标
   * 早已走过它,随后 `disposers.length = 0` 把它静默丢掉。
   */
  private disposeStarted = false

  /**
   * MCP / ACP 两只子系统(C1,方案
   * `docs/design/backend-principal-and-mcp-lifecycle-2026-09.md` §2.2)。
   *
   * 它们**不进** `BackendHandle` —— 那个窄接口回答的是"这个进程里的引擎/总线是哪一
   * 只",给的是散在各处经 `getXxx()` 读装配产物的模块;而 MCP/ACP 的生命周期只有
   * 两类调用方:装配自己,和拿着实例的宿主(壳的 `startPostWindowServices`)。
   * 塞进句柄等于给一个不需要它的读法开一扇门。
   */
  private mcpSubsystem: McpSubsystem | null = null
  private acpSubsystem: AcpSubsystem | null = null
  private pluginModelService: PluginLlmService | undefined
  private credentialStrategyService: CredentialStrategyService | undefined
  private todoPlanRuntime: TodoPlanRuntime | undefined
  /**
   * 资源内核(K1,`docs/design/atom-2026-09.md`)。**实例字段,不是模块槽** ——
   * 与 `assembly:gate` 那把尺子同一句话:装配期的状态住在实例上、由 `own()` 收尾。
   *
   * (私有的那台 `BackendResources` 因此改名叫 `lifecycle`:它本来就是
   * `./lifecycle.js` 里那只「关机清单」,而 `resources` 这个名字属于原子那一层的
   * 「资源」。两件同名的东西住在一个类里,读代码的人迟早会读错一次。)
   */
  private resourceKernel: ResourceKernel | undefined
  private shellResourceRegistry: ShellMountRegistry | undefined

  readonly options: Readonly<OnethingBackendOptions>

  private constructor(options: OnethingBackendOptions) {
    this.options = options
    this.lifecycle = new BackendResources(options.shutdownTimeoutMs, failure => {
      log.error('backend disposer failed', { step: failure.step }, failure.cause)
    })
    this.own(async () => {
      while (this.activeTasks.size) await Promise.allSettled([...this.activeTasks.keys()])
    }, 'activeRequests', 'drain')
  }

  get storeLease(): StoreLease {
    if (!this.lease) throw new BackendNotAssembledError()
    this.lease.assertHeld()
    return this.lease
  }

  get isShuttingDown(): boolean { return this.lifecycle.isClosing }

  get pluginModels(): PluginLlmService {
    if (!this.pluginModelService) throw new BackendNotAssembledError()
    return this.pluginModelService
  }

  get todoPlans(): TodoPlanRuntime {
    if (!this.todoPlanRuntime) throw new BackendNotAssembledError()
    return this.todoPlanRuntime
  }

  get credentialStrategies(): CredentialStrategyService {
    if (!this.credentialStrategyService) throw new BackendNotAssembledError()
    return this.credentialStrategyService
  }

  /**
   * 资源内核 —— 界面 / 调度 / 脚本 / 测试进「读、做、看」那条管线的门(K1)。
   *
   * 它与 AI 走的是**同一台 `ToolRunner`**,所以授权、审计、预算、取消四样同源。
   * K2 的 RPC 通用 `read` / `do` 处理器接的就是这一格。
   */
  get resources(): ResourceKernel {
    if (!this.resourceKernel) throw new BackendNotAssembledError()
    return this.resourceKernel
  }

  /**
   * 壳侧自述的登记簿(K2b-2)—— `home: 'shell'` 的那半边资源住在这里。
   *
   * 它与 `resources` 是同一台内核的两个面:`resources` 是**调用**面(读 / 做 / 看),
   * 这一格是**供给**面(哪扇壳交了哪几种资源、它还活着没有)。分成两格而不是把
   * `mountShell` 挂到内核上,是因为「一扇壳的连接」这个寿命概念内核不该知道 ——
   * 内核只认 provider(§2 不变量 3)。
   */
  get shellResources(): ShellMountRegistry {
    if (!this.shellResourceRegistry) throw new BackendNotAssembledError()
    return this.shellResourceRegistry
  }

  get mediaLibrary(): MediaLibraryService { return requireBackendField(this.parts, 'mediaLibrary') }
  get toolExecutions(): ToolExecutionRegistry { return requireBackendField(this.parts, 'toolExecutions') }
  get practice(): PracticeService { return requireBackendField(this.parts, 'practice') }
  get music(): MusicSubsystem { return requireBackendField(this.parts, 'music') }
  get collabDigests(): CollabDigestRunner { return requireBackendField(this.parts, 'collabDigests') }
  get notes(): NotesSubsystem { return requireBackendField(this.parts, 'notes') }

  assertActive(): void { this.lifecycle.assertActive() }

  /** Every accepted transport operation remains owned until its work settles. */
  runTask<T>(label: string, run: () => T | Promise<T>): Promise<T> {
    this.assertActive()
    const task = Promise.resolve().then(run)
    this.activeTasks.set(task, label)
    void task.then(() => { this.activeTasks.delete(task) }, () => { this.activeTasks.delete(task) })
    return task
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

  get sessionLayer(): SessionLayer {
    return requireBackendField(this.parts, 'sessionLayer')
  }

  get journalStore(): SessionEventLogStoreHandle {
    return requireBackendField(this.parts, 'journalStore')
  }

  get taskDispatchLayer(): TaskDispatchLayer {
    return requireBackendField(this.parts, 'taskDispatchLayer')
  }

  get sessionDeletionRecovery(): SessionDeletionRecovery {
    return requireBackendField(this.parts, 'sessionDeletionRecovery')
  }

  get engine(): StreamEngine {
    return requireBackendField(this.parts, 'engine')
  }

  get runtime(): MainOnethingRuntime {
    return requireBackendField(this.parts, 'runtime')
  }

  /**
   * MCP 子系统。装配途中(工具目录那一步之后)建好;还没建到就抛,与五格产物同口径。
   */
  get mcp(): McpSubsystem {
    if (!this.mcpSubsystem) throw new BackendNotAssembledError()
    return this.mcpSubsystem
  }

  /** ACP 子系统。同上。 */
  get acp(): AcpSubsystem {
    if (!this.acpSubsystem) throw new BackendNotAssembledError()
    return this.acpSubsystem
  }

  /**
   * 谁起了一件会留尾巴的东西,谁把收尾登记进来。`dispose()` 按**登记逆序**跑。
   *
   * 宿主在装配之后起的东西(内嵌 HTTP 面、用户调度器、todo/草稿纸 watcher、
   * MCP)也从这个口登记 —— 那是 A3 的活,A2 只把口开出来。
   *
   * **关门之后来的登记就地执行**(C0 R1,方案
   * `docs/design/backend-principal-and-mcp-lifecycle-2026-09.md` §1.3):宿主里有几处
   * 登记排在一个 `.then()` 里(MCP 的 manager、从前的调度器),而 `dispose()` 可能比
   * 那个 `.then()` 先跑完 —— 壳起来两秒内 Cmd+Q 就是。从前那种登记被**静默丢弃**,
   * 于是已经拉起来的 stdio 子进程成了孤儿。现在:已在 dispose 或已 dispose 完的实例
   * 收到 `own()`,**立刻跑**这只 disposer 并把它的 promise 交回去(不入表 —— 表已经
   * 或正在被逆序跑完,再入表要么跑两次要么跑不到)。
   *
   * 错误在这里**记日志不上抛**:调用点是 `b.own(x)` 这种"登记"语句,不是"关机"语句,
   * 让它抛等于把一次收尾失败变成一条启动路径上的异常。与 `dispose()` 里逐个
   * try/catch 同口径。
   */
  own(disposer: () => void | Promise<void>, label = 'anonymous', phase: BackendShutdownPhase = 'resources'): void | Promise<void> {
    return this.lifecycle.own(disposer, label, phase)
  }

  /**
   * 幂等;逆序跑完 `own()` 登记的全部 disposer,再清掉进程当前实例槽。
   *
   * 每个 disposer 单独 try/catch 并记 error:一个失败不许挡住后面的 —— 关机链
   * 上排在最后的是**落盘**,让它被前面某个 shutdown 的异常吞掉是这条链最坏的
   * 失败形态。
   */
  dispose(reason = 'shutdown'): Promise<void> {
    if (this.disposing) return this.disposing
    // 同步先立旗(见 `disposeStarted` 的注释):IIFE 的 promise 要到第一个 await
    // 之后才赋回 `this.disposing`,而 `own()` 的守卫在那之前就得说得出话。
    this.disposeStarted = true
    this.disposing = (async () => {
      await this.lifecycle.dispose(reason)
      /*
       * C0 R10:装配产物那五格也清掉。
       *
       * 从前只清进程当前实例槽,于是**这只实例**手上还攥着已经关掉的引擎/总线:
       * `backend.engine` 照样交得出来,拿到的是一只 shutdown 过的东西。今天没有
       * 已知的实害(全仓的 safe 访问器都经槽走,槽清了它们就回 null/false),
       * 但"关完还能从这只实例上摸到活引擎"是个说谎的形状 —— 清掉之后
       * `backend.engine` 抛 `BackendNotAssembledError`,与"还没建到那一格"同义。
       */
      for (const field of Object.keys(this.parts) as Array<keyof BackendHandleParts>) {
        delete this.parts[field]
      }
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
    return this.lifecycle.labels()
  }

  /**
   * 收编一台子系统的关机(工单 5 §1,triage B1)。
   *
   * 从前这里是三十几行机械重复:每台子系统两句 `own()`,一句进 `quiesce` 阶段、
   * 一句进 `drain` 阶段,标签手拼。那是**骨架按能力枚举**——加一台子系统要在
   * 装配里多写两句同形的话,而两句里任何一句忘了、阶段填错了、标签拼错了,
   * 都要等到真机关机才发作。
   *
   * 改成 `adopt` 之后,子系统自述它是 `Quiescible`,骨架读表:一次登记两条,
   * 标签由 `label` 推,阶段是常量。**这里没有、也不许有按子系统分叉的分支**——
   * 接不上接口的(只有 `stop()` 的触发器 / 任务派发层)在**它自己那边**补一个
   * `quiesce` 别名,不在这里认名字。
   *
   * 资源级的收尾(`dispose()` / 解绑单槽 / 归还进程状态)仍然各自一句 `own()`:
   * 十四台里只有一台有 `dispose`,把它折进来只会让"这台到底登记了几条"变成
   * 要读实现才答得出的问题。
   */
  adopt(label: string, subsystem: Quiescible): void {
    this.own(() => subsystem.quiesce(), `${label}Admission`, 'quiesce')
    this.own(() => subsystem.drain(), `${label}Drain`, 'drain')
  }

  requestShutdown(reason = 'shutdown'): Promise<void> { return this.dispose(reason) }

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
      try {
        await backend.dispose('assembly failed')
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Backend assembly and cleanup failed', { cause: error })
      }
      throw error
    }
  }

  private async assembleSteps(): Promise<void> {
    const options = this.options
    if (options.storePath) {
      const previous = process.env.ONETHING_STORE_PATH
      process.env.ONETHING_STORE_PATH = options.storePath
      this.own(() => {
        if (previous === undefined) delete process.env.ONETHING_STORE_PATH
        else process.env.ONETHING_STORE_PATH = previous
      }, 'storePath', 'restore')
    }
    configureAppRuntimeAdapters()
    // 宿主能力先落位:它们是**输入**,装配的每一步都可能读到(sandbox 在工具目录
    // 之前、auth 在凭证升级之前、storePath 在 docs 目录之前)。一次性交出来的好处
    // 就在这里 —— 顺序问题只有这一个答案:全部,在最前面。
    //
    // `applyHostPorts` 返回一个还原函数。C0 R6 起它还原的是**十六格全部**
    // (从前只有 `localTrust` 那一格有 restore,其余是没有回头路的单槽覆盖):
    // 登记在这里 = dispose 之后这个进程回到"没有宿主注入过任何能力"的状态,
    // 于是同一个进程里先后装配两只 backend 时,第二只不会继承第一只的语音 /
    // 插件 / 沙箱端口。
    this.own(applyHostPorts(options.host), 'hostPorts', 'restore')

    const { bindExternalAgentConnectors } = await import('./wiring/external-agents/index.js')
    const externalAgents = bindExternalAgentConnectors({
      isAccepting: () => !this.isShuttingDown,
    })
    // afterSettings can already invoke the lazy provider factory, then throw.
    // Own that generation immediately; the later registration preserves the
    // established successful-shutdown order and shares this idempotent disposer.
    this.own(externalAgents.dispose, 'externalAgentsAssemblyRollback')
    this.own(externalAgents.quiesce, 'externalAgentsAdmission', 'quiesce')
    await externalAgents.ready

    const lease = createStoreLease({ storePath: options.storePath, ...(options.owner ? { owner: options.owner } : {}) })
    await lease.acquire(options.owner ?? 'server')
    this.lease = lease
    this.own(() => lease.release(), 'storeLease', 'release')
    invalidateSettingsCache()
    const usageLedger = new OnethingUsageLedger({
      ledgerDir: path.join(lease.storePath, 'usage'),
      assertOwned: () => lease.assertHeld(),
    })
    this.own(configureUsageLedger(usageLedger), 'usageLedgerBinding', 'restore')
    this.own(() => usageLedger.close(), 'usageLedger', 'flush')
    const pluginModels = new PluginLlmService(this)
    this.pluginModelService = pluginModels
    this.adopt('pluginModels', pluginModels)
    const credentialStrategies = new CredentialStrategyService()
    this.credentialStrategyService = credentialStrategies
    this.adopt('credentialStrategies', credentialStrategies)
    this.own(() => disposeCredentialStrategyState(), 'credentialStrategyState', 'resources')
    const todoPlans = new TodoPlanRuntime({ storePath: lease.storePath, assertActive: () => this.assertActive() })
    this.todoPlanRuntime = todoPlans
    this.adopt('todoPlan', todoPlans)
    this.own(() => todoPlans.dispose(), 'todoPlanRuntime', 'resources')
    const evalsTasks = new EvalsTaskOwner(() => lease.assertHeld())
    this.own(configureEvalsTaskOwner(evalsTasks), 'evalsTaskBinding', 'resources')
    this.adopt('evalsTask', evalsTasks)
    const mediaLibrary = new MediaLibraryService({
      indexPath: getOnethingMediaIndexPath({ storePath: lease.storePath }),
      imagesDir: getOnethingMediaImagesDir({ storePath: lease.storePath }),
      filesDir: getOnethingMediaFilesDir({ storePath: lease.storePath }),
    })
    this.parts.mediaLibrary = mediaLibrary
    this.own(configureMediaLibraryService(mediaLibrary), 'mediaLibraryBinding', 'resources')
    this.adopt('mediaLibrary', mediaLibrary)
    const practice = new PracticeService({ storePath: lease.storePath, assertOwned: () => lease.assertHeld() })
    this.parts.practice = practice
    this.own(configurePracticeService(practice), 'practiceBinding', 'resources')
    this.adopt('practice', practice)
    const music = new MusicSubsystem({ storePath: lease.storePath, assertOwned: () => lease.assertHeld() })
    this.parts.music = music
    this.adopt('music', music)
    const voice = createVoiceService()
    this.own(configureVoiceService(voice), 'voiceBinding', 'resources')
    this.adopt('voice', voice)
    if (options.logging) {
      this.own(() => shutdownAppLogging(), 'logging', 'endpoints')
      configureLogging(options.logging)
    }
    const deletionRecovery = createSessionDeletionRecovery({
      sessionsDir: path.join(lease.storePath, 'sessions'),
      assertOwned: () => lease.assertHeld(),
      associatedDirectories: { traces: getTracesDir({ storePath: lease.storePath }) },
    })
    this.parts.sessionDeletionRecovery = deletionRecovery
    await deletionRecovery.recover()
    const journal = acquireSessionEventLogStore(lease.storePath)
    this.parts.journalStore = journal
    this.own(() => journal.drainAndRelease(), 'flushSessionEventLedger', 'flush')

    initializeStores()
    /*
     * 落盘是关机链上的**最后**两步,所以它们是最先登记的两件(逆序)。
     *
     * 顺序:`flushAllPendingSaves` 排的是 messages.jsonl 的 300ms 节流队列;
     * 事件账本有**自己**的每会话写队列(§15.12(a)(b)),必须排在它之后 ——
     * 抄本停写之后那就是唯一持久化,退出那一刻队列里剩什么就丢什么。
     * 账本那一步自带 2s 时限,超时记一行 warn 不阻退出。
     */
    this.own(() => flushAllPendingSaves(), 'flushAllPendingSaves', 'flush')

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
    /*
     * 笔记库的**播种**(P1,§3.4)。同一处、同一条纪律:刚读完 settings、
     * 任何人问「有哪些笔记库」之前;幂等靠 `settings.notes.migratedAt`;
     * 失败不写标记、下次启动重跑,所以这里只记不抛(`migrateNotesSettings`
     * 自己把异常吃掉并答 `'failed'`)。
     *
     * 它**只播种,不删**:两个老变量一个字不动(P3 才删),所以这一步是可
     * 回退的。(`general.dailyNotes` 那五格已随 P2 的 `notes` 检索能力一起删了 ——
     * 零迁移:`mergeWithDefaults` 是白名单式重建,旧键自然落地。)
     */
    await migrateNotesSettings()
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
    /*
     * 待办目录的文件监听器随装配启动(设置里的待办目录此刻才读得到)。从前全仓唯一的
     * 启动点在「保存设置」之后,于是从开机到用户第一次保存设置之间,AI 用写文件工具改了
     * 计划,界面收不到任何通知(`apps/desktop-react/docs/todo-2026-09.md` §1 缺口 2)。
     * 起不来只记日志:待办监听不是装配能不能成的前提。收场在 `todoPlanRuntime` 那条 own 上。
     */
    await todoPlans.start().catch(error => log.error('todo plan watcher failed to start', {}, error))
    await options.hooks?.afterSettings?.(this)

    const { eventBus, streamChannel } = createEventSystem()
    this.parts.eventBus = eventBus
    this.parts.streamChannel = streamChannel
    this.own(() => {
      eventBus.shutdown()
      streamChannel.shutdown()
      log.info('event system shut down')
    }, 'eventSystem')
    /*
     * 宠物 P4(§11.3)—— 音乐接上总线:缺省主持人声音出声前后发 `speech:activity`,并订同一条
     * 事件在播放器正在放时压低音乐。与有没有宠物无关(没有宠物时电台口播也要让音乐让路),
     * 所以不挂在 `pets` 那一格下面。登记在事件系统之后,关机时先解绑、再关总线。
     */
    this.own(music.attachSpeechActivity(eventBus), 'musicSpeechActivity')

    /**
     * 删一条会话之前要排空的**生产者表** —— 每一台在自己造出来的那一行登记自己
     * (工单 4 C10)。
     *
     * 从前这里是一段闭包,直接点名 `sessionToc`(在它下面四十行才声明)和三个
     * `this.parts.X!`。那三个非空断言掩盖的正是这条时序:装配跑到这一行时,它们
     * 真的还不存在;断言只是让 `tsc` 别问。改成后填的表之后,时序变成数据 ——
     * 表是空的就是「这一刻还没有生产者」,而不是一个会在运行时炸的 undefined。
     * 加一台生产者 = 造它那一行多一句 push,这里一个字不改。
     */
    const sessionProducers: { abortAndDrain(sessionId: string): Promise<void> }[] = []
    const sessionLayer = createSessionLayer(eventBus, streamChannel, {
      historyBuilder: createSessionHistoryBuilder(),
      abortAndDrain: async id => {
        const settled = await Promise.allSettled(sessionProducers.map(producer => producer.abortAndDrain(id)))
        const errors = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (errors.length) throw new AggregateError(errors, `Session producers failed to drain: ${id}`)
      },
    })
    this.parts.sessionLayer = sessionLayer
    // MindPort/typing can publish room state without starting the room actors.
    // The view therefore belongs to every Backend, not only options.collab.
    const collabInspector = createCollabInspector({
      getSession,
      emit: eventBus.emit.bind(eventBus),
      isActive: () => !this.isShuttingDown && getCurrentBackendSafe() === this,
      onError: error => log.error('collab inspector broadcast failed', {}, error),
    })
    this.own(configureCollabInspector(collabInspector), 'collabInspectorBinding', 'resources')
    this.adopt('collabInspector', collabInspector)
    const toolExecutions = new ToolExecutionRegistry(sessionLayer.access)
    this.parts.toolExecutions = toolExecutions
    sessionProducers.push(toolExecutions)
    this.adopt('toolExecution', toolExecutions)
    const digestStore = createCollabDigestStore({ storePath: lease.storePath, assertOwned: () => lease.assertHeld() })
    this.own(configureCollabDigestStore(digestStore), 'collabDigestBinding', 'resources')
    const collabDigests = createCollabDigestRunner({
      store: digestStore, access: sessionLayer.access, assertOwned: () => lease.assertHeld(),
      recordUsage: captureUsageRecorder(),
    })
    this.parts.collabDigests = collabDigests
    sessionProducers.push(collabDigests)
    // 摘要档的关闸由 runner 自己带上(它是那份 store 唯一的写者),于是这里也只是一句 adopt。
    this.adopt('collabDigest', collabDigests)
    journal.assertSessionWritable = sessionLayer.deletion.assertWritable
    this.parts.sessionManager = sessionLayer.sessionManager
    this.own(() => sessionLayer.dispose(), 'sessionLayer')
    this.own(() => sessionLayer.deletion.drain(), 'sessionDeletions', 'drain')

    const sessionToc = createSessionTocTrigger({
      runTask: (label, work) => this.runTask(label, work),
      assertAccepting: id => sessionLayer.deletion.assertAccepting(id),
    })
    sessionProducers.push(sessionToc)
    this.adopt('sessionToc', sessionToc)

    // B 期(§17.8):写入口每落一条事件,原样在总线上广播一份 —— 桌面 IPC 与
    // web SSE 都观察总线,于是"两个传输同步"是构造性的。必须在事件系统之后
    // (它要 `getEventBus()`),在任何一条事件被写下之前。
    installSessionLedgerEventBroadcaster()
    this.own(() => uninstallSessionLedgerEventBroadcaster(), 'sessionLedgerBroadcaster')

    const engineLayer = createStreamEngineLayer({
      eventBus,
      streamChannel,
      assertAccepting: id => {
        this.assertActive()
        if (id) sessionLayer.deletion.assertAccepting(id)
      },
    })
    this.parts.engine = engineLayer.engine
    sessionProducers.push(engineLayer.engine)
    this.parts.runtime = engineLayer.runtime
    this.own(() => engineLayer.quiesceOutboundReplies(), 'outboundRepliesAdmission', 'quiesce')
    this.own(() => engineLayer.drainOutboundReplies(), 'outboundRepliesDrain', 'drain')
    const taskDispatchLayer = createTaskDispatchLayer({
      eventBus,
      engine: engineLayer.engine,
      access: sessionLayer.access,
      reads: sessionLayer.reads,
    })
    this.parts.taskDispatchLayer = taskDispatchLayer
    this.adopt('taskDispatch', taskDispatchLayer)
    /*
     * A3(方案 §2.5,(b) 类闩):内置触发器注册返回 disposer。
     *
     * `triggerManager` 是模块级单例,三只触发器里握着这一份装配的引擎与总线。
     * 从前那个单向闩让"装配 → dispose → 再装配"只在第一份里注册过 —— 第二份
     * 跑的是第一份的尸体。登记在这里(而不是并进下面那处显式反序块):触发器是
     * 被动的,谁先谁后都不影响关机语义。
     */
    this.own(registerBuiltinTriggers({ sessionToc }), 'builtinTriggers')

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
    const goalBreakers = bootstrapGoalStreamBreakers()
    this.own(goalBreakers, 'goalStreamBreakers')
    this.adopt('goalRetry', goalBreakers)
    // All accepted tasks drained; goal metadata must reach the still-live
    // session layer before that layer is disposed and its stores are flushed.
    this.own(() => { flushGoalRuntimeUsage(); disposeGoalRuntimeState() }, 'goalUsage', 'resources')
    this.own(bootstrapProjectDirs(), 'projectDirs')
    /*
     * 笔记库(P1,`docs/design/notes-obsidian-cli-2026-09.md` §3)。落点紧挨
     * 目录名册之后:两者都是「用户盘上的根」,都排在工具目录之前 —— 工具面的
     * 沙箱根与检索根将来(P2/P3)要问它。
     *
     * 第一次发现是异步的,装配不等它:它要读 `obsidian.json`,而装配链上没人
     * 等着用库表。
     */
    this.own(bootstrapNotes(subsystem => { this.parts.notes = subsystem }), 'notes')
    // 库表一变,技能缓存就该作废 —— 勾了「技能来源」的库是技能根的一部分(P3)。
    // 紧跟着 notes 注册,因为它订的就是那只子系统。
    this.own(bootstrapNoteVaultSkillRoots(), 'noteVaultSkillRoots')

    // 缝 4 —— 三档目录。R4b 之后它是**唯一**一本工具册子(旧注册表已删)。
    //
    // `feature_*` 与插件工具**不在这里**:前者由 self-evolution feature 在 mount 时
    // 自己装进目录,后者由 `api.registerTool` 装 —— 两者的寿命都不是"一档目录"的寿命。
    const toolRegistryTier = options.toolRegistry ?? 'headless'
    const toolkitCatalog = buildToolkitCatalog(toolRegistryTier)
    // §13.7 裁定 5:服务器工具面变了就重算目录。挂在既有的唯一通知点上,
    // 不顶掉宿主自己那个 handler(它注册的是另一个口子)。
    configureToolkitMCPCapabilitiesChangedHandler(() => refreshToolkitMcpTools())

    /*
     * 缝 4.1 —— 资源内核(K1,`docs/design/atom-2026-09.md` §9)。
     *
     * 排在工具目录**之后**:它要一台 `ToolRunner`,而 runner 要沙箱、权限、审计
     * 这些已经在位的东西。
     *
     * 两件事,两个 `own()`,顺序反着登记:
     *   ① 内核本身(实例字段,不是模块槽);
     *   ② 内置资源的注册(`mountBuiltinResources` —— 加一种资源只改那只文件)。
     *
     * **观察者是 noop,审计是真的**:这台 runner 服务的是非 AI 调用方(K2 的 RPC、
     * 调度、脚本),它们没有 IPC 投影器可接 —— 但每一次「做」都必须落
     * `tool/audit`,那正是「界面点按钮也走管线」这句话唯一看得见的证据。
     *
     * 资源工具进不进工具目录、在哪种场子露面归 K3-a,见下面那条对账。
     */
    /*
     * K2b-2 —— `home: 'shell'` 的做法往哪儿派。
     *
     * 派发器在内核**之前**造:它是内核的构造参数(`ResourceKernelOptions.shell`),
     * 而登记簿在内核**之后**造(它要 `kernel.mount`)。三者的依赖是一条直线,不是
     * 一个环 —— 派发器不认识内核,登记簿两头都认识,内核两头都不认识。
     *
     * 路由表(scheme → 哪扇壳)住在派发器里,登记簿(shellId → 有哪几个 scheme)
     * 住在注册表里,唯一的写者是注册表。
     */
    const shellDispatch = new ShellCommandDispatch({ emit: event => eventBus.emitGlobal(event) })
    const resourceKernel = createResourceKernel(validator => createAppToolRunner({
      observer: { on: () => {} },
      audit: toolkitAuditSink,
      /*
       * 2026-09-10 —— 资源内核拼的 `Invocation` 没有 cwd(它的坐标是主体 + 发起
       * 会话),所以授权者要另有一条问路口才答得出「这次调用在哪个项目里」。判据
       * 与理由都在 `sessionWorkspaceRootFor` 头上;没有它,项目级的两档授权
       * (`workdir` / 应用级的 `always`)在资源面上是一个点不动的键。
       */
      authorizer: createPermissionAuthorizer({ workspaceRootOf: sessionWorkspaceRootFor }),
      // K2a:认得生成 schema 的那位校验者由 `createResourceKernel` 串好递进来 ——
      // 收配方而不是收 runner,是为了让「runner 认识自己工具的契约」结构性成立。
      validator,
    }), { shell: shellDispatch })
    this.resourceKernel = resourceKernel
    /*
     * K2a' §10.1 —— 关机时**内核在飞的「做」必须以 `Outcome.aborted` 收场,不许
     * 悬着**。`dispose()` 拉内核那只 `AbortController`、等在飞收场、再注销全部
     * provider。
     *
     * 它登记在 `mountBuiltinResources` **之前**,所以关机链上跑在它**之后** ——
     * 设计正本 §10.1 的原话是「先撤 provider、再撤内核」,而 `own()` 是逆序跑的。
     */
    this.own(async () => { await resourceKernel.dispose(); this.resourceKernel = undefined }, 'resourceKernel')
    /*
     * K3-b:递的是这台宿主建目录时用的那一档。「哪一档挂哪些内置资源」的判据住在
     * `mountBuiltinResources` 里 —— 这里照旧一个资源的名字都不出现。
     */
    /*
     * 宠物 P2 —— 宠物子系统。它要**这台内核的注册表**(查事件自述上的 `moment`)与总线
     * (订 `resource:event`),所以排在内核之后;`pet:` 这一格随内置资源一起登记。
     * 构造即 `own()`:收尾不依赖 `start()` 有没有跑完。登记在 `builtinResources` 之前,
     * 于是关机链上先摘 `pet:`、再停子系统(等喂食链与写盘链落地)。
     */
    const pets = options.pets
      ? new PetsSubsystem({
        dir: getOnethingPetsDir({ storePath: lease.storePath }),
        registry: resourceKernel.registry,
        bus: eventBus,
        assertOwned: () => lease.assertHeld(),
        // P4 §11.2:没带现成台词的时刻交给工具模型写。
        fallbackComposer: new ModelMomentComposer(),
        // P4 §11.3:自己开口也出声 —— 现问音乐要同一份口播缓存与出声路。
        voiceKit: () => music.voiceKit(),
        // P5 §12.4:开口频率初值取设置,之后订 `settings:changed` 热换(下面那一行)。
        chattiness: petChattinessOf(getSettings()),
      })
      : null
    if (pets) {
      this.own(() => pets.dispose(), 'pets')
      await pets.start()
      this.own(watchPetChattiness(pets), 'petsChattiness')
      /*
       * 宠物 P3(§10.2「宠物接管」)—— 电台的话交给宠物说。音乐域只认 `HostVoice` 接口,
       * 这一行是两边唯一见面的地方。登记在 `pets` 之后,关机时先解绑(电台退回缺省实现)
       * 再停宠物子系统。
       */
      this.own(music.bindHostVoice(kit => pets.createHostVoice(kit)), 'petsHostVoice')
    }
    this.own(mountBuiltinResources(resourceKernel, { tier: toolRegistryTier, pets }), 'builtinResources')
    /*
     * K2b-2 —— 壳侧提供者的登记簿。登记在内置资源**之后**,所以关机链上跑在它
     * **之前**:壳交的那几种资源要先按 §10.2 的三步收场(断路由 → 在飞以
     * `ResourceHomeUnavailableError` 收场 → 逆序摘),再轮到内置的和内核本身。
     */
    const shellResources = new ShellMountRegistry(resourceKernel, shellDispatch)
    this.shellResourceRegistry = shellResources
    this.own(async () => { await shellResources.dispose(); this.shellResourceRegistry = undefined }, 'shellResources')
    /*
     * K2a ③ —— 资源事件转发上总线。**单向**:装配层订阅 hub,hub 不认识总线
     * (K1 留账写死的方向)。订阅名单问注册表、跟着注册表变,这里一个 scheme 名
     * 都不出现;退订随实例走。
     */
    this.own(forwardResourceEventsToBus(resourceKernel, eventBus), 'resourceEventBridge')
    /*
     * K3-a —— 资源工具(加元工具 `resources`)进工具目录,跟着注册表来去
     * (`docs/design/atom-2026-09.md` §4「AI 工具」、§10.4 第三行:provider 在 =
     * 露面)。规则住在 `wiring/resource/catalog-sync.ts`,这里只有一行接线 ——
     * 这只文件里照旧一个 scheme 名都没有。
     *
     * 登记在壳登记簿**之后**,所以关机链上跑在它**之前**:先把目录里那批投影摘掉,
     * 再去撤壳交上来的自述 —— 反过来的话,中间那一拍目录里会留着一只已经没有实现
     * 的工具。
     *
     * K3-a':递的是这台宿主建目录时用的那一档。「哪一档不给资源工具」的判据住在
     * 对账那只文件里(`readonly` 一只都不给,理由写在它头上)—— 这里照旧不认识
     * 任何一档的含义,也照旧一个 scheme 名都没有。
     */
    this.own(
      syncResourceToolsIntoCatalog(resourceKernel, toolkitCatalog, { tier: toolRegistryTier }),
      'resourceCatalogTools',
    )

    /*
     * 工具跑出去的进程要收回来。挂在工具目录这一步:没有目录就没有工具,也就
     * 没有这两件尾巴。两条都是"没起过就是 no-op",所以无条件登记。
     * (登记顺序反着写 —— 关机链上是 `killTrackedDetachedChildren` 先、
     * `killAllTerminals` 后。)
     */
    this.own(() => killAllTerminals(), 'killAllTerminals')
    this.own(() => killTrackedDetachedChildren(), 'killTrackedDetachedChildren')

    /*
     * 缝 4.5 —— 检索(检索重建 S2/S3b,`docs/design/search-index-2026-09.md` §3 / §10)。
     *
     * 排在 RPC 域**之前**:`search` 域从进程单槽里读这份服务。S3b 起这一行会留下
     * 三样尾巴 —— 一条索引 Worker、账本的 append 观察者、总线上两条会话订阅 ——
     * 它们全部收在这**同一个** disposer 里(先摘订阅再停线程,见那个文件的头注)。
     * 装配等的那一下是「笔记目录在哪」(读一次 Obsidian 配置),毫秒级。
     */
    const searchService = await createAppSearchService()
    this.own(() => searchService.dispose(), 'searchService')

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
      await initializeCollabV3Runtime({ storePath: lease.storePath, assertOwned: () => lease.assertHeld() })
    }

    /*
     * C1(方案 `docs/design/backend-principal-and-mcp-lifecycle-2026-09.md` §2.2):
     * MCP / ACP 各是一只 backend 拥有的子系统对象。
     *
     * **构造在这里,`start()` 在下面那个反序块之后**。理由是孤儿:从前 MCP 的
     * `initialize` 就写在这一行,而它的收尾要到下面那个块才登记 —— `initialize` 里
     * 抛一个错,`assemble` 的 catch 去 `dispose()` 时表里根本没有 MCP 那一格,已经拉起
     * 的 stdio 子进程就没人关。构造(不起任何东西)→ 登记 → 才 start,这条窗口
     * 结构上就不存在了。设置**懒读**:构造点到 start 之间设置域可能已经改过。
     */
    const mcp = new McpSubsystem({
      manager: MCPManager,
      settings: () => getSettings().mcp || DEFAULT_MCP_SETTINGS,
      registerTools: () => registerMCPTools(),
    })
    this.mcpSubsystem = mcp
    const acp = new AcpSubsystem({
      manager: ACPManager,
      settings: () => getSettings().acp || { enabled: true, agents: [] },
    })
    this.acpSubsystem = acp
    /*
     * ACP 适配器子进程走应用代理(2026-09-24,用户:「而且没有走代理」):与 Claude Code
     * SDK 那条外部 agent 通路同一个函数。登记在 `acp` 的收尾之前 —— 逆序跑时先关
     * 子系统、后摘这一格。
     */
    ACPManager.setSpawnEnvProvider(resolveExternalAgentSpawnEnv)
    this.own(() => ACPManager.setSpawnEnvProvider(undefined), 'acpSpawnEnv')
    /*
     * ── 关机链的**头**七件,一处登记、显式反序 ──
     * (C1 之前是六件 —— `'mcpAcp'` 那一格拆成了 `'mcp'` / `'acp'` 两格。)
     *
     * 这七件的关机顺序有真实约束,而那个顺序**不是**装配顺序的逆:
     *  · RPC 面第一个下(不再接新调用),但它建在第 31 步;
     *  · `abortAll` 必须排在 MCP/ACP 收摊**之前**(先停我们这侧的流,再拆它
     *    要用的服务器),而引擎建在第 14 步;
     *  · 插件在桌面上根本不是装配起的(宿主在窗口之后起),这里的登记是
     *    **无条件、幂等**的兜底 —— A3 会把它交回宿主的 `own()`。MCP/ACP 从 C1
     *    起不再是"兜底":这两格就是它们唯一的登记点,宿主只决定何时 `start()`。
     * 所以这七件按今天 `shutdown()` 里的顺序反着登记在这一处,`dispose()` 跑
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
      await plugins.getPluginManager()?.shutdown()
    }, 'pluginManager')
    /*
     * C1:从前这里是一格 `'mcpAcp'`,里面手写 `ACPManager.shutdown()` 然后
     * `MCPManager.shutdown()`,并且靠 `if (!options.mcpAcp) return` 判"这只 backend
     * 起过没有"。现在是两格,各自问自己的子系统 —— 判据("我起过没有")与"等在途的
     * start 落地"都住进了子系统里。登记序 mcp → acp,于是 `dispose()` 的逆序跑出来
     * 仍然是先 acp 后 mcp,与 C1 之前逐字相同。
     */
    this.own(() => mcp.dispose(), 'mcp')
    /*
     * K5-a —— MCP 投影驱动(`docs/design/atom-2026-09.md` §9 K5「外部」:把一台
     * 已连接的 server 投影成一个命名空间)。
     *
     * 它接在这里而不是缝 4.1 里,因为它同时要**内核**(缝 4.1 建的)与**这台进程的
     * MCP 客户端**(上面那只子系统管着的那一台)。规则住在
     * `wiring/resource/mcp-mount.ts` —— 这只文件里照旧一个 scheme 名都没有,连
     * 「哪些档挂它」的判据都没有:MCP 子系统在哪些档存在,它就在哪些档投影,不另加
     * 一条档判据。
     *
     * **紧跟在 `'mcp'` 之后登记**,于是逆序跑出来是「先摘掉那几个投影出来的命名空间
     * (§10.2 三步:掐在飞 → 等收场 → 摘表),再关客户端」。反过来的话,中间那一拍
     * 注册表里会留着一批打不通电话的命名空间。内核本身在缝 4.1 登记,所以它比这两件
     * 都晚拆 —— 摘的时候内核还在。
     */
    this.own(
      mountMcpResources({ kernel: resourceKernel, manager: MCPManager }),
      'mcpResources',
    )
    this.own(() => acp.dispose(), 'acp')
    this.own(externalAgents.dispose, 'externalAgents')
    this.own(() => engineLayer.engine.abortAll(), 'engineAbortAll', 'drain')
    this.own(async () => {
      if (!options.collab) return
      await shutdownCollabV3Runtime()
    }, 'collab', 'quiesce')
    // Reversible registration: a second assemble in the same process (tests,
    // host restarts) must not trip the duplicate-domain guard.
    this.own(() => disposeRpcDomains(), 'rpcDomains', 'quiesce')

    /*
     * C1:`mcpAcp: true`(CLI daemon)才在装配里起。行为与 C1 之前逐字相同 ——
     * `MCPManager.initialize` + `registerMCPTools` + `ACPManager.initialize`,同一个顺序。
     * 位置从上面挪到这里**只跨过那一处纯登记的反序块**(六句 `own()`,零副作用),
     * 换来的是"起之前收尾已经在表里"。
     */
    if (options.mcpAcp) {
      await mcp.start()
      await acp.start()
    }

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
