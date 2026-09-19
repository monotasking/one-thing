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
import { hasEmbedderModelFiles, isEmbedderModelPresent } from './model-store.js'
import type {
  EmbedderCreateOptions,
  EmbedderDownloadOptions,
  EmbedderFactory,
  EmbedderModelSpec,
  EmbedderVerifyOptions,
} from './registry.js'

const log = getLogger('search.embedding')

/** 注册 id = 设置里的 `modelId` 缺省值。 */
export const E5_SMALL_EMBEDDER_ID = 'multilingual-e5-small'

/** HuggingFace 上的仓库名。**是数据,不是判断** —— 换模型换这一行加一个注册。 */
const E5_SMALL_REPO = 'Xenova/multilingual-e5-small'

/** 384 维、512 token —— 与 `vec_docs_384` 和切段判据对上。 */
export const E5_SMALL_DIMS = 384
export const E5_SMALL_MAX_TOKENS = 512

/**
 * 下载**大约**多少字节。真机冷下量到 112.8 MB(`gate:search-index` ⑫ 的读数),
 * 这里写的就是那一次的数。
 *
 * 它只在「还没下」那一态露脸(屏上「未下载 · 约 113 MB」)—— 一下完,屏上写的就是
 * 磁盘上的**真数**(`model-store.ts` 的清单)。所以它偏几个百分点无伤大雅,
 * 而**它永远不是「下全了没有」的判据**。
 */
export const E5_SMALL_APPROX_BYTES = 118_300_000

export const E5_SMALL_MODEL_SPEC: EmbedderModelSpec = { approxBytes: E5_SMALL_APPROX_BYTES }

/**
 * 模型不在本地时 `ready()` 抛的那句话。
 *
 * **要能被 `describeEmbedderFailure` 判成 `'model'`** —— 判据表里那一行认
 * `are not downloaded`(它与 `Could not locate` / `404` 同属「文件那一侧」)。
 * 于是开关开着而模型没下时,设置页写的是「模型文件不完整」而不是「运行时装不上」。
 */
export const MODEL_NOT_DOWNLOADED_ERROR = 'embedding model files are not downloaded'

/** e5 的两个前缀。调用方永远不用记它们。 */
const PREFIX: Record<EmbedKind, string> = { query: 'query: ', passage: 'passage: ' }

interface TransformersPipeline {
  (texts: string[], options: { pooling: 'mean'; normalize: boolean }): Promise<{
    tolist(): number[][]
  }>
  tokenizer?: { encode(text: string): unknown[] }
  /** 把 ONNX 会话还回去。下载那一路装完管线就调它(文件已经落盘,会话是副产物)。 */
  dispose?(): Promise<void>
}

interface TransformersModule {
  env: {
    localModelPath?: string
    cacheDir?: string
    allowLocalModels?: boolean
    /**
     * 允不允许出网拿文件。**两条路在这一格上分道**:装载(`load`)钉死 `false`,
     * 下载(`downloadE5SmallModel`)才 `true`。
     */
    allowRemoteModels?: boolean
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
      session_options?: { intraOpNumThreads?: number; enableCpuMemArena?: boolean }
      progress_callback?: (info: unknown) => void
    },
  ): Promise<TransformersPipeline>
}

/** 两条路共用的那几格 —— dtype / device / 线程数在装载与下载里必须逐字相同。 */
const PIPELINE_OPTIONS = {
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
   *
   * **不用 ORT 的 CPU 内存池**(2026-09-18,桌面一天崩四次的那一刀):那个池每次扩容按
   * 2 的幂翻倍、且从不归还,而每一批的 padding 长度都不同 —— 变长的 32 条一批,几批
   * 之内它就开口要 `posix_memalign(0x80000000)`。系统 Node 的 malloc 照给;Electron 的
   * malloc 是 PartitionAlloc,单次申请到 2GiB 这一档**不返回空指针、直接 SIGTRAP 掐掉
   * 整个进程**(四份 .ips 同栈:`BFCArena::Extend` → `posix_memalign` → `EXC_BREAKPOINT`;
   * 原生 trap,JS 的 crash hook 一行都写不出)。关掉之后张量用完就还,实测 Electron 下
   * 60 批变长全过,常驻 1.2GB → 239MB。`enableMemPattern: false` **不算修**:它只是涨得
   * 慢,没翻到那一档而已。这件事由 `gate:embed-runtime` 在两个运行时下真跑出来,不靠这段话。
   */
  session_options: { intraOpNumThreads: 1, enableCpuMemArena: false },
} as const

