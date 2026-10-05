#!/usr/bin/env node
// 第二入口门(决策 D26,docs/design/backend-structure-decisions-2026-10.md)。零基线硬闸。
//
// 为什么:每个功能有两个对外的口。主入口 `<功能>/<功能>.ts`(N3)给别的功能用;
// 第二个入口 `<功能>/<功能>-client-api*.ts` 给界面用 —— 它装的是这个功能开给 HTTP 服务器的东西
// (名册里的域行、只有 HTTP 服务器用的投影与投递件),可以引任何功能的主入口,所以它天然是枢纽。
// 如果别的功能、或者某个主入口去引它,有界面操作的功能就会重新变成枢纽,入口无环门(D19)的零环结论会翻掉
// (`docs/design/feature-layers-and-provider-placement-2026-10.md` 第 8 节第 1 条)。
//
// 判据:
//   - 「client-api 文件」只看路径:`packages/backend/<功能>/<功能>-client-api.ts` 或
//     `…/<功能>-client-api-<方面>.ts`(`scripts/lib/backend-structure.mjs` 的 `clientApiFeatureOf`)。
//     文件名里带 `-client-api` 却不是这个形状(不在功能目录正下方、不以自己的功能名打头)= 红:名字是判据本身,不许含糊。
//   - 引用 = 一处模块说明符(静态 / 动态 import、`export … from`、`require`、`vi.mock` 一族;口径与 `entry:gate` 同一份代码)。
//   - 允许引 client-api 文件的只有:
//       ① `packages/backend/http-server/` 下的文件(HTTP 服务器读名册、装投递件);
//       ② 同一个功能的另一只 client-api 文件(一个功能开给界面的东西分几只文件写,彼此可以引);
//       ③ 测试(`__tests__/`、`*.test.*`、`__fixtures__/`、`testing/`);
//       ④ 下面 `EXCEPTIONS` 里逐对写了理由的引用(今天为空)。
//     其余任何一处 = 红(主入口引它、别的功能引它、包根别的文件引它、apps / scripts 引它)。
//   - 主入口只算主入口:`cycle:gate` 的环判据不把 client-api 当入口(它不该被任何主入口引,本门保证这一点)。
//   - 装配入口(D191)`<功能>/<功能>-configure.ts`(`configureEntryFeatureOf`,今天只有 logging):装配期才建的状态与
//     接线 API。允许引它的只有:层次表上站 L4 的文件(包根、http-server、两种第二入口槽位、L4 的功能)、`apps/` 下的宿主、
//     测试。L0–L3 的功能文件引它 = 红 —— 它们要的无副作用函数面由主入口交出。
//
// 两条防假绿:client-api 文件少于 `MIN_CLIENT_API_FILES` 或扫描文件少于下限 = 红(搬家 / 遍历坏了不该像「全干净」)。
//
// 用法:
//   node scripts/client-api-gate.mjs              判(package.json: client-api:gate)
//   node scripts/client-api-gate.mjs --list       另打每只 client-api 文件与它的引用方(package.json: client-api:check)
//   node scripts/client-api-gate.mjs --self-test  判据自检
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectSpecifiers, resolveSpecifier } from './feature-entry-gate.mjs'
import { clientApiFeatureOf, configureEntryFeatureOf, isTestPath, loadLayerTable, repoRoot, runtimeFeatureOf } from './lib/backend-structure.mjs'

const SCAN_ROOTS = ['packages', 'apps', 'scripts', 'evals']
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'release', 'coverage'])
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/
const MIN_CLIENT_API_FILES = 40
const MIN_SCANNED_FILES = 3000
const HTTP_SERVER_DIR = 'packages/backend/http-server/'

/**
 * 逐条写理由的例外:`引用方 → 被引的 client-api 文件`。删掉一条之前先让那个文件不再那样引。
 */
export const EXCEPTIONS = new Map([
  // 包根归位 A 时这里有两对(轨迹 feature → sessions 事件域、ACP → sessions 域),包根归位 B(2026-10-04)两对都消了:
  // 轨迹并成了 sessions 事件域那一行名册,ACP 认领远端会话改走会话入口交出的 `session-caller-ops.ts`。
])

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRECTORIES.has(entry) || entry.startsWith('.') || entry.startsWith('dist-')) continue
    const absolute = path.join(dir, entry)
    const stat = statSync(absolute)
    if (stat.isDirectory()) walk(absolute, out)
    else if (SOURCE_FILE.test(entry)) out.push(absolute)
  }
  return out
}

