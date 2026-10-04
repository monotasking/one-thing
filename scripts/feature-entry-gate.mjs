#!/usr/bin/env node
// 功能入口棘轮(server / client 拆分 docs/design/server-client-split-2026-10.md §4「功能入口」)。
//
// 用户拍板(2026-10-03):每个功能只通过自己的入口 `packages/backend/<功能>/<功能>.ts`(N3;6b 之前叫 `index.ts`)对外交出能力
// (命名规范 N3 的形状 `<功能>/<功能>.ts` 同样是入口,2026-10-04 凭证功能起用);
// 功能目录里其余文件是内部实现,外面(包根、别的功能、apps、scripts、evals)不许直接引用。读一个功能,
// 先看它的入口就知道它对外给了什么。
//
// 度量的是:**从功能目录之外,引用这个功能内部文件(入口 `<功能>.ts` 以外的任何文件)的 import 处数。**
// 两半判法(D202 第 15 条,2026-10-04 起):
//   - **非测试部分是零基线硬闸**:引用方不是测试(`isTestPath` 为假)、也不在 `scripts/gate-*/` 下,而它深层引用了某个功能
//     的内部文件 —— 一处就红,红的那行打印 `目标 ← 引用方:行`。
//   - **测试部分仍是逐功能棘轮**:只许减。某功能高于基线、或出现基线里没有的功能 → 红;低于基线 → 提示可收紧。
//     基线只记测试的处数(非测试那一半没有基线,它就是 0)。
// 永久规则一条:**进程入口不经功能入口**(`docs/design/server-client-split-2026-10.md` §4)。被构建配方或真机门当作独立进程 /
// 线程起的文件(构建配方点名的 Worker / 桥入口、`*-standalone-main.ts`、`scripts/gate-*/` 下的被测产物入口)按文件路径指它要的
// 模块 —— 它们的定义就是「不装那个功能的入口闭包」,所以 `scripts/gate-*/` 作为引用方按目录类不计(与 `__tests__` /
// client-api 同一种按类不计);反过来,**这类文件不许被任何文件 import**,有一处就红。
//
// 另两条判据(D228,2026-10-04 拆分批 1 一起落地,决策 D235 / D236;拆分批 2 清零后改零基线硬闸,D241):
//   - **功能主入口不许 `export *`**(命名规范 N3「只用具名导出、按类分组」):`<功能>/<功能>.ts` 里的
//     `export * from '…'` 一条就红。`export * as <名字> from '…'` 是一个具名的命名空间导出,不算(`settings` 入口的
//     `modelRegistry`)。批 1 停下的 media 那一条,批 2 先给四个带服务商名的名字按内容改了名,再改成具名(D240)。
//   - **功能内的非测试文件不许引自家主入口**(D126「功能内部引兄弟文件,不经入口」):`packages/backend/<功能>/` 下非测试文件的
//     说明符解析到 `<功能>/<功能>.ts` 就算一处(入口自己不算),一处就红。批 1 停下的 25 处(eval 23 / session 1 / theme 1),
//     批 2 先把测试替身改打声明那个名字的兄弟文件、再改引兄弟,清零(D241)。
//   两条都不进基线:基线里再出现 `self:` / `star:` 行(从前的只减名单)也是红 —— 名单已经撤了,留着就是陈账。
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
//   node scripts/feature-entry-gate.mjs --write-baseline 收紧测试部分的基线(只在真降之后;非测试部分不进基线)
//   node scripts/feature-entry-gate.mjs --self-test      判据自检
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { pathToFileURL } from 'node:url'
import { NON_FEATURE_DIRS, clientApiFeatureOf, configureEntryFeatureOf, isTestPath } from './lib/backend-structure.mjs'

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
  // 装配入口 `<功能>-configure.ts`(D191)同理不计:谁可以引它(只许 L4 与 apps)也由 `client-api:gate` 管。
  if (configureEntryFeatureOf(`${FEATURE_ROOT}/${feature}/${inner.replace(/\.js$/, '.ts')}`) === feature) return null
  return { feature, target: inner }
}

/** 真机门的被测产物入口目录类:`scripts/gate-<名字>/` 下的文件(由门用 esbuild 打成独立进程,与构建配方同类)。 */
export function isGateProbePath(relative) {
  return /^scripts\/gate-[^/]+\//.test(relative)
}

