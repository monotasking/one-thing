/**
 * 插件凭证策略注册表 + 调用口(批 E,装配层)。
 *
 * core 立了契约(`credential-strategy.ts`:白名单投影、超时常量、命名空间、
 * 合法性判据),这里接四样只有装配层认识的东西:
 *
 *  1. **注册表**(`plugin:<id>:<name>` → handler),连同两侧拆除;
 *  2. **超时 + 熔断** —— 超时 / 抛错 / 返回非法 id 记进 `credential-strategy`
 *     家族(degrade-surface);降级之后**连 handler 都不调**(否则每一次起流都
 *     要白等一个超时预算);
 *  3. **脱敏上下文** —— 用 core 的白名单投影把 entry 压成视图,再贴上账本按
 *     `credentialId` 归因聚合出来的近期用量;
 *  4. **同步裁决口** —— 装到产品层的 `configureSpaceCredentialPluginStrategyHost`
 *     上,让分叉点 `selectSpaceCredentialEntryDetailed` 能同步取用。
 *
 * ## 为什么是「异步算、同步取」(批 E 最重要的一条设计)
 *
 * 分叉点整条上游链是同步的:`selectSpaceCredentialEntryDetailed` →
 * `resolveSpaceProviderCredential` → `applySessionSpaceCredentials` →
 * `getEffectiveOnethingProviderConfig` → core 的
 * `StreamEngineProviderAdapter.getEffectiveConfig`。而插件 handler 的契约是
 * `string | Promise<string>`。两者只能在这里对接:
 *
 *  - **异步侧**(`refreshCredentialStrategyDecision`)在**请求/重试边界**上跑:
 *    真正 await handler、掐超时、记熔断、落一条「裁决」。
 *  - **同步侧**(`decide`)只做一件事:把已经算好的那条裁决取出来用,并顺手
 *    再排一次异步刷新(下一次选择就是新鲜的)。取不到 = 返回 undefined =
 *    分叉点回落内置 `priority-failover`。
 *
 * 代价说清楚:**冷启动后的第一次选择走的是内置 failover**(那一刻还没有任何
 * 裁决),从第二次起才是策略说了算;而**错误路径(轮换)是 await 的、恒新鲜**
 * ——那正是「这个用完用另一个」的主场。把整条链改成异步能消掉这个冷启动窗口,
 * 但那要动 core 引擎的适配器契约,与「接线点唯一」这条纪律相悖,不值。
 *
 * ## 拆除:代码侧摘掉,数据侧一个字节不改
 *
 * 插件停用/卸载 = 策略从表里摘除,选择当场回落内置 failover(**调用仍然成功**
 * ——这是三个既有注册表里唯一一个真的 `degrade-to-default`)。用户空间里的
 * `policy` 字段**原样保留**:那是用户的选择,插件回来自动生效;面板把它画成
 * 灰态并注明「策略不可用,正在使用内置 failover」。策略本身没有数据足迹
 * (它要存东西用 `api.storage`,归 R3 的插件数据目录管),所以没有归档动作。
 */
import {
  PLUGIN_CREDENTIAL_STRATEGY_TIMEOUT_MS,
  isPluginCredentialChoiceValid,
  pluginCredentialStrategySurface,
  pluginScope,
  toPluginCredentialEntryView,
  type CorePluginCredentialStrategyContext,
  type CorePluginCredentialStrategyRegistration,
  type PluginCredentialEntryView,
  type PluginCredentialFailureKind,
  type PluginCredentialUsage,
} from '@onething/core/plugins'
import {
  configureSpaceCredentialPluginStrategyHost,
  type SpaceCredentialEntry,
} from '@onething/runtime/spaces/credentials'
import {
  computeOnethingCredentialUsage,
  type OnethingUsageLedgerRecord,
} from '@onething/runtime/usage'
import {
  isPluginSurfaceDegraded,
  probePluginSurface,
  reportPluginRuntimeFailure,
  reportPluginRuntimeSuccess,
} from '../../plugins/health.js'
import { getUsageLedger } from '../usage/index.js'

/**
 * 用量统计窗口。
 *
 * 24 小时是「便宜」与「有信息量」的交点:配额通常按天/按月重置,一天的量足够
 * 回答"哪把 key 今天用得多";再长就要扫更多月文件,而这条路径挂在起流边界上。
 */
