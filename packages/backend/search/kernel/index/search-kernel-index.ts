export {
  BM25_B,
  BM25_K1,
  matchesFacetFilter,
  matchesFacetFilters,
} from './search-kernel-index-types.js'
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
} from './search-kernel-index-types.js'
export type { EmbedKind, Embedder } from './search-kernel-index-types.js'
export { DEFAULT_MAX_FIELD_CHARS, MemoryIndex } from './search-kernel-memory-index.js'
export type { MemoryIndexOptions } from './search-kernel-memory-index.js'
export { MemoryVectorIndex } from './search-kernel-memory-vector-index.js'
export { FAKE_EMBEDDER_DIMS, createFakeEmbedder, normalizeVector } from './search-kernel-index-fake-embedder.js'
export type { FakeEmbedderOptions } from './search-kernel-index-fake-embedder.js'
export type { MemoryVectorIndexOptions } from './search-kernel-memory-vector-index.js'
