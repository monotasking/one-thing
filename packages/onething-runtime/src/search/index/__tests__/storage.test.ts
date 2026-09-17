/**
 * **检索占了多少地方**,以及**什么时候该收拾一下**(2026-09-18)。
 *
 * 用户 09-17:「我要知道搜索占得空间,不管是现在的 fts5 还是向量库。」
 *
 * 三组:
 *  ① 归类判据(纯):哪几张表算向量库 —— **问库,不抄清单**;
 *  ② 真库上的读数:四个数加起来等于 `totalBytes`;没有向量表时 `vectorBytes`
 *     **整格缺席**(与「0 字节」分得开,屏幕上一个画「—」一个画「0 MB」);
 *  ③ 收拾的判据(纯)+ Worker 那一趟真的按判据跑(optimize 与 vacuum 各自一条),
 *     以及**空闲页要在 optimize 之后再量一遍**这条施工判断。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MessageChannel } from 'node:worker_threads'
import { afterAll, describe, expect, it } from 'vitest'

import type { DocPayload } from '@onething/core/search'
import { createFakeEmbedder } from '@onething/core/search'

import { SqliteIndex } from '../sqlite-index.js'
import {
  DEFAULT_INDEX_MAINTENANCE_POLICY,
  shouldOptimizeFullText,
  shouldVacuum,
  vectorTableFamily,
} from '../storage.js'
import type { IndexMaintenanceStats } from '../storage.js'
import { IndexWorkerCore } from '../worker-core.js'
import type { IndexEndpoint, IndexWorkerCoreOptions, IndexWriteFace } from '../worker-core.js'

const MESSAGES = 'messages'
const SCHEMA = { content: { analyzer: 'composite', weight: 1, embed: true } }

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-index-storage-'))
afterAll(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

function docOf(key: string, text: string): DocPayload {
  return { capability: MESSAGES, key, time: 1, facets: {}, fields: { content: text } }
}

/* ── ① 归类:问库,不抄清单 ─────────────────────────────────────────────── */

describe('vectorTableFamily', () => {
  const names = [
    'docs', 'docs_fts_data', 'docs_fts_content', 'docs_by_key', 'edges',
    'vec_docs_384', 'vec_docs_384_info', 'vec_docs_384_vector_chunks00',
    'sqlite_autoindex_vec_docs_384_info_1',
    'sqlite_autoindex_vec_docs_384_vector_chunks00_1',
  ]

  it('虚表 + 它的影子表 + 影子表的自动索引,一个不漏一个不多', () => {
    expect(new Set(vectorTableFamily(names, ['vec_docs_384']))).toEqual(new Set([
      'vec_docs_384',
      'vec_docs_384_info',
      'vec_docs_384_vector_chunks00',
      'sqlite_autoindex_vec_docs_384_info_1',
      'sqlite_autoindex_vec_docs_384_vector_chunks00_1',
    ]))
  })

  it('库里没有向量虚表 = 一张都不算(不去猜表名)', () => {
    expect(vectorTableFamily(names, [])).toEqual([])
  })

  it('换一档嵌入器换维度 → 判据一个字不改,照样认得出', () => {
    const other = ['docs', 'vec_docs_768', 'vec_docs_768_rowids', 'sqlite_autoindex_vec_docs_768_rowids_1']
    expect(new Set(vectorTableFamily(other, ['vec_docs_768']))).toEqual(new Set([
      'vec_docs_768', 'vec_docs_768_rowids', 'sqlite_autoindex_vec_docs_768_rowids_1',
    ]))
  })

  it('名字碰巧以虚表名开头但不是它的影子表(没有那条下划线)不算', () => {
    expect(vectorTableFamily(['vec_docs_3840'], ['vec_docs_384'])).toEqual([])
  })
})

/* ── ② 真库上的读数 ─────────────────────────────────────────────────────── */