export const PLUGIN_CREDENTIAL_USAGE_WINDOW_MS = 24 * 60 * 60_000

/** 用量聚合的缓存寿命 —— 起流边界上不该每次都去读账本文件。 */
const USAGE_CACHE_TTL_MS = 60_000

interface RegisteredCredentialStrategy {
  pluginId: string
  policy: string
  name: string
  title: string
  description?: string
  registration: CorePluginCredentialStrategyRegistration
}

/** key = `plugin:<pluginId>:<name>`,也就是落盘的 policy 取值。 */
const strategies = new Map<string, RegisteredCredentialStrategy>()

/**
 * 已算好的裁决。key = `<spaceId>:<providerId>`。
 *
 * **不持久化**,与批 D 的 round-robin 游标同一条理由:它是纯调度细节,落盘会把
 * 它变成需要迁移、需要并发保护的状态,而重启后多走一次内置 failover 的代价近乎为零。
 */
interface CredentialStrategyDecision {
  policy: string
  entryId: string
  /** 算这条裁决时的候选集指纹 —— 池变了就作废(否则会指向一条已删的 entry)。 */
  fingerprint: string
  at: number
}

const decisions = new Map<string, CredentialStrategyDecision>()

/** 正在跑的异步刷新(去重:同一 key 不并发问两次)。 */
const inflight = new Map<string, Promise<void>>()

/** 每条 entry 最近一次的失败分类 —— 喂给 ctx.entries[].lastErrorKind。 */
const lastFailureByEntry = new Map<string, PluginCredentialFailureKind>()

interface UsageCacheSlot {
  at: number
  byCredential: Record<string, PluginCredentialUsage>
}

const usageCache = new Map<string, UsageCacheSlot>()

function decisionKey(spaceId: string, providerId: string): string {
  return `${spaceId}:${providerId}`
}

function fingerprintOf(candidates: readonly { id: string }[]): string {
  return candidates.map(entry => entry.id).join('|')
}

/* ── 注册表 ─────────────────────────────────────────────────────────────── */

/**
 * 装配层落点:core 的 `host.registerCredentialStrategy` 转发到这里。返回退订函数。
 *
 * 同一 policy 重复注册 = 覆盖(core 侧一个 manifest 策略绑一份实现;这里是最终
 * 登记表,以后到者为准足够)。
 */
export function registerPluginCredentialStrategy(
  pluginId: string,
  registration: CorePluginCredentialStrategyRegistration,
): () => void {
  const name = String(registration?.name ?? '').trim()
  if (!name) return () => {}
  const policy = `plugin:${pluginId}:${name}`
  const entry: RegisteredCredentialStrategy = {
    pluginId,
    policy,
    name,
    title: String(registration.title ?? '').trim() || name,
    ...(registration.description?.trim() ? { description: registration.description.trim() } : {}),
    registration,
  }
  strategies.set(policy, entry)
  let released = false
  return () => {
    if (released) return
    released = true
    // 只删自己那一份:竞态窗口里可能有新登记覆盖了它,别把别人的删了。
    if (strategies.get(policy)?.registration === registration) {
      strategies.delete(policy)
      // 裁决跟着策略走 —— 留着一条属于已撤下策略的裁决,下一次选择就会拿它
      // 当"策略还在生效"用。
      for (const [key, decision] of decisions) {
        if (decision.policy === policy) decisions.delete(key)
      }
    }
  }
}

export interface PluginCredentialStrategyInfo {
  policy: string
  pluginId: string
  name: string
  title: string
  description?: string
}

/** 面板的策略选择器据它列出"当前可选的插件策略"。 */
export function listPluginCredentialStrategies(): PluginCredentialStrategyInfo[] {
  return [...strategies.values()].map(({ policy, pluginId, name, title, description }) => ({
    policy,
    pluginId,
    name,
    title,
    ...(description ? { description } : {}),
  }))
}

/**
 * 这个 policy 此刻有没有一个**能用**的策略。
 *
 * 「注册着」还不够:降级(连败到阈值)之后它同样是不可用的 —— 面板要画的灰态
 * 是"用户选了但它现在没在生效",两种原因对用户是同一件事。
 */
