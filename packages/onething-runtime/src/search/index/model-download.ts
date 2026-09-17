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
 *
 * ## 认领:清单缺席、文件却在(2026-09-17 下午的事故,§15.8「认领」)
 *
 * 上一版「翻开关即下载」把 113 MB 完整地下到了盘上;这一版把判据换成清单,于是那份
 * **真的下全了的**模型因为没有清单被当成没下过 —— 用户的原话是「为什么下载了也当做
 * 没下载?」。这是新判据的迁移漏洞,不是它错。
 *
 * 补法不是退回「看文件在不在」(那条路为什么不成立,`model-store.ts` 头上写着),而是
 * **试装一次**:清单缺席但目录里有东西时,拿嵌入器自己那条只读本地的装载路走一遍 ——
 * **装得上是唯一一个不联网就说得出口的「这堆文件是完整的」**。装得上就照磁盘上真实的
 * 文件与字节数补一份清单(`ready`);装不上就维持 `absent`,**文件一个都不删**(下一次
 * 「下载」等于续传,transformers 自己认得已经下全的那几个)。
 *
 * 三件配套的规矩,都在下面的代码里:
 *  - **空目录不试装** —— 那是「从没下过」,一次装载都不该发生(`gate:search-index` ⑬a
 *    的「零网络」有一半是它);
 *  - **试装期间 `status()` 答 `undefined`**(整格缺席 = 壳的 unknown「检查中…」)。
 *    不为它加第五个态:契约少一格是一格,而「还不知道」这件事屏幕上早就有画法了;
 *  - **不装第二遍 118 MB** —— 开关开着时试装走的**就是**这条 Worker 的嵌入器那一次
 *    装载(`tryLoad` 由 `worker.ts` 递进来),所以认领成功时它已经在用了,不必再喊
 *    宿主换 Worker。
 */

