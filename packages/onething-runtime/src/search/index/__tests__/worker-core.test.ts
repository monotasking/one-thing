/**
 * 索引服务的端到端(临时 store,同线程 Worker):
 *
 * - ② 发一条用户消息立刻可搜(enqueue → drain → query)
 * - ④ 改名 → 指纹变 → 标题可搜;归档 → facet 变;删目录 → 指纹 undefined → 墓碑
 * - ⑤ 目录监视:另一个「进程」直接往文件尾 append(不经观察者)→ 500ms 内折进
 * - ⑥ 折坏隔离:一个会话的账本写坏一行 → 它记 error、其它两个照搜
 * - ⑦ 检查点:关闭再打开只补差的键(用计数证)
 *
 * 以及 §11 S3 的三条反证(**用注入点拆,不改产品代码**):
 * 摘目录监视 → ⑤ 红;run/end 前建文档 → ③ 红;折坏不隔离 → ⑥ 红。
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { DocPayload, DocumentFeed, QueryNode } from '@onething/core/search'

import { LedgerFeed } from '../ledger-feed.js'
import { IndexProjector } from '../projector.js'
import { defaultDocumentFilters } from '../filters.js'
import { SearchIndexService } from '../service.js'
import type { IndexSearchResult } from '../worker-core.js'
import {
  BASE_TIME,
  INDEX_SCHEMAS,
  LedgerWriter,
  MESSAGE_CAPABILITY,
  SESSION_CAPABILITY,
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

function newStore(): TempStore {
  const store = createTempStore()
  stores.push(store)
  return store
}

/** 一个词的 AND 查询(严格档)。 */
function termQuery(...words: string[]): QueryNode {
  if (words.length === 1) return { type: 'term', text: words[0]!, range: { start: 0, end: words[0]!.length } }
  return {
    type: 'and',
    children: words.map(word => ({ type: 'term' as const, text: word, range: { start: 0, end: word.length } })),
  }
}

interface Harness {
  service: SearchIndexService
  worker: SameThreadWorker
  search(capability: string, ...words: string[]): Promise<IndexSearchResult>
  keys(capability: string, ...words: string[]): Promise<string[]>
}

function mount(store: TempStore, options: {
  feeds?: readonly DocumentFeed<string>[]
  projector?: IndexProjector
  /** 反证用:把目录监视摘掉 */
  withoutDirectoryWatch?: boolean
  indexPath?: string
} = {}): Harness {
  const feeds = options.feeds ?? [options.withoutDirectoryWatch === true
    ? withoutDirectoryWatch(new LedgerFeed({
      sessionsDir: store.sessionsDir,
      ...(options.projector !== undefined ? { projector: options.projector } : {}),
    }))
    : new LedgerFeed({
      sessionsDir: store.sessionsDir,
      ...(options.projector !== undefined ? { projector: options.projector } : {}),
    })]

  const worker = createSameThreadWorker({
    indexPath: options.indexPath ?? store.indexPath,
    feeds,
    filters: defaultDocumentFilters(),
    debounceMs: 5,
  })
  workers.push(worker)
  const service = new SearchIndexService({ createWorker: () => worker.handle })
  services.push(service)
  service.start()

  const search = async (capability: string, ...words: string[]): Promise<IndexSearchResult> => {
    await service.drain()
    return service.search({
      capability,
      fields: Object.fromEntries(Object.entries(INDEX_SCHEMAS[capability]!)
        .map(([field, spec]) => [field, spec.weight])),
      ast: termQuery(...words),
      limit: 50,
      offset: 0,
    })
  }
  return {
    service,
    worker,
    search,
    keys: async (capability, ...words) => (await search(capability, ...words)).docs.map(doc => doc.key).sort(),
  }
}

/**
 * **反证的注入点**:同一个 feed,`subscribe` 只挂注入的两条适配器,目录监视那条摘掉。
 * 产品代码一个字不改 —— 拆的是装配。
 */
function withoutDirectoryWatch(feed: LedgerFeed): DocumentFeed<string> {
  return {
    id: feed.id,
    capabilities: feed.capabilities,
    policy: feed.policy,
    keys: () => feed.keys(),
    fingerprint: key => feed.fingerprint(key),
    documentsOf: key => feed.documentsOf(key),
    subscribe: () => () => {},
  }
}

