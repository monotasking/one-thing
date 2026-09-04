/**
 * **严格档命中集的快照**(检索重建 S5,`docs/design/search-index-2026-09.md` §10 S5 行)。
 *
 * ## 它接的是谁的班
 *
 * S5 之前有两道对账门:
 *
 *  - `search:parity-A`(S2)—— 新路与**旧扫描路**的 `results` 逐字节相同;
 *  - `search:parity-B`(S3c)—— 索引严格档的命中集 **⊇** 旧扫描路的命中集。
 *
 * 两道门的参照物都是那条旧扫描路。S5 把它删了,参照物也就没了 —— 一道拿不到参照物
 * 的门不是「还能跑的门」,是一句谎。所以它们退役,守过的东西换成**这份快照**:
 * 把 S0 那份冻在仓里的真语料灌进 `SqliteIndex`,把 20 条黄金查询 + 20 条黄金复述句
 * 在**严格档**(阶梯 ①:全 AND + 短语相邻)下的命中集录成 JSON。命中集变了就红。
 *
 * ## 判据为什么是「集合」而不是「次序」
 *
 * 快照里的 `keys` 是**排过序的集合**,不是排名。这跟 parity-B 的口径一致(它判的是
 * ⊇,不是逐字):改字段权重只动次序、不动召回,那不该让一道回归网变红;而**召回**
 * 变了(多了一条、少了一条)一定是一件要解释的事。`total` 单独记一格,因为它是
 * 契约上会被壳读出来的那个数。
 *
 * ## 复述集为什么也在这里
 *
 * `paraphrase.json` 是 S7 给**向量路**出的卷子,改写句与原文尽量不共用词面 —— 所以
 * 它们在词法严格档下**大多零命中**,那正是向量路存在的理由。把这 20 条的词法读数
 * 也钉住,是为了让「向量路捞回来的到底是不是词法捞不到的」这句话有底片:哪天某条
 * 复述句在词法路上开始命中了,这道门先红,而不是等向量那边的读数悄悄变好看。
 *
 * ## 更新这份快照
 *
 *   ONETHING_SEARCH_GOLDEN_UPDATE=1 bunx vitest run packages/onething-runtime/src/search
 *
 * 但**改它要在报告里写明理由**:它变了 = 「同一句话能搜到什么」变了。
 *
 * ## 不经账本
 *
 * 直接 `replaceKey` 灌 —— 这一条量的是「索引 + 查询流水线」这一段,投影那一路有它
 * 自己的用例(`search/index/__tests__/projector.test.ts` / `worker-core.test.ts`)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

import type { CapabilityManifest, DocPayload, LexicalQuery } from '@onething/core/search'
import {
  buildLexicalQuery,
  createDefaultAnalyzerRegistry,
  createDefaultExpanderRegistry,
  parse,
  plan,
} from '@onething/core/search'

import { SqliteIndex } from '../index/sqlite-index.js'

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
interface Golden { queries: Array<{ query: string; expectKeys: string[] }> }
interface Paraphrase { cases: Array<{ id: string; query: string; expect: string[] }> }
/** 一条查询的读数:命中总数 + 命中的文档键(排过序,与名次无关)。 */
interface HitSet { total: number; keys: string[] }

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, '../../../../core/search/__tests__/fixtures')
const snapshotPath = path.join(here, '__fixtures__/golden-hit-sets.json')

const corpus = JSON.parse(fs.readFileSync(path.join(fixtures, 'corpus.json'), 'utf-8')) as Corpus
const golden = JSON.parse(fs.readFileSync(path.join(fixtures, 'golden-queries.json'), 'utf-8')) as Golden
const paraphrase = JSON.parse(fs.readFileSync(path.join(fixtures, 'paraphrase.json'), 'utf-8')) as Paraphrase

