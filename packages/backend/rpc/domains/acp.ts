/**
 * acp(外部 Agent Client Protocol 代理)域 —— 结构债 P4c 第六批,整只从手写 IPC
 * 通道搬到通用 `rpc:invoke` / `POST /api/rpc`。
 *
 * 替换掉三处镜像:
 *  - `apps/electron/src/ipc/acp.ts` 的手写 IPC 工厂 + `apps/electron/src/main/ipc/acp.ts`
 *    那层壳适配(`IPC_CHANNELS` 上那八条 acp 通道);
 *  - `preload/bridge.ts` 的八条包装与 `platform/web.ts` 的八条 REST 镜像;
 *  - `server/http.ts` 的八条 REST 路由、`server/runtime.ts` 的 `acp` facade adapter,
 *    以及只服务于它的那台 **`ServerSafeACPManager`** —— 一个只会把设置里的
 *    agent 列表原样投影成「永远 disconnected」、连接一律抛
 *    "ACP agent connections are disabled in the web server runtime." 的假管家。
 *
 * 逻辑一行没搬:八条方法**逐条**转调 `@onething/runtime/acp` 的投影
 * (`*OnethingACP*ForIpc`),管家取的是进程内那台真 `ACPManager`(桌面 / CLI /
 * server 共用的同一个单例),设置取的是 `@onething/backend/stores/settings` ——
 * 与迁移前 `@main` 那份适配逐字同义。
 *
 * **本域没有需要按 `context.transport` 分叉的护栏**(拍板 #20 的纪律)。逐条核对
 * 过旧 server 侧比桌面多出来的东西,只有两类,都不是校验/隔离:
 *  1. `connectAgent` 恒失败、`disconnectAgent` / `cancelSession` 恒空转 —— 那是
 *     `ServerSafeACPManager` **没有实现**,不是它多了一道门;删掉这份镜像实现正是
 *     本批要做的事(与 skills 的 `executeSkill`、media 的第二份媒体库同判例)。
 *  2. per-owner 的设置隔离 —— 与 #27 / #28 同判例:一个 store 一份设置,web 与桌面
 *     从此读同一份。
 *  「agent 不存在 → 明确错误」这一条**两边本来就一样**:真 `ACPManager` 的
 *  `getOrCreateClient` 抛的「找不到这个 agent」与旧 server 那一句逐字相同,
 *  所以没有需要补回的分叉。
 */
import {
  ACPManager,
  addOnethingACPAgentForIpc,
  cancelOnethingACPSessionForIpc,
  connectOnethingACPAgentForIpc,
  disconnectOnethingACPAgentForIpc,
  getOnethingACPAgentsForIpc,
  refreshOnethingACPAgentForIpc,
  removeOnethingACPAgentForIpc,
  runOnethingACPRosterOperationForIpc,
  setOnethingACPSessionModeForIpc,
  updateOnethingACPAgentForIpc,
} from '@onething/runtime/acp'
import type { ACPAgentConfig, ACPAgentState, ACPSettings } from '@shared/ipc/acp.js'
import type { AcpRoutes } from '@shared/ipc/acp.js'
import { getSettings, saveSettings } from '../../stores/settings.js'
import { getCurrentBackendInstance } from '../../current.js'
import { consolePort, getLogger } from '../../wiring/logging/index.js'
import type { RpcRouteHandlers } from '../registry.js'
import { DESKTOP_RPC_CONTEXT } from '@shared/ipc/rpc.js'
import { sessionAccess } from '../../session/access.js'
import { sessionReads } from '../../session/reads.js'
import type { RpcDispatchContext } from '@shared/ipc/rpc.js'
import type { ConsoleLikePort } from '@onething/runtime/logging'
import type { OnethingACPIpcLogger } from '@onething/runtime/acp/ipc-operations'
import type { OnethingACPIpcAdapters } from '@onething/runtime/acp/ipc-operations'
import type { ChatMessage } from '@shared/ipc/chat.js'
import type { ACPAdoptSessionResponse } from '@shared/ipc/acp.js'
import { sessionCommands } from '../../session/commands.js'
import { flushSessionEventLog } from '../../session/event-log.js'
import { AcpSessionLifecycle, type AcpSessionLifecyclePorts } from '../../wiring/acp/session-lifecycle.js'

