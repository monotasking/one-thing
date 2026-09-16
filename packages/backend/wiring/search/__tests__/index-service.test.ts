/**
 * 检索索引的**装配**(检索重建 S3b,`docs/design/search-index-2026-09.md`
 * §5.2 / §5.3 / §5.2b / §10 S3 行)。
 *
 * 这份文件问四件事,每一件都是「装配这一层的活」,不是索引本身的活:
 *
 *  ① **起停**:`createAppSearchService()` 把库路径 / 会话目录 / 笔记目录 / 字段表
 *     算对了没有;`dispose()` 之后订阅全摘、Worker 已停(索引再问一句就报不可用)。
 *  ② **三条订阅各一例**:账本的 append 观察者 → 刚落盘的消息立刻可搜;总线
 *     `session:renamed` → 标题跟着变;`session:deleted` → 那条会话的文档全消失。
 *  ③ **daily 懒建**:查过 daily 档之前,索引的 `feeds` 里没有笔记那一路;查过之后有。
 *  ④ 索引起不来时**不回退旧扫描**(那一条在 runtime 的能力用例里)。
 *
 * **Worker 是同线程的**:`createAppSearchService({ createWorker })` 拿装配自己算出
 * 来的那份 `workerData` 去起一条 `IndexWorkerCore`(S3a 的 `MessageChannel` 手法)。
 * 真 `worker_threads` 起不起得来是产物的事,由 `gate:search-index`(真 dist/server)
 * 与 `gate:packaged`(真 .app)证 —— 这里证的是装配。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MessageChannel } from 'node:worker_threads'

const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-search-wiring-'))
const notesDir = path.join(storeRoot, 'notes')
const sessionsDir = path.join(storeRoot, 'sessions')
fs.mkdirSync(notesDir, { recursive: true })
fs.mkdirSync(sessionsDir, { recursive: true })
const previousStorePath = process.env.ONETHING_STORE_PATH
process.env.ONETHING_STORE_PATH = storeRoot

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../../../events/event-bus.js'
import { SESSION_EVENT_TYPES } from '@onething/core/events'
import { encodeSessionLogEventLine } from '@onething/core/session'
import type { SessionLogEventRecord } from '@onething/core/session'
import { DailyNotesFeed, DAILY_FEED_ID, LedgerFeed, LEDGER_FEED_ID, IndexProjector, IndexWorkerCore, SqliteIndex, defaultDocumentFilters } from '@onething/runtime/search/index'
import type { IndexEndpoint } from '@onething/runtime/search/index'
import type { IndexWorkerData } from '@onething/runtime/search/index/worker-data'
import type { IndexWorkerHandle } from '@onething/runtime/search/index/worker-host'
import type { OnethingSearchProvidersAdapters } from '@onething/runtime/search'
import {
  broadcastSettingsChanged,
  configureSettingsEventBroadcaster,
  getSettingsEventBroadcaster,
} from '../../settings/events.js'
import { DEFAULT_SEMANTIC_MODEL_ID, type AppSettings } from '@shared/ipc/settings'

/** 总线:装配从 `getEventBus()` 拿,用例给一只真的 `EventBus`。 */
let bus = new EventBus()
vi.mock('../../../events/index.js', () => ({ getEventBus: () => bus }))

/**
 * append 观察者:装配注册的那只回调抓在手里,用例自己喊。
 *
 * **它收的是 `(sessionId, record)` 两格**(真签名就是这个,`backend/session/
 * event-log.ts`):S3b 第二轮之后装配读 `record.type` 决定这一条值不值得重折,
 * 所以用例也必须递一条真事件,不能只递会话 id。
 */
const appendObservers = new Set<(sessionId: string, record: SessionLogEventRecord) => void>()
vi.mock('../../../session/event-log.js', () => ({
  registerSessionLogEventAppendObserver: (
    observer: (sessionId: string, record: SessionLogEventRecord) => void,
  ) => {
    appendObservers.add(observer)
    return () => appendObservers.delete(observer)
  },
}))

/**
 * 取材面:装配层真正那一份要读设置 / 会话仓 / ripgrep,而这里要验的是装配的算术,
 * 所以给一份最小的。**每日笔记那一格是真的**:`resolveDailyNoteSearchDirs` 读它,
 * 而「笔记目录算对了没有」正是①要证的事之一。
 */
