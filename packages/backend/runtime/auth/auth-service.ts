import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { withProviderRetryAfter } from '../agent-loop/provider-error-classification.js'
import {
  credentialRefreshKey,
  credentialTargetKey,
  normalizeCredentialTarget,
  type OnethingCredentialTarget,
  type OnethingSpaceCredentialTarget,
} from './credential-target.js'
import {
  generatePKCE,
  getAuthProviderDefinition,
  normalizeGenericOAuthToken,
} from './registry.js'
import type { OnethingSpaceAuthTokenStore } from '@onething/backend/runtime/credentials'
import type {
  OnethingAuthAccount,
  OnethingOAuthAccountStatus,
  OnethingAuthBodyFormat,
  OnethingAuthFlowEvent,
  OnethingAuthFlowPhase,
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

/**
 * 令牌的存放面。**只有一种**:空间的凭证池(批 8 起默认空间也是,`<store>/oauth-tokens.json`
 * 那一把单槽退役)。形状见 `space-token-store.ts`。
 */
export type OnethingAuthTokenStore<TToken extends OnethingOAuthToken = OnethingOAuthToken> =
  OnethingSpaceAuthTokenStore<TToken>

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
  /** 令牌存放面(空间凭证池)。`createOnethingAuthServiceOptions` 缺省装上真的那一台。 */
  tokenStore: OnethingAuthTokenStore<TToken>
  fetch?: typeof fetch
  getDefinition?: (providerId: string) => OnethingAuthProviderDefinition | undefined
  callbackServer?: OnethingAuthCallbackServerAdapter
  createId?: () => string
  now?: () => number
  logger?: Pick<Console, 'warn'>
}

/** 事件载荷。`target` 缺席 = 默认空间,与调用侧缺省一致。 */
export interface OnethingAuthTokenEvent {
  providerId: string
  target?: OnethingCredentialTarget
  error?: string
}

/**
 * 一条登录流的两只计时器:设备码的下一次轮询、整条流的到点超时。
 * 流在表里就有它们,流一出表(完成 / 失败 / 超时 / 取消 / dispose)它们就一起收掉。
 */
interface FlowTimers {
  poll?: ReturnType<typeof setTimeout>
  expire?: ReturnType<typeof setTimeout>
}

/**
 * 订阅登录的服务。
 *
 * **登录流的生命周期在这里**(批 1,`docs/design/provider-settings-rework-2026-09.md` §3.1):
 * `start` 之后由它自己起设备码轮询、等回调、到 `expiresAt` 判超时,`cancel(flowId)`
 * 收尾。每一次相位变化发一条 `'flow'` 事件(`OnethingAuthFlowEvent`)——
 * `pending` 只在 `start` 时发一次,其余四档是终局。装配层把它接成全局事件
 * `oauth:flow`,于是壳只订阅、不轮询;CLI / 网页壳要登录也不必各写一遍轮询。
 *
 * 计时器都是这台服务自己的:`dispose()` 把它们连同在飞的流一起收掉,装配层在
 * `backend.own()` 上登记这一口(不 `unref` —— 漏收一只就该让进程退不干净,而不是被藏起来)。
 */
export class OnethingAuthService<TToken extends OnethingOAuthToken = OnethingOAuthToken> extends EventEmitter {
  private readonly tokenStore: OnethingAuthTokenStore<TToken>
  private readonly fetchImpl: typeof fetch
  private readonly getDefinitionImpl: (providerId: string) => OnethingAuthProviderDefinition | undefined
  private readonly callbackServer?: OnethingAuthCallbackServerAdapter
  private readonly createId: () => string
  private readonly now: () => number
  private readonly logger: Pick<Console, 'warn'>
  private flows = new Map<string, OnethingAuthFlowState>()
  /** flowId → 这条流的计时器。与 `flows` 同进同出(`clearFlow` 一处收)。 */
  private flowTimers = new Map<string, FlowTimers>()
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

  /** 目标归一:缺席 / 非法 spaceId = 默认空间那一池(批 8)。 */
  private resolveTarget(target?: OnethingCredentialTarget | null): OnethingSpaceCredentialTarget {
    return normalizeCredentialTarget(target)
  }

  /**
   * 读 / 刷新 / 退出之前把「不指名哪一条」落成**具体的一条**(兼容口,见
   * `OnethingSpaceAuthTokenStore.resolveEntryId`)。落不成(池里一条 oauth 都没有)就原样返回,
   * 读侧答 `null`。**刷新之前必须落** —— 不落的话锁名是 `*`、写回又是「追加」,
   * 一次刷新会凭空多出一个账号。
   */
  private async concreteTarget(
    providerId: string,
    target?: OnethingCredentialTarget | null,
  ): Promise<OnethingSpaceCredentialTarget> {
    const resolved = this.resolveTarget(target)
    if (resolved.entryId) return resolved
    const entryId = await this.tokenStore.resolveEntryId(providerId, resolved)
    return entryId ? { ...resolved, entryId } : resolved
  }

