#!/usr/bin/env node
// 功能入口棘轮(server / client 拆分 docs/design/server-client-split-2026-10.md §4「功能入口」)。
//
// 用户拍板(2026-10-03):每个功能只通过自己的入口 `packages/backend/<功能>/<功能>.ts`(N3;6b 之前叫 `index.ts`)对外交出能力
// (命名规范 N3 的形状 `<功能>/<功能>.ts` 同样是入口,2026-10-04 凭证功能起用);
// 功能目录里其余文件是内部实现,外面(包根、别的功能、apps、scripts、evals)不许直接引用。读一个功能,
// 先看它的入口就知道它对外给了什么。
//
// 度量的是:**从功能目录之外,引用这个功能内部文件(入口 `<功能>.ts` 以外的任何文件)的 import 处数。**
// 逐功能计数,规矩一条:**只许减**。某功能高于基线、或出现基线里没有的功能 → 红;低于基线 → 提示可收紧。
//
// 口径:
//   - 「引用」= 一处模块说明符:`import … from` / `import '…'` / `export … from` / `import x = require('…')` /
//     动态 `import('…')` / 类型位置的 `import('…')`(`typeof import('…')`)/ `require('…')` /
//     `vi.mock` / `vi.doMock` / `vi.unmock` / `vi.doUnmock` / `vi.importActual` / `vi.importMock` 的第一个参数。
//     用 TypeScript 解析器取,注释与普通字符串不算。
//   - 包说明符 `@onething/backend/<子路径>` 先按 `packages/backend/package.json` 的 exports 精确键解析到文件
//     (`./search/index` 这种键指的是 `search/index/` 子目录的桶,不是入口,所以必须按文件判);
//     没有键的按字面路径解析。相对路径按磁盘解析(`.js` → `.ts`、补 `.ts` / `/index.ts`)。
//   - 解析到 `<功能>/<功能>.ts` = 走入口,不计;解析到功能目录里的其他文件 = 深层,计一处;
//     引用方自己就在这个功能目录里 = 内部引用,不计。
//   - 从前还有一行 `(总桶)`(引用总桶 `runtime/index.ts` 的处数);总桶 2026-10-04 删掉,这一行随之撤掉。
//   - 「功能」= `packages/backend/` 下的每个直接子目录,`NON_FEATURE_DIRS`(`__tests__` / `http-server` / `node_modules`)除外;
//     包根的散文件(backend.ts 等)与非功能目录不是功能,引用它们不计。(2026-10-04 去掉 `runtime/` 这一层之前,功能根是包根下的 `runtime/` 目录。)
//   - 扫描范围 `packages/`、`apps/`、`scripts/`、`evals/` 下的 `.ts/.tsx/.mts/.cts/.js/.mjs/.cjs`;跳过 node_modules、
//     点开头的目录与构建产物目录(dist、dist-*、build、release、coverage)。`.txt` 模板不是代码,不扫。
//
// 两条防假绿(与 assembly-gate 同构):扫描规模低于下限 = 红;基线读不到或解析为空 = 红。
//
// 用法:
//   node scripts/feature-entry-gate.mjs                  棘轮比对(package.json: entry:gate)
//   node scripts/feature-entry-gate.mjs --list           打全表(package.json: entry:check)
//   node scripts/feature-entry-gate.mjs --list --verbose 另打每一处引用(功能 / 内部目标 / 引用方:行)
//   node scripts/feature-entry-gate.mjs --list <功能…>   只打这几个功能的逐处引用
//   node scripts/feature-entry-gate.mjs --write-baseline 收紧基线(只在真降之后)
//   node scripts/feature-entry-gate.mjs --self-test      判据自检
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { NON_FEATURE_DIRS, clientApiFeatureOf } from './lib/backend-structure.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = path.join(root, 'docs/audit/feature-entry-baseline-2026-10.txt')
const BACKEND = 'packages/backend'
/** 功能目录的根:2026-10-04 起就是包根(功能目录直接住在 `packages/backend/` 下)。 */
const FEATURE_ROOT = BACKEND
const PACKAGE_NAME = '@onething/backend'
/** 防假绿:这只功能目录必须在,否则功能根已经搬走、指标失效。 */
const SENTINEL_FEATURE = 'session'

const SCAN_ROOTS = ['packages', 'apps', 'scripts', 'evals']
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'release', 'coverage'])
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/
const MOCK_CALLEES = new Set(['mock', 'doMock', 'unmock', 'doUnmock', 'importActual', 'importMock'])

/** 扫描规模下限:遍历坏了 / 目录搬家了,同样长得像「全收口了」。 */
const MIN_SCANNED_FILES = 3000

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

