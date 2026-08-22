/**
 * OAuth Module
 * OAuth-related type definitions for IPC communication
 */

/**
 * 凭证的写回目标(批 B6)。**缺席 = 默认空间**(`<store>/oauth-tokens.json`),
 * 即这个字段出现之前的行为,一字未改。
 *
 * 带上 `spaceId` = 落进该空间的凭证池(`workspaces/<id>/credentials.json`);
 * `entryId` 缺席表示「登录一个新账号,追加一条 entry」——同一个 provider 允许
 * 多条 oauth entry。OAuth token **不能跨空间复制**(共用一串 refresh token 在
 * rotation 下会互相作废),所以每个空间必须自己登一次。
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

// OAuth status response
export interface OAuthStatusResponse {
  success: boolean
  providerId?: string
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
 * `configureOAuthEventBroadcaster` 注入端口(`@onething/backend/wiring/auth/oauth-events`),
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
}

export const oauthRouter = defineRouter<OAuthRoutes>('oauth', [
  'start',
  'callback',
  'devicePoll',
  'refresh',
  'status',
  'logout',
])
