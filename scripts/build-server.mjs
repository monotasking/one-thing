#!/usr/bin/env node
/**
 * `npm run server:build` —— headless server 的两段产物。
 *
 *   ① `dist/server/main.js`   vite SSR 单文件包(`apps/server/vite.config.ts`)
 *   ② `dist/server/search-worker.cjs`  检索索引 Worker(检索重建 S3b,§3 末行)
 *
 * ## 为什么 ② 是**第二次构建**而不是 vite 的第二个入口
 *
 * `apps/server/vite.config.ts` 钉着 `inlineDynamicImports: true`,而 rollup 明文
 * 不允许「多入口 + inline」(`Invalid value for option
 * output.inlineDynamicImports - multiple inputs are not supported`)。那条 inline
 * 不是可有可无的:server 的模块图里有顶层 await,拆出去的动态 chunk 会回过头 import
 * `main.js`,那个环会把模块求值卡死(vite.config.ts 里的原注释)。
 *
 * 所以 Worker 走**另一条链**:与 React 主进程 / CLI 同一份 `shellEsbuildOptions`
 * (node 平台、CJS、原生模块 external、`import.meta.url` 垫片)。这样三份
 * `search-worker.cjs` 是同一个配方出的同一种东西,而不是「server 那份特殊」。
 *
 * 这个脚本存在的另一个理由:`server:build` 从前是 package.json 里的一行
 * `vite build --config …`,加第二段就得写成 `a && b` 的 shell 串 —— 跨执行器
 * (npm / bun / Windows)语义不一,而失败该停在哪一段要看得见(与
 * `scripts/build-desktop.mjs` 同一条判例)。
 */
import { build as esbuild } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { searchWorkerEsbuildOptions } from '../apps/desktop-react/scripts/build-electron.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outdir = path.join(repoRoot, 'dist/server')
const vite = path.join(repoRoot, 'node_modules/.bin/vite')

process.stdout.write('[server:build] ① vite SSR → dist/server/main.js\n')
const ssr = spawnSync(process.execPath, [vite, 'build', '--config', 'apps/server/vite.config.ts'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: process.env,
})
if (ssr.status !== 0) {
  process.stderr.write(`[server:build] ① 失败(退出码 ${ssr.status ?? ssr.signal})\n`)
  process.exit(ssr.status ?? 1)
}

process.stdout.write('[server:build] ② esbuild → dist/server/search-worker.cjs\n')
await esbuild(searchWorkerEsbuildOptions({ outdir, repoRoot }))
process.stdout.write('[server:build] 完成\n')
