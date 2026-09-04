/**
 * Search Everywhere — 装配。
 *
 * 设计:docs/design/search-index-2026-09.md §3 落位表最后一行 / §5.2(改名 / 归档 /
 * 删除不经账本,靠总线与指纹)/ §5.3(增量挂在同步观察者上)/ §10 S2·S3 行。
 *
 * 这个文件就是「加一类 = 一个文件 + **一行注册**」里的那一行住的地方。S3b 之后它
 * 做六件事:
 *  ① 起 `SearchIndexService` —— 一条 Worker,库在 `<store>/index/search.v1.sqlite`;
 *  ② 把**三条订阅**接上:进程内 append 观察者(毫秒级)、总线的 `session:renamed`
 *     与 `session:deleted`。三条都只喊一声 sessionId,不带内容(§5.2 / §5.3);
 *  ③ 用宿主的适配器造一份带六个内置能力的 `SearchService`(能力清单来自
 *     `@onething/runtime/search/capabilities` 的那张表,这里不点名任何一类);
 *  ④ 把已在册的插件供给方接成 `remote` 能力(§4.2 第四行);
 *  ⑤ 把服务装进进程单槽(`@onething/runtime/search/service-bound`)——
 *     `rpc/domains/search.ts` 从那里读;
 *  ⑥ 返回**一个** disposer,装配层 `own()` 它。
 *
 * ## 为什么观察者挂在**主线程**这一侧
 *
 * `registerSessionLogEventAppendObserver` 与总线都住这个包里,而 Worker 是另一条
 * 线程、拿不到它们。所以主线程收到「这条会话变了」之后只做一件事:
 * `indexService.enqueue('ledger', sessionId)` —— 一次结构化克隆,微秒级,主线程上
 * 零 IO、零分析器、零 sqlite(§5.3 原话)。`LedgerFeed` 自己那两个注入口
 * (`subscribeAppend` / `subscribeMeta`)在真宿主下**用不上**:它住在 Worker 里,
 * 那一侧靠的是目录监视(为了另一个进程写的账本,§5.6)。
 *
 * ## 为什么它是 async
 *
 * 笔记目录要问 `resolveDailyNoteSearchDirs`(要读 Obsidian 的 `daily-notes.json`),
 * 而目录是 `workerData` 的一部分 —— 起线程那一刻就定死了。所以装配在这里等一次
 * 文件读(毫秒级),而不是起完 Worker 再想办法把目录塞进去。
 *
 * ## dispose 的次序:先解订阅,再停 Worker
 *
 * 派工单写的是「先停 Worker、再解订阅」。这里**反过来**,理由是竞态:先停 Worker
 * 的话,还挂着的观察者下一条事件会往一只已经没有的 Worker 上发 `enqueue`,那是一
 * 条必然被拒的 Promise、而且没人接 —— 未处理的拒绝。先摘掉三条订阅,之后就再没有
 * 人往队列里放东西,停 Worker 是一件安静的事。库跟着 Worker 一起关(句柄在那边)。
 */

import { SESSION_EVENT_TYPES } from '@onething/core/events'
import type { CapabilityManifest } from '@onething/core/search'
import {
  createOnethingSearchService,
  resolveDailyNoteSearchDirs,
  type OnethingSearchProvidersAdapters,
  type OnethingSearchService,
} from '@onething/runtime/search'
import {
  chatsSearchManifest,
  dailySearchManifest,
  messagesSearchManifest,
  type SearchIndexQueryFace,
} from '@onething/runtime/search/capabilities'
import { LEDGER_FEED_ID, SearchIndexService, affectsIndexedDocuments } from '@onething/runtime/search/index'
import type { IndexWorkerData } from '@onething/runtime/search/index/worker-data'
import type { IndexWorkerHandle } from '@onething/runtime/search/index/worker-host'
import { configureOnethingSearchService } from '@onething/runtime/search/service-bound'
import { getOnethingSessionsDir, getOnethingStorePath } from '@onething/runtime/storage/paths'
import fs from 'node:fs'
import path from 'node:path'
import { getEventBus } from '../../events/index.js'
import { registerSessionLogEventAppendObserver } from '../../session/event-log.js'
import { getLogger } from '../logging/index.js'
import { createAppSearchProvidersAdapters } from './adapters.js'
import { syncPluginSearchCapabilities } from './plugin-search-registry.js'
import { createSearchWorkerFactory, resolveSearchWorkerPath } from './worker.js'

