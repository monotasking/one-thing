#!/usr/bin/env node
// 功能层次棘轮(决策 D23,docs/design/backend-structure-decisions-2026-10.md;层次的推导见
// docs/design/feature-layers-and-provider-placement-2026-10.md 第 6 节)。
//
// 为什么:功能之间不是平级的。providers / engine / auth / usage 的环,病根都是「一个目录里既有下层人人要的叶子,
// 又有要用到全世界的重半边」。把功能分成五个层次(L0 基础件 / L1 领域事实 / L2 能力 / L3 编排 / L4 对外接口)
// 并规定「只许高层引低层」,每只文件该去哪就由它依赖的层次决定,环也就没地方长。目录照旧一个功能一个、平铺,
// 层次只是一张标签表(Nx 模块边界 / Feature-Sliced Design 的做法)。
//
// 判据:
//   - 层次表 `docs/audit/feature-layers-2026-10.json`:每个功能一行 `{feature, layer, why}`;包根与 shared 按路径分进槽位行。
//   - 在运行期值引用图上(口径见 `scripts/lib/backend-structure.mjs` 文件头,与 Fable 的模拟器一致)取跨行的边,
//     来源行的层次低于目标行的层次 = 一条违例。同层的边不在这里判(入口无环门管)。
//   - **零基线硬闸**(2026-10-04 越层清零第 6 单之后):违例 0 条 / 0 对,所以不再有基线文件 ——
//     从前的 `docs/audit/layer-violation-baseline-2026-10.txt`(只减不增的成对计数)随之删掉。
//     任何一条低层引高层的值边都直接红,没有「已知的越层边」可以容忍。
//   - **层次表里没登记的功能 = 红**:新功能必须先定层次,再写代码。表里登记了但目录还不存在的(如 D25 的 credentials)只提示。
//
// 用法:
//   node scripts/feature-layer-gate.mjs                  零基线硬闸(package.json: layer:gate)
//   node scripts/feature-layer-gate.mjs --list           打每一对违例与其中的边(package.json: layer:check)
//
// 两条防假绿:跨功能值边少于下限(解析坏了)= 红;层次表里没登记的功能 = 红。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LAYER_TABLE, buildValueGraph, byCodeUnit, layerViolations, loadLayerTable,
} from './lib/backend-structure.mjs'

const MIN_CROSS_EDGES = 1000

function main() {
  const args = process.argv.slice(2)
  const table = loadLayerTable()
  const graph = buildValueGraph()
  const { violations, unregistered, crossEdges } = layerViolations(graph, table)
  if (crossEdges < MIN_CROSS_EDGES) {
    console.error(`[layer-gate] 只算出 ${crossEdges} 条跨功能边(下限 ${MIN_CROSS_EDGES})—— 解析坏了,不认这次结果。`)
    process.exit(1)
  }
  const counts = Object.fromEntries([...violations].map(([pair, list]) => [pair, list.length]))
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
  const present = new Set(graph.files.map(table.groupOf))
  const registeredButAbsent = table.rows.filter((row) => row.kind === 'feature' && !present.has(row.name)).map((row) => row.name)
  const tag = (pair) => pair.split(' → ').map((name) => `${name}(${table.layerOf(name) ?? '?'})`).join(' → ')

  if (args.includes('--list')) {
    console.log(`[layer] ${crossEdges} 条跨功能值边,其中低层引高层 ${total} 条 / ${violations.size} 对:`)
    const pairs = Object.keys(counts).sort(byCodeUnit)
    for (const pair of pairs) {
      console.log(`  ${counts[pair]}\t${tag(pair)}`)
      for (const edge of violations.get(pair)) console.log(`      ${edge}`)
    }
  }

  if (unregistered.length > 0) {
    console.error(`[layer-gate] failed: ${unregistered.length} 个功能没在层次表里登记:${unregistered.join('、')}`)
    console.error(`  新功能先在 ${LAYER_TABLE} 的 features 里加一行 {"feature","layer","why"},定好它站在哪一层,再写代码。`)
    process.exit(1)
  }
  if (registeredButAbsent.length > 0) console.log(`[layer-gate] 层次表里登记了、目录还不存在:${registeredButAbsent.join('、')}(只提示)`)

  if (args.includes('--write-baseline')) {
    console.error('[layer-gate] 这道门是零基线硬闸,没有基线可写 —— 违例只能改代码消掉(搬家或装配时注入)。')
    process.exit(1)
  }
  if (total > 0) {
    console.error(`[layer-gate] failed: ${total} 条越层引用 / ${violations.size} 对 —— 低层功能引了高层功能(零基线,一条都不许有):`)
    for (const pair of Object.keys(counts).sort(byCodeUnit)) {
      console.error(`  + ${tag(pair)}: ${counts[pair]}`)
      for (const edge of violations.get(pair).slice(0, 20)) console.error(`      ${edge}`)
    }
    console.error('  规矩:只许高层引低层。要么把这只文件搬到它依赖的层次去,要么把值引用改成装配时注入(能力自己登记、低层读表)。')
    process.exit(1)
  }
  console.log(`[layer-gate] ok — zero-baseline: 0 upward edges out of ${crossEdges} cross-feature value edges, ${table.rows.length} row(s) in the layer table`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
