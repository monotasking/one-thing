/**
 * 凭证轮换的**宿主接线**(批 D)—— 「这次失败要不要换一把 key 再试」。
 *
 * ## 边界:请求/重试边界,流中绝不换
 *
 * 唯一的挂载点是 core agent-loop 的 turn 级重试(`AgentLoopOptions.rotateCredential`,
 * `packages/backend/agent-loop/agent-loop-runner.ts` 的 attempt 循环 catch 块)。那里有三个
 * 现成的保证,一个都不用重造:
 *
 *  - 它在**流已经失败之后**跑 —— 不存在"换到一半"的流。
 *  - 它前面有 `resultsByToolCallId.size > 0` 这道闸 —— 已经执行过工具的一轮
 *    不会重试,换 key 也不例外(换钥匙不会让重复执行副作用变安全)。
 *  - 它是**唯一**的重试边界,没有第二条重试链需要同步。
 *
 * ## 为什么要重建 provider,而不是"改一下 key"
 *
 * 凭证在 `createProvider` 时就被烤进了 provider 闭包(claude 的 `x-api-key`、
 * deepseek 的 `Authorization` 都是构造时拼好的字符串),首次解析之后没有任何
 * 一处会再问一遍。所以"重新走凭证解析"在这里的落地方式就是:重新解析 →
 * 拿到另一条 entry → 用它**重建 provider**(`prepared.reprovision`)。
 * 这就是 B3 留下的接口所说的那个「最窄处」。
 *
 * ## 轮转 v2:沿候选序列走(批 6,`docs/design/provider-settings-rework-2026-09.md` §9.1)
 *
 * 「下一条是谁」不再只在一家的池里找:失败的那条写上冷却之后,重新问一遍
 * `routeSpaceProvider`(= `pickRoute`)要整条候选序列,取当前这条之后的那一条。序列可能
 * 跨到同家的另一半(订阅额度全用完 → 同家 API),那时 `reprovision` 连「造谁」一起换
 * (`providerId` + 那一家的端点一族),core 只把新 provider 接过去 —— 它不知道换了家。
 * 冷却 = 报错冷却 ∪ 配额冷却,同一格;序列头在窗口重置之后自然回到订阅账号。
 *
 * ## 默认空间与别的空间同路
 *
 * 默认空间早已并入同一份密钥池(`space-credentials.ts` 的 C1:default 不再是特例),
 * 所以这里不再按空间分叉。`currentEntryId` 为空 = 这条会话没命中池里的任何一条
 * → 整个钩子**返回 undefined 不挂载**,core 的重试逻辑一行都不会变。
 */

import type { AgentCredentialRotation, AgentProvider } from '@onething/backend/agent-loop'
import {
  classifyProviderError,
  providerErrorCooldownUntil,
} from '@onething/backend/agent-loop'
import {
  getSpaceCredentialEntry,
  getSpaceProviderCredentials,
  isPluginSpaceCredentialPolicy,
  isSpaceCredentialEntryCooling,
  isSpaceCredentialEntryUsable,
  markSpaceCredentialCooldown,
} from './credentials-pool.js'
import {
  buildOnethingRequestProviderOptionsBag,
  getProviderManifest,
  type CoreProviderConfigLike,
  type CoreSpaceCredentialMarker,
} from '@onething/backend/provider'
import { ROUTE_FALLBACK_API_REASON, type RouteCandidate } from './credentials-candidate-route.js'
import { getAuthService } from '@onething/backend/auth'
import { resolveSessionSpaceId, getSpaceSettings } from '@onething/backend/session'
import {
  buildRoutedProviderConfig,
  isSubscriptionFallbackOn,
  markSpaceOAuthRefreshFailure,
  noteRouteCandidateUsed,
  routeSpaceProvider,
} from './credentials-resolution.js'
import {
  notePluginCredentialFailure,
  refreshCredentialStrategyDecision,
} from './credentials-strategy.js'

export interface SessionCredentialRotatorInput {
  sessionId: string
  /** 用户选的那一家(会话的 provider)。 */
  providerId: string
  /** 本次流首次解析命中的 entry id(`providerConfig.spaceCredential?.entryId`)。 */
  currentEntryId?: string
  /**
   * 本次流首次解析**真正在用**的那一家(`providerConfig.spaceCredential?.route?.providerId`):
   * 发送前就被接力给同家另一半时是那一家。缺席 = `providerId`。
   */
  currentProviderId?: string
  /** 首次解析那份 config。换家时从它取模型一族(型号、各型覆盖表、目录)。 */
  providerConfig?: CoreProviderConfigLike
  /** 用另一份凭证(必要时另一家)重建 provider —— 由 runtime 的 `buildOnething…` 结果提供。 */
  reprovision: (override: {
    apiKey?: string
    baseUrl?: string
    oauthToken?: { accessToken: string }
    spaceCredential?: { spaceId?: string; entryId?: string; authType?: string }
    providerId?: string
    config?: Record<string, unknown>
  }) => AgentProvider | undefined
  /** 换手成功之后报一声新的标记(批 6):账本与配额回调据它记「这一发真用了谁」。 */
  onRotated?: (marker: CoreSpaceCredentialMarker) => void
  logger?: Pick<Console, 'warn'>
}