/** 一只源文件里的全部模块说明符(带行号)。 */
export function collectSpecifiers(fileName, source) {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX
    : /\.(?:m|c)?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, kind)
  const found = []
  const add = (node) => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      found.push({ specifier: node.text, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 })
    }
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier)
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression)
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal)
    else if (ts.isCallExpression(node)) {
      const callee = node.expression
      const first = node.arguments[0]
      if (callee.kind === ts.SyntaxKind.ImportKeyword) add(first)
      else if (ts.isIdentifier(callee) && callee.text === 'require') add(first)
      else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        && callee.expression.text === 'vi' && MOCK_CALLEES.has(callee.name.text)) add(first)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** 把一个落在磁盘上的路径补成真文件(`.js` → `.ts`、补扩展名、补 `/index.ts`);补不出来就原样返回。 */
function toFile(absolute) {
  const candidates = [absolute]
  const stripped = absolute.replace(/\.(?:js|mjs|cjs|ts|tsx|mts|cts)$/, '')
  for (const ext of ['.ts', '.tsx', '.mts', '.js', '.mjs']) candidates.push(stripped + ext)
  candidates.push(path.join(absolute, 'index.ts'), path.join(stripped, 'index.ts'))
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return absolute
}

function loadExports() {
  const pkg = JSON.parse(readFileSync(path.join(root, BACKEND, 'package.json'), 'utf8'))
  return pkg.exports ?? {}
}

/** 说明符 → 仓内绝对路径;不是本仓后端包的说明符返回 null。 */
export function resolveSpecifier(specifier, importerAbsolute, exportsMap) {
  if (specifier.startsWith('.')) return toFile(path.resolve(path.dirname(importerAbsolute), specifier))
  if (specifier !== PACKAGE_NAME && !specifier.startsWith(`${PACKAGE_NAME}/`)) return null
  const sub = specifier.slice(PACKAGE_NAME.length)
  const key = `.${sub}`
  const target = exportsMap[key === '.' ? '.' : key]
  if (typeof target === 'string') return path.join(root, BACKEND, target)
  return toFile(path.join(root, BACKEND, sub))
}

/**
 * 判一处引用:返回 `{ feature, target }`(深层,feature 为功能名),或 null(不计)。
 * `features` 是功能目录名的集合。
 */
export function classify(resolvedAbsolute, importerAbsolute, features) {
  if (!resolvedAbsolute) return null
  const runtimeAbsolute = path.join(root, FEATURE_ROOT)
  const rel = path.relative(runtimeAbsolute, resolvedAbsolute)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  const parts = rel.split(path.sep)
  if (parts.length === 1) return null // 包根的散文件,不是功能
  const feature = parts[0]
  if (!features.has(feature)) return null
  const featureDir = path.join(runtimeAbsolute, feature)
  if (importerAbsolute.startsWith(featureDir + path.sep)) return null
  const inner = parts.slice(1).join('/')
  if (inner === '') return null
  // 入口 = 命名规范 N3 的形状 `<功能>/<功能>.ts`。2026-10-04 机械改名 6b 把每个功能的 `index.ts` 改成了这个名字,
  // 过渡期「目录里有 `index.ts` 时认 `index.ts`」的判法(D31)随之删掉 —— 万一谁又建了 `<功能>/index.ts`,它按深层计。
  if (inner === `${feature}.ts` || inner === `${feature}.js` || inner === feature) return null
  // 第二个入口 `<功能>-client-api*.ts`(D26)同样不计:谁可以引它由 `client-api:gate` 管(只许 HTTP 服务器)。
  if (clientApiFeatureOf(`${FEATURE_ROOT}/${feature}/${inner.replace(/\.js$/, '.ts')}`) === feature) return null
  return { feature, target: inner }
}

/** @returns {{ counts: Record<string, number>, sites: Array<{feature,target,importer,line,specifier}>, scanned: number }} */
export function measure() {
  const runtimeAbsolute = path.join(root, FEATURE_ROOT)
  if (!existsSync(path.join(runtimeAbsolute, SENTINEL_FEATURE))) {
    // 目录不存在 ≠ 指标归零。真搬家了就该显式改这个脚本,而不是让 gate 替你庆祝。
    throw new Error(`功能根不对:${FEATURE_ROOT}/${SENTINEL_FEATURE} 不存在 —— 指标已失效,不认这次结果`)
  }
  const features = new Set(readdirSync(runtimeAbsolute)
    .filter((name) => !NON_FEATURE_DIRS.has(name) && !name.startsWith('.') && statSync(path.join(runtimeAbsolute, name)).isDirectory()))
  const exportsMap = loadExports()
  const files = []
  for (const scanRoot of SCAN_ROOTS) {
    const absolute = path.join(root, scanRoot)
    if (existsSync(absolute)) walk(absolute, files)
  }
  const counts = {}
  const sites = []
  for (const absolute of files.sort()) {
    const source = readFileSync(absolute, 'utf8')
    for (const { specifier, line } of collectSpecifiers(absolute, source)) {
      const hit = classify(resolveSpecifier(specifier, absolute, exportsMap), absolute, features)
      if (!hit) continue
      counts[hit.feature] = (counts[hit.feature] ?? 0) + 1
      sites.push({ ...hit, importer: path.relative(root, absolute), line, specifier })
    }
  }
  return { counts, sites, scanned: files.length }
}

