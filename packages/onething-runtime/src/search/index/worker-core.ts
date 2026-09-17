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
  Embedder,
  DocumentFilter,
  FacetFilter,
  IndexedDoc,
  LadderStep,
  LexicalHit,
  LexicalQuery,
  QueryNode,
  SearchQuery,
  VectorHit,
  VectorIndex,
  VectorSearchScope,
} from '@onething/core/search'
import {
  buildLexicalQuery,
  composeDocumentFilters,
  createDefaultAnalyzerRegistry,
  createDefaultExpanderRegistry,
} from '@onething/core/search'
import type { AnalyzerRegistry, CapabilityManifest, ExpanderRegistry } from '@onething/core/search'

import { getLogger } from '../../logging/index.js'
import type { ModelDownloader, ModelState, ModelStatus } from './model-download.js'
import type { SqliteIndex } from './sqlite-index.js'
import { VectorWriter } from './vector-writer.js'
import type { VectorState } from './vector-writer.js'

const log = getLogger('search.index.worker')

/** 去抖窗口(§5.3「队列去抖 50ms 成批」)。 */
export const ENQUEUE_DEBOUNCE_MS = 50

/** 这条 Worker 管不了模型(没装 `ModelDownloader`)时那三个动作的答复。 */
export const MODEL_UNAVAILABLE_ERROR = 'model management is not available on this host'

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

/**
 * 一次向量召回的请求。**递的是一句自然语言,不是一个向量** —— 查询嵌入 ~40ms,
 * 而模型住在 Worker 这一侧;在主线程嵌就把 wasm 拖回了主线程,那正是 §15.2 要躲的事。
 */
export interface IndexVectorSearchRequest {
  capability: string
  /** 查询原串。前缀(e5 的 `query:`)由嵌入器自己贴,这一层不认识任何模型。 */
  text: string
  filters?: Record<string, FacetFilter>
  /** KNN 取几条。融合那一侧要 `offset + limit` 条。 */
  k: number
}

export interface IndexVectorSearchResult {
  hits: VectorHit[]
  docs: IndexedDoc[]
  generation: number
  /** 向量路答不了的时候说清楚是哪一种,壳与门据此画字,不当成「零命中」。 */
  unavailable?: VectorState
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
  /**
   * **真正折过几次**(S3b 第二轮)。指纹没变那一支的提前返回不算 —— 它没读文件、
   * 没跑投影。这一格是「白做工」唯一可观测的读数:流式回复期间它一动不动,
   * `run/end` 之后加一,就是「观察者只对会改文档的事件喊」这条判据的活证据
   * (判据本身住 `projector.ts` 的 `INDEX_DOCUMENT_EFFECTS`)。
   */
  refolds: number
  /** 启动校对还在跑吗。 */
  building: boolean
  generation: number
  errors: IndexKeyError[]
  /**
   * 已**纳入**的 feed(S3b)。`eager` 的在 `start()` 那一刻就进来;`lazy` 的要等
   * 到第一次有人查它替之产文档的那个能力(§5.2b 那张表「文件树 lazy(首次查询才
   * 建)」)。这一格是「首次查询才建」这条策略**唯一**可观测的地方 —— 能力自己
   * 一个字都不知道它的来源是懒的还是急的。
   */
  feeds: string[]
  /**
   * 语义召回此刻在干什么(§15;`'off'` = 没开 / 关掉了 / 装不上扩展)。
   * 它与 `vectorExtension` 是两件事:一个是「开关与进度」,一个是「这份产物装得上
   * 扩展吗」—— `gate:packaged` 在开关关着的时候读的正是后者。
   */
  vector: VectorState
  /** 还有几份文档没嵌进去(与 `pending` 同一种诚实,只是另一条派生数据)。 */
  vectorPending: number
  vectorExtension: 'loadable' | 'missing'
  /**
   * `vector === 'off'` **是因为它自己关回去了**时,那一句原因(2026-09-17;契约只加)。
   *
   * 缺席有两种意思,都不是「没出错」:没开过(开关关着)、或者这一条还没关过。
   * 屏幕上只在「开着 + `'off'`」那一态读它 —— 别的态下它不该出现在句子里。
   * 产地是 `VectorWriter.describeEmbedderFailure`(判据在那里,不在这)。
   *
   * **是诊断原话,不是文案**:它与 `vectorErrorKind` 成对出现,壳按 kind 查一句人话、
   * 把这一格括在后面。后端一个中文字都不拼(R12,2026-09-17)。
   */
  vectorError?: string
  /**
   * 那句原因属于**哪一类**(2026-09-17 R12;与 `vectorError` 同生同灭)。
   *
   * `network` 改代理 / `runtime` 本机装不出推理运行时 / `model` 模型文件不完整 /
   * `unknown` 不认识(壳就只说原话,不猜)。判据表在 `vector-writer.ts`。
   */
  vectorErrorKind?: 'network' | 'runtime' | 'model' | 'unknown'
  /**
   * **嵌入模型这件东西自己的状态**(2026-09-17;与开关无关)。
   *
   * 它与 `vector` 是两件事,分开的理由就是用户那句裁定「把开关和下载模型拆开」:
   * `vector` 说的是「语义召回此刻在干什么」(开关开着才有意义),这一格说的是
   * 「这台机器上有没有那份模型、下到哪儿了」——**开关关着的时候它照样要说得出话**,
   * 因为设置页那颗「下载」就是在开关关着的时候按的。
   *
   * 这条 Worker 管不了模型时缺席(假嵌入器 / 配置里没有语义那一段)。
   */
  model?: ModelStatus
}

