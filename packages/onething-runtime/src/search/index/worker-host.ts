/**
 * `IndexWorkerHost` —— 主线程侧的代理。
 *
 * 设计:docs/design/search-index-2026-09.md §5.3 —— 「主线程侧 `worker-host.ts` 把
 * `enqueue` / `query` / `status` / `preview` 四种消息做成 Promise 往返(query 一次
 * 往返 < 1ms),**Worker 崩了记一条 `error` 日志、重起、从检查点续;两次连续崩就报
 * `index.status() = { error }` 不再重起**。」+ §13 留账那一条(停了之后三路能力答
 * 「index unavailable」,**不回退到旧扫描**)。
 *
 * 「怎么造 Worker」是**参数**:真宿主传一只起 `worker_threads.Worker` 的工厂
 * (S3b 在装配层接,三个宿主各加一个构建入口),单测传 `MessageChannel` 的一头 +
 * 同线程跑的 `IndexWorkerCore`。于是这个类不 import `worker_threads`,也就不必为了
 * 测它去起一条真线程。
 *
 * **「从检查点续」不需要这里做任何事**:检查点在库里,重起之后新 Worker 的启动校对
 * (§5.4)自己会把停摆期间的差补齐。这里要做的只有一件 —— 把在飞的请求**拒掉**,
 * 而不是让它们永远挂着。
 */

import { getLogger } from '../../logging/index.js'
import {
  WORKER_LOG_THREAD_FIELD,
  isWorkerLogMessage,
  workerLogLevelOf,
  type WorkerLogMessage,
} from './worker-logging.js'
import { isWorkerModelMessage } from './worker-core.js'
import type { ModelState, ModelStatus } from './model-download.js'
import type {
  IndexEndpoint,
  IndexModelOp,
  IndexSearchRequest,
  IndexSearchResult,
  IndexVectorSearchRequest,
  IndexVectorSearchResult,
  IndexStatus,
  IndexWorkerRequest,
  IndexWorkerResponse,
} from './worker-core.js'

const log = getLogger('search.index.host')

/** 连崩几次就不再重起(§5.3 末句)。 */
export const MAX_CONSECUTIVE_CRASHES = 2

/**
 * Worker 那一侧的一条记录 → 宿主这一侧的同一条记录(2026-09-17)。
 *
 * **原样重发,只多一格**:`ns`(`search.index.worker` / `search.embedding` / …)、级别、
 * `msg`、`fields`、`err` 一个都不改 —— 改了 `log:tail --ns search.*` 就对不上了。加的
 * 那一格是 `thread`,它回答的是「这条是哪条线程说的」,在 `app.jsonl` 里一眼可筛。
 *
 * `record.time` 由宿主的 `LoggerRoot` 重新盖(跨线程那一跳是微秒级;理由写在
 * `worker-logging.ts` 的文件头)。
 */
function relayWorkerLog(frame: WorkerLogMessage): void {
  const { record } = frame
  const relay = getLogger(record.ns)
  relay[workerLogLevelOf(record)](
    record.msg,
    { ...record.fields, thread: WORKER_LOG_THREAD_FIELD },
    record.err,
  )
}

export interface IndexWorkerHandle {
  readonly endpoint: IndexEndpoint
  onError(listener: (error: Error) => void): void
  onExit(listener: (code: number) => void): void
  terminate(): void | Promise<void>
}

export type IndexWorkerFactory = () => IndexWorkerHandle

export class IndexWorkerUnavailableError extends Error {
  constructor(message = 'index unavailable') {
    super(message)
    this.name = 'IndexWorkerUnavailableError'
  }
}

/**
 * 一条请求去掉 `id` 之后的形。**要逐支分配**(`T extends unknown ? Omit<T,'id'> : never`)
 * —— 直接 `Omit<联合, 'id'>` 会先把联合折成交集再删,结果只剩三个类型都有的那几格,
 * `request` / `feedId` 当场消失。
 */
type IndexWorkerRequestBody = IndexWorkerRequest extends infer T
  ? T extends { id: number } ? Omit<T, 'id'> : never
  : never

interface InFlight {
  resolve(value: unknown): void
  reject(error: Error): void
}