describe('SqliteIndex.storage()', () => {
  it('没有向量表时 vectorBytes 整格缺席,字面那一格就是整个库', () => {
    const file = path.join(tempRoot, 'lexical-only.sqlite')
    const index = new SqliteIndex({ path: file })
    index.setSchema(MESSAGES, SCHEMA)
    index.replaceKey(MESSAGES, 'm1', [docOf('m1', '身份牌已经私发四人了')])
    // 折回主库再量:WAL 里还压着的页在主库文件上看不见,而 `page_count` 数的是逻辑
    // 上的库 —— 两个坐标系只有 checkpoint 之后才重合(判据写在 `databaseBytes()`)。
    index.checkpointTruncate()

    const storage = index.storage()
    expect(storage.vectorBytes).toBeUndefined()
    expect('vectorBytes' in storage).toBe(false)
    expect(storage.lexicalBytes).toBeGreaterThan(0)
    expect(storage.lexicalBytes).toBe(fs.statSync(file).size)
    expect(storage.walBytes).toBe(fs.statSync(`${file}-wal`).size)
    index.close()
  })

  it('开了向量之后 vectorBytes > 0,而且字面那一格是**减出来的**(两格之和 = 库文件)', () => {
    const embedder = createFakeEmbedder({ synonyms: {} })
    const file = path.join(tempRoot, 'with-vector.sqlite')
    const index = new SqliteIndex({ path: file, vector: { dims: embedder.dims } })
    const vector = index.vector
    expect(vector).toBeDefined()
    if (vector === undefined) return
    index.setSchema(MESSAGES, SCHEMA)
    index.replaceKey(MESSAGES, 'm1', [docOf('m1', '身份牌已经私发四人了')])
    const doc = index.byKey(MESSAGES, 'm1')[0]
    expect(doc).toBeDefined()
    if (doc === undefined) return
    vector.upsert(doc.docId, 0, new Float32Array(embedder.dims).fill(0.1))
    index.checkpointTruncate()

    const storage = index.storage()
    expect(storage.vectorBytes).toBeGreaterThan(0)
    expect(storage.lexicalBytes + (storage.vectorBytes ?? 0)).toBe(fs.statSync(file).size)
    index.close()
  })
})

describe('IndexWorkerCore.storage()', () => {
  it('四个数加起来正好是 totalBytes,模型那一格由 ModelDownloader 说', async () => {
    const file = path.join(tempRoot, 'worker-storage.sqlite')
    const index = new SqliteIndex({ path: file })
    index.setSchema(MESSAGES, SCHEMA)
    index.replaceKey(MESSAGES, 'm1', [docOf('m1', '身份牌已经私发四人了')])

    // 「模型占了多少」只有一个产地:`ModelDownloader.storageBytes()`。这里用一个
    // 只答那一句的替身 —— 这一条要证的是**加法**,不是模型状态机(那有它自己的单测)。
    const model = {
      storageBytes: () => 4096,
      status: () => undefined,
      onSettled: () => () => {},
    } as unknown as IndexWorkerCoreOptions['model']
    const { core, dispose } = startCore(index, model)
    const storage = core.storage()
    expect(storage.modelBytes).toBe(4096)
    expect(storage.totalBytes).toBe(
      storage.lexicalBytes + (storage.vectorBytes ?? 0) + storage.walBytes + storage.modelBytes,
    )
    expect(storage.measuredAt).toBeGreaterThan(0)
    dispose()
    index.close()
  })

  it('管不了模型的宿主上 modelBytes = 0(缺席不是「不知道多少」,是真的没占地方)', () => {
    const index = new SqliteIndex({ path: path.join(tempRoot, 'no-model.sqlite') })
    const { core, dispose } = startCore(index)
    expect(core.storage().modelBytes).toBe(0)
    dispose()
    index.close()
  })
})

/* ── ③ 收拾:判据与那一趟 ───────────────────────────────────────────────── */

function statsOf(over: Partial<IndexMaintenanceStats> = {}): IndexMaintenanceStats {
  return { segments: 1, pageCount: 1000, freelistCount: 0, pageSize: 4096, ...over }
}

describe('收拾的判据', () => {
  it('段数够多才 optimize(健康的库一条语句都不跑)', () => {
    expect(shouldOptimizeFullText(statsOf({ segments: 7 }))).toBe(false)
    expect(shouldOptimizeFullText(statsOf({ segments: 8 }))).toBe(true)
    // 真店那一份:26 段、108 MB 陈旧数据。
    expect(shouldOptimizeFullText(statsOf({ segments: 26 }))).toBe(true)
  })

  it('空闲页够多才 VACUUM', () => {
    expect(shouldVacuum(statsOf({ freelistCount: 99 }))).toBe(false)
    expect(shouldVacuum(statsOf({ freelistCount: 100 }))).toBe(true)
  })

  it('活数据超过预算就不 VACUUM —— 少收一点地方,好过把 Worker 按住五秒', () => {
    const pageSize = 4096
    const live = DEFAULT_INDEX_MAINTENANCE_POLICY.maxVacuumBytes / pageSize
    expect(shouldVacuum(statsOf({ pageCount: live * 2, freelistCount: live, pageSize }))).toBe(true)
    expect(shouldVacuum(statsOf({ pageCount: live * 2 + 2, freelistCount: live, pageSize }))).toBe(false)
  })

  it('空库不收拾(0 页上没有比例可言)', () => {
    expect(shouldVacuum(statsOf({ pageCount: 0, freelistCount: 0 }))).toBe(false)
  })
})

