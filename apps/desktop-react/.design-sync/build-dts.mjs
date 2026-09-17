// design-sync 的「构建」:这仓没有 dist,组件契约只能从 tsc 的声明输出抽。
// 1) tsc -p tsconfig.dts.json --emitDeclarationOnly → build/ts(或 --out 指定的目录);
// 2) 只保留 src/ui/*.d.ts 与 src/components/icons.d.ts(IconButton 的 LucideIcon 型);
//    其余全是 import 拖进来的邻居(workspace / focus / packages/shared…),留着会被
//    转换器当成「.d.ts 树里的 PascalCase 导出 = 组件」枚举出来。
// 用法:node .design-sync/build-dts.mjs [--out build/ts]
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, statSync, renameSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(here, '..')
const outArg = process.argv.indexOf('--out')
const out = resolve(appDir, outArg > 0 ? process.argv[outArg + 1] : 'build/ts')

rmSync(out, { recursive: true, force: true })
const tsc = join(appDir, 'node_modules', '.bin', 'tsc')
const r = spawnSync(tsc, ['-p', join(here, 'tsconfig.dts.json'), '--outDir', out], { stdio: ['ignore', 'pipe', 'pipe'] })
const log = String(r.stdout) + String(r.stderr)
// 类型错误不阻断声明输出(noEmitOnError 缺省 false);只在没产物时才算失败。
const errs = (log.match(/error TS/g) || []).length
function walk(d, acc = []) { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p, acc) : acc.push(p) } return acc }
if (!existsSync(out)) { console.error(log); console.error(`[build-dts] tsc emitted nothing (${errs} errors)`); process.exit(1) }
const all = walk(out)
const keep = (p) => /\/src\/ui\/[^/]+\.d\.ts$/.test(p) || /\/src\/components\/icons\.d\.ts$/.test(p)
// 搬平:把 <out>/<...>/src/ui/X.d.ts 与 icons.d.ts 挪到 <out>/src/ui/X.d.ts、<out>/src/components/icons.d.ts,
// 相对 import('../components/icons')在搬平后仍然成立。
const staging = out + '.staging'
rmSync(staging, { recursive: true, force: true })
let kept = 0
for (const p of all) {
  if (!keep(p)) continue
  const rel = p.slice(p.indexOf('/src/') + 1)
  const dest = join(staging, rel)
  mkdirSync(dirname(dest), { recursive: true })
  renameSync(p, dest); kept++
}
rmSync(out, { recursive: true, force: true })
renameSync(staging, out)
// 3) 内联参数类型的组件(`export declare function X({…}: {…})`,没有 `XProps` 接口)转换器抽不到:
//    它的兜底要走包根 index.d.ts 的导出表,这仓没有。给每个这样的 PascalCase 函数补一行
//    `export type XProps = Parameters<typeof X>[0]`,ts-morph 的检查器会把它解成真形 —— 不手抄、不腐烂。
//    无参函数(`X()`)跳过:Parameters[0] 是 undefined,补了只会得到一个假契约。
let aliased = 0
for (const f of readdirSync(join(out, 'src', 'ui'))) {
  if (!f.endsWith('.d.ts')) continue
  const fp = join(out, 'src', 'ui', f)
  let text = readFileSync(fp, 'utf8')
  const names = [...text.matchAll(/^export declare function ([A-Z][A-Za-z0-9]*)\(\s*\{/gm)].map((m) => m[1])
  const add = names.filter((n) => !new RegExp(`(interface|type) ${n}Props\\b`).test(text))
  if (!add.length) continue
  text += add.map((n) => `export type ${n}Props = Parameters<typeof ${n}>[0];\n`).join('')
  writeFileSync(fp, text); aliased += add.length
}
console.error(`[build-dts] ${aliased} inline-typed component(s) got a Parameters<> props alias`)
console.error(`[build-dts] ${kept} declaration files kept under ${out} (tsc reported ${errs} type errors, non-blocking)`)