const stubAdapters: OnethingSearchProvidersAdapters = {
  getSessionsList: () => fs.readdirSync(sessionsDir).filter(id => fs.existsSync(path.join(sessionsDir, id, 'meta.json')))
    .map(id => ({ id, updatedAt: 200, ...JSON.parse(fs.readFileSync(path.join(sessionsDir, id, 'meta.json'), 'utf8')) })),
  iterateSessionMessages: () => [],
  getSession: () => undefined,
  getCurrentSessionId: () => undefined,
  getSettings: () => ({
    general: {
      dailyNotes: {
        enabled: true,
        directoryMode: 'custom',
        customDirectory: notesDir,
        useObsidianConfig: false,
      },
    },
  }),
  getVariablesStore: () => ({ getUserNoteDir: () => undefined, getWorkNoteDir: () => undefined }),
  listFiles: () => ({ async *[Symbol.asyncIterator]() {} }),
  listPrompts: () => [],
}
vi.mock('../adapters.js', () => ({ createAppSearchProvidersAdapters: () => stubAdapters }))

const { createAppSearchService } = await import('../index.js')

// ---- 同线程 Worker(照装配算出来的 workerData 装) -----------------------

interface SameThread {
  handle: IndexWorkerHandle
  data: IndexWorkerData
  close(): void
}

function sameThreadWorker(data: IndexWorkerData): SameThread {
  const channel = new MessageChannel()
  const index = new SqliteIndex({
    path: data.databasePath,
    ...(data.analyzerId !== undefined ? { analyzerId: data.analyzerId } : {}),
  })
  const core = new IndexWorkerCore({
    endpoint: channel.port2 as unknown as IndexEndpoint,
    index,
    feeds: [
      new LedgerFeed({
        sessionsDir: data.sessionsDir,
        projector: new IndexProjector({ includeReasoning: data.includeReasoning ?? false }),
      }),
      ...(data.notesDirs ?? []).map((dir, at) => new DailyNotesFeed({
        notesDir: dir,
        ...(at === 0 ? {} : { id: `${DAILY_FEED_ID}#${at}` }),
      })),
    ],
    filters: defaultDocumentFilters(),
    ...(data.schemas !== undefined ? { schemas: data.schemas } : {}),
    debounceMs: 5,
  })
  core.start()
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    core.dispose()
    index.close()
    channel.port1.close()
    channel.port2.close()
  }
  return {
    data,
    close,
    handle: {
      endpoint: channel.port1 as unknown as IndexEndpoint,
      onError: () => {},
      onExit: () => {},
      terminate: close,
    },
  }
}

// ---- 手写账本 -----------------------------------------------------------

const BASE_TIME = 1_780_000_000_000

/** 已经写到第几条 —— 追加行时接着排 seq(指纹的前半格就是它)。 */
const lastSeqOf = new Map<string, number>()

function writeSession(sessionId: string, text: string, name: string): void {
  const dir = path.join(sessionsDir, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  const lines = [
    { seq: 1, time: BASE_TIME, type: 'session/created', data: { sessionId } },
    {
      seq: 2,
      time: BASE_TIME + 1000,
      type: 'user/message',
      surfaceOp: 'append',
      data: { message: { id: `u-${sessionId}`, role: 'user', content: text, timestamp: BASE_TIME + 1000 } },
    },
  ] as unknown as SessionLogEventRecord[]
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.map(encodeSessionLogEventLine).join(''))
  lastSeqOf.set(sessionId, 2)
  writeMeta(sessionId, name)
}

/**
 * 真写路做的两件事:**落盘 + 同步喊一声**(`backend/session/event-log.ts` 在分配
 * 到 seq 的同一个同步段通知观察者)。用例照做同样两件,所以「装配听见之后干了
 * 什么」是真的被考到了。
 */
function appendEvent(sessionId: string, event: { type: string; data: unknown; surfaceOp?: string }): void {
  const seq = (lastSeqOf.get(sessionId) ?? 0) + 1
  lastSeqOf.set(sessionId, seq)
  const record = { seq, time: BASE_TIME + 1000 + seq, ...event } as unknown as SessionLogEventRecord
  fs.appendFileSync(path.join(sessionsDir, sessionId, 'events.jsonl'), encodeSessionLogEventLine(record))
  for (const observer of appendObservers) observer(sessionId, record)
}

