/**
 * `VectorWriter` —— 嵌入的**写路**:文档落库之后把该嵌的字段切段、成批喂模型、
 * 写进向量索引。它住 Worker 里(§15.2「wasm 在 Worker 里跑,主线程零 CPU」)。
 *
 * 设计:docs/design/search-index-2026-09.md §15.3 / §15.4
 *
 * ## 三条纪律
 *
 *  ① **写路永不阻塞折**。`IndexWorkerCore.refold` 只喊一声 `enqueue(docId)` 就走;
 *     真正的前向在这只写路自己的循环里跑。词法路的读数(`gate:search-index` ⑤ 那
 *     三个窗口)因此不会被嵌入拖下水。
 *  ② **每批之后让出**(缺省 32 段一批)。`setImmediate` 一次,让 Worker 的消息循环
 *     有机会答查询 —— 冷嵌一万四千段要几分钟,期间搜索必须照常。
 *  ③ **`DocumentFilter` 早已跑过**。这只写路读的是 `IndexedDoc.fields`,那是**脱敏
 *     之后**的正文(§15.3 末句)。原文一个字都不会进模型。
 *
 * ## 换模型 = 全量重嵌
 *
 * 库头 `meta.embeddingModelId` 与当前嵌入器 id 不符 → `vector.clear()` + 全库排队
 * (§5.4)。**词法路一行不动** —— 那是同一个库里两套派生数据,各自重建。
 */

import type { Embedder, IndexedDoc, VectorIndex } from '@onething/core/search'

import { getLogger } from '../../logging/index.js'
import { chunkForEmbedding } from '../embedding/embedder.js'

const log = getLogger('search.index.vector')

/** 一批喂多少段。§15.3 写的就是 32。 */
export const EMBED_BATCH_SIZE = 32

/** 语义召回此刻在干什么(投影成 `SearchStatusResponse.vector`)。 */
export type VectorState = 'off' | 'downloading' | 'embedding' | 'ready'

export interface VectorWriterIndexFace {
  get(docId: number): IndexedDoc | undefined
  byKey(capability: string, key: string): IndexedDoc[]
  allDocIds(): number[]
}

export interface VectorWriterOptions {
  index: VectorWriterIndexFace
  vector: VectorIndex
  embedder: Embedder
  /** 这个能力的哪几个字段要嵌(读 manifest.schema 的 `embed: true`)。 */
  embedFields(capability: string): string[]
  batchSize?: number
  /** 状态变了喊一声(worker-core 拿它更新 `status`)。 */
  onState?(state: VectorState): void
}

export class VectorWriter {
  private readonly options: VectorWriterOptions
  private readonly batchSize: number
  private readonly queue = new Set<number>()
  private running: Promise<void> | undefined
  private readyPromise: Promise<void> | undefined
  private state: VectorState = 'downloading'
  private disposed = false

  constructor(options: VectorWriterOptions) {
    this.options = options
    this.batchSize = options.batchSize ?? EMBED_BATCH_SIZE
  }

  currentState(): VectorState {
    return this.state
  }

  pending(): number {
    return this.queue.size
  }

  /**
   * 装载模型(下载 / 解压 / 编译 wasm)。**幂等**,失败把状态钉在 `'off'` 并把原话
   * 交给调用方 —— 调用方(worker-core)据此关掉开关,不在这里重试到死(§15.3)。
   */
  ready(): Promise<void> {
    if (this.readyPromise === undefined) {
      this.setState('downloading')
      this.readyPromise = this.options.embedder.ready().then(() => {
        this.setState(this.queue.size > 0 ? 'embedding' : 'ready')
      })
    }
    return this.readyPromise
  }

  /**
   * 一份文档待嵌。整键重折之后,这一把钥匙下的每份文档各喊一次。
   *
   * **关掉了就不再收活**:`'off'` 是吸收态,往一只已经关掉的写路里堆 docId 只会让队列
   * 无界地长(而且 `drain()` 会在一个永远不动的队列上空转 —— 施工时真踩到,是个死循环)。
   */
  enqueue(docId: number): void {
    if (this.disposed || this.state === 'off') return
    this.queue.add(docId)
    this.setState('embedding')
    void this.pump()
  }

  enqueueKey(capability: string, key: string): void {
    for (const doc of this.options.index.byKey(capability, key)) this.enqueue(doc.docId)
  }

  /** 换模型:清空向量,全库排队(§5.4「换模型 = 后台全量重嵌」)。 */
  reembedAll(): void {
    this.options.vector.clear()
    for (const docId of this.options.index.allDocIds()) this.queue.add(docId)
    log.info('re-embedding the whole index', {
      fields: { docs: this.queue.size, embedder: this.options.embedder.id },
    })
    this.setState(this.queue.size > 0 ? 'embedding' : 'ready')
    void this.pump()
  }

