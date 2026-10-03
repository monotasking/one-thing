/**
 * 嵌入器这一族的桶 + **内置两条的注册**(S7)。
 *
 * 设计:docs/design/search-index-2026-09.md §15.3
 *
 * `registerBuiltinEmbedders()` 是幂等的,由 Worker 入口调一次。真的那一条
 * (`transformers-onnx`)只在这里挂一个**工厂** —— `@huggingface/transformers` 本体
 * 要到 `create()` 之后的 `ready()` 里才动态 import,所以「注册」这件事零成本、
 * 也不把 onnxruntime 拖进任何 bundle 的启动路径。
 */

export { chunkForEmbedding, normalizeVector, MAX_CHUNKS_PER_DOC } from './embedder.js'
export type { EmbeddingChunk, Embedder, EmbedKind } from './embedder.js'
export {
  listEmbedders,
  registerEmbedder,
  resetEmbedderRegistry,
  resolveEmbedder,
} from './registry.js'
export type {
  EmbedderCreateOptions,
  EmbedderDownloadOptions,
  EmbedderFactory,
  EmbedderFileProgress,
  EmbedderModelSpec,
  EmbedderProgress,
} from './registry.js'
export {
  MODEL_MANIFEST_FILE,
  captureModelManifest,
  isEmbedderModelPresent,
  probeEmbedderModel,
  readModelManifest,
  removeEmbedderModel,
} from './model-store.js'
export type { ModelManifest, ModelPresence, ModelProbe } from './model-store.js'
export {
  FAKE_EMBEDDER_DIMS,
  FAKE_EMBEDDER_ID,
  FAKE_TABLE_ENV,
  createFakeEmbedderFromEnv,
  fakeEmbedderFactory,
  loadFakeSynonyms,
} from './fake.js'
export {
  E5_SMALL_APPROX_BYTES,
  E5_SMALL_DIMS,
  E5_SMALL_EMBEDDER_ID,
  E5_SMALL_MAX_TOKENS,
  E5_SMALL_MODEL_SPEC,
  MODEL_NOT_DOWNLOADED_ERROR,
  createTransformersOnnxEmbedder,
  downloadE5SmallModel,
  transformersOnnxEmbedderFactory,
} from './transformers-onnx.js'

import { fakeEmbedderFactory } from './fake.js'
import { listEmbedders, registerEmbedder } from './registry.js'
import { transformersOnnxEmbedderFactory } from './transformers-onnx.js'

/** 幂等。加第三条嵌入器 = 这里多一行,别处一个字不改。 */
export function registerBuiltinEmbedders(): void {
  const known = new Set(listEmbedders())
  for (const factory of [transformersOnnxEmbedderFactory, fakeEmbedderFactory]) {
    if (known.has(factory.id)) continue
    registerEmbedder(factory)
  }
}
