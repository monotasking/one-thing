/**
 * `QuotaService` —— 配额与余额的**唯一持有者**(批 5,`docs/design/provider-settings-rework-2026-09.md` §8.3)。
 *
 * 这一只是纯逻辑:取凭证、取数、推送、写冷却全部经 `QuotaServiceDeps` 注入(真接线在
 * `index.ts`),所以单测不碰网络也不碰磁盘。计时器全归它,`dispose()` 一并收掉。
 *
 * ── 缓存键 ──────────────────────────────────────────────────────────────
 * `(providerId, credentialId)`。池里每条凭证各一格 —— 同一家的两个订阅账号各有各的窗口,
 * 两把 DeepSeek 密钥各有各的余额。env 兜底(机器环境变量里的钥匙)没有 id,落在
 * `(providerId, '')` 那一格。
 *
 * ── 取数时机(§8.3 逐字) ─────────────────────────────────────────────────
 *  - composer 卡片打开:缓存超 60 秒才真去问(`get`,不带 force);
 *  - 每次 `run/end`:针对本轮用的 provider 与凭证,**30 秒去抖**(`noteRunEnd`,每来一次
 *    重置那一格的计时器;窗口内来几次都只问一次);近 60 秒内被动源刚刷过就不问;
 *  - 设置页刷新钮:force,绕过 60 秒;
 *  - **空闲不轮询**:没人问、没有 run 结束,就一发请求都没有;
 *  - `rate-limited`(429)之后 10 分钟**任何理由都不问**(包括 force)—— Claude 那条非公开
 *    接口动不动 429,越问越限;这期间照旧答上一份好的数(没有就答那条 rate-limited 错);
 *  - 被动源(响应头)来一条就直接进缓存(`observe`),零额外请求。
 *
 * ── 为批 6 留的那一格 ────────────────────────────────────────────────────
 * 每拿到一份好数就看一眼:任一窗口 `usedPercent >= 100` 或余额 `<= 0`,给那条凭证写一格
 * **配额冷却**(`cooldownUntil = resetsAt ?? now + 10min`,只延长不缩短,`cooldownReason:
 * 'quota'`)。批 6 的 `pickRoute` 读的就是这一格。
 */
import type { ProviderQuota, ProviderQuotaPushPayload } from '@shared/contracts/quota.js'
import type { QuotaFetchContext } from '@onething/runtime/providers/quota'
import type { Logger } from '@onething/core/logging'

export const QUOTA_CARD_TTL_MS = 60_000
export const QUOTA_RUN_END_DEBOUNCE_MS = 30_000
export const QUOTA_RATE_LIMIT_HOLD_MS = 10 * 60_000
export const QUOTA_COOLDOWN_FALLBACK_MS = 10 * 60_000

/** 取数前的那一步的答案:要么是一份可以拿去问的上下文,要么是一句「问不了」。 */
export type QuotaCredentialResolution =
  | { kind: 'ready'; credentialId?: string; context: Omit<QuotaFetchContext, 'fetchImpl'> }
  | { kind: 'unavailable'; credentialId?: string; message: string }