function writeMeta(sessionId: string, name: string): void {
  fs.writeFileSync(path.join(sessionsDir, sessionId, 'meta.json'), JSON.stringify({
    id: sessionId, formatVersion: 2, name, createdAt: BASE_TIME, updatedAt: BASE_TIME + 2000,
  }))
}

// ---- 夹具 ---------------------------------------------------------------

let started: SameThread | undefined
let handle: Awaited<ReturnType<typeof createAppSearchService>> | undefined

/**
 * **这一轮起过的每一条 Worker**(⑤ 语义召回热生效要的账)。
 *
 * 从前这里只留最后一条(`started`),因为一次装配只起一条。热生效之后「换了几条、
 * 每一条带的是哪份 `workerData`」正是要判的东西,所以逐条记下来 —— `started` 仍然
 * 是最后那条,别处的用例一个字不用改。
 */
const spawned: SameThread[] = []

async function mount() {
  handle = await createAppSearchService({
    createWorker: data => {
      started = sameThreadWorker(data)
      spawned.push(started)
      return started.handle
    },
  })
  await handle.index?.drain()
  return handle
}

/** 等一件事成真(热生效那一路是后台的:广播是同步的,换 Worker 不是)。 */
async function waitFor(label: string, predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等不到:${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

beforeEach(() => {
  bus = new EventBus()
  appendObservers.clear()
  lastSeqOf.clear()
  spawned.length = 0
  // 单槽端口:上一条用例没还原干净(比如它中途红了)不该漏给下一条。
  configureSettingsEventBroadcaster(null)
  fs.rmSync(sessionsDir, { recursive: true, force: true })
  fs.mkdirSync(sessionsDir, { recursive: true })
  fs.rmSync(path.join(storeRoot, 'index'), { recursive: true, force: true })
  for (const entry of fs.readdirSync(notesDir)) fs.rmSync(path.join(notesDir, entry), { force: true })
})

afterEach(async () => {
  await handle?.dispose()
  handle = undefined
  // 起过的每一条都要收尸 —— 热生效那一路一轮里会起两三条。
  for (const worker of spawned) worker.close()
  spawned.length = 0
  started = undefined
  configureSettingsEventBroadcaster(null)
  vi.restoreAllMocks()
})

afterAll(() => {
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

async function search(query: string, category: string) {
  const response = await handle!.service.query({ query, category, limit: 10 })
  return response.results
}

describe('search authorization before retrieval, preview and actions', () => {
  const alice = { transport: 'http' as const, ownerUid: 'alice', workspaceId: 'tenant-a' }
  const bob = { transport: 'http' as const, ownerUid: 'bob', workspaceId: 'tenant-a' }
  async function seedOwners() {
    for (const [id, ownerUserId, ownerWorkspaceId] of [
      ['alice-a', 'alice', 'tenant-a'], ['alice-b', 'alice', 'tenant-b'], ['bob-a', 'bob', 'tenant-a'],
    ]) {
      writeSession(id, 'sharedneedle private body', 'sharedneedle title')
      const metaPath = path.join(sessionsDir, id, 'meta.json')
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
      fs.writeFileSync(metaPath, JSON.stringify({ ...meta, ownerUserId, ownerWorkspaceId, workspaceId: 'same-product-space', workingDirectory: path.join(storeRoot, id) }))
    }
    await mount()
    const { configureHostLocalTrust } = await import('../../../server/host-trust.js')
    const restore = configureHostLocalTrust({ origin: 'loopback-server' })
    const { searchRpcHandlers } = await import('../../../rpc/domains/search.js')
    return { rpc: searchRpcHandlers, restore }
  }
  function messageItem(id: string) {
    return { capability: 'messages', id: `msg:${id}:m1`, target: { kind: 'message', payload: { sessionId: id, messageId: 'm1' } } }
  }

  it('restricts the real SQL query by owner and tenant before retrieving matching bodies', async () => {
    const { rpc, restore } = await seedOwners()
    try {
      const response = await rpc.query({ query: 'sharedneedle', category: 'messages', limit: 20 }, alice)
      expect(response.results.map(result => result.sessionId)).toEqual(['alice-a'])
      expect(response.total).toBe(1)
      const escaped = await rpc.query({ query: 'sharedneedle', category: 'messages', filters: { sessionId: 'bob-a', spaceId: 'same-product-space' } }, alice)
      expect(escaped.results).toEqual([])
      // The product-space filter is not an identity or tenant override.
      const otherTenant = await rpc.query({ query: 'sharedneedle', category: 'messages' }, { ...alice, workspaceId: 'tenant-b' })
      expect(otherTenant.results.map(result => result.sessionId)).toEqual(['alice-b'])
    } finally { restore() }
  })

  it('preflights all preview targets and actions before reading any body or invoking a provider', async () => {
    const { rpc, restore } = await seedOwners()
    const body = vi.spyOn(stubAdapters, 'iterateSessionMessages').mockReturnValue([{ id: 'm1', role: 'user', content: 'allowed body' }])
    const action = vi.fn(async () => {})
    handle!.service.registry.get('messages')!.invoke = action
    try {
      const denied = await rpc.preview({ items: [messageItem('alice-a'), messageItem('bob-a')], mode: 'batch' }, alice)
      expect(denied.success).toBe(false)
      expect(body).not.toHaveBeenCalled()
      expect((await rpc.invoke({ capability: 'messages', actionId: 'open', items: [messageItem('bob-a')] }, alice)).success).toBe(false)
      expect(action).not.toHaveBeenCalled()
      expect((await rpc.preview({ items: [messageItem('alice-a')] }, alice)).success).toBe(true)
      expect(body).toHaveBeenCalledWith('alice-a')
      expect((await rpc.invoke({ capability: 'messages', actionId: 'open', items: [messageItem('alice-a')] }, alice)).success).toBe(true)
      expect(action).toHaveBeenCalledTimes(1)
      const metaPath = path.join(sessionsDir, 'alice-a', 'meta.json')
      fs.writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(metaPath, 'utf8')), ownerUserId: 'bob' }))
      body.mockClear()
      expect((await rpc.preview({ items: [messageItem('alice-a')] }, alice)).success).toBe(false)
      expect(body).not.toHaveBeenCalled()
    } finally { restore() }
  })

  it('uses the caller of tool expansion, even when another caller populated the result memo', async () => {
    const { restore } = await seedOwners()
    const { createAppSearchToolAdapters } = await import('../tool-adapters.js')
    const tools = createAppSearchToolAdapters(handle!.service)
    const principal = { kind: 'user' as const, id: 'alice', sessionId: 'alice-a', spaceId: 'same-product-space', executionContext: { userId: 'alice', workspaceId: 'tenant-a' } }
    const body = vi.spyOn(stubAdapters, 'iterateSessionMessages')
    try {
      const page = await tools.search({ query: 'sharedneedle', capability: 'messages', limit: 10 }, principal)
      await expect(tools.preview(page.hits[0].ref, { ...principal, id: 'bob', sessionId: 'bob-a', executionContext: { userId: 'bob', workspaceId: 'tenant-a' } })).rejects.toThrow('Session not found')
      expect(body).not.toHaveBeenCalled()
    } finally { restore() }
  })

  it('rejects arbitrary file roots and symlinked daily paths before enumeration, reads or writes', async () => {
    const { rpc, restore } = await seedOwners()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'search-private-'))
    fs.writeFileSync(path.join(outside, 'secret.md'), 'private')
    fs.symlinkSync(outside, path.join(notesDir, 'escape'))
    const listFiles = vi.spyOn(stubAdapters, 'listFiles')
    const read = vi.spyOn(fs.promises, 'readFile')
    const write = vi.spyOn(fs.promises, 'writeFile')
    const dailyPreview = vi.spyOn(handle!.service.registry.get('daily')!, 'preview')
    const dailyInvoke = vi.spyOn(handle!.service.registry.get('daily')!, 'invoke')
    try {
      expect((await rpc.query({ query: 'secret', category: 'files', filters: { dir: outside } }, alice)).success).toBe(false)
      expect(listFiles).not.toHaveBeenCalled()
      const escaped = path.join(notesDir, 'escape', 'secret.md')
      expect((await rpc.preview({ items: [{ capability: 'daily', id: `daily:${escaped}`, target: { kind: 'daily', payload: { filePath: escaped } } }] }, { transport: 'ipc' })).success).toBe(false)
      expect(read.mock.calls.some(call => String(call[0]).endsWith('secret.md'))).toBe(false)
      expect(dailyPreview).not.toHaveBeenCalled()
      expect((await rpc.invoke({ capability: 'daily', actionId: `create-daily:${encodeURIComponent(path.join(outside, 'new.md'))}`, items: [] }, { transport: 'ipc' })).success).toBe(false)
      expect(write).not.toHaveBeenCalled()
      expect(dailyInvoke).not.toHaveBeenCalled()
      expect(fs.existsSync(path.join(outside, 'new.md'))).toBe(false)
      const allowed = path.join(notesDir, 'allowed.md')
      expect((await rpc.invoke({ capability: 'daily', actionId: `create-daily:${encodeURIComponent(allowed)}`, items: [] }, { transport: 'ipc' })).success).toBe(true)
      expect(fs.existsSync(allowed)).toBe(true)
      expect((await rpc.preview({ items: [{ capability: 'daily', id: `daily:${allowed}`, target: { kind: 'daily', payload: { filePath: allowed } } }] }, { transport: 'ipc' })).success).toBe(true)
    } finally { restore(); fs.rmSync(outside, { recursive: true, force: true }) }
  })
})

