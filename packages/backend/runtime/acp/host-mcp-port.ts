/**
 * ACP 连接器的宿主工具面端口(A4-b,`docs/design/acp-integration-2026-09.md` §3.6 / §11.5)。
 *
 * 产品层的 `createAcpConnector` 不认识装配层的桥与凭据表(`HostMcpBridge`,`AcpSubsystem` 的
 * 实例字段),所以装配层递一个端口进去:连接器握完手、开会话之前问 `serversFor`,每一轮开头
 * `beginTurn`。
 *
 * **桥在调用时现取**(`getCurrentBackendInstance()?.acp.hostMcpBridge`),不在构造时抓:连接器
 * 在装配途中就造好了,那时 ACP 子系统也许还没构造;同一个进程里换过一台 backend(测试、宿主重启),
 * 凭据要签在活着的那一台上 —— 第一台 dispose 时已经全部作废。
 */
import { ACPManager } from '@onething/backend/runtime/acp'
import type { AcpHostMcpPort } from '@onething/backend/runtime/external-agents'
import { getCurrentBackendInstance } from '@onething/backend/current.js'
import { getLogger } from '@onething/backend/runtime/logging/configure-logging'
import type { HostMcpBridge } from './host-mcp-bridge.js'

const log = getLogger('app.acp.host-mcp')

/** 协议那一侧的名册形状(桥产的是它的结构子集,不在装配层 import SDK)。 */
type AcpMcpServerList = Awaited<ReturnType<AcpHostMcpPort['serversFor']>>

/** 这台 agent 在两格开关上的生效值(缺省:给宿主工具、不透传名册)。 */
export interface AcpHostMcpAgentSwitches {
  hostTools?: boolean
  forwardMcpServers?: boolean
}

export interface AcpHostMcpPortDeps {
  /** 活着的那只桥。缺省 = 当前 backend 的 `acp.hostMcpBridge`;没装配 / 没有 ACP 子系统 = undefined。 */
  bridge?: () => HostMcpBridge | undefined
  /** 旧 id → 现 id(与作废时连接状态里的 id 对齐)。缺省 `ACPManager.canonicalAgentId`。 */
  canonicalAgentId?: (agentId: string) => string
  /** 这台 agent 的生效配置里那两格。缺省读 `backend.acp.agentState(id).config`(名册 ⊕ 覆盖)。 */
  agentSwitches?: (agentId: string) => AcpHostMcpAgentSwitches | undefined
}

function currentBridge(): HostMcpBridge | undefined {
  try {
    return getCurrentBackendInstance()?.acp.hostMcpBridge
  } catch {
    // 还没装配到 ACP 子系统(BackendNotAssembledError):这一轮没有宿主工具。
    return undefined
  }
}

function currentAgentSwitches(agentId: string): AcpHostMcpAgentSwitches | undefined {
  try {
    return getCurrentBackendInstance()?.acp.agentState(agentId)?.config
  } catch {
    return undefined
  }
}

export function createAcpHostMcpPort(deps: AcpHostMcpPortDeps = {}): AcpHostMcpPort {
  const bridgeOf = deps.bridge ?? currentBridge
  const canonical = deps.canonicalAgentId ?? (agentId => ACPManager.canonicalAgentId(agentId))
  const switchesOf = deps.agentSwitches ?? currentAgentSwitches

  return {
    serversFor({ agentId, localSessionId, cwd, executionContext, mcpCapabilities }) {
      const bridge = bridgeOf()
      if (!bridge) return []
      const id = canonical(agentId)
      const switches = switchesOf(id) ?? {}
      const common = {
        ...(mcpCapabilities ? { mcpCapabilities } : {}),
        forwardMcpServers: switches.forwardMcpServers === true,
      }
      // 用户关了这台的宿主工具面:不签凭据(没有 `onething` 那一条要用它),只剩透传的名册。
      if (switches.hostTools === false) return bridge.forwardedMcpServers(common) as AcpMcpServerList
      const minted = bridge.mintCredential(id, localSessionId, {
        ...common,
        cwd,
        ...(executionContext === undefined ? {} : { executionContext }),
      })
      log.info('host MCP servers composed', {
        agentId: id,
        sessionId: localSessionId,
        servers: minted.mcpServers.map(server => `${server.name}:${'type' in server ? server.type : 'stdio'}`),
      })
      return minted.mcpServers as AcpMcpServerList
    },

    beginTurn(agentId, localSessionId, turn) {
      const bridge = bridgeOf()
      return bridge ? bridge.beginTurn(canonical(agentId), localSessionId, turn) : () => undefined
    },
  }
}