export { createDailyNote, executeSearch } from './providers.js'
export { createSearchWorkerFactory, resolveSearchWorkerPath } from './worker.js'

const log = getLogger('search')

/** 库文件。`v1` 是**格式**版本,不是产品版本:换了形状就换个文件名,旧的删掉即可。 */
export const SEARCH_INDEX_FILENAME = 'search.v1.sqlite'

/** `<store>/index/search.v1.sqlite`。经 `getOnethingStorePath()` 派生,不硬编码。 */
export function getOnethingSearchIndexPath(): string {
  return path.join(getOnethingStorePath(), 'index', SEARCH_INDEX_FILENAME)
}

export interface AppSearchServiceHandle {
  service: OnethingSearchService
  /** 索引服务;这台宿主起不来 Worker 时是 `undefined`。 */
  index: SearchIndexService | undefined
  dispose(): Promise<void>
}

/**
 * 三条索引型能力的自述。**这里不点名任何一格字段**:字段表读的是各能力自己的
 * `manifest.schema`。加第四条索引型能力 = 在这张表里加一行。
 */
const INDEXED_MANIFESTS: readonly CapabilityManifest[] = [
  chatsSearchManifest,
  dailySearchManifest,
  messagesSearchManifest,
]

function schemasOf(manifests: readonly CapabilityManifest[]): IndexWorkerData['schemas'] {
  const schemas: NonNullable<IndexWorkerData['schemas']> = {}
  for (const manifest of manifests) {
    if (manifest.schema === undefined) continue
    schemas[manifest.id] = Object.fromEntries(
      Object.entries(manifest.schema).map(([field, spec]) => [field, {
        analyzer: spec.analyzer,
        weight: spec.weight,
      }]),
    )
  }
  return schemas
}

/**
 * 索引起不来时的问答面 —— 空结果 + `mode: 'error'`。
 *
 * 有意不叫 "empty":它说的不是「索引里没有东西」,而是「这台宿主没有索引」。壳读
 * `status.mode` 画的是「没搜成」,不是「0 条」(§9 / §13:不回退到旧扫描)。
 */
export function unavailableIndexFace(): SearchIndexQueryFace {
  return {
    search: async () => ({ hits: [], total: 0, docs: [], generation: 0 }),
    status: async () => ({
      mode: 'error',
      docs: 0,
      pending: 0,
      refolds: 0,
      building: false,
      generation: 0,
      errors: [],
      feeds: [],
    }),
  }
}

export interface AppSearchServiceOverrides {
  /**
   * 谁来造 Worker。**缺省是真 `worker_threads.Worker`**(按宿主产物解析路径);
   * `workerData` 无论如何都由装配算 —— 传进来的只是「拿这份数据去造一条 Worker」
   * 的那一步。
   *
   * 用例传它是为了对着**装配算出来的那份 workerData** 起一条同线程的
   * `IndexWorkerCore`(S3a 的 `MessageChannel` 手法):这样测到的是「装配把
   * 库路径 / 会话目录 / 笔记目录 / 字段表算对了没有」,而不是 `worker_threads`
   * 会不会起线程 —— 后者由 `gate:search-index` 与 `gate:packaged` 在真产物上证。
   */
  createWorker?(data: IndexWorkerData): IndexWorkerHandle
}

export async function createAppSearchService(
  overrides: AppSearchServiceOverrides = {},
): Promise<AppSearchServiceHandle> {
  const adapters = createAppSearchProvidersAdapters()
  const indexService = await startSearchIndexService(adapters, overrides)
  const unsubscribes = indexService === undefined ? [] : subscribeLedger(indexService)

  const service = createOnethingSearchService(adapters, {
    index: indexService ?? unavailableIndexFace(),
    // §6.4b 的兜底核验:候选逃出可见范围是「能力实现有 bug」的证据,记 warn 不抛。
    warn: (message, detail) => log.warn(message, detail),
  })
  const unsyncPlugins = syncPluginSearchCapabilities(service)
  const restoreSlot = configureOnethingSearchService(service)

  return {
    service,
    index: indexService,
    async dispose() {
      restoreSlot()
      unsyncPlugins()
      // 先摘订阅(见文件头「dispose 的次序」),再停 Worker。
      for (const unsubscribe of unsubscribes.reverse()) {
        try {
          unsubscribe()
        } catch (error) {
          log.warn('search index unsubscribe failed', { err: error })
        }
      }
      if (indexService !== undefined) await indexService.dispose()
    },
  }
}

