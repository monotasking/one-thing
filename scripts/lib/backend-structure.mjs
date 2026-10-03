// 后端结构门共用的几样东西:运行期值引用图、强连通分量、最短环、功能归属、「次数 名字」基线的读写与比较。
//
// 使用者:`scripts/feature-cycle-gate.mjs`(入口无环,D19)、`scripts/feature-layer-gate.mjs`(层次,D23)、
// `scripts/feature-map.mjs`(功能地图,R4)、`scripts/file-name-gate.mjs`(文件名重复,N1,只用基线那几只)。
// 决策正本:`docs/design/backend-structure-decisions-2026-10.md`。
//
// 值引用图的口径与 Fable 的模拟器(s15 `sim.mjs --real`)逐条一致,三批数据已经和真代码对上,所以这里照搬,不另起口径:
//   - 节点 = `packages/backend` 与 `packages/shared` 下 `tsconfig.node.json` 收进来的非测试 `.ts` 文件
//     (`__tests__/`、`*.test.*`、`__fixtures__/`、`testing/` 都算测试)。
//   - 边 = 一条顶层 `import … from` / `import '…'` / `export … from` 语句,且它至少带进来一个**值**:
//     副作用 import、命名空间 import、`export *` 整只算;具名的逐个用类型检查器解析到声明,只引接口 / 类型别名的名字、
//     `import type` / `export type`、`import { type X }` 都不成边(编译后被擦掉)。
//   - 动态 `import()`、`require`、类型位置的 `import('…')` 都不成边:它们不在加载期求值,不会造成加载期的环。
//   - 说明符解析:相对路径按磁盘(`.js` → `.ts`、补 `/index.ts`);`@onething/backend/<子路径>` 按
//     `packages/backend/package.json` 的 exports 精确键;`@shared/<路径>` 按 `packages/shared`;其余(npm 包)不算。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const BACKEND = 'packages/backend'
/**
 * 功能目录的根。2026-10-04(路线第 6 项,机械改名 6a)去掉了 `runtime/` 这一层,功能目录直接住在包根下,
 * 所以它与 `BACKEND` 相同;包根下哪些目录**不是**功能,见 `NON_FEATURE_DIRS`。
 */
export const FEATURE_ROOT = BACKEND
/** 包根下不是功能的目录:包级测试、界面连进来的 HTTP 服务器(层次表里是槽位)、依赖。其余目录都是功能。 */
export const NON_FEATURE_DIRS = new Set(['__tests__', 'http-server', 'node_modules'])
export const SHARED = 'packages/shared'

/** 按 UTF-16 码元比较:不随机器的区域设置变,生成文件在本机与 CI 上才逐字节相同。 */
export const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

export const isTestPath = (relative) => /__tests__|\.test\.|__fixtures__|\/testing\//.test(relative)

/**
 * 功能入口:过渡期的老形状 `<功能>/index.ts`,或命名规范 N3 的形状 `<功能>/<功能>.ts`
 * (2026-10-04 凭证功能起用;路线第 6 项入口改名(6b)之后只剩后一种)。目录里有 `index.ts` 时入口就是它 ——
 * 今天 `scheduler/scheduler.ts` 是 scheduler 的一只内部文件,入口仍是 `scheduler/index.ts`。
 */
export function entryFeatureOf(relative, root = repoRoot) {
  const match = /^packages\/backend\/([^/]+)\/([^/]+)\.ts$/.exec(relative)
  if (!match || NON_FEATURE_DIRS.has(match[1])) return null
  if (match[2] === 'index') return match[1]
  if (match[2] !== match[1]) return null
  return fs.existsSync(path.join(root, FEATURE_ROOT, match[1], 'index.ts')) ? null : match[1]
}

/**
 * 功能的**第二个入口**(决策 D26):`<功能>/<功能>-client-api.ts` 或 `<功能>/<功能>-client-api-<方面>.ts`
 * —— 这个功能开给界面(经 HTTP 服务器)的东西:名册里的域行、只有 HTTP 服务器用的投影与投递件。
 * 判据只看路径:必须直接住在功能目录下、以自己的功能名打头,测试不算。是就返回功能名,否则 null。
 * 使用者:`client-api:gate`(谁可以引它)、`entry:gate`(引它不算深层)、`layer:gate`(它站 L4)、`transport:gate`(扫描范围)。
 */
