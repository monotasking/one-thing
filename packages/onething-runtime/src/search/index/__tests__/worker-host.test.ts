/**
 * ⑩ Worker host:一次崩重起并**从检查点续**,两次连崩变 `mode: 'error'`。
 *
 * 设计 §5.3 末段 + §13 留账那一条(停了之后不回退旧扫描,壳画「没搜成」)。
 * 「从检查点续」这里是**真的**:第二条 Worker 开的是同一个库文件,它的启动校对
 * 只补差的键 —— 用 `documentsOf` 的调用计数证。
 */
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { DocPayload, DocumentFeed, QueryNode } from '@onething/core/search'

import { LedgerFeed } from '../ledger-feed.js'
import { SearchIndexService } from '../service.js'
import { IndexWorkerHost, IndexWorkerUnavailableError } from '../worker-host.js'
import {
  INDEX_SCHEMAS,
  MESSAGE_CAPABILITY,
  createSameThreadWorker,
  createTempStore,
  writeMeta,
  writeTypicalSession,
} from './helpers.js'
import type { SameThreadWorker, TempStore } from './helpers.js'

const stores: TempStore[] = []
const spawned: SameThreadWorker[] = []
afterEach(() => {
  for (const worker of spawned.splice(0)) worker.handle.terminate()
  for (const store of stores.splice(0)) store.dispose()
})

function newStore(): TempStore {
  const store = createTempStore()
  stores.push(store)
  return store
}

const askQuery: QueryNode = { type: 'term', text: '身份牌', range: { start: 0, end: 3 } }

function messageFields(): Record<string, number> {
  return Object.fromEntries(Object.entries(INDEX_SCHEMAS[MESSAGE_CAPABILITY]!)
    .map(([field, spec]) => [field, spec.weight]))
}

/** 每次「起 Worker」都数一遍它折了哪些键。 */
function countingFeed(sessionsDir: string, folded: string[]): DocumentFeed<string> {
  const feed = new LedgerFeed({ sessionsDir })
  return {
    id: feed.id,
    capabilities: feed.capabilities,
    policy: feed.policy,
    keys: () => feed.keys(),
    fingerprint: key => feed.fingerprint(key),
    documentsOf: (key): AsyncIterable<DocPayload> => {
      folded.push(key)
      return feed.documentsOf(key)
    },
    subscribe: () => () => {},
  }
}

describe('IndexWorkerHost 崩溃与重起', () => {
  it('崩一次:重起、从检查点续(只补差的键),在飞的请求被拒不是挂住', async () => {
    const store = newStore()
    for (const id of ['s1', 's2']) {
      writeTypicalSession(store, { sessionId: id })
      writeMeta(path.join(store.sessionsDir, id), id, { name: id })
    }

    const folded: string[] = []
    const service = new SearchIndexService({
      createWorker: () => {
        const worker = createSameThreadWorker({
          indexPath: store.indexPath,
          feeds: [countingFeed(store.sessionsDir, folded)],
          debounceMs: 5,
        })
        spawned.push(worker)
        return worker.handle
      },
    })
    service.start()
    await service.drain()
    expect(folded.sort()).toEqual(['s1', 's2'])
    const before = await service.search({
      capability: MESSAGE_CAPABILITY, fields: messageFields(), ast: askQuery, limit: 10, offset: 0,
    })
    expect(before.docs).toHaveLength(2)

    // 崩一次。在飞的请求要被**拒掉**,不是永远挂着。
    folded.length = 0
    const inFlight = service.status()
    spawned[0]!.crash()
    await expect(inFlight).rejects.toBeInstanceOf(IndexWorkerUnavailableError)

    // 重起之后:第二条 Worker 开同一个库,检查点还在 → 一把钥匙都不用重折。
    await service.drain()
    expect(folded).toEqual([])
    const after = await service.search({
      capability: MESSAGE_CAPABILITY, fields: messageFields(), ast: askQuery, limit: 10, offset: 0,
    })
    expect(after.docs.map(doc => doc.key).sort()).toEqual(before.docs.map(doc => doc.key).sort())
    expect((await service.status()).mode).toBe('owner')

    await service.dispose()
  })

  it('连崩两次:不再重起,status.mode = error,后续请求当场拒', async () => {
    const store = newStore()
    writeTypicalSession(store, { sessionId: 's1' })
    writeMeta(path.join(store.sessionsDir, 's1'), 's1', { name: 's1' })

    let built = 0
    const service = new SearchIndexService({
      createWorker: () => {
        built += 1
        const worker = createSameThreadWorker({
          indexPath: store.indexPath,
          feeds: [countingFeed(store.sessionsDir, [])],
          debounceMs: 5,
        })
        spawned.push(worker)
        return worker.handle
      },
    })
    service.start()
    await service.drain()
    expect(built).toBe(1)

    spawned[0]!.crash()
    expect(built).toBe(2)
    // 第二条**还没答过任何一次成功往返**就崩了 —— 这才叫「连续」。
    spawned[1]!.crash()
    expect(built).toBe(2)

    expect(await service.status()).toEqual({
      mode: 'error', docs: 0, pending: 0, refolds: 0, building: false, generation: 0, errors: [], feeds: [],
    })
    await expect(service.search({
      capability: MESSAGE_CAPABILITY, fields: messageFields(), ast: askQuery, limit: 10, offset: 0,
    })).rejects.toBeInstanceOf(IndexWorkerUnavailableError)

    await service.dispose()
  })

  it('中间成功过一次就不算「连续」—— 计数清零,第二次崩照样重起', async () => {
    const store = newStore()
    writeTypicalSession(store, { sessionId: 's1' })
    writeMeta(path.join(store.sessionsDir, 's1'), 's1', { name: 's1' })

    let built = 0
    const host = new IndexWorkerHost(() => {
      built += 1
      const worker = createSameThreadWorker({
        indexPath: store.indexPath,
        feeds: [countingFeed(store.sessionsDir, [])],
        debounceMs: 5,
      })
      spawned.push(worker)
      return worker.handle
    })
    host.start()
    await host.drain()

    spawned[0]!.crash()
    expect(built).toBe(2)
    await host.drain() // 一次成功往返 → 计数清零
    spawned[1]!.crash()
    expect(built).toBe(3)
    expect(host.stopped).toBe(false)

    await host.dispose()
  })
})
