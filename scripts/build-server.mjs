#!/usr/bin/env node
/**
 * `npm run server:build` —— 不带界面的后端进程的三段产物。
 *
 *   ① `dist/server/main.js`   vite SSR 单文件包(配置就是下面的 `serverViteConfig()`,入口
 *      `packages/backend/backend-standalone-main.ts`)
 *   ② `dist/server/search-worker.cjs`  检索索引 Worker(检索重建 S3b,§3 末行)
 *   ③ `dist/server/acp-mcp-bridge.cjs` ACP 宿主工具面的 stdio 桥(ACP A4-a,与 ② 同一条规矩)
 *
 * ## 为什么 vite 配置写在这里而不是一只 `vite.config.ts`
 *
 * 2026-10-05(D255 起)`apps/backend-server` 并进 `packages/backend` 之后,进程入口住在后端包根;
 * 一只 `vite.config.ts` 放进 `packages/backend` 会违反命名规矩 N2(包根散文件必须以 `backend-` 打头),
 * 而它本来就只服务这一个构建脚本。所以配置用 vite 的 JS API 内联在这里(`configFile: false`),
 * 逐项照搬原来那份文件,原注释一并带过来。`scripts/build-workspace-watch.test.mjs` 也读同一个函数。
 *
 * ## 为什么 ② 是**第二次构建**而不是 vite 的第二个入口
 *
 * ① 钉着 `inlineDynamicImports: true`,而 rollup 明文
 * 不允许「多入口 + inline」(`Invalid value for option
 * output.inlineDynamicImports - multiple inputs are not supported`)。那条 inline
 * 不是可有可无的:server 的模块图里有顶层 await,拆出去的动态 chunk 会回过头 import
 * `main.js`,那个环会把模块求值卡死(见下面 `rollupOptions` 里的原注释)。
 *
 * 所以 Worker 走**另一条链**:与 React 主进程 / CLI 同一份 `shellEsbuildOptions`
 * (node 平台、CJS、原生模块 external、`import.meta.url` 垫片)。这样三份
 * `search-worker.cjs` 是同一个配方出的同一种东西,而不是「server 那份特殊」。
 *
 * 这个脚本存在的另一个理由:`server:build` 从前是 package.json 里的一行
 * `vite build --config …`,加第二段就得写成 `a && b` 的 shell 串 —— 跨执行器
 * (npm / bun / Windows)语义不一,而失败该停在哪一段要看得见(与
 * `scripts/build-desktop.mjs` 同一条判例)。
 *
 * import 这个文件不做事(测试要拿 `serverViteConfig`);只有被当作脚本直接跑时才构建。
 */
import { build as esbuild } from 'esbuild'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { acpMcpBridgeEsbuildOptions, searchWorkerEsbuildOptions } from '../apps/desktop-react/scripts/build-electron.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 不带界面的后端进程入口(进程入口,不许被 import;`entry:gate` 按名字认它)。 */
export const SERVER_ENTRY = path.join(repoRoot, 'packages/backend/backend-standalone-main.ts')

/**
 * ① 的 vite 配置(从前的 `apps/backend-server/vite.config.ts`,逐项照搬)。
 *
 * @param {{ outDir?: string }} [options] `outDir` 缺省 `dist/server`;dev-unified 的 dev-self 泳道经 `--outDir` 改它。
 * @returns {import('vite').InlineConfig}
 */
export function serverViteConfig({ outDir = path.join(repoRoot, 'dist/server') } = {}) {
  return {
    configFile: false,
    root: repoRoot,
    cacheDir: path.join(repoRoot, 'node_modules/.vite/server'),
    resolve: {
      // core / gateway / runtime / backend 都是真 workspace 包,vite 走 node 解析 +
      // 各自 package.json 的 exports —— 这里一条 @onething/* alias 都不需要。
      alias: [
        { find: '@shared', replacement: path.join(repoRoot, 'packages/shared') },
      ],
    },
    // macOS-only optional native addon. Preserve the real package (and its
    // relative .node file) instead of bundling a detached JavaScript wrapper.
    ssr: { external: ['fsevents'] },
    build: {
      ssr: SERVER_ENTRY,
      target: 'node20',
      outDir,
      emptyOutDir: true,
      rollupOptions: {
        // Keep the guarded import external even when Linux or Windows omit this
        // optional darwin addon; Rollup must not resolve it during the build.
        external: ['fsevents'],
        output: {
          entryFileNames: 'main.js',
          // Single-file bundle: split dynamic-import chunks re-import main.js,
          // and with a top-level await in flight that cycle deadlocks module
          // evaluation (the electron main build already bundles single-file).
          inlineDynamicImports: true,
        },
      },
    },
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (!(args.length === 0 || (args.length === 2 && args[0] === '--outDir' && args[1] && !args[1].includes('\0')))) {
    throw new Error('Usage: node scripts/build-server.mjs [--outDir <directory>]')
  }
  // dev-unified 的 dev-self 泳道传入 --outDir;两个产物必须跟同一实际宿主目录。
  const outdir = path.resolve(repoRoot, args[1] ?? 'dist/server')

  process.stdout.write(`[server:build] ① vite SSR → ${path.join(outdir, 'main.js')}\n`)
  try {
    const { build: viteBuild } = await import('vite')
    await viteBuild(serverViteConfig({ outDir: outdir }))
  } catch (error) {
    process.stderr.write(`[server:build] ① 失败(${error instanceof Error ? error.message : String(error)})\n`)
    process.exit(1)
  }

  process.stdout.write(`[server:build] ② esbuild → ${path.join(outdir, 'search-worker.cjs')}\n`)
  await esbuild(searchWorkerEsbuildOptions({ outdir, repoRoot }))
  process.stdout.write(`[server:build] ③ esbuild → ${path.join(outdir, 'acp-mcp-bridge.cjs')}\n`)
  await esbuild(acpMcpBridgeEsbuildOptions({ outdir, repoRoot }))
  process.stdout.write('[server:build] 完成\n')
}

/** 被当作脚本直接跑的才构建。比真实路径:ESM 加载器给的 `import.meta.url` 已经解开符号链接,`argv[1]` 是原样的(macOS 的临时目录就是一条链接)。 */
function invokedAsScript() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1]))
  } catch {
    return false
  }
}

if (invokedAsScript()) {
  await main()
}
