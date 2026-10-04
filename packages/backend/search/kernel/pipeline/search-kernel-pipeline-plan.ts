/**
 * plan:放宽阶梯。
 *
 * 设计:docs/design/search-index-2026-09.md §6.2
 *
 * `①严格(AND + 短语相邻)→ ②去相邻约束 → ③AND→「至少命中一半的词」→ ④单词`。
 * **plan 只产出阶梯,不执行** —— 执行是 fanout 的事,而且是**对每个能力各自**逐级试:
 * messages 放宽到 ③ 不影响 sessions 停在 ①。壳照 `relaxed` 写「已放宽:按任一词匹配」,
 * 不静默放宽。
 *
 * **一个查询词摊成多词元时算几个词**(S3b 第二轮修):`minShouldMatch` 数的一直是
 * **AST 里的词**(`2026-09-05` 是一个词),而分析器把它切成 `2026` `09` `05` 三个
 * 词元 —— 从前的翻译把三个词元当三个独立词、再取 `min(1, 3) = 1`,于是「①严格 =
 * 全 AND」在这一形上实际是 OR(`2026-09-06` 也被召回)。治法是给每一级多说一句话:
 * ①② 把这样一个词当**一条相邻短语 / 一组必须同在的词元**(`multiTokenTerms:
 * 'phrase'`),③④ 才摊平(`'split'`),让「至少一半」「任一词」名副其实。
 */

import type { LadderStep, SearchQuery } from '../candidate.js'
import { collectQueryTerms } from './parse.js'

// LadderStep 住在 candidate.ts(它要挂到 SearchQuery 上,放这里会成环)。
export type { LadderStep }

export interface PlanOptions {
  /** 能力自报 relax:false 时只跑第一级(§6.2 末句) */
  relax?: boolean
}

export function plan(query: SearchQuery, options: PlanOptions = {}): LadderStep[] {
  const { terms } = collectQueryTerms(query.ast)
  const count = terms.length
  const strict: LadderStep = {
    level: 0,
    minShouldMatch: count,
    phraseAdjacent: true,
    multiTokenTerms: 'phrase',
  }
  if (options.relax === false) return [strict]

  const half = Math.max(1, Math.ceil(count / 2))
  const ladder: LadderStep[] = [
    strict,
    // ②只去相邻,词还是词:`2026-09-05` 仍要求三个词元同在一个字段里(不要求顺序)。
    { level: 1, minShouldMatch: count, phraseAdjacent: false, multiTokenTerms: 'phrase' },
    // ③④才把词摊开 —— 「至少一半的词」「任一词」这两句话到这里才数得着词元。
    { level: 2, minShouldMatch: half, phraseAdjacent: false, multiTokenTerms: 'split' },
    { level: 3, minShouldMatch: Math.min(1, count), phraseAdjacent: false, multiTokenTerms: 'split' },
  ]

  // 一个词的查询,②③④ 与 ① 只差短语相邻那一档;级数照留(壳要如实说放宽到哪一级),
  // 但相同的级不重复跑 —— 由 fanout 的「有结果即停」自然收敛。
  return ladder
}