const log = getLogger('rpc.acp')
/** 投影层收的是鸭子 logger;`@main` 那份原来直接递 `console`,这里递受管的那只。 */
const consoleLog: ConsoleLikePort & OnethingACPIpcLogger = consolePort(log)

function getACPSettings(): ACPSettings {
  return getSettings().acp || { enabled: true, agents: [] }
}

async function saveACPSettings(acpSettings: ACPSettings): Promise<void> {
  const settings = getSettings()
  settings.acp = acpSettings
  saveSettings(settings)
  /*
   * C1(方案 `docs/design/backend-principal-and-mcp-lifecycle-2026-09.md` §2.2):
   * 有活实例就经它的子系统改;没有(不装 backend 的那些单测)退化为直接调 manager,
   * 行为与 C1 之前逐字相同。
   */
  const acp = getCurrentBackendInstance()?.acp
  if (acp) await acp.applySettings(acpSettings)
  else ACPManager.updateSettings(acpSettings)
}

/**
 * 投影层(`*OnethingACP*ForIpc`)眼里的「管家」。
 *
 * A1-a 起名册住装配层的 `AcpSubsystem`:喂管家的是名册的生效配置,读出来的行带
 * manifest / 来处 / 探测。所以有活实例时,「喂设置」与「读行」两件交给子系统,连接类动作
 * 仍然直达 `ACPManager`;没有实例(不装 backend 的单测)退化为整只 `ACPManager`,与 A1 之前
 * 逐字相同。
 */
function acpManagerFacade(): OnethingACPIpcAdapters<ACPAgentConfig, ACPAgentState>['manager'] {
  const acp = getCurrentBackendInstance()?.acp
  if (!acp) return ACPManager
  return {
    updateSettings: settings => acp.applySettings(settings as ACPSettings),
    getAgentStates: () => acp.agentStates(),
    getAgentState: agentId => acp.agentState(agentId),
    connectAgent: agentId => ACPManager.connectAgent(agentId),
    disconnectAgent: agentId => ACPManager.disconnectAgent(agentId),
    refreshAgent: agentId => ACPManager.refreshAgent(agentId),
    cancelSession: (sessionId, agentId) => ACPManager.cancelSession(sessionId, agentId),
  }
}

/**
 * 名册里有、设置里没有的 id(种子 / 注册表来的):`updateAgent` 对它们是「新建一条覆盖」,
 * `addAgent` 的 `basedOn` 从它们继承起法。没有实例 = 名册为空。
 */
function rosterManifest(agentId: string) {
  return getCurrentBackendInstance()?.acp.roster().find(entry => entry.manifest.id === agentId)
}

/**
 * 种子 / 注册表来的那一台的 manifest —— 写它的覆盖时只存与之不同的格(稀疏覆盖)。
 * 用户手加的条目(`source: 'user'`)不算:它们在设置里存整份,manifest 就是它们自己。
 */
function seedOrRegistryManifest(agentId: string) {
  const entry = rosterManifest(agentId)
  return entry && entry.source !== 'user' ? entry.manifest : undefined
}

function acpAdapters() {
  return {
    getSettings: getACPSettings,
    saveSettings: saveACPSettings,
    manager: acpManagerFacade(),
    logger: consoleLog,
    isRosterAgent: (agentId: string) => Boolean(seedOrRegistryManifest(agentId)),
    rosterManifest: seedOrRegistryManifest,
    resolveBasedOn: (agentId: string) => rosterManifest(agentId)?.effective,
  }
}

/**
 * `detect` / `refreshRegistry` 的执行体。有活实例 → 名册子系统;没有(不装 backend 的单测)→
 * 没有名册可探测,答管家眼里的那张表。信封与错误投影在 runtime 的 ipc-operations。
 */
function rosterRows(
  run: (acp: NonNullable<ReturnType<typeof getCurrentBackendInstance>>['acp']) => Promise<ACPAgentState[]>,
) {
  return runOnethingACPRosterOperationForIpc<ACPAgentState>({
    run: () => {
      const acp = getCurrentBackendInstance()?.acp
      if (acp) return run(acp)
      ACPManager.updateSettings(getACPSettings())
      return ACPManager.getAgentStates()
    },
    logger: consoleLog,
  }) as Promise<AcpRoutes['detect']['output']>
}

