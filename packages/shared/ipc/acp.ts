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
  AcpAgentAuth,
  AcpAgentSource,
  AcpAuthMethod,
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
  AcpAgentAuth,
  AcpAgentSource,
  AcpAuthMethod,
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

/**
 * 「去登录」(A3-c,方案 §3.5 / §3.9 ②):按 agent 自报的一种方法登录。
 *  - 终端型:onething 开一格终端跑那台 agent 自己的登录程序,**立刻**答 `terminalId`(壳开终端瓦
 *    让人在里面走完流程);程序退出码 0 = 登录成功,后端清掉 `auth.required` 并断开那台 agent,
 *    下一轮自然带着新凭据重连。结局经 `acp:agent-state` 推给壳。
 *  - agent 型:调 agent 的 `authenticate({ methodId })`,等它答完;成功即清 `auth.required`。
 */
export interface ACPAuthenticateRequest {
  agentId: string
  methodId: string
}

/**
 * 失败的 `code` 是稳定的机器码(壳按它查自己的文案表),`error` 是一句给排障看的原话:
 * `unavailable` = 这台宿主没装登录桥;`no-terminal` = 终端型方法但这台机器上没有终端可用;
 * `unknown-agent` / `unknown-method` = 名册里没有这台 / 它没自报这种方法;`failed` = agent 拒了或起不来。
 */
export type ACPAuthenticateResponse =
  | { ok: true; terminalId?: string }
  | { ok: false; code: 'unavailable' | 'no-terminal' | 'unknown-agent' | 'unknown-method' | 'failed'; error: string }

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
  authenticate: { input: ACPAuthenticateRequest; output: ACPAuthenticateResponse }
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
  'authenticate',
])
