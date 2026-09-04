/**
 * 分析器注册表:id → analyzer。
 *
 * 设计:docs/design/search-index-2026-09.md §4.2b 末段
 *
 * manifest.schema 里写的是分析器 **id**,不是实例 —— 于是能力可以自带一个分析器
 * (`identifier`、将来的 `pinyin`)并在注册时带上,core 不枚举分析器名。
 */

import type { Analyzer } from './types.js'
import { cjkBigramAnalyzer } from './cjk-bigram.js'
import { latinWordAnalyzer } from './latin-word.js'
import { compositeAnalyzer } from './composite.js'

export class DuplicateAnalyzerError extends Error {
  readonly analyzerId: string

  constructor(analyzerId: string) {
    super(`analyzer already registered: ${analyzerId}`)
    this.name = 'DuplicateAnalyzerError'
    this.analyzerId = analyzerId
  }
}

export interface AnalyzerRegistry {
  register(analyzer: Analyzer): () => void
  get(id: string): Analyzer | undefined
  /** 取不到就退回缺省 —— 一个字段声明了没人认识的分析器,不该让整次搜索塌掉 */
  resolve(id: string | undefined): Analyzer
  list(): Analyzer[]
  readonly fallback: Analyzer
}

export function createAnalyzerRegistry(options: { fallback?: Analyzer } = {}): AnalyzerRegistry {
  const fallback = options.fallback ?? compositeAnalyzer
  const map = new Map<string, Analyzer>()

  return {
    fallback,
    register(analyzer) {
      if (map.has(analyzer.id)) throw new DuplicateAnalyzerError(analyzer.id)
      map.set(analyzer.id, analyzer)
      return () => {
        if (map.get(analyzer.id) === analyzer) map.delete(analyzer.id)
      }
    },
    get: id => map.get(id),
    resolve: id => (id === undefined ? fallback : map.get(id) ?? fallback),
    list: () => [...map.values()],
  }
}

/** core 自带的三个。能力可以再注册自己的,这里不是白名单。 */
export function createDefaultAnalyzerRegistry(): AnalyzerRegistry {
  const registry = createAnalyzerRegistry()
  registry.register(cjkBigramAnalyzer)
  registry.register(latinWordAnalyzer)
  registry.register(compositeAnalyzer)
  return registry
}