export function formatBaseline(counts) {
  const lines = [
    '# feature-entry ratchet baseline (docs/design/server-client-split-2026-10.md §4「功能入口」)',
    '# 每行 `<次数> <功能>`:从功能目录之外引用 packages/backend/<功能>/ 里入口(N3 形状的 `<功能>/<功能>.ts`)以外文件的 import 处数。',
    '# 只许降:任一功能高于这里的数、或出现这里没有的功能,`bun run entry:gate` 红。',
    '# 降了之后跑 `node scripts/feature-entry-gate.mjs --write-baseline` 收紧。',
  ]
  const keys = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b))
  for (const key of keys) lines.push(`${counts[key]} ${key}`)
  return `${lines.join('\n')}\n`
}

export function parseBaseline(text) {
  const counts = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const at = line.indexOf(' ')
    if (at < 0) continue
    const value = Number.parseInt(line.slice(0, at), 10)
    const key = line.slice(at + 1).trim()
    if (!key || Number.isNaN(value)) continue
    counts[key] = value
  }
  return counts
}

/** 纯比较:只回报,不打印、不退出。 */
export function compare(baseline, current) {
  const regressions = []
  const improvements = []
  for (const [key, n] of Object.entries(current)) {
    const base = baseline[key] ?? 0
    // 基线里没有的功能一律当红:不然新开一个功能目录就能绕开棘轮。
    if (n > base) regressions.push({ key, baseline: base, current: n, isNew: !(key in baseline) })
  }
  for (const [key, base] of Object.entries(baseline)) {
    const n = current[key] ?? 0
    if (n < base) improvements.push({ key, baseline: base, current: n })
  }
  return { regressions, improvements }
}

