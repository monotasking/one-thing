import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { withProviderRetryAfter } from '../agent-loop/provider-error-classification.js'
import {
  credentialRefreshKey,
  credentialTargetKey,
  isSpaceCredentialTarget,
  SETTINGS_CREDENTIAL_TARGET,
  type OnethingCredentialTarget,
} from './credential-target.js'
import {
  generatePKCE,
  getAuthProviderDefinition,
  normalizeGenericOAuthToken,
} from './registry.js'
import type { OnethingSpaceAuthTokenStore } from './space-token-store.js'
import type {
  OnethingAuthAccount,
  OnethingAuthBodyFormat,
  OnethingAuthFlowState,
  OnethingAuthProviderDefinition,
  OnethingOAuthCallbackResponse,
  OnethingOAuthDevicePollResponse,
  OnethingOAuthStartResponse,
  OnethingOAuthStatusResponse,
  OnethingOAuthToken,
  OnethingProviderAuthContext,
} from './types.js'

const FLOW_TIMEOUT_MS = 5 * 60 * 1000
const REFRESH_BUFFER_MS = 5 * 60 * 1000

export interface OnethingAuthTokenStore<TToken extends OnethingOAuthToken = OnethingOAuthToken> {
  getToken(providerId: string): Promise<TToken | null>
  saveToken(providerId: string, token: TToken): Promise<void>
  deleteToken(providerId: string): Promise<void>
  isTokenExpired(token: TToken): boolean
}

export interface OnethingAuthCallbackRegistration {
  flowId: string
  providerId: string
  state: string
  path: string
  ports: number[]
  timeoutMs: number
  onCallback: (params: {
    code: string
    state: string
    /** RFC 9207 issuer identifier, when the AS stamped it on the redirect. */
    iss?: string
    flowId: string
    providerId: string
  }) => Promise<void>
}

export interface OnethingAuthCallbackServerAdapter {
  registerFlow(options: OnethingAuthCallbackRegistration): Promise<{ redirectUri: string; port: number }>
  unregisterState(state: string): void
  cleanup(): void
}

export interface OnethingAuthServiceOptions<TToken extends OnethingOAuthToken = OnethingOAuthToken> {
  tokenStore: OnethingAuthTokenStore<TToken>
  /**
   * per-space 的 token 存放面(批 B6)。**缺席 = 只有默认空间**:任何带 space
   * 目标的调用都会退回 settings 那一份 —— 宿主没装这块就当它不存在,而不是
   * 半路抛错。
   */
  spaceTokenStore?: OnethingSpaceAuthTokenStore<TToken>
  fetch?: typeof fetch
  getDefinition?: (providerId: string) => OnethingAuthProviderDefinition | undefined
  callbackServer?: OnethingAuthCallbackServerAdapter
  createId?: () => string
  now?: () => number
  logger?: Pick<Console, 'warn'>
}

/** 事件载荷。`target` 缺席 = 默认空间(settings 源),与调用侧缺省一致。 */
export interface OnethingAuthTokenEvent {
  providerId: string
  target?: OnethingCredentialTarget
  error?: string
}

export class OnethingAuthService<TToken extends OnethingOAuthToken = OnethingOAuthToken> extends EventEmitter {
  private readonly tokenStore: OnethingAuthTokenStore<TToken>
  private readonly spaceTokenStore?: OnethingSpaceAuthTokenStore<TToken>
  private readonly fetchImpl: typeof fetch
  private readonly getDefinitionImpl: (providerId: string) => OnethingAuthProviderDefinition | undefined
  private readonly callbackServer?: OnethingAuthCallbackServerAdapter
  private readonly createId: () => string
  private readonly now: () => number
  private readonly logger: Pick<Console, 'warn'>
  private flows = new Map<string, OnethingAuthFlowState>()
  /** key = `providerId::<target>` —— 同一个 provider 在两个空间是两条独立的登录流。 */
  private providerFlowIds = new Map<string, string>()
  private providerErrors = new Map<string, string>()
  /**
   * 刷新单飞锁(盲点 5)。并发 refresh 会互相作废 refresh token:第二次拿着
   * 已经被消费掉的那一串去换,换回来的是一个错误,而它可能还会覆盖第一次的成果。
   * 锁的粒度**恰好等于 token 的存放位置**(`credentialRefreshKey`)—— 粗一格会让
   * A 空间的调用拿到 B 空间的 token,细一格就等于没锁。
   */
  private refreshInFlight = new Map<string, Promise<TToken>>()

