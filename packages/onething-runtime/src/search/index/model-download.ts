/**
 * `ModelDownloader` —— **模型是一件独立的东西**:它有自己的状态、自己的进度、自己的
 * 三个动作(下载 / 取消 / 删除),与「按含义找」那个开关无关。
 *
 * 设计:docs/design/search-index-2026-09.md §15.8(2026-09-17 用户裁定:「把开关和
 * 下载模型拆开,另外下载模型要能够知道进度」)。
 *
 * 在这之前:翻开关 = 换一条 Worker = 嵌入器 `ready()` 里顺带下 112.8 MB(真机冷下
 * 191 秒),屏上只有一句「正在下载模型…」——**没有进度,也取消不了**。
 *
 * ## 它住在 Worker 里
 *
 * 与 `VectorWriter` 同一条理由(§15.2):这条线程上已经有一只受管 fetch(会走 app 的
 * 代理,§15.7)、一条通回宿主 `app.jsonl` 的日志线,而下载这件事本来就是后台 I/O。
 * 主线程那一侧只多一次 `postMessage`。
 *
 * ## 四个态,以及它们之间怎么走
 *
 * | 态 | 什么时候 | `loadedBytes` / `totalBytes` |
 * | --- | --- | --- |
 * | `absent` | 清单说没下全(含「取消过」「刚删过」「从没下过」) | — / 嵌入器自述的估计值 |
 * | `downloading` | `download()` 起了一发还没落定 | 逐文件读数的和 / 已知 total 的和 |
 * | `ready` | 清单核对通过 | 磁盘上的真数(两格相同) |
 * | `failed` | 那一发以**非取消**的错误结束 | 停在当时的读数 |
 *
 * **取消不是失败**:它回 `absent`,不留错话 —— 人自己按的那一下不该在屏幕上留下一句
 * 红字。失败才留(`errorKind` + 原话,判据表与语义召回自己关回去那条**共用**
 * `describeEmbedderFailure`,不抄第二份)。
 *
 * ## 「下了一半算不算下了」
 *
 * 不算,而且这件事是**结构上**成立的,不是靠这里的 if:判据在 `model-store.ts` —— 清单
 * 是下载**落定之后**才写的,取消 / 半途死掉都没有清单。这个类每次要答「在不在」时
 * 都去问它,不靠自己记(进程重启、别的进程删了目录,记忆都会说谎)。
 */

import { getLogger } from '../../logging/index.js'
import {
  captureModelManifest,
  probeEmbedderModel,
  removeEmbedderModel,
} from '../embedding/model-store.js'
import type { EmbedderFactory } from '../embedding/registry.js'
import { describeEmbedderFailure, type VectorErrorKind } from './vector-writer.js'

const log = getLogger('search.index.model')

/** 模型此刻的样子(投影成 `SearchStatusResponse.model`)。 */
export type ModelState = 'absent' | 'downloading' | 'ready' | 'failed'

export interface ModelStatus {
  /** 嵌入器注册 id。**是数据**(设置里的 `modelId`),不是文案。 */
  id: string
  state: ModelState
  loadedBytes?: number
  totalBytes?: number
  errorKind?: VectorErrorKind
  error?: string
}

/** 开关开着的时候不许删 —— 那是把正在用的东西从底下抽走。 */
export const MODEL_IN_USE_ERROR = 'model-in-use'

/** 这条嵌入器根本没有可下的模型(假嵌入器)。 */
export const MODEL_NOT_DOWNLOADABLE_ERROR = 'model-not-downloadable'

/** 取消用的那只闸(`worker-network.ts` 的 `WorkerDownloadSignal` 就是这个形)。 */
export interface ModelDownloadSignalSource {
  begin(): AbortSignal
  abort(): void
  end(): void
}

export interface ModelDownloaderOptions {
  factory: EmbedderFactory
  /** `<store>/models/embeddings/<modelId>`(装配算好递进来)。 */
  modelDir: string
  signals?: ModelDownloadSignalSource
  /**
   * 这一条 Worker 此刻在用这份模型吗。**用来拒绝「删除」** —— 判据不在这个类里
   * (它不认识「语义召回开关」这件事),由 `worker-core` 按「这条 Worker 装没装
   * 向量写路」答。
   */
  inUse?(): boolean
}

