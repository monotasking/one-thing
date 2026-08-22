export type GatewayChannelId = 'wechat'

export type GatewayWechatLoginStatus =
  | 'idle'
  | 'waiting-for-scan'
  | 'scanned'
  | 'confirmed'
  | 'logged-in'
  | 'expired'
  | 'error'

export interface GatewayWechatStatus {
  id?: string
  label?: string
  enabled: boolean
  running: boolean
  loginStatus: GatewayWechatLoginStatus
  qrUrl?: string
  loggedIn: boolean
  accountId?: string
  botId?: string
  baseUrl?: string
  lastError?: string
  lastUpdatedAt?: number
}

export interface GatewayWechatAccountStatus extends GatewayWechatStatus {
  id: string
}

export interface GatewayStatus {
  running: boolean
  starting: boolean
  stopping: boolean
  enabled: boolean
  lastError?: string
  wechat: GatewayWechatStatus
  wechatAccounts?: GatewayWechatAccountStatus[]
}

export interface GatewayGetStatusResponse {
  success: boolean
  status?: GatewayStatus
  error?: string
}

export interface GatewayStartRequest {
  channel?: GatewayChannelId
  accountId?: string
}

export interface GatewayWechatAddAccountRequest {
  label?: string
}

export interface GatewayWechatRemoveAccountRequest {
  accountId: string
}

export interface GatewayWechatStopAccountRequest {
  accountId: string
}

export interface GatewayWechatLogoutRequest {
  accountId?: string
}

export interface GatewayWechatRenameAccountRequest {
  accountId: string
  label?: string
}

export interface GatewayStartResponse {
  success: boolean
  status?: GatewayStatus
  error?: string
}

export interface GatewayStopResponse {
  success: boolean
  status?: GatewayStatus
  error?: string
}

export interface GatewayWechatLogoutResponse {
  success: boolean
  status?: GatewayStatus
  error?: string
}

export interface GatewayWechatAddAccountResponse {
  success: boolean
  status?: GatewayStatus
  account?: GatewayWechatAccountStatus
  error?: string
}

export interface GatewayWechatRemoveAccountResponse {
  success: boolean
  status?: GatewayStatus
  error?: string
}

export interface GatewayWechatStopAccountResponse {
  success: boolean
  status?: GatewayStatus
  error?: string
}

export interface GatewayWechatRenameAccountResponse {
  success: boolean
  status?: GatewayStatus
  account?: GatewayWechatAccountStatus
  error?: string
}

// ============================================
// Router
// ============================================

/**
 * gateway(IM 网关)域 —— 结构债 P4c 第八批,八条数据面整只从手写 IPC 通道迁到
 * 通用 `rpc:invoke` / `POST /api/rpc`。
 *
 * 八条方法**逐条对应**从前 `IPC_CHANNELS` 上那八条 `gateway:*` 通道,请求/响应
 * 形状一字未改;变的只是通道:壳上八条包装、`platform/web.ts` 的八条 REST 镜像、
 * `server/http.ts` 的八条路由与 `server/runtime.ts` 那份 `gateway` facade adapter,
 * 一起消失。
 *
 * **本域零推送** —— 全仓没有任何 `GATEWAY_*_CHANGED` 通道,状态靠调用方在每次
 * 操作后重新 `getStatus()` 轮询(`ChannelsSettingsTab.vue` 的 `runGatewayAction`
 * 就是这么写的)。所以这一批不需要立广播端口。
 *
 * 无参的两条(`getStatus` / `stop`)按本仓惯例递 `{}`;其余六条递原来的请求对象。
 */
import { defineRouter } from './router.js'

export type GatewayRoutes = {
  getStatus: { input: Record<string, never>; output: GatewayGetStatusResponse }
  start: { input: GatewayStartRequest; output: GatewayStartResponse }
  stop: { input: Record<string, never>; output: GatewayStopResponse }
  wechatLogout: { input: GatewayWechatLogoutRequest; output: GatewayWechatLogoutResponse }
  wechatAddAccount: {
    input: GatewayWechatAddAccountRequest
    output: GatewayWechatAddAccountResponse
  }
  wechatStopAccount: {
    input: GatewayWechatStopAccountRequest
    output: GatewayWechatStopAccountResponse
  }
  wechatRemoveAccount: {
    input: GatewayWechatRemoveAccountRequest
    output: GatewayWechatRemoveAccountResponse
  }
  wechatRenameAccount: {
    input: GatewayWechatRenameAccountRequest
    output: GatewayWechatRenameAccountResponse
  }
}

export const gatewayRouter = defineRouter<GatewayRoutes>('gateway', [
  'getStatus',
  'start',
  'stop',
  'wechatLogout',
  'wechatAddAccount',
  'wechatStopAccount',
  'wechatRemoveAccount',
  'wechatRenameAccount',
])
