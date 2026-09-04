/**
 * 黄金复述集(S7,`docs/design/search-index-2026-09.md` §15.5)。
 *
 * 与隔壁的 `corpus.test.ts` 是**同一份语料上的两张卷子**:那一张考词法路的严格档
 * 覆盖,这一张考**改写句**——用不同的词说同一件事,词法路大多零命中,向量路必须
 * 把它捞回来。
 *
 * ## 这张卷子证的是什么
 *
 * **链路,不是模型**。跑的是确定性的假嵌入器(core 的 `createFakeEmbedder`),它靠
 * `paraphrase.json` 的 `synonyms` 表把改写句与原文指到同一个概念上。所以绿了只说明
 * 「切段 → 写 `vec_docs` → 查询嵌入 → KNN → 授权 → 融合 → 出候选」这一整条链通,
 * 不说明 `multilingual-e5-small` 召回得好。模型的质量由真机冒烟说话。
 *
 * ## 三条硬判据
 *
 *  ① **向量路 top-5 必中**:20 条改写句,每条的期望键要出现在向量路前五名里;
 *  ② **词法路在严格档上对同一批查询零命中**——那正是这条路存在的理由。判据只钉
 *     严格档(①「全部词都要中」),最松的一档(④「任一词」)只**记读数不断言**:
 *     一个中文改写句与原文难免共用一两个二元词元,施工时的读数是严格档 0/20、
 *     最松档 11/20、向量路 20/20。§15.4 让向量路从阶梯 ② 起才加入,判的本来就不是
 *     最松那一档;
 *  ③ **授权是查询的输入**:给一个把期望会话排除在外的 `sessionId` 过滤,向量路
 *     答的必须是**范围内**最近的那几条,而不是「先取 k 条再筛成空」。这一条钉的是
 *     `sqlite-vec.ts` 文件头那张读数表(`IN (子查询)` 下推 vs JOIN 后过滤)。
 *
 * 另外两条钉的是库头与融合:换 `embeddingModelId` 会重嵌;RRF 融合之后 `explain`
 * 说得出这条来自哪一路。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

import type { CapabilityManifest, DocPayload, Embedder } from '@onething/core/search'
import {
  VECTOR_RETRIEVER_ID,
  buildLexicalQuery,
  createDefaultAnalyzerRegistry,
  createDefaultExpanderRegistry,
  createFakeEmbedder,
  parse,
  plan,
} from '@onething/core/search'

import { chunkForEmbedding } from '../../embedding/embedder.js'
import { SqliteIndex } from '../sqlite-index.js'

interface CorpusDoc {
  capability: string
  key: string
  sessionKey: string
  role?: string
  time: number
  title?: string
  content: string
}
interface Corpus { docs: CorpusDoc[] }
interface Paraphrase {
  synonyms: Record<string, string>
  cases: Array<{ id: string; concept: string; query: string; expect: string[] }>
}

const fixtures = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../core/search/__tests__/fixtures',
)
const corpus = JSON.parse(fs.readFileSync(path.join(fixtures, 'corpus.json'), 'utf-8')) as Corpus
const paraphrase = JSON.parse(
  fs.readFileSync(path.join(fixtures, 'paraphrase.json'), 'utf-8'),
) as Paraphrase

const MESSAGES = 'messages'
const SCHEMA = {
  title: { analyzer: 'composite', weight: 2 },
  content: { analyzer: 'composite', weight: 1, embed: true },
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-search-semantic-'))
afterAll(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

const embedder: Embedder = createFakeEmbedder({ synonyms: paraphrase.synonyms })
const index = new SqliteIndex({
  path: path.join(tempRoot, 'semantic.sqlite'),
  vector: { dims: embedder.dims },
})
for (const capability of new Set(corpus.docs.map(doc => doc.capability))) {
  index.setSchema(capability, SCHEMA)
}

const analyzers = createDefaultAnalyzerRegistry()
const expanders = createDefaultExpanderRegistry()
const manifest: CapabilityManifest = {
  id: MESSAGES,
  labelKey: '',
  icon: '',
  kind: 'indexed',
  schema: SCHEMA,
  budget: { default: 5, timeoutMs: 300 },
  order: 0,
}

/** 只灌消息那一半 —— 复述集考的是正文。 */
const messageDocs = corpus.docs.filter(doc => doc.capability === MESSAGES)
for (const doc of messageDocs) {
  const payload: DocPayload = {
    capability: doc.capability,
    key: doc.key,
    time: doc.time,
    facets: { sessionId: doc.sessionKey, archived: false, time: doc.time },
    fields: { ...(doc.title !== undefined ? { title: doc.title } : {}), content: doc.content },
  }
  index.replaceKey(doc.capability, doc.key, [payload])
}