export class ModelDownloader {
  private readonly options: ModelDownloaderOptions
  private state: ModelState
  /** 逐文件的读数。聚合成总数时**只加,不猜**。 */
  private readonly files = new Map<string, { loaded: number; total?: number }>()
  private running: Promise<void> | undefined
  /** 本轮的编号:取消之后,旧那一轮落定时不许再改状态。 */
  private round = 0
  private cancelled = false
  private failure: { kind: VectorErrorKind; reason: string } | undefined
  /** 下全了多少字节(`ready` 那一态的真数,来自清单)。 */
  private readyBytes = 0
  private readonly listeners = new Set<(state: ModelState) => void>()

  constructor(options: ModelDownloaderOptions) {
    this.options = options
    const probe = probeEmbedderModel(options.modelDir, options.factory.id)
    this.state = probe.state
    this.readyBytes = probe.bytes
  }

  /**
   * 落定时喊一声(`'ready'` / `'failed'` / 取消后的 `'absent'`)。
   *
   * 唯一的听众是 `IndexWorkerCore` —— 它把这一声 `postMessage` 给宿主,宿主据此在
   * 「开关本来就开着」时换一条 Worker(见 `backend/wiring/search/index.ts`)。
   * **不要求用户再翻一次开关**。
   */
  onSettled(listener: (state: ModelState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  status(): ModelStatus {
    const id = this.options.factory.id
    switch (this.state) {
      case 'ready':
        return { id, state: 'ready', loadedBytes: this.readyBytes, totalBytes: this.readyBytes }
      case 'downloading':
        return { id, state: 'downloading', loadedBytes: this.loaded(), totalBytes: this.total() }
      case 'failed':
        return {
          id,
          state: 'failed',
          loadedBytes: this.loaded(),
          totalBytes: this.total(),
          ...(this.failure === undefined
            ? {}
            : { errorKind: this.failure.kind, error: this.failure.reason }),
        }
      case 'absent':
        return {
          id,
          state: 'absent',
          // **估计值只在这一态露脸**:真数要等下完才有(见 `EmbedderModelSpec`)。
          ...(this.options.factory.model === undefined
            ? {}
            : { totalBytes: this.options.factory.model.approxBytes }),
        }
    }
  }

  /**
   * 开始下载。**幂等**:正在下 / 已经下全了都当场原样答,不重下。
   *
   * 它**不等下载完**(112.8 MB 冷下 191 秒,一条 HTTP 往返等不了那么久)——
   * 答的是「这一发起来了」,进度由调用方轮 `status()` 读。
   */
  download(): ModelStatus {
    if (this.state === 'downloading' || this.state === 'ready') return this.status()
    const download = this.options.factory.download
    if (download === undefined) throw new Error(MODEL_NOT_DOWNLOADABLE_ERROR)

    this.round += 1
    const round = this.round
    this.cancelled = false
    this.failure = undefined
    this.files.clear()
    this.state = 'downloading'

    const signal = this.options.signals?.begin()
    this.running = download({
      modelDir: this.options.modelDir,
      ...(signal === undefined ? {} : { signal }),
      onFile: progress => {
        // 晚到的那一轮的读数不许污染这一轮(取消之后立刻重下,两轮会重叠一小段)。
        if (round !== this.round) return
        this.files.set(progress.file, {
          loaded: progress.loaded,
          ...(progress.total === undefined ? {} : { total: progress.total }),
        })
      },
    }).then(
      () => this.settle(round, undefined),
      (error: unknown) => this.settle(round, error),
    )
    log.info('embedding model download started', { fields: { model: this.options.factory.id } })
    return this.status()
  }

  /**
   * 取消。**当场回 `absent`** —— 人按了停,屏幕就该立刻不再写「正在下载」;在飞的那
   * 一发由 signal 断掉,半截文件由 `FileCache` 自己的 `catch` 删掉。
   *
   * 落定时再问一次磁盘(`settle`):万一它在 abort 送到之前已经下完了,那就是 `ready`,
   * 不是 `absent` —— 说磁盘上真有的那件事,不说我们刚才想要的那件事。
   */
  cancel(): ModelStatus {
    if (this.state !== 'downloading') return this.status()
    this.cancelled = true
    this.options.signals?.abort()
    this.state = 'absent'
    log.info('embedding model download cancelled', { fields: { model: this.options.factory.id } })
    return this.status()
  }

  /**
   * 把模型删了。开关开着时**拒**(`MODEL_IN_USE_ERROR`)—— 壳那一侧那颗钮本来就禁着,
   * 这是结构上的第二道。
   */
  remove(): ModelStatus {
    if (this.options.inUse?.() === true) throw new Error(MODEL_IN_USE_ERROR)
    if (this.state === 'downloading') this.cancel()
    removeEmbedderModel(this.options.modelDir)
    this.files.clear()
    this.failure = undefined
    this.readyBytes = 0
    this.state = 'absent'
    log.info('embedding model removed', { fields: { model: this.options.factory.id } })
    return this.status()
  }

  /** 在飞的那一发落定再答(单测与门用;生产没有人等它)。 */
  async drain(): Promise<void> {
    while (this.running !== undefined) {
      const running = this.running
      await running
      if (this.running === running) this.running = undefined
    }
  }

  /**
   * 一发下载的收场。**判据是磁盘,不是这一发的成败** —— 成了就照现场写一份清单,
   * 然后无论如何都再核对一遍(`probeEmbedderModel`),核对说 ready 才是 ready。
   */
  private settle(round: number, error: unknown): void {
    if (round !== this.round) return
    this.running = undefined
    this.options.signals?.end()
    const cancelled = this.cancelled
    this.cancelled = false

    if (error === undefined) {
      try {
        captureModelManifest(this.options.modelDir, this.options.factory.id)
      } catch (writeError) {
        // 清单写不下去 = 这份模型说不出「我下全了」。如实当成一次失败。
        log.warn('writing the model manifest failed', undefined, writeError)
      }
    }

    const probe = probeEmbedderModel(this.options.modelDir, this.options.factory.id)
    this.readyBytes = probe.bytes
    if (probe.state === 'ready') {
      this.state = 'ready'
      this.failure = undefined
      log.info('embedding model is ready', { fields: { bytes: probe.bytes } })
      this.emit('ready')
      return
    }
    if (error === undefined || cancelled) {
      // 取消,或者「那一发说成了但磁盘上不齐」——两样都不是错话,都是「还没下」。
      this.state = 'absent'
      this.emit('absent')
      return
    }
    this.state = 'failed'
    this.failure = describeEmbedderFailure(error)
    log.warn('embedding model download failed', { fields: { kind: this.failure.kind } }, error)
    this.emit('failed')
  }

  private emit(state: ModelState): void {
    for (const listener of this.listeners) {
      try {
        listener(state)
      } catch (error) {
        log.warn('a model-settled listener threw', undefined, error)
      }
    }
  }

  /** 已经下了多少 —— 逐文件的和。每个文件自己单调,所以这个和也单调。 */
  private loaded(): number {
    let sum = 0
    for (const file of this.files.values()) sum += file.loaded
    return sum
  }

  /**
   * 一共多少 —— **只加已知的那几个**(`Content-Length` 没给的文件不算,不用估计值
   * 去凑)。于是它在下载途中是**单调不减**的:每认识一个新文件就长一截,而那一百
   * 多兆的 onnx 一露面就占了 97%,所以屏幕上的百分比不会来回跳。
   *
   * 兜一道 `loaded`:总数还没认识完的那一瞬,别让分子大过分母。
   */
  private total(): number {
    let sum = 0
    for (const file of this.files.values()) sum += file.total ?? 0
    return Math.max(sum, this.loaded())
  }
}
