/**
 * `gate:embed-runtime` 的探针入口 —— 被 `scripts/gate-embed-runtime.mjs` 用 esbuild
 * 打成一份单文件 cjs,然后在**系统 Node** 与 **`ELECTRON_RUN_AS_NODE=1` 的 Electron**
 * 下各跑一遍。
 *
 * ## 为什么这里一行 pipeline 选项都不写
 *
 * 这道门要守的东西就在 `transformers-onnx.ts` 的 `PIPELINE_OPTIONS` 里
 * (`enableCpuMemArena: false`,2026-09-18 桌面一天崩四次的那一刀)。**在门里抄一份
 * 选项 = 门守的是抄件,产品改坏了门照样绿** —— 所以这里只 import 产品自己的工厂
 * `createTransformersOnnxEmbedder`,一个参数都不替它做主。
 *
 * ## 它跑什么
 *
 * `ready()` 之后连跑 N 批、每批 **32 条变长**中文文本。变长是判据的一半:ORT 的
 * CPU 内存池按 padding 后的形状分配,长度一律相同就永远命中上一次的块、也就永远不
 * 扩容 —— 那样的批次跑一万遍也炸不出问题来。每条 = 一句话重复 1–60 次,重复次数由
 * 一只**定种 LCG** 给,所以两个运行时跑的是**逐字相同**的那一串输入。
 *
 * 读数从 `process.memoryUsage.rss()` 来,每批记一次峰值;最后打一行
 * `__GATE_EMBED_RESULT__` + JSON,由门去判。
 *
 * ## 它不做什么
 *
 * 不写盘、不出网(嵌入器本来就 `allowRemoteModels = false`)、不碰 store 里除模型目录
 * 以外的任何东西 —— 模型目录也只读。
 */

import { createTransformersOnnxEmbedder } from '@onething/runtime/search/embedding/transformers-onnx'

/** 门把这两格从环境里递进来;单跑这份产物时也能用同样两格。 */
const modelDir = process.env.ONETHING_GATE_EMBED_MODEL_DIR ?? ''
const batches = Number.parseInt(process.env.ONETHING_GATE_EMBED_BATCHES ?? '40', 10)

/** 一批多少条 —— 与 `VectorWriter` 真机上那一批同数(§15.2)。 */
const BATCH_SIZE = 32

/** 重复它就得到变长文本。中文,因为真机上炸的就是中文会话。 */
const UNIT = '今天程序崩溃了好几次帮我看下。'

/** 最多重复几次(≈ 60 × 15 字 ≈ 900 字,正好落在 512 token 那一档上下)。 */
const MAX_REPEAT = 60

/**
 * 定种 LCG(numerical recipes 那一组常数)。**不用 `Math.random()`** —— 两个运行时
 * 必须吃到同一串输入,否则「Node 过了 Electron 没过」说不清是运行时的差别还是输入的差别。
 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

function formatMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10
}

async function main(): Promise<void> {
  if (modelDir === '') throw new Error('ONETHING_GATE_EMBED_MODEL_DIR is required')
  if (!Number.isFinite(batches) || batches < 1) throw new Error(`bad batch count: ${String(batches)}`)

  const random = createRandom(20260918)
  const embedder = createTransformersOnnxEmbedder({ modelDir })

  const readyStart = Date.now()
  await embedder.ready()
  const readyMs = Date.now() - readyStart
  let peakRss = process.memoryUsage.rss()
  console.log(`ready in ${readyMs}ms rss ${formatMb(peakRss)} MB`)

  const runStart = Date.now()
  for (let batch = 1; batch <= batches; batch += 1) {
    const texts: string[] = []
    for (let i = 0; i < BATCH_SIZE; i += 1) {
      const repeat = 1 + Math.floor(random() * MAX_REPEAT)
      texts.push(UNIT.repeat(repeat))
    }
    await embedder.embed(texts, 'passage')
    const rss = process.memoryUsage.rss()
    if (rss > peakRss) peakRss = rss
    if (batch % 10 === 0 || batch === batches) {
      console.log(`batch ${batch} rss ${formatMb(rss)} MB`)
    }
  }
  const totalMs = Date.now() - runStart

  const result = {
    batches,
    batchSize: BATCH_SIZE,
    readyMs,
    totalMs,
    msPerBatch: Math.round(totalMs / batches),
    peakRssMb: formatMb(peakRss),
    runtime: {
      node: process.versions.node,
      modules: process.versions.modules,
      electron: process.versions.electron ?? null,
    },
  }
  console.log(`__GATE_EMBED_RESULT__${JSON.stringify(result)}`)
}

main().catch((error: unknown) => {
  console.error(`__GATE_EMBED_ERROR__${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  process.exit(3)
})
