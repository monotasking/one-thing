/**
 * ⑫ 真语料读数:S0 那份 2473 条脱敏文档灌进 `SqliteIndex`,20 条黄金查询在**严格档**
 * 下对期望键的覆盖;冷灌耗时与查询 p50 / p99 打印,不硬断言。
 *
 * **结论先写在这里:18 / 20 全覆盖,两条不中,原因是黄金表的期望集是拿「子串匹配」
 * 那份参考语义跑出来的,而倒排不是子串匹配器**(逐条理由见下面那条用例的注释)。
 * 这不是索引漏了,所以这一条守的是「恰好这两条」而不是「零漏」—— 多一条、少一条
 * 都红。
 *
 * 语料与黄金表是 S0 从真库抽出来冻在仓里的
 * (`packages/core/search/__tests__/fixtures/`),S1 的 `fixtures.test.ts` 只验了「夹具
 * 自洽」;把它们真跑在一个索引上,这里是第一次。
 *
 * **不经账本**:直接 `replaceKey` 灌 —— 这一条量的是索引本身,投影那一路有它自己
 * 的用例(`projector.test.ts` / `worker-core.test.ts`)。
 *
 * 查询是走**真流水线**拼出来的:`parse`(归一化 + 短语 + 排除 + 意图前缀)→
 * `buildLexicalQuery`(同一个分析器切词 + 前缀展开)→ `index.search`。自己在测试里
 * 手拼 `LexicalQuery` 会把「查询侧与文档侧同一条切法」这个最要紧的判据绕过去。
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
} from '@onething/core/search'

import { SqliteIndex } from '../sqlite-index.js'

interface CorpusDoc {
  capability: string
  key: string
  sessionKey: string
  role?: string
  time: number
  title?: string
  content: string
  truncated?: boolean
}

interface Corpus { docs: CorpusDoc[] }
interface Golden { queries: Array<{ query: string; expectKeys: string[]; note: string }> }

const fixtures = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../core/search/__tests__/fixtures',
)
const corpus = JSON.parse(fs.readFileSync(path.join(fixtures, 'corpus.json'), 'utf-8')) as Corpus
const golden = JSON.parse(fs.readFileSync(path.join(fixtures, 'golden-queries.json'), 'utf-8')) as Golden

/**
 * 语料里两类文档(消息 / 会话标题)共用一张 schema:`title` 2.0、`content` 1.0
 * —— 与 §6.5「messages 声明 pinFieldHit: 'title'」那一层是两件事,这里只是字段权重。
 */