/**
 * 进程入口的名册(相对仓根的路径):构建配方点名的入口常量(`*_ENTRY`,读配方本身,不在这里抄一份)、
 * 名字是 `*-standalone-main.ts` 的文件、`scripts/gate-<名字>/` 下的文件。它们一律不许被 import。
 */
export async function loadProcessEntries() {
  const entries = new Set()
  const recipe = await import(pathToFileURL(path.join(root, 'apps/desktop-react/scripts/build-electron.mjs')).href)
  for (const [name, value] of Object.entries(recipe)) {
    if (/_ENTRY$/.test(name) && typeof value === 'string' && value.startsWith('packages/')) entries.add(value)
  }
  if (entries.size === 0) throw new Error('构建配方里一个 *_ENTRY 常量都没读到 —— 名册失效,不认这次结果')
  const scan = (dir) => {
    const out = []
    if (existsSync(path.join(root, dir))) walk(path.join(root, dir), out)
    return out.map((file) => path.relative(root, file))
  }
  for (const file of scan('packages')) if (/-standalone-main\.ts$/.test(file)) entries.add(file)
  for (const file of scan('scripts')) if (isGateProbePath(file)) entries.add(file)
  return entries
}

/**
 * @param {Set<string>} [processEntries] 进程入口名册(给了就顺带查「谁 import 了进程入口」)
 * @returns {{ counts: Record<string, number>, testCounts: Record<string, number>, sites: Array<{feature,target,importer,line,specifier,test}>,
 *   nonTestSites: Array<object>, processEntryImports: Array<{target,importer,line,specifier}>, scanned: number }}
 */
export function measure(processEntries = new Set()) {
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
  const testCounts = {}
  const sites = []
  const processEntryImports = []
  for (const absolute of files.sort()) {
    const importer = path.relative(root, absolute)
    const source = readFileSync(absolute, 'utf8')
    for (const { specifier, line } of collectSpecifiers(absolute, source)) {
      const resolved = resolveSpecifier(specifier, absolute, exportsMap)
      if (resolved && processEntries.has(path.relative(root, resolved)) && path.relative(root, resolved) !== importer) {
        processEntryImports.push({ target: path.relative(root, resolved), importer, line, specifier })
      }
      // 真机门的被测产物入口(`scripts/gate-*/`)按目录类不计:它是进程入口,按文件路径指模块是它的定义。
      if (isGateProbePath(importer)) continue
      const hit = classify(resolved, absolute, features)
      if (!hit) continue
      const test = isTestPath(importer)
      counts[hit.feature] = (counts[hit.feature] ?? 0) + 1
      if (test) testCounts[hit.feature] = (testCounts[hit.feature] ?? 0) + 1
      sites.push({ ...hit, importer, line, specifier, test })
    }
  }
  const { selfCounts, selfSites } = measureSelfEntryImports(files, features, exportsMap)
  const starExports = measureEntryStarExports(features)
  return { counts, testCounts, sites, nonTestSites: sites.filter((site) => !site.test), processEntryImports, selfCounts, selfSites, starExports, scanned: files.length }
}

/** 一只文件在哪个功能里、是不是那个功能的主入口(功能目录之外 / 非功能目录返回 null)。 */
export function featureOfFile(absolute, features) {
  const rel = path.relative(path.join(root, FEATURE_ROOT), absolute)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  const parts = rel.split(path.sep)
  if (parts.length < 2 || !features.has(parts[0])) return null
  return { feature: parts[0], isEntry: parts.length === 2 && parts[1] === `${parts[0]}.ts` }
}

/** 规则②:功能内非测试文件引自家主入口的处数(按功能)与逐处清单。 */
export function measureSelfEntryImports(files, features, exportsMap) {
  const selfCounts = {}
  const selfSites = []
  for (const absolute of files) {
    const importer = path.relative(root, absolute)
    if (isTestPath(importer)) continue
    const home = featureOfFile(absolute, features)
    if (!home || home.isEntry) continue
    const entry = path.join(root, FEATURE_ROOT, home.feature, `${home.feature}.ts`)
    for (const { specifier, line } of collectSpecifiers(absolute, readFileSync(absolute, 'utf8'))) {
      if (resolveSpecifier(specifier, absolute, exportsMap) !== entry) continue
      selfCounts[home.feature] = (selfCounts[home.feature] ?? 0) + 1
      selfSites.push({ feature: home.feature, importer, line, specifier })
    }
  }
  return { selfCounts, selfSites }
}

