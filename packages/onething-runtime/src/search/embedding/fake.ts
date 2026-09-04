/**
 * 假嵌入器的**注册表适配器**。机制住 core(`@onething/core/search` 的
 * `createFakeEmbedder`,与 `MemoryIndex` 同一种身份);这个文件只做两件宿主的事:
 * 把映射表从磁盘读进来,把工厂挂进注册表。
 *
 * 设计:docs/design/search-index-2026-09.md §15.5
 *
 * 表与黄金复述集是**同一份数据**(`packages/core/search/__tests__/fixtures/
 * paraphrase.json` 的 `synonyms` 段),由 `ONETHING_SEARCH_EMBEDDER_FAKE_TABLE`
 * 指过来 —— 一份数据两个读者,不许抄两份。没指表 = 只有词面层,仍然确定性、仍然
 * 跑得通,只是不懂同义。
 */

import { readFileSync } from 'node:fs'

import { FAKE_EMBEDDER_DIMS, createFakeEmbedder } from '@onething/core/search'
import type { Embedder } from '@onething/core/search'

import type { EmbedderCreateOptions, EmbedderFactory } from './registry.js'

/** 注册 id。设置里 `modelId` 填它就用假的(门 ⑧ 就是这么注入的)。 */
export const FAKE_EMBEDDER_ID = 'fake'

/** 表从哪儿来。读不到就是空表 —— 生产不会走到这只嵌入器,所以不抛。 */
export const FAKE_TABLE_ENV = 'ONETHING_SEARCH_EMBEDDER_FAKE_TABLE'

export { FAKE_EMBEDDER_DIMS }

export function loadFakeSynonyms(file: string | undefined): Record<string, string> {
  if (file === undefined || file.length === 0) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { synonyms?: Record<string, string> }
    return parsed.synonyms ?? {}
  } catch {
    return {}
  }
}

export function createFakeEmbedderFromEnv(): Embedder {
  return createFakeEmbedder({
    id: FAKE_EMBEDDER_ID,
    synonyms: loadFakeSynonyms(process.env[FAKE_TABLE_ENV]),
  })
}

export const fakeEmbedderFactory: EmbedderFactory = {
  id: FAKE_EMBEDDER_ID,
  create: (_options: EmbedderCreateOptions) => createFakeEmbedderFromEnv(),
}
