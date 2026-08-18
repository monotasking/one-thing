/**
 * 凭证轮换的**宿主接线**(批 D)—— 「这次失败要不要换一把 key 再试」。
 *
 * ## 边界:请求/重试边界,流中绝不换
 *
 * 唯一的挂载点是 core agent-loop 的 turn 级重试(`AgentLoopOptions.rotateCredential`,
 * `packages/core/agent-loop/runner.ts` 的 attempt 循环 catch 块)。那里有三个
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
 * ## 默认空间不参与
 *
 * default space 的凭证源是 `settings.ai`,没有池、没有 entry id。
 * `currentEntryId` 为空 = 这条会话没有池 → 整个钩子**返回 undefined 不挂载**,
 * core 的重试逻辑一行都不会变。
 */

import type { AgentCredentialRotation, AgentProvider } from '@onething/core/agent-loop'
import {
  classifyProviderError,
  providerErrorCooldownUntil,
} from '@onething/runtime/agent-loop/provider-error-classification'
import {
  markSpaceCredentialCooldown,
  getSpaceProviderCredentials,
  isPluginSpaceCredentialPolicy,
  isSpaceCredentialEntryCooling,
  isSpaceCredentialEntryUsable,
} from '@onething/runtime/spaces/credentials'
import { DEFAULT_SPACE_ID } from '@onething/runtime/spaces/types'
import { authService } from '../auth/auth-service.js'
import { resolveSessionSpaceId } from '../stores/sessions.js'
import {
  markSpaceOAuthRefreshFailure,
  resolveSessionProviderCredential,
} from './space-credentials.js'
import {
  notePluginCredentialFailure,
  refreshCredentialStrategyDecision,
} from './credential-strategy.js'

export interface SessionCredentialRotatorInput {
  sessionId: string
  providerId: string
  /** 本次流首次解析命中的 entry id(`providerConfig.spaceCredential?.entryId`)。 */
  currentEntryId?: string
  /** 用另一份凭证重建 provider —— 由 runtime 的 `buildOnething…` 结果提供。 */
  reprovision: (override: {
    apiKey?: string
    baseUrl?: string
    oauthToken?: { accessToken: string }
    spaceCredential?: { spaceId?: string; entryId?: string; authType?: string }
  }) => AgentProvider | undefined
  logger?: Pick<Console, 'warn'>
}

export type SessionCredentialRotator = (
  error: unknown,
  attempt: number,
) => Promise<AgentCredentialRotation | undefined>

/**
 * 造一个轮换钩子。**没有可换的就返回 `undefined`** —— 让 core 那边连这个字段
 * 都不存在,而不是挂一个每次都答"不换"的函数。行为不变要看得见,不是靠推理。
 *
 * 三种「没有可换的」:
 *  1. 默认空间(凭证源是 settings.ai,无池);
 *  2. 本次没有命中任何 entry(未配置 —— 那是起流前置拦截的事);
 *  3. 池里只有一条 —— 换来换去还是它。
 */
export function createSessionCredentialRotator(
  input: SessionCredentialRotatorInput,
): SessionCredentialRotator | undefined {
  const spaceId = resolveSessionSpaceId(input.sessionId)
  if (spaceId === DEFAULT_SPACE_ID) return undefined
  if (!input.currentEntryId) return undefined
  const pool = getSpaceProviderCredentials(spaceId, input.providerId)
  if (!pool || pool.entries.length < 2) return undefined

  let activeEntryId = input.currentEntryId

  return async (error: unknown, attempt = 1): Promise<AgentCredentialRotation | undefined> => {
    const classification = classifyProviderError(error)
    // `unknown` 与 `transient` 在这里出局。把一个程序性错误当配额,会让同一个
    // bug 沿着池子把每一把 key 依次烧穿 —— 用户看到"所有密钥都失效了",
    // 而真相是一行参数写错了。
    if (!classification.rotates) return undefined

    const cooldownUntil = providerErrorCooldownUntil(classification)
    if (cooldownUntil > 0) {
      // 写盘 —— 重启不忘。配额窗口按小时算,只记在进程内存等于每次重启重烧一遍池。
      markSpaceCredentialCooldown(spaceId, input.providerId, activeEntryId, cooldownUntil)
    }

    // 插件策略(批 E):**这条路是 await 的、恒新鲜**。它是「这个用完用另一个」
    // 的主场 —— 冷却刚写进去、失败分类刚算出来,正是策略最该说话的时刻。
    // 算好的裁决落进装配层的裁决槽,紧接着的那次同步解析就会取到它;
    // 策略缺席/超时/返回非法 id 一律什么都不做,解析照常回落内置 failover。
    notePluginCredentialFailure(activeEntryId, classification.kind)
    const livePool = getSpaceProviderCredentials(spaceId, input.providerId)
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
          providerId: input.providerId,
          candidates,
          attempt: attempt + 1,
          lastFailure: {
            entryId: activeEntryId,
            kind: classification.kind,
            ...(classification.status !== undefined ? { status: classification.status } : {}),
          },
          now,
        })
      }
    }

    // 重新走一遍解析:冷却刚写进去,选择器这次会跳过它。这一句就是"重试路径
    // 重新走凭证解析"的落点。
    const resolution = resolveSessionProviderCredential(input.sessionId, input.providerId)
    // 全池冷却 / 未配置:轮换无能为力,把原错误交回去 —— core 会按它自己的
    // 规则决定要不要原地重试,下一次起流则会撞上 `exhausted` 那个一等状态。
    if (resolution.kind !== 'entry' && resolution.kind !== 'oauth-entry') return undefined
    if (resolution.entry.id === activeEntryId) return undefined

    const marker = {
      spaceId,
      entryId: resolution.entry.id,
      authType: resolution.kind === 'oauth-entry' ? 'oauth' : 'apiKey',
    }

    // OAuth 型:换手前先把那条 entry 的 token 刷到可用(过期就刷新,单飞锁在
    // authService 里)。刷不出来就当这条也不能用 —— 顺手记上 auth-invalid 冷却,
    // 下一轮解析会继续往后找。
    let oauthToken: { accessToken: string } | undefined
    if (resolution.kind === 'oauth-entry') {
      try {
        oauthToken = await authService.refreshTokenIfNeeded(input.providerId, {
          kind: 'space',
          spaceId,
          entryId: resolution.entry.id,
        })
      } catch (refreshError) {
        markSpaceOAuthRefreshFailure(
          input.providerId,
          spaceId,
          resolution.entry.id,
          refreshError,
        )
        return undefined
      }
    }

    const provider = input.reprovision({
      ...(resolution.kind === 'oauth-entry'
        ? { oauthToken }
        : { apiKey: resolution.entry.apiKey }),
      baseUrl: resolution.entry.baseUrl,
      spaceCredential: marker,
    })
    if (!provider) {
      input.logger?.warn?.(
        `[spaces] credential rotation could not rebuild provider ${input.providerId}`,
      )
      return undefined
    }

    const from = activeEntryId
    activeEntryId = resolution.entry.id
    return {
      provider,
      // 换的是**另一把** key,没有理由退避 —— 退避是给"同一把钥匙等它凉下来"的。
      delayMs: 0,
      reason: `凭证 ${from} ${describeRotationCause(classification.kind)},换用「${resolution.entry.label}」重试`,
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