/**
 * 选项读写落在哪条 agent 会话上:会话存在 → 它的 id 与目录(目录原样交给 ACP 层,
 * 空串 / 未绑由 `resolveACPSessionCwd` 统一判,与发送那条路同一个判据);
 * 不存在(草稿)→ undefined,走草稿路。
 */
function optionTarget(
  context: RpcDispatchContext,
  sessionId: string | undefined,
  operation: 'read' | 'write',
): { localSessionId: string; cwd: string | undefined } | undefined {
  if (!sessionId) return undefined
  if (!sessionAccess.resolveOptional(context, sessionId, operation)) return undefined
  return { localSessionId: sessionId, cwd: sessionReads.getSession(sessionId)?.workingDirectory }
}

function optionsFailure(error: unknown): AcpRoutes['sessionOptions']['output'] {
  const message = error instanceof Error ? error.message : String(error)
  log.warn('acp session options failed', { error: message })
  return { success: false, options: [], live: false, error: message }
}

/** 认领在飞表(A5):按调用方造的 `AcpSessionLifecycle` 共用这一张,连点两下只认领一次。 */
const adoptionsInFlight = new Map<string, Promise<ACPAdoptSessionResponse>>()

function envelopeError(result: { success?: boolean; error?: string } | undefined, fallback: string): string {
  return result?.error || fallback
}

/**
 * 会话生命(A5)的端口:本地会话走 `sessions` 域**同一组**处理器(建 / 分支 / 绑目录 / 指模型 /
 * 删),带着这一次的调用方身份 —— 归属印、沙箱夹持、事件与 `sessions.create` 逐字同一条路;
 * 消息进账本走命令面 `replaceAll({ reason: 'replaced' })`(一条消息一条 `message/imported`)。
 */
function lifecyclePorts(context: RpcDispatchContext): AcpSessionLifecyclePorts {
  /*
   * `sessions` 域按需取(调用时才 import):它的模块图很重(资源面、协作、分支…),而认领 / 分叉
   * 是少见的动作 —— 静态 import 会让每个只想读 agent 列表的宿主与单测都先把它整个装一遍。
   * 调用时早已装配完,动态 import 拿到的就是注册表里那一份模块。
   */
  const sessions = async () => (await import('./sessions.js')).sessionsRpcHandlers
  return {
    manager: {
      listRemoteSessions: (agentId, cwd) => ACPManager.listRemoteSessions(agentId, cwd),
      adoptRemoteSession: (agentId, localSessionId, acpSessionId, cwd) =>
        ACPManager.adoptRemoteSession(agentId, localSessionId, acpSessionId, cwd),
      forkSession: (agentId, source, target, cwd) => ACPManager.forkSession(agentId, source, target, cwd),
      linkedLocalSessions: (agentId, acpSessionId) => ACPManager.linkedLocalSessions(agentId, acpSessionId),
      canonicalAgentId: agentId => ACPManager.canonicalAgentId(agentId),
    },
    getSession: sessionId => {
      if (!sessionAccess.resolveOptional(context, sessionId, 'read')) return undefined
      const session = sessionReads.getSession(sessionId)
      return session
        ? {
            workingDirectory: session.workingDirectory,
            lastProvider: session.lastProvider,
            lastModel: session.lastModel,
            name: session.name,
          }
        : undefined
    },
    createSession: async ({ sessionId, name, cwd, agentId }) => {
      const sessionsRpcHandlers = await sessions()
      const made = await sessionsRpcHandlers.create({ name, sessionId }, context)
      if (!made.success || !made.session?.id) return { ok: false, error: envelopeError(made, 'Failed to create session') }
      const id = made.session.id
      const workdir = await sessionsRpcHandlers.updateWorkingDirectory({ sessionId: id, workingDirectory: cwd }, context)
      if (!workdir.success) return { ok: false, error: envelopeError(workdir, 'Failed to bind the working directory') }
      const model = await sessionsRpcHandlers.updateModel({ sessionId: id, provider: 'acp', model: agentId }, context)
      if (!model.success) return { ok: false, error: envelopeError(model, 'Failed to select the ACP agent') }
      return { ok: true, sessionId: id }
    },
    listMessages: sessionId => {
      if (!sessionAccess.resolveOptional(context, sessionId, 'read')) return []
      return sessionReads.listMessages(sessionId).messages
    },
    importMessages: async (sessionId, messages: ChatMessage[]) => {
      await sessionCommands.replaceAll(sessionId, { messages, reason: 'replaced' })
      // 语义检查点:认领 / 分叉答「成了」的那一刻,这些消息必须已经在盘上。
      await flushSessionEventLog(sessionId)
    },
    discardSession: async sessionId => {
      await (await sessions()).delete({ sessionId }, context)
    },
  }
}