/** 一只入口文件里的 `export * from '…'`(不含 `export * as x from`):`[{ line, specifier }]`。 */
export function starExportsOf(fileName, source) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
  const out = []
  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement) && !statement.exportClause && statement.moduleSpecifier) {
      out.push({ line: file.getLineAndCharacterOfPosition(statement.getStart(file)).line + 1, specifier: statement.moduleSpecifier.text })
    }
  }
  return out
}

/** 规则①:每个功能主入口里的 `export *`。 */
export function measureEntryStarExports(features) {
  const out = []
  for (const feature of [...features].sort()) {
    const entry = path.join(root, FEATURE_ROOT, feature, `${feature}.ts`)
    if (!existsSync(entry)) continue
    for (const hit of starExportsOf(entry, readFileSync(entry, 'utf8'))) out.push({ feature, entry: path.relative(root, entry), ...hit })
  }
  return out
}

/** 从前基线里规则②的只减名单行(`self:<功能>`)。D241 起规则②是零基线硬闸,基线里再出现这种行就是陈账,判红。 */
export const SELF_PREFIX = 'self:'
/** 从前基线里规则①的只减名单行(`star:<功能>`)。D241 起同上。 */
export const STAR_PREFIX = 'star:'
export function splitBaseline(baseline) {
  const test = {}
  const self = {}
  const star = {}
  for (const [key, n] of Object.entries(baseline)) {
    if (key.startsWith(SELF_PREFIX)) self[key.slice(SELF_PREFIX.length)] = n
    else if (key.startsWith(STAR_PREFIX)) star[key.slice(STAR_PREFIX.length)] = n
    else test[key] = n
  }
  return { test, self, star }
}

/** 规则①的计数:每个功能主入口里 `export *` 的条数。 */
export function starCountsOf(starExports) {
  const counts = {}
  for (const item of starExports) counts[item.feature] = (counts[item.feature] ?? 0) + 1
  return counts
}