export const CLIENT_API_PATTERN = /^packages\/backend\/([^/]+)\/([^/]+)-client-api(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.ts$/
export function clientApiFeatureOf(relative) {
  const match = CLIENT_API_PATTERN.exec(relative)
  if (!match || NON_FEATURE_DIRS.has(match[1])) return null
  return match[1] === match[2] || LEGACY_FILE_PREFIX[match[1]] === match[2] ? match[1] : null
}

/**
 * 过渡表(机械改名 6a,2026-10-04):这一笔只把复数名的功能目录改成单数(命名规范 N5),**文件名不动**,
 * 所以单数目录里的文件仍以旧的复数名打头(`session/sessions-client-api.ts`)。「以自己的功能名打头」这条判据在过渡期
 * 认两种前缀:目录名本身,或这张表里它的旧名。下一笔 6b 给文件名加功能前缀时这些文件改成单数前缀,这张表随之删掉。
 */
export const LEGACY_FILE_PREFIX = Object.freeze({
  agent: 'agents', eval: 'evals', event: 'events', 'external-agent': 'external-agents', file: 'files', goal: 'goals',
  note: 'notes', permission: 'permissions', pet: 'pets', plugin: 'plugins', 'project-dir': 'project-dirs',
  prompt: 'prompts', provider: 'providers', reference: 'references', session: 'sessions', skill: 'skills',
  space: 'spaces', task: 'tasks', theme: 'themes', tool: 'tools', trigger: 'triggers', variable: 'variables',
})

/** 某个功能的入口文件(仓库相对路径):有 `<功能>/index.ts` 就是它;没有、但有 `<功能>/<功能>.ts`,就是后者。 */
export function entryFileOf(feature, root = repoRoot) {
  const index = `${FEATURE_ROOT}/${feature}/index.ts`
  const named = `${FEATURE_ROOT}/${feature}/${feature}.ts`
  return !fs.existsSync(path.join(root, index)) && fs.existsSync(path.join(root, named)) ? named : index
}
/** 功能名:`packages/backend/<功能>/…` → `<功能>`;其余(包根散文件、非功能目录、shared)→ null。(总桶 2026-10-04 删掉。) */
export function runtimeFeatureOf(relative) {
  if (!relative.startsWith(`${FEATURE_ROOT}/`)) return null
  const rest = relative.slice(FEATURE_ROOT.length + 1)
  if (!rest.includes('/')) return null
  const first = rest.split('/')[0]
  return NON_FEATURE_DIRS.has(first) ? null : first
}

const isFile = (p) => fs.existsSync(p) && fs.statSync(p).isFile()
function toFile(absolute) {
  const stripped = absolute.replace(/\.(js|mjs|ts)$/, '')
  for (const candidate of [`${stripped}.ts`, `${stripped}.tsx`, absolute, `${stripped}/index.ts`, `${absolute}/index.ts`]) {
    if (isFile(candidate) && /\.tsx?$/.test(candidate)) return candidate
  }
  return null
}

/**
 * 建 HEAD 的运行期值引用图。
 * @returns {{ files: string[], edges: Map<string, Set<string>>, program: ts.Program, checker: ts.TypeChecker, root: string }}
 *   `files` / `edges` 里全是仓库相对路径(正斜杠)。
 */
export function buildValueGraph(root = repoRoot) {
  const config = ts.parseJsonConfigFileContent(
    ts.readConfigFile(path.join(root, 'tsconfig.node.json'), ts.sys.readFile).config, ts.sys, root,
  )
  const inScope = (f) => (f.startsWith(`${root}/${BACKEND}/`) || f.startsWith(`${root}/${SHARED}/`))
    && !f.includes('/node_modules/') && !isTestPath(f) && /\.tsx?$/.test(f) && !f.endsWith('.d.ts')
  const exportsMap = JSON.parse(fs.readFileSync(path.join(root, BACKEND, 'package.json'), 'utf8')).exports ?? {}
  const resolve = (specifier, from) => {
    if (specifier.startsWith('.')) return toFile(path.resolve(path.dirname(from), specifier))
    if (specifier === '@onething/backend' || specifier.startsWith('@onething/backend/')) {
      const target = exportsMap[`.${specifier.slice('@onething/backend'.length)}`]
      return target ? path.resolve(root, BACKEND, target) : null
    }
    if (specifier.startsWith('@onething/client')) return null
    if (specifier.startsWith('@shared/')) return toFile(path.resolve(root, SHARED, specifier.slice('@shared/'.length)))
    return undefined
  }
  const options = { ...config.options, noEmit: true, composite: false }
  const host = ts.createCompilerHost(options)
  host.resolveModuleNames = (names, containing) => names.map((name) => {
    const hit = resolve(name, containing)
    if (hit) return { resolvedFileName: hit, extension: hit.endsWith('.tsx') ? ts.Extension.Tsx : ts.Extension.Ts, isExternalLibraryImport: false }
    if (hit === null) return undefined
    return ts.resolveModuleName(name, containing, config.options, ts.sys).resolvedModule
  })
  const program = ts.createProgram(config.fileNames.filter(inScope), options, host)
  const checker = program.getTypeChecker()
  const sources = program.getSourceFiles().filter((sf) => inScope(path.resolve(sf.fileName)))
  const rel = (f) => path.relative(root, f).split(path.sep).join('/')

  const aliased = (symbol) => {
    let s = symbol
    while (s && (s.flags & ts.SymbolFlags.Alias)) {
      const next = checker.getAliasedSymbol(s)
      if (next === s) break
      s = next
    }
    return s
  }
  /** 这个名字落到一个值上吗?落到就返回它的声明所在文件,否则 null。 */
  const valueFileOf = (symbol) => {
    const s = aliased(symbol)
    if (!s || !(s.flags & ts.SymbolFlags.Value)) return null
    const decl = s.valueDeclaration ?? s.declarations?.find((d) => !ts.isInterfaceDeclaration(d) && !ts.isTypeAliasDeclaration(d))
    return decl ? path.resolve(decl.getSourceFile().fileName) : null
  }

  const edges = new Map()
  for (const sf of sources) edges.set(rel(path.resolve(sf.fileName)), new Set())
  for (const sf of sources) {
    const from = path.resolve(sf.fileName)
    const fromRel = rel(from)
    for (const st of sf.statements) {
      const isImport = ts.isImportDeclaration(st)
      if (!(isImport || (ts.isExportDeclaration(st) && st.moduleSpecifier))) continue
      if (isImport ? st.importClause?.isTypeOnly : st.isTypeOnly) continue
      const resolved = resolve(st.moduleSpecifier.text, from)
      if (!resolved) continue
      const target = path.resolve(resolved)
      if (!inScope(target)) continue
      let carriesValue = false
      if (isImport) {
        const clause = st.importClause
        if (!clause) carriesValue = true // 副作用 import
        else {
          if (clause.name && valueFileOf(checker.getSymbolAtLocation(clause.name))) carriesValue = true
          const bindings = clause.namedBindings
          if (bindings && ts.isNamespaceImport(bindings)) carriesValue = true
          else if (bindings) {
            for (const element of bindings.elements) {
              if (element.isTypeOnly) continue
              const file = valueFileOf(checker.getSymbolAtLocation(element.name))
              if (file && inScope(file)) carriesValue = true
            }
          }
        }
      } else if (!st.exportClause || ts.isNamespaceExport(st.exportClause)) carriesValue = true // export * / export * as ns
      else {
        for (const element of st.exportClause.elements) {
          if (element.isTypeOnly) continue
          const file = valueFileOf(checker.getSymbolAtLocation(element.name))
          if (file && inScope(file)) carriesValue = true
        }
      }
      if (carriesValue && target !== from) edges.get(fromRel).add(rel(target))
    }
  }
  return { files: [...edges.keys()].sort(), edges, program, checker, root }
}

/** 一只入口文件交出的名字数:`{ total, values, types }`(按类型检查器的模块导出表,含再导出)。 */
export function countModuleExports(graph, relative) {
  const sf = graph.program.getSourceFile(path.join(graph.root, relative))
  if (!sf) return null
  const symbol = graph.checker.getSymbolAtLocation(sf)
  if (!symbol) return { total: 0, values: 0, types: 0 }
  let values = 0
  let types = 0
  for (const exported of graph.checker.getExportsOfModule(symbol)) {
    let s = exported
    while (s && (s.flags & ts.SymbolFlags.Alias)) {
      const next = graph.checker.getAliasedSymbol(s)
      if (next === s) break
      s = next
    }
    if (s && (s.flags & ts.SymbolFlags.Value)) values += 1
    else types += 1
  }
  return { total: values + types, values, types }
}

/** Tarjan(迭代版,不怕深递归)。返回大小 > 1 的强连通分量,每个是排好序的节点数组,按大小降序。 */
export function stronglyConnected(edges) {
  let counter = 0
  const index = new Map()
  const low = new Map()
  const onStack = new Set()
  const stack = []
  const components = []
  for (const start of edges.keys()) {
    if (index.has(start)) continue
    const work = [[start, [...(edges.get(start) ?? [])], 0]]
    index.set(start, counter); low.set(start, counter); counter += 1; stack.push(start); onStack.add(start)
    while (work.length) {
      const top = work[work.length - 1]
      const [node, next] = top
      if (top[2] < next.length) {
        const w = next[top[2]++]
        if (!edges.has(w)) continue
        if (!index.has(w)) {
          index.set(w, counter); low.set(w, counter); counter += 1; stack.push(w); onStack.add(w)
          work.push([w, [...(edges.get(w) ?? [])], 0])
        } else if (onStack.has(w)) low.set(node, Math.min(low.get(node), index.get(w)))
      } else {
        work.pop()
        if (work.length) { const parent = work[work.length - 1][0]; low.set(parent, Math.min(low.get(parent), low.get(node))) }
        if (low.get(node) === index.get(node)) {
          const members = []
          let w
          do { w = stack.pop(); onStack.delete(w); members.push(w) } while (w !== node)
          if (members.length > 1) components.push(members.sort())
        }
      }
    }
  }
  return components.sort((a, b) => b.length - a.length || byCodeUnit(a[0], b[0]))
}

/** 经过 `node` 的最短环(广度优先,邻居按字典序走,结果稳定);没有环返回 null。返回 `[node, …, node]`。 */
export function shortestCycleThrough(edges, node) {
  const previous = new Map()
  const queue = []
  for (const w of [...(edges.get(node) ?? [])].sort()) {
    if (!previous.has(w)) { previous.set(w, node); queue.push(w) }
  }
  while (queue.length) {
    const current = queue.shift()
    if (current === node) break
    for (const w of [...(edges.get(current) ?? [])].sort()) {
      if (!previous.has(w)) { previous.set(w, current); queue.push(w) }
    }
  }
  if (!previous.has(node)) return null
  const chain = [node]
  let at = previous.get(node)
  while (at !== node) { chain.unshift(at); at = previous.get(at) }
  chain.unshift(node)
  return chain
}

// ── 「次数 名字」基线(name:gate 与 layer:gate 共用;形状同 entry:gate)

export function parseCountBaseline(text) {
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

export function formatCountBaseline(headerLines, counts) {
  const keys = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || byCodeUnit(a, b))
  return `${[...headerLines.map((line) => `# ${line}`), ...keys.map((key) => `${counts[key]} ${key}`)].join('\n')}\n`
}

/** 只减不增的比较:高于基线或基线里没有 = regression;低于基线 = improvement。 */
export function compareCounts(baseline, current) {
  const regressions = []
  const improvements = []
  for (const [key, n] of Object.entries(current)) {
    const base = baseline[key] ?? 0
    if (n > base) regressions.push({ key, baseline: base, current: n, isNew: !(key in baseline) })
  }
  for (const [key, base] of Object.entries(baseline)) {
    const n = current[key] ?? 0
    if (n < base) improvements.push({ key, baseline: base, current: n })
  }
  return { regressions, improvements }
}

// ── 层次表(`docs/audit/feature-layers-2026-10.json`)

export const LAYER_TABLE = 'docs/audit/feature-layers-2026-10.json'

/**
 * 读层次表,返回:
 *   - `layers`:按从低到高排好的 `{ id, name, meaning }`;
 *   - `rankOf(feature)`:层次序号(0 起),没登记返回 undefined;
 *   - `groupOf(relative)`:一只文件归哪一行(功能名或槽位名);功能目录里的文件归功能,其余按槽位前缀、最后落兜底;
 *   - `rows`:功能行与槽位行,`{ name, layer, why, kind: 'feature' | 'slot' }`。
 */
export function loadLayerTable(root = repoRoot) {
  const table = JSON.parse(fs.readFileSync(path.join(root, LAYER_TABLE), 'utf8'))
  const layers = table.layers
  const rank = new Map(layers.map((layer, i) => [layer.id, i]))
  const rows = []
  const rankByName = new Map()
  const register = (name, layer, why, kind) => {
    if (!rank.has(layer)) throw new Error(`层次表:「${name}」的层次 ${layer} 不在 layers 里`)
    if (rankByName.has(name)) throw new Error(`层次表:「${name}」登记了两次`)
    rankByName.set(name, rank.get(layer))
    rows.push({ name, layer, why, kind })
  }
  for (const row of table.features) register(row.feature, row.layer, row.why, 'feature')
  for (const row of table.slots) register(row.slot, row.layer, row.why, 'slot')
  // 槽位按文件归属:先看功能目录,再按槽位的路径前缀(长的先;以 `/` 结尾的是目录),
  // 最后落到兜底槽位(`"fallback": true` 的那一行,只许一行)。
  const prefixed = table.slots.filter((slot) => slot.match?.length)
    .flatMap((slot) => slot.match.map((prefix) => [prefix, slot.slot]))
    .sort((a, b) => b[0].length - a[0].length)
  const fallbacks = table.slots.filter((slot) => slot.fallback)
  if (fallbacks.length !== 1) throw new Error(`层次表:兜底槽位(fallback)应恰好一行,现在 ${fallbacks.length} 行`)
  const fallback = fallbacks[0].slot
  // 第二入口槽位(`"secondEntry": true`,只许一行):`<功能>-client-api*.ts` 归它,不归所属功能(D26)。
  const secondEntries = table.slots.filter((slot) => slot.secondEntry)
  if (secondEntries.length > 1) throw new Error(`层次表:第二入口槽位(secondEntry)最多一行,现在 ${secondEntries.length} 行`)
  const secondEntry = secondEntries[0]?.slot
  const groupOf = (relative) => {
    if (secondEntry && clientApiFeatureOf(relative)) return secondEntry
    const feature = runtimeFeatureOf(relative)
    if (feature) return feature
    for (const [prefix, slot] of prefixed) if (relative === prefix || (prefix.endsWith('/') && relative.startsWith(prefix))) return slot
    return fallback
  }
  return { layers, rows, rankOf: (name) => rankByName.get(name), groupOf, layerOf: (name) => rows.find((r) => r.name === name)?.layer }
}

/** 跨行(功能 / 槽位)的值边:`Map<"from → to", string[]>`(每条是「文件 → 文件」;功能目录里的文件去掉 `packages/backend/` 前缀,其余写全路径)。 */
export function crossGroupEdges(graph, groupOf) {
  const pairs = new Map()
  const short = (f) => (runtimeFeatureOf(f) ? f.slice(FEATURE_ROOT.length + 1) : f)
  for (const [from, targets] of graph.edges) {
    const a = groupOf(from)
    for (const to of targets) {
      const b = groupOf(to)
      if (a === b) continue
      const key = `${a} → ${b}`
      if (!pairs.has(key)) pairs.set(key, [])
      pairs.get(key).push(`${short(from)} → ${short(to)}`)
    }
  }
  for (const list of pairs.values()) list.sort()
  return pairs
}

/** 低层引高层的边:`Map<"from → to", string[]>`,外加没登记的行名。 */
export function layerViolations(graph, table) {
  const pairs = crossGroupEdges(graph, table.groupOf)
  const violations = new Map()
  const unregistered = new Set()
  let crossEdges = 0
  for (const [key, list] of pairs) {
    const [a, b] = key.split(' → ')
    crossEdges += list.length
    const ra = table.rankOf(a)
    const rb = table.rankOf(b)
    if (ra === undefined) unregistered.add(a)
    if (rb === undefined) unregistered.add(b)
    if (ra === undefined || rb === undefined) continue
    if (ra < rb) violations.set(key, list)
  }
  // 没有任何跨边的功能也要登记:按目录再扫一遍。
  for (const file of graph.files) { const g = table.groupOf(file); if (table.rankOf(g) === undefined) unregistered.add(g) }
  return { violations, unregistered: [...unregistered].sort(), crossEdges }
}