/** 模型那三个动作。**没有 `'status'`** —— 状态由 `status` 那一发一起带回去。 */
export type IndexModelOp = 'download' | 'cancel' | 'remove'

export type IndexWorkerRequest =
  | { id: number; type: 'enqueue'; feedId: string; key: string; hint?: unknown }
  | { id: number; type: 'query'; request: IndexSearchRequest }
  | { id: number; type: 'vector-query'; request: IndexVectorSearchRequest }
  | { id: number; type: 'status' }
  | { id: number; type: 'rebuild' }
  /** 模型的下载 / 取消 / 删除(2026-09-17)。答的是**动作之后**那一刻的模型状态。 */
  | { id: number; type: 'model'; op: IndexModelOp }
  /** 队列排空再答 —— 单测与「刚发的消息搜得到吗」这类判定用。 */
  | { id: number; type: 'drain' }

/**
 * Worker → 宿主的**通知帧**(不带 `id`,不是往返)—— 与日志帧同一种形。
 *
 * 今天只有一句话要说:模型那一发落定了。宿主据此在「开关本来就开着」时换一条
 * Worker,于是下完就生效,不要求用户再翻一次开关。
 */
export const WORKER_MODEL_MESSAGE_TYPE = 'model-event'

export interface WorkerModelMessage {
  type: typeof WORKER_MODEL_MESSAGE_TYPE
  state: ModelState
}

/** 这一帧是不是模型通知。**逐格验**(结构化克隆过来的东西类型上是 `unknown`)。 */
export function isWorkerModelMessage(value: unknown): value is WorkerModelMessage {
  if (typeof value !== 'object' || value === null) return false
  const frame = value as { type?: unknown; state?: unknown }
  return frame.type === WORKER_MODEL_MESSAGE_TYPE && typeof frame.state === 'string'
}

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
  | 'checkpointKeys' | 'readCheckpointOwnedKeys' | 'byKey' | 'allDocIds'
  | 'readMeta' | 'writeMeta'
>