describe('启动后那一次有界的收拾', () => {
  it('段数够多 → optimize;**空闲页在 optimize 之后才够** → 接着 VACUUM + checkpoint', async () => {
    const index = new SqliteIndex({ path: path.join(tempRoot, 'maintain.sqlite') })
    /*
     * 两份读数,依次交出去 —— 这就是真店那一形:optimize **之前**空闲页只有 0.5%
     * (陈旧段此刻还算活数据),optimize **之后**才是 64%。拿第一份去问 VACUUM,
     * 答案永远是「不用缩」。
     */
    const readings: IndexMaintenanceStats[] = [
      statsOf({ segments: 26, pageCount: 39395, freelistCount: 224 }),
      statsOf({ segments: 1, pageCount: 40180, freelistCount: 25558 }),
    ]
    const { face, calls } = spyIndex(index, readings)
    const { core, dispose } = startCore(face)
    await core.drain()
    await flushMicrotasks()

    expect(calls.optimize).toBe(1)
    expect(calls.vacuum).toBe(1)
    // VACUUM 在 WAL 模式下把整个新库写进 `-wal`;不截断的话收拾完反而更占地方。
    expect(calls.checkpoint).toBe(1)
    dispose()
    index.close()
  })

  it('健康的库一条语句都不跑', async () => {
    const index = new SqliteIndex({ path: path.join(tempRoot, 'healthy.sqlite') })
    const { face, calls } = spyIndex(index, [statsOf({ segments: 2, pageCount: 1000, freelistCount: 3 })])
    const { core, dispose } = startCore(face)
    await core.drain()
    await flushMicrotasks()
    expect(calls).toMatchObject({ optimize: 0, vacuum: 0, checkpoint: 0 })
    dispose()
    index.close()
  })

  it('`maintenance: false` = 这条 Worker 不收拾(「够不着」与「压根没这回事」是两件事)', async () => {
    const index = new SqliteIndex({ path: path.join(tempRoot, 'opt-out.sqlite') })
    const { face, calls } = spyIndex(index, [statsOf({ segments: 26, pageCount: 1000, freelistCount: 900 })])
    const { core, dispose } = startCore(face, undefined, false)
    await core.drain()
    await flushMicrotasks()
    expect(calls).toMatchObject({ optimize: 0, vacuum: 0 })
    dispose()
    index.close()
  })

  it('VACUUM 撞上别的进程(SQLITE_BUSY)只记一条 warn,索引照常', async () => {
    const index = new SqliteIndex({ path: path.join(tempRoot, 'busy.sqlite') })
    const { face, calls } = spyIndex(
      index,
      [statsOf({ segments: 26, pageCount: 1000, freelistCount: 900 }), statsOf({ segments: 1, pageCount: 1000, freelistCount: 900 })],
      () => { throw new Error('database is locked') },
    )
    const { core, dispose } = startCore(face)
    await core.drain()
    await flushMicrotasks()
    expect(calls.optimize).toBe(1)
    // 抛在 VACUUM 里,没有把 Worker 带走:还答得出话。
    expect(core.status().docs).toBe(0)
    dispose()
    index.close()
  })
})

/* ── 夹具 ───────────────────────────────────────────────────────────────── */

/**
 * 真的 `SqliteIndex` 外面套一层:只换掉 `maintenanceStats`(按次序交出预先备好的
 * 读数)与那三句收拾语(记一笔)。**其余一格不动** —— 于是这几条用例验的是
 * `IndexWorkerCore` 的次序与判据,而不是 SQLite 会不会 VACUUM(那是副本上量过的)。
 */
function spyIndex(
  index: SqliteIndex,
  readings: readonly IndexMaintenanceStats[],
  onVacuum?: () => void,
): { face: IndexWriteFace; calls: { optimize: number; vacuum: number; checkpoint: number } } {
  const calls = { optimize: 0, vacuum: 0, checkpoint: 0 }
  let at = 0
  const overrides: Record<string, unknown> = {
    maintenanceStats: () => readings[Math.min(at++, readings.length - 1)],
    optimizeFullText: () => { calls.optimize += 1 },
    vacuum: () => { calls.vacuum += 1; onVacuum?.() },
    checkpointTruncate: () => { calls.checkpoint += 1 },
  }
  const face = new Proxy(index, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop]
      const value = Reflect.get(target, prop, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as unknown as IndexWriteFace
  return { face, calls }
}

function startCore(
  index: IndexWriteFace,
  model?: IndexWorkerCoreOptions['model'],
  maintenance?: false,
): { core: IndexWorkerCore; dispose(): void } {
  const channel = new MessageChannel()
  const core = new IndexWorkerCore({
    endpoint: channel.port2 as unknown as IndexEndpoint,
    index,
    feeds: [],
    schemas: { [MESSAGES]: SCHEMA },
    ...(model === undefined ? {} : { model }),
    ...(maintenance === undefined ? {} : { maintenance }),
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

/** 收拾那一趟挂在 `start()` 之后的一串 promise 上 —— 让它们都跑完。 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}
