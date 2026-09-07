import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const projectRoot = resolve(__dirname, '../..')

export default defineConfig({
  root: projectRoot,
  cacheDir: resolve(projectRoot, 'node_modules/.vite/server'),
  resolve: {
    // core / gateway / runtime / backend 都是真 workspace 包,vite 走 node 解析 +
    // 各自 package.json 的 exports —— 这里一条 @onething/* alias 都不需要。
    alias: [
      { find: '@shared', replacement: resolve(projectRoot, 'packages/shared') },
    ],
  },
  // macOS-only optional native addon. Preserve the real package (and its
  // relative .node file) instead of bundling a detached JavaScript wrapper.
  ssr: { external: ['fsevents'] },
  build: {
    ssr: resolve(projectRoot, 'apps/server/src/main.ts'),
    target: 'node20',
    outDir: resolve(projectRoot, 'dist/server'),
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
})
