/**
 * The product assembly factory: the single recipe that turns the @onething/backend
 * subsystems into a running onething backend.
 *
 * Every host (Electron desktop, CLI daemon, headless server) boots through
 * this function instead of hand-sequencing the initialize* steps — the
 * ordering constraints (variables before tools, engine before Permission, …)
 * live here and nowhere else. Host-specific surfaces arrive through the
 * configure*Host ports and the options/hooks below; importing this module
 * (or any @onething/backend module) performs no configuration by itself.
 */
import { initializeStores, flushAllPendingSaves } from './store.js'
import { getSettings, initializeSettings } from './stores/settings.js'
import { applyDiagnosticsMode } from './logging/diagnostics.js'
import { initializeAgents } from './wiring/agents/index.js'
import { configureSandboxHost, configureAppToolSandbox } from './wiring/tools/core/sandbox.js'
import { configureAppBackgroundJobs } from '@onething/runtime/tools/background-jobs-bound'
import { configureAppProviderRegistry } from './providers/index.js'
import { configureAppSpaceCredentialsCrypto } from './providers/space-credentials.js'
import { migrateProviderConfigToDefaultSpace } from './providers/space-config-migration.js'
import { configureAppPluginCredentialStrategyHost } from './providers/credential-strategy.js'
import { configureAppScheduler } from '@onething/runtime/scheduler/scheduler-bound'
import { configureAppRipgrep } from './utils/ripgrep.js'
import { configureAppSearchProviders } from './wiring/search/providers.js'
import { configureAppSkillManage } from './wiring/skills/manage.js'
import { configureAppSkillsLoader } from './wiring/skills/loader.js'
import { configureAppPermissionGrants } from './wiring/permission/permission-grants.js'
import {
  initializeEventSystem,
  shutdownEventSystem,
  getEventBus,
  getStreamChannel,
} from './events/index.js'
import { initializeSessionLayer, shutdownSessionLayer } from './session/index.js'
import { installSessionPermissionEventRecorders } from './session/permission-events.js'
import {
  initializeStreamEngine,
  shutdownStreamEngine,
  getStreamEngine,
} from './engine/index.js'
import type { BindableStreamSender } from './engine/stream-engine.js'
import { registerBuiltinTriggers } from './engine/triggers/index.js'
import { initializeCollabV3Runtime, shutdownCollabV3Runtime } from './collab/index.js'
import { Permission } from './wiring/permission/index.js'
import { Interaction } from '@onething/core/interaction'
import { bootstrapVariableSystem } from './wiring/variables/index.js'
import { bootstrapGoalStreamBreakers } from './wiring/goals/runtime-hooks.js'
import { bootstrapProjectDirs } from './wiring/project-dirs/index.js'
import { configureToolkitMCPCapabilitiesChangedHandler } from './mcp/capabilities-changed.js'
import { buildToolkitCatalog, refreshToolkitMcpTools } from './toolkit/wiring.js'
import { registerAppRpcDomains } from './rpc/index.js'
import { initializeSessionSkills } from './wiring/skills/session-skills.js'
import { MCPManager, registerMCPTools } from './mcp/index.js'
import { DEFAULT_MCP_SETTINGS } from '@onething/core/mcp'
import { ACPManager } from '@onething/runtime/acp'
import { killTrackedDetachedChildren } from '@onething/runtime/tools/bash-executor'
import { killAllTerminals } from '@onething/runtime/terminal/service.wiring'
import { getLogger } from './logging/index.js'

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
}

export interface OnethingBackendHooks {
  /** Runs right after settings are loaded (desktop: shortcuts, network proxy). */
  afterSettings?: () => void | Promise<void>
  /** Runs after the engine + triggers are up, before Permission/tools. */
  afterEngine?: () => void | Promise<void>
  /** Runs after the tool registry is ready (desktop: IPC, todo watcher). */
  afterTools?: () => void | Promise<void>
}