/** 那个库的进度回声(`{status, file, loaded, total, progress}`)。 */
interface TransformersProgress {
  status?: string
  file?: string
  loaded?: number
  total?: number
  progress?: number
}

/**
 * 装载 / 下载都要先把 `env` 摆好。**两条路唯一的区别是 `allowRemoteModels`** ——
 * 摆在一处,免得哪天只改了一边。
 */
async function openTransformers(modelDir: string, allowRemote: boolean): Promise<TransformersModule> {
  // **动态 import**:开关不打开、也没人点下载,就不加载(见文件头)。
  const transformers = await import('@huggingface/transformers') as unknown as TransformersModule
  transformers.env.cacheDir = modelDir
  transformers.env.localModelPath = modelDir
  transformers.env.allowLocalModels = true
  transformers.env.allowRemoteModels = allowRemote
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
  return transformers
}

/**
 * **把模型文件下下来**,别的什么都不做(2026-09-17 用户裁定的那一刀)。
 *
 * 用的是那个库**自己的**下载机制:`pipeline(...)` 走一遍,`progress_callback` 把逐
 * 文件的字节数喊出来,文件由它自己的 `FileCache` 落进 `modelDir`。**不在这里抄一份
 * 文件清单** —— 要哪几个文件、摆成什么目录是它的事(理由写在 `model-store.ts` 头上)。
 *
 * 代价是装完管线顺带建了一次 ONNX 会话(几秒、几百 MB 常驻)。所以最后一句
 * `dispose()` 把它还回去:这一路要的只是磁盘上的那些文件。
 *
 * **取消**走 `signal`:Worker 那条线程的全局 `fetch` 被 `WorkerDownloadSignal` 包过一层,
 * 这只 signal 会被它塞进每一发请求(`worker-network.ts`)。中止之后 `FileCache.put` 的
 * `catch` 自己把半截文件删掉,而这只 promise 以 abort 错误拒绝。
 */
export async function downloadE5SmallModel(options: EmbedderDownloadOptions): Promise<void> {
  const transformers = await openTransformers(options.modelDir, true)
  const loading = transformers.pipeline('feature-extraction', E5_SMALL_REPO, {
    ...PIPELINE_OPTIONS,
    progress_callback: info => {
      const record = info as TransformersProgress
      if (record.status !== 'progress' || record.file === undefined) return
      options.onFile?.({
        file: record.file,
        loaded: record.loaded ?? 0,
        ...(typeof record.total === 'number' && record.total > 0 ? { total: record.total } : {}),
      })
    },
  })
  /*
   * **取消要当场答**。signal 一路是经全局 `fetch` 塞进去的(那个库没有 signal 口),
   * 所以在飞的那一发确实会断 —— 但「断」到「`pipeline()` 那只 promise 拒绝」之间隔着
   * 它自己的几层 await。赛一把:abort 赢了就当场拒绝,输的那一边**不许变成
   * unhandledRejection**,而且万一它后来还是装成了,会话要还回去。
   */
  void loading.then(pipe => pipe.dispose?.(), () => undefined).catch(() => undefined)
  const pipe = await Promise.race([loading, whenAborted(options.signal)])
  // 会话还回去。它抛不该让「文件已经下好了」这件事变成一次失败 —— 记一条就走。
  try {
    await pipe.dispose?.()
  } catch (error) {
    log.warn('releasing the download-time inference session failed', undefined, error)
  }
  log.info('embedding model downloaded', { model: E5_SMALL_REPO, dir: options.modelDir })
}

/** 取消那一边。没给 signal = 一只永不落地的 promise(`Promise.race` 里等于不存在)。 */
function whenAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal === undefined) return
    const fail = (): void => {
      const error = new Error('model download cancelled')
      error.name = 'AbortError'
      reject(error)
    }
    if (signal.aborted) { fail(); return }
    signal.addEventListener('abort', fail, { once: true })
  })
}