export function formatBaseline(counts) {
  const lines = [
    '# feature-entry ratchet baseline (docs/design/server-client-split-2026-10.md §4「功能入口」)',
    '# 每行 `<次数> <功能>`:**测试文件**从功能目录之外引用 packages/backend/<功能>/ 里入口(N3 形状的 `<功能>/<功能>.ts`)以外文件的 import 处数。',
    '# 非测试部分不进这张表 —— 它是零基线硬闸(D202 第 15 条,2026-10-04):一处非测试深层引用就红。',
    '# 测试部分只许降:任一功能高于这里的数、或出现这里没有的功能,`bun run entry:gate` 红。',
    '# 降了之后跑 `node scripts/feature-entry-gate.mjs --write-baseline` 收紧。',
  ]
  const keys = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b))
  for (const key of keys) lines.push(`${counts[key]} ${key}`)
  lines.push('# 主入口的 `export *`(规则①)与功能内引自家主入口(规则②)是零基线硬闸,不进这张表(D241)。')
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

  // 4) 非测试零基线与两类按类不计(D202 第 15 条)。
  expect('真机门的被测产物入口按目录类不计', isGateProbePath('scripts/gate-embed-runtime/entry.ts'))
  expect('门脚本本身(scripts/gate-x.mjs)不是被测产物入口', !isGateProbePath('scripts/gate-search-index.mjs'))
  expect('别的 scripts 不按类不计', !isGateProbePath('scripts/lib/search-corpus-redact.mjs'))
  expect('__tests__ 算测试', isTestPath('packages/backend/mcp/__tests__/x.test.ts'))
  expect('scripts/__tests__ 也算测试', isTestPath('scripts/__tests__/x.test.mjs'))
  expect('普通源文件不算测试', !isTestPath('packages/backend/backend.ts'))
  const verdict = judge({ nonTestSites: [], processEntryImports: [], testCounts: { search: 1 } }, { search: 2 })
  expect('非测试 0 处、测试降了 → 绿', verdict.failures.length === 0 && verdict.improvements.length === 1)
  const red = judge({ nonTestSites: [{ feature: 'mcp', target: 'x.ts', importer: 'packages/backend/backend.ts', line: 1 }], processEntryImports: [], testCounts: {} }, {})
  expect('非测试一处就红(没有基线可言)', red.failures.some((f) => f.kind === 'non-test'))
  const imported = judge({ nonTestSites: [], processEntryImports: [{ target: 'packages/backend/gateway/gateway-standalone-main.ts', importer: 'packages/backend/x.ts', line: 3 }], testCounts: {} }, {})
  expect('进程入口被 import 就红', imported.failures.some((f) => f.kind === 'process-entry'))
  const testUp = judge({ nonTestSites: [], processEntryImports: [], testCounts: { search: 3 } }, { search: 2 })
  expect('测试部分上升照旧红', testUp.failures.some((f) => f.kind === 'test-ratchet'))
  // 判一处真实的说明符:被测产物入口里的深层引用不进 sites,普通脚本的照算。
  const features2 = new Set(['search'])
  expect('被测产物入口之外的脚本深层引用照算',
    classify(R('search/kernel/search-kernel-redact.ts'), path.join(root, 'scripts/lib/x.mjs'), features2)?.feature === 'search')

  // 5) 规则①:入口里的 `export *` 一条就红;`export * as x` 不算;具名转交不算。
  const stars = starExportsOf('entry.ts', "export * from './a.js'\nexport * as ns from './b.js'\nexport { c } from './c.js'\nexport type * from './d.js'\n")
  expect('export * from 算一条(export type * 也算)', stars.length === 2 && stars[0].specifier === './a.js' && stars[1].specifier === './d.js')
  expect('export * as x 不算', !stars.some((x) => x.specifier === './b.js'))
  const starSite = { feature: 'session', entry: 'packages/backend/session/session.ts', line: 1, specifier: './a.js' }
  const starRed = judge({ nonTestSites: [], processEntryImports: [], starExports: [starSite], testCounts: {}, selfSites: [] }, { search: 1 })
  expect('入口 export * 一条就红(零基线)', starRed.failures.some((f) => f.kind === 'entry-star' && f.item === starSite))
  const starKnown = judge({ nonTestSites: [], processEntryImports: [], starExports: [starSite], testCounts: {}, selfSites: [] }, { 'star:session': 1 })
  expect('基线里写着 star 行也挡不住(名单已撤)', starKnown.failures.some((f) => f.kind === 'entry-star'))
  const starStale = judge({ nonTestSites: [], processEntryImports: [], starExports: [], testCounts: {}, selfSites: [] }, { 'star:session': 1 })
  expect('基线里留着 star 陈账行 → 红', starStale.failures.some((f) => f.kind === 'stale-baseline-row' && f.item.key === 'star:session'))
  // 6) 规则②:功能内非测试文件引自家主入口 → 只许减;入口自己与测试不算。
  const feats3 = new Set(['session', 'search'])
  expect('功能内文件归到自己的功能', featureOfFile(R('session/session-store.ts'), feats3)?.feature === 'session')
  expect('主入口自己标成入口', featureOfFile(R('session/session.ts'), feats3)?.isEntry === true)
  expect('子目录里的同名文件不是入口', featureOfFile(R('session/x/session.ts'), feats3)?.isEntry === false)
  expect('包根文件不属于功能', featureOfFile(path.join(root, BACKEND, 'backend.ts'), feats3) === null)
  const selfSite = { feature: 'eval', importer: 'packages/backend/eval/eval-client-api.ts', line: 3, specifier: '@onething/backend/eval' }
  const selfOne = judge({ nonTestSites: [], processEntryImports: [], starExports: [], testCounts: {}, selfSites: [selfSite] }, { search: 1 })
  expect('自引入口一处就红(零基线)', selfOne.failures.some((f) => f.kind === 'self-entry' && f.item === selfSite))
  const selfKnown = judge({ nonTestSites: [], processEntryImports: [], starExports: [], testCounts: {}, selfSites: [selfSite] }, { 'self:eval': 2 })
  expect('基线里写着 self 行也挡不住(名单已撤)', selfKnown.failures.some((f) => f.kind === 'self-entry'))
  const selfStale = judge({ nonTestSites: [], processEntryImports: [], starExports: [], testCounts: {}, selfSites: [] }, { 'self:eval': 2 })
  expect('基线里留着 self 陈账行 → 红', selfStale.failures.some((f) => f.kind === 'stale-baseline-row' && f.item.key === 'self:eval'))
  const clean = judge({ nonTestSites: [], processEntryImports: [], starExports: [], testCounts: { search: 1 }, selfSites: [] }, { search: 1 })
  expect('两条规则都是 0、基线只有测试行 → 绿', clean.failures.length === 0)
  const written = parseBaseline(formatBaseline({ search: 2 }))
  expect('写出的基线只有测试行', written.search === 2 && Object.keys(written).every((k) => !k.startsWith(SELF_PREFIX) && !k.startsWith(STAR_PREFIX)))

  if (failures.length > 0) {
    console.error('[feature-entry-gate] self-test FAILED:')
    for (const label of failures) console.error('  ✗', label)
    process.exit(1)
  }
  console.log('[feature-entry-gate] self-test ok — 43 checks passed')
}

