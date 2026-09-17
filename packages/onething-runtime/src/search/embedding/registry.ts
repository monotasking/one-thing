/**
 * 嵌入器注册表(§15.3)。**模型是数据,换运行时 = 一个模块 + 一行注册。**
 *
 * 设计:docs/design/search-index-2026-09.md §15.3(拍点癸)
 *
 * 拍点癸 b(换 `onnxruntime-node`)真要来的时候,这个文件一个字都不用改:多一个
 * `registerEmbedder(createOnnxEmbedder())`,设置里 `modelId` 换一个值就完事。
 * 注册表本身不认识任何模型 —— 它只按 id 存取工厂。
 */

import type { Embedder } from '@onething/core/search'

export interface EmbedderFactory {
  readonly id: string
  create(options: EmbedderCreateOptions): Embedder
  /**
   * 这条嵌入器有没有一份**要先下载的模型**(2026-09-17;契约只加)。
   *
   * 缺席 = 没有(假嵌入器就是这一档:它是一张同义词表,没有什么可下的)。
   * 在场 = 设置页会为它画一行「模型」,带下载 / 取消 / 删除三个动作。
   */
  readonly model?: EmbedderModelSpec
  /**
   * 把模型文件下到 `modelDir`。**缺席 = 不用下**(与 `model` 同生同灭)。
   *
   * 它与 `create(...).ready()` 是两件事,这正是 2026-09-17 用户裁定的那一刀:
   * 从前「翻开关」= 换 Worker = `ready()` 里顺带下 112.8MB(冷 191 秒,屏上只有
   * 一句「正在下载模型…」,没有进度也取消不了)。现在 `ready()` **只读本地**,
   * 下载是一个自己有状态、有进度、可取消的动作。
   */
  download?(options: EmbedderDownloadOptions): Promise<void>
  /**
   * **试装一次**:`modelDir` 里那堆文件能不能装起来(2026-09-17 认领,§15.8)。
   * 装得上就正常返回,装不上就抛原话。**不出网、不写盘、不留会话。**
   *
   * 它存在的理由是一次真实的事故:上一版「翻开关即下载」把模型完整下到了盘上,
   * 这一版把判据换成「下载落定才写的清单」—— 于是那份**下全了的**模型因为没有清单
   * 被当成没下过。清单缺席时,「文件在不在」证明不了完整(`FileCache` 直写最终路径),
   * 而**装得上**是唯一一个不联网就说得出口的证明。
   *
   * 缺席 = 这条嵌入器没法自证(假嵌入器),那就没有认领这回事。
   */
  verify?(options: EmbedderVerifyOptions): Promise<void>
}

/**
 * 模型在磁盘上的样子 —— **由嵌入器自述**,注册表与索引都不认识任何模型。
 *
 * 这里**故意没有「必需文件清单」那一格**:文件清单与缓存布局是
 * `@huggingface/transformers` 自己的事(它决定去要哪几个文件、按什么目录摆),
 * 在这里抄一份就是第二份真相 —— 换一个 dtype、换一版库就会漂开,而漂开的后果是
 * 「下完了却永远说没下」。齐不齐由**下载真的落下了什么**说(`model-store.ts` 的
 * 清单文件),不由这里的一张表说。
 */
export interface EmbedderModelSpec {
  /**
   * 大约多少字节。**屏幕上「约 113 MB」那一句,不是判据** —— 判据永远是磁盘上
   * 那份清单。它只在「还没下」那一态露脸,因为那一态下真数还不知道。
   */
  approxBytes: number
}

/** 下载过程中一个文件的读数(`loaded` 单调增;`total` 不知道就缺席)。 */
export interface EmbedderFileProgress {
  /** 文件名(哪一个文件在下)—— 只用来把逐文件的读数聚合成一个总数。 */
  file: string
  loaded: number
  total?: number
}

export interface EmbedderDownloadOptions {
  /** 落哪儿:`<store>/models/embeddings/<modelId>/`。 */
  modelDir: string
  /** 取消。中止之后这只 promise 该以一个 abort 错误拒绝。 */
  signal?: AbortSignal
  /** 逐文件的读数。喊几次由实现决定;不喊也合法(那时屏上只有「正在下载」)。 */
  onFile?(progress: EmbedderFileProgress): void
}

export interface EmbedderVerifyOptions {
  /** 要试装的那个目录:`<store>/models/embeddings/<id>/`。 */
  modelDir: string
}

export interface EmbedderCreateOptions {
  /** 模型文件落哪儿:`<store>/models/embeddings/<id>/`(§15.3)。 */
  modelDir: string
  /** 下载 / 装载的进度回声。实现自己决定喊几次;不喊也合法。 */
  onProgress?(progress: EmbedderProgress): void
}

export interface EmbedderProgress {
  /** 0–1;不知道就缺席。 */
  ratio?: number
  message?: string
}

const factories = new Map<string, EmbedderFactory>()

export function registerEmbedder(factory: EmbedderFactory): () => void {
  if (factories.has(factory.id)) {
    throw new Error(`embedder "${factory.id}" is already registered`)
  }
  factories.set(factory.id, factory)
  return () => {
    if (factories.get(factory.id) === factory) factories.delete(factory.id)
  }
}

/** 没注册就是 `undefined` —— 调用方据此把开关关回去并 `warn`,不抛(§15.3)。 */
export function resolveEmbedder(id: string): EmbedderFactory | undefined {
  return factories.get(id)
}

export function listEmbedders(): string[] {
  return [...factories.keys()].sort()
}

/** 单测用:清干净。生产没有调用方。 */
export function resetEmbedderRegistry(): void {
  factories.clear()
}