/** 候诊室里的一发:换 Worker 期间到达的请求,等新的那条起来再发。 */
interface Waiting {
  message: IndexWorkerRequestBody
  resolve(value: unknown): void
  reject(error: Error): void
}

/**
 * 换 Worker 时**等旧 Worker 把在飞的那几发答完**的上限。
 *
 * 为什么要等:一发 `query` 已经交给旧 Worker 了,直接 `terminate()` 它就永远
 * 等不到答复 —— 那是「换一次设置,正在打字的那个人看见一句搜不了」。
 * 为什么有上限:`drain` 这类请求可以等很久,而换 Worker 不该被它无限期拖住;
 * 到点还没答完的**如实拒掉**(`index worker replaced`),不让调用方挂死。
 */
export const WORKER_SWAP_SETTLE_MS = 2000

export class IndexWorkerHost {
  private readonly factory: IndexWorkerFactory
  private handle: IndexWorkerHandle | undefined
  private readonly inFlight = new Map<number, InFlight>()
  private nextId = 1
  private consecutiveCrashes = 0
  private dead = false
  private disposed = false
  /** 正在换 Worker 的那一发(合流用:同时来两条换的请求只换一次)。 */
  private swap: Promise<void> | undefined
  /** 换 Worker 期间到达的请求。换完按原序发出去。 */
  private readonly waiting: Waiting[] = []
  /** 「在飞的都答完了」的等待者。 */
  private idleWaiters: Array<() => void> = []
  /**
   * 「模型那一发落定了」的听众。**挂在 host 上而不是某一条 Worker 上** —— 换一条
   * Worker(改代理 / 翻开关)之后它照样在,否则一次设置改动就会把监听悄悄弄丢。
   */
  private readonly modelListeners = new Set<(state: ModelState) => void>()

  constructor(factory: IndexWorkerFactory) {
    this.factory = factory
  }

  start(): void {
    if (this.disposed || this.dead) return
    if (this.handle !== undefined) return
    this.spawn()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.rejectInFlight(new IndexWorkerUnavailableError('index worker disposed'))
    // 候诊室也要清:正赶上换 Worker 的那一刻退出,排着的那几发没有人会来发它们。
    for (const entry of this.waiting.splice(0, this.waiting.length)) {
      entry.reject(new IndexWorkerUnavailableError('index worker disposed'))
    }
    const handle = this.handle
    this.handle = undefined
    if (handle !== undefined) await handle.terminate()
  }

  /** 停了没有(连崩两次)。`status()` 的 `mode` 由它翻成 `'error'`。 */
  get stopped(): boolean {
    return this.dead
  }

  /**
   * **换一条 Worker**(设置里的语义召回开关改了;`workerData` 在 `new Worker(...)`
   * 那一刻定死,所以换配置就是换线程)。
   *
   * 这里不认识「语义召回」四个字 —— 换出来的那一条长什么样全由**工厂**说,工厂
   * 读的是装配那一侧此刻的配置(`wiring/search/index.ts`)。于是崩溃重起走的也是
   * 同一只工厂,新旧配置不会分家。
   *
   * ## 次序:先静默 → 等在飞的答完 → 停旧的 → 起新的
   *
   * **不先起新的**:两条 Worker 同时开同一个 `search.v1.sqlite` 就是两个写者
   * (新那条一上来就跑启动校对,那是写),`SQLITE_BUSY` 是迟早的事。
   * 那样换来的「零空窗」由候诊室(`waiting`)更便宜地拿到了:空窗期的请求不拒、
   * 排着,新 Worker 一起来就按原序发出去。**所以换 Worker 期间查询不会抛**,
   * 只是慢那么一下。
   */
  restart(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    // 合流:两条设置一起落地(或者用户连点两下)只换一条 Worker。
    if (this.swap !== undefined) return this.swap
    const swap = this.performSwap().finally(() => {
      this.swap = undefined
      this.flushWaiting()
    })
    this.swap = swap
    return swap
  }