export function isPluginCredentialStrategyAvailable(policy: string): boolean {
  const strategy = strategies.get(policy)
  if (!strategy) return false
  return !isPluginSurfaceDegraded(strategy.pluginId, pluginCredentialStrategySurface(policy))
}

/** 测试专用:清空注册表与全部缓存。 */
export function resetPluginCredentialStrategiesForTests(): void {
  strategies.clear()
  decisions.clear()
  inflight.clear()
  lastFailureByEntry.clear()
  usageCache.clear()
}

/** 轮换路径把上一条 entry 的失败分类记在这里,下一次 ctx 就带得上。 */
export function notePluginCredentialFailure(
  entryId: string,
  kind: PluginCredentialFailureKind,
): void {
  lastFailureByEntry.set(entryId, kind)
}

/* ── 用量聚合(账本按 credentialId 归因)─────────────────────────────────── */

async function loadUsage(
  spaceId: string,
  providerId: string,
  now: number,
): Promise<Record<string, PluginCredentialUsage>> {
  const key = decisionKey(spaceId, providerId)
  const cached = usageCache.get(key)
  if (cached && now - cached.at < USAGE_CACHE_TTL_MS) return cached.byCredential
  let records: readonly OnethingUsageLedgerRecord[] = []
  try {
    records = await getUsageLedger().readRecordsInRange(
      now - PLUGIN_CREDENTIAL_USAGE_WINDOW_MS,
      now + 1,
    )
  } catch {
    // 账本读不出来不该让挑钥匙失败 —— 用量是决策的佐料,不是前提。
    records = []
  }
  const byCredential = computeOnethingCredentialUsage(records, { providerId, workspaceId: spaceId })
  usageCache.set(key, { at: now, byCredential })
  return byCredential
}

/* ── 脱敏上下文 ─────────────────────────────────────────────────────────── */

function buildEntryViews(
  candidates: readonly SpaceCredentialEntry[],
  usage: Record<string, PluginCredentialUsage>,
): PluginCredentialEntryView[] {
  // **白名单投影**(core 的 toPluginCredentialEntryView):apiKey / oauthToken /
  // baseUrl / apiMode 一个字节都不进这个对象。正向构造,不是"删掉几个字段"。
  return candidates.map(entry => toPluginCredentialEntryView(entry, {
    ...(usage[entry.id] ? { usage: usage[entry.id] } : {}),
    ...(lastFailureByEntry.get(entry.id)
      ? { lastErrorKind: lastFailureByEntry.get(entry.id)! }
      : {}),
  }))
}

/* ── 异步侧:算一条裁决 ─────────────────────────────────────────────────── */

