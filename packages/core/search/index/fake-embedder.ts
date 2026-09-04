/**
 * `createFakeEmbedder` —— **确定性的假嵌入器**,与 `MemoryIndex` / `MemoryVectorIndex`
 * 同一种身份:单测与门的替身,零依赖、零 IO。
 *
 * 设计:docs/design/search-index-2026-09.md §15.5(门那一节)
 *
 * ## 它证的是链路,不是模型
 *
 * 真模型 110MB、冷嵌几分钟,门里跑它就等于把「网络通不通」混进检索的读数里。所以
 * 门跑这一只:同一份文本永远得到同一个向量,微秒级。**它能证**「切段 → 写向量索引
 * → 查询嵌入 → KNN → RRF 融合 → 出候选」这一整条链通、授权在 KNN 里就生效、换
 * `embeddingModelId` 会重嵌;**它证不了**模型本身的召回质量 —— 那由真机冒烟说话。
 *
 * ## 它怎么造一个「懂同义」的向量
 *
 * 两层相加再归一化:
 *
 *  ① **概念层**(权重 1):一张 `短语 → 概念` 的人工映射表。文本里出现了某个短语,
 *     就把那个概念的基向量加进来;基向量由概念名的哈希确定性生成 —— 384 维空间里
 *     两个随机单位向量近乎正交,于是「同一个概念」的两段文本方向几乎重合、「不同
 *     概念」的几乎垂直。**改写句与原文用不同的词说同一件事**,靠的就是这张表把两边
 *     指到同一个概念上。
 *  ② **词面层**(权重 0.15):词元哈希成基向量相加。它让「一个概念都没命中」的两段
 *     文本仍然彼此不同(否则全库塌成同一个向量)。权重刻意压得低 —— 概念一致必须
 *     压倒词面一致,否则这只假嵌入器就退化成了另一条词法路,那样它什么都证不了。
 *
 * **映射表不住这个文件**:它是数据,由调用方递进来(黄金复述集
 * `__tests__/fixtures/paraphrase.json` 的 `synonyms` 段就是它)。一份数据,几个读者。
 */

import type { EmbedKind, Embedder } from './types.js'

/** 与 `multilingual-e5-small` 同维 —— 换模型的反证不该被维度差掩盖。 */
export const FAKE_EMBEDDER_DIMS = 384

/** 词面层相对概念层的权重。见文件头 ②。 */
const LEXICAL_WEIGHT = 0.15

export interface FakeEmbedderOptions {
  /** `短语 → 概念名`;缺省空表 = 只有词面层(仍然确定性,只是不懂同义)。 */
  synonyms?: Readonly<Record<string, string>>
  dims?: number
  id?: string
  /** 假嵌入器的一个 token = 一个字符,所以这就是字数上限。 */
  maxTokens?: number
}

export function createFakeEmbedder(options: FakeEmbedderOptions = {}): Embedder {
  const dims = options.dims ?? FAKE_EMBEDDER_DIMS
  const synonyms = options.synonyms ?? {}
  // 长短语优先:`身份牌` 与 `身份` 都在表里时先认长的那个。
  const phrases = Object.keys(synonyms).sort((a, b) => b.length - a.length)
  const basis = new Map<string, Float32Array>()
  const basisOf = (name: string): Float32Array => {
    const cached = basis.get(name)
    if (cached !== undefined) return cached
    const made = deterministicUnitVector(name, dims)
    basis.set(name, made)
    return made
  }

  return {
    id: options.id ?? 'fake',
    dims,
    maxTokens: options.maxTokens ?? 400,
    countTokens: text => text.length,
    async ready() { /* 假的没有模型可装 */ },
    async embed(texts: readonly string[], _kind: EmbedKind) {
      return texts.map(text => {
        const lower = text.toLowerCase()
        const concepts = new Float32Array(dims)
        let conceptCount = 0
        for (const phrase of phrases) {
          if (!lower.includes(phrase)) continue
          add(concepts, basisOf(`concept:${synonyms[phrase]!}`))
          conceptCount += 1
        }
        const lexical = new Float32Array(dims)
        for (const token of fakeTokenize(lower)) add(lexical, basisOf(`token:${token}`))

        const out = new Float32Array(dims)
        if (conceptCount > 0) add(out, normalizeVector(concepts))
        addScaled(out, normalizeVector(lexical), LEXICAL_WEIGHT)
        return normalizeVector(out)
      })
    },
  }
}

/** L2 归一化。向量索引存单位向量,于是 L2 距离与余弦是同一个序。 */
export function normalizeVector(values: Float32Array): Float32Array {
  let sum = 0
  for (const value of values) sum += value * value
  const norm = Math.sqrt(sum)
  if (norm === 0) return values
  const out = new Float32Array(values.length)
  for (let i = 0; i < values.length; i += 1) out[i] = (values[i] ?? 0) / norm
  return out
}

/** latin 按非字母数字切,CJK 按二元 —— 粗粒度即可,不求与产品分析器逐字一致。 */
function fakeTokenize(lower: string): string[] {
  const out: string[] = []
  for (const run of lower.split(/[^\p{L}\p{N}]+/u)) {
    if (run.length === 0) continue
    if (/[㐀-鿿぀-ヿ가-힯]/.test(run)) {
      if (run.length === 1) out.push(run)
      for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2))
      continue
    }
    out.push(run)
  }
  return out
}

function add(target: Float32Array, source: Float32Array): void {
  for (let i = 0; i < target.length; i += 1) target[i] = (target[i] ?? 0) + (source[i] ?? 0)
}

function addScaled(target: Float32Array, source: Float32Array, factor: number): void {
  for (let i = 0; i < target.length; i += 1) target[i] = (target[i] ?? 0) + (source[i] ?? 0) * factor
}

/**
 * 名字 → 一个确定性的单位向量。xorshift32,种子取名字的 FNV-1a 哈希。要的只是
 * 「同名同向量、异名近乎正交」,不需要密码学质量。
 */
function deterministicUnitVector(name: string, dims: number): Float32Array {
  let state = 2166136261 >>> 0
  for (let i = 0; i < name.length; i += 1) {
    state ^= name.charCodeAt(i)
    state = Math.imul(state, 16777619) >>> 0
  }
  if (state === 0) state = 1
  const out = new Float32Array(dims)
  for (let i = 0; i < dims; i += 1) {
    state ^= state << 13; state >>>= 0
    state ^= state >>> 17
    state ^= state << 5; state >>>= 0
    out[i] = (state / 0xffffffff) * 2 - 1
  }
  return normalizeVector(out)
}
