/**
 * OAuth Module
 * OAuth-related type definitions for IPC communication
 */

/**
 * 凭证的写回目标(批 B6;批 8 `docs/design/subscription-accounts-2026-09.md` §8 归一)。
 *
 * 令牌一律住在空间的凭证池里(`workspaces/<id>/credentials.json`)。`spaceId` **缺席 = 默认
 * 空间那一池** —— 默认空间不再有自己的单槽(`<store>/oauth-tokens.json` 已退役),它和别的
 * 空间一样一家可以有多条 oauth entry。
 *
 * `entryId`:登录时缺席 = 追加一个新账号(同一身份再登一次 = 更新那一条);带上 = 重新授权
 * 那一条。读 / 退出时缺席 = 这一池第一个可用账号(兼容口),带上 = 那一条。
 * OAuth token **不能跨空间复制**(共用一串 refresh token 在 rotation 下会互相作废),
 * 所以每个空间必须自己登一次;也**不跨空间回落**。
 */
export interface OAuthCredentialTargetRequest {
  spaceId?: string
  entryId?: string
  /** 新建 entry 的展示名。只在 `entryId` 缺席时用得上。 */
  label?: string
}

// OAuth start request
export interface OAuthStartRequest extends OAuthCredentialTargetRequest {
  providerId: string
}

// OAuth start response (for authorization-code flow with PKCE)
export interface OAuthStartResponse {
  success: boolean
  flowId?: string
  flowKind?: 'pkce-callback' | 'manual-pkce' | 'device-code'
  pollIntervalMs?: number
  expiresAt?: number
  statusMessage?: string
  // For PKCE flow - returns auth URL to open in browser
  authUrl?: string
  state?: string
  // For device flow - returns user code to display
  userCode?: string
  verificationUri?: string
  expiresIn?: number
  interval?: number
  // For manual code entry flow (Claude Code)
  requiresCodeEntry?: boolean
  instructions?: string
  error?: string
}

// OAuth callback request (after user completes auth in browser)
export interface OAuthCallbackRequest extends OAuthCredentialTargetRequest {
  providerId: string
  code: string
  state: string
}

// OAuth callback response
export interface OAuthCallbackResponse {
  success: boolean
  error?: string
}

// OAuth status request
export interface OAuthStatusRequest extends OAuthCredentialTargetRequest {
  providerId: string
}

/**
 * 池里一个订阅账号的登录态(批 8 §8.3)。已登录屏每账号一行读的就是它;**没有令牌原文**。
 */
export interface OAuthAccountStatus {
  /** 池条目 id —— 重新授权 / 退出 / 排序都按它认。 */
  entryId: string
  label: string
  email?: string
  accountId?: string
  planType?: string
  /** 令牌过期,或读不出来。两者同一种处置:重新授权。 */
  isExpired: boolean
  expiresAt?: number
  canRefresh?: boolean
}

// OAuth status response
export interface OAuthStatusResponse {
  success: boolean
  providerId?: string
  /** 这份登录态说的是池里哪一条(不指名时是兼容口选中的那一条;一条都没有就缺席)。 */
  entryId?: string
  isLoggedIn: boolean
  isExpired?: boolean
  canRefresh?: boolean
  expiresAt?: number
  account?: {
    id?: string
    email?: string
    planType?: string
    isFedramp?: boolean
  }
  /** 这个空间这一家的全部订阅账号(池序 = 余量相同时的优先级)。 */
  accounts?: OAuthAccountStatus[]
  lastError?: string
  error?: string
}

// OAuth logout request
export interface OAuthLogoutRequest extends OAuthCredentialTargetRequest {
  providerId: string
}

// OAuth logout response
export interface OAuthLogoutResponse {
  success: boolean
  error?: string
}

// OAuth device poll request (for device flow)
export interface OAuthDevicePollRequest extends OAuthCredentialTargetRequest {
  providerId: string
  deviceCode?: string
  flowId?: string
}

// OAuth device poll response
export interface OAuthDevicePollResponse {
  success: boolean
  completed: boolean
  error?: string
  // 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied'
  pollStatus?: string
}

// OAuth refresh request / response
export interface OAuthRefreshRequest extends OAuthCredentialTargetRequest {
  providerId: string
}

export interface OAuthRefreshResponse {
  success: boolean
  error?: string
}

// OAuth cancel request / response(批 1,`docs/design/provider-settings-rework-2026-09.md` §3.1)
export interface OAuthCancelRequest {
  flowId: string
}

export interface OAuthCancelResponse {
  success: boolean
  /** 真的取消了一条还在跑的流。`false` = 这条流早已不在(完成 / 超时 / 取消过)。 */
  cancelled: boolean
  error?: string
}

/**
 * 登录流的相位 —— 全局事件 `oauth:flow` 的载荷(`@shared/events` 的 `OAuthFlowGlobalEvent`)。
 * `pending` 只在起流时发一次;其余四档是终局。
 */
export type OAuthFlowPhase = 'pending' | 'completed' | 'failed' | 'expired' | 'cancelled'

export interface OAuthFlowEventPayload {
  providerId: string
  flowId: string
  phase: OAuthFlowPhase
  /** 服务商原话(`access_denied` / `expired_token` / token 端点的报错)。 */
  error?: string
}

// ============================================
// Router
// ============================================

/**
 * oauth(订阅登录)域 —— 结构债 P4c 第七批,六条数据面从手写 IPC 通道迁到通用
 * `rpc:invoke` / `POST /api/rpc`。
 *
 * 六条方法**逐条对应**从前 `IPC_CHANNELS` 上那六条 oauth invoke 通道,信封形状
 * 也一字未改(`{ providerId, ...credentialTarget }`)—— 从前壳上那几条包装是把
 * `(providerId, target)` 两个位置参数现拼成同一个对象,现在渲染侧直接递对象。
 *
 * **两条推送不在这张表上**:`OAUTH_TOKEN_REFRESHED` / `OAUTH_TOKEN_EXPIRED` 走
 * `configureOAuthEventBroadcaster` 注入端口(`@onething/backend/auth/oauth-events`),
 * 桌面推 `webContents.send`、server 推 `GET /api/oauth/events` 那条 SSE ——
 * router 今天没有推送面,白名单上多一条就等于承诺了一条不存在的通道。
 *
 * `start` 是本域唯一按 `context.transport` 分叉的一条:http 上不开浏览器
 * (旧 server 路由从来就没递过 `openExternal`,逐字保留)。
 */
import { defineRouter } from './router.js'

export type OAuthRoutes = {
  start: { input: OAuthStartRequest; output: OAuthStartResponse }
  callback: { input: OAuthCallbackRequest; output: OAuthCallbackResponse }
  devicePoll: { input: OAuthDevicePollRequest; output: OAuthDevicePollResponse }
  refresh: { input: OAuthRefreshRequest; output: OAuthRefreshResponse }
  status: { input: OAuthStatusRequest; output: OAuthStatusResponse }
  logout: { input: OAuthLogoutRequest; output: OAuthLogoutResponse }
  /** 取消一条登录流(批 1)。后端持有流的计时器,取消就是它收尾并发 `oauth:flow cancelled`。 */
  cancel: { input: OAuthCancelRequest; output: OAuthCancelResponse }
}

export const oauthRouter = defineRouter<OAuthRoutes>('oauth', [
  'start',
  'callback',
  'devicePoll',
  'refresh',
  'status',
  'logout',
  'cancel',
])