  constructor(options: OnethingAuthServiceOptions<TToken>) {
    super()
    this.tokenStore = options.tokenStore
    this.spaceTokenStore = options.spaceTokenStore
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.getDefinitionImpl = options.getDefinition ?? getAuthProviderDefinition
    this.callbackServer = options.callbackServer
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? (() => Date.now())
    this.logger = options.logger ?? console
  }

  getDefinition(providerId: string): OnethingAuthProviderDefinition | undefined {
    return this.getDefinitionImpl(providerId)
  }

  /**
   * 目标归一。**宿主没装 spaceTokenStore 时 space 目标一律退回 settings** ——
   * 那种宿主(CLI daemon / server)本来就只有默认空间,让它半路抛错等于把一个
   * 不适用的功能变成一个 bug。
   */
  private resolveTarget(target?: OnethingCredentialTarget | null): OnethingCredentialTarget {
    if (isSpaceCredentialTarget(target) && this.spaceTokenStore) return target
    return SETTINGS_CREDENTIAL_TARGET
  }

  private async readToken(
    providerId: string,
    target: OnethingCredentialTarget,
  ): Promise<TToken | null> {
    return isSpaceCredentialTarget(target) && this.spaceTokenStore
      ? this.spaceTokenStore.getToken(providerId, target)
      : this.tokenStore.getToken(providerId)
  }

  /** 写回。space 目标会回报真正落地的 entryId(新登录时才知道)。 */
  private async writeToken(
    providerId: string,
    token: TToken,
    target: OnethingCredentialTarget,
  ): Promise<OnethingCredentialTarget> {
    if (isSpaceCredentialTarget(target) && this.spaceTokenStore) {
      const { entryId } = await this.spaceTokenStore.saveToken(providerId, token, target)
      return { ...target, entryId }
    }
    await this.tokenStore.saveToken(providerId, token)
    return SETTINGS_CREDENTIAL_TARGET
  }

  private async removeToken(
    providerId: string,
    target: OnethingCredentialTarget,
  ): Promise<void> {
    if (isSpaceCredentialTarget(target) && this.spaceTokenStore) {
      await this.spaceTokenStore.deleteToken(providerId, target)
      return
    }
    await this.tokenStore.deleteToken(providerId)
  }

  private flowKey(providerId: string, target?: OnethingCredentialTarget | null): string {
    return `${providerId}::${credentialTargetKey(target)}`
  }

  async start(
    providerId: string,
    target?: OnethingCredentialTarget,
  ): Promise<OnethingOAuthStartResponse> {
    const definition = this.requireDefinition(providerId)
    const resolvedTarget = this.resolveTarget(target)
    this.clearProviderFlow(providerId, resolvedTarget)

    if (definition.flowKind === 'device-code') {
      return this.startDeviceFlow(definition, resolvedTarget)
    }

    const { codeVerifier, codeChallenge } = generatePKCE()
    const flowId = this.createId()
    const state = definition.stateStrategy === 'code-verifier' ? codeVerifier : this.createId()
    let redirectUri = definition.redirectUri || ''

    const flow: OnethingAuthFlowState = {
      flowId,
      providerId,
      target: resolvedTarget,
      kind: definition.flowKind,
      state,
      codeVerifier,
      codeChallenge,
      redirectUri,
      expiresAt: this.now() + FLOW_TIMEOUT_MS,
    }

    if (definition.flowKind === 'pkce-callback') {
      if (!this.callbackServer) {
        throw new Error(`Callback server not configured for ${providerId}`)
      }

      const callbackPath = definition.callbackPath || '/callback'
      const callbackPorts = definition.callbackPorts || [54545]
      const registration = await this.callbackServer.registerFlow({
        flowId,
        providerId,
        state,
        path: callbackPath,
        ports: callbackPorts,
        timeoutMs: FLOW_TIMEOUT_MS,
        onCallback: async ({ code, state: returnedState }) => {
          try {
            await this.completeAuthorizationCodeFlow(providerId, code, returnedState, flowId)
          } catch (error) {
            const message = this.toPublicError(error, 'OAuth callback failed')
            this.providerErrors.set(this.flowKey(providerId, resolvedTarget), message)
            this.emit('token-expired', { providerId, target: resolvedTarget, error: message })
          }
        },
      })
      redirectUri = registration.redirectUri
      flow.redirectUri = redirectUri
    }

    this.flows.set(flowId, flow)
    this.providerFlowIds.set(this.flowKey(providerId, resolvedTarget), flowId)
    this.providerErrors.delete(this.flowKey(providerId, resolvedTarget))

    const authUrl = this.buildAuthorizationUrl(definition, {
      providerId,
      flowId,
      codeVerifier,
      codeChallenge,
      state,
      redirectUri,
    })

    return {
      success: true,
      authUrl,
      state,
      flowId,
      flowKind: definition.flowKind,
      expiresAt: flow.expiresAt,
      pollIntervalMs: definition.flowKind === 'pkce-callback' ? 2000 : undefined,
      requiresCodeEntry: definition.flowKind === 'manual-pkce',
      instructions: definition.flowKind === 'manual-pkce' ? definition.codeEntryInstructions : undefined,
      statusMessage: definition.statusMessage,
    }
  }

