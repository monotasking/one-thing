#!/usr/bin/env node
/**
 * 把 `electron/{main,preload}.ts` 打成 `dist-electron/{main,preload}.cjs`。
 *
 * **选型**:esbuild 直调,不上 electron-vite。这个壳的 main 侧只有两个文件、零
 * 依赖(除 electron 本体)、不需要 HMR;electron-vite 会顺带把渲染层的构建也接管
 * 过去,而渲染层这边已经是一份好好的纯 vite 配置(它同时还服务 vitest)。
 * 两条链各管一半、互不打扰,是这个自包含小壳最省的一种。
 *
 * 产物是 **CJS**(`.cjs`):preload 只能是 CJS,main 也跟着走同一种格式,
 * `__dirname` 因此直接可用,不必再补 ESM 的 `fileURLToPath` 仪式。
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

await build({
  entryPoints: {
    main: path.join(appRoot, 'electron/main.ts'),
    preload: path.join(appRoot, 'electron/preload.ts'),
  },
  outdir: path.join(appRoot, 'dist-electron'),
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  // electron 本体由运行时提供;node: 内建同理。
  external: ['electron'],
  logLevel: 'info',
})
