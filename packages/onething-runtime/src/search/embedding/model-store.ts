/**
 * 「这份模型下全了没有」的**唯一判据**:一份下载落定时才写下的清单。
 *
 * 设计:docs/design/search-index-2026-09.md §15.8(2026-09-17 用户裁定「把开关和
 * 下载模型拆开,另外下载模型要能够知道进度」)。
 *
 * ## 为什么不是「看看那几个文件在不在」
 *
 * 派工单原话是「`state:'ready'` 的判据 = 本地文件齐(config / tokenizer / onnx 都在
 * 且 onnx 大小 > 0)」。真去看 `@huggingface/transformers` 3.8.1 怎么写盘之后,这条
 * 判据**挡不住半截文件**,而且要在这里抄一份文件清单:
 *
 *  - `FileCache.put`(`src/utils/hub.js:319`)**直接写最终路径**,没有 `.part` 也没有
 *    先写临时名再改名;`match()` 那一侧只问一句 `file.exists`。
 *  - 它确实在 `catch` 里 `unlink` —— 所以**取消**(fetch 被 abort → `reader.read()`
 *    抛)那一路是干净的,半截文件会被它自己删掉。但进程在写盘中途被杀(退出、断电、
 *    `SIGKILL`)那一路没有人来删,磁盘上就留下一个大小不对的 `model_quantized.onnx`,
 *    而「文件在、大小 > 0」会把它当成下全了 —— 下一次装载在 ONNX 那一层抛,用户看到
 *    的是一句「运行时装不上」,与真因(文件是半截的)差着十万八千里。
 *  - 而「要哪几个文件」是那个库的事(dtype 换一档、库升一版就换一批)。在这里抄一份
 *    清单,漂开的那天会变成「下完了却永远说没下」,那是个死循环。
 *
 * 所以判据反过来:**下载成功之后,把磁盘上真的落下了什么逐个记下来**
 * (`captureModelManifest`),此后 `probeEmbedderModel` 拿清单去核对每个文件的**字节数**。
 * 清单是最后一步写的,于是:
 *
 *  - 取消 / 半途死掉 → 没有清单 → `'absent'`,**半截文件不可能被当成完整的**;
 *  - 下载完了又被人删掉一个文件 / 文件被截断 → 字节数对不上 → `'absent'`;
 *  - 清单里一个文件都没有 → `'absent'`(挡住「往空目录里写一份清单」这种说谎法)。
 *
 * 留在盘上的半截文件**不删**:transformers 自己的缓存会认出已经下全的那几个文件、
 * 跳过它们,所以下一次「下载」等于续传。清单不认它们,所以它们说不了谎。
 *
 * ## 目录
 *
 * `<store>/models/embeddings/<modelId>/` —— 装配层算好递进来(Worker 不解析 store
 * 路径)。里面的布局全是 transformers 的(它同时是 `env.cacheDir` 与
 * `env.localModelPath`),这个文件一格都不解释,只递归地数。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 清单文件名。点头是有意的:它是 onething 写的,不是模型的一部分。 */
export const MODEL_MANIFEST_FILE = '.onething-model.json'

/**
 * 一份下全了的模型。`files` 的键是**相对 `modelDir` 的 posix 路径**,值是字节数。
 *
 * `id` 是嵌入器注册 id:同一个目录换了嵌入器(拍点癸 b)时,旧清单不能替新模型作证。
 */
export interface ModelManifest {
  id: string
  /** 写下这份清单的时刻(ISO)。只给人看 / 给排障看,不参与判据。 */
  at: string
  /** `files` 的和。存下来是为了「已下载 · 113 MB」那一句不必每次去 stat 一遍。 */
  bytes: number
  files: Record<string, number>
}

/** 磁盘上这份模型的两种样子。**没有第三种** —— 「下了一半」在这里就是没下。 */
export type ModelPresence = 'absent' | 'ready'