let layerTable
/** 装配入口(D191)的判据:只许 L4、`apps/` 与测试引。合规返回 null,违规返回一句理由;目标不是装配入口返回 undefined。 */
export function judgeConfigureEntry(importer, target, table = (layerTable ??= loadLayerTable())) {
  const owner = configureEntryFeatureOf(target)
  if (!owner) return undefined
  if (isTestPath(importer) || importer.startsWith('apps/')) return null
  if (table.layerOf(table.groupOf(importer)) === 'L4') return null
  return `${owner} 的装配入口只许 L4(包根、${HTTP_SERVER_DIR}、两种第二入口、L4 的功能)、apps/ 与测试引用;无副作用的名字从 ${owner} 的主入口拿`
}

/** 判一处引用:合规返回 null,违规返回一句理由。`importer` / `target` 都是仓库相对路径。 */
export function judge(importer, target) {
  const configureVerdict = judgeConfigureEntry(importer, target)
  if (configureVerdict !== undefined) return configureVerdict
  const owner = clientApiFeatureOf(target)
  if (!owner) return null
  if (importer.startsWith(HTTP_SERVER_DIR)) return null
  if (clientApiFeatureOf(importer) === owner) return null
  if (isTestPath(importer)) return null
  if (EXCEPTIONS.has(`${importer} → ${target}`)) return null
  return `${owner} 的第二个入口只许 HTTP 服务器(${HTTP_SERVER_DIR})与 ${owner} 自己的 client-api 文件引用`
}

/** 名字里带 `-client-api` 却不是判据认的形状:返回理由,否则 null。 */
export function misnamed(relative) {
  if (isTestPath(relative) || !/-client-api/.test(path.basename(relative))) return null
  if (!runtimeFeatureOf(relative)) return null // 只判功能目录里的文件(包根散文件、http-server 不判,与搬家前只判 runtime/ 下同一范围)
  return clientApiFeatureOf(relative) ? null : '文件名带 `-client-api`,但不是 `<功能>/<功能>-client-api[-<方面>].ts`'
}

export function measure(root = repoRoot) {
  const exportsMap = JSON.parse(readFileSync(path.join(root, 'packages/backend/package.json'), 'utf8')).exports ?? {}
  const files = []
  for (const scanRoot of SCAN_ROOTS) {
    const absolute = path.join(root, scanRoot)
    if (existsSync(absolute)) walk(absolute, files)
  }
  const rel = (f) => path.relative(root, f).split(path.sep).join('/')
  const clientApis = files.map(rel).filter((f) => clientApiFeatureOf(f) !== null || configureEntryFeatureOf(f) !== null).sort()
  const importersOf = new Map(clientApis.map((f) => [f, []]))
  const violations = []
  const misnamedFiles = files.map(rel).map((f) => [f, misnamed(f)]).filter(([, why]) => why)
  for (const absolute of files.sort()) {
    const importer = rel(absolute)
    for (const { specifier, line } of collectSpecifiers(absolute, readFileSync(absolute, 'utf8'))) {
      const resolved = resolveSpecifier(specifier, absolute, exportsMap)
      if (!resolved) continue
      const target = rel(resolved)
      if (!importersOf.has(target)) continue
      importersOf.get(target).push(`${importer}:${line}`)
      const why = judge(importer, target)
      if (why) violations.push({ importer, line, target, why })
    }
  }
  return { clientApis, importersOf, violations, misnamedFiles, scanned: files.length }
}

