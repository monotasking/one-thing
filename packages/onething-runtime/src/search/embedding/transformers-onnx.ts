/**
 * 真嵌入器:`@huggingface/transformers` 的 **onnxruntime-node(cpu)后端**,模型
 * `multilingual-e5-small`(int8,384 维;拍点癸 a 的模型不变)。
 *
 * 设计:docs/design/search-index-2026-09.md §15.2 / §15.3 / §15.7b / §15.7c
 *
 * ## 为什么不是 wasm(这是事实,不是取舍)
 *
 * 这个文件从 S7 到 2026-09-17 一直写着 `device: 'wasm'`,**那一行在这个仓的任何一个
 * 宿主上都没有成立过** —— 它只是从来没被跑到:门跑的是假嵌入器,而真机上模型在这之前
 * 一个字节也下不来(代理那条,§15.7),报错停在下载那一步,轮不到设备这一步。代理修好
 * 之后同一发跑出 `Error: Unsupported device: "wasm". Should be one of: cpu.`
 *
 * 判据在库里,不在猜里:`@huggingface/transformers` 3.8.1 的 **node 产物**
 * (`dist/transformers.node.mjs`,`package.json` 的 `exports.node` 指的就是它)在
 * `IS_NODE_ENV` 下把 ONNX 绑到 `onnxruntime-node`,`supportedDevices` 逐平台 push
 * (**2934–2957 行**:win 加 `dml`、linux x64 加 `cuda`、**darwin 什么都不加**),最后统一
 * push `'cpu'`;`'wasm'` 是 **2971 行**那一支(web 产物)才 push 的。macOS 上这张表就是
 * `['cpu']`,别的字面量一律在 **3001 行**抛。
 *
 * 于是 2026-09-17 走 §15.7b 的第一条路:**`device: 'cpu'`**。理由三条,都可查:
 *  ① 法条过得去 —— `onnxruntime-node` 早就在 `gate:native` 的表里,两个运行时下
 *    都 `require` 得动、`nm -u` 无 V8 私有符号(它是 N-API 插件)。
 *  ② 打包档不受影响 —— `electron-builder.yml` 按拍点癸'(路线 c)把
 *    `@huggingface/transformers` 与两个 onnxruntime 包都排除在外,所以打包桌面档
 *    **照旧** `vector: 'off'` 优雅降级(`gate:packaged` 断言的就是这个)。
 *  ③ dev / server / CLI 三个宿主由此**真能用**,这是这一改唯一的行为变化。
 *
 * 另外两条路留在 §15.7b 里没有作废:装 `onnxruntime-web` 并
 * `globalThis[Symbol.for('onnxruntime')] = ort`(3.8.1 的 **2929 行**认这个口),或者
 * 换一条嵌入器(注册表多一行)。
 *
 * **一件必须交代的事**:装 `@huggingface/transformers` 顺带把 `onnxruntime-node` 与
 * `sharp` 两个**原生**包拖进了 node_modules(它们是它的直接依赖)。开关打开时产品
 * **真的会加载** `onnxruntime-node`(就是这一行 `device: 'cpu'`);`sharp` 仍然从不加载。
 * 两块二进制都在 `gate:native` 的表里 —— 法条判的是「真的装了 / 真的产出」,而不是
 * 「用不用」,所以这一改不改变那张表,只把其中一行从「装了没用」变成「装了在用」。
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
 * 下载不通 / 模型损坏 / `onnxruntime-node` 的 `.node` 装不上(打包档就是这一类:
 * 连 `@huggingface/transformers` 本身都不在)—— `ready()` 抛,`VectorWriter` 接住、把
 * `status.vector` 钉成 `'off'` 并记下**原因码 + 原话**(`describeEmbedderFailure`),
 * **不重试到死**(§15.3)。词法路一个字不受影响。
 */

import type { EmbedKind, Embedder } from '@onething/core/search'

import { getLogger } from '../../logging/index.js'
import { resolveHuggingFaceEndpoint } from '../index/worker-network.js'
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
    /** 从哪儿下(缺省 `https://huggingface.co/`)。`HF_ENDPOINT` 设了就换成镜像站。 */
    remoteHost?: string
  }
  pipeline(
    task: 'feature-extraction',
    model: string,
    options: {
      dtype?: string
      device?: string
      /** 原样递给 `InferenceSession.create`(3.8.1 的 7787 行 `{ ...options.session_options }`)。 */
      session_options?: { intraOpNumThreads?: number }
      progress_callback?: (info: unknown) => void
    },
  ): Promise<TransformersPipeline>
}

export function createTransformersOnnxEmbedder(options: EmbedderCreateOptions): Embedder {
  let pipe: TransformersPipeline | undefined
  let loading: Promise<void> | undefined

  const load = async (): Promise<void> => {
    // **动态 import**:开关不打开就不加载(见文件头)。
    const transformers = await import('@huggingface/transformers') as unknown as TransformersModule
    transformers.env.cacheDir = options.modelDir
    transformers.env.localModelPath = options.modelDir
    /*
     * 镜像站(2026-09-17)。`HF_ENDPOINT` 是 huggingface 生态里既有的那条逃生口,
     * 国内常用;**只读环境变量,不加设置项**(设置极简:它不是必填项)。判据住
     * `search/index/worker-network.ts` —— 与「这台机器怎么上网」的另一半(代理)同一处,
     * 换一条嵌入器时这两件事都不该跟着搬。
     */
    const endpoint = resolveHuggingFaceEndpoint()
    if (endpoint !== undefined) {
      transformers.env.remoteHost = endpoint
      log.info('embedding model downloads use a mirror', { fields: { remoteHost: endpoint } })
    }
    pipe = await transformers.pipeline('feature-extraction', E5_SMALL_REPO, {
      dtype: 'q8',
      // 见文件头:macOS 上 `supportedDevices` 就是 `['cpu']`,别的字面量当场抛。
      device: 'cpu',
      /*
       * **单线程**:Worker 里再开线程池会跟宿主抢核,而这条路本来就是后台活。
       *
       * 换过口径了(2026-09-17):wasm 那一侧的旋钮是 `env.backends.onnx.wasm.numThreads`,
       * 而 onnxruntime-node 的线程数是**每个会话**的 `intraOpNumThreads`,只能经
       * `session_options` 递 —— transformers 3.8.1 的 7787 行把它原样并进
       * `InferenceSession.create` 的参数。不设 = ORT 按物理核数开满。
       */
      session_options: { intraOpNumThreads: 1 },
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

export const transformersOnnxEmbedderFactory: EmbedderFactory = {
  id: E5_SMALL_EMBEDDER_ID,
  create: createTransformersOnnxEmbedder,
}
