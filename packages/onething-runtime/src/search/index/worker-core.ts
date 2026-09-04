/**
 * `IndexWorkerCore` —— 索引服务的**本体**。它不认识 `worker_threads`。
 *
 * 设计:docs/design/search-index-2026-09.md §5.3(增量 / 为什么是 Worker)
 * + §5.4(检查点与校对)+ §5.2b(索引服务对所有 feed 一视同仁)。
 *
 * 它只认识一个 `MessagePort` 形状的端点(`postMessage` + `on('message')`),于是
 * 同一份代码有两种装法:真 Worker 里挂 `parentPort`(`worker.ts`,十行),单测里
 * 挂 `MessageChannel` 的一头、另一头给 `IndexWorkerHost`。**「跑在哪条线程上」
 * 因此不是这个类的事**,它只管收四种消息、答四种消息。
 *
 * ## 它做的四件事
 *
 * 1. **入队 + 去抖 50ms 成批**(§5.3)。观察者一条事件喊一声 key,这里攒 50ms
 *    再折 —— 一次流式回复几百条 delta,不去抖就是几百次整键重折。
 * 2. **整键重折**:`fingerprint` 与检查点比对,不同才折;`documentsOf` 过一遍
 *    `DocumentFilter` 列表,按 (capability, key) 分组写进索引。**这一把 feed 钥匙
 *    上一轮拥有哪些索引钥匙**记在检查点行上,于是这一轮少掉的那些当场删掉 ——
 *    「删一条消息」与「改一条消息」在这里是同一件事(重折一遍,少了的就是没了)。
 * 3. **启动校对**(§5.4):打开库 → 立刻可查 → 每个 eager feed 跑一遍
 *    `keys()` × `fingerprint` 比检查点,差的排队;库里有、feed 说不存在的打墓碑。
 * 4. **折坏隔离**(§5.3 末句):某一把钥匙 reduce 抛 → 作废它的检查点、记一条
 *    error、**其它钥匙照折**。一条坏账本不许让整个索引停摆。
 */

import type {
  DocPayload,
  DocumentFeed,
  DocumentFilter,
  FacetFilter,
  IndexedDoc,
  LadderStep,
  LexicalHit,
  LexicalQuery,
  QueryNode,
  SearchQuery,
} from '@onething/core/search'
import {
  buildLexicalQuery,
  composeDocumentFilters,
  createDefaultAnalyzerRegistry,
  createDefaultExpanderRegistry,
} from '@onething/core/search'
import type { AnalyzerRegistry, CapabilityManifest, ExpanderRegistry } from '@onething/core/search'

import { getLogger } from '../../logging/index.js'
import type { SqliteIndex } from './sqlite-index.js'

const log = getLogger('search.index.worker')

/** 去抖窗口(§5.3「队列去抖 50ms 成批」)。 */
export const ENQUEUE_DEBOUNCE_MS = 50

// ---- 协议 ---------------------------------------------------------------

/**
 * 一次查询的请求。
 *
 * **这里传的是查询 AST + 阶梯,不是拼好的 `LexicalQuery`** —— 与派工单原话
 * 「`query(LexicalQuery)`」的一处出入,理由是**词典住在索引这一侧**:前缀展开
 * (§6.2b 的 expander)要读 `Vocabulary`,而 `Vocabulary` 是同步接口、句柄在
 * Worker 里。若主线程先拼 `LexicalQuery`,它就得为每个查询词多做一次
 * `terms()` 往返;把 AST 递进来、在这一侧拼,一次往返做完全部事。
 */
export interface IndexSearchRequest {
  capability: string
  /** 字段 → 权重(来自 manifest.schema)。 */
  fields: Record<string, number>
  ast: QueryNode
  filters?: Record<string, FacetFilter>
  ladder?: LadderStep
  limit: number
  offset: number
  /** 关掉前缀展开(严格档对账用)。缺省开。 */
  expand?: boolean
}

export interface IndexSearchResult {
  hits: LexicalHit[]
  total: number
  /** 命中那几份文档的正文 —— 主线程没有 `DocTable`,摘要与候选都从这里取。 */
  docs: IndexedDoc[]
  generation: number
}

export interface IndexKeyError {
  feedId: string
  key: string
  message: string
}