  private async performSwap(): Promise<void> {
    const handle = this.handle
    // 从这一刻起 `send()` 进候诊室 —— `swap` 已经挂上,`handle` 已经摘掉。
    this.handle = undefined
    if (handle !== undefined) {
      await this.whenIdle(WORKER_SWAP_SETTLE_MS)
      try {
        await handle.terminate()
      } catch (error) {
        log.warn('index worker terminate failed while swapping', { err: error })
      }
    } else {
      // 旧的已经不在了(崩过 / 还没起过):在飞的那几发没人会答,如实拒掉。
      this.rejectInFlight(new IndexWorkerUnavailableError('index worker replaced'))
    }
    if (this.disposed) return
    /*
     * 换过一条 Worker 就是**重新开张**:连崩计数与「停了」都清零。上一条的崩溃史
     * 说的是上一份配置(比如一个装不上的嵌入器),不该判新的这一条死刑。
     */
    this.consecutiveCrashes = 0
    this.dead = false
    try {
      this.spawn()
    } catch (error) {
      // 起不来就如实停摆:候诊室里那几发会拿到 `index unavailable`,不是挂死。
      this.dead = true
      this.handle = undefined
      log.error('index worker could not be replaced', { err: error })
    }
  }

  /** 在飞的都答完了(或者到点了)。到点还欠着的**如实拒掉**。 */
  private whenIdle(timeoutMs: number): Promise<void> {
    if (this.inFlight.size === 0) return Promise.resolve()
    return new Promise<void>(resolve => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        this.rejectInFlight(new IndexWorkerUnavailableError('index worker replaced'))
        finish()
      }, timeoutMs)
      // 这只计时器不该拦住进程退出(与 Worker 自己 `unref()` 同一条理由)。
      timer.unref?.()
      this.idleWaiters.push(finish)
    })
  }

  private notifyIdle(): void {
    if (this.inFlight.size > 0) return
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const waiter of waiters) waiter()
  }

  /** 候诊室排空:按原序重发。此刻停摆了的话,它们在 `send()` 里如实被拒。 */
  private flushWaiting(): void {
    const waiting = this.waiting.splice(0, this.waiting.length)
    for (const entry of waiting) {
      this.send(entry.message).then(entry.resolve, entry.reject)
    }
  }

  // ---- 四种消息 ---------------------------------------------------------

  async search(request: IndexSearchRequest): Promise<IndexSearchResult> {
    return await this.send({ type: 'query', request }) as IndexSearchResult
  }

  /**
   * 向量召回(S7)。Worker 崩了那一支答「向量路不可用」而不是零命中 —— 与词法路
   * 的 `mode: 'error'` 同一种诚实。
   */
  async vectorSearch(request: IndexVectorSearchRequest): Promise<IndexVectorSearchResult> {
    if (this.dead) return { hits: [], docs: [], generation: 0, unavailable: 'off' }
    return await this.send({ type: 'vector-query', request }) as IndexVectorSearchResult
  }

  /**
   * 模型的下载 / 取消 / 删除(2026-09-17)。停摆了就**如实拒**,不假装收下 ——
   * 一条没人执行的「下载」比一句「现在不行」糟得多。
   */
  async model(op: IndexModelOp): Promise<ModelStatus> {
    if (this.dead) throw new IndexWorkerUnavailableError()
    return await this.send({ type: 'model', op }) as ModelStatus
  }

  /** 模型那一发落定了。返回退订。 */
  onModelSettled(listener: (state: ModelState) => void): () => void {
    this.modelListeners.add(listener)
    return () => this.modelListeners.delete(listener)
  }

  async enqueue(feedId: string, key: string, hint?: unknown): Promise<void> {
    await this.send({ type: 'enqueue', feedId, key, ...(hint !== undefined ? { hint } : {}) })
  }

  async rebuild(): Promise<void> {
    await this.send({ type: 'rebuild' })
  }

  async drain(): Promise<void> {
    await this.send({ type: 'drain' })
  }

  /**
   * 停了就**当场答** `{ mode: 'error' }` —— 不往一条已经没有的 Worker 上发消息等
   * 超时。其它格给零值:壳照 §9 画「没搜成」,而不是画「0 条结果」。
   */
  async status(): Promise<IndexStatus> {
    if (this.dead) {
      return {
        mode: 'error', docs: 0, pending: 0, refolds: 0, building: false, generation: 0,
        errors: [], feeds: [], vector: 'off', vectorPending: 0, vectorExtension: 'missing',
      }
    }
    return await this.send({ type: 'status' }) as IndexStatus
  }

  // ---- 往返 -------------------------------------------------------------

  private send(message: IndexWorkerRequestBody): Promise<unknown> {
    if (this.disposed) return Promise.reject(new IndexWorkerUnavailableError())
    /*
     * 换 Worker 期间**排队而不是拒绝**(见 `restart()` 的头注):空窗只有几十毫秒,
     * 而一句「搜不了」会留在屏幕上。排在这里的那几发由 `flushWaiting()` 原序发出。
     */
    if (this.swap !== undefined) {
      return new Promise<unknown>((resolve, reject) => {
        this.waiting.push({ message, resolve, reject })
      })
    }
    if (this.dead) return Promise.reject(new IndexWorkerUnavailableError())
    if (this.handle === undefined) this.spawn()
    const handle = this.handle
    if (handle === undefined) return Promise.reject(new IndexWorkerUnavailableError())

    const id = this.nextId
    this.nextId += 1
    return new Promise<unknown>((resolve, reject) => {
      this.inFlight.set(id, { resolve, reject })
      try {
        handle.endpoint.postMessage({ ...message, id } as IndexWorkerRequest)
      } catch (error) {
        this.inFlight.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private spawn(): void {
    const handle = this.factory()
    this.handle = handle
    handle.endpoint.on('message', value => {
      // **日志帧先认领**:它不带 `id`,否则下一行会把它当成一条没人等的答复扔掉
      // (2026-09-17 以前正是这样 —— Worker 里的每一句话都掉在地上,见 `worker-logging.ts`)。
      if (isWorkerLogMessage(value)) {
        relayWorkerLog(value)
        return
      }
      // 模型通知帧同理:它也不带 `id`,也不是谁在等的一条答复。
      if (isWorkerModelMessage(value)) {
        for (const listener of this.modelListeners) {
          try {
            listener(value.state)
          } catch (error) {
            log.warn('a model-settled listener threw', { err: error })
          }
        }
        return
      }
      const response = value as IndexWorkerResponse
      const pending = this.inFlight.get(response.id)
      if (pending === undefined) return
      this.inFlight.delete(response.id)
      this.notifyIdle()
      if (response.ok) {
        // 一次成功的往返 = 这一条 Worker 活过来了 —— 「连续」的计数在这里清零,
        // 否则一天里前后崩两次(各自恢复过)也会被当成「连崩两次」。
        this.consecutiveCrashes = 0
        pending.resolve(response.result)
      } else {
        pending.reject(new Error(response.error))
      }
    })
    // 两条监听都按**句柄身份**认领:换 Worker 时我们自己 `terminate()` 的那一条
    // 会照样喊 error / exit,而它的死是我们要的,不是崩溃(不然换一次设置就会被
    // 记一次「连崩」,两次就把索引判死)。
    handle.onError(error => {
      if (this.disposed || this.handle !== handle) return
      log.error('index worker errored', { err: error })
      this.onCrash()
    })
    handle.onExit(code => {
      if (this.disposed || this.handle !== handle) return
      log.error('index worker exited', { fields: { code } })
      this.onCrash()
    })
  }

  private onCrash(): void {
    if (this.disposed || this.dead) return
    this.handle = undefined
    this.consecutiveCrashes += 1
    this.rejectInFlight(new IndexWorkerUnavailableError('index worker crashed'))
    if (this.consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
      this.dead = true
      log.error('index worker crashed twice in a row; giving up', {
        fields: { crashes: this.consecutiveCrashes },
      })
      return
    }
    // 重起一次。**不必回放什么** —— 检查点在库里,新 Worker 的启动校对会把停摆
    // 期间的差补齐(§5.4)。
    log.warn('restarting index worker from checkpoint', { fields: { crashes: this.consecutiveCrashes } })
    this.spawn()
  }

  private rejectInFlight(error: Error): void {
    for (const pending of this.inFlight.values()) pending.reject(error)
    this.inFlight.clear()
    this.notifyIdle()
  }
}
