/**
 * Search Everywhere — 装配。
 *
 * 设计:docs/design/search-index-2026-09.md §3 落位表最后一行 / §5.2(改名 / 归档 /
 * 删除不经账本,靠总线与指纹)/ §5.3(增量挂在同步观察者上)/ §10 S2·S3 行。
 *
 * 这个文件就是「加一类 = 一个文件 + **一行注册**」里的那一行住的地方。S3b 之后它
 * 做六件事(2026-09-17 多了第 ⑦ 件 —— 订「设置刚保存过」,语义召回那一格改了就换
 * 一条 Worker,见 `semanticWorkerConfig` 与 `watchSettingsChanged`):
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
import { configureSearchVisibilityPort } from '@onething/runtime/search/capabilities'
import { configureOnethingSearchService } from '@onething/runtime/search/service-bound'
import { configureSearchToolAdapters } from '@onething/runtime/toolkit'
import { getOnethingSessionsDir, getOnethingStorePath } from '@onething/runtime/storage/paths'
import { DEFAULT_SEMANTIC_MODEL_ID } from '@shared/ipc/settings.js'
import type { AppSettings } from '@shared/ipc/settings.js'
import fs from 'node:fs'
import path from 'node:path'
import { getEventBus } from '../../events/index.js'
import { getSettings } from '../../stores/settings.js'
import { registerSessionLogEventAppendObserver } from '../../session/event-log.js'
import {
  configureSettingsEventBroadcaster,
  getSettingsEventBroadcaster,
  type SettingsEvent,
  type SettingsEventBroadcaster,
} from '../settings/events.js'
import { getLogger } from '../logging/index.js'
import { createAppSearchProvidersAdapters } from './adapters.js'
import { syncPluginSearchCapabilities } from './plugin-search-registry.js'
import { createAppSearchToolAdapters } from './tool-adapters.js'
import { createAppSearchVisibilityPort } from './visibility.js'
import { createAppSearchAuthorization } from './authorization.js'
import { createSearchWorkerFactory, resolveSearchWorkerPath } from './worker.js'

export { AGENT_TOOL_SURFACE, createAppSearchToolAdapters } from './tool-adapters.js'
export { createAppSearchVisibilityPort, visibleSessionIdsFor, VISIBLE_SESSIONS_CAP } from './visibility.js'
export { configureAppSearchProviders, createDailyNote } from './providers.js'
export { invokePluginSearchAction, PLUGIN_SEARCH_ACTION_PREFIX } from './plugin-search-registry.js'
export { createSearchWorkerFactory, resolveSearchWorkerPath } from './worker.js'

const log = getLogger('search')

/** 库文件。`v1` 是**格式**版本,不是产品版本:换了形状就换个文件名,旧的删掉即可。 */
export const SEARCH_INDEX_FILENAME = 'search.v1.sqlite'

/** `<store>/index/search.v1.sqlite`。经 `getOnethingStorePath()` 派生,不硬编码。 */
export function getOnethingSearchIndexPath(): string {
  return path.join(getOnethingStorePath(), 'index', SEARCH_INDEX_FILENAME)
}

/**
 * 嵌入模型落哪儿:`<store>/models/embeddings/`(§15.3)。
 *
 * 与 `resources/models/`(随包发的 kws 模型)是两回事 —— 那一份是产物,这一份是
 * 用户开了开关之后下载的用户数据,所以住 store 里、与 `index/` 同级。
 */
export function getOnethingEmbeddingModelsDir(): string {
  return path.join(getOnethingStorePath(), 'models', 'embeddings')
}

/**
 * 设置 → Worker 的语义召回那一格(拍点壬 a:**默认关**)。
 *
 * **保存即生效**(2026-09-17;它结清了 §13 留账「S7 待拍(三)——开关保存后不热
 * 生效」)。`workerData` 确实在 `new Worker(...)` 那一刻定死,所以改开关就是**换一条
 * Worker**;留账里担心的「要一格装配级可变状态」并没有发生 —— 那一格状态挂在
 * `createAppSearchService` 这次调用的闭包里,而这次调用的产物已经被
 * `backend.own(() => searchService.dispose())` 收着了。模块作用域一个 `let` 都没多,
 * `assembly:gate` 读的正是行首的 `let`。
 *
 * 换 Worker 的两条硬规矩(细节在 `IndexWorkerHost.restart()`):**先停旧的再起新的**
 * (两条 Worker 同开一个库就是两个写者),**换的过程里查询排队不拒**。
 * 词法索引文件一个字节不动;关掉时向量表**留着不删**(下次开省一次重嵌)。
 */