// ---- ① 起停 ------------------------------------------------------------

describe('createAppSearchService:起停', () => {
  it('workerData 全部由 store 路径派生:库 / 会话目录 / 笔记目录 / 字段表', async () => {
    writeSession('s1', '身份牌已经私发四人了', '开局')
    await mount()

    const data = started!.data
    expect(data.databasePath).toBe(path.join(storeRoot, 'index', 'search.v1.sqlite'))
    expect(data.sessionsDir).toBe(sessionsDir)
    // 笔记目录来自设置(同一个产地:`resolveDailyNoteSearchDirs`),不是硬编码。
    expect(data.notesDirs).toEqual([notesDir])
    // 字段表来自三份 manifest 的 schema —— 装配不认识任何一格字段名。
    expect(Object.keys(data.schemas ?? {}).sort()).toEqual(['chats', 'daily', 'messages'])
    // `embed` 那一格也要搬过来 —— 少了它嵌入队列会永远空着(施工时踩过,
    // `vec_docs` 零行而 `vectorPending` 一直是 0)。
    expect(data.schemas?.messages?.content).toEqual({ analyzer: 'composite', weight: 1, embed: true })
    expect(data.schemas?.messages?.attachments).toEqual({ analyzer: 'composite', weight: 1 })
    // 语义召回:缺省关(拍点壬 a),模型目录由 store 派生。
    expect(data.semantic?.enabled).toBe(false)
    expect(data.semantic?.modelsDir).toBe(path.join(storeRoot, 'models', 'embeddings'))
    // 库文件真的建出来了(目录不存在时装配自己建)。
    expect(fs.existsSync(data.databasePath)).toBe(true)
  })

  it('启动校对把盘上已有的会话折进去了', async () => {
    writeSession('s1', '身份牌已经私发四人了', '开局')
    await mount()
    expect((await search('身份牌', 'messages')).map(result => result.sessionId)).toEqual(['s1'])
    expect((await search('开局', 'chats')).map(result => result.id)).toEqual(['chat:s1'])
  })

  it('dispose:三条订阅全摘、Worker 停了(再问索引就报不可用)', async () => {
    writeSession('s1', '身份牌已经私发四人了', '开局')
    const mounted = await mount()
    expect(appendObservers.size).toBe(1)

    // 「总线上还有没有听众」`EventBus` 不对外报,所以判据换成**行为**:dispose 之后
    // 往总线上发同样两条事件,索引一次都不该被叫到。
    const enqueue = vi.spyOn(mounted.index!, 'enqueue')
    await mounted.dispose()
    handle = undefined

    // 订阅全摘:观察者表空了,总线上那两条也不再落到索引上。
    expect(appendObservers.size).toBe(0)
    await bus.emit('s1', { type: SESSION_EVENT_TYPES.SESSION_RENAMED, name: '别的名字' } as never)
    bus.emitGlobal({ type: 'session:deleted', sessionId: 's1' } as never)
    expect(enqueue).not.toHaveBeenCalled()

    // Worker 停了 —— 再问一句是**拒绝**,不是一份空答案。
    await expect(mounted.index!.status()).rejects.toThrow()
  })
})

