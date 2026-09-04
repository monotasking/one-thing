/**
 * expand:查询词 → 候选词(注册表)。
 *
 * 设计:docs/design/search-index-2026-09.md §6.2b(起因见 §4.4 轴 ②)
 *
 * 第一稿把「前缀展开」写死在分析器的查询侧 —— 那是枚举点:模糊、拼音、同义、
 * 拼写纠错各要再写死一次。现在它们各是一个 expander,注册即生效。
 * **expander 只看词典不看文档**,所以是纯函数、可单测。
 */

import type { Vocabulary } from '../index/types.js'

/** 前缀展开的上限(§6.2b)。`a` 展开成半个词典是这条守的。 */
export const PREFIX_EXPANSION_LIMIT = 64

export interface QueryToken {
  text: string
  /** 是不是查询的末词 —— 边打边出时只有末词该做前缀展开 */
  last: boolean
}

export interface ExpandContext {
  /** 在哪些字段的词典上展开(来自 manifest.schema) */
  fields: readonly string[]
  limit?: number
}

export interface ExpandedTerm {
  term: string
  weight: number
}

export interface QueryExpander {
  readonly id: string
  expand(term: QueryToken, vocab: Vocabulary, ctx: ExpandContext): ExpandedTerm[]
}

export class DuplicateExpanderError extends Error {
  readonly expanderId: string

  constructor(expanderId: string) {
    super(`query expander already registered: ${expanderId}`)
    this.name = 'DuplicateExpanderError'
    this.expanderId = expanderId
  }
}

export interface ExpanderRegistry {
  register(expander: QueryExpander): () => void
  list(): QueryExpander[]
  get(id: string): QueryExpander | undefined
}

export function createExpanderRegistry(): ExpanderRegistry {
  const map = new Map<string, QueryExpander>()
  return {
    register(expander) {
      if (map.has(expander.id)) throw new DuplicateExpanderError(expander.id)
      map.set(expander.id, expander)
      return () => {
        if (map.get(expander.id) === expander) map.delete(expander.id)
      }
    },
    list: () => [...map.values()],
    get: id => map.get(id),
  }
}

/**
 * 末词在词典区间展开,上限 64。展开项的权重按名次递减 —— 越靠后的补全越不像
 * 用户想要的那个词,不该和原词一样重。
 */
export function createPrefixExpander(limit = PREFIX_EXPANSION_LIMIT): QueryExpander {
  return {
    id: 'prefix',
    expand(term, vocab, ctx) {
      if (!term.last || term.text.length === 0) return []
      const cap = Math.min(limit, ctx.limit ?? limit)
      const seen = new Set<string>([term.text])
      const out: ExpandedTerm[] = []
      for (const field of ctx.fields) {
        // 多要一条:原词自己也在词典里,它要占掉一个名额,而上限说的是**展开出来的**那 64 个。
        for (const candidate of vocab.terms(field, term.text, cap + 1)) {
          if (out.length >= cap) return out
          if (seen.has(candidate)) continue
          seen.add(candidate)
          out.push({ term: candidate, weight: 0.5 })
        }
      }
      return out
    },
  }
}

export function createDefaultExpanderRegistry(): ExpanderRegistry {
  const registry = createExpanderRegistry()
  registry.register(createPrefixExpander())
  return registry
}

/**
 * 一个词的全部候选:原词永远在,权重 1;展开项跟在后面。
 * 上限对**整条**生效(不是每个 expander 各 64),否则加一个 expander 就翻一倍。
 */
export function expandTerm(
  term: QueryToken,
  expanders: readonly QueryExpander[],
  vocab: Vocabulary,
  ctx: ExpandContext,
): ExpandedTerm[] {
  const cap = ctx.limit ?? PREFIX_EXPANSION_LIMIT
  const seen = new Set<string>([term.text])
  const out: ExpandedTerm[] = [{ term: term.text, weight: 1 }]

  for (const expander of expanders) {
    for (const expanded of expander.expand(term, vocab, ctx)) {
      if (out.length >= cap + 1) return out
      if (seen.has(expanded.term)) continue
      seen.add(expanded.term)
      out.push(expanded)
    }
  }

  return out
}