function lifecycle(context: RpcDispatchContext): AcpSessionLifecycle {
  return new AcpSessionLifecycle(lifecyclePorts(context), adoptionsInFlight)
}

export const acpRpcHandlers: RpcRouteHandlers<AcpRoutes> = {
  async getAgents() {
    return getOnethingACPAgentsForIpc({
      getSettings: getACPSettings,
      manager: acpManagerFacade(),
      logger: consoleLog,
    }) as Promise<AcpRoutes['getAgents']['output']>
  },
  /** 探测一台或全部(PATH + 版本号),答整张名册。不起 agent 进程。 */
  async detect(request) {
    return rosterRows(acp => acp.detect(request?.agentId || undefined))
  },
  /** 立刻重拉官方注册表(不看 24h 缓存)并探测,答整张名册。注册表开关关着 = 不联网。 */
  async refreshRegistry() {
    return rosterRows(acp => acp.refreshRegistry())
  },
  async addAgent(request) {
    const aCPIpcAdapters: OnethingACPIpcAdapters<ACPAgentConfig, ACPAgentState> & { config: ACPAgentConfig; } = {
      ...acpAdapters(),
      config: request.config,
    };
    return addOnethingACPAgentForIpc(aCPIpcAdapters) as Promise<AcpRoutes['addAgent']['output']>
  },
  async updateAgent(request) {
    const aCPIpcAdapters2: OnethingACPIpcAdapters<ACPAgentConfig, ACPAgentState> & { config: ACPAgentConfig; } = {
      ...acpAdapters(),
      config: request.config,
    };
    return updateOnethingACPAgentForIpc(aCPIpcAdapters2) as Promise<AcpRoutes['updateAgent']['output']>
  },
  async removeAgent(request) {
    const aCPIpcAdapters3: OnethingACPIpcAdapters<ACPAgentConfig, ACPAgentState> & { agentId: string; } = {
      ...acpAdapters(),
      agentId: request.agentId,
    };
    return removeOnethingACPAgentForIpc(aCPIpcAdapters3)
  },
  async connectAgent(request) {
    return connectOnethingACPAgentForIpc({
      getSettings: getACPSettings,
      manager: acpManagerFacade(),
      agentId: request.agentId,
      logger: consoleLog,
    }) as Promise<AcpRoutes['connectAgent']['output']>
  },
  async disconnectAgent(request) {
    return disconnectOnethingACPAgentForIpc({
      agentId: request.agentId,
      disconnectAgent: agentId => ACPManager.disconnectAgent(agentId),
      logger: consoleLog,
    })
  },
  async refreshAgent(request) {
    return refreshOnethingACPAgentForIpc({
      getSettings: getACPSettings,
      manager: acpManagerFacade(),
      agentId: request.agentId,
      logger: consoleLog,
    }) as Promise<AcpRoutes['refreshAgent']['output']>
  },
  async sessionOptions(request, context = DESKTOP_RPC_CONTEXT) {
    try {
      const target = optionTarget(context, request.sessionId, 'read')
      const snapshot = await ACPManager.getSessionOptions(request.agentId, target?.localSessionId, target?.cwd)
      return { success: true, ...snapshot }
    } catch (error) {
      return optionsFailure(error)
    }
  },
  async setSessionOption(request, context = DESKTOP_RPC_CONTEXT) {
    try {
      const target = optionTarget(context, request.sessionId, 'write')
      const snapshot = await ACPManager.setSessionOption(
        request.agentId,
        target?.localSessionId,
        target?.cwd,
        request.optionId,
        request.value,
      )
      return { success: true, ...snapshot }
    } catch (error) {
      return optionsFailure(error)
    }
  },
  /**
   * 这条会话在 agent 那边此刻的状态(A0-2)。只读内存,不起进程、不开会话:没开过就是 `null`。
   * 变化另走全局事件 `acp:session-state`,这一条给冷启动与补读用。
   */
  async sessionState(request, context = DESKTOP_RPC_CONTEXT) {
    sessionAccess.resolveOptional(context, request.sessionId, 'read')
    return ACPManager.getSessionState(request.sessionId, request.agentId) ?? null
  },
  /**
   * 切模式(A2-b,`session/set_mode`)。会话闸在前(写);切完把新模式折进状态表,经
   * `acp:session-state` 推出去,这里再把那张表原样答回去,壳不必等推送。
   */
  async setSessionMode(request, context = DESKTOP_RPC_CONTEXT) {
    sessionAccess.resolve(context, request.sessionId, 'write')
    return setOnethingACPSessionModeForIpc({
      sessionId: request.sessionId,
      modeId: request.modeId,
      agentId: request.agentId,
      setSessionMode: (sessionId, modeId, agentId) => ACPManager.setSessionMode(
        sessionId,
        sessionReads.getSession(sessionId)?.workingDirectory,
        modeId,
        agentId,
      ),
      logger: consoleLog,
    }) as Promise<AcpRoutes['setSessionMode']['output']>
  },
  /**
   * 「去登录」(A3-c):交给宿主挂上的登录桥。终端型立刻答 terminalId(壳开终端瓦),结局经
   * `acp:agent-state` 推;agent 型等 agent 答完。没挂桥的宿主(不装 backend 的单测)答 `unavailable`。
   */
  async authenticate(request) {
    const bridge = ACPManager.getAuthBridge()
    if (!bridge) return { ok: false, code: 'unavailable', error: 'ACP login is not available on this host' }
    if (!request?.agentId || !request?.methodId) {
      return { ok: false, code: 'unknown-method', error: 'agentId and methodId are required' }
    }
    return bridge.authenticate(request.agentId, request.methodId)
  },
  /** agent 那边的会话(A5,`session/list`)。要这台 agent 自报 `sessionCapabilities.list`。 */
  async listRemoteSessions(request, context = DESKTOP_RPC_CONTEXT) {
    return lifecycle(context).listRemoteSessions({ agentId: request?.agentId, cwd: request?.cwd })
  },
  /**
   * 认领(A5):建本地会话(与 `sessions.create` 同一条路)+ 链接 + `session/load`,回放折成
   * `message/imported` 进账本。同一台 agent 的同一条会话认领过(本地会话还在)= 答那一条。
   */
  async adoptSession(request, context = DESKTOP_RPC_CONTEXT) {
    return lifecycle(context).adoptSession({
      agentId: request?.agentId,
      acpSessionId: request?.acpSessionId,
      cwd: request?.cwd,
    })
  },
  /** 分叉(A5,`session/fork`):新本地会话(带着本地历史、同目录)绑到 fork 出来的那条。 */
  async forkSession(request, context = DESKTOP_RPC_CONTEXT) {
    if (!request?.sessionId) return { ok: false, code: 'failed', error: 'sessionId is required' }
    try {
      sessionAccess.resolve(context, request.sessionId, 'read')
    } catch (error) {
      return { ok: false, code: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
    return lifecycle(context).forkSession({ sessionId: request.sessionId, agentId: request.agentId })
  },
  /** 「重新连接」(A5):清掉崩溃退避的锁,再连一次。答带名册那一半的行。 */
  async reconnectAgent(request) {
    if (!request?.agentId) return { ok: false, error: 'agentId is required' }
    try {
      const live = await ACPManager.reconnectAgent(request.agentId)
      const state = getCurrentBackendInstance()?.acp.agentState(live.config.id) ?? live
      return { ok: true, state }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn('acp reconnect failed', { agentId: request.agentId, error: message })
      return { ok: false, error: message }
    }
  },
  async cancelSession(request, context = DESKTOP_RPC_CONTEXT) {
    sessionAccess.resolve(context, request.sessionId, 'abort')
    return cancelOnethingACPSessionForIpc({
      sessionId: request.sessionId,
      agentId: request.agentId,
      cancelSession: (sessionId, agentId) => ACPManager.cancelSession(sessionId, agentId),
      logger: consoleLog,
    })
  },
}