export type SessionCredentialRotator = (
  error: unknown,
  attempt: number,
) => Promise<AgentCredentialRotation | undefined>

/**
 * 候选序列**可能**走到的全部条目数:目标家的池,加上接力开着时同家另一半的池。不到两条
 * = 换来换去还是它,钩子不挂。
 */
function rotationUniverseSize(spaceId: string, providerId: string): number {
  const sizeOf = (id: string): number => getSpaceProviderCredentials(spaceId, id)?.entries.length ?? 0
  const manifest = getProviderManifest(providerId)
  let size = sizeOf(providerId)
  if (manifest?.billing === 'subscription' && manifest.sibling) {
    const providers = getSpaceSettings(spaceId).ai?.providers as
      | Record<string, { subscriptionFallback?: boolean } | undefined>
      | undefined
    if (isSubscriptionFallbackOn(providers, providerId)) size += sizeOf(manifest.sibling)
  }
  return size
}

/**
 * 造一个轮换钩子。**没有可换的就返回 `undefined`** —— 让 core 那边连这个字段
 * 都不存在,而不是挂一个每次都答"不换"的函数。行为不变要看得见,不是靠推理。
 *
 * 两种「没有可换的」:
 *  1. 本次没有命中任何 entry(未配置 —— 那是起流前置拦截的事);
 *  2. 序列可能走到的条目不到两条 —— 换来换去还是它。
 */
