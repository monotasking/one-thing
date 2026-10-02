/**
 * budgetPolicy:每一路给多少条、等多久。
 *
 * 设计:docs/design/search-index-2026-09.md §7.1
 *
 * 它是一段显式代码,但**读的是各能力的自述** —— 这个函数里没有任何能力的名字。
 * 想改某一路的配额,改它自己的 manifest;想让用户设置覆盖,是**替换这一个函数**,
 * 不是在里面加 if。
 */

import type { SearchQuery } from '../candidate.js'
import type { SearchCapability } from '../capability.js'

export interface Budget {
  limit: number
  timeoutMs: number
}

export type BudgetPolicy = (
  query: SearchQuery,
  capabilities: readonly SearchCapability[],
) => Record<string, Budget>

export const budgetPolicy: BudgetPolicy = (query, capabilities) =>
  Object.fromEntries(capabilities.map(capability => {
    const manifest = capability.manifest
    return [manifest.id, {
      limit: manifest.budget.whenIntent?.[query.intent] ?? manifest.budget.default,
      timeoutMs: manifest.budget.timeoutMs,
    }]
  }))

/** 单类档:这一路吃满页大小,别的路不参与。 */
export function singleCapabilityBudgetPolicy(limit: number): BudgetPolicy {
  return (query, capabilities) =>
    Object.fromEntries(capabilities.map(capability => [capability.manifest.id, {
      limit,
      timeoutMs: capability.manifest.budget.timeoutMs,
    }]))
}
