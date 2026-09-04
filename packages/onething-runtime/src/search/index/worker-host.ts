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
import type {
  IndexEndpoint,
  IndexSearchRequest,
  IndexSearchResult,
  IndexStatus,
  IndexWorkerRequest,
  IndexWorkerResponse,
} from './worker-core.js'

const log = getLogger('search.index.host')

/** 连崩几次就不再重起(§5.3 末句)。 */
export const MAX_CONSECUTIVE_CRASHES = 2

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

export class IndexWorkerHost {
  private readonly factory: IndexWorkerFactory
  private handle: IndexWorkerHandle | undefined
  private readonly inFlight = new Map<number, InFlight>()
  private nextId = 1
  private consecutiveCrashes = 0
  private dead = false
  private disposed = false

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
    const handle = this.handle
    this.handle = undefined
    if (handle !== undefined) await handle.terminate()
  }

  /** 停了没有(连崩两次)。`status()` 的 `mode` 由它翻成 `'error'`。 */
  get stopped(): boolean {
    return this.dead
  }

  // ---- 四种消息 ---------------------------------------------------------

  async search(request: IndexSearchRequest): Promise<IndexSearchResult> {
    return await this.send({ type: 'query', request }) as IndexSearchResult
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
      return { mode: 'error', docs: 0, pending: 0, building: false, generation: 0, errors: [] }
    }
    return await this.send({ type: 'status' }) as IndexStatus
  }

  // ---- 往返 -------------------------------------------------------------

  private send(message: IndexWorkerRequestBody): Promise<unknown> {
    if (this.dead || this.disposed) return Promise.reject(new IndexWorkerUnavailableError())
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
      const response = value as IndexWorkerResponse
      const pending = this.inFlight.get(response.id)
      if (pending === undefined) return
      this.inFlight.delete(response.id)
      if (response.ok) {
        // 一次成功的往返 = 这一条 Worker 活过来了 —— 「连续」的计数在这里清零,
        // 否则一天里前后崩两次(各自恢复过)也会被当成「连崩两次」。
        this.consecutiveCrashes = 0
        pending.resolve(response.result)
      } else {
        pending.reject(new Error(response.error))
      }
    })
    handle.onError(error => {
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
  }
}
