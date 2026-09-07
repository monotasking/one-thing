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
import type { ConsoleLikePort } from '@onething/runtime/logging'
import type { OnethingACPIpcLogger } from '@onething/runtime/acp/ipc-operations'
import type { OnethingACPIpcAdapters } from '@onething/runtime/acp/ipc-operations'

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

function acpAdapters() {
  return {
    getSettings: getACPSettings,
    saveSettings: saveACPSettings,
    manager: ACPManager,
    logger: consoleLog,
  }
}

export const acpRpcHandlers: RpcRouteHandlers<AcpRoutes> = {
  async getAgents() {
    return getOnethingACPAgentsForIpc({
      getSettings: getACPSettings,
      manager: ACPManager,
      logger: consoleLog,
    }) as Promise<AcpRoutes['getAgents']['output']>
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
      manager: ACPManager,
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
      manager: ACPManager,
      agentId: request.agentId,
      logger: consoleLog,
    }) as Promise<AcpRoutes['refreshAgent']['output']>
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