export interface ModelProbe {
  state: ModelPresence
  /** 下全了 = 实际字节数;没下全 = 0(**不是**估计值:估计值是嵌入器自述的那一格)。 */
  bytes: number
}

/** 相对 `modelDir` 的每个文件 + 字节数(清单文件自己不算进去)。 */
function walkFiles(dir: string, base = dir): Record<string, number> {
  const files: Record<string, number> = {}
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      Object.assign(files, walkFiles(full, base))
      continue
    }
    if (!entry.isFile()) continue
    const relative = path.relative(base, full).split(path.sep).join('/')
    if (relative === MODEL_MANIFEST_FILE) continue
    try {
      files[relative] = fs.statSync(full).size
    } catch {
      // 刚刚还在、这一刻没了:当它不存在,核对那一侧自然会说 `'absent'`。
    }
  }
  return files
}

/**
 * 下载落定之后把现场记下来。**必须是最后一步** —— 它在盘上的存在就是「下全了」这
 * 句话本身。
 */
export function captureModelManifest(modelDir: string, id: string): ModelManifest {
  const files = walkFiles(modelDir)
  const manifest: ModelManifest = {
    id,
    at: new Date().toISOString(),
    bytes: Object.values(files).reduce((sum, size) => sum + size, 0),
    files,
  }
  fs.mkdirSync(modelDir, { recursive: true })
  fs.writeFileSync(path.join(modelDir, MODEL_MANIFEST_FILE), JSON.stringify(manifest, null, 2))
  return manifest
}

/** 读清单。读不到 / 坏了 = 没有清单(不抛:一份坏清单与没有清单是同一件事)。 */
export function readModelManifest(modelDir: string): ModelManifest | undefined {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(modelDir, MODEL_MANIFEST_FILE), 'utf8'),
    ) as Partial<ModelManifest>
    if (typeof parsed?.id !== 'string' || typeof parsed.files !== 'object' || parsed.files === null) {
      return undefined
    }
    const files: Record<string, number> = {}
    for (const [file, size] of Object.entries(parsed.files)) {
      if (typeof size === 'number' && Number.isFinite(size)) files[file] = size
    }
    return {
      id: parsed.id,
      at: typeof parsed.at === 'string' ? parsed.at : '',
      bytes: typeof parsed.bytes === 'number' ? parsed.bytes : Object.values(files)
        .reduce((sum, size) => sum + size, 0),
      files,
    }
  } catch {
    return undefined
  }
}

/**
 * 这份模型齐不齐。判据三条,缺一条就是 `'absent'`(见文件头):清单在且是这个
 * 嵌入器的、清单非空、清单里每个文件此刻的字节数**逐个相等**。
 */
export function probeEmbedderModel(modelDir: string, id: string): ModelProbe {
  const manifest = readModelManifest(modelDir)
  if (manifest === undefined || manifest.id !== id) return { state: 'absent', bytes: 0 }
  const entries = Object.entries(manifest.files)
  if (entries.length === 0) return { state: 'absent', bytes: 0 }
  let bytes = 0
  for (const [file, size] of entries) {
    let actual: number
    try {
      actual = fs.statSync(path.join(modelDir, file)).size
    } catch {
      return { state: 'absent', bytes: 0 }
    }
    if (actual !== size) return { state: 'absent', bytes: 0 }
    bytes += actual
  }
  return { state: 'ready', bytes }
}

/** 齐不齐的布尔版 —— 嵌入器 `ready()` 的第一句问的就是它。 */
export function isEmbedderModelPresent(modelDir: string, id: string): boolean {
  return probeEmbedderModel(modelDir, id).state === 'ready'
}

/**
 * 整个模型目录删掉(设置页那颗「删除」)。**连清单一起** —— 留下清单而删掉文件,
 * 核对那一侧照样答 `'absent'`,但那是靠运气对,不是靠意图对。
 */
export function removeEmbedderModel(modelDir: string): void {
  fs.rmSync(modelDir, { recursive: true, force: true })
}