// ---- ② 三条订阅 --------------------------------------------------------

describe('createAppSearchService:三条订阅(§5.2 / §5.3)', () => {
  it('append 观察者:刚落盘的消息一喊就可搜', async () => {
    await mount()
    expect(await search('私发', 'messages')).toEqual([])

    // 真写入口做的两件事:落盘 + 同步喊一声。这里手动做同样两件。
    writeSession('s2', '身份牌已经私发四人了', '第二局')
    for (const observer of appendObservers) {
      observer('s2', { seq: 2, type: 'user/message' } as unknown as SessionLogEventRecord)
    }
    await handle!.index!.drain()

    expect((await search('私发', 'messages')).map(result => result.sessionId)).toEqual(['s2'])
  })

  it('总线 session:renamed:标题跟着变(账本一个字节都没动)', async () => {
    writeSession('s1', '身份牌已经私发四人了', '开局')
    await mount()
    expect((await search('开局', 'chats')).map(result => result.title)).toEqual(['开局'])

    // 改名只改 meta.json —— 指纹的后半格(mtime)因此变了。
    writeMeta('s1', '收官')
    await bus.emit('s1', { type: SESSION_EVENT_TYPES.SESSION_RENAMED, name: '收官' } as never)
    await handle!.index!.drain()

    expect(await search('开局', 'chats')).toEqual([])
    expect((await search('收官', 'chats')).map(result => result.id)).toEqual(['chat:s1'])
  })

  it('总线 session:deleted:那条会话的文档全消失(目录已经没了 = 指纹 undefined)', async () => {
    writeSession('s1', '身份牌已经私发四人了', '开局')
    await mount()
    expect(await search('身份牌', 'messages')).toHaveLength(1)

    fs.rmSync(path.join(sessionsDir, 's1'), { recursive: true, force: true })
    bus.emitGlobal({ type: 'session:deleted', sessionId: 's1' } as never)
    await handle!.index!.drain()

    expect(await search('身份牌', 'messages')).toEqual([])
    expect(await search('开局', 'chats')).toEqual([])
  })
})

