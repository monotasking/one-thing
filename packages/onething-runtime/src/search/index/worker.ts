/**
 * Worker 的**入口**。十行,故意的。
 *
 * 设计:docs/design/search-index-2026-09.md §3 落位 ——「`worker.ts`(Worker 入口:
 * 持有 SqliteIndex,收 enqueue / query / status / preview)」。本体在
 * `worker-core.ts`,它不认识 `worker_threads`;这个文件是唯一认识的地方,所以也是
 * 唯一不能被单测直接跑的地方 —— 于是它里面不许有判断,只有装配。
 *
 * 每个宿主的构建配方各加一个 Worker 入口指向这里(§3 末行),`workerData` 递进来
 * 装配所需的路径与开关。
 */

import path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

import { registerBuiltinEmbedders, resolveEmbedder } from '../embedding/index.js'

import { DAILY_FEED_ID, DailyNotesFeed } from './daily-feed.js'
import { defaultDocumentFilters } from './filters.js'
import { LedgerFeed } from './ledger-feed.js'
import { IndexProjector } from './projector.js'
import { SqliteIndex } from './sqlite-index.js'
import { IndexWorkerCore } from './worker-core.js'
import type { IndexEndpoint } from './worker-core.js'

import type { IndexWorkerData } from './worker-data.js'
import { installWorkerLogging } from './worker-logging.js'
import { installWorkerProxyFetch } from './worker-network.js'

if (parentPort === null) throw new Error('search index worker must run inside a Worker')

const data = workerData as IndexWorkerData
const port = parentPort

/*
 * **第一句就接日志**(2026-09-17)。这条线程里 `setRuntimeLoggerRoot()` 从来没有人调过,
 * 于是产品层的兜底 root 生效 —— 一只 200 条的内存环,线程一死就没了。下面第一句
 * `new SqliteIndex(...)` 就可能 warn(sqlite-vec 装不上),那句话也该落到宿主的
 * `app.jsonl` 里。理由与机制写在 `worker-logging.ts` 的文件头。
 */
installWorkerLogging(value => { port.postMessage(value) })

/*
 * **出网先接代理**。模型是下载来的,而这条线程的 `fetch` 与主进程那只受管 fetch 毫无
 * 关系(09-17 事故:provider 走得好好的,模型一个字节下不来)。判据与手法在
 * `worker-network.ts`;代理没配就是一个字都不做,还原函数这里用不上 —— 线程活多久
 * 这只 fetch 就活多久。
 */
installWorkerProxyFetch(data.semantic?.proxy)

/**
 * 语义召回的装配(S7)。三件事按顺序问,任何一件答不上来就是「这次没有向量路」
 * —— 词法路照常开库、照常答查询(§15 的第一条纪律)。
 *
 *  ① 开关(拍点壬 a:默认关);
 *  ② 嵌入器工厂在不在注册表里(`modelId` 是数据,这里不认识任何模型的名字);
 *  ③ sqlite-vec 扩展装不装得上(由 `SqliteIndex` 试,失败即 `vector === undefined`)。
 *
 * 维度由**嵌入器**说,不写死 —— `vec0` 的维度写在建表语句里,所以 `SqliteIndex`
 * 要在开库那一刻就知道它。
 */
registerBuiltinEmbedders()
const semantic = data.semantic
const embedderFactory = semantic?.enabled === true ? resolveEmbedder(semantic.modelId) : undefined
const embedder = embedderFactory === undefined || semantic === undefined
  ? undefined
  : embedderFactory.create({ modelDir: path.join(semantic.modelsDir, semantic.modelId) })

const index = new SqliteIndex({
  path: data.databasePath,
  ...(data.analyzerId !== undefined ? { analyzerId: data.analyzerId } : {}),
  ...(embedder !== undefined ? { vector: { dims: embedder.dims } } : {}),
})
const feeds = [
  new LedgerFeed({
    sessionsDir: data.sessionsDir,
    projector: new IndexProjector({ includeReasoning: data.includeReasoning ?? false }),
  }),
  // 一个笔记目录一把 feed。第二把起要另给 id —— 索引服务按 id 找 feed。
  ...(data.notesDirs ?? []).map((notesDir, at) => new DailyNotesFeed({
    notesDir,
    ...(at === 0 ? {} : { id: `${DAILY_FEED_ID}#${at}` }),
  })),
]
const core = new IndexWorkerCore({
  endpoint: port as unknown as IndexEndpoint,
  index,
  feeds,
  filters: defaultDocumentFilters(),
  ...(data.schemas !== undefined ? { schemas: data.schemas } : {}),
  // 扩展装得上吗 —— 开关关着也要答得出(`gate:packaged` 读它)。
  vectorExtension: index.vectorExtension,
  ...(embedder !== undefined && index.vector !== undefined
    ? { vector: { index: index.vector, embedder } }
    : {}),
})
core.start()