export interface IndexWorkerCoreOptions {
  endpoint: IndexEndpoint
  index: IndexWriteFace
  feeds: readonly DocumentFeed<string>[]
  filters?: readonly DocumentFilter[]
  analyzers?: AnalyzerRegistry
  expanders?: ExpanderRegistry
  /**
   * 各能力的字段表(manifest.schema)。索引不认识能力,只认这张表。
   * `embed` 那一格决定这个字段进不进向量索引(§15.3)。
   */
  schemas?: Record<string, Record<string, { analyzer: string; weight: number; embed?: boolean }>>
  debounceMs?: number
  /**
   * 语义召回(S7)。**两件都在才算开**:嵌入器由设置里的 `modelId` 解析出来,
   * 向量索引由 sqlite-vec 装载出来。缺一件 = `status.vector` 恒 `'off'`,词法路
   * 一个字不受影响。
   */
  vector?: { index: VectorIndex; embedder: Embedder }
  /** 这份产物装得上 sqlite-vec 扩展吗(开关关着也答得出;`gate:packaged` 读它)。 */
  vectorExtension?: 'loadable' | 'missing'
  /**
   * 模型的下载 / 取消 / 删除(2026-09-17)。**与 `vector` 那一格互不依赖** —— 开关
   * 关着的 Worker 照样带着它,因为「下载」这颗钮就是在开关关着的时候按的。
   */
  model?: ModelDownloader
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
  private readonly schemas: Record<string, Record<string, { analyzer: string; weight: number; embed?: boolean }>>

  private readonly pending = new Set<string>()
  /**
   * **正在折的那一批**(S3c)。
   *
   * `flush()` 的第一句就是 `pending.clear()` —— 那些钥匙没有折完,只是换了个地方
   * 待着。少了这一格,`status()` 会在整个 flush 期间答 `pending: 0`,于是
   * `stale`(= `pending > 0 || building`)在**索引明明还在追账本**的时候说「追上了」。
   *
   * 这不是理论:S3c 的 parity-B 就是被它咬到的 —— 等 `stale === false` 之后开始
   * 对账,跑到一半同一条查询多答出两条来(冷建的 flush 还在折)。`drain()` 早就
   * 认得这一形(它的三个条件里有 `this.flushing !== undefined`),错的只是
   * `status()` 少问了一句;这一批把两处对齐,判据仍然是「还欠着几把钥匙」。
   */
  private readonly inFlight = new Set<string>()
  private readonly errors = new Map<string, IndexKeyError>()
  private readonly unsubscribes: Array<() => void> = []
  private timer: NodeJS.Timeout | undefined
  private flushing: Promise<void> | undefined
  private readonly idleWaiters: Array<() => void> = []
  /** 已纳入的 feed id(S3b:`eager` 在 start 时进,`lazy` 在首次查询时进)。 */
  private readonly activeFeeds = new Set<string>()
  /**
   * 正在跑校对的 feed 数。**是计数不是布尔** —— 懒 feed 的纳入与账本的启动校对
   * 可以同时在跑,一个布尔会让先结束的那个把另一个的「还在建」抹掉,`drain()`
   * 于是提前答「排空了」。
   */
  private buildingCount = 0
  private started = false
  /** 真正折过几次(`status().refolds`)。 */
  private refolds = 0
  /** 嵌入的写路。语义召回没开就是 `undefined`(§15)。 */
  private readonly vectorWriter: VectorWriter | undefined
  private readonly vectorIndex: VectorIndex | undefined
  private readonly vectorExtension: 'loadable' | 'missing'
  private vectorState: VectorState = 'off'
  /** 模型那件东西(2026-09-17)。这条 Worker 管不了模型时缺席。 */
  private readonly model: ModelDownloader | undefined