// ---- ②b 白做工:流式期间不重折 ----------------------------------------

/**
 * **观察者只对「会改文档」的事件喊**(S3b 第二轮修,设计 §5.2 表下那一句)。
 *
 * 病:worker 的增量是「整键重折」(读整份 `events.jsonl` 再折一遍),而观察者从前
 * 对**每条**追加事件都喊 —— `assistant/chunks` 每 16ms 一批,于是一轮回复期间同一
 * 条会话被重读重折几十遍,折出来的文档**逐字相同**(流式中不产助手文档)。不卡主
 * 线程,但长会话上 Worker 会饱和。
 *
 * 判据是 `affectsIndexedDocuments`,住投影器;装配与目录监视只读它。读数是
 * `status().refolds` —— 真正折过几次(指纹没变那一支的提前返回不算)。
 */
describe('createAppSearchService:流式期间不白折(§5.2 + projector 的 INDEX_DOCUMENT_EFFECTS)', () => {
  const chunk = (seq: number) => ({
    type: 'assistant/chunks',
    data: {
      runId: 'r-1',
      requestIndex: 0,
      messageId: 'a-1',
      partIndex: 0,
      kind: 'text',
      time0: BASE_TIME + 2000,
      dt: [0],
      text: [`第 ${seq} 片`],
    },
  })

  it('20 条 assistant/chunks 一次都不折;run/end 折一次', async () => {
    writeSession('s1', '身份牌已经私发四人了', '开局')
    await mount()
    const before = (await handle!.index!.status()).refolds

    // 一轮流式回复:开 run,然后 20 批 delta。每一批都真的落盘(指纹跟着变),
    // 每一批都真的喊一声 —— 与真写路逐字同款。
    appendEvent('s1', {
      type: 'run/start',
      data: { runId: 'r-1', kind: 'chat', assistantMessageId: 'a-1', timestamp: BASE_TIME + 2000 },
    })
    for (let i = 0; i < 20; i += 1) appendEvent('s1', chunk(i))
    await handle!.index!.drain()

    expect((await handle!.index!.status()).refolds - before).toBe(0)
    // 而且流式中真的搜不到半条(§5.2「流式中不搜半条」)——「没折」不是「折了但没写」。
    expect(await search('第 3 片', 'messages')).toEqual([])

    // `run/end` 才是助手文档的产地:一条事件,一次重折。
    appendEvent('s1', { type: 'run/end', data: { runId: 'r-1', outcome: 'completed' } })
    await handle!.index!.drain()

    expect((await handle!.index!.status()).refolds - before).toBe(1)
    expect((await search('第 3 片', 'messages')).map(result => result.sessionId)).toEqual(['s1'])
    // 折得干干净净:没有一把钥匙进错误表。
    expect((await handle!.index!.status()).errors).toEqual([])
  })

  it('用户消息照旧一喊就折(过滤的是白做工,不是增量本身)', async () => {
    writeSession('s1', '身份牌已经私发四人了', '开局')
    await mount()
    const before = (await handle!.index!.status()).refolds

    appendEvent('s1', {
      type: 'user/message',
      surfaceOp: 'append',
      data: { message: { id: 'u-2', role: 'user', content: '把名单再念一遍', timestamp: BASE_TIME + 3000 } },
    })
    await handle!.index!.drain()

    expect((await handle!.index!.status()).refolds - before).toBe(1)
    expect((await search('名单', 'messages')).map(result => result.sessionId)).toEqual(['s1'])
  })
})