export interface IndexStatus {
  /**
   * 拍点庚(一个 store 两个 core)09-04 用户裁「先不做」,所以这一格**暂恒
   * `'owner'`**;`'error'` 由主线程侧的 `IndexWorkerHost` 在连崩两次之后覆写
   * (§13 留账「Worker 崩两次即停」)。
   */
  mode: 'owner' | 'error'
  docs: number
  /** 队列里还欠着几把钥匙。 */
  pending: number
  /** 启动校对还在跑吗。 */
  building: boolean
  generation: number
  errors: IndexKeyError[]
}

export type IndexWorkerRequest =
  | { id: number; type: 'enqueue'; feedId: string; key: string; hint?: unknown }
  | { id: number; type: 'query'; request: IndexSearchRequest }
  | { id: number; type: 'status' }
  | { id: number; type: 'rebuild' }
  /** 队列排空再答 —— 单测与「刚发的消息搜得到吗」这类判定用。 */
  | { id: number; type: 'drain' }

export type IndexWorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }

/** `MessagePort` 的最小面(node:worker_threads 的 port 与 parentPort 都是这个形)。 */
export interface IndexEndpoint {
  postMessage(value: unknown): void
  on(event: 'message', listener: (value: unknown) => void): void
  off?(event: 'message', listener: (value: unknown) => void): void
  close?(): void
}

/** 索引的写面 —— 这里只用得到这几只,所以只要这几只(不绑死整个 SqliteIndex)。 */
export type IndexWriteFace = Pick<SqliteIndex,
  | 'replaceKey' | 'deleteKey' | 'tombstone' | 'search' | 'get' | 'size' | 'generation'
  | 'setSchema' | 'terms' | 'readCheckpoint' | 'writeCheckpoint' | 'dropCheckpoint'
  | 'checkpointKeys' | 'readCheckpointOwnedKeys'
>

export interface IndexWorkerCoreOptions {
  endpoint: IndexEndpoint
  index: IndexWriteFace
  feeds: readonly DocumentFeed<string>[]
  filters?: readonly DocumentFilter[]
  analyzers?: AnalyzerRegistry
  expanders?: ExpanderRegistry
  /** 各能力的字段表(manifest.schema)。索引不认识能力,只认这张表。 */
  schemas?: Record<string, Record<string, { analyzer: string; weight: number }>>
  debounceMs?: number
}

/**
 * 拼 `feedId + key` / `capability + key` 用的分隔符。取 U+0000 而不是冒号或空格:
 * 每日笔记的 key 是**文件名**,里面可以有空格、冒号、斜杠 —— 只有它不可能出现。
 * (与 `MemoryIndex` 里那只 `compositeKey` 同一条理由、同一个字符;这里写成转义
 * 序列,源码里不留裸 NUL 字节。)
 */
const KEY_SEPARATOR = '\u0000'

export class IndexWorkerCore {
  private readonly endpoint: IndexEndpoint
  private readonly index: IndexWriteFace
  private readonly feeds: readonly DocumentFeed<string>[]
  private readonly filter: DocumentFilter
  private readonly analyzers: AnalyzerRegistry
  private readonly expanders: ExpanderRegistry
  private readonly debounceMs: number

  private readonly pending = new Set<string>()
  private readonly errors = new Map<string, IndexKeyError>()
  private readonly unsubscribes: Array<() => void> = []
  private timer: NodeJS.Timeout | undefined
  private flushing: Promise<void> | undefined
  private readonly idleWaiters: Array<() => void> = []
  private building = false
  private started = false

  constructor(options: IndexWorkerCoreOptions) {
    this.endpoint = options.endpoint
    this.index = options.index
    this.feeds = options.feeds
    this.filter = composeDocumentFilters(options.filters ?? [])
    this.analyzers = options.analyzers ?? createDefaultAnalyzerRegistry()
    this.expanders = options.expanders ?? createDefaultExpanderRegistry()
    this.debounceMs = options.debounceMs ?? ENQUEUE_DEBOUNCE_MS
    for (const [capability, schema] of Object.entries(options.schemas ?? {})) {
      this.index.setSchema(capability, schema)
    }
    this.endpoint.on('message', message => {
      void this.handle(message as IndexWorkerRequest)
    })
  }

  /**
   * 订阅各 feed + 跑一遍启动校对。**校对是后台的**:`start()` 立刻返回,库打开的
   * 那一刻就能查(§5.4「打开库 → 立刻可查 → 后台对每个 feed 跑一遍校对」)。
   */
  start(): void {
    if (this.started) return
    this.started = true
    for (const feed of this.feeds) {
      this.unsubscribes.push(feed.subscribe(key => this.enqueue(feed.id, key)))
    }
    void this.reconcile()
  }

