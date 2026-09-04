/**
 * **运行时缺席时,语义召回优雅降级**(检索重建 S7,09-05 拍点癸' (c))。
 *
 * 设计:`docs/design/search-index-2026-09.md` §0 拍点癸' / §13 留账 1
 *
 * 打包桌面档**不带**语义召回的运行时 —— `electron-builder.yml` 的 `files:` 排除了
 * `@huggingface/transformers` 与它拖来的 onnxruntime / sharp(理由与三条待拍的路
 * 写在那几行注释里)。于是打包 app 里,`transformers-wasm.ts` 那句
 * `await import('@huggingface/transformers')` 抛 `ERR_MODULE_NOT_FOUND`。
 *
 * 这个文件钉死那一刻**该发生什么**:
 *  ① `status.vector` 答 `'off'`(不是 `'downloading'` 挂在那儿,也不是往上抛);
 *  ② 日志**恰好一条 `warn`**,不是 `error` —— 「用户没开的能力起不来」是一条事实,
 *     不是这个进程出了错;
 *  ③ **查多少次都只有那一条** —— `ready()` 的 promise 是记住的,写路与查询路撞上的是
 *     同一条拒绝,`markOff` 幂等把重复的话吃掉;
 *  ④ 向量索引一个字没被写(词法路那一半在这条路上根本不经过 —— 它连
 *     `VectorWriter` 都不认识)。
 *
 * 两个入口各证一遍,因为**它们是两条独立的路**:查询路(`embedQuery`)与写路
 * (`enqueue` → `pump`)。施工时查询路那一条真的漏了 —— `await this.ready()` 裸奔,
 * 「开关开着 + 库已经建好 + 没有新文档」那一形下第一条查询会把装载失败原样抛给调用方。
 */

import { describe, expect, it, vi } from 'vitest'

import type { IndexedDoc, VectorIndex } from '@onething/core/search'

import { captureRuntimeLogs } from '../../../logging/index.js'
import { VectorWriter } from '../../index/vector-writer.js'
import { E5_SMALL_DIMS, createTransformersWasmEmbedder } from '../transformers-wasm.js'

/**
 * 逐字重现打包档里的现场:模块不在,node 的动态 import 抛 `ERR_MODULE_NOT_FOUND`。
 * (仓里这个包是装着的 —— 所以只能这样模拟「它不在」。)
 */
vi.mock('@huggingface/transformers', () => {
  const error = new Error("Cannot find package '@huggingface/transformers'") as Error & { code?: string }
  error.code = 'ERR_MODULE_NOT_FOUND'
  throw error
})

interface Harness {
  writer: VectorWriter
  states: string[]
  upserts: number
  logs: ReturnType<typeof captureRuntimeLogs>
}

function makeWriter(): Harness {
  const states: string[] = []
  const harness = { upserts: 0 } as { upserts: number }
  const vector: VectorIndex = {
    dims: E5_SMALL_DIMS,
    upsert() { harness.upserts += 1 },
    remove() { /* 幂等,记不记都行 */ },
    clear() { /* noop */ },
    size: () => 0,
    search: () => [],
  }
  const doc: IndexedDoc = {
    docId: 1,
    capability: 'messages',
    key: 's1',
    time: 0,
    facets: {},
    fields: { text: '一段会被嵌的正文' },
  }
  const writer = new VectorWriter({
    index: {
      get: (docId: number) => (docId === 1 ? doc : undefined),
      byKey: () => [doc],
      allDocIds: () => [1],
    },
    vector,
    embedder: createTransformersWasmEmbedder({ modelDir: '/nonexistent/models/e5' }),
    embedFields: () => ['text'],
    onState: state => { states.push(state) },
  })
  return {
    writer,
    states,
    get upserts() { return harness.upserts },
    logs: captureRuntimeLogs(),
  }
}

describe('运行时缺席:语义召回把自己关回去(S7 / 拍点癸\' c)', () => {
  /*
   * 一件测试脚手架的事实,写在这儿免得后来人当成产品行为:vitest 会把 `vi.mock` 工厂抛的
   * 东西**包一层**它自己的 "There was an error when mocking a module",真话在 `cause` 里。
   * 所以下面两处断言看的都是 `cause` —— 打包 app 上没有这一层,`markOff` 收到的就是
   * node 的原话本身(`normalizeError` 会顺着 `cause` 链往下记,两种形状都读得出)。
   */
  it('⓪ 嵌入器自己抛的就是 `ERR_MODULE_NOT_FOUND`(打包档里 node 的原话)', async () => {
    const embedder = createTransformersWasmEmbedder({ modelDir: '/nonexistent/models/e5' })
    await expect(embedder.ready()).rejects.toMatchObject({
      cause: { code: 'ERR_MODULE_NOT_FOUND' },
    })
  })

  it('① 查询路:装载失败 → 答 undefined、状态 off、一条 warn', async () => {
    const h = makeWriter()
    try {
      await expect(h.writer.embedQuery('钉边架子怎么收起来')).resolves.toBeUndefined()

      expect(h.writer.currentState()).toBe('off')
      expect(h.states.at(-1)).toBe('off')

      const warns = h.logs.ofLevel('warn')
      expect(warns).toHaveLength(1)
      expect(warns[0]?.msg).toBe('semantic recall turned itself off')
      // 原话要带着走,而且要在 `err` 那一格 —— 排障读的是它,不是「装载失败」四个字。
      expect(warns[0]?.err?.cause?.message).toContain('@huggingface/transformers')
      // **不是 error**:用户没开成的能力不算这个进程出错。
      expect(h.logs.ofLevel('error')).toHaveLength(0)
      expect(h.logs.ofLevel('fatal')).toHaveLength(0)
      expect(h.upserts).toBe(0)
    } finally {
      h.logs.restore()
      h.writer.dispose()
    }
  })

  it('② 查一百次也只有那一条 warn(`markOff` 幂等,不许每次查询都刷一行)', async () => {
    const h = makeWriter()
    try {
      for (let at = 0; at < 100; at += 1) {
        await expect(h.writer.embedQuery(`第 ${at} 条`)).resolves.toBeUndefined()
      }
      expect(h.logs.ofLevel('warn')).toHaveLength(1)
      expect(h.writer.currentState()).toBe('off')
    } finally {
      h.logs.restore()
      h.writer.dispose()
    }
  })

  it('③ 写路:排队的文档嵌不了也只关一次,向量库一个字没写', async () => {
    const h = makeWriter()
    try {
      h.writer.enqueue(1)
      await h.writer.drain()

      expect(h.writer.currentState()).toBe('off')
      expect(h.writer.pending()).toBe(0)
      expect(h.upserts).toBe(0)
      expect(h.logs.ofLevel('warn')).toHaveLength(1)
      expect(h.logs.ofLevel('error')).toHaveLength(0)

      // 写路关过之后,查询路不再补第二条。
      await expect(h.writer.embedQuery('再问一句')).resolves.toBeUndefined()
      expect(h.logs.ofLevel('warn')).toHaveLength(1)
    } finally {
      h.logs.restore()
      h.writer.dispose()
    }
  })

  it('④ `off` 是吸收态:关回去之后没有人能悄悄再打开', async () => {
    const h = makeWriter()
    try {
      await h.writer.embedQuery('先把它关掉')
      expect(h.writer.currentState()).toBe('off')

      h.writer.enqueue(1)
      await h.writer.drain()
      expect(h.writer.currentState()).toBe('off')
      expect(h.logs.ofLevel('warn')).toHaveLength(1)
    } finally {
      h.logs.restore()
      h.writer.dispose()
    }
  })
})