export interface QuotaServiceDeps {
  /** 这家有没有配额源。没有 = `unsupported`,一发请求都不起。 */
  hasSource(providerId: string): boolean
  /** 「下一发会用哪条」(密钥策略的只读 `decide`)。 */
  decide(providerId: string, spaceId: string): string | undefined
  /** 把 (provider, 空间, 凭证) 解成取数上下文(OAuth 在这里刷新)。 */
  resolve(providerId: string, spaceId: string, credentialId: string | undefined): Promise<QuotaCredentialResolution>
  fetch(providerId: string, context: QuotaFetchContext): Promise<ProviderQuota>
  fetchImpl(): QuotaFetchContext['fetchImpl']
  /** 出网全局事件 `provider:quota`。 */
  emit(payload: ProviderQuotaPushPayload): void
  /** 配额冷却(只延长不缩短)。 */
  markCooldown(spaceId: string, providerId: string, credentialId: string, until: number): void
  now(): number
  setTimer(run: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  logger: Pick<Logger, 'debug' | 'info' | 'warn'>
}

export interface QuotaRequest {
  providerId: string
  spaceId: string
  /** 缺席 = `decide`(composer 读数卡:这一发会用哪条)。 */
  credentialId?: string
  force?: boolean
}

export interface QuotaAnswer {
  quota: ProviderQuota
  credentialId?: string
}

export interface QuotaRunEnd {
  providerId: string
  spaceId: string
  credentialId?: string
}

interface CacheCell {
  /** 最近一份答案(可能是错误)。 */
  quota?: ProviderQuota
  /** 最近一份**好的**答案(windows / balance)。rate-limited 期间答它。 */
  good?: ProviderQuota
  /** 最近一次真去问(或被动源刷新)的时刻。 */
  refreshedAt?: number
  /** 被动源最近一次刷新的时刻。 */
  passiveAt?: number
  /** 429 静默期到期时刻。 */
  holdUntil?: number
  inflight?: Promise<ProviderQuota>
  runEndTimer?: unknown
  /** 去抖计时器到点时要用的空间(最后一次 run/end 说的那个)。 */
  runEndSpaceId?: string
}

function isGood(quota: ProviderQuota | undefined): quota is Extract<ProviderQuota, { kind: 'windows' | 'balance' }> {
  return quota?.kind === 'windows' || quota?.kind === 'balance'
}

/**
 * 这份配额说「这条凭证眼下用不了」吗?说了就答冷却到哪一刻,没说答 `undefined`。
 * 窗口满:冷却到**最晚**重置的那一窗(两窗都满时,早的那窗重置了也还是用不了);
 * 满窗没给重置时刻就 +10 分钟,到时候再看。余额见底:+10 分钟(= 下次配额刷新)。
 */
export function quotaCooldownUntil(quota: ProviderQuota, now: number): number | undefined {
  if (quota.kind === 'windows') {
    const full = quota.windows.filter(window => window.usedPercent >= 100)
    if (full.length === 0) return undefined
    return Math.max(...full.map(window => window.resetsAt ?? now + QUOTA_COOLDOWN_FALLBACK_MS))
  }
  if (quota.kind === 'balance') {
    return quota.available <= 0 ? now + QUOTA_COOLDOWN_FALLBACK_MS : undefined
  }
  return undefined
}

export class QuotaService {
  private readonly cells = new Map<string, CacheCell>()
  private disposed = false

  constructor(private readonly deps: QuotaServiceDeps) {}

  private keyOf(providerId: string, credentialId: string | undefined): string {
    return `${providerId}\u0000${credentialId ?? ''}`
  }

  private cellOf(providerId: string, credentialId: string | undefined): CacheCell {
    const key = this.keyOf(providerId, credentialId)
    let cell = this.cells.get(key)
    if (!cell) {
      cell = {}
      this.cells.set(key, cell)
    }
    return cell
  }

  /** 静默期内答什么:上一份好的,没有就答那条 rate-limited 错。 */
  private heldAnswer(cell: CacheCell): ProviderQuota {
    return cell.good ?? cell.quota ?? {
      kind: 'error',
      reason: 'rate-limited',
      message: 'rate limited',
      fetchedAt: this.deps.now(),
    }
  }

  /**
   * 卡片 / 设置页 / RPC 的那一问。
   *
   * 不支持的家不起请求;凭证解不出来(没配 / 没登录)答一条 `auth` 错,不进缓存(那不是
   * 服务商说的,是本地事实,下次问照样现算)。
   */
  async get(request: QuotaRequest): Promise<QuotaAnswer> {
    const { providerId, spaceId } = request
    if (!this.deps.hasSource(providerId)) return { quota: { kind: 'unsupported' } }
    const credentialId = request.credentialId ?? this.deps.decide(providerId, spaceId)
    const cell = this.cellOf(providerId, credentialId)
    const now = this.deps.now()
    const answer = (quota: ProviderQuota): QuotaAnswer => ({ quota, ...(credentialId ? { credentialId } : {}) })

    if (cell.holdUntil !== undefined && cell.holdUntil > now) return answer(this.heldAnswer(cell))
    if (!request.force && cell.quota && cell.refreshedAt !== undefined && now - cell.refreshedAt < QUOTA_CARD_TTL_MS) {
      return answer(cell.quota)
    }
    return answer(await this.refresh(providerId, spaceId, credentialId, cell))
  }