  dispose(): void {
    for (const dispose of this.unsubscribes.reverse()) {
      try {
        dispose()
      } catch (error) {
        log.warn('feed unsubscribe failed', { err: error })
      }
    }
    this.unsubscribes.length = 0
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  // ---- 消息 -------------------------------------------------------------

  private async handle(message: IndexWorkerRequest): Promise<void> {
    try {
      const result = await this.dispatch(message)
      this.endpoint.postMessage({ id: message.id, ok: true, result } satisfies IndexWorkerResponse)
    } catch (error) {
      this.endpoint.postMessage({
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies IndexWorkerResponse)
    }
  }

  private async dispatch(message: IndexWorkerRequest): Promise<unknown> {
    switch (message.type) {
      case 'enqueue':
        this.enqueue(message.feedId, message.key)
        return null
      case 'query':
        return this.search(message.request)
      case 'status':
        return this.status()
      case 'rebuild':
        await this.rebuild()
        return null
      case 'drain':
        await this.drain()
        return null
    }
  }

  // ---- 查询 -------------------------------------------------------------

  search(request: IndexSearchRequest): IndexSearchResult {
    const query: SearchQuery = {
      raw: '',
      ast: request.ast,
      intent: '',
      filters: request.filters ?? {},
      ...(request.ladder !== undefined ? { ladder: request.ladder } : {}),
    }
    // `buildLexicalQuery` 只读 manifest 的 `id`(它把它填进 `LexicalQuery.capability`),
    // 所以这里给一份最小 manifest 而不是把整份 manifest 递过 postMessage ——
    // manifest 里有函数(`visibility`),结构化克隆过不去。
    const manifest: CapabilityManifest = {
      id: request.capability,
      labelKey: '',
      icon: '',
      kind: 'indexed',
      budget: { default: request.limit, timeoutMs: 0 },
      order: 0,
    }
    const lexical: LexicalQuery = buildLexicalQuery(query, {
      manifest,
      fields: request.fields,
      analyzer: this.analyzers.resolve(undefined),
      vocabulary: this.index,
      ...(request.expand === false ? {} : { expanders: this.expanders }),
      limit: request.limit,
      offset: request.offset,
    })
    const result = this.index.search(lexical)
    const docs: IndexedDoc[] = []
    for (const hit of result.hits) {
      const doc = this.index.get(hit.docId)
      if (doc !== undefined) docs.push(doc)
    }
    return { hits: result.hits, total: result.total, docs, generation: this.index.generation() }
  }

  status(): IndexStatus {
    return {
      mode: 'owner',
      docs: this.index.size(),
      pending: this.pending.size,
      building: this.building,
      generation: this.index.generation(),
      errors: [...this.errors.values()],
    }
  }

  // ---- 队列 -------------------------------------------------------------

  enqueue(feedId: string, key: string): void {
    this.pending.add(`${feedId}${KEY_SEPARATOR}${key}`)
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, this.debounceMs)
    this.timer.unref?.()
  }

  /** 队列排空(含正在飞的那一批与校对)。 */
  async drain(): Promise<void> {
    while (this.building || this.pending.size > 0 || this.flushing !== undefined) {
      if (this.flushing !== undefined) {
        await this.flushing
        continue
      }
      if (this.pending.size > 0) {
        if (this.timer !== undefined) {
          clearTimeout(this.timer)
          this.timer = undefined
        }
        await this.flush()
        continue
      }
      await new Promise<void>(resolve => {
        this.idleWaiters.push(resolve)
        setTimeout(() => {
          const at = this.idleWaiters.indexOf(resolve)
          if (at >= 0) this.idleWaiters.splice(at, 1)
          resolve()
        }, this.debounceMs).unref?.()
      })
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing !== undefined) return this.flushing
    const run = (async () => {
      while (this.pending.size > 0) {
        const batch = [...this.pending]
        this.pending.clear()
        for (const composite of batch) {
          const separator = composite.indexOf(KEY_SEPARATOR)
          const feedId = composite.slice(0, separator)
          const key = composite.slice(separator + 1)
          const feed = this.feeds.find(candidate => candidate.id === feedId)
          if (feed === undefined) continue
          await this.refold(feed, key)
        }
      }
    })()
    this.flushing = run
    try {
      await run
    } finally {
      this.flushing = undefined
      for (const waiter of this.idleWaiters.splice(0)) waiter()
    }
  }

  // ---- 折 ---------------------------------------------------------------

  /**
   * 一把钥匙的整键重折。**折坏了只坏这一把**:检查点作废(下次校对会再试)、
   * 记一条 error,异常不往上抛 —— 上面那层是批处理循环,抛了就把同一批里其它
   * 会话一起带走了。
   */
  private async refold(feed: DocumentFeed<string>, key: string): Promise<void> {
    try {
      const fingerprint = await feed.fingerprint(key)
      const owned = this.index.readCheckpointOwnedKeys(feed.id, key)

      if (fingerprint === undefined) {
        // feed 说这把钥匙不存在了(会话目录被 rmSync 了)—— 它拥有过的每一份
        // 文档打墓碑,检查点撤掉。这就是拍点甲 (b) 里「指纹 undefined 即墓碑」。
        for (const doc of owned) this.index.tombstone(doc.capability, doc.key)
        this.index.dropCheckpoint(feed.id, key)
        this.errors.delete(`${feed.id}${KEY_SEPARATOR}${key}`)
        return
      }

      if (this.index.readCheckpoint(feed.id, key) === fingerprint) return

      const grouped = new Map<string, { capability: string; key: string; docs: DocPayload[] }>()
      for await (const raw of feed.documentsOf(key)) {
        const doc = this.filter(raw, { feedId: feed.id, key })
        if (doc === null) continue
        const composite = `${doc.capability}${KEY_SEPARATOR}${doc.key}`
        const entry = grouped.get(composite)
        if (entry === undefined) grouped.set(composite, { capability: doc.capability, key: doc.key, docs: [doc] })
        else entry.docs.push(doc)
      }

      for (const entry of grouped.values()) {
        this.index.replaceKey(entry.capability, entry.key, entry.docs)
      }
      // 上一轮有、这一轮没有的那些 = 被删 / 被压缩 / 被清空的消息。**删掉,不打
      // 墓碑** —— 墓碑说的是「这把 feed 钥匙不存在了」,而这条会话还活着。
      const live = new Set([...grouped.values()].map(entry => `${entry.capability}${KEY_SEPARATOR}${entry.key}`))
      for (const doc of owned) {
        if (!live.has(`${doc.capability}${KEY_SEPARATOR}${doc.key}`)) {
          this.index.deleteKey(doc.capability, doc.key)
        }
      }

      this.index.writeCheckpoint(feed.id, key, fingerprint, [...grouped.values()].map(entry => ({
        capability: entry.capability,
        key: entry.key,
      })))
      this.errors.delete(`${feed.id}${KEY_SEPARATOR}${key}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.index.dropCheckpoint(feed.id, key)
      this.errors.set(`${feed.id}${KEY_SEPARATOR}${key}`, { feedId: feed.id, key, message })
      log.error('index fold failed; key isolated', { feedId: feed.id, key, err: error })
    }
  }

  // ---- 校对(§5.4)------------------------------------------------------

  private async reconcile(): Promise<void> {
    this.building = true
    try {
      for (const feed of this.feeds) {
        if ((feed.policy?.build ?? 'eager') !== 'eager') continue
        const live = new Set<string>()
        for await (const key of feed.keys()) {
          live.add(key)
          const fingerprint = await feed.fingerprint(key)
          if (fingerprint === undefined) continue
          if (this.index.readCheckpoint(feed.id, key) === fingerprint) continue
          this.pending.add(`${feed.id}${KEY_SEPARATOR}${key}`)
        }
        // 库里记着、feed 说不存在的 —— 排队走一遍 refold,指纹 undefined 那一支
        // 会给它打墓碑(§5.4「库里有、feed 说不存在的墓碑」)。
        for (const key of this.index.checkpointKeys(feed.id)) {
          if (!live.has(key)) this.pending.add(`${feed.id}${KEY_SEPARATOR}${key}`)
        }
      }
    } catch (error) {
      log.error('index reconcile failed', { err: error })
    } finally {
      this.building = false
    }
    await this.flush()
  }

  /** 全量重建:检查点全撤,所有钥匙重排队。 */
  async rebuild(): Promise<void> {
    for (const feed of this.feeds) {
      for (const key of this.index.checkpointKeys(feed.id)) this.index.dropCheckpoint(feed.id, key)
    }
    this.errors.clear()
    await this.reconcile()
  }
}
