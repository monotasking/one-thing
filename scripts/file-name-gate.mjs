#!/usr/bin/env node
// 文件名门(命名规范 N1 / N3 / N4,决策 D22;docs/design/backend-structure-decisions-2026-10.md「命名规范」)。
//
// 为什么:用户 10-04 指出「同名文件太多,搜索出来的内容太多」——立门那天 `packages/backend` 里 98 个 `index.ts`、
// 36 个 `types.ts`、20 个 `ipc-operations.ts`,按文件名搜索或在编辑器里模糊跳转,出来的是一屏同名文件。
// 立门时它是只减不增的棘轮(基线 `docs/audit/file-name-baseline-2026-10.txt`);2026-10-04 机械改名 6b 把重复名清到 0,
// **基线文件随之删掉,门改成零基线硬闸**:没有「已知的重复名」可以容忍,所以不需要基线,任何一处命中都直接红。
//
// 判据:扫描 `packages/backend` 下的非测试 `.ts` 文件(测试 = `__tests__/` 下的文件或文件名带 `.test.`;
// `.d.ts` 也算一个文件名;跳过 node_modules),三条一起判,任何一条有命中就红:
//   1. N1 文件名全包唯一:同一个文件名(不含目录)出现两次以上;
//   2. N3 入口叫 `<功能>.ts`:任何 `index.ts`(功能子目录里的也算 —— 子目录按 `<功能>-<子目录>.ts` 起名);
//   3. N4 泛名不单用:文件名去掉扩展名以后恰好是 index / types / utils / helpers / service / manager / runtime /
//      registry / store / core / common / misc 之一(它们只许跟在功能名后面,例如 `session-types.ts`)。
// 新文件请按 N2 起名:`<功能>-<做什么>.ts`。
//
// 用法:
//   node scripts/file-name-gate.mjs          判(package.json: name:gate)
//   node scripts/file-name-gate.mjs --list   打全表:三条各列出命中的路径(package.json: name:check)
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BACKEND, byCodeUnit, repoRoot } from './lib/backend-structure.mjs'

/** 扫描规模下限:遍历坏了同样长得像「重名全清了」。 */
const MIN_SCANNED_FILES = 1000

const isTestFile = (relative) => /(^|\/)__tests__\//.test(relative) || /\.test\./.test(path.basename(relative))

/** 列出 `packages/backend` 下的非测试 `.ts` 文件(仓库相对路径)。 */
export function listBackendSourceFiles(root = repoRoot) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      const absolute = path.join(dir, entry)
      if (statSync(absolute).isDirectory()) walk(absolute)
      else if (entry.endsWith('.ts')) {
        const relative = path.relative(root, absolute).split(path.sep).join('/')
        if (!isTestFile(relative)) out.push(relative)
      }
    }
  }
  walk(path.join(root, BACKEND))
  return out.sort()
}

/** 文件名 → 出现在哪些路径;只留出现两次以上的。 */
export function duplicateNames(files) {
  const byName = new Map()
  for (const file of files) {
    const name = path.basename(file)
    if (!byName.has(name)) byName.set(name, [])
    byName.get(name).push(file)
  }
  return new Map([...byName].filter(([, paths]) => paths.length > 1))
}

/** N4 的泛名:不许单独作文件名。 */
export const GENERIC_STEMS = new Set(['index', 'types', 'utils', 'helpers', 'service', 'manager', 'runtime', 'registry', 'store', 'core', 'common', 'misc'])
const stemOf = (name) => name.replace(/\.d\.ts$|\.ts$/, '')

/** 三条判据的命中:`{ duplicates: Map<名字, 路径[]>, indexFiles: 路径[], genericFiles: 路径[] }`。 */
export function nameViolations(files) {
  return {
    duplicates: duplicateNames(files),
    indexFiles: files.filter((file) => path.basename(file) === 'index.ts'),
    genericFiles: files.filter((file) => GENERIC_STEMS.has(stemOf(path.basename(file)))),
  }
}

function main() {
  const args = process.argv.slice(2)
  const files = listBackendSourceFiles()
  if (files.length < MIN_SCANNED_FILES) {
    console.error(`[name-gate] 只扫到 ${files.length} 个文件(下限 ${MIN_SCANNED_FILES})—— 遍历坏了,不认这次结果。`)
    process.exit(1)
  }
  const { duplicates, indexFiles, genericFiles } = nameViolations(files)
  const dupFiles = [...duplicates.values()].reduce((sum, paths) => sum + paths.length, 0)
  const summary = `${duplicates.size} 个重复名(${dupFiles} 只文件)、${indexFiles.length} 只 index.ts、${genericFiles.length} 只泛名文件,扫描 ${files.length} 只非测试文件`

  if (args.includes('--list')) {
    console.log(`[name] ${summary}:`)
    const names = [...duplicates.keys()].sort((a, b) => duplicates.get(b).length - duplicates.get(a).length || byCodeUnit(a, b))
    for (const name of names) {
      console.log(`  ${duplicates.get(name).length}\t${name}`)
      for (const file of duplicates.get(name)) console.log(`      ${file}`)
    }
    for (const file of indexFiles) console.log(`  index.ts\t${file}`)
    for (const file of genericFiles) console.log(`  泛名\t${file}`)
    return
  }

  if (duplicates.size > 0 || indexFiles.length > 0 || genericFiles.length > 0) {
    console.error(`[name-gate] failed: ${summary} —— 这道门是零基线硬闸,任何一处都红:`)
    for (const [name, paths] of duplicates) {
      console.error(`  重复名 ${name}:`)
      for (const file of paths) console.error(`      ${file}`)
    }
    for (const file of indexFiles) console.error(`  index.ts:${file}(入口叫 <功能>.ts,子目录按 <功能>-<子目录>.ts)`)
    for (const file of genericFiles) console.error(`  泛名:${file}`)
    console.error('  规矩见命名规范 N1 / N2 / N3 / N4:文件名全包唯一,按 `<功能>-<做什么>.ts` 起名;index / types / store 这类泛名不单用。')
    process.exit(1)
  }
  console.log(`[name-gate] ok — 0 duplicate file names, 0 index.ts, 0 generic names; ${files.length} file(s) scanned`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