  /** 真去问一次(单飞:同一格同时只有一发在路上)。 */
  private refresh(providerId: string, spaceId: string, credentialId: string | undefined, cell: CacheCell): Promise<ProviderQuota> {
    if (cell.inflight) return cell.inflight
    const run = (async (): Promise<ProviderQuota> => {
      let resolution: QuotaCredentialResolution
      try {
        resolution = await this.deps.resolve(providerId, spaceId, credentialId)
      } catch (error) {
        // 令牌刷新被拒 / 读不出来:这是「这条凭证眼下用不了」,不是服务商说的配额。
        resolution = {
          kind: 'unavailable',
          message: error instanceof Error && error.message ? error.message : String(error),
        }
      }
      if (resolution.kind === 'unavailable') {
        return { kind: 'error', reason: 'auth', message: resolution.message, fetchedAt: this.deps.now() }
      }
      this.deps.logger.debug('quota fetch', { providerId, credentialId })
      const quota = await this.deps.fetch(providerId, { ...resolution.context, fetchImpl: this.deps.fetchImpl() })
      if (this.disposed) return quota
      this.accept(providerId, spaceId, credentialId, cell, quota, 'fetch')
      return quota.kind === 'error' && quota.reason === 'rate-limited' ? this.heldAnswer(cell) : quota
    })()
    cell.inflight = run
    void run.finally(() => { if (cell.inflight === run) cell.inflight = undefined }).catch(() => undefined)
    return run
  }

  /** 一份新答案进缓存:推送、写冷却、429 进静默期。 */
  private accept(
    providerId: string,
    spaceId: string | undefined,
    credentialId: string | undefined,
    cell: CacheCell,
    quota: ProviderQuota,
    via: 'fetch' | 'passive',
  ): void {
    const now = this.deps.now()
    if (quota.kind === 'error' && quota.reason === 'rate-limited') {
      // 静默:不改屏上的数、不推送,10 分钟内不再问。
      cell.holdUntil = now + QUOTA_RATE_LIMIT_HOLD_MS
      cell.refreshedAt = now
      if (!cell.good) cell.quota = quota
      this.deps.logger.info('quota rate-limited; holding', { providerId, credentialId, holdMs: QUOTA_RATE_LIMIT_HOLD_MS })
      return
    }
    cell.quota = quota
    cell.refreshedAt = now
    if (via === 'passive') cell.passiveAt = now
    if (isGood(quota)) {
      cell.good = quota
      cell.holdUntil = undefined
    }
    this.deps.emit({ providerId, ...(credentialId ? { credentialId } : {}), quota })
    if (!credentialId || !spaceId) return
    const until = quotaCooldownUntil(quota, now)
    if (until !== undefined && until > now) {
      this.deps.markCooldown(spaceId, providerId, credentialId, until)
      this.deps.logger.info('quota exhausted; credential cooling', { providerId, credentialId, until })
    }
  }

  /**
   * 被动源:一条响应头带回来的配额(`provider-data { type: 'quota' }`)。直接进缓存,
   * 零请求。**只收好数** —— 头上读不出错误这回事。
   */
  observe(input: { providerId: string; spaceId?: string; credentialId?: string; quota: ProviderQuota }): void {
    if (this.disposed || !isGood(input.quota)) return
    const cell = this.cellOf(input.providerId, input.credentialId)
    this.accept(input.providerId, input.spaceId, input.credentialId, cell, input.quota, 'passive')
  }

  /** 一轮跑完:那一格 30 秒去抖,到点真去问一次(近 60 秒被动源刷过则免)。 */
  noteRunEnd(input: QuotaRunEnd): void {
    if (this.disposed || !this.deps.hasSource(input.providerId)) return
    const cell = this.cellOf(input.providerId, input.credentialId)
    if (cell.runEndTimer !== undefined) this.deps.clearTimer(cell.runEndTimer)
    cell.runEndSpaceId = input.spaceId
    cell.runEndTimer = this.deps.setTimer(() => {
      cell.runEndTimer = undefined
      if (this.disposed) return
      const now = this.deps.now()
      if (cell.holdUntil !== undefined && cell.holdUntil > now) return
      if (cell.passiveAt !== undefined && now - cell.passiveAt < QUOTA_CARD_TTL_MS) return
      void this.refresh(input.providerId, cell.runEndSpaceId ?? input.spaceId, input.credentialId, cell).catch(error => {
        this.deps.logger.warn('quota refresh after run failed', {
          providerId: input.providerId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }, QUOTA_RUN_END_DEBOUNCE_MS)
  }

  /** 测试 / 排障:此刻挂着几只计时器。 */
  pendingTimers(): number {
    let count = 0
    for (const cell of this.cells.values()) if (cell.runEndTimer !== undefined) count += 1
    return count
  }

  dispose(): void {
    this.disposed = true
    for (const cell of this.cells.values()) {
      if (cell.runEndTimer !== undefined) this.deps.clearTimer(cell.runEndTimer)
      cell.runEndTimer = undefined
    }
    this.cells.clear()
  }
}
