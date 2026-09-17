/**
 * **「头对得上,可向量表是空的」也要全量重嵌**(2026-09-17;判据在
 * `IndexWorkerCore.applyEmbeddingModelHeader`)。
 *
 * 这一条不是补一个理论缺口,它是这一批自己造出来的那条路的收尾:
 *
 *  1. 开关开着、模型还没下 → 第一条 Worker 装了嵌入器,于是它**把库头
 *     `embeddingModelId` 写下了**,随后 `ready()` 在第一句抛「模型文件没下载」,
 *     `VectorWriter` 把自己钉成 `'off'`(吸收态),一行向量都没写;
 *  2. 人按「下载」,模型下完,宿主换上一条新 Worker(「下完就生效」);
 *  3. 新 Worker 一看头**对得上**——要是就此什么都不排队,状态会永远停在「正在启动」,
 *     那条链在最后一米断掉。
 *
 * 所以判据从「头变没变」扩成「头变没变 **或** 这个头下面一行向量都没有」。
 * 后者住在库里、看得见、重启也还在,不需要跨 Worker 的记忆。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import type { DocPayload, Embedder, VectorIndex } from '@onething/core/search'
import { createFakeEmbedder } from '@onething/core/search'
import { MessageChannel } from 'node:worker_threads'

import { SqliteIndex } from '../sqlite-index.js'
import { IndexWorkerCore } from '../worker-core.js'
import type { IndexEndpoint } from '../worker-core.js'

const MESSAGES = 'messages'
const SCHEMA = {
  content: { analyzer: 'composite', weight: 1, embed: true },
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-vector-rebuild-'))
afterAll(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

/** 起一条同线程的 core(feed 一个都不给 —— 这一条只看装配那一刻做了什么)。 */
function startCore(index: SqliteIndex, vector: VectorIndex, embedder: Embedder): {
  core: IndexWorkerCore
  dispose(): void
} {
  const channel = new MessageChannel()
  const core = new IndexWorkerCore({
    endpoint: channel.port2 as unknown as IndexEndpoint,
    index,
    feeds: [],
    schemas: { [MESSAGES]: SCHEMA },
    vector: { index: vector, embedder },
  })
  core.start()
  return {
    core,
    dispose: () => {
      core.dispose()
      channel.port1.close()
      channel.port2.close()
    },
  }
}

describe('向量那一半:空表也算「没嵌过」', () => {
  it('头对得上但一行向量都没有 → 全量排队(否则「下完就生效」在最后一米断掉)', async () => {
    const embedder = createFakeEmbedder({ synonyms: {} })
    const index = new SqliteIndex({
      path: path.join(tempRoot, 'rebuild.sqlite'),
      vector: { dims: embedder.dims },
    })
    index.setSchema(MESSAGES, SCHEMA)
    const vector = index.vector
    expect(vector).toBeDefined()
    if (vector === undefined) return

    const docs: DocPayload[] = [{
      capability: MESSAGES,
      key: 'm1',
      time: 1,
      facets: {},
      fields: { content: '身份牌已经私发四人了' },
    }]
    index.replaceKey(MESSAGES, 'm1', docs)

    /*
     * ① 第一条 Worker:头是空的 → 排队 → 嵌进去。这就是今天正常的那条路。
     */
    const first = startCore(index, vector, embedder)
    await first.core.drain()
    expect(index.readMeta('embeddingModelId')).toBe(embedder.id)
    expect(vector.size()).toBeGreaterThan(0)
    first.dispose()

    /*
     * ② 把向量表清空但**头留着** —— 逐字重现「上一条 Worker 写了头就把自己关回去了」
     *    的现场(模型没下那一形)。
     */
    vector.clear()
    expect(vector.size()).toBe(0)
    expect(index.readMeta('embeddingModelId')).toBe(embedder.id)

    /*
     * ③ 新 Worker:头对得上,可表是空的 —— 照样全量排队,嵌回来。
     */
    const second = startCore(index, vector, embedder)
    await second.core.drain()
    expect(vector.size()).toBeGreaterThan(0)
    expect((await second.core.status()).vector).toBe('ready')
    second.dispose()

    /*
     * ④ 反面:头对得上、表也不空 = 什么都不用做。`refolds` 一次都没涨(它数的是
     *    真的折过几次),而向量表原样。
     */
    const before = vector.size()
    const third = startCore(index, vector, embedder)
    await third.core.drain()
    expect(vector.size()).toBe(before)
    expect(third.core.status().refolds).toBe(0)
    third.dispose()

    index.close()
  })
})
