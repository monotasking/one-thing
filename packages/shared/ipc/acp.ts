/**
 * ACP (Agent Client Protocol) settings and IPC types.
 */

import type {
  ACPAgentConfig,
  ACPAgentState,
  ACPConnectionStatus,
  ACPPermissionMode,
  ACPSessionOption,
  ACPSessionOptionChoice,
  ACPSettings,
  AcpAgentDetect,
  AcpAgentManifest,
  AcpAgentSource,
  AcpSessionState,
} from '../contracts/acp.js'
import { defineRouter } from './router.js'

// 这些形状只有一份,住 `@shared/contracts/acp.ts`(A0-3 / A0-2),产品层与全局事件也读它。
export type {
  ACPAgentConfig,
  ACPAgentState,
  ACPConnectionStatus,
  ACPPermissionMode,
  ACPSessionOption,
  ACPSessionOptionChoice,
  ACPSettings,
  AcpAgentDetect,
  AcpAgentManifest,
  AcpAgentSource,
  AcpSessionState,
}

export interface ACPGetAgentsResponse {
  success: boolean
  agents?: ACPAgentState[]
  error?: string
}

/**
 * `config.basedOn` = 「复制为自定义」:新条目继承那一台(种子 / 注册表)的 manifest,
 * 这时 `config.command` 可以留空,缺的起法从那一台补。
 */
export interface ACPAddAgentRequest {
  config: ACPAgentConfig
}

export interface ACPAddAgentResponse {
  success: boolean
  agent?: ACPAgentState
  error?: string
}

export interface ACPUpdateAgentRequest {
  config: ACPAgentConfig
}

export interface ACPUpdateAgentResponse {
  success: boolean
  agent?: ACPAgentState
  error?: string
}

export interface ACPRemoveAgentRequest {
  agentId: string
}

export interface ACPRemoveAgentResponse {
  success: boolean
  error?: string
}

export interface ACPConnectAgentRequest {
  agentId: string
}

export interface ACPConnectAgentResponse {
  success: boolean
  agent?: ACPAgentState
  error?: string
}

export interface ACPDisconnectAgentRequest {
  agentId: string
}

export interface ACPDisconnectAgentResponse {
  success: boolean
  error?: string
}

export interface ACPRefreshAgentRequest {
  agentId: string
}

export interface ACPRefreshAgentResponse {
  success: boolean
  agent?: ACPAgentState
  error?: string
}

/** 探测一台(`agentId`)或全部(缺席)。PATH 上找可执行 + 取版本号;不起 agent 进程。 */
export interface ACPDetectRequest {
  agentId?: string
}

/** 探测 / 刷注册表之后的整张名册(与 `getAgents` 同形)。 */
export type ACPDetectResponse = ACPGetAgentsResponse

/** 立刻重拉官方注册表(不看 24h 缓存),再探测一遍。注册表开关关着时只重读种子与探测。 */
export type ACPRefreshRegistryResponse = ACPGetAgentsResponse

export interface ACPCancelSessionRequest {
  sessionId: string
  agentId?: string
}

export interface ACPCancelSessionResponse {
  success: boolean
  error?: string
}

/**
 * 选择器右栏读这一格。`sessionId` 缺席或那条会话还没落盘 = 草稿态:不起 agent 进程,
 * 答上次见过的目录(`live: false`)。
 */
export interface ACPSessionOptionsRequest {
  agentId: string
  sessionId?: string
}

export interface ACPSessionOptionsResponse {
  success: boolean
  options: ACPSessionOption[]
  live: boolean
  error?: string
}

export interface ACPSetSessionOptionRequest {
  agentId: string
  sessionId?: string
  optionId: string
  value: string
}

export type ACPSetSessionOptionResponse = ACPSessionOptionsResponse

/**
 * 这条会话在 agent 那边此刻的状态快照(A0-2)。没开过 ACP 会话 / 不是 ACP 会话 = `null`。
 * 变化另走全局事件 `acp:session-state`,这一条是冷启动与补读用的。
 */
export interface ACPSessionStateRequest {
  sessionId: string
  /** 同一条本地会话换过 agent 时指定读哪一台;缺席 = 找正开着它的那台。 */
  agentId?: string
}

export type ACPSessionStateResponse = AcpSessionState | null

// ============================================================================
// acp 域的 router —— 结构债 P4c 第六批
// ============================================================================

/**
 * acp(外部 Agent Client Protocol 代理)域 —— **八条**方法从手写 IPC 通道搬到
 * 通用 `rpc:invoke` / `POST /api/rpc`:`ACP_GET_AGENTS` / `ACP_ADD_AGENT` /
 * `ACP_UPDATE_AGENT` / `ACP_REMOVE_AGENT` / `ACP_CONNECT_AGENT` /
 * `ACP_DISCONNECT_AGENT` / `ACP_REFRESH_AGENT` / `ACP_CANCEL_SESSION`。
 *
 * 这一域**一条推送都没有**:agent 连上以后的流是会话事件,不是这个域的通道。
 * 所以搬完之后 `apps/electron/src/ipc/acp.ts` 整只删掉,`@main/ipc/acp.ts` 只剩
 * `initializeACP` / `shutdownACP` 两件生命周期(它们要 `ACPManager` 的进程内
 * 单例与权限桥,不是传输面)。
 *
 * 位置参数一律折成信封(与 sessions / media / skills / chat 同一判例);
 * 无参的 `getAgents` 按本仓惯例递 `{}`。
 */
export type AcpRoutes = {
  getAgents: { input: Record<string, never>; output: ACPGetAgentsResponse }
  addAgent: { input: ACPAddAgentRequest; output: ACPAddAgentResponse }
  updateAgent: { input: ACPUpdateAgentRequest; output: ACPUpdateAgentResponse }
  removeAgent: { input: ACPRemoveAgentRequest; output: ACPRemoveAgentResponse }
  connectAgent: { input: ACPConnectAgentRequest; output: ACPConnectAgentResponse }
  disconnectAgent: {
    input: ACPDisconnectAgentRequest
    output: ACPDisconnectAgentResponse
  }
  refreshAgent: { input: ACPRefreshAgentRequest; output: ACPRefreshAgentResponse }
  cancelSession: {
    input: ACPCancelSessionRequest
    output: ACPCancelSessionResponse
  }
  sessionOptions: { input: ACPSessionOptionsRequest; output: ACPSessionOptionsResponse }
  setSessionOption: { input: ACPSetSessionOptionRequest; output: ACPSetSessionOptionResponse }
  sessionState: { input: ACPSessionStateRequest; output: ACPSessionStateResponse }
  detect: { input: ACPDetectRequest; output: ACPDetectResponse }
  refreshRegistry: { input: Record<string, never>; output: ACPRefreshRegistryResponse }
}

export const acpRouter = defineRouter<AcpRoutes>('acp', [
  'getAgents',
  'addAgent',
  'updateAgent',
  'removeAgent',
  'connectAgent',
  'disconnectAgent',
  'refreshAgent',
  'cancelSession',
  'sessionOptions',
  'setSessionOption',
  'sessionState',
  'detect',
  'refreshRegistry',
])