function runWithTimeout<T>(run: () => T | Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`credential strategy timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
    timer.unref?.()
    Promise.resolve()
      .then(run)
      .then(
        value => { clearTimeout(timer); resolve(value) },
        error => { clearTimeout(timer); reject(error) },
      )
  })
}

export interface RefreshCredentialStrategyInput {
  policy: string
  spaceId: string
  providerId: string
  candidates: readonly SpaceCredentialEntry[]
  attempt?: number
  lastFailure?: { entryId: string; kind: PluginCredentialFailureKind; status?: number }
  now?: number
  timeoutMs?: number
}

/**
 * 问一次插件策略,把结果落成裁决。**这是唯一真的 await handler 的地方。**
 *
 * 返回选中的 entry id,或 undefined(策略缺席 / 降级 / 超时 / 抛错 / 返回非法值)。
 * 后四种都记熔断 —— 前一种不记(没注册不是运行期失败,是插件没装/没启用)。
 */
export async function refreshCredentialStrategyDecision(
  input: RefreshCredentialStrategyInput,
): Promise<string | undefined> {
  const strategy = strategies.get(input.policy)
  if (!strategy || input.candidates.length === 0) return undefined
  const surface = pluginCredentialStrategySurface(input.policy)
  // 降级的策略:半开满一个间隔才放行一次探测,否则**连 handler 都不调** ——
  // 每一次起流白等一个超时预算,是这条路径上最贵的浪费。
  if (isPluginSurfaceDegraded(strategy.pluginId, surface)
    && !probePluginSurface(strategy.pluginId, surface)) {
    return undefined
  }

  const now = input.now ?? Date.now()
  const usage = await loadUsage(input.spaceId, input.providerId, now)
  const entries = buildEntryViews(input.candidates, usage)
  const ctx: CorePluginCredentialStrategyContext = {
    providerId: input.providerId,
    spaceId: input.spaceId,
    entries,
    attempt: input.attempt ?? 1,
    ...(input.lastFailure ? { lastFailure: input.lastFailure } : {}),
    usageWindowMs: PLUGIN_CREDENTIAL_USAGE_WINDOW_MS,
    now,
  }

  const scope = pluginScope.credentialStrategy(input.policy)
  try {
    const choice = await runWithTimeout(
      () => strategy.registration.select(ctx),
      input.timeoutMs ?? PLUGIN_CREDENTIAL_STRATEGY_TIMEOUT_MS,
    )
    // 「返回非法 id」与「返回冷却中的 id」在这里同归一路:候选集里本来就没有
    // 冷却中的条目,所以一条判据覆盖两种错法。
    if (!isPluginCredentialChoiceValid(choice, entries)) {
      reportPluginRuntimeFailure(
        strategy.pluginId,
        scope,
        new Error(
          `credential strategy "${input.policy}" returned an id that is not among the `
          + `${entries.length} available credential(s): ${JSON.stringify(choice)}`,
        ),
      )
      return undefined
    }
    reportPluginRuntimeSuccess(strategy.pluginId, scope)
    decisions.set(decisionKey(input.spaceId, input.providerId), {
      policy: input.policy,
      entryId: choice,
      fingerprint: fingerprintOf(input.candidates),
      at: now,
    })
    return choice
  } catch (error) {
    reportPluginRuntimeFailure(strategy.pluginId, scope, error)
    return undefined
  }
}

/* ── 同步侧:分叉点的裁决口 ─────────────────────────────────────────────── */

interface DecideInput {
  policy: string
  spaceId: string
  providerId: string
  candidates: readonly SpaceCredentialEntry[]
  now: number
}

/**
 * 分叉点同步取用。取到 = 用它;取不到 = undefined,分叉点回落 priority-failover。
 *
 * 顺手排一次异步刷新(去重),让下一次选择新鲜。刷新失败什么也不做 ——
 * 回落路径本来就是可用的默认答案。
 */
function decide(input: DecideInput): string | undefined {
  const strategy = strategies.get(input.policy)
  if (!strategy || input.candidates.length === 0) return undefined
  const key = decisionKey(input.spaceId, input.providerId)
  const decision = decisions.get(key)
  const fingerprint = fingerprintOf(input.candidates)
  // 池变了(加/删/排序)= 旧裁决作废:它可能指向一条已经被删掉的 entry。
  const usable = decision
    && decision.policy === input.policy
    && decision.fingerprint === fingerprint
    ? decision.entryId
    : undefined
  if (!usable) decisions.delete(key)

  if (!inflight.has(key)) {
    const task = refreshCredentialStrategyDecision({
      policy: input.policy,
      spaceId: input.spaceId,
      providerId: input.providerId,
      candidates: input.candidates,
      attempt: 1,
      now: input.now,
    })
      .then(() => {})
      .catch(() => {})
      .finally(() => { inflight.delete(key) })
    inflight.set(key, task)
  }
  return usable
}

let configured = false

/**
 * 把裁决口装到产品层的分叉点上。由 `configureAppRuntimeAdapters()` 调用,幂等。
 *
 * **import 本模块不配置任何东西** —— 与 `import-side-effect-free` 那条守卫同规。
 */
export function configureAppPluginCredentialStrategyHost(): void {
  if (configured) return
  configured = true
  configureSpaceCredentialPluginStrategyHost({ decide })
}

/** 测试专用:卸下裁决口并复位幂等闩。 */
export function resetAppPluginCredentialStrategyHostForTests(): void {
  configured = false
  configureSpaceCredentialPluginStrategyHost(null)
}

/** 测试专用:等所有在途刷新落地(同步裁决口是 fire-and-forget 的)。 */
export async function flushPluginCredentialStrategyRefreshForTests(): Promise<void> {
  while (inflight.size > 0) await Promise.all([...inflight.values()])
}
