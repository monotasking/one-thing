#!/usr/bin/env node
/**
 * 把 `electron/{main,preload}.ts` 打成 `dist-electron/{main,preload}.cjs`。
 *
 * **选型**:esbuild 直调,不上 electron-vite。这个壳的 main 侧只有三个文件、
 * 不需要 HMR;electron-vite 会顺带把渲染层的构建也接管过去,而渲染层这边已经是
 * 一份好好的纯 vite 配置(它同时还服务 vitest)。两条链各管一半、互不打扰,
 * 是这个自包含小壳最省的一种。
 *
 * 产物是 **CJS**(`.cjs`):preload 只能是 CJS,main 也跟着走同一种格式,
 * `__dirname` 因此直接可用,不必再补 ESM 的 `fileURLToPath` 仪式。
 *
 * ── A1-a(2026-08-31):main 侧从「薄壳」变成「装了 backend 的壳」 ──────────
 * `electron/main.ts` 现在 import `@onething/backend`,于是整棵 core/runtime/backend
 * 被 inline 进这一个 bundle(~10MB)。这条链因此多出四件事,每一件都是**不做就
 * 运行时炸**的那种,不是优化:
 *
 *  ① `?raw` loader —— 产品层有 8 处 `import x from './y.md?raw'`(music/radio-render、
 *     toc/render、goals/render、toolkit/builtin/variable),那是 vite 的语法,
 *     esbuild 不认。这里补一个 12 行插件把它读成字符串。
 *
 *  ② `import.meta.url` 的 CJS 替身 —— `terminal/pty-backend.ts:46` 与
 *     `voice/kws/engine.wiring.ts` 顶层就是 `createRequire(import.meta.url)`。
 *     CJS 产物里 `import.meta` 不存在,esbuild 会把它降成 `{}`,于是
 *     `createRequire(undefined)` 抛 ERR_INVALID_ARG_VALUE —— 而且是**模块求值期**
 *     抛,整只 bundle 一起死。banner 里现算一个 `file://` 的 __filename 顶上。
 *
 *  ③ 原生与延迟加载模块 external —— 打进 bundle 会得到找不到二进制的假副本。
 *     `node-pty` 是真触达的(终端工具);`sherpa-onnx-node`(语音)今天在导入图里
 *     不可达,列在这里是零成本的护栏:哪天有人把它接进来,得到的是「模块没装」的
 *     诚实报错,而不是一次静默的错误绑定。
 *     (2026-09-03:`better-sqlite3` 整体退役,这一行随之删掉 —— 护栏只护还存在的包。)
 *     检索重建 S7 加了两个,各有各的理由:`sqlite-vec` 要在运行时按平台
 *     `require.resolve` 出那份 `vec0.dylib`(打进 bundle 就找不着平台子包了);
 *     `@huggingface/transformers` 是**动态 import** 的(开关不打开就不加载),
 *     inline 进来会把 wasm 后端拖进每一份产物的启动路径,那正是要躲的事。
 *
 *  ④ `@shared` alias —— `@onething/*` 三个包都是真 workspace 包(走各自
 *     package.json 的 exports,node 原生解析得到),不需要 alias;`@shared` 不是
 *     包,只是 `packages/shared` 这棵树,所以要这一行。
 * ──────────────────────────────────────────────────────────────────────
 */
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')

/**
 * ①:`import text from './x.md?raw'` → 一个导出字符串的模块。
 * 只认 `?raw`,别的 query 一律不接(不接 = esbuild 照旧报错,不是静默降级)。
 */
const rawLoaderPlugin = {
  name: 'onething-raw-loader',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, args => ({
      path: path.resolve(args.resolveDir, args.path.slice(0, -'?raw'.length)),
      namespace: 'onething-raw',
    }))
    build.onLoad({ filter: /.*/, namespace: 'onething-raw' }, async args => ({
      contents: await readFile(args.path, 'utf-8'),
      loader: 'text',
    }))
  },
}

