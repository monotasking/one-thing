/**
 * 检索语料夹具的自检(检索重建 S0,`docs/design/search-index-2026-09.md` §10 S0 行)。
 *
 * `fixtures/corpus.json` 是从**真库**抽出来的 2000 条脱敏消息 + 全部会话标题,
 * `fixtures/golden-queries.json` 是 20 条手写查询与它们在这份语料上的期望键。
 * 两份文件都由 `scripts/search-corpus-extract.mjs` 与施工时的一次性生成跑出来,
 * 之后就**冻在仓里**——S1 的分析器 / 流水线、S3 的索引、S7 的复述集都拿它们当靶子。
 *
 * 这个文件守三件事:
 *
 *  1. **规模**:消息文档 ≤ 2000,会话标题文档与计数表对得上;
 *  2. **脱敏**:拿 `scripts/lib/search-corpus-redact.mjs` **同一份**函数在成品上再跑
 *     一遍必须逐字相同(恒等),且 `findRedactionHits` 在每一段文本上零命中 ——
 *     恒等 + 零命中合起来就是「一条漏网都没有」;
 *  3. **黄金表可兑现**:每一个 `expectKey` 都真的是语料里的一个键。期望集里指着
 *     不存在的键,S1 那道门就永远是绿的假象。
 *
 * 本目录(`packages/core/search/`)此刻**只有夹具与这个用例** —— 内核是 S1 的活。
 * 边界检查器的 `checkCoreSearchNamesNoCapability` 从 S0 起就守着它:core 里不许出现
 * 任何能力 id 的字面量。`__tests__` 不在那条规则的射程内(夹具当然要拿真名字当证词)。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REDACT_RULE_IDS, findRedactionHits, redactText } from '../../../../scripts/lib/search-corpus-redact.mjs'

interface CorpusDoc {
  capability: 'messages' | 'sessions'
  key: string
  sessionKey: string
  role?: string
  time: number
  title?: string
  content: string
  truncated?: boolean
}

interface Corpus {
  generatedAt: string
  store: string
  counts: {
    sessionsScanned: number
    sessionsBroken: number
    sessionDocs: number
    messageDocs: number
    messageDocsAvailable: number
    truncated: number
  }
  docs: CorpusDoc[]
}

interface GoldenQueries {
  note: string
  semantics: string[]
  queries: Array<{ query: string; expectKeys: string[]; note: string }>
}

/** 抽取脚本里的两个上限;改了这里就要重跑抽取。 */
const MESSAGE_DOC_LIMIT = 2000
const MAX_CONTENT_CHARS = 2000

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const corpus = JSON.parse(fs.readFileSync(path.join(fixtures, 'corpus.json'), 'utf-8')) as Corpus
const golden = JSON.parse(fs.readFileSync(path.join(fixtures, 'golden-queries.json'), 'utf-8')) as GoldenQueries

const messageDocs = corpus.docs.filter(doc => doc.capability === 'messages')
const sessionDocs = corpus.docs.filter(doc => doc.capability === 'sessions')
/** 一条文档里所有**文本**字段;脱敏与长度都按它算。 */
const textFieldsOf = (doc: CorpusDoc): string[] =>
  [doc.title, doc.content].filter((value): value is string => typeof value === 'string')