  constructor(options: IndexWorkerCoreOptions) {
    this.endpoint = options.endpoint
    this.index = options.index
    this.feeds = options.feeds
    this.filter = composeDocumentFilters(options.filters ?? [])
    this.analyzers = options.analyzers ?? createDefaultAnalyzerRegistry()
    this.expanders = options.expanders ?? createDefaultExpanderRegistry()
    this.debounceMs = options.debounceMs ?? ENQUEUE_DEBOUNCE_MS
    this.schemas = options.schemas ?? {}
    for (const [capability, schema] of Object.entries(this.schemas)) {
      this.index.setSchema(capability, schema)
    }

    this.vectorExtension = options.vectorExtension ?? 'missing'
    this.vectorIndex = options.vector?.index
    if (options.vector !== undefined) {
      this.vectorWriter = new VectorWriter({
        index: this.index,
        vector: options.vector.index,
        embedder: options.vector.embedder,
        embedFields: capability => Object.entries(this.schemas[capability] ?? {})
          .filter(([, spec]) => spec.embed === true)
          .map(([field]) => field),
        onState: state => { this.vectorState = state },
      })
      this.vectorState = 'downloading'
      this.applyEmbeddingModelHeader(options.vector.embedder.id, options.vector.index)
    }

    /*
     * 模型那一发落定了就**主动喊一声**(不带 `id` 的通知帧)。宿主据此在「开关本来
     * 就开着」时换一条 Worker —— 那正是老用户的处境:设置里 `enabled: true` 是上一版
     * 留下的,而模型从来没下过。下完就生效,不要求他再翻一次开关。
     */
    this.model = options.model
    this.model?.onSettled(state => {
      this.endpoint.postMessage({
        type: WORKER_MODEL_MESSAGE_TYPE,
        state,
      } satisfies WorkerModelMessage)
    })

    this.endpoint.on('message', message => {
      void this.handle(message as IndexWorkerRequest)
    })
  }