import { getLogger } from '../../logging/index.js'
import {
  captureModelManifest,
  hasEmbedderModelFiles,
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
  /**
   * **试装一次**(2026-09-17 认领):把 `modelDir` 里那堆文件在本地装起来,装得上就
   * 正常返回、装不上就抛。不出网(嵌入器那一侧钉着 `allowRemoteModels = false`)。
   *
   * 由 `worker.ts` 递进来,因为「装哪一次」是**装配**的事:这条 Worker 有嵌入器
   * (开关开着)就递它的 `ready()` —— 认领与正经装载共用同一次,不装第二遍 118 MB;
   * 没有嵌入器才递嵌入器工厂自述的 `verify`(装完就把会话还回去)。
   *
   * 缺席 = 这条 Worker 没法试装,于是没有认领这回事(清单缺席就一律 `absent`)。
   */
  tryLoad?(): Promise<void>
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
  /** 正在试装的那一发(2026-09-17 认领)。在飞 = 这台机器上「有没有」还没答得出。 */
  private adopting: Promise<void> | undefined

  constructor(options: ModelDownloaderOptions) {
    this.options = options
    const probe = probeEmbedderModel(options.modelDir, options.factory.id)
    this.state = probe.state
    this.readyBytes = probe.bytes
    /*
     * **认领**(见文件头):清单缺席、目录里却有东西 —— 那多半是上一版下全的那一份。
     * 异步做,`start()` 与词法查询一步都不等它。空目录不试装:那是「从没下过」。
     */
    if (
      probe.state === 'absent'
      && options.tryLoad !== undefined
      && hasEmbedderModelFiles(options.modelDir)
    ) {
      this.beginAdoption(options.tryLoad)
    }
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

  /**
   * 此刻的模型状态,**或者 `undefined` = 还在试装、说不出口**(2026-09-17 认领)。
   *
   * 缺席与「没下载」不是一回事:`IndexWorkerCore` 把缺席原样传下去(`status.model`
   * 整格不出现),壳读成 unknown「检查中…」,一颗钮都不画。试装几秒钟里报一句
   * 「未下载」再翻成「已下载」,那是**闪一下错话**,比不说话糟。
   */
  status(): ModelStatus | undefined {
    return this.adopting === undefined ? this.describe() : undefined
  }

  /**
   * 这份模型在磁盘上占了多少(2026-09-18 的「占用空间」那一节)。
   *
   * 答的是**清单核对过的那个真数**(`readyBytes`),所以它与设置页模型行上那句
   * 「已下载 · 129 MB」是同一个数,不是第二个产地。没下全 = 0(半截文件不算数,
   * 与 `probeEmbedderModel` 同一条判据);**估计值一个字都不进来** —— 这一格问的是
   * 「此刻占了多少地方」,而「约 113 MB」是「下下来会占多少」,那是另一句话。
   */
  storageBytes(): number {
    return this.state === 'ready' ? this.readyBytes : 0
  }

  /** 这一刻磁盘与状态机合起来的样子。**一定答得出** —— 三个动作的回执用它。 */
  private describe(): ModelStatus {
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
    if (this.state === 'downloading' || this.state === 'ready') return this.describe()
    const download = this.options.factory.download
    if (download === undefined) throw new Error(MODEL_NOT_DOWNLOADABLE_ERROR)

    // 人按了「下载」就下载:在飞的那一发试装作废(它的结论此后不许改状态)。
    this.abandonAdoption()
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
    return this.describe()
  }

  /**
   * 取消。**当场回 `absent`** —— 人按了停,屏幕就该立刻不再写「正在下载」;在飞的那
   * 一发由 signal 断掉,半截文件由 `FileCache` 自己的 `catch` 删掉。
   *
   * 落定时再问一次磁盘(`settle`):万一它在 abort 送到之前已经下完了,那就是 `ready`,
   * 不是 `absent` —— 说磁盘上真有的那件事,不说我们刚才想要的那件事。
   */
  cancel(): ModelStatus {
    if (this.state !== 'downloading') return this.describe()
    this.cancelled = true
    this.options.signals?.abort()
    this.state = 'absent'
    log.info('embedding model download cancelled', { fields: { model: this.options.factory.id } })
    return this.describe()
  }

  /**
   * 把模型删了。开关开着时**拒**(`MODEL_IN_USE_ERROR`)—— 壳那一侧那颗钮本来就禁着,
   * 这是结构上的第二道。
   */
  remove(): ModelStatus {
    if (this.options.inUse?.() === true) throw new Error(MODEL_IN_USE_ERROR)
    if (this.state === 'downloading') this.cancel()
    // 文件正要没了,在飞的那一发试装说什么都不算数了。
    this.abandonAdoption()
    this.round += 1
    removeEmbedderModel(this.options.modelDir)
    this.files.clear()
    this.failure = undefined
    this.readyBytes = 0
    this.state = 'absent'
    log.info('embedding model removed', { fields: { model: this.options.factory.id } })
    return this.describe()
  }

  /**
   * 在飞的那一发落定再答(单测与门用;生产没有人等它)。**试装也算一发** ——
   * 认领与下载是同一个状态机上的两条路,等一件事不该只等其中一条。
   */
  async drain(): Promise<void> {
    while (this.running !== undefined || this.adopting !== undefined) {
      const running = this.running
      const adopting = this.adopting
      await Promise.all([running, adopting])
      if (running !== undefined && this.running === running) this.running = undefined
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

  /**
   * 试装那一发起飞。**不 await** —— Worker 起身、词法查询一步都不等它;它在飞的这
   * 几秒里 `status()` 答 `undefined`(壳画「检查中…」)。
   */
  private beginAdoption(tryLoad: () => Promise<void>): void {
    const round = this.round
    this.adopting = this.adopt(tryLoad, round).finally(() => {
      // 中途有人按了下载 / 删除(round 变了)= 这一发已经被作废,别把新的清掉。
      if (round === this.round) this.adopting = undefined
    })
  }

  /**
   * 认领一份**盘上已经有、却没有清单**的模型(见文件头)。
   *
   * 顺序是死的:**先装得上,再写清单,最后照清单核对一遍** —— 清单永远是「下载 /
   * 认领落定之后」才落的那一笔,`probeEmbedderModel` 仍然是唯一的判据。
   */
  private async adopt(tryLoad: () => Promise<void>, round: number): Promise<void> {
    const startedAt = Date.now()
    try {
      await tryLoad()
    } catch (error) {
      if (round !== this.round) return
      /*
       * 装不上 = 这堆文件不完整(截断的 onnx / 少一件)。维持 `absent`,而且
       * **一个文件都不删**:transformers 自己认得已经下全的那几个,下一次「下载」
       * 就是续传。原话记一条,人问起来时日志里有。
       */
      log.warn('model files on disk could not be adopted; they are left as they are', {
        fields: { model: this.options.factory.id },
      }, error)
      return
    }
    if (round !== this.round) return

    let files: number
    try {
      files = Object.keys(captureModelManifest(this.options.modelDir, this.options.factory.id).files).length
    } catch (error) {
      log.warn('writing the adopted model manifest failed', undefined, error)
      return
    }
    const probe = probeEmbedderModel(this.options.modelDir, this.options.factory.id)
    if (probe.state !== 'ready') {
      // 装得上却核对不过 = 写清单与核对之间文件动过。不猜,维持 `absent`。
      log.warn('the adopted model did not survive its own check', {
        fields: { model: this.options.factory.id },
      })
      return
    }
    this.readyBytes = probe.bytes
    this.failure = undefined
    this.state = 'ready'
    log.info('adopted model files found on disk', {
      fields: {
        model: this.options.factory.id,
        files,
        bytes: probe.bytes,
        ms: Date.now() - startedAt,
      },
    })
    /*
     * **喊不喊这一声,看这条 Worker 自己用不用得上**。这一声的用处只有一个:让宿主
     * 换一条 Worker,好让模型生效(`backend/wiring/search/index.ts`)。而 `inUse()`
     * 为真时,试装走的**就是**这条 Worker 的嵌入器那一次装载(接线在 `worker.ts`)
     * —— 它已经装好、向量路已经能走,换一条只会把它扔掉再装一遍 118 MB。
     */
    if (this.options.inUse?.() !== true) this.emit('ready')
  }

  /** 在飞的那一发试装作废(按下载 / 删除时)。它落定时会看 round,什么都不会改。 */
  private abandonAdoption(): void {
    this.adopting = undefined
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