/**
 * 纯判决:非测试一处就红、进程入口被 import 就红、测试部分按基线只许降。只回报,不打印、不退出。
 * @returns {{ failures: Array<{kind: 'non-test'|'process-entry'|'test-ratchet', item: object}>, improvements: Array<object> }}
 */
export function judge(measured, baseline) {
  const failures = []
  const { test: testBaseline, self: selfBaseline, star: starBaseline } = splitBaseline(baseline)
  for (const site of measured.nonTestSites) failures.push({ kind: 'non-test', item: site })
  for (const item of measured.processEntryImports) failures.push({ kind: 'process-entry', item })
  // 规则①②是零基线硬闸(D241):一处就红;基线里留着从前的只减名单行也红(陈账)。
  for (const site of measured.starExports ?? []) failures.push({ kind: 'entry-star', item: site })
  for (const site of measured.selfSites ?? []) failures.push({ kind: 'self-entry', item: site })
  for (const key of [...Object.keys(selfBaseline), ...Object.keys(starBaseline)]) {
    failures.push({ kind: 'stale-baseline-row', item: { key: key in selfBaseline ? `${SELF_PREFIX}${key}` : `${STAR_PREFIX}${key}` } })
  }
  const { regressions, improvements } = compare(testBaseline, measured.testCounts)
  for (const item of regressions) failures.push({ kind: 'test-ratchet', item })
  return { failures, improvements }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) return selfTest()

  const processEntries = await loadProcessEntries()
  const measured = measure(processEntries)
  const { counts, testCounts, sites, scanned } = measured
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
  const testTotal = Object.values(testCounts).reduce((sum, n) => sum + n, 0)

  if (scanned < MIN_SCANNED_FILES) {
    console.error(`[feature-entry-gate] 只扫到 ${scanned} 个文件(下限 ${MIN_SCANNED_FILES})—— 遍历坏了,不认这次结果。`)
    process.exit(1)
  }

  if (args.includes('--list')) {
    const only = args.filter((a) => !a.startsWith('--'))
    const verbose = args.includes('--verbose') || only.length > 0
    const keys = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b))
    console.log(`[entry] ${total} deep import site(s) into ${keys.length} feature(s) — non-test ${total - testTotal}, test ${testTotal} — ${scanned} file(s) scanned:`)
    for (const key of keys) console.log(`  ${counts[key]}\t${key}\t(test ${testCounts[key] ?? 0})`)
    if (verbose) {
      for (const key of keys) {
        if (only.length > 0 && !only.includes(key)) continue
        console.log(`\n# ${key}`)
        for (const site of sites.filter((s) => s.feature === key)) {
          console.log(`  ${site.target}\t${site.importer}:${site.line}\t${site.specifier}${site.test ? '' : '\t[non-test]'}`)
        }
      }
    }
    const selfTotal = Object.values(measured.selfCounts).reduce((sum, n) => sum + n, 0)
    console.log(`[entry] entry \`export *\`: ${measured.starExports.length}; feature-internal non-test imports of the own entry: ${selfTotal}`)
    if (verbose) for (const site of measured.selfSites) console.log(`  self\t${site.feature}\t${site.importer}:${site.line}\t${site.specifier}`)
    console.log(`[entry] process entries (must not be imported): ${processEntries.size}`)
    console.log(`[entry] complete: ${scanned} file(s) scanned`)
    return
  }

  if (args.includes('--write-baseline')) {
    writeFileSync(baselinePath, formatBaseline(testCounts), 'utf8')
    console.log(`[feature-entry-gate] baseline written → ${path.relative(root, baselinePath)} (${testTotal} test site(s))`)
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

  const { failures, improvements } = judge(measured, baseline)

  if (improvements.length > 0) {
    const n = improvements.reduce((sum, item) => sum + (item.baseline - item.current), 0)
    console.log(`[feature-entry-gate] 测试部分 ${n} 处深层引用消失了 —— 可以收紧基线(--write-baseline):`)
    for (const item of improvements) console.log(`  - ${item.key}: ${item.baseline} → ${item.current}`)
  }

  if (failures.length > 0) {
    const nonTest = failures.filter((f) => f.kind === 'non-test').map((f) => f.item)
    const imported = failures.filter((f) => f.kind === 'process-entry').map((f) => f.item)
    const ratchet = failures.filter((f) => f.kind === 'test-ratchet').map((f) => f.item)
    if (nonTest.length > 0) {
      console.error(`[feature-entry-gate] failed: 非测试深层引用 ${nonTest.length} 处(零基线硬闸,一处都不许有):`)
      for (const site of nonTest) console.error(`  ${site.feature}/${site.target}  ← ${site.importer}:${site.line}`)
    }
    if (imported.length > 0) {
      console.error(`[feature-entry-gate] failed: 进程入口被 import 了 ${imported.length} 处(进程入口不经功能入口,反过来也谁都不许引它):`)
      for (const item of imported) console.error(`  ${item.target}  ← ${item.importer}:${item.line}`)
    }
    const stars = failures.filter((f) => f.kind === 'entry-star').map((f) => f.item)
    const selfSites = failures.filter((f) => f.kind === 'self-entry').map((f) => f.item)
    const stale = failures.filter((f) => f.kind === 'stale-baseline-row').map((f) => f.item)
    if (stars.length > 0) {
      console.error(`[feature-entry-gate] failed: 功能主入口里有 ${stars.length} 条 \`export *\`(零基线硬闸;入口只用具名导出、按类分组,只交外面真用的,N3):`)
      for (const site of stars) console.error(`  ${site.entry}:${site.line}  export * from '${site.specifier}'`)
    }
    if (selfSites.length > 0) {
      console.error(`[feature-entry-gate] failed: 功能里的非测试文件引了自家主入口 ${selfSites.length} 处(零基线硬闸;D126:功能内部引兄弟文件,不经入口):`)
      for (const site of selfSites) console.error(`  ${site.feature}  ${site.importer}:${site.line}  ${site.specifier}`)
    }
    if (stale.length > 0) {
      console.error(`[feature-entry-gate] failed: 基线里还留着 ${stale.length} 行从前的只减名单(规则①②已改零基线,D241),删掉:`)
      for (const item of stale) console.error(`  ${item.key}`)
    }
    if (ratchet.length > 0) {
      console.error(`[feature-entry-gate] failed: ${ratchet.length} 个功能的测试深层引用上升:`)
      for (const item of ratchet) {
        const note = item.isNew ? '(基线里没有这个功能)' : ''
        console.error(`  + ${item.key}: ${item.baseline} → ${item.current} ${note}`)
        for (const site of sites.filter((s) => s.feature === item.key && s.test).slice(0, 20)) {
          console.error(`      ${site.target}  ← ${site.importer}:${site.line}`)
        }
      }
    }
    console.error('  规矩见 docs/design/server-client-split-2026-10.md §4「功能入口」:')
    console.error('  外面要用的名字从 `@onething/backend/<功能>` 拿;入口没有的,先想清楚它该不该交出去,再加进入口。')
    process.exit(1)
  }

  console.log(
    `[feature-entry-gate] ok — non-test 0 (hard gate), entry \`export *\` 0 (hard gate), own-entry import sites inside features 0 (hard gate),`
    + ` ${testTotal} known test deep import site(s) across ${Object.keys(testCounts).length} feature row(s),`
    + ` ${processEntries.size} process entr(ies) imported by nobody, ${scanned} file(s) scanned, none new`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
