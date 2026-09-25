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
  AcpReconnectBackoff,
  AcpRemoteSessionInfo,
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
  AcpReconnectBackoff,
  AcpRemoteSessionInfo,
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
 * 切这条会话的模式(A2-b,协议 `session/set_mode`)。`agentId` 缺席 = 正开着这条会话的那台。
 * 模式表与当前值在 `acp.sessionState(...).modes`;切完之后 agent 推的 `current_mode_update`
 * 也折进同一格,经 `acp:session-state` 到壳。
 */
export interface ACPSetSessionModeRequest {
  sessionId: string
  agentId?: string
  modeId: string
}

/** 成功时带切完之后的状态表(`state`);失败时 `error` 是一句给排障看的原话。 */
export type ACPSetSessionModeResponse =
  | { success: true; state: AcpSessionState | null }
  | { success: false; error: string }

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

/**
 * 会话生命(A5,方案 §3.7 / §11.6)的四条。失败的 `code` 是稳定的机器码(壳按它查文案表),
 * `error` 是一句给排障看的原话:`unsupported` = 这台 agent 在握手里没自报那项能力
 * (`sessionCapabilities.list` / `fork`,或认领要的 `loadSession`);`unavailable` = 连不上 / 停用 /
 * 名册里没有 / 崩溃退避锁着;`failed` = agent 拒了或本地落不下。
 */
export type AcpSessionLifecycleFailure = {
  ok: false
  code: 'unsupported' | 'unavailable' | 'failed'
  error: string
}

/** 列 agent 那边的会话(协议 `session/list`,翻页直到没有 cursor,上限 500 条)。 */
export interface ACPListRemoteSessionsRequest {
  agentId: string
  cwd?: string
}

export type ACPListRemoteSessionsResponse =
  | { ok: true; sessions: AcpRemoteSessionInfo[] }
  | AcpSessionLifecycleFailure

/**
 * 认领 agent 那边的一条会话:建本地会话 + 链接 + `session/load`,回放的历史折成
 * `message/imported` 进账本。幂等:同一台 agent 的同一条会话认领过(本地会话还在)就答那一条,
 * `alreadyAdopted: true`、`imported: 0`。
 */
export interface ACPAdoptSessionRequest {
  agentId: string
  acpSessionId: string
  cwd: string
}

export type ACPAdoptSessionResponse =
  | { ok: true; sessionId: string; imported: number; alreadyAdopted: boolean }
  | AcpSessionLifecycleFailure

/**
 * 分叉(协议 `session/fork`):新本地会话(同目录、带着本地这边的历史)绑到 agent fork 出来的那条。
 * `agentId` 缺席 = 这条会话选着的那台 agent。
 */
export interface ACPForkSessionRequest {
  sessionId: string
  agentId?: string
}

export type ACPForkSessionResponse =
  | { ok: true; sessionId: string }
  | AcpSessionLifecycleFailure

/** 「重新连接」:清掉崩溃退避的锁,再连一次。 */
export interface ACPReconnectAgentRequest {
  agentId: string
}

export type ACPReconnectAgentResponse =
  | { ok: true; state: ACPAgentState }
  | { ok: false; error: string }

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
  setSessionMode: { input: ACPSetSessionModeRequest; output: ACPSetSessionModeResponse }
  detect: { input: ACPDetectRequest; output: ACPDetectResponse }
  refreshRegistry: { input: Record<string, never>; output: ACPRefreshRegistryResponse }
  authenticate: { input: ACPAuthenticateRequest; output: ACPAuthenticateResponse }
  listRemoteSessions: { input: ACPListRemoteSessionsRequest; output: ACPListRemoteSessionsResponse }
  adoptSession: { input: ACPAdoptSessionRequest; output: ACPAdoptSessionResponse }
  forkSession: { input: ACPForkSessionRequest; output: ACPForkSessionResponse }
  reconnectAgent: { input: ACPReconnectAgentRequest; output: ACPReconnectAgentResponse }
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
  'setSessionMode',
  'detect',
  'refreshRegistry',
  'authenticate',
  'listRemoteSessions',
  'adoptSession',
  'forkSession',
  'reconnectAgent',
])