function selfTest() {
  const failures = []
  const expect = (label, condition) => { if (!condition) failures.push(label) }
  const api = 'packages/backend/settings/settings-client-api.ts'
  const aspect = 'packages/backend/settings/settings-client-api-projection.ts'
  expect('功能名打头、在功能目录正下方 = client-api', clientApiFeatureOf(api) === 'settings')
  expect('方面文件也是 client-api', clientApiFeatureOf(aspect) === 'settings')
  expect('别人名字打头的不是', clientApiFeatureOf('packages/backend/settings/mcp-client-api.ts') === null)
  expect('子目录里的不是', clientApiFeatureOf('packages/backend/settings/x/settings-client-api.ts') === null)
  expect('测试不是', clientApiFeatureOf('packages/backend/settings/__tests__/settings-client-api.test.ts') === null)
  expect('名字含糊 = 红', misnamed('packages/backend/settings/mcp-client-api.ts') !== null)
  expect('HTTP 服务器可以引', judge('packages/backend/http-server/http-server-client-api-roster.ts', api) === null)
  expect('同功能的 client-api 可以引', judge(api, aspect) === null)
  expect('测试可以引', judge('packages/backend/settings/__tests__/settings-client-api.test.ts', api) === null)
  expect('包根别处的 feature 引 = 红(轨迹那条例外已删)', judge('packages/backend/backend.ts', 'packages/backend/session/session-client-api-events.ts') !== null)
  expect('别的功能的 client-api 动态引也 = 红(ACP 那条例外已删)', judge('packages/backend/acp/acp-client-api.ts', 'packages/backend/session/session-client-api.ts') !== null)
  expect('主入口引 = 红', judge('packages/backend/settings/settings.ts', api) !== null)
  expect('功能内部文件引 = 红', judge('packages/backend/settings/settings-store.ts', api) !== null)
  expect('别的功能的 client-api 引 = 红', judge('packages/backend/mcp/mcp-client-api.ts', api) !== null)
  expect('包根别的文件引 = 红', judge('packages/backend/backend.ts', api) !== null)
  expect('宿主引 = 红', judge('apps/cli/src/daemon-server.ts', api) !== null)
  expect('不带界面的后端进程入口引 = 红', judge('packages/backend/backend-standalone-main.ts', api) !== null)
  expect('不是 client-api 的目标不判', judge('packages/backend/mcp/mcp.ts', 'packages/backend/settings/settings.ts') === null)
  const configure = 'packages/backend/logging/logging-configure.ts'
  expect('装配入口:形状认得出', configureEntryFeatureOf(configure) === 'logging')
  expect('装配入口:别人名字打头的不是', configureEntryFeatureOf('packages/backend/logging/storage-configure.ts') === null)
  expect('装配入口:包根装配配方可以引', judge('packages/backend/backend.ts', configure) === null)
  expect('装配入口:http-server 可以引', judge('packages/backend/http-server/http-server-runtime.ts', configure) === null)
  expect('装配入口:client-api 可以引', judge('packages/backend/logging/logging-client-api.ts', configure) === null)
  expect('装配入口:宿主可以引', judge('apps/cli/src/daemon-server.ts', configure) === null)
  expect('装配入口:包根的进程入口可以引', judge('packages/backend/backend-standalone-main.ts', configure) === null)
  expect('装配入口:测试可以引', judge('packages/backend/toc/__tests__/record-turn.test.ts', configure) === null)
  expect('装配入口:L2 的功能文件引 = 红', judge('packages/backend/permission/permission-enforcement.ts', configure) !== null)
  expect('装配入口:同功能的普通文件引 = 红', judge('packages/backend/logging/logging-diagnostics.ts', configure) !== null)
  if (failures.length > 0) {
    console.error('[client-api-gate] self-test FAILED:')
    for (const label of failures) console.error('  ✗', label)
    process.exit(1)
  }
  console.log('[client-api-gate] self-test ok — 28 checks passed')
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) return selfTest()
  const { clientApis, importersOf, violations, misnamedFiles, scanned } = measure()
  if (scanned < MIN_SCANNED_FILES || clientApis.length < MIN_CLIENT_API_FILES) {
    console.error(`[client-api-gate] 只扫到 ${scanned} 个文件 / ${clientApis.length} 只 client-api 文件(下限 ${MIN_SCANNED_FILES} / ${MIN_CLIENT_API_FILES})—— 遍历坏了或搬家了,不认这次结果。`)
    process.exit(1)
  }
  if (args.includes('--list')) {
    console.log(`[client-api] ${clientApis.length} 只 client-api 文件:`)
    for (const file of clientApis) {
      console.log(`  ${file.replace('packages/backend/', '')}`)
      for (const site of importersOf.get(file)) console.log(`      ← ${site}`)
    }
  }
  if (misnamedFiles.length > 0 || violations.length > 0) {
    console.error(`[client-api-gate] failed: ${violations.length} 处越界引用、${misnamedFiles.length} 只名字不合判据的文件:`)
    for (const [file, why] of misnamedFiles) console.error(`  ✗ ${file}:${why}`)
    for (const v of violations) console.error(`  ✗ ${v.importer}:${v.line} → ${v.target}\n      ${v.why}`)
    console.error('  治法:要用的名字该由那个功能的主入口交出(它是给别的功能用的那个口);只有 HTTP 服务器用的东西才住 client-api。')
    process.exit(1)
  }
  const importerCount = [...importersOf.values()].reduce((n, list) => n + list.length, 0)
  console.log(`[client-api-gate] ok — ${clientApis.length} client-api / configure-entry file(s) across ${new Set(clientApis.map((f) => clientApiFeatureOf(f) ?? configureEntryFeatureOf(f))).size} feature(s), ${importerCount} import site(s), 0 outside http-server / same-feature / L4 / apps / tests / ${EXCEPTIONS.size} listed exception(s); ${scanned} file(s) scanned`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
