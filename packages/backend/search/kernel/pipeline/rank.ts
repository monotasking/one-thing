/**
 * rank:组内排序。
 *
 * 设计:docs/design/search-index-2026-09.md §6.5(v3.1)
 *
 * **分数怎么算是能力的事,不是流水线的事。** v3 曾把「用户消息 ×1.1、标题命中置顶、
 * 30 天半衰」写在这一段 —— 那是某一类结果的语义混进了 core。这里只剩一件事:
 * 按能力给的 `score` 排,同分按时间倒序,再同分按 id 升序。
 *
 * 最后那一档不是洁癖:cursor 是 `{queryHash, offset}`,排序不确定就等于翻页错位。
 */

import type { Candidate, SearchContext } from '../candidate.js'

/** 排序信号(点击回流之类)的提供者。缺省空 —— 没有信号就没有个性化。 */
export interface RankingSignals {
  /** 返回乘数;1 = 不动 */
  weightOf(candidate: Candidate): number
}

export const emptyRankingSignals: RankingSignals = { weightOf: () => 1 }

export interface Ranker {
  readonly id: string
  rank(items: readonly Candidate[], ctx: SearchContext, signals: RankingSignals): Candidate[]
}

export const defaultRanker: Ranker = {
  id: 'score-desc',
  rank(items, _ctx, signals) {
    const weighted = items.map(candidate => ({
      candidate,
      score: candidate.score * signals.weightOf(candidate),
    }))
    weighted.sort((a, b) =>
      (b.score - a.score)
      || ((b.candidate.time ?? 0) - (a.candidate.time ?? 0))
      || (a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0))
    return weighted.map(entry =>
      entry.score === entry.candidate.score
        ? entry.candidate
        : { ...entry.candidate, score: entry.score })
  },
}