export function semanticWorkerConfig(settings: AppSettings): IndexWorkerData['semantic'] {
  const semantic = settings.search?.semantic
  // **门的口子**:`ONETHING_SEARCH_EMBEDDER=fake` 换掉 modelId。它只换「用哪个嵌入
  // 器」,开关本身照旧读设置 —— 门要的是「不下载 110MB 也能把整条链跑一遍」
  // (§15.5),不是一个能绕过默认关的后门。
  const override = process.env.ONETHING_SEARCH_EMBEDDER
  return {
    enabled: semantic?.enabled === true,
    modelId: override || semantic?.modelId || DEFAULT_SEMANTIC_MODEL_ID,
    modelsDir: getOnethingEmbeddingModelsDir(),
    ...proxyWorkerConfig(settings),
  }
}

/**
 * 网络那一格照抄进 `workerData`(2026-09-17)。
 *
 * **为什么要抄**:Worker 是另一条线程,它的全局 `fetch` 与主进程那只受管 fetch
 * (`provider-binding/bound-fetch.ts`)毫无关系。09-17 用户真机事故:设置里代理开着、
 * provider 通得好好的,语义召回的模型却一个字节也下不来。判据与手法住 Worker 那一侧
 * (`runtime/search/index/worker-network.ts`),装配这一侧只负责把数据递过去 ——
 * 递的是**设置里那一份**,不是这里现算的什么东西。
 *
 * 关着 / 没填 URL = 不递(缺席 = 直连)。
 */
function proxyWorkerConfig(settings: AppSettings): Pick<NonNullable<IndexWorkerData['semantic']>, 'proxy'> {
  const proxy = settings.network?.proxy
  if (proxy?.enabled !== true || !proxy.url) return {}
  return {
    proxy: {
      enabled: true,
      url: proxy.url,
      ...(proxy.bypassRules !== undefined ? { bypassRules: proxy.bypassRules } : {}),
    },
  }
}