// ---- ③ daily 懒建 ------------------------------------------------------

describe('createAppSearchService:daily 是懒的(§5.2b「文件树 lazy(首次查询才建)」)', () => {
  it('查过 daily 档之前 feeds 里没有笔记那一路,查过之后有', async () => {
    writeSession('s1', '身份牌已经私发四人了', '开局')
    fs.writeFileSync(path.join(notesDir, '2026-09-05.md'), '# 2026-09-05\n\n身份牌那件事今天办完了\n')
    await mount()

    // 账本是 eager,一开始就在;笔记那一路还没被纳入。
    const before = await handle!.index!.status()
    expect(before.feeds).toEqual([LEDGER_FEED_ID])

    // 第一次查 daily:纳入 + 排队建,这一发本身可能还查不到(懒建的诚实代价)。
    await search('身份牌', 'daily')
    const after = await handle!.index!.status()
    expect(after.feeds).toContain(DAILY_FEED_ID)

    // 建完之后才有结果。
    await handle!.index!.drain()
    expect((await search('身份牌', 'daily')).map(result => result.filePath))
      .toEqual([path.join(notesDir, '2026-09-05.md')])
  })

  it('只查 messages 不会把笔记那一路拉起来 —— 懒是按能力认的,不是按时间', async () => {
    writeSession('s1', '身份牌已经私发四人了', '开局')
    fs.writeFileSync(path.join(notesDir, '2026-09-05.md'), '身份牌那件事今天办完了\n')
    await mount()

    await search('身份牌', 'messages')
    await search('开局', 'chats')
    await handle!.index!.drain()
    expect((await handle!.index!.status()).feeds).toEqual([LEDGER_FEED_ID])
  })
})

// ---- ⑤ 语义召回开关:保存即生效 ----------------------------------------

/**
 * **开关保存即生效**(2026-09-17;结清 `docs/design/search-index-2026-09.md` §13
 * 「S7 待拍(三)——开关保存后不热生效」)。
 *
 * 判的是**装配这一层**的四件事,与嵌入器、sqlite-vec、模型统统无关(那几样由
 * `semantic.test.ts` 与 `gate:search-index` ⑧ 判):
 *
 *  ① 关 → 开:换了一条 Worker,新那条拿到的 `workerData.semantic.enabled` 是真;
 *  ② 开 → 关:再换一条,又回到假;
 *  ③ 同值不换:一次「只改了主题」的保存不该把索引掀掉重起;
 *  ④ 换 Worker 的那个空窗里来的查询**不抛** —— 它们排队等新的那条(候诊室)。
 *
 * **入口是产品那条真路**:`broadcastSettingsChanged` 就是 `settings` 域保存成功后
 * 喊的那一声。**反证**:把 `createAppSearchService` 里 `watchSettingsChanged(...)`
 * 那一行注掉 → ① 当场红(只起过一条 Worker)。
 */