  /** 队列排空再答(单测与门用;生产没有人等它)。 */
  async drain(): Promise<void> {
    while (this.queue.size > 0 || this.running !== undefined) {
      if (this.running !== undefined) { await this.running; continue }
      await this.pump()
    }
  }

  /**
   * 一条查询的向量。模型没装好就答 `undefined` —— 召回器据此答空,不假装。
   *
   * **`ready()` 抛也走这条降级路**,不往查询上抛:打包桌面档里
   * `@huggingface/transformers` 根本不在(`electron-builder.yml` 排除了它,拍点癸' (c)),
   * 于是开关被打开、又恰好没有任何文档触发过写路的时候,**第一条查询就是装载失败的现场**。
   * 那时该发生的是「把开关关回去 + 一条 warn + 词法路照常」,不是查询报错。
   * `markOff` 是幂等的,所以之后每条查询在第一行就被 `'off'` 挡回去 —— **warn 只有一条**。
   */
  async embedQuery(text: string, signal?: AbortSignal): Promise<Float32Array | undefined> {
    if (this.currentState() === 'off') return undefined
    try {
      await this.ready()
    } catch (error) {
      this.markOff(error)
      return undefined
    }
    // `ready()` 期间状态可能翻成 `'off'`(装载失败),所以过了 await 要再问一次。
    if (this.currentState() === 'off') return undefined
    const [vector] = await this.options.embedder.embed([text], 'query', signal)
    return vector
  }

  dispose(): void {
    this.disposed = true
    this.queue.clear()
  }

  private setState(next: VectorState): void {
    if (this.state === next) return
    // `'off'` 是个吸收态:关掉了就不许被后来的一句 `'embedding'` 悄悄打开。
    if (this.state === 'off') return
    this.state = next
    this.options.onState?.(next)
  }

  /**
   * 关回去。**幂等** —— 写路与查询路都会撞上同一个装载失败(`ready()` 的 promise 是
   * 记住的,两边 await 的是同一条拒绝),关过一次之后不再重复 `warn`:排障要的是
   * 「它什么时候关的、为什么」一条,不是每查一次刷一行。
   */
  private markOff(error: unknown): void {
    const alreadyOff = this.state === 'off'
    // 状态与队列**每次都收拾**(幂等的是「说这句话」,不是「收拾现场」——
    // 早退到 `queue.clear()` 前面会留下一个永远不动的队列,`drain()` 当场空转)。
    this.state = 'off'
    this.queue.clear()
    if (alreadyOff) return
    this.options.onState?.('off')
    // 错误进**第三格**(`Logger.warn(msg, fields, err)`),不是塞进 fields —— 仓顶那条
    // 「变量进 fields、错误进 err」;塞错格子 `log:tail --level warn` 就打不出原话。
    log.warn('semantic recall turned itself off', undefined, error)
  }

  private pump(): Promise<void> {
    if (this.running !== undefined) return this.running
    const run = (async () => {
      try {
        await this.ready()
      } catch (error) {
        this.markOff(error)
        return
      }
      while (this.queue.size > 0 && !this.disposed && this.state !== 'off') {
        const docId = this.queue.values().next().value as number
        this.queue.delete(docId)
        try {
          await this.embedDoc(docId)
        } catch (error) {
          // 一份文档嵌坏了只坏它自己 —— 与折坏隔离同一条纪律(§5.3 末句)。
          log.warn('embedding one document failed; the rest continue', {
            fields: { docId },
            err: error,
          })
        }
        // ② 让出:冷嵌期间搜索必须照常。
        await new Promise<void>(resolve => { setImmediate(resolve) })
      }
      if (this.state !== 'off') this.setState('ready')
    })()
    this.running = run
    return run.finally(() => { this.running = undefined })
  }

  private async embedDoc(docId: number): Promise<void> {
    const doc = this.options.index.get(docId)
    // 文档在排队期间被删了。`remove` 是幂等的,喊一声就当收尾。
    if (doc === undefined) { this.options.vector.remove(docId); return }

    const fields = this.options.embedFields(doc.capability)
    const text = fields
      .map(field => doc.fields[field] ?? '')
      .filter(value => value.length > 0)
      .join('\n')
      .trim()

    this.options.vector.remove(docId)
    if (text.length === 0) return

    const chunks = chunkForEmbedding(text, this.options.embedder)
    for (let at = 0; at < chunks.length; at += this.batchSize) {
      const batch = chunks.slice(at, at + this.batchSize)
      const vectors = await this.options.embedder.embed(batch.map(c => c.text), 'passage')
      batch.forEach((chunk, index) => {
        const vector = vectors[index]
        if (vector !== undefined) this.options.vector.upsert(docId, chunk.chunk, vector)
      })
      if (at + this.batchSize < chunks.length) {
        await new Promise<void>(resolve => { setImmediate(resolve) })
      }
    }
  }
}
