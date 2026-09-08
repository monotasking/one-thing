/**
 * fanout:问能力。
 *
 * 设计:docs/design/search-index-2026-09.md §6.4(v3.1 版)+ §6.5b
 *
 * 五条硬规矩,少一条这一段就白写:
 * ① 按能力**各自**逐级试阶梯 —— messages 放宽到 ③ 不影响 sessions 停在 ①;
 *    manifest `relax:false` 的只跑第一级。
 * ② 超时经 `ctx.signal` 派生的 AbortSignal **传进** `search()` —— 不是外面包一层
 *    `withTimeout` 让它在里面继续白算。
 * ③ 授权在调 `search()` **之前**算好塞进 filters(§6.4b)。
 * ④ **一个能力只收它自述里声明过的过滤键**(见 `narrowToDeclaredFacets`)。
 * ⑤ 谁先答完谁先 yield;失败 / 超时 = 该组 `{ error }`,不拖死别组。
 * ⑥ **不挑那一档不等去外部枚举的那些路**(09-07 事故;见 `deferInAll`)。
 */

import type {
  GroupResult,
  LadderStep,
  PageRequest,
  SearchContext,
  SearchPage,
  SearchQuery,
} from '../candidate.js'
import { ALL_CAPABILITIES } from '../candidate.js'
import type { CapabilityRegistry, SearchCapability } from '../capability.js'
import { capabilityServesSurface } from '../capability.js'
import type { Budget, BudgetPolicy } from './budget.js'
import { budgetPolicy as defaultBudgetPolicy } from './budget.js'
import { plan } from './plan.js'
import type { AuthorizationWarn } from './authorize.js'
import { applyVisibility, assertAuthorized, visibilityScopeOf } from './authorize.js'

export interface FanoutOptions {
  warn?: AuthorizationWarn
  /** 单类档翻页时把游标交给那一路;全部档不带游标(§7.2 不分页) */
  page?: PageRequest
  now?: () => number
}

export type Fanout = (
  ctx: SearchContext,
  query: SearchQuery,
  options?: FanoutOptions,
) => AsyncGenerator<GroupResult>

export function fanout(
  registry: CapabilityRegistry,
  budgets: BudgetPolicy = defaultBudgetPolicy,
): Fanout {
  return async function* run(ctx, query, options = {}) {
    const selected = selectCapabilities(registry, query, ctx)
    if (selected.length === 0) return

    // ⑥:不挑那一档里,自述说「我去外部枚举」的那几路**这一次不问**(见 `deferInAll`)。
    const askedForAll = (query.capability ?? ALL_CAPABILITIES) === ALL_CAPABILITIES
    const deferred = askedForAll ? selected.filter(deferInAll) : []
    const capabilities = deferred.length === 0
      ? selected
      : selected.filter(capability => !deferInAll(capability))

    // 先出「这一组没跑」——它一个字节的 I/O 都不做,让消费方最早知道该自己去问一次。
    for (const capability of deferred) yield { capability: capability.manifest.id, deferred: true }

    if (capabilities.length === 0) return
    const table = budgets(query, capabilities)
    const inFlight = capabilities.map(capability =>
      runLadder(capability, query, ctx, table[capability.manifest.id], options))

    for await (const group of settleInArrivalOrder(inFlight)) yield group
  }
}

/**
 * **不挑那一档不等它**(硬规矩 ⑥;`docs/design/search-index-2026-09.md` §7.1)。
 *
 * 判据是自述里那格 `kind`:`'scan'` 说的是「我不是查索引,我是去外部枚举」——
 * 一次枚举有多大是外部世界说了算,不是这台机器说了算(09-07 那一次是 18GB、
 * 16 个 node_modules 与一圈符号链接)。一次「不挑」的搜索要把全部组收齐才答得出
 * 分组总览,于是这样一路能把整发钉死。
 *
 * 这里**没有任何能力的名字**,加一路 scan 型能力不用改这一行;而单类档
 * (用户明确挑了这一档)照常真跑 —— 那时用户要的就是这一路,等它是应该的。
 */
function deferInAll(capability: SearchCapability): boolean {
  return capability.manifest.kind === 'scan'
}

export function selectCapabilities(
  registry: CapabilityRegistry,
  query: SearchQuery,
  ctx: SearchContext,
): SearchCapability[] {
  const selector = query.capability ?? ALL_CAPABILITIES
  if (selector !== ALL_CAPABILITIES) {
    const one = registry.get(selector)
    return one === undefined ? [] : [one]
  }
  return registry.list().filter(capability =>
    capabilityServesSurface(capability.manifest, ctx.surface) && capability.supports(query))
}