/**
 * 这个壳 main 侧的 esbuild 配方。冒烟脚本(scripts/smoke-core-boot.mjs)用**同一份**
 * 打它的探针 —— 冒烟验的必须是真配方,不是一份长得像的抄件。
 *
 * `nodeShims`(默认 true)= 上不上 ② 那个 `import.meta.url` 替身。
 * **preload 必须传 false**:preload 跑在 Electron 的 sandbox 上下文里,那里
 * **没有 `__filename`**。banner 是模块的第一行,于是它成了 preload 的第一句崩溃 ——
 * 症状不是「preload 里某个功能坏了」,而是整只 preload 加载失败、
 * `window.onethingHost` 根本不存在,渲染层拿不到宿主连接。
 * (这条是本批真踩出来的:gate:connect 路径一在「渲染层完成一次 RPC 往返」上超时,
 * 主进程侧一切正常,错全在 preload。)
 */
export function shellEsbuildOptions({ entryPoints, outdir, nodeShims = true }) {
  return {
    entryPoints,
    outdir,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: true,
    // ③ electron 本体由运行时提供;node: 内建同理;原生模块见文件头。
    // macOS workspace watching loads this optional N-API package at runtime;
    // bundling its JS would detach the relative fsevents.node resource.
    external: ['electron', 'node-pty', 'sherpa-onnx-node', 'sqlite-vec', '@huggingface/transformers', 'fsevents'],
    // ② 见文件头。banner 现算一次,define 把每个 import.meta.url 指过去。
    ...(nodeShims
      ? {
        banner: {
          js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;",
        },
        define: { 'import.meta.url': '__importMetaUrl' },
      }
      : {}),
    // ④ `@shared` 不是包,是一棵树。
    alias: { '@shared': path.join(repoRoot, 'packages/shared') },
    plugins: [rawLoaderPlugin],
    logLevel: 'info',
  }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

/**
 * 检索索引 Worker 的入口(检索重建 S3b,`docs/design/search-index-2026-09.md` §3
 * 末行:「每个宿主的构建配方各加一个 Worker 入口,产物与宿主入口同目录」)。
 *
 * 三个宿主(React 主进程 / CLI / server)各出一份 `search-worker.cjs`,**都与自己
 * 的宿主入口同目录** —— 装配层就是靠这条纪律按 `import.meta.url` 往旁边找的
 * (`packages/backend/wiring/search/worker.ts`)。所以这个常量在这里、被三份配方
 * 共用,而不是三处各写一个字符串。
 *
 * 它与 main 同一份 `shellEsbuildOptions`:node 平台、CJS、原生模块 external。
 * `node:sqlite` 是内建模块,esbuild 的 node 平台自动 external,不必列。
 */
export const SEARCH_WORKER_ENTRY = 'packages/onething-runtime/src/search/index/worker.ts'
export const SEARCH_WORKER_NAME = 'search-worker'

export function searchWorkerEsbuildOptions({ outdir, repoRoot: root }) {
  return shellEsbuildOptions({
    entryPoints: { [SEARCH_WORKER_NAME]: path.join(root, SEARCH_WORKER_ENTRY) },
    outdir,
  })
}

if (invokedDirectly) {
  // 三次调用而不是一个 entryPoints 表:main 与 preload 跑在**两种不同的运行时**里
  // (node 上下文 vs Electron sandbox),而 banner/define 是整份配置级的开关,
  // 没法只对其中一个入口生效。见 `nodeShims` 的注释。
  const outdir = path.join(appRoot, 'dist-electron')
  await build(shellEsbuildOptions({
    entryPoints: { main: path.join(appRoot, 'electron/main.ts') },
    outdir,
  }))
  await build(shellEsbuildOptions({
    entryPoints: { preload: path.join(appRoot, 'electron/preload.ts') },
    outdir,
    nodeShims: false,
  }))
  // 第三个入口:检索索引 Worker(见上面那段注释)。
  await build(searchWorkerEsbuildOptions({ outdir, repoRoot }))
}
