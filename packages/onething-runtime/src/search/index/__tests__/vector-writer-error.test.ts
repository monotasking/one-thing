/**
 * 「语义召回为什么关回去了」这句话的产地(2026-09-17)。
 *
 * 设置页在这之前只会写「没跑起来。原因在日志里」,而日志那一半当时是假的
 * (`worker-logging.test.ts` 的文件头)。
 *
 * **R12 改口:后端只答码 + 原话**(同日晚)。第一版在这里拼了一句中文前缀「下载模型
 * 失败(检查网络代理):」—— 那是后端替壳写文案,英文界面上就是一句中文。所以这里判的
 * 变成:四类判据各认得出、原话一个字不加、`VectorWriter` 把**第一条**原因留住并交给
 * `status.vectorError` / `status.vectorErrorKind`。
 */

import { describe, expect, it } from 'vitest'
import type { Embedder, IndexedDoc, VectorHit, VectorIndex } from '@onething/core/search'

import { captureRuntimeLogs } from '../../../logging/index.js'
import {
  VECTOR_ERROR_MAX_LENGTH,
  VectorWriter,
  describeEmbedderFailure,
} from '../vector-writer.js'

describe('describeEmbedderFailure', () => {
  it('① 网络类:判据是错误链里真的有那几个字,而且原话一个字不加', () => {
    // 09-17 真机现场的原形:`TypeError: fetch failed`,cause 是一只 AggregateError。
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:7890')
    const error = new TypeError('fetch failed', { cause })
    expect(describeEmbedderFailure(error)).toEqual({ kind: 'network', reason: 'fetch failed' })
  })

  it('①b 只在 cause 里出现也算(顶层那句可能什么都不说)', () => {
    const error = new Error('pipeline failed', { cause: new Error('getaddrinfo ENOTFOUND huggingface.co') })
    expect(describeEmbedderFailure(error).kind).toBe('network')
  })

  it('② 运行时类:§15.7b 那堵墙与装不上的 .node', () => {
    expect(describeEmbedderFailure(new Error('Unsupported device: "wasm". Should be one of: cpu.')))
      .toEqual({ kind: 'runtime', reason: 'Unsupported device: "wasm". Should be one of: cpu.' })
    expect(describeEmbedderFailure(new Error(
      'Cannot open onnxruntime_binding.node: ERR_DLOPEN_FAILED',
    )).kind).toBe('runtime')
    // 打包档(路线 c)根本没带 transformers:那也是「这台宿主的运行时不成立」,不是未知。
    expect(describeEmbedderFailure(new Error(
      "Cannot find package '@huggingface/transformers' imported from /app/search-worker.cjs",
    )).kind).toBe('runtime')
  })

  it('③ 模型类:文件那一侧', () => {
    expect(describeEmbedderFailure(new Error('Could not locate file: "…/config.json"')).kind)
      .toBe('model')
  })

  /**
   * **网络排在运行时 / 模型前面**。下载失败时 transformers 常常把话说成「找不到
   * config.json」,真因在 `cause` 里 —— 判反了就会让人去查模型文件,而该改的是代理。
   *
   * 反证:把 `FAILURE_MARKERS` 里 network 那一行挪到末尾 → 这一条当场红(答 model)。
   */
  it('③b 同一只错既像网络又像模型时,网络赢', () => {
    const error = new Error('Could not locate file: "https://huggingface.co/…/config.json"', {
      cause: new TypeError('fetch failed'),
    })
    expect(describeEmbedderFailure(error).kind).toBe('network')
  })

  it('④ 不认识的就是 unknown,原话交出去,不猜', () => {
    expect(describeEmbedderFailure(new Error('embedder "fake" is not registered')))
      .toEqual({ kind: 'unknown', reason: 'embedder "fake" is not registered' })
    expect(describeEmbedderFailure('something odd'))
      .toEqual({ kind: 'unknown', reason: 'something odd' })
  })

  it('⑤ 200 字封顶 —— 它是状态行上的一句话,不是一份栈', () => {
    const described = describeEmbedderFailure(new Error('x'.repeat(500)))
    expect(described.reason.length).toBe(VECTOR_ERROR_MAX_LENGTH)
    expect(described.reason.endsWith('…')).toBe(true)
  })
})

/** 一只什么都不做的向量索引 —— 这一条判的是写路的状态,不是 sqlite。 */
function stubVectorIndex(): VectorIndex {
  return {
    dims: 4,
    upsert: () => undefined,
    remove: () => undefined,
    clear: () => undefined,
    size: () => 0,
    search: (): VectorHit[] => [],
  }
}

function failingEmbedder(error: unknown): Embedder {
  return {
    id: 'never-loads',
    dims: 4,
    maxTokens: 64,
    countTokens: text => text.length,
    ready: () => Promise.reject(error),
    embed: () => Promise.reject(error),
  }
}

function writerWith(error: unknown): VectorWriter {
  const docs = new Map<number, IndexedDoc>()
  return new VectorWriter({
    index: {
      get: docId => docs.get(docId),
      byKey: () => [],
      allDocIds: () => [],
    },
    vector: stubVectorIndex(),
    embedder: failingEmbedder(error),
    embedFields: () => ['content'],
  })
}

describe('VectorWriter.lastError', () => {
  it('⑥ 装载失败 → 状态钉 off,原因(码 + 原话)留下来', async () => {
    const logs = captureRuntimeLogs()
    try {
      const writer = writerWith(new TypeError('fetch failed'))
      expect(writer.lastError()).toBeUndefined()
      expect(await writer.embedQuery('anything')).toBeUndefined()
      expect(writer.currentState()).toBe('off')
      expect(writer.lastError()).toEqual({ kind: 'network', reason: 'fetch failed' })
    } finally {
      logs.restore()
    }
  })

  it('⑦ 关过一次就不再改口(第一条原因才是「它为什么关的」)', async () => {
    const logs = captureRuntimeLogs()
    try {
      const writer = writerWith(new Error('onnx model file is corrupt'))
      await writer.embedQuery('a')
      const first = writer.lastError()
      await writer.embedQuery('b')
      expect(writer.lastError()).toBe(first)
      // `warn` 也只有一条 —— 排障要的是「它什么时候关的」,不是每查一次刷一行。
      expect(logs.ofLevel('warn').filter(r => r.msg === 'semantic recall turned itself off').length).toBe(1)
    } finally {
      logs.restore()
    }
  })
})