/**
 * **本地装一次**,一个字节的网络都不发。装载与「认领」(`verifyE5SmallModel`)共用
 * 这一条,所以两边的 `allowRemoteModels = false` 与 `PIPELINE_OPTIONS` 必然逐字相同。
 *
 * 门槛只有一句:**目录里连东西都没有就当场抛**(`MODEL_NOT_DOWNLOADED_ERROR`,判据表
 * 里的 `'model'` 一类)—— 那是「从没下过」,连 `import()` 都不必走,`gate:search-index`
 * ⑬a 的「假站计数 0」守的就是这一刀。
 *
 * **清单不在、文件在**那一形**不拦**(2026-09-17 认领,§15.8):判据由「清单在不在」
 * 松成「装不装得上」—— 装得上就说明这些文件是完整的,而清单该不该补是
 * `ModelDownloader` 的账(它是清单的**唯一**写者)。真出网这条路照旧被
 * `allowRemoteModels = false` 堵死,松的只是「先问一句清单」。
 */
async function loadLocalPipeline(
  modelDir: string,
  onProgress?: EmbedderCreateOptions['onProgress'],
): Promise<TransformersPipeline> {
  if (!isEmbedderModelPresent(modelDir, E5_SMALL_EMBEDDER_ID) && !hasEmbedderModelFiles(modelDir)) {
    throw new Error(MODEL_NOT_DOWNLOADED_ERROR)
  }
  const transformers = await openTransformers(modelDir, false)
  return await transformers.pipeline('feature-extraction', E5_SMALL_REPO, {
    ...PIPELINE_OPTIONS,
    progress_callback: info => {
      const record = info as TransformersProgress
      onProgress?.({
        ...(typeof record.progress === 'number' ? { ratio: record.progress / 100 } : {}),
        ...(record.status !== undefined ? { message: `${record.status} ${record.file ?? ''}`.trim() } : {}),
      })
    },
  })
}

/**
 * **试装一次,别的什么都不做**(2026-09-17 认领,§15.8)。
 *
 * 装得上就正常返回 —— 那是「不联网就能证明这堆文件是完整的」**唯一**的办法
 * (`FileCache` 直写最终路径,所以「文件在、大小 > 0」证明不了任何事)。装不上就抛,
 * 原话原样交给调用方。
 *
 * 会话当场还回去:这一路要的只是**那句判断**,不是一份能跑推理的管线。这条路只在
 * 「这条 Worker 没装嵌入器」(开关关着)时走 —— 开关开着时认领直接用嵌入器自己那一次
 * 装载,不装第二遍 118 MB(接线在 `search/index/worker.ts`)。
 */
export async function verifyE5SmallModel(options: EmbedderVerifyOptions): Promise<void> {
  const pipe = await loadLocalPipeline(options.modelDir)
  try {
    await pipe.dispose?.()
  } catch (error) {
    log.warn('releasing the verification-time inference session failed', undefined, error)
  }
}

export function createTransformersOnnxEmbedder(options: EmbedderCreateOptions): Embedder {
  let pipe: TransformersPipeline | undefined
  let loading: Promise<void> | undefined

  const load = async (): Promise<void> => {
    /*
     * **装载只读本地**(2026-09-17 用户裁定「把开关和下载模型拆开」)。
     *
     * 在这之前,翻一下开关就等于开始下 112.8 MB —— 一个设置开关**不该是**一次
     * 一百多兆的网络动作。现在模型是一件自己有状态的东西(下载 / 取消 / 删除在
     * 设置页的「模型」那一行),而这里只回答「它在不在」。
     *
     * 判据与门槛都在 `loadLocalPipeline` 里(装载与认领共用那一条)。
     */
    pipe = await loadLocalPipeline(options.modelDir, options.onProgress)
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
  // 这一条有一份要先下载的模型,所以它自述这三格;假嵌入器三格都缺席。
  model: E5_SMALL_MODEL_SPEC,
  download: downloadE5SmallModel,
  verify: verifyE5SmallModel,
}
