/**
 * fanout:问能力。
 *
 * 设计:docs/design/search-index-2026-09.md §6.4(v3.1 版)+ §6.5b
 *
 * 四条硬规矩,少一条这一段就白写:
 * ① 按能力**各自**逐级试阶梯 —— messages 放宽到 ③ 不影响 sessions 停在 ①;
 *    manifest `relax:false` 的只跑第一级。
 * ② 超时经 `ctx.signal` 派生的 AbortSignal **传进** `search()` —— 不是外面包一层
 *    `withTimeout` 让它在里面继续白算。
 * ③ 授权在调 `search()` **之前**算好塞进 filters(§6.4b)。
 * ④ 谁先答完谁先 yield;失败 / 超时 = 该组 `{ error }`,不拖死别组。
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
    const capabilities = selectCapabilities(registry, query, ctx)
    if (capabilities.length === 0) return

    const table = budgets(query, capabilities)
    const inFlight = capabilities.map(capability =>
      runLadder(capability, query, ctx, table[capability.manifest.id], options))

    for await (const group of settleInArrivalOrder(inFlight)) yield group
  }
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
  const authorized = applyVisibility(query, scope)
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
      // 预算用完就收场。有结果的话上面早返回了,所以这里只可能是「空页 + 超时」。
      if (derived.timedOut) return { capability: id, error: 'timeout' }
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