describe('索引服务 端到端', () => {
  it('② 发一条用户消息立刻可搜', async () => {
    const store = newStore()
    const dir = path.join(store.sessionsDir, 's1')
    const writer = writeTypicalSession(store, { sessionId: 's1' })
    writeMeta(dir, 's1', { name: '开局', workspaceId: 'w1' })

    const harness = mount(store)
    expect(await harness.keys(MESSAGE_CAPABILITY, '身份牌')).toEqual(['s1:u-s1'])

    // 新来一条 —— 观察者那条路就是「往队列里喊一声 key」。
    writer.appendToFile({
      type: 'user/message',
      surfaceOp: 'append',
      data: { message: { id: 'u2', role: 'user', content: '刚发的这句要立刻搜得到', timestamp: BASE_TIME + 9000 } },
    })
    await harness.service.enqueue('ledger', 's1')
    expect(await harness.keys(MESSAGE_CAPABILITY, '立刻')).toEqual(['s1:u2'])
  })

  it('④ 改名 → 标题可搜;归档 → facet 变;删目录 → 墓碑', async () => {
    const store = newStore()
    const dir = path.join(store.sessionsDir, 's1')
    writeTypicalSession(store, { sessionId: 's1' })
    writeMeta(dir, 's1', { name: '原来的标题', workspaceId: 'w1' })

    const harness = mount(store)
    expect(await harness.keys(SESSION_CAPABILITY, '原来')).toEqual(['s1'])
    expect(await harness.keys(SESSION_CAPABILITY, '崭新')).toEqual([])

    writeMeta(dir, 's1', { name: '崭新的标题', workspaceId: 'w1' })
    const later = new Date(Date.now() + 5000)
    fs.utimesSync(path.join(dir, 'meta.json'), later, later)
    await harness.service.enqueue('ledger', 's1')
    expect(await harness.keys(SESSION_CAPABILITY, '崭新')).toEqual(['s1'])
    expect(await harness.keys(SESSION_CAPABILITY, '原来')).toEqual([])

    // 归档:文档还在(拍点丙「搜得到带徽」),facet 翻真。
    writeMeta(dir, 's1', { name: '崭新的标题', workspaceId: 'w1', isArchived: true })
    const later2 = new Date(Date.now() + 10_000)
    fs.utimesSync(path.join(dir, 'meta.json'), later2, later2)
    await harness.service.enqueue('ledger', 's1')
    const archived = await harness.search(SESSION_CAPABILITY, '崭新')
    expect(archived.docs).toHaveLength(1)
    expect(archived.docs[0]!.facets.archived).toBe(true)

    // 删目录:指纹 undefined → 墓碑,消息与标题一起没了。
    fs.rmSync(dir, { recursive: true, force: true })
    await harness.service.enqueue('ledger', 's1')
    expect(await harness.keys(SESSION_CAPABILITY, '崭新')).toEqual([])
    expect(await harness.keys(MESSAGE_CAPABILITY, '身份牌')).toEqual([])
    expect(harness.worker.index.isTombstoned(SESSION_CAPABILITY, 's1')).toBe(true)
  })

  it('⑤ 目录监视:另一个「进程」直接 append(不经观察者)也折得进来', async () => {
    const store = newStore()
    const dir = path.join(store.sessionsDir, 's1')
    const writer = writeTypicalSession(store, { sessionId: 's1' })
    writeMeta(dir, 's1', { name: 'x' })

    const harness = mount(store)
    await harness.service.drain()

    // 「另一个进程」= 直接往文件尾追一行,一次 enqueue 都不发。
    writer.appendToFile({
      type: 'user/message',
      surfaceOp: 'append',
      data: { message: { id: 'other', role: 'user', content: '别的进程写下的一句话', timestamp: BASE_TIME + 9000 } },
    })

    await waitFor(async () => (await harness.keys(MESSAGE_CAPABILITY, '别的进程')).length === 1, 4000)
    expect(await harness.keys(MESSAGE_CAPABILITY, '别的进程')).toEqual(['s1:other'])
  }, 15_000)

  it('⑥ 折坏隔离:一本坏账本记 error,其它两条照搜', async () => {
    const store = newStore()
    for (const id of ['s1', 's2']) {
      writeTypicalSession(store, { sessionId: id })
      writeMeta(path.join(store.sessionsDir, id), id, { name: `好会话 ${id}` })
    }
    // 第三条:折的时候抛(投影器拿到一条 data 缺失的事件)。写坏尾行不够 ——
    // 解码器**只跳过**半行(那是它的容错口径),所以现场要造在「折」这一步。
    const brokenDir = path.join(store.sessionsDir, 's3')
    const broken = new LedgerWriter(brokenDir)
    broken.append({ type: 'user/message', surfaceOp: 'append', data: { message: { id: 'b1', role: 'user', content: '坏账本里的话', timestamp: BASE_TIME } } })
    broken.write()
    writeMeta(brokenDir, 's3', { name: '坏会话' })

    const exploding = new IndexProjector()
    const original = exploding.project.bind(exploding)
    exploding.project = input => {
      if (input.sessionId === 's3') throw new Error('boom: projection failed')
      return original(input)
    }

    const harness = mount(store, { projector: exploding })
    await harness.service.drain()

    const status = await harness.service.status()
    expect(status.errors.map(entry => entry.key)).toEqual(['s3'])
    expect(status.errors[0]!.message).toContain('boom')
    // 其它两条照搜。
    expect(await harness.keys(MESSAGE_CAPABILITY, '身份牌')).toEqual(['s1:u-s1', 's2:u-s2'])
    // 坏的那条一份文档都没有,检查点也作废了(下次校对会再试)。
    expect(await harness.keys(MESSAGE_CAPABILITY, '坏账本')).toEqual([])
    expect(harness.worker.index.readCheckpoint('ledger', 's3')).toBeUndefined()
  })

  it('⑦ 检查点:关闭再打开只补差的那一把钥匙', async () => {
    const store = newStore()
    for (const id of ['s1', 's2', 's3']) {
      writeTypicalSession(store, { sessionId: id })
      writeMeta(path.join(store.sessionsDir, id), id, { name: id })
    }

    const counted = new Map<string, number>()
    const countingProjector = (): IndexProjector => {
      const projector = new IndexProjector()
      const original = projector.project.bind(projector)
      projector.project = input => {
        counted.set(input.sessionId, (counted.get(input.sessionId) ?? 0) + 1)
        return original(input)
      }
      return projector
    }

    const first = mount(store, { projector: countingProjector() })
    await first.service.drain()
    expect([...counted.keys()].sort()).toEqual(['s1', 's2', 's3'])
    await first.service.dispose()
    services.splice(services.indexOf(first.service), 1)
    counted.clear()

    // s2 变了(账本长了一行),s1 / s3 一个字节没动。
    const writer = new LedgerWriter(path.join(store.sessionsDir, 's2'))
    fs.appendFileSync(
      path.join(store.sessionsDir, 's2', 'events.jsonl'),
      `${JSON.stringify({ seq: 500, time: BASE_TIME + 99_000, type: 'user/message', surfaceOp: 'append', data: { message: { id: 'later', role: 'user', content: '第二次开机之前多出来的一句', timestamp: BASE_TIME } } })}\n`,
    )
    void writer

    const second = mount(store, { projector: countingProjector() })
    await second.service.drain()
    expect([...counted.keys()]).toEqual(['s2'])
    expect(await second.keys(MESSAGE_CAPABILITY, '多出来')).toEqual(['s2:later'])
  })

  it('脱敏过滤器在写路径上 —— 密钥不进倒排也不进正文', async () => {
    const store = newStore()
    const dir = path.join(store.sessionsDir, 's1')
    const writer = new LedgerWriter(dir)
    writer.append({
      type: 'user/message',
      surfaceOp: 'append',
      data: { message: { id: 'm1', role: 'user', content: '钥匙是 sk-abcdefghijklmnopqrstuvwxyz012345 记一下', timestamp: BASE_TIME } },
    })
    writer.write()
    writeMeta(dir, 's1', { name: 'x' })

    const harness = mount(store)
    const result = await harness.search(MESSAGE_CAPABILITY, '钥匙')
    expect(result.docs).toHaveLength(1)
    expect(result.docs[0]!.fields.content).toBe('钥匙是 <redacted:apikey> 记一下')
    expect(await harness.keys(MESSAGE_CAPABILITY, 'abcdefghijklmnopqrstuvwxyz012345')).toEqual([])
  })
})

