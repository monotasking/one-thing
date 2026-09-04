/**
 * 真嵌入器:`@huggingface/transformers` 的 **wasm 后端**,模型
 * `multilingual-e5-small`(int8,384 维;拍点癸 a)。
 *
 * 设计:docs/design/search-index-2026-09.md §15.2 / §15.3
 *
 * ## 为什么是 wasm 而不是 onnxruntime-node
 *
 * 拍点癸 a:**零原生依赖就零法条问题**(仓顶那条「原生模块只许 N-API」)。代价是
 * 慢约两倍,以及首次装载不便宜(**本机实测 `import('@huggingface/transformers')`
 * 本身 179ms**;`pipeline()` 建管线要在这之上,本机没量到 —— 见下)。所以这个模块是
 * **动态 import** 的:开关不打开就一行代码都不加载,不进任何宿主 bundle 的关键路径。
 * 换成 onnxruntime-node(癸 b)是「多一个模块 + 一行注册」,注册表不改。
 *
 * **一件必须交代的事**:装 `@huggingface/transformers` 顺带把 `onnxruntime-node` 与
 * `sharp` 两个**原生**包拖进了 node_modules(它们是它的直接依赖)。产品从不加载
 * 它们 —— 这里写死 `device: 'wasm'` —— 但它们真的被 electron-builder 打进 app,
 * 而法条判的是「真的装了 / 真的产出」,所以两块二进制都进了 `gate:native` 的表
 * (实测都是 N-API,绿)。体积与打包那一半的账在 §13 留账里,**有一条待拍**。
 *
 * ## 模型文件落哪儿
 *
 * `<store>/models/embeddings/<modelId>/` —— 与 sherpa 的 `resources/models/` 是**两
 * 回事**:那一份是随包发的,这一份是用户开开关之后下载的用户数据。落在 store 里,
 * 与 `index/` 同级,看门人(`log/` 的 janitor)不管它。
 *
 * ## e5 的前缀由嵌入器自己贴
 *
 * e5 系列要求查询前面写 `query: `、正文前面写 `passage: `,漏了会掉召回。**这条
 * 知识住在这个文件里**,不许漏给调用方(`Embedder.embed` 的 `kind` 参数就是为它
 * 留的那一格)。
 *
 * ## 失败 = 把开关关回去
 *
 * 下载不通 / 模型损坏 / wasm 编不出来 —— `ready()` 抛,`VectorWriter` 接住并把
 * `status.vector` 钉成 `'off'`,**不重试到死**(§15.3)。词法路一个字不受影响。
 */

import type { EmbedKind, Embedder } from '@onething/core/search'

import { getLogger } from '../../logging/index.js'
import { normalizeVector } from './embedder.js'
import type { EmbedderCreateOptions, EmbedderFactory } from './registry.js'

const log = getLogger('search.embedding')

/** 注册 id = 设置里的 `modelId` 缺省值。 */
export const E5_SMALL_EMBEDDER_ID = 'multilingual-e5-small'

/** HuggingFace 上的仓库名。**是数据,不是判断** —— 换模型换这一行加一个注册。 */
const E5_SMALL_REPO = 'Xenova/multilingual-e5-small'

/** 384 维、512 token —— 与 `vec_docs_384` 和切段判据对上。 */
export const E5_SMALL_DIMS = 384
export const E5_SMALL_MAX_TOKENS = 512

/** e5 的两个前缀。调用方永远不用记它们。 */
const PREFIX: Record<EmbedKind, string> = { query: 'query: ', passage: 'passage: ' }

interface TransformersPipeline {
  (texts: string[], options: { pooling: 'mean'; normalize: boolean }): Promise<{
    tolist(): number[][]
  }>
  tokenizer?: { encode(text: string): unknown[] }
}

interface TransformersModule {
  env: {
    localModelPath?: string
    cacheDir?: string
    allowLocalModels?: boolean
    backends?: { onnx?: { wasm?: { numThreads?: number } } }
  }
  pipeline(
    task: 'feature-extraction',
    model: string,
    options: { dtype?: string; device?: string; progress_callback?: (info: unknown) => void },
  ): Promise<TransformersPipeline>
}

export function createTransformersWasmEmbedder(options: EmbedderCreateOptions): Embedder {
  let pipe: TransformersPipeline | undefined
  let loading: Promise<void> | undefined

  const load = async (): Promise<void> => {
    // **动态 import**:开关不打开就不加载(见文件头)。
    const transformers = await import('@huggingface/transformers') as unknown as TransformersModule
    transformers.env.cacheDir = options.modelDir
    transformers.env.localModelPath = options.modelDir
    /*
     * wasm 单线程:Worker 里再开线程池会跟宿主抢核,而这条路本来就是后台活。
     *
     * **尽力而为,不是保证**:3.8.1 上实测 `Object.keys(env.backends.onnx.wasm)`
     * 只见到 `wasmPaths` / `proxy`,`numThreads` 是 ORT 那一侧的可选项 —— 设了不
     * 报错,那一版不认就当没设。真要钉死线程数得等真机读数(§13 留账)。
     */
    if (transformers.env.backends?.onnx?.wasm !== undefined) {
      transformers.env.backends.onnx.wasm.numThreads = 1
    }
    pipe = await transformers.pipeline('feature-extraction', E5_SMALL_REPO, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: info => {
        const record = info as { progress?: number; status?: string; file?: string }
        options.onProgress?.({
          ...(typeof record.progress === 'number' ? { ratio: record.progress / 100 } : {}),
          ...(record.status !== undefined ? { message: `${record.status} ${record.file ?? ''}`.trim() } : {}),
        })
      },
    })
    log.info('embedding model loaded', { model: E5_SMALL_REPO, dir: options.modelDir })
  }

  return {
    id: E5_SMALL_EMBEDDER_ID,
    dims: E5_SMALL_DIMS,
    maxTokens: E5_SMALL_MAX_TOKENS,
    /**
     * 分词器装好之前只能估:**按字符近似**(中文 ≈ 1 token / 字,latin ≈ 4 字符 /
     * token)。切段判据因此在冷启第一批上略保守 —— 保守的方向是切得更碎,不会超模型
     * 的窗口,所以不修。
     */
    countTokens(text) {
      const encode = pipe?.tokenizer?.encode
      if (encode !== undefined && pipe?.tokenizer !== undefined) {
        try { return encode.call(pipe.tokenizer, text).length } catch { /* 退回估算 */ }
      }
      let tokens = 0
      // CJK 用码点写,不写字面区间 —— 区间的起点 U+3000 是个全角空格,写成字面
      // 就是一处「不规则空白」(eslint 当场红,施工时踩过)。
      for (const ch of text) tokens += /[\u3000-\u9fff\uac00-\ud7af]/.test(ch) ? 1 : 0.3
      return Math.ceil(tokens)
    },
    async ready() {
      if (pipe !== undefined) return
      if (loading === undefined) loading = load()
      await loading
    },
    async embed(texts: readonly string[], kind: EmbedKind) {
      if (pipe === undefined) await this.ready()
      const runner = pipe
      if (runner === undefined) throw new Error('embedding pipeline is not ready')
      const prefixed = texts.map(text => `${PREFIX[kind]}${text}`)
      const output = await runner(prefixed, { pooling: 'mean', normalize: true })
      return output.tolist().map(row => normalizeVector(Float32Array.from(row)))
    },
  }
}

export const transformersWasmEmbedderFactory: EmbedderFactory = {
  id: E5_SMALL_EMBEDDER_ID,
  create: createTransformersWasmEmbedder,
}