export interface AppSearchServiceHandle {
  service: OnethingSearchService
  /** 索引服务;这台宿主起不来 Worker 时是 `undefined`。 */
  index: SearchIndexService | undefined
  /**
   * 设置变了就把这一份递进来。**与当前生效的那一份逐格相同 = 一个字都不做**;
   * 不同就换一条 Worker(答 `true`)。没有索引的宿主上恒 `false`。
   *
   * 它挂在**实例**上而不是一个模块槽:这个句柄本身已经被
   * `backend.own(() => searchService.dispose())` 收着了,状态跟着它生灭。
   */
  applySemantic(settings: AppSettings): Promise<boolean>
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
      // **逐格搬,不 spread**:`workerData` 要过结构化克隆,而 manifest 里还有
      // 函数(`visibility`)。加一格要在这里加一行 —— S7 的 `embed` 就是这么加的,
      // 少了它嵌入队列会永远空着(施工时真踩过:`vec_docs` 零行,`vectorPending`
      // 却一直是 0,因为「该嵌哪几个字段」答的是空表)。
      Object.entries(manifest.schema).map(([field, spec]) => [field, {
        analyzer: spec.analyzer,
        weight: spec.weight,
        ...(spec.embed === true ? { embed: true } : {}),
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
    // 向量路同理:`'off'` 说的是「这台宿主没有语义召回」,不是「零条相似的」。
    vectorSearch: async () => ({ hits: [], docs: [], generation: 0, unavailable: 'off' as const }),
    status: async () => ({
      mode: 'error',
      docs: 0,
      pending: 0,
      refolds: 0,
      building: false,
      generation: 0,
      errors: [],
      feeds: [],
      vector: 'off',
      vectorPending: 0,
      vectorExtension: 'missing',
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
  /*
   * `access.fileRoots` **只喂授权**(`assertPath`),不喂扫盘 —— 09-07 事故第一条。
   *
   * 这里曾经有一行 `adapters.getSearchDirectories = access.fileRoots`,把「谁准看
   * 哪些路径」那张全集接成了「这一次去哪几个目录扫」。真机读数:492 条会话 →
   * 31 个扫描根 → 一次搜索 31 条 `rg --files --follow --no-ignore`,扎进
   * `~/data/code`(18GB / 16 个 node_modules)的那几条三次都没有 close。
   * 扫哪儿是 files 能力自己的语义(`capabilities/files.ts` 的 `getSearchDirs`),
   * 那个端口连同这一行一起没了。
   */
  const access = createAppSearchAuthorization(adapters)
  const started = await startSearchIndexService(adapters, overrides)
  const indexService = started?.service
  const unsubscribes = indexService === undefined ? [] : subscribeLedger(indexService)

  const service = createOnethingSearchService(adapters, {
    authorization: access.authorization,
    index: indexService ?? unavailableIndexFace(),
    // §6.4b 的兜底核验:候选逃出可见范围是「能力实现有 bug」的证据,记 warn 不抛。
    warn: (message, detail) => log.warn(message, detail),
  })
  const unsyncPlugins = syncPluginSearchCapabilities(service)
  const restoreSlot = configureOnethingSearchService(service)
  // 拍点辛 a 的判据产地(`visibility.ts`)—— 装在**造服务的同一处**:两件事的
  // 生命周期必须一致,否则会出现「能力问得出范围、但问的是上一份宿主的会话表」。
  const restoreVisibility = configureSearchVisibilityPort(createAppSearchVisibilityPort())
  // §14.3:`search` 工具的适配器。工具住 runtime、从单槽里拿这一份;没装 = 那台
  // 宿主的 `search` 结构化答「不可用」,而不是抛。
  const restoreToolAdapters = configureSearchToolAdapters(createAppSearchToolAdapters(service))

  const applySemantic = async (settings: AppSettings): Promise<boolean> => {
    if (started === undefined) return false
    return await started.applySemantic(semanticWorkerConfig(settings))
  }
  // 设置面一保存就问一句。**settings 域不认识 search**(见 `watchSettingsChanged`)。
  const unwatchSettings = watchSettingsChanged(event => {
    void applySemantic(event.settings).catch((error: unknown) => {
      log.error('applying the semantic-recall setting failed', { err: error })
    })
  })

  return {
    service,
    index: indexService,
    applySemantic,
    async dispose() {
      // 还原次序与装配次序相反(设置订阅 → 工具面 → 授权面 → 服务槽)。
      unwatchSettings()
      restoreToolAdapters()
      restoreVisibility()
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

/**
 * 起好的索引:服务本体 + 「换一份语义配置」那一手。
 *
 * **那一格可变状态就住在 `startSearchIndexService` 的闭包里** —— 起 Worker 的工厂
 * 读它,所以崩溃重起与换配置重起拿到的是同一份最新值,新旧配置不会分家。
 */
interface StartedSearchIndex {
  service: SearchIndexService
  /** 与当前生效的那一份逐格相同 = 恒等(答 `false`);不同就换一条 Worker。 */
  applySemantic(next: IndexWorkerData['semantic']): Promise<boolean>
}

/**
 * 两份语义配置是不是同一件事。`modelsDir` 由 store 派生,进程内是常量。
 *
 * **代理三格也算进来**(2026-09-17):`workerData` 在 `new Worker(...)` 那一刻定死,
 * 而 Worker 里那只受管 fetch 是按这三格现造的 —— 改了代理却不换 Worker,就是「设置页
 * 上代理已经改好了,模型还在照旧连不上」。改代理 = 换一条 Worker,词法索引文件不动。
 */
function sameSemantic(
  a: IndexWorkerData['semantic'],
  b: IndexWorkerData['semantic'],
): boolean {
  return a?.enabled === b?.enabled
    && a?.modelId === b?.modelId
    && a?.modelsDir === b?.modelsDir
    && a?.proxy?.enabled === b?.proxy?.enabled
    && a?.proxy?.url === b?.proxy?.url
    && a?.proxy?.bypassRules === b?.proxy?.bypassRules
}

/** 起 Worker + 服务。产物不在(vitest / 没构建过)= `undefined`,如实降级。 */
async function startSearchIndexService(
  adapters: OnethingSearchProvidersAdapters,
  overrides: AppSearchServiceOverrides,
): Promise<StartedSearchIndex | undefined> {
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

  const base = {
    databasePath,
    sessionsDir: getOnethingSessionsDir(),
    ...(notesDirs.length > 0 ? { notesDirs } : {}),
    schemas: schemasOf(INDEXED_MANIFESTS),
    // 分析器换了实现就换这个串 —— 库头对不上就丢库重建(§5.4)。
    analyzerId: 'composite' as const,
  }

  /*
   * **唯一那格可变状态**(函数作用域,不是模块作用域)。工厂每次造 Worker 都现读
   * 它,所以「崩溃重起」与「换配置重起」走的是同一份值。
   */
  let semantic = semanticWorkerConfig(getSettings())
  const workerDataNow = (): IndexWorkerData => ({ ...base, semantic })

  const override = overrides.createWorker
  const service = new SearchIndexService({
    createWorker: override === undefined
      ? () => createSearchWorkerFactory(workerPath, workerDataNow())()
      : () => override(workerDataNow()),
  })
  /*
   * **模型下完就生效**(2026-09-17)。
   *
   * 这条线存在的理由是老用户的处境:设置里 `enabled: true` 是上一版留下的(那时
   * 打开开关**就是**下载),而模型一个字节都没下过。今天翻开关不再下载,所以他们
   * 那条 Worker 里的嵌入器在第一次装载时就抛「模型文件没下载」,`VectorWriter` 把
   * 向量路钉成 `'off'` —— 那是个**吸收态**,同一条 Worker 此后不会再试。
   *
   * 于是模型下完之后必须换一条。走的是与「改代理 / 翻开关」**同一条** `restart()`:
   * 先停旧的再起新的、空窗里的查询排队不拒。开关关着就不换 —— 那时换出来的 Worker
   * 与现在这条逐字相同。
   */
  service.onModelSettled(state => {
    if (state !== 'ready') return
    if (semantic?.enabled !== true) return
    log.info('embedding model is ready; replacing the index worker so it takes effect', {
      fields: { modelId: semantic.modelId },
    })
    void service.restart().catch((error: unknown) => {
      log.error('replacing the index worker after the model download failed', { err: error })
    })
  })
  service.start()
  log.info('search index worker started', {
    fields: { workerPath, databasePath, notesDirs: notesDirs.length, semantic: semantic?.enabled === true },
  })

  return {
    service,
    async applySemantic(next) {
      // 同值不换:一次「只改了主题」的保存不该把索引 Worker 掀掉重起。
      if (sameSemantic(semantic, next)) return false
      semantic = next
      /*
       * **换 Worker 之前先把在下的那一发停掉**(2026-09-17)。旧 Worker 一 terminate,
       * 那条正在写盘的流就被硬断在半路 —— 停在自己手里,`FileCache` 的 `catch` 才有
       * 机会把半截文件删掉。新 Worker **不自动续**:它起来时问一次清单,没有清单就是
       * 「还没下」,人再按一次「下载」——而已经下全的那几个文件 transformers 自己认得,
       * 所以续的那一次只补差额。
       *
       * 取消失败不拦路(这条 Worker 可能根本没有模型可管:假嵌入器、或者上一条已经崩了)。
       */
      await service.cancelModelDownload().catch(() => undefined)
      log.info('semantic recall setting changed; replacing the index worker', {
        fields: {
          enabled: next?.enabled === true,
          modelId: next?.modelId,
          // 代理也会换 Worker(见 `sameSemantic`)—— 只记「有没有」,不记 URL。
          proxy: next?.proxy?.enabled === true,
        },
      })
      await service.restart()
      return true
    },
  }
}

/**
 * 订「设置刚保存过」。
 *
 * **串联,不是占槽**:`configureSettingsEventBroadcaster` 是个单槽端口(桌面 / server
 * 各自往自己那条推送面上扇出),直接写进去会把宿主那条推送掐掉。所以照
 * `server/runtime.ts` 那条既有判例串一层:先把上一位的活干掉,再干自己的。
 *
 * **方向是单向的**:search 认识 settings 的推送端口,settings 域一个字都不知道有
 * search 这回事 —— 与 `backend.mcp.applySettings` 那条链相反的接法,理由是那一条要
 * 在保存的**副作用链里同步**跑完(工具目录要跟着重建),而换一条索引 Worker 是
 * 后台的事,保存不必等它。
 *
 * 还原带**身份守卫**(与 `localTrust` 同判):后来又有人串了一层的话,还原就会把
 * 那一层抹掉,所以只在槽里还是自己那只时才还原。
 */
function watchSettingsChanged(listener: (event: SettingsEvent) => void): () => void {
  const previous = getSettingsEventBroadcaster()
  const ours: SettingsEventBroadcaster = event => {
    // 先让宿主那条推送走 —— 屏幕上的设置页不该等一次索引重起。
    previous?.(event)
    try {
      listener(event)
    } catch (error) {
      log.warn('settings-changed listener failed', { err: error })
    }
  }
  configureSettingsEventBroadcaster(ours)
  return () => {
    if (getSettingsEventBroadcaster() !== ours) return
    configureSettingsEventBroadcaster(previous)
  }
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
