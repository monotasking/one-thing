/**
 * 索引 Worker 的**宿主侧装配**:产物在哪、怎么起、起不来怎么说。
 *
 * 设计:docs/design/search-index-2026-09.md §3 末行(「每个宿主的构建配方各加一个
 * Worker 入口,产物与宿主入口同目录,`new Worker(new URL('./search-worker.js',
 * import.meta.url))`」)+ §5.3(Worker 是唯一持有 sqlite 句柄的地方)。
 *
 * ## 路径怎么解析:选了「跟着宿主产物走」,不是「宿主各传一次」
 *
 * 两条路都能通:(a) 装配时由宿主传一个 `workerPath` 进来,三个宿主各写一行;
 * (b) 这里自己按 `import.meta.url` 往旁边找。**选 (b)**,理由是开闭:
 *
 *  - (a) 是一处**按宿主枚举**的地方 —— 加第四个宿主要改装配层的签名与三处调用点,
 *    正是「加功能不许改骨架」那条法要消掉的形;(b) 下加一个宿主 = 在**它自己的
 *    构建配方**里加一个入口,装配层一个字不动。
 *  - 「产物与宿主入口同目录」本来就是 §3 定的构建纪律,三份配方(React 主进程
 *    esbuild / CLI esbuild / server 的第二次 esbuild)都照它出 `search-worker.cjs`。
 *    (b) 读的就是这条纪律,而 (a) 是把同一条纪律再抄三遍。
 *
 * 三份产物下 `import.meta.url` 分别是什么:两份 esbuild 产物走
 * `shellEsbuildOptions` 的 `define`(`import.meta.url` → banner 里现算的
 * `pathToFileURL(__filename)`),于是它 = 宿主 bundle 自己;server 那份是 vite SSR
 * 的 ESM 产物,`import.meta.url` 是原生的,同样 = 宿主 bundle 自己。三份都与
 * `search-worker.cjs` 同目录。
 *
 * `ONETHING_SEARCH_WORKER` 是逃生口(门脚本 / 排障用),不是产品配置。
 *
 * **找不到就如实说**:vitest 与 `tsx` 下这里解析到的是**源码**目录,旁边当然没有
 * `.cjs` —— 那时返回 `undefined`,装配层换上一份「索引不可用」的问答面
 * (`mode: 'error'`),三路能力答零结果。不偷偷退回旧扫描(§13 留账)。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import type { IndexWorkerData } from '@onething/runtime/search/index/worker-data'
import type { IndexWorkerFactory, IndexWorkerHandle } from '@onething/runtime/search/index/worker-host'
import { getLogger } from '../logging/index.js'

const log = getLogger('search.index')

/** 三份构建配方共同约定的产物名。 */
export const SEARCH_WORKER_FILENAME = 'search-worker.cjs'

/** 逃生口:门脚本可以直接指一份产物。 */
export const SEARCH_WORKER_PATH_ENV = 'ONETHING_SEARCH_WORKER'

/**
 * 这台宿主的 Worker 产物在哪。找不到 = `undefined`(不抛 —— 抛会把整条装配带走,
 * 而「这台机器上没有搜索索引」是一件该结构化降级的事)。
 */
export function resolveSearchWorkerPath(): string | undefined {
  const candidates: string[] = []
  const override = process.env[SEARCH_WORKER_PATH_ENV]
  if (override !== undefined && override.length > 0) candidates.push(path.resolve(override))
  const here = hostDirectory()
  if (here !== undefined) {
    const inPlace = path.join(here, SEARCH_WORKER_FILENAME)
    // **解包那一份排在前面**(见 `unpackedTwin` 的说明)。
    const unpacked = unpackedTwin(inPlace)
    if (unpacked !== undefined) candidates.push(unpacked)
    candidates.push(inPlace)
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  log.warn('search index worker bundle not found; search will report an unavailable index', {
    fields: { candidates },
  })
  return undefined
}

/**
 * 打包之后的那一份 —— `…/app.asar/…` → `…/app.asar.unpacked/…`(不在 asar 里就
 * `undefined`)。
 *
 * **这是打包链上必须自己处理的一格,不是可选的保险**:主进程 bundle 住在 asar
 * *里*,所以 `import.meta.url` 指的是 asar 里的路径;而 `search-worker.cjs` 被
 * `asarUnpack` 抽到了旁边的 `app.asar.unpacked/` 下(`electron-builder.yml` 那一行)。
 * Electron 给 `fs` 打了 asar 补丁,`existsSync` 对 asar 内的路径**会答 true**,于是
 * 不做这一步就会把一条 asar 内的路径交给 `new Worker()` —— 而 `worker_threads` 起的
 * 是一条新的 Node 环境,不保证带着那层补丁。asarUnpack 的整个意义就是「这个文件要
 * 以真文件的身份被打开」,所以解包那一份**排在前面**。
 *
 * 开发期路径里没有 `app.asar`,这里答 `undefined`,候选表就只剩原地那一份。
 */
function unpackedTwin(filePath: string): string | undefined {
  const marker = `app.asar${path.sep}`
  if (!filePath.includes(marker)) return undefined
  return filePath.replace(marker, `app.asar.unpacked${path.sep}`)
}

/**
 * 宿主 bundle 所在目录。ESM 产物走 `import.meta.url`,CJS 产物走 esbuild 垫上的
 * 同一个值;两者都拿不到时(理论上不该发生)退回 `__dirname`,再拿不到就放弃。
 */
function hostDirectory(): string | undefined {
  try {
    const here = import.meta.url
    if (typeof here === 'string' && here.startsWith('file:')) {
      return path.dirname(fileURLToPath(here))
    }
  } catch {
    // import.meta 在某些 CJS 降级下会被折成 {} —— 落到下面那一支。
  }
  return typeof __dirname === 'string' ? __dirname : undefined
}

/**
 * 真 Worker 工厂。`IndexWorkerHost` 只认这四件事(端点 / 出错 / 退出 / 终止),
 * 所以 `worker_threads` 只出现在这一个函数里 —— 单测传一个 `MessageChannel` 版本
 * 的同形工厂,不必为了测宿主逻辑去起一条真线程。
 */
export function createSearchWorkerFactory(
  workerPath: string,
  workerData: IndexWorkerData,
): IndexWorkerFactory {
  return (): IndexWorkerHandle => {
    const worker = new Worker(workerPath, { workerData })
    // 这条线程不该拦住进程退出:它是派生数据的建造者,不是产品数据的写者。
    worker.unref()
    return {
      endpoint: worker,
      onError: listener => { worker.on('error', listener) },
      onExit: listener => { worker.on('exit', listener) },
      // `Worker.terminate()` 答的是退出码;宿主只关心「停了没有」。
      terminate: async () => { await worker.terminate() },
    }
  }
}