  /**
   * 纳入各 `eager` feed(订阅 + 跑一遍启动校对)。**校对是后台的**:`start()`
   * 立刻返回,库打开的那一刻就能查(§5.4「打开库 → 立刻可查 → 后台对每个 feed
   * 跑一遍校对」)。
   *
   * **`lazy` 的这里一个都不碰**(S3b):它们既不订阅也不校对,要等到第一次有人
   * 查它替之产文档的那个能力(`search()` 里的 `ensureFeedsFor`)。「首次查询才
   * 建」于是落在**纳入时机**上,而不是落在能力里 —— 能力问的还是同一句话,答它
   * 的索引这一刻恰好刚开始建而已。
   */
  start(): void {
    if (this.started) return
    this.started = true
    for (const feed of this.feeds) {
      if ((feed.policy?.build ?? 'eager') !== 'eager') continue
      void this.activate(feed)
    }
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
    this.vectorWriter?.dispose()
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
      case 'vector-query':
        return this.vectorSearch(message.request)
      case 'status':
        return this.status()
      case 'rebuild':
        await this.rebuild()
        return null
      case 'model':
        return this.modelOp(message.op)
      case 'drain':
        await this.drain()
        return null
    }
  }

  // ---- 查询 -------------------------------------------------------------

  search(request: IndexSearchRequest): IndexSearchResult {
    this.ensureFeedsFor(request.capability)
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
    // 缺席 = 「没关过」。**显式的 `undefined` 与没有这一格是两回事**,所以条件展开。
    const failure = this.vectorWriter?.lastError()
    const model = this.model?.status()
    return {
      mode: 'owner',
      docs: this.index.size(),
      // 排着队的 + 正在折的都算「还欠着」(见 `inFlight` 的说明)。
      pending: this.pending.size + this.inFlight.size,
      refolds: this.refolds,
      building: this.buildingCount > 0,
      generation: this.index.generation(),
      errors: [...this.errors.values()],
      feeds: [...this.activeFeeds],
      vector: this.vectorState,
      vectorPending: this.vectorWriter?.pending() ?? 0,
      vectorExtension: this.vectorExtension,
      ...(failure !== undefined
        ? { vectorError: failure.reason, vectorErrorKind: failure.kind }
        : {}),
      /*
       * 模型那一格:管得了就说,管不了就缺席(缺席 = 不知道,不是「没下」)。
       * **正在认领的那几秒也缺席** —— `ModelDownloader.status()` 自己答
       * `undefined`(2026-09-17):那时「有没有」真的还不知道,而屏幕上「不知道」
       * 早有画法(壳的 unknown「检查中…」),报一句「未下载」再翻过来才是错话。
       */
      ...(model === undefined ? {} : { model }),
    }
  }

  /**
   * 模型的三个动作。**都当场答**(连 `download` 也是)—— 112.8 MB 冷下 191 秒,
   * 一条 HTTP 往返等不了那么久,进度由调用方轮 `status` 读。
   *
   * 这条 Worker 管不了模型时**结构化拒绝**,不假装成功:调用方(设置页)据此知道
   * 「这台宿主上没有这件事」,而不是画一个永远停在 0% 的进度条。
   */
  private modelOp(op: IndexModelOp): ModelStatus {
    const model = this.model
    if (model === undefined) throw new Error(MODEL_UNAVAILABLE_ERROR)
    switch (op) {
      case 'download':
        return model.download()
      case 'cancel':
        return model.cancel()
      case 'remove':
        return model.remove()
    }
  }

  /**
   * 库头 `meta.embeddingModelId` 与当前嵌入器不符 → 清空向量、全库排队重嵌
   * (§5.4「换模型 = 后台全量重嵌,词法路照常」)。**词法路的库头三格里只有这一格
   * 变了,所以只有向量那一半重建** —— `version` / `analyzerId` 不符才是丢整个库。
   */
  private applyEmbeddingModelHeader(embedderId: string, vector: VectorIndex): void {
    const recorded = this.index.readMeta('embeddingModelId')
    this.index.writeMeta('embeddingModelId', embedderId)
    if (recorded !== embedderId) {
      log.info('embedding model changed; the vector half is rebuilt', {
        fields: { from: recorded ?? null, to: embedderId },
      })
      this.vectorWriter?.reembedAll()
      return
    }
    /*
     * **头对得上,可向量表是空的**(2026-09-17)。那句头说的是「这个模型嵌过这个库」,
     * 而空表说明它根本没嵌成 —— 最典型的一形就是这一批造出来的:开关开着、模型还没下,
     * 上一条 Worker 在 `ready()` 第一句就把自己关回去了(`'off'` 是吸收态),但它**已经
     * 把头写下了**。等模型下完、宿主换上一条新 Worker,头一对得上就什么都不排队,
     * 状态会永远停在「正在启动」——下完也不生效。
     *
     * 判据是**空表 + 有文档**,不是「上一条关过没有」:后者要跨 Worker 记忆,而这一格
     * 在库里、看得见、重启也还在。代价是一种退化情形 —— 库里所有文档都没有可嵌的字段时,
     * 每次起 Worker 都会白排一遍队(逐份文档算出空正文、`remove` 一下就过),那是一趟
     * 便宜的空转,换的是「下完就生效」永远成立。
     */
    if (vector.size() === 0 && this.index.size() > 0) {
      log.info('the vector half is empty under this model; queueing the whole index', {
        fields: { docs: this.index.size(), embedder: embedderId },
      })
      this.vectorWriter?.reembedAll()
    }
  }

  /**
   * 向量召回。**范围与词法路走同一条编译**(`SqliteIndex.compileVectorScope`),
   * 于是授权在 KNN 里就生效,而不是先取 k 条再筛(§6.4b / `sqlite-vec.ts` 的读数)。
   */
  async vectorSearch(request: IndexVectorSearchRequest): Promise<IndexVectorSearchResult> {
    this.ensureFeedsFor(request.capability)
    const writer = this.vectorWriter
    const vector = this.vectorIndex
    if (writer === undefined || vector === undefined) {
      return { hits: [], docs: [], generation: this.index.generation(), unavailable: 'off' }
    }
    const embedding = await writer.embedQuery(request.text)
    if (embedding === undefined) {
      return { hits: [], docs: [], generation: this.index.generation(), unavailable: writer.currentState() }
    }
    const scope: VectorSearchScope = {
      capability: request.capability,
      ...(request.filters !== undefined ? { filters: request.filters } : {}),
    }
    const hits = vector.search(embedding, request.k, scope)
    const docs: IndexedDoc[] = []
    const seen = new Set<number>()
    for (const hit of hits) {
      if (seen.has(hit.docId)) continue
      seen.add(hit.docId)
      const doc = this.index.get(hit.docId)
      if (doc !== undefined) docs.push(doc)
    }
    // 还在嵌的时候如实说 —— 壳画「语义索引建立中」,而不是把半个索引当成全部。
    const state = writer.currentState()
    return {
      hits,
      docs,
      generation: this.index.generation(),
      ...(state === 'ready' ? {} : { unavailable: state }),
    }
  }

  /**
   * 这个能力的文档由哪些 feed 产 —— 还没纳入的当场纳入(S3b 的懒建时机)。
   *
   * 判据读的是 `feed.capabilities`(feed 自述它替谁产文档),这个文件里因此没有
   * 任何能力名,也没有「daily 是懒的」这种知识。加一个懒来源 = 加一个 feed。
   */
  private ensureFeedsFor(capability: string): void {
    for (const feed of this.feeds) {
      if (this.activeFeeds.has(feed.id)) continue
      if (!feed.capabilities.includes(capability)) continue
      void this.activate(feed)
    }
  }

  /**
   * 纳入一把 feed:订阅 + 跑一遍它的校对。幂等。
   *
   * `buildingCount` 在**同步段**就加上去(`reconcileFeed` 的第一句),于是「查一下
   * daily 然后 drain」拿得到「还在建」这个事实 —— 加在第一个 `await` 之后就是一次
   * 竞态,drain 会在校对还没开始时答「排空了」。
   */
  private activate(feed: DocumentFeed<string>): Promise<void> {
    if (this.activeFeeds.has(feed.id)) return Promise.resolve()
    this.activeFeeds.add(feed.id)
    try {
      this.unsubscribes.push(feed.subscribe(key => this.enqueue(feed.id, key)))
    } catch (error) {
      log.error('feed subscribe failed; it will still be reconciled once', { feedId: feed.id, err: error })
    }
    return this.reconcileFeed(feed)
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

  /** 队列排空(含正在飞的那一批、校对,以及嵌入的写路)。 */
  async drain(): Promise<void> {
    while (this.buildingCount > 0 || this.pending.size > 0 || this.flushing !== undefined) {
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
    // 折完了不等于嵌完了。`drain()` 说的是「欠的活都干完了」,那就包括这一半。
    await this.vectorWriter?.drain()
  }

  private async flush(): Promise<void> {
    if (this.flushing !== undefined) return this.flushing
    const run = (async () => {
      while (this.pending.size > 0) {
        const batch = [...this.pending]
        this.pending.clear()
        // 出了队不等于折完了 —— 交接给 `inFlight`,`status()` 才不会在这一段说谎。
        for (const composite of batch) this.inFlight.add(composite)
        for (const composite of batch) {
          try {
            const separator = composite.indexOf(KEY_SEPARATOR)
            const feedId = composite.slice(0, separator)
            const key = composite.slice(separator + 1)
            const feed = this.feeds.find(candidate => candidate.id === feedId)
            if (feed === undefined) continue
            await this.refold(feed, key)
          } finally {
            this.inFlight.delete(composite)
          }
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

      // 从这一行起才是真的折(读整份账本 + 跑投影);读数进 `status().refolds`。
      this.refolds += 1
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
        // 文档落库之后才排嵌入队 —— docId 是 `replaceKey` 插出来的(§15.3)。
        this.vectorWriter?.enqueueKey(entry.capability, entry.key)
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

  /** 一把 feed 的校对。**只对已纳入的 feed 调**(懒的没纳入就没有校对可言)。 */
  private async reconcileFeed(feed: DocumentFeed<string>): Promise<void> {
    this.buildingCount += 1
    try {
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
    } catch (error) {
      log.error('index reconcile failed', { feedId: feed.id, err: error })
    } finally {
      this.buildingCount -= 1
    }
    await this.flush()
  }

  /** 全量重建:检查点全撤,**已纳入的**每把 feed 各校对一遍。 */
  async rebuild(): Promise<void> {
    for (const feed of this.feeds) {
      for (const key of this.index.checkpointKeys(feed.id)) this.index.dropCheckpoint(feed.id, key)
    }
    this.errors.clear()
    await Promise.all(this.feeds
      .filter(feed => this.activeFeeds.has(feed.id))
      .map(feed => this.reconcileFeed(feed)))
  }
}