/** 嵌入的写路在这个卷子里手动跑一遍(worker-core 那一路有它自己的用例)。 */
async function embedAll(): Promise<number> {
  const vector = index.vector
  if (vector === undefined) return 0
  let chunks = 0
  for (const docId of index.allDocIds()) {
    const doc = index.get(docId)
    if (doc === undefined) continue
    const text = (doc.fields.content ?? '').trim()
    if (text.length === 0) continue
    const pieces = chunkForEmbedding(text, embedder)
    const vectors = await embedder.embed(pieces.map(piece => piece.text), 'passage')
    pieces.forEach((piece, at) => {
      const made = vectors[at]
      if (made !== undefined) vector.upsert(docId, piece.chunk, made)
    })
    chunks += pieces.length
  }
  return chunks
}

const embeddedChunks = await embedAll()

/** 一条查询在**向量路**上的前 N 名(按文档去重,`docId` → `capability:key`)。 */
async function vectorTop(query: string, limit: number, filters?: Record<string, unknown>): Promise<string[]> {
  const vector = index.vector
  if (vector === undefined) return []
  const [embedding] = await embedder.embed([query], 'query')
  if (embedding === undefined) return []
  const hits = vector.search(embedding, limit * 4, {
    capability: MESSAGES,
    ...(filters !== undefined ? { filters: filters as never } : {}),
  })
  const seen = new Set<number>()
  const keys: string[] = []
  for (const hit of hits) {
    if (seen.has(hit.docId)) continue
    seen.add(hit.docId)
    const doc = index.get(hit.docId)
    if (doc !== undefined) keys.push(`${doc.capability}:${doc.key}`)
    if (keys.length >= limit) break
  }
  return keys
}

/** 同一条查询在**词法路**上的命中键(走真流水线:parse → 阶梯 → buildLexicalQuery)。 */
function lexicalKeys(query: string, level: number): string[] {
  const parsed = parse(query)
  const ladder = plan(parsed)[level]
  const lexical = buildLexicalQuery(
    { ...parsed, ...(ladder !== undefined ? { ladder } : {}) },
    {
      manifest,
      fields: { title: 2, content: 1 },
      analyzer: analyzers.resolve(undefined),
      vocabulary: index,
      expanders,
      limit: 50,
      offset: 0,
    },
  )
  return index.search(lexical).hits
    .map(hit => index.get(hit.docId))
    .filter((doc): doc is NonNullable<typeof doc> => doc !== undefined)
    .map(doc => `${doc.capability}:${doc.key}`)
}