/** 起 Worker + 服务。产物不在(vitest / 没构建过)= `undefined`,如实降级。 */
async function startSearchIndexService(
  adapters: OnethingSearchProvidersAdapters,
  overrides: AppSearchServiceOverrides,
): Promise<SearchIndexService | undefined> {
  const workerPath = overrides.createWorker === undefined ? resolveSearchWorkerPath() : ''
  if (workerPath === undefined) return undefined

  const databasePath = getOnethingSearchIndexPath()
  try {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true })
  } catch (error) {
    log.error('cannot create the index directory; search index disabled', {
      fields: { databasePath },
      err: error,
    })
    return undefined
  }

  // 笔记目录问不出来不是错(没配笔记目录是常态);问的过程炸了才是,那时装账本
  // 那一路照旧,笔记那一路缺席。
  let notesDirs: string[] = []
  try {
    notesDirs = await resolveDailyNoteSearchDirs(adapters)
  } catch (error) {
    log.warn('cannot resolve daily-note directories; the daily feed is not installed', { err: error })
  }

  const workerData: IndexWorkerData = {
    databasePath,
    sessionsDir: getOnethingSessionsDir(),
    ...(notesDirs.length > 0 ? { notesDirs } : {}),
    schemas: schemasOf(INDEXED_MANIFESTS),
    // 分析器换了实现就换这个串 —— 库头对不上就丢库重建(§5.4)。
    analyzerId: 'composite',
  }

  const override = overrides.createWorker
  const service = new SearchIndexService({
    createWorker: override === undefined
      ? createSearchWorkerFactory(workerPath, workerData)
      : () => override(workerData),
  })
  service.start()
  log.info('search index worker started', {
    fields: { workerPath, databasePath, notesDirs: notesDirs.length },
  })
  return service
}

/**
 * 三条订阅(§5.2 / §5.3)。每条只喊一声 sessionId。
 *
 * **append 观察者不是每条事件都喊**(S3b 第二轮):worker 的增量是「整键重折」
 * (读整份 `events.jsonl` 再折),而 `assistant/chunks` 每 16ms 一批 —— 照单全喊
 * 就是一轮回复期间把同一条会话重读重折几十遍,折出来的文档逐字相同。判据是
 * `affectsIndexedDocuments`,它住**投影器**(「事件 → 文档」那张表的产地);
 * 这里只读它,一个事件名都不认识。加一种会改文档的事件不用碰这个文件。
 *
 * 改名 / 删除那两条走总线,与账本行无关,照旧无条件喊。
 */
function subscribeLedger(index: SearchIndexService): Array<() => void> {
  const touch = (sessionId: string): void => {
    void index.enqueue(LEDGER_FEED_ID, sessionId).catch((error: unknown) => {
      // 索引跟不上不该把产品写路带下水:记一条 debug 就够(状态面上 pending / mode
      // 已经把「索引不健康」这件事说清楚了)。
      log.debug('index enqueue rejected', { sessionId, err: error })
    })
  }

  const bus = getEventBus()
  return [
    // ① 进程内 append 观察者:一条事件在分配到 seq 的同一个同步段就到这里。
    //    只有会改文档的那些值得重折(见上面那段)。
    registerSessionLogEventAppendObserver((sessionId, record) => {
      if (affectsIndexedDocuments(record)) touch(sessionId)
    }),
    // ② 改名:会话事件,发在被改名的那条会话上(`rpc/domains/sessions.ts`)。
    //    账本一个字节都没变,变的是 `meta.json` 的 mtime —— 指纹的后半格。
    bus.onAnySession(SESSION_EVENT_TYPES.SESSION_RENAMED, envelope => touch(envelope.sessionId)),
    // ③ 删除:全局事件(`shared/events/global-events.ts`)。会话目录已经没了,
    //    `LedgerFeed.fingerprint` 答 `undefined`,那一把钥匙的文档全打墓碑。
    bus.onGlobal('session:deleted', envelope => touch(envelope.event.sessionId)),
  ]
}
