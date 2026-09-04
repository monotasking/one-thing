/**
 * `createSqliteLexicalRetriever` —— S3b 要塞进 `indexedCapability` 的那一路召回。
 *
 * 这里守三件事:候选的形由**能力**给(`toCandidate`,core 不发明 target kind)、
 * 打分只读 `manifest.ranking` 那格**数据**(半衰 / facet 加权 / 某字段命中置顶)、
 * 索引停了就**抛**(§13 留账:不回退旧扫描,让那一组带 error 上去)。
 */
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { CapabilityManifest, SearchContext, SearchQuery } from '@onething/core/search'
import { PIN_FIELD_HIT_OFFSET, parse } from '@onething/core/search'

import { LedgerFeed } from '../ledger-feed.js'
import { SearchIndexService, createSqliteLexicalRetriever } from '../service.js'
import { IndexWorkerUnavailableError } from '../worker-host.js'
import {
  createSameThreadWorker,
  createTempStore,
  writeMeta,
  writeTypicalSession,
} from './helpers.js'
import type { SameThreadWorker, TempStore } from './helpers.js'

const stores: TempStore[] = []
const workers: SameThreadWorker[] = []
const services: SearchIndexService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose()
  for (const worker of workers.splice(0)) worker.handle.terminate()
  for (const store of stores.splice(0)) store.dispose()
})

const MANIFEST: CapabilityManifest = {
  id: 'messages',
  labelKey: 'search.capability.messages',
  icon: 'MessagesSquare',
  kind: 'indexed',
  budget: { default: 20, timeoutMs: 2000 },
  order: 5,
  schema: {
    content: { analyzer: 'composite', weight: 1 },
    attachments: { analyzer: 'composite', weight: 1.5 },
  },
  ranking: { boosts: { role: { user: 1.1 } }, pinFieldHit: 'attachments' },
}

function context(): SearchContext {
  return {
    principal: { kind: 'user', id: 'u1' },
    surface: 'test',
    spaceId: 'w1',
    signal: new AbortController().signal,
    now: Date.now(),
  }
}

function mount(): { service: SearchIndexService; worker: SameThreadWorker; store: TempStore } {
  const store = createTempStore()
  stores.push(store)
  writeTypicalSession(store, { sessionId: 's1' })
  writeMeta(path.join(store.sessionsDir, 's1'), 's1', { name: '开局', workspaceId: 'w1' })

  const worker = createSameThreadWorker({
    indexPath: store.indexPath,
    feeds: [new LedgerFeed({ sessionsDir: store.sessionsDir })],
    debounceMs: 5,
  })
  workers.push(worker)
  const service = new SearchIndexService({ createWorker: () => worker.handle })
  services.push(service)
  service.start()
  return { service, worker, store }
}

function query(raw: string): SearchQuery {
  return parse(raw)
}

describe('createSqliteLexicalRetriever', () => {
  it('候选的形由能力给;分数经 applyRanking 读 manifest.ranking', async () => {
    const { service } = mount()
    await service.drain()

    const retriever = createSqliteLexicalRetriever({
      manifest: MANIFEST,
      service,
      toCandidate: ({ doc, score }) => ({
        capability: doc.capability,
        id: doc.key,
        title: doc.fields.content ?? '',
        score,
        time: doc.time,
        // 这个 kind 是**能力自己定义**的,core 里没有它 —— 换一个能力就换一个形。
        target: { kind: 'message', payload: { sessionId: doc.facets.sessionId, key: doc.key } },
        facets: doc.facets,
      }),
    })

    const page = await retriever.retrieve(query('身份牌'), context(), { limit: 10, offset: 0 })
    expect(page.total).toBe(1)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.target).toEqual({
      kind: 'message',
      payload: { sessionId: 's1', key: 's1:u-s1' },
    })
    // role=user 的加权乘上去了(1.1),而没有 attachments 字段所以没有置顶常数。
    expect(page.items[0]!.score).toBeGreaterThan(0)
    expect(page.items[0]!.score).toBeLessThan(PIN_FIELD_HIT_OFFSET)
  })

  it('ctx.debug 时带 explain(命中词与命中字段)', async () => {
    const { service } = mount()
    await service.drain()
    const retriever = createSqliteLexicalRetriever({
      manifest: MANIFEST,
      service,
      toCandidate: ({ doc, score }) => ({
        capability: doc.capability, id: doc.key, title: '', score,
        target: { kind: 'message', payload: {} },
      }),
    })
    const page = await retriever.retrieve(query('身份牌'), { ...context(), debug: true }, { limit: 10, offset: 0 })
    expect(page.items[0]!.explain).toMatchObject({ fields: ['content'] })
  })

  it('索引停了就抛 —— 不回退旧扫描,让这一组带 error 上去(§13 留账)', async () => {
    const { service, worker } = mount()
    await service.drain()
    const retriever = createSqliteLexicalRetriever({
      manifest: MANIFEST,
      service,
      toCandidate: ({ doc, score }) => ({
        capability: doc.capability, id: doc.key, title: '', score,
        target: { kind: 'message', payload: {} },
      }),
    })
    // 连崩两次 → host 不再重起。
    worker.crash()
    const second = workers[workers.length - 1]
    if (second !== undefined && second !== worker) second.crash()
    await expect(retriever.retrieve(query('身份牌'), context(), { limit: 10, offset: 0 }))
      .rejects.toBeInstanceOf(IndexWorkerUnavailableError)
  })
})