/** 语料里两类文档(消息 / 会话标题)共用一张 schema —— 与 `corpus.test.ts` 逐字同。 */
const SCHEMA = {
  title: { analyzer: 'composite', weight: 2 },
  content: { analyzer: 'composite', weight: 1 },
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-search-golden-'))
afterAll(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

const index = new SqliteIndex({ path: path.join(tempRoot, 'golden.sqlite') })
for (const capability of new Set(corpus.docs.map(doc => doc.capability))) {
  index.setSchema(capability, SCHEMA)
}
for (const doc of corpus.docs) {
  const payload: DocPayload = {
    capability: doc.capability,
    key: doc.key,
    time: doc.time,
    facets: {
      sessionId: doc.sessionKey,
      ...(doc.role !== undefined ? { role: doc.role } : {}),
      archived: false,
      time: doc.time,
    },
    fields: {
      ...(doc.title !== undefined ? { title: doc.title } : {}),
      content: doc.content,
    },
  }
  index.replaceKey(doc.capability, doc.key, [payload])
}

const analyzers = createDefaultAnalyzerRegistry()
const expanders = createDefaultExpanderRegistry()

const manifest: CapabilityManifest = {
  id: 'corpus',
  labelKey: '',
  icon: '',
  kind: 'indexed',
  budget: { default: 50, timeoutMs: 0 },
  order: 0,
  schema: SCHEMA,
}

/** 严格档(阶梯 ①:全 AND + 短语相邻)。级由 `plan` 给,不在这里手拼。 */
function strictQuery(raw: string, limit = 2000): LexicalQuery {
  const parsed = parse(raw)
  const step = plan(parsed)[0]!
  const lexical = buildLexicalQuery({ ...parsed, ladder: step }, {
    manifest,
    fields: { title: 2, content: 1 },
    analyzer: analyzers.resolve(undefined),
    vocabulary: index,
    expanders,
    limit,
    offset: 0,
  })
  return { ...lexical, capability: undefined }
}

function hitSetOf(raw: string): HitSet {
  const answer = index.search(strictQuery(raw))
  const keys = answer.hits
    .map(hit => index.get(hit.docId)?.key)
    .filter((key): key is string => key !== undefined)
  return { total: answer.total, keys: [...keys].sort() }
}

const recorded: Record<string, HitSet> = {}
for (const entry of golden.queries) recorded[`golden:${entry.query}`] = hitSetOf(entry.query)
for (const entry of paraphrase.cases) recorded[`paraphrase:${entry.id}`] = hitSetOf(entry.query)

if (process.env.ONETHING_SEARCH_GOLDEN_UPDATE === '1') {
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true })
  fs.writeFileSync(snapshotPath, `${JSON.stringify({
    note: '检索重建 S5 录制:S0 语料灌进 SqliteIndex 后,黄金查询 20 条 + 黄金复述句 20 条'
      + '在严格档(阶梯 ①)下的命中集。keys 排过序 = 判召回不判名次。'
      + '重录:ONETHING_SEARCH_GOLDEN_UPDATE=1,并在报告里写明为什么。',
    docs: corpus.docs.length,
    cases: recorded,
  }, null, 2)}\n`)
}

const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8')) as {
  docs: number
  cases: Record<string, HitSet>
}

describe('严格档命中集快照(S5 接 parity-A / parity-B 的班)', () => {
  it('语料灌得进去,而且份数与快照录制时一致', () => {
    expect(index.size()).toBe(corpus.docs.length)
    expect(snapshot.docs).toBe(corpus.docs.length)
  })

  it('卷子没有被悄悄改小:20 条黄金查询 + 20 条复述句', () => {
    expect(golden.queries.length).toBe(20)
    expect(paraphrase.cases.length).toBe(20)
    expect(Object.keys(snapshot.cases).length).toBe(40)
  })

  it('每一条的命中集与快照逐字同(改一个键就红)', () => {
    expect(recorded).toEqual(snapshot.cases)
  })

  /**
   * 快照本身可能被录错,所以再问一句**独立于快照**的话:黄金表自己声明的期望键,
   * 严格档下只许差那两条已经逐条解释过的(`corpus.test.ts` 里那段说明:
   * `elcc_holiday_tranfer` 是整词不在文档里、`ＦＡＣ 888` 是中段子串)。
   */
  it('黄金表的期望键,严格档下只差那两条已知的子串语义例外', () => {
    const misses: string[] = []
    for (const entry of golden.queries) {
      const hits = new Set(recorded[`golden:${entry.query}`]!.keys)
      for (const key of entry.expectKeys) {
        if (!hits.has(key)) misses.push(`${entry.query} → 缺 ${key}`)
      }
    }
    expect(misses.sort()).toEqual([
      'elcc_holiday_tranfer → 缺 caecca753d58:7c1e015e5689',
      'ＦＡＣ 888 → 缺 b1e4aa574e87:dbad5b5c5dec',
    ].sort())
  })
})
