#!/usr/bin/env node
// 功能入口无环门(决策 D19,docs/design/backend-structure-decisions-2026-10.md)。零基线硬闸。
//
// 为什么:每个功能只经自己的入口 `<功能>/<功能>.ts`(命名规范 N3;6b 之前叫 `index.ts`)对外(D9)。入口一旦卷进加载期的环,
// 就会重演 10-04 providers 的崩溃 —— 一个入口 `export *` 全交出去,60 只模块成环,`class X extends Base`
// 在加载期读到 undefined。继承没法改成惰性,所以唯一的办法是保证入口之间是有向无环图(DAG)。
//
// 判据:在运行期值引用图上(口径见 `scripts/lib/backend-structure.mjs` 文件头:只引类型的名字、`import type`、
// 动态 `import()`、测试文件都不成边;与 Fable 的模拟器 `sim.mjs --real` 逐边一致)算强连通分量。
// **任何强连通分量只要含有某个功能入口 `<功能>/<功能>.ts`,就红**(从前还有总桶 `runtime/index.ts`,2026-10-04 删掉),
// 并打出经过该入口的最短环。没有基线:今天读数是 0,以后也只能是 0。
//
// 不经入口的深层环(功能目录内部、或包根文件之间)今天还有几个,这里照打它们的大小供参考,不判红 ——
// 它们不会让「从入口拿名字」的人在加载期读到 undefined,治理归各功能自己的批次。
//
// D26 的第二入口 `<功能>-client-api.ts`(开给界面的操作)落地后不算入口:它只给 http-server 用,
// 任何主入口都不许引它,所以环判据只看主入口。
//
// 用法:
//   node scripts/feature-cycle-gate.mjs          判(package.json: cycle:gate)
//   node scripts/feature-cycle-gate.mjs --list   另打每个深层环的成员(package.json: cycle:check)
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildValueGraph, entryFeatureOf, runtimeFeatureOf, shortestCycleThrough, stronglyConnected } from './lib/backend-structure.mjs'

/** 图规模下限:解析坏了同样长得像「没有环」。 */
const MIN_GRAPH_FILES = 1000
const MIN_ENTRIES = 30

const short = (f) => (runtimeFeatureOf(f) ? f.slice('packages/backend/'.length) : f.replace('packages/backend/', '(包根)/'))

/** 纯判定:哪些强连通分量含入口,以及每个入口的最短环。 */
export function findEntryCycles(edges, isEntry) {
  const components = stronglyConnected(edges)
  const offending = []
  const deep = []
  for (const members of components) {
    const entries = members.filter(isEntry)
    if (entries.length === 0) { deep.push(members); continue }
    offending.push({ members, entries: entries.map((entry) => ({ entry, cycle: shortestCycleThrough(edges, entry) })) })
  }
  return { offending, deep }
}

function main() {
  const args = process.argv.slice(2)
  const graph = buildValueGraph()
  const isEntry = (f) => entryFeatureOf(f) !== null
  const entryCount = graph.files.filter(isEntry).length
  const edgeCount = [...graph.edges.values()].reduce((n, s) => n + s.size, 0)
  if (graph.files.length < MIN_GRAPH_FILES || entryCount < MIN_ENTRIES) {
    console.error(`[cycle-gate] 图只有 ${graph.files.length} 只文件 / ${entryCount} 个入口(下限 ${MIN_GRAPH_FILES} / ${MIN_ENTRIES})—— 解析坏了,不认这次结果。`)
    process.exit(1)
  }
  const { offending, deep } = findEntryCycles(graph.edges, isEntry)
  const deepSizes = deep.map((members) => members.length)

  if (args.includes('--list')) {
    console.log(`[cycle] ${graph.files.length} 只文件、${edgeCount} 条值边、${entryCount} 个入口;不经入口的深层环 ${deep.length} 个:`)
    for (const members of deep) {
      console.log(`  ${members.length} 只:`)
      for (const file of members) console.log(`      ${short(file)}`)
    }
  }

  if (offending.length > 0) {
    const entryNames = offending.flatMap((c) => c.entries.map(({ entry }) => entryFeatureOf(entry)))
    console.error(`[cycle-gate] failed: ${offending.length} 个环卷进了功能入口(${entryNames.join('、')})—— 入口之间必须是有向无环图(D19):`)
    for (const { members, entries } of offending) {
      console.error(`  环里 ${members.length} 只文件,含入口 ${entries.length} 个:`)
      for (const { entry, cycle } of entries) {
        console.error(`    ${entryFeatureOf(entry)} 的最短环(${cycle.length - 1} 步):`)
        console.error(`      ${cycle.map(short).join('\n        → ')}`)
      }
    }
    console.error('  治法:找到环上那条「低层引高层」或「入口引回自己的使用者」的边,把值引用改成装配时注入,或把文件搬到它依赖的层次去。')
    console.error('  不要改成 import type 骗过门 —— 只有真的只用类型才能那样写。')
    process.exit(1)
  }
  console.log(
    `[cycle-gate] ok — 0 cycles through ${entryCount} feature entries (${graph.files.length} files, ${edgeCount} value edges);`
    + ` deep cycles not through an entry: ${deepSizes.length ? deepSizes.join(' / ') : 'none'} (not judged)`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