  private async readToken(
    providerId: string,
    target: OnethingSpaceCredentialTarget,
  ): Promise<TToken | null> {
    if (!target.entryId) return null
    return this.tokenStore.getToken(providerId, target)
  }

  /** 写回。回报真正落地的 entryId(新登录时才知道)。 */
  private async writeToken(
    providerId: string,
    token: TToken,
    target: OnethingSpaceCredentialTarget,
  ): Promise<OnethingSpaceCredentialTarget> {
    const { entryId } = await this.tokenStore.saveToken(providerId, token, target)
    return { ...target, entryId }
  }

  private async removeToken(
    providerId: string,
    target: OnethingSpaceCredentialTarget,
  ): Promise<void> {
    await this.tokenStore.deleteToken(providerId, target)
  }

  private tokenExpired(token: TToken): boolean {
    return this.now() >= token.expiresAt
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
    // 同一个 (provider, 目标) 上重开一次登录 = 上一条作废。它的订阅者会收到 `cancelled`。
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
            // 回调流只有这一次回调:失败就是终局。从前这里发的是 `token-expired`
            // (壳上读作「登录已过期」)—— 那是一句错话,登录失败不是令牌过期。
            const message = this.toPublicError(error, 'OAuth callback failed')
            this.providerErrors.set(this.flowKey(providerId, resolvedTarget), message)
            this.finishFlow(flowId, 'failed', message)
          }
        },
      })
      redirectUri = registration.redirectUri
      flow.redirectUri = redirectUri
    }

    this.flows.set(flowId, flow)
    this.providerFlowIds.set(this.flowKey(providerId, resolvedTarget), flowId)
    this.providerErrors.delete(this.flowKey(providerId, resolvedTarget))

    let authUrl: string
    try {
      authUrl = this.buildAuthorizationUrl(definition, {
        providerId,
        flowId,
        codeVerifier,
        codeChallenge,
        state,
        redirectUri,
      })
    } catch (error) {
      // 起不来的流不该留在表里(也不该留一只回调端口开着)。
      this.clearFlow(flowId)
      throw error
    }
    this.armFlow(flow)

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
    return this.pollDeviceOnce(definition, flow)
  }

  /**
   * 问一次 token 端点。公开的 `pollDeviceFlow`(RPC `devicePoll`,别的宿主还在用)与
   * 服务自己的轮询计时器走的是这同一口,于是谁先问到都走同一条收尾、发同一条事件。
   */
  private async pollDeviceOnce(
    definition: OnethingAuthProviderDefinition,
    flow: OnethingAuthFlowState,
  ): Promise<OnethingOAuthDevicePollResponse> {
    const providerId = flow.providerId
    if (!flow.deviceCode) return { success: false, completed: false, error: 'expired_token' }
    if (this.now() > flow.expiresAt) {
      this.finishFlow(flow.flowId, 'expired', 'expired_token')
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
    // 问的路上流没了(取消 / 超时 / 另一路先问到了):这一份答案不再算数,更不落盘。
    if (!this.flows.has(flow.flowId)) {
      return { success: false, completed: false, error: 'expired_token' }
    }
    if (data.error) {
      if (data.error === 'authorization_pending') {
        return { success: true, completed: false, pollStatus: 'authorization_pending' }
      }
      if (data.error === 'slow_down') {
        flow.intervalMs = (flow.intervalMs || 5000) + 5000
        return { success: true, completed: false, pollStatus: 'slow_down' }
      }
      const error = String(data.error)
      this.finishFlow(flow.flowId, error === 'expired_token' ? 'expired' : 'failed', error)
      return { success: false, completed: false, error, pollStatus: error }
    }

    const token = this.normalizeToken(definition, data)
    const flowTarget = this.resolveTarget(flow.target as OnethingCredentialTarget | undefined)
    const savedTarget = await this.writeToken(providerId, token, flowTarget)
    this.providerErrors.delete(this.flowKey(providerId, flowTarget))
    this.emit('token-refreshed', { providerId, target: savedTarget })
    this.finishFlow(flow.flowId, 'completed')
    return { success: true, completed: true }
  }

  /**
   * 取消一条登录流。流还在 → 收掉计时器与回调注册、发 `cancelled`,答 `true`;
   * 流已经不在(早就完成 / 超时 / 取消过)→ 答 `false`,什么都不发。
   */
  cancel(flowId: string): boolean {
    return this.finishFlow(flowId, 'cancelled')
  }

  /**
   * 刷新。**单飞**(盲点 5):同一个 (provider, 目标) 上并发调用只会真的发一次
   * 请求,其余人等同一个 promise。粒度见 `credentialRefreshKey` 的注释。
   */
  async refreshToken(
    providerId: string,
    target?: OnethingCredentialTarget,
  ): Promise<TToken> {
    const resolvedTarget = await this.concreteTarget(providerId, target)
    if (!resolvedTarget.entryId) throw new Error('No refresh token available')
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
    target: OnethingSpaceCredentialTarget,
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
    const resolvedTarget = await this.concreteTarget(providerId, target)
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
    return this.readToken(providerId, await this.concreteTarget(providerId, target))
  }

  async saveToken(
    providerId: string,
    token: TToken,
    target?: OnethingCredentialTarget,
  ): Promise<void> {
    await this.writeToken(providerId, token, this.resolveTarget(target))
  }

  /**
   * 退出**那一条**(批 8:空间里「退出」= 删本空间那一条 oauth entry,令牌随之删;
   * 不向服务商吊销)。不指名时落到 `resolveEntryId` 那一条 —— 与不指名的 `status`
   * 答的是同一个账号;池里一条都没有就什么都不删。
   */
  async deleteToken(providerId: string, target?: OnethingCredentialTarget): Promise<void> {
    const requested = this.resolveTarget(target)
    const resolvedTarget = await this.concreteTarget(providerId, requested)
    // 登录流按「不指名」那一格记(新登录没有 entryId):退出时一并收掉那一坑的流与错误。
    this.clearProviderFlow(providerId, requested)
    await this.removeToken(providerId, resolvedTarget)
    this.providerErrors.delete(this.flowKey(providerId, requested))
    this.providerErrors.delete(this.flowKey(providerId, resolvedTarget))
  }

  isTokenExpired(token: TToken): boolean {
    return this.tokenExpired(token)
  }

  async isLoggedIn(providerId: string, target?: OnethingCredentialTarget): Promise<boolean> {
    const token = await this.readToken(providerId, await this.concreteTarget(providerId, target))
    return !!token && !this.tokenExpired(token)
  }

  /**
   * 登录态(批 8 §8.3):带 `entryId` 答那一条;不带答 `resolveEntryId` 那一条(兼容),
   * 并附这一池的全部账号 `accounts[]` —— 壳的已登录屏每账号一行,读的就是它。
   * `lastError` 是登录流的错(按「不指名」那一格记),与账号行无关。
   */
  async getStatus(
    providerId: string,
    target?: OnethingCredentialTarget,
  ): Promise<OnethingOAuthStatusResponse> {
    const requested = this.resolveTarget(target)
    const resolvedTarget = await this.concreteTarget(providerId, requested)
    const token = await this.readToken(providerId, resolvedTarget)
    const isExpired = token ? this.tokenExpired(token) : false
    const entries = await this.tokenStore.listEntries(providerId, requested.spaceId)
    const accounts: OnethingOAuthAccountStatus[] = entries.map(entry => ({
      entryId: entry.entryId,
      label: entry.label,
      ...(entry.token?.email ? { email: entry.token.email } : {}),
      ...(entry.token?.accountId ? { accountId: entry.token.accountId } : {}),
      ...(entry.token?.planType ? { planType: entry.token.planType } : {}),
      // 令牌读不出来(坏条目)与过期同一种处置:重新授权。
      isExpired: entry.token ? this.tokenExpired(entry.token) : true,
      ...(entry.token ? { expiresAt: entry.token.expiresAt } : {}),
      canRefresh: Boolean(entry.token?.refreshToken),
    }))
    return {
      success: true,
      providerId,
      ...(resolvedTarget.entryId && token ? { entryId: resolvedTarget.entryId } : {}),
      isLoggedIn: !!token && !isExpired,
      isExpired,
      canRefresh: !!token?.refreshToken,
      expiresAt: token?.expiresAt,
      account: toAccount(token),
      accounts,
      lastError: this.providerErrors.get(this.flowKey(providerId, requested)),
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
    for (const flowId of [...this.flowTimers.keys()]) this.clearFlowTimers(flowId)
    this.callbackServer?.cleanup()
    this.flows.clear()
    this.providerFlowIds.clear()
    this.refreshInFlight.clear()
  }

  /**
   * 收掉这台服务起的一切:在飞的登录流、它们的计时器、回调端口。**不发事件** ——
   * dispose 发生在关机链上,那时事件总线可能已经不在,而进程马上就没了。
   * 收完服务仍可再用(装配层那台是进程单例,下一次 assemble 还是它)。
   * 返回收掉了几条流(装配层记一行日志用)。
   */
  dispose(): number {
    const flows = this.flows.size
    this.cleanup()
    return flows
  }

  /** 此刻还挂着的计时器数。测试与门用:dispose 之后它必须是 0。 */
  pendingTimerCount(): number {
    let count = 0
    for (const timers of this.flowTimers.values()) {
      if (timers.poll) count += 1
      if (timers.expire) count += 1
    }
    return count
  }

  private async startDeviceFlow(
    definition: OnethingAuthProviderDefinition,
    target: OnethingSpaceCredentialTarget,
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
    this.armFlow(flow)

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
    // 换 token 的路上流被取消 / 超时了:不落盘。
    if (!this.flows.has(flow.flowId)) {
      throw new Error('OAuth flow has expired. Please try logging in again.')
    }
    const token = this.normalizeToken(definition, data)
    const flowTarget = this.resolveTarget(flow.target as OnethingCredentialTarget | undefined)
    const savedTarget = await this.writeToken(providerId, token, flowTarget)
    this.providerErrors.delete(this.flowKey(providerId, flowTarget))
    this.emit('token-refreshed', { providerId, target: savedTarget })
    this.finishFlow(flow.flowId, 'completed')
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

  /** 被新一次登录顶掉 / 被登出收掉的那条流 —— 对它的订阅者而言就是取消。 */
  private clearProviderFlow(providerId: string, target?: OnethingCredentialTarget): void {
    const flowId = this.providerFlowIds.get(this.flowKey(providerId, this.resolveTarget(target)))
    if (flowId) this.finishFlow(flowId, 'cancelled')
  }

  /**
   * 起流之后挂上它的计时器:到点超时(三种流都有),设备码流再挂第一次轮询。
   * 然后发唯一的一条 `pending`。
   */
  private armFlow(flow: OnethingAuthFlowState): void {
    const timers = this.timersOf(flow.flowId)
    timers.expire = setTimeout(() => {
      timers.expire = undefined
      this.finishFlow(flow.flowId, 'expired', 'expired_token')
    }, Math.max(0, flow.expiresAt - this.now()))
    if (flow.kind === 'device-code') this.scheduleDevicePoll(flow)
    this.emitFlow({ providerId: flow.providerId, flowId: flow.flowId, phase: 'pending', target: flow.target })
  }

  private timersOf(flowId: string): FlowTimers {
    let timers = this.flowTimers.get(flowId)
    if (!timers) {
      timers = {}
      this.flowTimers.set(flowId, timers)
    }
    return timers
  }

  private scheduleDevicePoll(flow: OnethingAuthFlowState): void {
    if (!this.flows.has(flow.flowId)) return
    const timers = this.timersOf(flow.flowId)
    timers.poll = setTimeout(() => {
      timers.poll = undefined
      void this.devicePollTick(flow.flowId)
    }, flow.intervalMs ?? 5000)
  }

  /**
   * 计时器上的一次轮询。**问不到不判死**:网络抖一下、token 端点 5xx 一次,下一拍
   * 再问 —— 终局由 token 端点自己说(`access_denied` / `expired_token`)或到点超时说。
   */
  private async devicePollTick(flowId: string): Promise<void> {
    const flow = this.flows.get(flowId)
    if (!flow) return
    const definition = this.getDefinition(flow.providerId)
    if (!definition) {
      this.finishFlow(flowId, 'failed', `Unknown OAuth provider: ${flow.providerId}`)
      return
    }
    try {
      const result = await this.pollDeviceOnce(definition, flow)
      if (result.completed || !result.success) return
    } catch (error) {
      if (!this.flows.has(flowId)) return
      this.logger.warn('[Auth] device-code poll failed; retrying', error)
    }
    this.scheduleDevicePoll(flow)
  }

  /**
   * 一条流的终局:出表、收计时器与回调注册、发事件。流已经不在就什么都不做 ——
   * 一条流只有一个终局,先到的那一路说了算。
   */
  private finishFlow(flowId: string, phase: Exclude<OnethingAuthFlowPhase, 'pending'>, error?: string): boolean {
    const flow = this.flows.get(flowId)
    if (!flow) return false
    this.clearFlow(flowId)
    if (phase === 'failed' && error) {
      this.providerErrors.set(this.flowKey(flow.providerId, flow.target as OnethingCredentialTarget | undefined), error)
    }
    this.emitFlow({
      providerId: flow.providerId,
      flowId,
      phase,
      ...(error ? { error } : {}),
      target: flow.target,
    })
    return true
  }

  private emitFlow(event: OnethingAuthFlowEvent): void {
    try {
      this.emit('flow', event)
    } catch (error) {
      // 一只订阅者抛错不该把登录流的收尾打断。
      this.logger.warn('[Auth] flow listener failed', error)
    }
  }

  private clearFlowTimers(flowId: string): void {
    const timers = this.flowTimers.get(flowId)
    if (!timers) return
    if (timers.poll) clearTimeout(timers.poll)
    if (timers.expire) clearTimeout(timers.expire)
    this.flowTimers.delete(flowId)
  }

  private clearFlow(flowId: string): void {
    this.clearFlowTimers(flowId)
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
