export {
  BM25_B,
  BM25_K1,
  matchesFacetFilter,
  matchesFacetFilters,
} from './types.js'
export type {
  DocTable,
  IndexWriter,
  IndexedDoc,
  InvertedIndex,
  LexicalHit,
  LexicalPhrase,
  LexicalQuery,
  LexicalResult,
  LexicalSearcher,
  LexicalTerm,
  Posting,
  VectorHit,
  VectorIndex,
  VectorSearchScope,
  Vocabulary,
} from './types.js'
export type { EmbedKind, Embedder } from './types.js'
export { DEFAULT_MAX_FIELD_CHARS, MemoryIndex } from './memory-index.js'
export type { MemoryIndexOptions } from './memory-index.js'
export { MemoryVectorIndex } from './memory-vector-index.js'
export { FAKE_EMBEDDER_DIMS, createFakeEmbedder, normalizeVector } from './fake-embedder.js'
export type { FakeEmbedderOptions } from './fake-embedder.js'
export type { MemoryVectorIndexOptions } from './memory-vector-index.js'