describe('createAppSearchService:语义召回开关保存即生效', () => {
  const settingsWith = (enabled: boolean): AppSettings =>
    ({ search: { semantic: { enabled, modelId: DEFAULT_SEMANTIC_MODEL_ID } } }) as unknown as AppSettings

  it('① 关 → 开:换一条 Worker,新那条的 semantic.enabled 为真;词法索引一个字没丢', async () => {
    writeSession('s1', '身份牌已经私发四人了', '开局')
    await mount()
    expect(spawned.length).toBe(1)
    expect(spawned[0]!.data.semantic?.enabled).toBe(false)

    // 产品那条真路:设置域保存成功之后喊的正是这一声。
    broadcastSettingsChanged(settingsWith(true))
    await waitFor('第二条 Worker 起来了', () => spawned.length === 2)

    expect(spawned[1]!.data.semantic?.enabled).toBe(true)
    expect(spawned[1]!.data.semantic?.modelId).toBe(DEFAULT_SEMANTIC_MODEL_ID)
    // 换的只是 Worker:库路径、会话目录、字段表逐格照旧。
    expect(spawned[1]!.data.databasePath).toBe(spawned[0]!.data.databasePath)
    expect(spawned[1]!.data.schemas).toEqual(spawned[0]!.data.schemas)

    // 词法那一路一个字不受影响 —— 同一个库文件,刚才那句照旧搜得到。
    await handle!.index!.drain()
    expect((await search('身份牌', 'messages')).map(result => result.sessionId)).toEqual(['s1'])
  })

  it('② 开 → 关:再换一条,回到 enabled: false', async () => {
    writeSession('s1', '身份牌已经私发四人了', '开局')
    await mount()

    broadcastSettingsChanged(settingsWith(true))
    await waitFor('开了', () => spawned.length === 2)
    broadcastSettingsChanged(settingsWith(false))
    await waitFor('关了', () => spawned.length === 3)

    expect(spawned[2]!.data.semantic?.enabled).toBe(false)
    await handle!.index!.drain()
    expect((await search('身份牌', 'messages')).map(result => result.sessionId)).toEqual(['s1'])
  })

  it('③ 同值不换:一次「只改了主题」的保存不掀 Worker', async () => {
    writeSession('s1', '身份牌已经私发四人了', '开局')
    await mount()

    // 直接问那一手:答 false = 一个字都没做。
    await expect(handle!.applySemantic(settingsWith(false))).resolves.toBe(false)
    // 经广播再走一遍(设置里别的格改了的那一形)。
    broadcastSettingsChanged(settingsWith(false))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(spawned.length).toBe(1)
  })

  it('④ 换 Worker 的空窗里来的查询不抛 —— 排队等新的那条', async () => {
    writeSession('s1', '身份牌已经私发四人了', '开局')
    await mount()

    // 故意不 await:这一发查询正落在「旧的停了、新的还没起」那一格里。
    const swapping = handle!.applySemantic(settingsWith(true))
    const during = search('身份牌', 'messages')
    await swapping
    await expect(during).resolves.toBeTruthy()
    expect((await during).map(result => result.sessionId)).toEqual(['s1'])
    expect(spawned.length).toBe(2)
  })

  it('dispose 之后设置推送端口还给上一位,而且不再换 Worker', async () => {
    const hostBroadcasts: unknown[] = []
    const hostBroadcaster = (event: unknown): void => void hostBroadcasts.push(event)
    configureSettingsEventBroadcaster(hostBroadcaster)

    writeSession('s1', '身份牌已经私发四人了', '开局')
    const mounted = await mount()
    // 串联不是占槽:宿主那条推送照样收得到。
    broadcastSettingsChanged(settingsWith(true))
    await waitFor('换过一条', () => spawned.length === 2)
    expect(hostBroadcasts.length).toBe(1)

    await mounted.dispose()
    handle = undefined
    expect(getSettingsEventBroadcaster()).toBe(hostBroadcaster)

    broadcastSettingsChanged(settingsWith(false))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(hostBroadcasts.length).toBe(2)
    expect(spawned.length).toBe(2)
  })
})