function selfTest() {
  const failures = []
  const expect = (label, condition) => {
    if (!condition) failures.push(label)
  }

  // 1) 说明符采集:八种写法都算,注释与普通字符串不算。
  const fixture = [
    "import a from '@onething/backend/search/service.js'",
    "import '@onething/backend/search/side-effect.js'",
    "export { b } from '../search/kernel/redact.js'",
    "const c = await import('@onething/backend/search/capabilities')",
    "type D = typeof import('@onething/backend/search/service')",
    "vi.mock('@onething/backend/search/service-bound.js', () => ({}))",
    "const e = await vi.importActual('@onething/backend/search/service-setup.js')",
    "const f = require('./x.cjs')",
    "// import g from '@onething/backend/search/not-counted.js'",
    "const h = 'from @onething/backend/search/not-counted.js'",
  ].join('\n')
  const specs = collectSpecifiers('fixture.ts', fixture).map((s) => s.specifier)
  expect('应采到 8 处说明符', specs.length === 8)
  expect('注释与普通字符串不算', !specs.some((s) => s.includes('not-counted')))

  // 2) 判定:入口不计、深层计、功能内部不计、包根散文件与非功能目录不计。
  const features = new Set(['search', 'mcp'])
  const R = (p) => path.join(root, FEATURE_ROOT, p)
  const outside = path.join(root, BACKEND, 'backend.ts')
  expect('入口(N3 形状 <功能>/<功能>.ts)不计', classify(R('search/search.ts'), outside, features) === null)
  expect('index.ts 不再是入口,按深层计', classify(R('search/index.ts'), outside, features)?.target === 'index.ts')
  expect('深层计一处', classify(R('search/search-service.ts'), outside, features)?.feature === 'search')
  expect('子目录的入口文件也是深层', classify(R('search/index/search-index.ts'), outside, features)?.target === 'index/search-index.ts')
  expect('功能内部不计', classify(R('search/search-service.ts'), R('search/capabilities/x.ts'), features) === null)
  expect('别的功能引用算深层', classify(R('search/search-service.ts'), R('mcp/x.ts'), features)?.feature === 'search')
  expect('非功能目录(http-server)不计', classify(R('http-server/http-server-routes.ts'), outside, features) === null)
  expect('包根文件不计', classify(path.join(root, BACKEND, 'backend-current.ts'), outside, features) === null)
  expect('第二个入口 client-api 不计', classify(R('search/search-client-api.ts'), outside, features) === null)
  expect('client-api 的方面文件也不计', classify(R('search/search-client-api-providers.ts'), outside, features) === null)
  expect('别人名字打头的 client-api 照算深层', classify(R('search/mcp-client-api.ts'), outside, features)?.feature === 'search')

  // 3) 棘轮:升 → 红;降 → 提示;新功能 → 红;往返无损。
  const up = compare({ search: 1 }, { search: 2 })
  expect('上升应产生 regression', up.regressions.length === 1 && up.improvements.length === 0)
  const down = compare({ search: 3 }, { search: 1 })
  expect('下降应产生 improvement', down.improvements.length === 1 && down.regressions.length === 0)
  const added = compare({ search: 1 }, { search: 1, mcp: 1 })
  expect('新功能应算 regression', added.regressions.length === 1 && added.regressions[0].isNew)
  const healed = compare({ search: 2 }, {})
  expect('清零应算 improvement', healed.improvements.length === 1 && healed.improvements[0].current === 0)
  const round = parseBaseline(formatBaseline({ search: 4, mcp: 1 }))
  expect('基线往返应无损', round.search === 4 && round.mcp === 1)

  if (failures.length > 0) {
    console.error('[feature-entry-gate] self-test FAILED:')
    for (const label of failures) console.error('  ✗', label)
    process.exit(1)
  }
  console.log('[feature-entry-gate] self-test ok — 17 checks passed')
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) return selfTest()

  const { counts, sites, scanned } = measure()
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0)

  if (scanned < MIN_SCANNED_FILES) {
    console.error(`[feature-entry-gate] 只扫到 ${scanned} 个文件(下限 ${MIN_SCANNED_FILES})—— 遍历坏了,不认这次结果。`)
    process.exit(1)
  }

  if (args.includes('--list')) {
    const only = args.filter((a) => !a.startsWith('--'))
    const verbose = args.includes('--verbose') || only.length > 0
    const keys = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b))
    console.log(`[entry] ${total} deep import site(s) into ${keys.length} feature(s), ${scanned} file(s) scanned:`)
    for (const key of keys) console.log(`  ${counts[key]}\t${key}`)
    if (verbose) {
      for (const key of keys) {
        if (only.length > 0 && !only.includes(key)) continue
        console.log(`\n# ${key}`)
        for (const site of sites.filter((s) => s.feature === key)) {
          console.log(`  ${site.target}\t${site.importer}:${site.line}\t${site.specifier}`)
        }
      }
    }
    console.log(`[entry] complete: ${scanned} file(s) scanned`)
    return
  }

  if (args.includes('--write-baseline')) {
    writeFileSync(baselinePath, formatBaseline(counts), 'utf8')
    console.log(`[feature-entry-gate] baseline written → ${path.relative(root, baselinePath)} (${total} site(s))`)
    return
  }

  if (!existsSync(baselinePath)) {
    console.error(`[feature-entry-gate] 基线文件缺失:${path.relative(root, baselinePath)}`)
    console.error('  先跑一次 `node scripts/feature-entry-gate.mjs --write-baseline` 生成它。')
    process.exit(1)
  }
  const baseline = parseBaseline(readFileSync(baselinePath, 'utf8'))
  if (Object.keys(baseline).length === 0) {
    console.error('[feature-entry-gate] 基线解析为空 —— 格式坏了,不认这次结果')
    process.exit(1)
  }

  const { regressions, improvements } = compare(baseline, counts)

  if (improvements.length > 0) {
    const n = improvements.reduce((sum, item) => sum + (item.baseline - item.current), 0)
    console.log(`[feature-entry-gate] ${n} 处深层引用消失了 —— 可以收紧基线(--write-baseline):`)
    for (const item of improvements) console.log(`  - ${item.key}: ${item.baseline} → ${item.current}`)
  }

  if (regressions.length > 0) {
    console.error(`[feature-entry-gate] failed: ${regressions.length} 个功能的深层引用上升 —— 有人绕过入口直接引用了功能内部文件:`)
    for (const item of regressions) {
      const note = item.isNew ? '(基线里没有这个功能)' : ''
      console.error(`  + ${item.key}: ${item.baseline} → ${item.current} ${note}`)
      for (const site of sites.filter((s) => s.feature === item.key).slice(0, 20)) {
        console.error(`      ${site.target}  ← ${site.importer}:${site.line}`)
      }
    }
    console.error('  规矩见 docs/design/server-client-split-2026-10.md §4「功能入口」:')
    console.error('  外面要用的名字从 `@onething/backend/<功能>` 拿;入口没有的,先想清楚它该不该交出去,再加进入口。')
    process.exit(1)
  }

  console.log(
    `[feature-entry-gate] ok — ${total} known deep import site(s) across ${Object.keys(counts).length} feature row(s),`
    + ` ${scanned} file(s) scanned, none new`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