describe('search corpus fixture', () => {
  it('规模:消息 ≤ 2000 条,另加全部会话标题', () => {
    expect(messageDocs.length).toBeLessThanOrEqual(MESSAGE_DOC_LIMIT)
    expect(messageDocs.length).toBe(corpus.counts.messageDocs)
    expect(sessionDocs.length).toBe(corpus.counts.sessionDocs)
    expect(corpus.docs.length).toBe(messageDocs.length + sessionDocs.length)
    // 抽样是从更大的池子里取的 —— 取到的比池子还多就说明抽样错了。
    expect(corpus.counts.messageDocsAvailable).toBeGreaterThanOrEqual(messageDocs.length)
  })

  it('形状:键唯一、时间是数、正文非空', () => {
    const keys = new Set<string>()
    for (const doc of corpus.docs) {
      expect(keys.has(doc.key), `duplicate key ${doc.key}`).toBe(false)
      keys.add(doc.key)
      expect(typeof doc.time).toBe('number')
      expect(doc.content.length).toBeGreaterThan(0)
      // key 里带 sessionKey:消息是 `<session>:<message>`,会话就是 `<session>`。
      expect(doc.key.startsWith(doc.sessionKey)).toBe(true)
    }
  })

  it('截断:正文不过 2000 字,标了 truncated 的正好是踩到上限那些', () => {
    let truncated = 0
    for (const doc of messageDocs) {
      expect(doc.content.length).toBeLessThanOrEqual(MAX_CONTENT_CHARS)
      if (doc.truncated) {
        truncated += 1
        expect(doc.content.length).toBe(MAX_CONTENT_CHARS)
      }
    }
    expect(truncated).toBe(corpus.counts.truncated)
  })

  it('脱敏:每条规则在语料上零命中', () => {
    const residual = new Map<string, number>()
    for (const doc of corpus.docs) {
      for (const text of textFieldsOf(doc)) {
        for (const rule of findRedactionHits(text)) {
          residual.set(rule, (residual.get(rule) ?? 0) + 1)
        }
      }
    }
    expect(REDACT_RULE_IDS.length).toBeGreaterThan(0)
    expect(Object.fromEntries(residual)).toEqual({})
  })

  it('脱敏:同一份函数再跑一遍是恒等', () => {
    for (const doc of corpus.docs) {
      for (const text of textFieldsOf(doc)) {
        expect(redactText(text), `not idempotent at ${doc.key}`).toBe(text)
      }
    }
  })

  it('脱敏:整份文件(含键与元数据)也零命中', () => {
    // 键是哈希过的 12 位十六进制,所以「32 位以上随机串」那条也不会在元数据上命中 ——
    // 这一条守的就是「id 一律哈希」那个决定别被改回去。
    const raw = fs.readFileSync(path.join(fixtures, 'corpus.json'), 'utf-8')
    expect(findRedactionHits(raw)).toEqual([])
  })
})

describe('search golden queries', () => {
  it('20 条,每条都带查询、期望集与说明', () => {
    expect(golden.queries.length).toBe(20)
    for (const entry of golden.queries) {
      expect(entry.query.length).toBeGreaterThan(0)
      expect(Array.isArray(entry.expectKeys)).toBe(true)
      expect(entry.note.length).toBeGreaterThan(0)
    }
  })

  it('每个期望键都在语料里', () => {
    const keys = new Set(corpus.docs.map(doc => doc.key))
    const missing: string[] = []
    for (const entry of golden.queries) {
      for (const key of entry.expectKeys) {
        if (!keys.has(key)) missing.push(`${entry.query} → ${key}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('六种形都在表里(中文双字 / 全角混写 / camelCase / 命令样 / 短语 / 排除)', () => {
    const queries = golden.queries.map(entry => entry.query)
    // 中文双字词 —— FTS5 trigram 那道坎。
    expect(queries).toContain('私发')
    // 全角 / 半角混写。
    expect(queries.some(query => /[！-～]/.test(query))).toBe(true)
    // 英文 camelCase。
    expect(queries.some(query => /[a-z][A-Z]/.test(query))).toBe(true)
    // `/` 起头的命令样查询,而且期望**零命中**:`/` 是意图前缀,不是要剥掉的噪音。
    const command = golden.queries.find(entry => entry.query.startsWith('/'))
    expect(command).toBeDefined()
    expect(command?.expectKeys).toEqual([])
    // 短语与排除。
    expect(queries.some(query => query.includes('"'))).toBe(true)
    expect(queries.some(query => /(^|\s)-\S/.test(query))).toBe(true)
  })

  it('除命令样那条外,每条都真有命中', () => {
    for (const entry of golden.queries) {
      if (entry.query.startsWith('/')) continue
      expect(entry.expectKeys.length, `${entry.query} 期望集为空`).toBeGreaterThan(0)
    }
  })
})
