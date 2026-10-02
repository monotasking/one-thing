/**
 * 单测的装配夹具:一个 MemoryIndex、一两个假能力、一条流水线。
 *
 * 它同时是「换实现不改上层」的活证据的一半 —— 这里装的是 MemoryIndex,
 * runtime 装的是 SqliteIndex,上面的流水线一个字都不换。
 */

import type {
  Candidate,
  SearchContext,
  SearchPrincipal,
} from '../../candidate.js'
import type { CapabilityManifest, SearchCapability } from '../../capability.js'
import { createCapabilityRegistry } from '../../capability.js'
import { createDefaultAnalyzerRegistry } from '../../analyzer/registry.js'
import { MemoryIndex } from '../../index/memory-index.js'
import type { DocPayload } from '../../feed.js'
import { indexedCapability } from '../../bases/indexed.js'
import { createLexicalRetriever } from '../../bases/lexical-retriever.js'
import type { ExpanderRegistry } from '../../pipeline/expand.js'
import { compose } from '../../pipeline/compose.js'
import type { SearchPipeline } from '../../pipeline/compose.js'
import { CAP_A, CORPUS_NOW, corpusDocuments } from './corpus.js'

export const DEFAULT_SCHEMA = {
  title: { analyzer: 'composite', weight: 2 },
  content: { analyzer: 'composite', weight: 1 },
}

export function makeManifest(overrides: Partial<CapabilityManifest> & { id: string }): CapabilityManifest {
  return {
    labelKey: `label.${overrides.id}`,
    icon: 'circle',
    kind: 'indexed',
    budget: { default: 10, timeoutMs: 200 },
    order: 1,
    schema: DEFAULT_SCHEMA,
    ...overrides,
  }
}

export function buildIndex(documents: readonly DocPayload[], schemas: Record<string, typeof DEFAULT_SCHEMA> = {}): MemoryIndex {
  const index = new MemoryIndex({ analyzers: createDefaultAnalyzerRegistry() })
  const byCapability = new Set(documents.map(doc => doc.capability))
  for (const capability of byCapability) {
    index.setSchema(capability, schemas[capability] ?? DEFAULT_SCHEMA)
  }
  for (const doc of documents) index.replaceKey(doc.capability, doc.key, [doc])
  return index
}

export interface IndexedFixtureOptions {
  manifest?: Partial<CapabilityManifest>
  documents?: readonly DocPayload[]
  index?: MemoryIndex
  expanders?: ExpanderRegistry
  generation?: () => string | number
}

export function makeIndexedCapability(
  id: string,
  options: IndexedFixtureOptions = {},
): { capability: SearchCapability; index: MemoryIndex } {
  const documents = options.documents ?? corpusDocuments(id)
  const index = options.index ?? buildIndex(documents)
  const manifest = makeManifest({ id, ...options.manifest })
  const analyzers = createDefaultAnalyzerRegistry()

  const capability = indexedCapability({
    manifest,
    generation: options.generation,
    now: () => CORPUS_NOW,
    retrievers: [createLexicalRetriever({
      manifest,
      index,
      analyzers,
      expanders: options.expanders,
      now: () => CORPUS_NOW,
      toCandidate: ({ doc, hit, score }): Candidate => ({
        capability: doc.capability,
        id: doc.key,
        title: doc.fields.title ?? doc.key,
        subtitle: doc.fields.content,
        score,
        time: doc.time,
        target: { kind: 'row', payload: { key: doc.key } },
        facets: doc.facets,
        explain: hit.matched,
      }),
    })],
  })

  return { capability, index }
}

export function makeContext(overrides: Partial<SearchContext> = {}): SearchContext {
  const principal: SearchPrincipal = overrides.principal ?? { kind: 'user', id: 'u1' }
  return {
    principal,
    surface: 'test',
    spaceId: 's1',
    signal: new AbortController().signal,
    now: CORPUS_NOW,
    ...overrides,
  }
}

export function makePipeline(capabilities: readonly SearchCapability[]): {
  pipeline: SearchPipeline
  registry: ReturnType<typeof createCapabilityRegistry>
} {
  const registry = createCapabilityRegistry()
  for (const capability of capabilities) registry.register(capability)
  return { pipeline: compose({ registry, now: () => CORPUS_NOW }), registry }
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iterable) out.push(item)
  return out
}

export const DEFAULT_CAPABILITY_ID = CAP_A
