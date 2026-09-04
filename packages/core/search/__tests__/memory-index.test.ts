/**
 * `MemoryIndex` 答一遍索引的契约卷子。
 *
 * 卷子本体在 `index-contract.ts`(S3a 从这里抽出去,用例语义一字未改),
 * 另一位考生是 runtime 的 `SqliteIndex`
 * (`packages/onething-runtime/src/search/index/__tests__/sqlite-index.test.ts`)。
 * 这就是 §5.1 那句「换实现不改上层」从「一句话」变成「一份活证据」的地方。
 */
import { MemoryIndex } from '../index/memory-index.js'
import { createDefaultAnalyzerRegistry } from '../analyzer/registry.js'
import { corpusDocuments } from './unit-fixtures/corpus.js'
import { DEFAULT_SCHEMA } from './unit-fixtures/harness.js'
import { describeIndexContract } from './index-contract.js'

describeIndexContract('MemoryIndex', (options = {}) => {
  const documents = options.documents ?? corpusDocuments()
  const index = new MemoryIndex({
    analyzers: createDefaultAnalyzerRegistry(),
    ...(options.maxFieldChars !== undefined ? { maxFieldChars: options.maxFieldChars } : {}),
  })
  const capabilities = new Set(documents.map(doc => doc.capability))
  // 空语料那一档也要有 schema —— 「超长字段截断」那条用例装的是零文档 + 一条自造的。
  for (const capability of [...capabilities, ...Object.keys(options.schemas ?? {})]) {
    index.setSchema(capability, options.schemas?.[capability] ?? DEFAULT_SCHEMA)
  }
  if (capabilities.size === 0) index.setSchema('alpha', DEFAULT_SCHEMA)
  for (const doc of documents) index.replaceKey(doc.capability, doc.key, [doc])
  return index
})