export interface OnethingBackendOptions {
  /** Tool sandbox path surface (downloads/home). Omit to keep the host's own wiring. */
  sandboxHost?: { getPath?: (name: string) => string }
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

export interface OnethingBackend {
  engine: ReturnType<typeof getStreamEngine>
  eventBus: ReturnType<typeof getEventBus>
  streamChannel: ReturnType<typeof getStreamChannel>
  shutdown(): Promise<void>
}

export async function createOnethingBackend(
  options: OnethingBackendOptions = {},
): Promise<OnethingBackend> {
  configureAppRuntimeAdapters()
  if (options.sandboxHost) configureSandboxHost(options.sandboxHost)

  initializeStores()
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
  // Agents are read on every turn (and once per room member); warm the cache
  // here so nothing downstream pays a synchronous read + normalize.
  await initializeAgents()
  await options.hooks?.afterSettings?.()

  initializeEventSystem()
  initializeSessionLayer()
  initializeStreamEngine()
  registerBuiltinTriggers()

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

  await options.hooks?.afterEngine?.()

  Permission.initialize(
    getEventBus(),
    sessionId => getStreamEngine().getChannel(sessionId),
    sessionId => getStreamEngine().getPermissionMode(sessionId),
  )

  // 提问链与审批链是两条并列的等待链,同一个接入点、同一个通道解析器
  // (claude-code-integration-v2 §4)。同样要求 engine 先在位——targetChannel
  // 是 ask 当场从 engine 取的。
  Interaction.initialize(
    getEventBus(),
    sessionId => getStreamEngine().getChannel(sessionId),
  )

  // S1a(session-event-sourcing §10.2 的"权限/交互层"):两条等待链的时刻与
  // 决定进会话事件日志。必须在两个 initialize 之后 —— 它接的是同一对单例。
  installSessionPermissionEventRecorders()

  // Variables must precede the tool registry (the variable tool reads a
  // populated registry); goal breakers and project dirs are order-free but
  // belong before the first stream.
  bootstrapVariableSystem()
  bootstrapGoalStreamBreakers()
  bootstrapProjectDirs()

  // 缝 4 —— 三档目录。R4b 之后它是**唯一**一本工具册子(旧注册表已删)。
  //
  // `feature_*` 与插件工具**不在这里**:前者由 self-evolution feature 在 mount 时
  // 自己装进目录,后者由 `api.registerTool` 装 —— 两者的寿命都不是"一档目录"的寿命。
  buildToolkitCatalog(options.toolRegistry ?? 'headless')
  // §13.7 裁定 5:服务器工具面变了就重算目录。挂在既有的唯一通知点上,
  // 不顶掉宿主自己那个 handler(它注册的是另一个口子)。
  configureToolkitMCPCapabilitiesChangedHandler(() => refreshToolkitMcpTools())

  // RPC domains go up BEFORE afterTools: that hook is where the Electron host
  // runs initializeIPC() and mounts the `rpc:invoke` adapter, so the table it
  // dispatches into must already be complete. Registration itself is pure
  // bookkeeping (closures into a Map) — the handlers resolve their
  // dependencies lazily, per call.
  const disposeRpcDomains = await registerAppRpcDomains()

  await options.hooks?.afterTools?.()

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

  if (options.sender) {
    getStreamEngine().bind(options.sender)
  }

  return {
    engine: getStreamEngine(),
    eventBus: getEventBus(),
    streamChannel: getStreamChannel(),
    async shutdown() {
      // Reversible registration: a second createOnethingBackend in the same
      // process (tests, host restarts) must not trip the duplicate-domain guard.
      await disposeRpcDomains()
      if (options.collab) {
        try {
          await shutdownCollabV3Runtime()
        } catch (error) {
          log.error('collab shutdown failed', {}, error)
        }
      }
      getStreamEngine().abortAll()
      /**
       * 外部执行体跟着收摊(E4/G10)。`abortAll` 停的是我们这一侧的流,外部 agent
       * 的进程要它自己的 dispose 才会走 —— 漏了它,退出之后 CLI 子进程还活着。
       *
       * 无条件调:连接器是懒建的,没建过就是一次 no-op。桌面端另有一条
       * `shutdownACP` 也会调到它,dispose 本身幂等(表清空后再调直接返回)。
       *
       * 动态 import:装配层的静态图里不该多一条只在收摊时才用得上的边
       * (`import-side-effect-free` 那条纪律)。
       */
      try {
        const externalAgents = await import('./wiring/external-agents/index.js')
        await externalAgents.disposeExternalAgentConnectors()
      } catch (error) {
        log.error('external agent dispose failed', {}, error)
      }
      if (options.mcpAcp) {
        await ACPManager.shutdown()
        await MCPManager.shutdown()
      }
      /*
       * 插件系统必须在 **shutdownEventSystem 之前**拆。
       *
       * 插件 dispose 会往总线上发 cleared(R6 的状态清扫)、发 catalog-changed;
       * 总线先关的话那些事件发进一个已经没人听的地方,而账本里留着记录。
       * 这行此前一直是缺的 —— `CorePluginManager.shutdown` 与
       * `PluginManager.shutdown` 生产代码零调用者,R6 尾巴清理只是把那句
       * 不兑现的契约往上挪了一层。
       */
      try {
        const plugins = await import('./plugins/manager.js')
        plugins.getPluginManager()?.shutdown()
      } catch (error) {
        log.error('plugin manager shutdown failed', {}, error)
      }
      killTrackedDetachedChildren()
      // No-op unless a host actually created terminals. NOTE: the Electron
      // host quits through its beforeQuit cleanup table, not this shutdown —
      // it calls killAllTerminals there itself.
      killAllTerminals()
      shutdownStreamEngine()
      Permission.shutdown()
      Interaction.shutdown()
      shutdownSessionLayer()
      shutdownEventSystem()
      try {
        await flushAllPendingSaves()
      } catch (error) {
        log.error('flush pending saves failed', {}, error)
      }
    },
  }
}
