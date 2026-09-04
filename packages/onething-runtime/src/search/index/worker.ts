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

import { parentPort, workerData } from 'node:worker_threads'

import { DailyNotesFeed } from './daily-feed.js'
import { defaultDocumentFilters } from './filters.js'
import { LedgerFeed } from './ledger-feed.js'
import { IndexProjector } from './projector.js'
import { SqliteIndex } from './sqlite-index.js'
import { IndexWorkerCore } from './worker-core.js'
import type { IndexEndpoint } from './worker-core.js'

import type { IndexWorkerData } from './worker-data.js'

if (parentPort === null) throw new Error('search index worker must run inside a Worker')

const data = workerData as IndexWorkerData
const index = new SqliteIndex({
  path: data.databasePath,
  ...(data.analyzerId !== undefined ? { analyzerId: data.analyzerId } : {}),
})
const feeds = [
  new LedgerFeed({
    sessionsDir: data.sessionsDir,
    projector: new IndexProjector({ includeReasoning: data.includeReasoning ?? false }),
  }),
  ...(data.notesDir === undefined ? [] : [new DailyNotesFeed({ notesDir: data.notesDir })]),
]
const core = new IndexWorkerCore({
  endpoint: parentPort as unknown as IndexEndpoint,
  index,
  feeds,
  filters: defaultDocumentFilters(),
  ...(data.schemas !== undefined ? { schemas: data.schemas } : {}),
})
core.start()