async function runLadder(
  capability: SearchCapability,
  query: SearchQuery,
  ctx: SearchContext,
  budget: Budget | undefined,
  options: FanoutOptions,
): Promise<GroupResult> {
  const manifest = capability.manifest
  const id = manifest.id
  const limit = budget?.limit ?? manifest.budget.default
  const timeoutMs = budget?.timeoutMs ?? manifest.budget.timeoutMs

  const scope = visibilityScopeOf(manifest, ctx.principal)
  /*
   * 先按自述**收窄**用户那几格,再叠授权范围。次序是判据:
   * 授权那几格是 core 替这一路加上的,**它永远不该被收窄掉**(§6.4b「范围赢」)。
   */
  const authorized = applyVisibility(narrowToDeclaredFacets(query, manifest), scope)
  const ladder = plan(authorized, { relax: manifest.relax })

  const now = options.now ?? (() => Date.now())
  const startedAt = now()
  let last: SearchPage | undefined

  // §7.1 的 timeoutMs 是**这一路**的预算,不是每一级的:阶梯只是同一路问法的逐级放宽,
  // 所以派生一次、四级共用剩余时间;逐级各派生一次会让一个能力占到 4 × timeoutMs。
  const derived = deriveSignal(ctx.signal, timeoutMs)
  try {
    for (const step of ladder) {
      try {
        const page = await capability.search(
          withLadder(authorized, step),
          { limit, cursor: options.page?.cursor },
          { ...ctx, signal: derived.signal },
        )
        const checked = assertAuthorized(page, scope, { capability: id, warn: options.warn })
        last = { ...checked.page, relaxed: step.level }
        if (checked.page.items.length > 0) return { capability: id, page: last }
      } catch (error) {
        return { capability: id, error: describeError(error, derived.timedOut) }
      }
      // 上游已经喊停就别再往下放宽了 —— 换词那一刻在飞的全都不作数。
      if (ctx.signal.aborted) break
      /*
       * 预算用完就收场。有结果的话上面早返回了,所以这里只可能是「空页 + 超时」。
       *
       * **除非那一页自报 `partial`**:那句话的意思是「我知道自己被打断了,这是
       * 我扫到的部分」—— 它答过了,只是没答完,而「一条都没扫到」与「没搜成」是
       * 两件事(09-07 事故的第三条修)。这里认的是页上那一格,不是任何一个能力。
       */
      if (derived.timedOut) {
        return last?.partial === true
          ? { capability: id, page: last }
          : { capability: id, error: 'timeout' }
      }
    }
  } finally {
    derived.dispose()
  }

  return {
    capability: id,
    page: last ?? { items: [], total: 0, relaxed: 0, took: now() - startedAt },
  }
}

function withLadder(query: SearchQuery, step: LadderStep): SearchQuery {
  return { ...query, ladder: step }
}

/**
 * **一个能力只收它自述里声明过的过滤键**(硬规矩 ④)。
 *
 * `SearchQuery.filters` 是**全场一份**的:壳按各能力自述的并集画过滤片(§9 第五条
 * 「`all` 档画各组声明的并集」),`extract` 还会往里塞抽到的时间窗(§6.1b)。
 * 而 `matchesFacetFilter` 对一格**文档上根本没有的 facet** 判的是「不通过」——
 * 于是一格 `spaceId` 会把不声明 `spaceId` 的那一路(daily)整组清零:
 * 屏幕上那一组凭空消失,而没有任何一处说得出为什么。
 *
 * 判据只能是 manifest:**自述里没说认这个键 = 这个键与它无关**,不是「它不通过」。
 * core 在这里**不认识任何一个键名**,它只做一次集合运算 —— 与 §4.0 那条
 * 「凡按能力枚举的地方改成能力自述、别人读表」逐字同源。
 *
 * 两种缺省各有意思,不能混:
 *  · `facets` **缺席** = 这一类不认过滤(scan / static 基座今天就是)→ 一格都不给;
 *  · `facets: []` 同义。
 * 真要「什么都收」的能力,自己把键声明出来 —— 那正是自述的用处。
 */
export function narrowToDeclaredFacets(
  query: SearchQuery,
  manifest: { facets?: readonly { key: string }[] },
): SearchQuery {
  const keys = new Set((manifest.facets ?? []).map(facet => facet.key))
  const entries = Object.entries(query.filters).filter(([key]) => keys.has(key))
  // 一格都没被滤掉时**原样返回**:换一个等值的新对象只会让下游的身份判据白跑。
  if (entries.length === Object.keys(query.filters).length) return query
  return { ...query, filters: Object.fromEntries(entries) }
}

interface DerivedSignal {
  signal: AbortSignal
  timedOut: boolean
  dispose(): void
}

/**
 * 派生信号:上游一停这里就停,自己的预算到点也停。两条都要 —— 只有上游的会让
 * 一路慢查询吃掉整次搜索,只有自己的会让换词之后还在白算。
 */
export function deriveSignal(parent: AbortSignal, timeoutMs: number): DerivedSignal {
  const controller = new AbortController()
  const state = { timedOut: false }

  const onParentAbort = (): void => controller.abort(parent.reason)
  if (parent.aborted) controller.abort(parent.reason)
  else parent.addEventListener('abort', onParentAbort, { once: true })

  const timer = timeoutMs > 0
    ? setTimeout(() => {
      state.timedOut = true
      controller.abort(new Error(`search capability timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    : undefined

  return {
    signal: controller.signal,
    get timedOut() {
      return state.timedOut
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer)
      parent.removeEventListener('abort', onParentAbort)
    },
  }
}

function describeError(error: unknown, timedOut: boolean): string {
  if (timedOut) return 'timeout'
  if (error instanceof Error) return error.message
  return String(error)
}

/** 谁先答完谁先出(§6.5b)。传进来的 promise 不许 reject —— 上面已经全接住了。 */
export async function* settleInArrivalOrder<T>(
  promises: readonly Promise<T>[],
): AsyncGenerator<T> {
  const pending = new Map<number, Promise<{ index: number; value: T }>>()
  promises.forEach((promise, index) => {
    pending.set(index, promise.then(value => ({ index, value })))
  })

  while (pending.size > 0) {
    const settled = await Promise.race(pending.values())
    pending.delete(settled.index)
    yield settled.value
  }
}
