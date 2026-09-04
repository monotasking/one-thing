/**
 * 嵌入器这一侧的产品件:切段 + 归一化。**接口本身住 core**
 * (`packages/core/search/index/types.ts` 的 `Embedder`),因为向量召回器要认它。
 *
 * 设计:docs/design/search-index-2026-09.md §15.3
 *
 * 这个文件里没有任何模型的名字、没有任何能力的名字。它只回答一句话:
 * **一段正文怎么切成几段送进模型**。
 */

import { normalizeVector } from '@onething/core/search'
import type { Embedder, EmbedKind } from '@onething/core/search'

export type { Embedder, EmbedKind }
export { normalizeVector }

/** 一段。`chunk` 是序号,`(docId, chunk)` 在向量索引里是一行。 */
export interface EmbeddingChunk {
  chunk: number
  text: string
}

/**
 * 按嵌入器自己的分词器切段(§15.3「单文档超 512 token 切段」)。
 *
 * **判据是嵌入器答的 token 数,不是字数** —— 中文一个字常常就是一个 token,英文
 * 一个词可能是半个,拿字数当判据在中英混排的真库上必错一边。假嵌入器把
 * `countTokens` 实现成「字数」,于是它也用同一条切法、同一个函数,只是尺子不同。
 *
 * 切点用**换行 / 句号 / 空格**的最后一个落点回退,尽量不把一句话劈成两半;找不到
 * 就硬切(一个没有分隔符的 5 万字串是存在的,不许在这里死循环)。
 */
export function chunkForEmbedding(text: string, embedder: Embedder): EmbeddingChunk[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) return []
  if (embedder.countTokens(trimmed) <= embedder.maxTokens) {
    return [{ chunk: 0, text: trimmed }]
  }

  const chunks: EmbeddingChunk[] = []
  let rest = trimmed
  let index = 0
  while (rest.length > 0 && chunks.length < MAX_CHUNKS_PER_DOC) {
    const take = fitPrefix(rest, embedder)
    chunks.push({ chunk: index, text: rest.slice(0, take).trim() })
    rest = rest.slice(take).trim()
    index += 1
  }
  return chunks.filter(entry => entry.text.length > 0)
}

/**
 * 一份文档最多切几段。**这是一道刹车,不是一个语义** —— 真库最长的一条 31 万字
 * (§5.5),按 512 token 切就是几百段、几百次前向;而分析器那一侧本来就只索引前
 * 200k 字。超出的部分不嵌,与词法路的 `truncated` 是同一种诚实。
 */
export const MAX_CHUNKS_PER_DOC = 64

/**
 * 从头取一段「刚好装得下」的前缀,返回该切在第几个字符。
 *
 * 先按 token 数与字符数的比值猜一刀,再二分收敛 —— `countTokens` 在真模型上要跑
 * 分词器,不能一个字一个字试。
 */
function fitPrefix(text: string, embedder: Embedder): number {
  const budget = embedder.maxTokens
  const total = embedder.countTokens(text)
  if (total <= budget) return text.length

  let low = 1
  let high = text.length
  // 第一刀按比例猜,通常一两轮就收敛。
  let guess = Math.max(1, Math.floor(text.length * (budget / total)))
  for (let i = 0; i < 24 && low < high; i += 1) {
    const fits = embedder.countTokens(text.slice(0, guess)) <= budget
    if (fits) low = guess
    else high = guess - 1
    if (low >= high) break
    guess = Math.floor((low + high + 1) / 2)
  }
  const at = Math.max(1, low)
  return backOffToBoundary(text, at)
}

/** 往回找最近的换行 / 句末 / 空格;回退超过一成就算了,硬切。 */
function backOffToBoundary(text: string, at: number): number {
  const floor = Math.floor(at * 0.9)
  for (let i = at; i > floor; i -= 1) {
    const ch = text[i - 1]
    if (ch === undefined) continue
    if (ch === '\n' || ch === '。' || ch === '.' || ch === '!' || ch === '?' || ch === ' ') return i
  }
  return at
}
