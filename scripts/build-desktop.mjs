#!/usr/bin/env node
/**
 * `npm run build` —— 桌面产物的唯一入口(运行时统一第三步,2026-09-03:换主到 React 壳)。
 *
 * 两段,按序,任一段失败整条红:
 *   ① CLI `dist/cli/main.cjs`(`scripts/build-cli.mjs`)
 *   ② React 壳 `apps/desktop-react`:`vite build` → `dist/` + esbuild → `dist-electron/{main,preload}.cjs`
 *
 * 用 child_process 逐段跑而不是 package.json 里 `a && cd b && c` 串起来:跨目录的 shell 串
 * 在 Windows 与 bun/npm 两种执行器下语义不一,而失败该停在哪一段要看得见。
 *
 * electron-builder 吃的就是 ③ 的两个目录 + 根 package.json(`main` 指 `dist-electron/main.cjs`),
 * 见 electron-builder.yml。Vue 宿主的旧链(`electron-vite build` → `out/`)降为 `vue:build`,
 * 第四步整批删。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(label, command, args, cwd = repoRoot) {
  process.stdout.write(`[build] ${label}\n`)
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env })
  if (result.status !== 0) {
    process.stderr.write(`[build] ${label} 失败(退出码 ${result.status ?? result.signal})\n`)
    process.exit(result.status ?? 1)
  }
}

run('① CLI → dist/cli/main.cjs', process.execPath, [path.join(repoRoot, 'scripts/build-cli.mjs')])
run('② React 壳 → apps/desktop-react/{dist,dist-electron}', npm, ['run', 'app:build'], path.join(repoRoot, 'apps/desktop-react'))
process.stdout.write('[build] 完成\n')
