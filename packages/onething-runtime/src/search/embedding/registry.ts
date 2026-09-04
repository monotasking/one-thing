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