describe('§11 S3 反证(拆掉即红)', () => {
  it('摘掉目录监视 → ⑤ 那条红(别的进程写的搜不到)', async () => {
    const store = newStore()
    const dir = path.join(store.sessionsDir, 's1')
    const writer = writeTypicalSession(store, { sessionId: 's1' })
    writeMeta(dir, 's1', { name: 'x' })

    const harness = mount(store, { withoutDirectoryWatch: true })
    await harness.service.drain()
    writer.appendToFile({
      type: 'user/message',
      surfaceOp: 'append',
      data: { message: { id: 'other', role: 'user', content: '别的进程写下的一句话', timestamp: BASE_TIME + 9000 } },
    })

    const reached = await waitFor(
      async () => (await harness.keys(MESSAGE_CAPABILITY, '别的进程')).length === 1,
      1500,
      false,
    )
    expect(reached).toBe(false)
  }, 15_000)

  it('run/end 之前就建文档 → ③ 那条红(流式中出了半条)', async () => {
    const store = newStore()
    const dir = path.join(store.sessionsDir, 's1')
    writeTypicalSession(store, { sessionId: 's1', endRun: false })
    writeMeta(dir, 's1', { name: 'x' })

    // 基线:助手那条不出。
    const strict = mount(store)
    expect(await strict.keys(MESSAGE_CAPABILITY, '索引重建')).toEqual([])

    // 反证:换一只「不等 run/end」的投影器(装配处替换,产品代码不动)。
    const eager = new IndexProjector()
    const original = eager.project.bind(eager)
    eager.project = input => {
      const docs = original(input)
      docs.push({
        capability: MESSAGE_CAPABILITY,
        key: `${input.sessionId}:a-s1`,
        time: BASE_TIME,
        facets: { sessionId: input.sessionId, spaceId: '', role: 'assistant', archived: false, time: BASE_TIME },
        fields: { content: '索引重建大约五秒,期间还能查旧数据' },
      } satisfies DocPayload)
      return docs
    }
    const store2 = newStore()
    fs.cpSync(store.sessionsDir, store2.sessionsDir, { recursive: true })
    const loose = mount(store2, { projector: eager })
    expect(await loose.keys(MESSAGE_CAPABILITY, '索引重建')).toEqual(['s1:a-s1'])
  })

  it('折坏不隔离 → ⑥ 那条红(一本坏账本带走整批)', async () => {
    const store = newStore()
    for (const id of ['s1', 's2']) {
      writeTypicalSession(store, { sessionId: id })
      writeMeta(path.join(store.sessionsDir, id), id, { name: id })
    }
    const brokenDir = path.join(store.sessionsDir, 's3')
    const broken = new LedgerWriter(brokenDir)
    broken.append({ type: 'user/message', surfaceOp: 'append', data: { message: { id: 'b1', role: 'user', content: '坏账本', timestamp: BASE_TIME } } })
    broken.write()
    writeMeta(brokenDir, 's3', { name: '坏会话' })

    // 「不隔离」= feed 的 documentsOf 在**枚举**那一步就抛,而枚举不在 refold 的
    // try 里…… 它当然在。所以反证只能拆掉 refold 的 try/catch —— 这里用一只
    // 在 `keys()` 上抛的 feed 模拟「异常越过了隔离边界」:整批校对当场中断,
    // s1 / s2 一份文档都建不出来。
    const feed = new LedgerFeed({ sessionsDir: store.sessionsDir })
    const unisolated: DocumentFeed<string> = {
      id: feed.id,
      capabilities: feed.capabilities,
      policy: feed.policy,
      // eslint-disable-next-line require-yield
      keys: async function* () { throw new Error('boom: enumeration failed') },
      fingerprint: key => feed.fingerprint(key),
      documentsOf: key => feed.documentsOf(key),
      subscribe: () => () => {},
    }
    const harness = mount(store, { feeds: [unisolated] })
    await harness.service.drain()
    expect(await harness.keys(MESSAGE_CAPABILITY, '身份牌')).toEqual([])
  })
})

/** 轮询等一个条件成立;超时返回 `timeoutValue`(缺省抛)。 */
async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  timeoutValue?: boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (timeoutValue !== undefined) return timeoutValue
  throw new Error(`condition not met within ${timeoutMs}ms`)
}
