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
