#!/usr/bin/env node
// 功能地图生成器(可读性判据 R4,docs/design/backend-structure-decisions-2026-10.md)。
//
// 为什么:R4 要求「方向一眼看得出」—— 有一张**生成出来**的功能地图:每个功能做什么、依赖谁、按层次排好,
// 放在仓库里,并由门保证它与代码一致。手写的架构图会和代码分家(本仓库里这种图活不过两个月),所以这张只许生成。
//
// 内容:按层次表 `docs/audit/feature-layers-2026-10.json` 的层次分组(从高到低),每个功能一行:
//   - 做什么:层次表里那一行的 `why`;
//   - 依赖的功能:运行期值引用图上(口径见 `scripts/lib/backend-structure.mjs` 文件头,只引类型不算)它引用的别的功能,
//     带边数;低层引高层的标「越层」(即 `layer:gate` 的违例);
//   - 入口交出多少个名字:入口 `runtime/<功能>/index.ts` 的模块导出表(含再导出),分值与类型;没有入口的写「无入口」。
// 包根与 shared 的槽位行一并列出。
//
// 用法:
//   node scripts/feature-map.mjs           重新生成 docs/architecture/feature-map.md(package.json: feature-map)
//   node scripts/feature-map.mjs --check   判仓库里的文件与生成结果一致,不一致 = 红(package.json: feature-map:check)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LAYER_TABLE, RUNTIME, BARREL, buildValueGraph, byCodeUnit, countModuleExports, crossGroupEdges, loadLayerTable, repoRoot,
} from './lib/backend-structure.mjs'

const MAP_PATH = 'docs/architecture/feature-map.md'

const cell = (text) => String(text).replaceAll('|', '\\|')

export function renderFeatureMap(graph, table) {
  const pairs = crossGroupEdges(graph, table.groupOf)
  const outgoing = new Map()
  for (const [key, list] of pairs) {
    const [from, to] = key.split(' → ')
    if (!outgoing.has(from)) outgoing.set(from, [])
    outgoing.get(from).push([to, list.length])
  }
  const fileCount = new Map()
  for (const file of graph.files) { const g = table.groupOf(file); fileCount.set(g, (fileCount.get(g) ?? 0) + 1) }
  const entryOf = (row) => {
    if (row.name === BARREL) return `${RUNTIME}/index.ts`
    return row.kind === 'feature' ? `${RUNTIME}/${row.name}/index.ts` : null
  }
  const exportsCell = (row) => {
    const entry = entryOf(row)
    if (!entry) return '—'
    if (!graph.files.includes(entry)) return fileCount.has(row.name) ? '无入口' : '(目录未建)'
    const n = countModuleExports(graph, entry)
    return `${n.total}(值 ${n.values} / 类型 ${n.types})`
  }
  const dependsCell = (row) => {
    const list = (outgoing.get(row.name) ?? []).sort((a, b) => b[1] - a[1] || byCodeUnit(a[0], b[0]))
    if (list.length === 0) return '—'
    const mine = table.rankOf(row.name)
    return list.map(([to, n]) => `${to} ${n}${table.rankOf(to) > mine ? '(越层)' : ''}`).join(' · ')
  }

  const lines = [
    '# 后端功能地图',
    '',
    `> 由 \`scripts/feature-map.mjs\` 生成,**不要手改**。改了层次表(\`${LAYER_TABLE}\`)或功能之间的引用之后跑 \`bun run feature-map\`;`,
    '> `bun run feature-map:check` 在 CI 里判这份文件与代码一致。',
    '',
    '怎么读:',
    '',
    '- 从上往下是从高层到低层;规矩是**只许高层引低层**(决策 D23),同层之间经入口且不成环(D19)。',
    '- 「依赖的功能」是运行期值引用(只引类型的不算),数字是从这个功能的文件指向那个功能的文件的引用条数(同一对文件只算一条);标「越层」的是低层引高层,即 `bun run layer:gate` 记账的违例。',
    '- 「入口交出」是入口 `runtime/<功能>/index.ts` 交出的名字数(含再导出),越少越好(R6)。',
    '- 「文件」是这个功能的非测试源文件数。括号里的行不是功能,是包根与 shared 按路径分的槽位。',
    '',
  ]
  const layersHighToLow = [...table.layers].reverse()
  for (const layer of layersHighToLow) {
    const rows = table.rows.filter((row) => row.layer === layer.id)
      .sort((a, b) => (a.kind === b.kind ? byCodeUnit(a.name, b.name) : a.kind === 'feature' ? -1 : 1))
    lines.push(`## ${layer.id} ${layer.name}`, '', layer.meaning, '')
    lines.push('| 功能 | 做什么 | 依赖的功能 | 入口交出 | 文件 |', '| --- | --- | --- | --- | --- |')
    for (const row of rows) {
      lines.push(`| ${cell(row.name)} | ${cell(row.why)} | ${cell(dependsCell(row))} | ${cell(exportsCell(row))} | ${fileCount.get(row.name) ?? 0} |`)
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function main() {
  const check = process.argv.includes('--check')
  const table = loadLayerTable()
  const graph = buildValueGraph()
  const text = renderFeatureMap(graph, table)
  const target = path.join(repoRoot, MAP_PATH)
  if (check) {
    if (!existsSync(target)) {
      console.error(`[feature-map] failed: ${MAP_PATH} 不存在 —— 跑 \`bun run feature-map\` 生成它。`)
      process.exit(1)
    }
    const current = readFileSync(target, 'utf8')
    if (current !== text) {
      const a = current.split('\n')
      const b = text.split('\n')
      const at = a.findIndex((line, i) => line !== b[i])
      const line = at < 0 ? Math.min(a.length, b.length) : at
      console.error(`[feature-map] failed: ${MAP_PATH} 与代码不一致(第 ${line + 1} 行起)—— 跑 \`bun run feature-map\` 重新生成后一起提交。`)
      console.error(`  仓库里:${a[line] ?? '(文件结束)'}`)
      console.error(`  生成的:${b[line] ?? '(文件结束)'}`)
      process.exit(1)
    }
    console.log(`[feature-map] ok — ${MAP_PATH} matches the code (${table.rows.length} row(s))`)
    return
  }
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, text, 'utf8')
  console.log(`[feature-map] written → ${MAP_PATH} (${table.rows.length} row(s))`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
