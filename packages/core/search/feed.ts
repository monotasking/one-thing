/**
 * 喂索引的来源(`DocumentFeed`)与索引前的横切面(`DocumentFilter`)。
 *
 * 设计:docs/design/search-index-2026-09.md §5.1 / §5.2b / §5.2c
 *
 * 索引服务不直接认识账本:它收一组 feed,账本只是第一个。加一种来源 = 加一个
 * feed,索引服务与倒排一字不改。**这里只有形,实现在 runtime。**
 */

import type { FacetValue } from './candidate.js'

/**
 * 一份文档。§5.1 的 `Doc` 去掉 `docId` —— docId 是索引内部的递增号,由索引分配,
 * feed 说不出来。`capability` 是产它的能力 id(v3.1 把这里的字面量联合删了)。
 */
export interface DocPayload {
  capability: string
  /** 能力内唯一的一把钥匙;整键替换的粒度就是它 */
  key: string
  time: number
  /** 键由 manifest.facets 声明;core 不解释,只按键过滤 */
  facets: Record<string, FacetValue>
  /** 键由 manifest.schema 声明;值是脱敏后的原文 */
  fields: Record<string, string>
  /** 关系边;rel 的名字 core 不认识,只存与 join */
  relations?: Array<{ rel: string; to: string }>
}

export interface DocumentFeed<TKey = string> {
  readonly id: string
  /** 它替哪几个能力产文档(能力 id) */
  readonly capabilities: string[]
  /** 有变化就喊一声(不带内容);返回退订 */
  subscribe(onChange: (key: TKey, hint?: unknown) => void): () => void
  /** 变没变;undefined = 已不存在(墓碑) */
  fingerprint(key: TKey): string | undefined | Promise<string | undefined>
  /** 这一把钥匙下的全部文档(整键替换,幂等) */
  documentsOf(key: TKey): AsyncIterable<DocPayload>
  /** 全量重建 / 启动校对时枚举 */
  keys(): AsyncIterable<TKey>
  policy?: FeedPolicy
}

export interface FeedPolicy {
  build: 'eager' | 'lazy' | 'on-demand'
  priority?: number
}

export interface DocumentFilterContext {
  feedId: string
  key: string
}

/** 返回 null = 这份文档不索引。 */
export type DocumentFilter = (doc: DocPayload, ctx: DocumentFilterContext) => DocPayload | null

/**
 * 按注册序串行,任一返回 null 即止。纯函数:同一串 filter 同一份文档永远同一个答案,
 * 所以「排除清单」与「脱敏」谁先谁后是注册顺序说了算,不是运气。
 */
export function composeDocumentFilters(filters: readonly DocumentFilter[]): DocumentFilter {
  return (doc, ctx) => {
    let current: DocPayload | null = doc
    for (const filter of filters) {
      if (current === null) return null
      current = filter(current, ctx)
    }
    return current
  }
}
