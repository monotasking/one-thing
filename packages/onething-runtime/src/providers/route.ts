/**
 * 轮转 v2 的**唯一决策函数** —— 批 6(`docs/design/provider-settings-rework-2026-09.md` §9.1)。
 *
 * 「这一发该用哪一家的哪一条凭证,用不了再换谁」从前是两处各答一半:发送前
 * `selectSpaceCredentialEntryDetailed` 只在一家的池里挑,失败后轮转器也只在那一家的池里转。
 * 订阅与同家 API 之间零接力,配额满了只能等报错冷却。现在反过来:**一次算出整条候选序列**,
 * 发送前取 `[0]`,失败后沿序列取下一条 —— 两处读同一份答案,不再各算各的。
 *
 * 顺序(逐字照 §9.1):
 *  1. 目标家 `billing === 'subscription'`:它的登录账号,按**最紧那个窗口的剩余量**从多到少;
 *     没有配额数据的排在有数据的后面,按池内顺序;
 *  2. 开关「订阅额度用完时切到 API 密钥」开着、且目标家确实有登录过的账号时:`manifest.sibling`
 *     那一家(同家的 API 半边)的密钥,按那一池的策略排;
 *  3. 目标家 `billing === 'api'`:它的密钥按池策略排(`single` = 只取第一条可用;
 *     `priority-failover` = 按序;`round-robin` = 从游标起)。
 *
 * 冷却 = 报错冷却 ∪ 配额冷却,两者住在同一格 `cooldownUntil`(配额服务写的那种带
 * `cooldownReason: 'quota'`),这里只认那一格。停用的家硬过滤;**跨家(非 sibling)一律不进候选**
 * —— Claude 全用完不会改走 DeepSeek,换模型是用户在选择器里手选的事。
 *
 * **纯函数**:manifest 表、池、配额缓存、开关、游标全由调用方喂进来。本文件不写盘、不拨游标、
 * 不读进程状态 —— 「真正发出去的那一发才拨游标」是调用方的事。provider 名一个都不出现:
 * 谁是订阅、谁是谁的另一半,全读 manifest 的 `billing` / `sibling` / `auth`。
 */
import type { ProviderQuota, ProviderQuotaWindow } from '@shared/contracts/quota.js'
import type { ProviderManifest } from './manifest.js'
import {
  isPluginSpaceCredentialPolicy,
  isSpaceCredentialEntryCooling,
  isSpaceCredentialEntryUsable,
  normalizeSpaceCredentialPolicy,
  type SpaceCredentialAuthType,
  type SpaceCredentialEntry,
  type SpaceProviderCredentials,
} from '../spaces/credentials.js'

/**
 * 这条候选为什么排在这儿。
 *  - `subscription`:目标家(订阅)自己的登录账号;
 *  - `sibling-api`:订阅额度用完后接力的同家 API 密钥 —— 这一轮按 API 计费;
 *  - `api`:目标家(API)自己的密钥。
 */
export type RouteReason = 'subscription' | 'sibling-api' | 'api'

export interface RouteCandidate {
  providerId: string
  entryId: string
  reason: RouteReason
}

export interface PickRouteInput {
  /** 用户选的那一家(模型选择器里的那一家)。 */
  providerId: string
  spaceId: string
  now: number
  manifests: (providerId: string) => ProviderManifest | undefined
  pools: (providerId: string) => SpaceProviderCredentials | undefined
  /** 配额缓存里这条凭证的最新一份(只读,不取数)。没有 = 不知道。 */
  quotas: (providerId: string, entryId: string) => ProviderQuota | undefined
  /** 这家在这个空间开着吗(`isProviderEnabledIn`,与发送闸同一判据)。 */
  enabled: (providerId: string) => boolean
  /** 目标家那颗「订阅额度用完时切到 API 密钥」。缺席 = 开(拍点 7),由调用方折好传进来。 */
  subscriptionFallback: boolean
  /** round-robin 游标(读,不拨)。 */
  roundRobinCursor: (providerId: string) => number
  /**
   * 插件策略(`plugin:<id>:<name>`)的同步裁决口。返回候选里的一条 id 就把它排到最前,
   * 其余按池内顺序兜底(= 内置 failover);缺席 / 返回不认识的 id = 纯 failover。
   */
  pluginDecide?: (input: {
    policy: string
    providerId: string
    candidates: readonly SpaceCredentialEntry[]
  }) => string | undefined
}

/** 这条账号「最紧那个窗口」还剩多少(0–100)。没有窗口数据 = `undefined`。 */
export function remainingQuotaPercent(quota: ProviderQuota | undefined, now: number): number | undefined {
  if (!quota || quota.kind !== 'windows' || quota.windows.length === 0) return undefined
  // 主窗口(5 小时 / 本周)才说「这个账号还能不能用」;带 label 的附加窗口(某个型号族的周窗)
  // 只管那一族。主窗口一个都没有时才退回看全部。
  const primary = quota.windows.filter(window => !window.label)
  const windows: ProviderQuotaWindow[] = primary.length > 0 ? primary : quota.windows
  let tightest = Number.POSITIVE_INFINITY
  for (const window of windows) {
    // 缓存里那一份可能是重置之前取的:重置时刻已过的窗口按「用了 0」算。不这样,窗口重置后
    // 序列回不到那个账号 —— 它会一直挂着上一轮 100% 的旧读数排在最后。
    const used = window.resetsAt !== undefined && window.resetsAt <= now ? 0 : window.usedPercent
    tightest = Math.min(tightest, 100 - used)
  }
  return Number.isFinite(tightest) ? Math.max(0, tightest) : undefined
}