  async completeManualCode(
    providerId: string,
    code: string,
    state: string,
    target?: OnethingCredentialTarget,
  ): Promise<OnethingOAuthCallbackResponse> {
    const resolvedTarget = this.resolveTarget(target)
    try {
      await this.completeAuthorizationCodeFlow(providerId, code, state, undefined, resolvedTarget)
      return { success: true }
    } catch (error) {
      const message = this.toPublicError(error, 'OAuth callback failed')
      this.providerErrors.set(this.flowKey(providerId, resolvedTarget), message)
      return { success: false, error: message }
    }
  }

  async pollDeviceFlow(
    providerId: string,
    flowId?: string,
    target?: OnethingCredentialTarget,
  ): Promise<OnethingOAuthDevicePollResponse> {
    const definition = this.requireDefinition(providerId)
    if (definition.flowKind !== 'device-code') {
      return { success: false, completed: false, error: `Device flow not supported for ${providerId}` }
    }

    const flow = this.getFlow(providerId, flowId, this.resolveTarget(target))
    if (!flow?.deviceCode || flow.kind !== 'device-code') {
      return { success: false, completed: false, error: 'expired_token' }
    }
    if (this.now() > flow.expiresAt) {
      this.clearFlow(flow.flowId)
      return { success: false, completed: false, error: 'expired_token' }
    }

    const response = await this.authFetch(definition.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        client_id: definition.clientId,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: flow.deviceCode,
      }).toString(),
    })

    const data = await response.json()
    if (data.error) {
      if (data.error === 'authorization_pending') {
        return { success: true, completed: false, pollStatus: 'authorization_pending' }
      }
      if (data.error === 'slow_down') {
        flow.intervalMs = (flow.intervalMs || 5000) + 5000
        return { success: true, completed: false, pollStatus: 'slow_down' }
      }
      this.clearFlow(flow.flowId)
      return { success: false, completed: false, error: data.error, pollStatus: data.error }
    }

    const token = this.normalizeToken(definition, data)
    const flowTarget = this.resolveTarget(flow.target as OnethingCredentialTarget | undefined)
    const savedTarget = await this.writeToken(providerId, token, flowTarget)
    this.clearFlow(flow.flowId)
    this.providerErrors.delete(this.flowKey(providerId, flowTarget))
    this.emit('token-refreshed', { providerId, target: savedTarget })
    return { success: true, completed: true }
  }

  /**
   * 刷新。**单飞**(盲点 5):同一个 (provider, 目标) 上并发调用只会真的发一次
   * 请求,其余人等同一个 promise。粒度见 `credentialRefreshKey` 的注释。
   */
  async refreshToken(
    providerId: string,
    target?: OnethingCredentialTarget,
  ): Promise<TToken> {
    const resolvedTarget = this.resolveTarget(target)
    const key = credentialRefreshKey(providerId, resolvedTarget)
    const inFlight = this.refreshInFlight.get(key)
    if (inFlight) return inFlight

    const run = this.performRefresh(providerId, resolvedTarget)
    // 先落表再挂清理:清理只在自己还是当表里那一份时才删,避免把后一轮的
    // 单飞记录顺手抹掉。
    this.refreshInFlight.set(key, run)
    void run.catch(() => undefined).finally(() => {
      if (this.refreshInFlight.get(key) === run) this.refreshInFlight.delete(key)
    })
    return run
  }

  private async performRefresh(
    providerId: string,
    target: OnethingCredentialTarget,
  ): Promise<TToken> {
    const definition = this.requireDefinition(providerId)
    const currentToken = await this.readToken(providerId, target)
    if (!currentToken?.refreshToken) {
      throw new Error('No refresh token available')
    }

    const format = definition.refreshBodyFormat || definition.tokenBodyFormat || 'form'
    const params = definition.refreshParams
      ? definition.refreshParams(currentToken.refreshToken)
      : {
          client_id: definition.clientId,
          grant_type: 'refresh_token',
          refresh_token: currentToken.refreshToken,
        }

    const response = await this.authFetch(definition.refreshUrl || definition.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': contentTypeFor(format),
        'Accept': 'application/json',
        ...(definition.refreshHeaders ?? {}),
      },
      body: buildRequestBody(format, params),
    })

    if (!response.ok) {
      // 状态码挂在错误对象顶层 —— 批 D 的分类器要靠它把「refresh 被拒」判成
      // auth-invalid。裸消息 `Token refresh failed: 401` 不匹配分类器的锚定
      // 前缀(`API error: NNN` / `request failed (NNN)`),不带就永远是 unknown。
      const error = new Error(`Token refresh failed: ${response.status}`) as Error & {
        statusCode?: number
        responseBody?: string
      }
      error.statusCode = response.status
      error.responseBody = await response.text().catch(() => undefined)
      // 批 B8-2:token 端点同样会回 `Retry-After`(429 刷新过频)。
      // `classifyOAuthRefreshError` 已经会消费它,这里补上唯一的生产者。
      throw withProviderRetryAfter(error, {
        headers: response.headers,
        body: error.responseBody,
      })
    }

    const data = await response.json()
    const token = this.normalizeToken(definition, data, currentToken)
    const savedTarget = await this.writeToken(providerId, token, target)
    this.providerErrors.delete(this.flowKey(providerId, target))
    this.emit('token-refreshed', { providerId, target: savedTarget })
    return token
  }

  async refreshTokenIfNeeded(
    providerId: string,
    target?: OnethingCredentialTarget,
  ): Promise<TToken> {
    const resolvedTarget = this.resolveTarget(target)
    const token = await this.readToken(providerId, resolvedTarget)
    if (!token) throw new Error('Not logged in')

    if (token.expiresAt - this.now() < REFRESH_BUFFER_MS) {
      if (!token.refreshToken) {
        throw new Error('Token expired and no refresh token available')
      }
      // 走公开的 refreshToken —— 单飞锁在那里,绕过去就等于没有锁。
      return this.refreshToken(providerId, resolvedTarget)
    }

    return token
  }

  async getToken(providerId: string, target?: OnethingCredentialTarget): Promise<TToken | null> {
    return this.readToken(providerId, this.resolveTarget(target))
  }

  async saveToken(
    providerId: string,
    token: TToken,
    target?: OnethingCredentialTarget,
  ): Promise<void> {
    await this.writeToken(providerId, token, this.resolveTarget(target))
  }

  async deleteToken(providerId: string, target?: OnethingCredentialTarget): Promise<void> {
    const resolvedTarget = this.resolveTarget(target)
    this.clearProviderFlow(providerId, resolvedTarget)
    await this.removeToken(providerId, resolvedTarget)
    this.providerErrors.delete(this.flowKey(providerId, resolvedTarget))
  }

  isTokenExpired(token: TToken): boolean {
    return this.tokenStore.isTokenExpired(token)
  }

  async isLoggedIn(providerId: string, target?: OnethingCredentialTarget): Promise<boolean> {
    const token = await this.readToken(providerId, this.resolveTarget(target))
    return !!token && !this.tokenStore.isTokenExpired(token)
  }

  async getStatus(
    providerId: string,
    target?: OnethingCredentialTarget,
  ): Promise<OnethingOAuthStatusResponse> {
    const resolvedTarget = this.resolveTarget(target)
    const token = await this.readToken(providerId, resolvedTarget)
    const isExpired = token ? this.tokenStore.isTokenExpired(token) : false
    return {
      success: true,
      providerId,
      isLoggedIn: !!token && !isExpired,
      isExpired,
      canRefresh: !!token?.refreshToken,
      expiresAt: token?.expiresAt,
      account: toAccount(token),
      lastError: this.providerErrors.get(this.flowKey(providerId, resolvedTarget)),
    }
  }

  async resolveProviderAuth(
    providerId: string,
    apiKey?: string,
    target?: OnethingCredentialTarget,
  ): Promise<OnethingProviderAuthContext | null> {
    const definition = this.getDefinition(providerId)
    if (!definition) {
      return apiKey ? { kind: 'api-key', apiKey } : null
    }

    const token = await this.refreshTokenIfNeeded(providerId, target)
    return {
      kind: 'oauth',
      token,
      account: toAccount(token) || {},
    }
  }

  cleanup(): void {
    this.callbackServer?.cleanup()
    this.flows.clear()
    this.providerFlowIds.clear()
    this.refreshInFlight.clear()
  }

  private async startDeviceFlow(
    definition: OnethingAuthProviderDefinition,
    target: OnethingCredentialTarget,
  ): Promise<OnethingOAuthStartResponse> {
    if (!definition.deviceCodeUrl) {
      throw new Error(`Device flow not configured for ${definition.providerId}`)
    }

    const response = await this.authFetch(definition.deviceCodeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      // scope 只在真有的时候带:Kimi Code 的 device 端点不收 scope,发一个空串
      // 是在问「给我零个权限」—— 不是所有实现都会宽容地忽略它。
      body: new URLSearchParams({
        client_id: definition.clientId,
        ...(definition.scopes.length > 0 ? { scope: definition.scopes.join(' ') } : {}),
      }).toString(),
    })

    if (!response.ok) {
      throw new Error(`Device flow start failed: ${response.status}`)
    }

    const data = await response.json()
    const flowId = this.createId()
    const expiresIn = Number(data.expires_in || 900)
    const intervalMs = Number(data.interval || 5) * 1000
    const flow: OnethingAuthFlowState = {
      flowId,
      providerId: definition.providerId,
      target,
      kind: 'device-code',
      state: this.createId(),
      deviceCode: data.device_code,
      userCode: data.user_code,
      // `verification_uri_complete` 里已经带上了 user_code —— 有它就用它,
      // 用户点开就是确认页,不用再手抄一遍那八位码(RFC 8628 §3.3.1)。
      // 码本身照旧显示:验证页也会印出来,两边对得上才敢按确认。
      verificationUri: data.verification_uri_complete || data.verification_uri,
      intervalMs,
      expiresAt: this.now() + expiresIn * 1000,
    }

    this.flows.set(flowId, flow)
    this.providerFlowIds.set(this.flowKey(definition.providerId, target), flowId)
    this.providerErrors.delete(this.flowKey(definition.providerId, target))

    return {
      success: true,
      flowId,
      flowKind: 'device-code',
      userCode: flow.userCode,
      verificationUri: flow.verificationUri,
      expiresIn,
      interval: Math.round(intervalMs / 1000),
      pollIntervalMs: intervalMs,
      expiresAt: flow.expiresAt,
    }
  }

  private async completeAuthorizationCodeFlow(
    providerId: string,
    code: string,
    state: string,
    flowId?: string,
    target?: OnethingCredentialTarget,
  ): Promise<TToken> {
    const definition = this.requireDefinition(providerId)
    const flow = this.getFlow(providerId, flowId, target)
    if (!flow) {
      throw new Error('OAuth flow has expired. Please try logging in again.')
    }

    let actualCode = code.trim()
    let actualState = state
    if (actualCode.includes('#')) {
      const parts = actualCode.split('#')
      actualCode = parts[0]
      if (parts[1]) actualState = parts[1]
    }

    if (actualState && actualState !== flow.state) {
      throw new Error('OAuth state mismatch. Please try logging in again.')
    }

    const format = definition.tokenBodyFormat || 'form'
    const params = definition.tokenParams
      ? definition.tokenParams({
          providerId,
          flowId: flow.flowId,
          codeVerifier: flow.codeVerifier,
          codeChallenge: flow.codeChallenge,
          state: flow.state,
          redirectUri: flow.redirectUri,
          code: actualCode,
        })
      : {
          grant_type: 'authorization_code',
          client_id: definition.clientId,
          code: actualCode,
          redirect_uri: flow.redirectUri || definition.redirectUri || '',
          code_verifier: flow.codeVerifier || '',
        }

    const response = await this.authFetch(definition.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': contentTypeFor(format),
        'Accept': 'application/json',
        ...(definition.tokenHeaders ?? {}),
      },
      body: buildRequestBody(format, params),
    })

    if (!response.ok) {
      const error = new Error(`Token exchange failed: ${response.status}`) as Error & {
        statusCode?: number
      }
      error.statusCode = response.status
      throw error
    }

    const data = await response.json()
    const token = this.normalizeToken(definition, data)
    const flowTarget = this.resolveTarget(flow.target as OnethingCredentialTarget | undefined)
    const savedTarget = await this.writeToken(providerId, token, flowTarget)
    this.clearFlow(flow.flowId)
    this.providerErrors.delete(this.flowKey(providerId, flowTarget))
    this.emit('token-refreshed', { providerId, target: savedTarget })
    return token
  }

  private buildAuthorizationUrl(
    definition: OnethingAuthProviderDefinition,
    ctx: {
      providerId: string
      flowId: string
      codeVerifier: string
      codeChallenge: string
      state: string
      redirectUri: string
    },
  ): string {
    if (!definition.authorizationUrl) {
      throw new Error(`Authorization URL not configured for ${definition.providerId}`)
    }
    const params = definition.authorizationParams
      ? definition.authorizationParams(ctx)
      : {
          client_id: definition.clientId,
          response_type: 'code',
          redirect_uri: ctx.redirectUri || definition.redirectUri || '',
          code_challenge: ctx.codeChallenge,
          code_challenge_method: 'S256',
          scope: definition.scopes.join(' '),
          state: ctx.state,
        }
    return `${definition.authorizationUrl}?${new URLSearchParams(params).toString()}`
  }

  private normalizeToken(
    definition: OnethingAuthProviderDefinition,
    data: unknown,
    currentToken?: TToken | null,
  ): TToken {
    return (definition.normalizeToken
      ? definition.normalizeToken(data, currentToken)
      : normalizeGenericOAuthToken(data, currentToken)) as TToken
  }

  private requireDefinition(providerId: string): OnethingAuthProviderDefinition {
    const definition = this.getDefinition(providerId)
    if (!definition) throw new Error(`Unknown OAuth provider: ${providerId}`)
    return definition
  }

  /**
   * flowId 优先(回调/轮询都带着它),没有才按 (provider, 目标) 反查。
   * **反查一定要带目标** —— 否则一个空间的手输验证码会去认领另一个空间的流。
   */
  private getFlow(
    providerId: string,
    flowId?: string,
    target?: OnethingCredentialTarget,
  ): OnethingAuthFlowState | undefined {
    const resolvedFlowId = flowId
      || this.providerFlowIds.get(this.flowKey(providerId, this.resolveTarget(target)))
    if (!resolvedFlowId) return undefined
    const flow = this.flows.get(resolvedFlowId)
    if (!flow || flow.providerId !== providerId) return undefined
    return flow
  }

  private clearProviderFlow(providerId: string, target?: OnethingCredentialTarget): void {
    const flowId = this.providerFlowIds.get(this.flowKey(providerId, this.resolveTarget(target)))
    if (flowId) this.clearFlow(flowId)
  }

  private clearFlow(flowId: string): void {
    const flow = this.flows.get(flowId)
    if (!flow) return
    this.flows.delete(flowId)
    const key = this.flowKey(flow.providerId, flow.target as OnethingCredentialTarget | undefined)
    if (this.providerFlowIds.get(key) === flowId) {
      this.providerFlowIds.delete(key)
    }
    this.callbackServer?.unregisterState(flow.state)
  }

  private async authFetch(url: string, options: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, options)
    } catch (error) {
      this.logger.warn('[Auth] OAuth fetch failed:', error)
      throw error
    }
  }

  private toPublicError(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) return error.message
    return fallback
  }
}

function buildRequestBody(format: OnethingAuthBodyFormat, params: Record<string, string>): BodyInit {
  return format === 'json'
    ? JSON.stringify(params)
    : new URLSearchParams(params).toString()
}

function contentTypeFor(format: OnethingAuthBodyFormat): string {
  return format === 'json'
    ? 'application/json'
    : 'application/x-www-form-urlencoded'
}

function toAccount(token?: OnethingOAuthToken | null): OnethingAuthAccount | undefined {
  if (!token) return undefined
  const account: OnethingAuthAccount = {
    id: token.accountId,
    email: token.email,
    planType: token.planType,
    isFedramp: token.isFedrampAccount,
  }
  return Object.values(account).some(value => value !== undefined) ? account : undefined
}
