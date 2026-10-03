#!/usr/bin/env node
// 文件名重复棘轮(命名规范 N1,决策 D22,docs/design/backend-structure-decisions-2026-10.md「命名规范」)。
//
// 为什么:用户 10-04 指出「同名文件太多,搜索出来的内容太多」——今天 `packages/backend` 里 98 个 `index.ts`、
// 36 个 `types.ts`、20 个 `ipc-operations.ts`,按文件名搜索或在编辑器里模糊跳转,出来的是一屏同名文件。N1 的目标是
// 「文件名全包唯一,按文件名搜索只出一个结果」;存量一次改不完,所以先立只减不增的门,机械改名那一批(路线第 6 项)再清零。
//
// 判据:扫描 `packages/backend` 下的非测试 `.ts` 文件(测试 = `__tests__/` 下的文件或文件名带 `.test.`;
// `.d.ts` 也算一个文件名;跳过 node_modules),按文件名(不含目录)计数,出现两次以上的就是一个重复名。
// 基线 `docs/audit/file-name-baseline-2026-10.txt` 每行「次数 文件名」;**每个名字只许减**:
// 某个名字的次数高于基线、或基线里没有的名字出现了第二次 → 红;低于基线 → 提示可收紧。
// 所以新建一只 `index.ts` / `types.ts` 也会红 —— 新文件请按 N2 起名:`<功能>-<做什么>.ts`。
//
// 用法:
//   node scripts/file-name-gate.mjs                  棘轮比对(package.json: name:gate)
//   node scripts/file-name-gate.mjs --list           打全表,每个重复名列出所在路径(package.json: name:check)
//   node scripts/file-name-gate.mjs --write-baseline 收紧基线(只在真降之后)
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BACKEND, byCodeUnit, compareCounts, formatCountBaseline, parseCountBaseline, repoRoot } from './lib/backend-structure.mjs'

const baselinePath = path.join(repoRoot, 'docs/audit/file-name-baseline-2026-10.txt')
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

function main() {
  const args = process.argv.slice(2)
  const files = listBackendSourceFiles()
  if (files.length < MIN_SCANNED_FILES) {
    console.error(`[name-gate] 只扫到 ${files.length} 个文件(下限 ${MIN_SCANNED_FILES})—— 遍历坏了,不认这次结果。`)
    process.exit(1)
  }
  const duplicates = duplicateNames(files)
  const counts = Object.fromEntries([...duplicates].map(([name, paths]) => [name, paths.length]))
  const extra = Object.values(counts).reduce((sum, n) => sum + n, 0)

  if (args.includes('--list')) {
    console.log(`[name] ${duplicates.size} 个文件名重复(共 ${extra} 只文件),扫描 ${files.length} 只非测试文件:`)
    const names = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || byCodeUnit(a, b))
    for (const name of names) {
      console.log(`  ${counts[name]}\t${name}`)
      for (const file of duplicates.get(name)) console.log(`      ${file}`)
    }
    return
  }

  if (args.includes('--write-baseline')) {
    writeFileSync(baselinePath, formatCountBaseline([
      'file-name ratchet baseline(命名规范 N1,docs/design/backend-structure-decisions-2026-10.md)',
      '每行 `<次数> <文件名>`:packages/backend 下非测试 .ts 文件里,这个文件名出现的次数(只列出现两次以上的)。',
      '只许降:任一名字高于这里的数、或出现这里没有的重复名,`bun run name:gate` 红。',
      '降了之后跑 `node scripts/file-name-gate.mjs --write-baseline` 收紧。',
    ], counts), 'utf8')
    console.log(`[name-gate] baseline written → ${path.relative(repoRoot, baselinePath)} (${duplicates.size} duplicate name(s))`)
    return
  }

  if (!existsSync(baselinePath)) {
    console.error(`[name-gate] 基线文件缺失:${path.relative(repoRoot, baselinePath)}`)
    process.exit(1)
  }
  const baseline = parseCountBaseline(readFileSync(baselinePath, 'utf8'))
  if (Object.keys(baseline).length === 0) {
    console.error('[name-gate] 基线解析为空 —— 格式坏了,不认这次结果')
    process.exit(1)
  }
  const { regressions, improvements } = compareCounts(baseline, counts)
  if (improvements.length > 0) {
    console.log(`[name-gate] ${improvements.length} 个重复名变少了 —— 可以收紧基线(--write-baseline):`)
    for (const item of improvements) console.log(`  - ${item.key}: ${item.baseline} → ${item.current}`)
  }
  if (regressions.length > 0) {
    console.error(`[name-gate] failed: ${regressions.length} 个文件名的重复次数上升 —— 新文件又起了一个已经有人用的名字:`)
    for (const item of regressions) {
      console.error(`  + ${item.key}: ${item.baseline} → ${item.current}${item.isNew ? '(新出现的重复名)' : ''}`)
      const paths = duplicates.get(item.key)
      for (const file of paths.slice(0, 10)) console.error(`      ${file}`)
      if (paths.length > 10) console.error(`      …还有 ${paths.length - 10} 只(\`bun run name:check\` 打全)`)
    }
    console.error('  规矩见命名规范 N1 / N2 / N4:文件名全包唯一,按 `<功能>-<做什么>.ts` 起名;index / types / store 这类泛名不单用。')
    process.exit(1)
  }
  console.log(`[name-gate] ok — ${duplicates.size} known duplicate file name(s) across ${extra} file(s), ${files.length} file(s) scanned, none new`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