function authTypeOf(manifest: ProviderManifest | undefined): SpaceCredentialAuthType {
  return manifest?.auth.kind === 'oauth' ? 'oauth' : 'apiKey'
}

/** 这一池里「此刻能拿去发请求」的那些(鉴权形态对、有凭证材料、不在冷却里),池内顺序。 */
function liveEntries(
  pool: SpaceProviderCredentials | undefined,
  authType: SpaceCredentialAuthType,
  now: number,
): SpaceCredentialEntry[] {
  return (pool?.entries ?? [])
    .filter(entry => entry.authType === authType)
    .filter(isSpaceCredentialEntryUsable)
    .filter(entry => !isSpaceCredentialEntryCooling(entry, now))
}

/** 订阅账号:按最紧窗口剩余量从多到少;没数据的垫后,按池内顺序(稳定排序)。 */
function orderBySubscriptionRemaining(
  input: PickRouteInput,
  providerId: string,
  entries: SpaceCredentialEntry[],
): SpaceCredentialEntry[] {
  const scored = entries.map((entry, index) => ({
    entry,
    index,
    remaining: remainingQuotaPercent(input.quotas(providerId, entry.id), input.now),
  }))
  scored.sort((a, b) => {
    if (a.remaining === undefined && b.remaining === undefined) return a.index - b.index
    if (a.remaining === undefined) return 1
    if (b.remaining === undefined) return -1
    return b.remaining - a.remaining || a.index - b.index
  })
  return scored.map(item => item.entry)
}

/** 按池策略排(API 密钥那一类)。 */
function orderByPoolPolicy(
  input: PickRouteInput,
  providerId: string,
  pool: SpaceProviderCredentials | undefined,
  authType: SpaceCredentialAuthType,
): SpaceCredentialEntry[] {
  if (!pool || pool.entries.length === 0) return []
  const policy = normalizeSpaceCredentialPolicy(pool.policy)

  if (policy === 'single') {
    // B3 原语义:这一形态里头一条不在冷却里的 —— 它没填密钥就是没有(不越过它去用后面那把,
    // 那是 failover 的意思,不是 single 的)。
    const first = pool.entries
      .filter(entry => entry.authType === authType)
      .find(entry => !isSpaceCredentialEntryCooling(entry, input.now))
    return first && isSpaceCredentialEntryUsable(first) ? [first] : []
  }

  const live = liveEntries(pool, authType, input.now)
  if (live.length === 0) return []

  if (isPluginSpaceCredentialPolicy(policy)) {
    const chosenId = input.pluginDecide?.({ policy, providerId, candidates: live })
    const chosen = chosenId ? live.find(entry => entry.id === chosenId) : undefined
    return chosen ? [chosen, ...live.filter(entry => entry !== chosen)] : live
  }

  if (policy === 'round-robin') {
    const start = Math.abs(Math.trunc(input.roundRobinCursor(providerId))) % live.length
    return [...live.slice(start), ...live.slice(0, start)]
  }

  return live
}

/** 一家的候选(不含接力)。停用的家、不登录的家(外部执行体)答空。 */
function candidatesOf(
  input: PickRouteInput,
  providerId: string,
  reason: RouteReason,
): RouteCandidate[] {
  if (!input.enabled(providerId)) return []
  const manifest = input.manifests(providerId)
  if (manifest?.auth.kind === 'none') return []
  const authType = authTypeOf(manifest)
  const pool = input.pools(providerId)
  const entries = manifest?.billing === 'subscription'
    ? orderBySubscriptionRemaining(input, providerId, liveEntries(pool, authType, input.now))
    : orderByPoolPolicy(input, providerId, pool, authType)
  return entries.map(entry => ({ providerId, entryId: entry.id, reason }))
}

/**
 * 整条候选序列。空 = 这一家眼下没有可用的凭证(未配置 / 全在冷却 / 停用)—— 调用方照旧
 * 走今天那几句失败文案(`exhausted` / `no-entry` / 已停用),本函数不造句子。
 */
export function pickRoute(input: PickRouteInput): RouteCandidate[] {
  const target = input.manifests(input.providerId)
  if (target?.billing !== 'subscription') {
    return candidatesOf(input, input.providerId, 'api')
  }

  const route = candidatesOf(input, input.providerId, 'subscription')
  if (!input.subscriptionFallback || !target.sibling || !input.enabled(input.providerId)) return route

  // 接力只在「订阅额度用完」时才有意义:目标家一个登录过的账号都没有(从没登录)时,
  // 悄悄改走 API 计费是用户没说过的话 —— 那一格仍然报「未登录」。
  const loggedIn = (input.pools(input.providerId)?.entries ?? [])
    .some(entry => entry.authType === authTypeOf(target) && isSpaceCredentialEntryUsable(entry))
  if (!loggedIn) return route

  const sibling = input.manifests(target.sibling)
  // 只接 API 那一半:订阅接订阅不是「按 API 计费」,也不是 §9.1 说的那条路。
  if (!sibling || sibling.billing !== 'api') return route
  return [...route, ...candidatesOf(input, sibling.id, 'sibling-api')]
}

/** 接力到同家 API 的那一轮,自动重试提示行上的那句话(拍点 7)。 */
export const ROUTE_FALLBACK_API_REASON = '订阅额度已用完,这一轮按 API 计费'