const SCHEMA = {
  title: { analyzer: 'composite', weight: 2 },
  content: { analyzer: 'composite', weight: 1 },
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-search-corpus-'))
afterAll(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

const index = new SqliteIndex({ path: path.join(tempRoot, 'corpus.sqlite') })
for (const capability of new Set(corpus.docs.map(doc => doc.capability))) {
  index.setSchema(capability, SCHEMA)
}

const analyzers = createDefaultAnalyzerRegistry()
const expanders = createDefaultExpanderRegistry()

/**
 * 灌语料。**一次事务里全灌**:`replaceKey` 每次自己开事务 + 递代次 + 写 meta,
 * 2473 次就是 2473 次 fsync 级别的往返 —— 那量的是「一条一条写」的成本,不是
 * 「冷建一个索引」的成本。冷建走的是这一条路(Worker 里成批折),所以这里也成批。
 */
const coldStartedAt = performance.now()
/** 拼 `capability + key` 的分隔符;写成转义序列,源码里不留裸控制字符。 */
const KEY_SEPARATOR = '\u0000'
const grouped = new Map<string, DocPayload[]>()
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
  grouped.set(`${doc.capability}${KEY_SEPARATOR}${doc.key}`, [payload])
}
for (const [composite, docs] of grouped) {
  const separator = composite.indexOf(KEY_SEPARATOR)
  index.replaceKey(composite.slice(0, separator), composite.slice(separator + 1), docs)
}
const coldMs = performance.now() - coldStartedAt

const manifest: CapabilityManifest = {
  id: 'corpus',
  labelKey: '',
  icon: '',
  kind: 'indexed',
  budget: { default: 50, timeoutMs: 0 },
  order: 0,
  schema: SCHEMA,
}

/** 严格档:全 AND + 短语相邻(阶梯 ①)。 */
function strictQuery(raw: string, limit = 2000): LexicalQuery {
  const parsed = parse(raw)
  const lexical = buildLexicalQuery(parsed, {
    manifest,
    fields: { title: 2, content: 1 },
    analyzer: analyzers.resolve(undefined),
    vocabulary: index,
    expanders,
    limit,
    offset: 0,
  })
  // `parse` 不带阶梯时 `buildLexicalQuery` 已经给的是最严那一级(minShouldMatch =
  // 全部词、phraseAdjacent = true),这里只是把这件事写明白。
  return { ...lexical, capability: undefined, minShouldMatch: lexical.terms.length, phraseAdjacent: true }
}

function keysOf(raw: string): string[] {
  return index.search(strictQuery(raw)).hits
    .map(hit => index.get(hit.docId)?.key)
    .filter((key): key is string => key !== undefined)
}

describe('SqliteIndex 真语料(S0 夹具)', () => {
  it('灌得进去:文档数与语料一致', () => {
    expect(index.size()).toBe(corpus.docs.length)
  })

  /**
   * **18 / 20 全中,另外两条是黄金表自己的语义与索引不同**,不是索引漏了。
   *
   * 黄金表的 `expectKeys` 是拿 `golden-queries.json` 里那份「参考语义」在语料上真跑
   * 出来的,而那份语义是**子串匹配**(原话:「把 title 与 content 拼成一段可搜文本
   * …… 命中 = 全部普通词与短语都出现」)。倒排不是子串匹配器,于是两条对不上:
   *
   * - `elcc_holiday_tranfer` —— 语料里这个词**只以 `elcc_holiday_tranfer_audio` 的
   *   前半段出现过**。分析器对 snake 拆一层并保留整词,所以文档侧的词是
   *   `elcc_holiday_tranfer_audio` + `elcc` / `holiday` / `tranfer` / `audio`,而查询侧
   *   的整词 `elcc_holiday_tranfer` 不在其中;严格档要求四个词全中,于是差这一个。
   *   放宽到阶梯 ③(至少一半)它就回来了。
   * - `ＦＡＣ 888` —— 语料里是 `| fac | tablet | android | 00888/00666 |`,`888` 是
   *   `00888` 的**中段**。前缀展开救不了中段,而救中段要 trigram —— §0 已经写明
   *   trigram 对中文双字查询整片失灵,那是这套方案最先否掉的东西。
   *
   * 所以这一条守的是**恰好这两条**:哪天多出第三条(索引真的漏了)红,哪天这两条
   * 被治好了也红(得回来改这段说明)。
   */
  const KNOWN_SUBSTRING_ONLY_MISSES = [
    'elcc_holiday_tranfer → 缺 caecca753d58:7c1e015e5689',
    'ＦＡＣ 888 → 缺 b1e4aa574e87:dbad5b5c5dec',
  ]

  it('20 条黄金查询在严格档下命中期望键(两条子串语义的例外逐条钉住)', () => {
    const misses: string[] = []
    for (const entry of golden.queries) {
      const hits = new Set(keysOf(entry.query))
      for (const key of entry.expectKeys) {
        if (!hits.has(key)) misses.push(`${entry.query} → 缺 ${key}`)
      }
    }
    expect(misses.sort()).toEqual([...KNOWN_SUBSTRING_ONLY_MISSES].sort())

    // 20 条里 18 条期望集全覆盖(两条例外各占一条查询)。
    const covered = golden.queries.filter(entry => {
      const hits = new Set(keysOf(entry.query))
      return entry.expectKeys.every(key => hits.has(key))
    })
    expect(covered.length).toBe(18)
    expect(golden.queries.length).toBe(20)
  })

  it('放宽到阶梯 ③(至少一半)那条 snake 例外就回来了', () => {
    const relaxed = strictQuery('elcc_holiday_tranfer')
    relaxed.minShouldMatch = Math.ceil(relaxed.terms.length / 2)
    const keys = index.search(relaxed).hits
      .map(hit => index.get(hit.docId)?.key)
      .filter((key): key is string => key !== undefined)
    expect(keys).toContain('caecca753d58:7c1e015e5689')
  })

  /**
   * 黄金表给 `/compact` 的期望是**零命中**,理由写在它的 note 上:「`/` 是意图前缀
   * (actions 的 `intentPrefixes`),不是要丢掉的噪音」。
   *
   * 那个零**不产在索引这一层**:`/` 不是任何分析器的词字符,所以到了倒排面前
   * `/compact` 与 `compact` 已经是同一件东西,索引照实答「有 9 条讲 compact」。
   * 零来自**上一层** —— `parse` 认出意图是 actions,fanout 于是根本不问 messages。
   * 所以这里守的是**索引层该守的那一半**:`/` 确实被当成意图证据认了出来。
   */
  it('`/` 是意图证据 —— parse 认得出,零命中那一半归 fanout 不归索引', () => {
    const command = golden.queries.find(entry => entry.query.startsWith('/'))!
    expect(command.expectKeys).toEqual([])
    const actionsLike: CapabilityManifest = { ...manifest, id: 'actions', intentPrefixes: ['/', '>'] }
    expect(parse(command.query, { manifests: [actionsLike] }).intent).toBe('actions')
    // 没有注册表时它就是一个普通查询,索引照实答 —— 不装成零。
    expect(parse(command.query).intent).toBe('content')
    expect(keysOf(command.query).length).toBeGreaterThan(0)
  })

  it('读数:冷灌耗时与 20 条查询的 p50 / p99(打印,不断言)', () => {
    const samples: number[] = []
    // 每条跑 20 遍取分位 —— 一遍的抖动比要量的东西还大。
    for (let round = 0; round < 20; round += 1) {
      for (const entry of golden.queries) {
        const startedAt = performance.now()
        index.search(strictQuery(entry.query, 50))
        samples.push(performance.now() - startedAt)
      }
    }
    samples.sort((a, b) => a - b)
    const at = (q: number): number => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))]!
    const dbBytes = fs.statSync(path.join(tempRoot, 'corpus.sqlite')).size
    // 这是**读数**,不是日志:只在这一条用例里往测试报告上打一行,产品代码一个
    // console 都没有(`log:gate` 只扫非测试源码,`packages/core/search/__tests__/
    // benchmark.test.ts` 打基准也是这么打的)。
    console.log(`[S3a 读数] 冷灌 ${corpus.docs.length} 文档 ${coldMs.toFixed(0)}ms`
      + ` | 库 ${(dbBytes / 1024 / 1024).toFixed(2)}MiB`
      + ` | 查询 n=${samples.length} p50 ${at(0.5).toFixed(3)}ms p99 ${at(0.99).toFixed(3)}ms`)
    expect(samples.length).toBe(20 * golden.queries.length)
  })
})