export function createSessionCredentialRotator(
  input: SessionCredentialRotatorInput,
): SessionCredentialRotator | undefined {
  const spaceId = resolveSessionSpaceId(input.sessionId)
  if (!input.currentEntryId) return undefined
  if (rotationUniverseSize(spaceId, input.providerId) < 2) return undefined

  // provider 实例是按「首次解析那一家」造的;换家 = 相对它换。
  const builtFor = input.currentProviderId || input.providerId
  let active: { providerId: string; entryId: string } = { providerId: builtFor, entryId: input.currentEntryId }

  return async (error: unknown, attempt = 1): Promise<AgentCredentialRotation | undefined> => {
    const classification = classifyProviderError(error)
    // `unknown` 与 `transient` 在这里出局。把一个程序性错误当配额,会让同一个
    // bug 沿着池子把每一把 key 依次烧穿 —— 用户看到"所有密钥都失效了",
    // 而真相是一行参数写错了。
    if (!classification.rotates) return undefined

    const cooldownUntil = providerErrorCooldownUntil(classification)
    if (cooldownUntil > 0) {
      // 写盘 —— 重启不忘。配额窗口按小时算,只记在进程内存等于每次重启重烧一遍池。
      markSpaceCredentialCooldown(spaceId, active.providerId, active.entryId, cooldownUntil)
    }

    // 插件策略(批 E):**这条路是 await 的、恒新鲜**。它是「这个用完用另一个」
    // 的主场 —— 冷却刚写进去、失败分类刚算出来,正是策略最该说话的时刻。
    // 算好的裁决落进装配层的裁决槽,紧接着的那次同步解析就会取到它;
    // 策略缺席/超时/返回非法 id 一律什么都不做,解析照常回落内置 failover。
    notePluginCredentialFailure(active.entryId, classification.kind)
    const livePool = getSpaceProviderCredentials(spaceId, active.providerId)
    if (livePool && isPluginSpaceCredentialPolicy(livePool.policy)) {
      const now = Date.now()
      // 候选集与分叉点用的是**同一条规则**:剔掉没有凭证材料的、正在冷却的。
      // 让策略看见一条已经冷却的 entry,等于开了一个绕过冷却的口子。
      const candidates = livePool.entries
        .filter(entry => isSpaceCredentialEntryUsable(entry))
        .filter(entry => !isSpaceCredentialEntryCooling(entry, now))
      if (candidates.length > 0) {
        await refreshCredentialStrategyDecision({
          policy: livePool.policy,
          spaceId,
          providerId: active.providerId,
          candidates,
          attempt: attempt + 1,
          lastFailure: {
            entryId: active.entryId,
            kind: classification.kind,
            ...(classification.status !== undefined ? { status: classification.status } : {}),
          },
          now,
        })
      }
    }

    // 重新要一遍整条序列:冷却刚写进去,失败的那条已经不在里面了。取当前这条之后的那一条
    // (它若还在序列里 —— 冷却没写成的边角 —— 就越过它)。序列空 / 走到头:轮换无能为力,
    // 把原错误交回去,下一次起流会撞上 `exhausted` 那个一等状态。
    const route = routeSpaceProvider(spaceId, input.providerId)
    const at = route.findIndex(c => c.providerId === active.providerId && c.entryId === active.entryId)
    const next: RouteCandidate | undefined = at >= 0 ? route[at + 1] : route[0]
    if (!next) return undefined
    const entry = getSpaceCredentialEntry(spaceId, next.providerId, next.entryId)
    if (!entry) return undefined

    // 真要发出去的这一发:它那一池是 round-robin 就拨一格。
    noteRouteCandidateUsed(spaceId, route, next)

    const marker: CoreSpaceCredentialMarker = {
      spaceId,
      entryId: entry.id,
      authType: entry.authType === 'oauth' ? 'oauth' : 'apiKey',
      ...(next.providerId !== input.providerId
        ? { route: { providerId: next.providerId, reason: next.reason } }
        : {}),
    }

    // OAuth 型:换手前先把那条 entry 的 token 刷到可用(过期就刷新,单飞锁在
    // authService 里)。刷不出来就当这条也不能用 —— 顺手记上 auth-invalid 冷却,
    // 下一轮解析会继续往后找。
    let oauthToken: { accessToken: string } | undefined
    if (entry.authType === 'oauth') {
      try {
        oauthToken = await getAuthService().refreshTokenIfNeeded(next.providerId, {
          kind: 'space',
          spaceId,
          entryId: entry.id,
        })
      } catch (refreshError) {
        markSpaceOAuthRefreshFailure(next.providerId, spaceId, entry.id, refreshError)
        return undefined
      }
    }

    // 换家(相对 provider 实例造时的那一家):连端点一族一起换 —— 那一家在这个空间的设置
    // + 池里这一条,模型一族留用户选的那一家的。
    const crossing = next.providerId !== builtFor
    const routedConfig = crossing
      ? buildRoutedProviderConfig(spaceId, input.providerId, next, input.providerConfig)
      : undefined
    if (crossing && !routedConfig) return undefined

    const provider = input.reprovision({
      ...(entry.authType === 'oauth' ? { oauthToken } : { apiKey: entry.apiKey }),
      baseUrl: entry.baseUrl,
      spaceCredential: marker,
      ...(crossing ? { providerId: next.providerId, config: routedConfig as Record<string, unknown> } : {}),
    })
    if (!provider) {
      input.logger?.warn?.(
        `[spaces] credential rotation could not rebuild provider ${next.providerId}`,
      )
      return undefined
    }

    const from = active
    active = { providerId: next.providerId, entryId: entry.id }
    input.onRotated?.(marker)
    // 请求旋钮跟家走:新 provider 只读它自己那一格,所以袋子按**接下来真收请求的那一家**
    // 重挂 —— 换家就是那一家设置里的旋钮(`routedConfig`),回到实例造时那一家就是首次解析那份。
    // 型号级的旋钮不在这只袋里(按模型键,两半卖同一批模型),这里只管 provider 级那一半。
    const requestOptionsSource = (crossing ? routedConfig : input.providerConfig) as
      | { providerOptions?: Record<string, unknown> }
      | undefined
    return {
      provider,
      providerOptions: buildOnethingRequestProviderOptionsBag(next.providerId, requestOptionsSource?.providerOptions),
      // 换的是**另一把** key,没有理由退避 —— 退避是给"同一把钥匙等它凉下来"的。
      delayMs: 0,
      // 从订阅接力到同家 API 的那一轮说「按 API 计费」(拍点 7);其余沿用今天的话。
      reason: next.reason === 'sibling-api' && from.providerId !== next.providerId
        ? ROUTE_FALLBACK_API_REASON
        : `凭证 ${from.entryId} ${describeRotationCause(classification.kind)},换用「${entry.label}」重试`,
    }
  }
}

function describeRotationCause(kind: string): string {
  switch (kind) {
    case 'quota-exhausted':
      return '配额耗尽'
    case 'rate-limited':
      return '被限流'
    case 'auth-invalid':
      return '被拒绝(密钥无效)'
    default:
      return '不可用'
  }
}