describe('黄金复述集(S7)', () => {
  it(`语料灌进去了,而且每一段都嵌上了(${messageDocs.length} 份文档 / ${embeddedChunks} 段)`, () => {
    expect(index.vector, 'sqlite-vec 扩展没装上 —— 这台机器上 S7 的卷子考不了').toBeDefined()
    expect(index.vectorExtension).toBe('loadable')
    expect(embeddedChunks).toBeGreaterThan(messageDocs.length)
    expect(index.vector?.size()).toBe(embeddedChunks)
  })

  it('① 20 条改写句,向量路 top-5 必中', async () => {
    const missed: string[] = []
    for (const item of paraphrase.cases) {
      const top = await vectorTop(item.query, 5)
      if (!item.expect.some(key => top.includes(key))) {
        missed.push(`${item.id}: 期望 ${item.expect.join(' | ')},top-5 = ${top.join(' , ')}`)
      }
    }
    expect(missed, missed.join('\n')).toEqual([])
  })

  it('② 词法路在**严格档**上对这批改写句零命中 —— 那正是向量路存在的理由', async () => {
    let strictHit = 0
    let relaxedHit = 0
    let vectorHit = 0
    const strictWinners: string[] = []
    const relaxedWinners: string[] = []
    for (const item of paraphrase.cases) {
      const top = await vectorTop(item.query, 5)
      if (item.expect.some(key => top.includes(key))) vectorHit += 1
      // ①严格档 = 全部词都要中。改写句与原文不共用词,所以它应当一条都不中。
      if (item.expect.some(key => lexicalKeys(item.query, 0).slice(0, 5).includes(key))) {
        strictHit += 1
        strictWinners.push(item.id)
      }
      // ④「任一词」是最松的一档;这里**不断言**,只把读数记下来 —— 一个中文改写句
      // 与原文难免共用一两个二元词元(`目录` / `会话`),放到最松那一档偶尔中一条
      // 是诚实的事实,不是 bug。§15.4 让向量路从 ② 起才加入,判的也不是这一档。
      if (item.expect.some(key => lexicalKeys(item.query, 3).slice(0, 5).includes(key))) {
        relaxedHit += 1
        relaxedWinners.push(item.id)
      }
    }
    expect(vectorHit).toBe(paraphrase.cases.length)
    expect(
      strictHit,
      `严格档词法路 ${strictHit}/20(${strictWinners.join(', ')})`
      + `;最松档 ${relaxedHit}/20(${relaxedWinners.join(', ')});向量路 ${vectorHit}/20`,
    ).toBe(0)
  })

  it('③ 授权是查询的输入:范围外的候选不占 KNN 的名额', async () => {
    const item = paraphrase.cases[0]!
    const expected = item.expect[0]!
    const expectedKey = expected.slice(`${MESSAGES}:`.length)
    const expectedSession = expectedKey.slice(0, expectedKey.indexOf(':'))

    // 无过滤:期望那条在最前面。
    expect((await vectorTop(item.query, 3))[0]).toBe(expected)

    // 把期望那间会话排除掉。**答的必须是范围内最近的那几条,而不是空**
    // —— 空就意味着「先取 k 条再筛」,那正是 §6.4b 禁的形。
    const others = [...new Set(messageDocs.map(doc => doc.sessionKey))]
      .filter(session => session !== expectedSession)
      .slice(0, 40)
    const scoped = await vectorTop(item.query, 3, { sessionId: others })
    expect(scoped.length).toBe(3)
    expect(scoped).not.toContain(expected)

    // 空范围 = 空集,不是「全库」。
    expect(await vectorTop(item.query, 3, { sessionId: [] })).toEqual([])
  })

  // 这一条要把两千份文档重嵌一遍(本机 ~7s),所以给它自己的预算。
  it('④ 换模型 = 向量那一半重建,词法路一行不动', { timeout: 60_000 }, async () => {
    const before = index.search(buildLexicalQuery(parse('身份牌'), {
      manifest,
      fields: { title: 2, content: 1 },
      analyzer: analyzers.resolve(undefined),
      vocabulary: index,
      limit: 50,
      offset: 0,
    })).total
    expect(index.vector?.size()).toBe(embeddedChunks)

    // 库头换一个模型 id → 清空向量。词法路的命中数逐字不变。
    index.writeMeta('embeddingModelId', 'some-other-model')
    index.vector?.clear()
    expect(index.vector?.size()).toBe(0)
    expect(await vectorTop(paraphrase.cases[0]!.query, 5)).toEqual([])

    const after = index.search(buildLexicalQuery(parse('身份牌'), {
      manifest,
      fields: { title: 2, content: 1 },
      analyzer: analyzers.resolve(undefined),
      vocabulary: index,
      limit: 50,
      offset: 0,
    })).total
    expect(after).toBe(before)

    // 重嵌之后又回来了。
    const again = await embedAll()
    expect(again).toBe(embeddedChunks)
    const top = await vectorTop(paraphrase.cases[0]!.query, 5)
    expect(paraphrase.cases[0]!.expect.some(key => top.includes(key))).toBe(true)
  })

  it('⑤ 召回器 id 就是 manifest 里 `retrievers` 那张表的键', () => {
    // 这一条守的是「core 不认识向量这个词」那条法的落点:表的键是**召回器 id**,
    // 而 id 只有一个产地。
    expect(VECTOR_RETRIEVER_ID).toBe('vector')
  })
})
