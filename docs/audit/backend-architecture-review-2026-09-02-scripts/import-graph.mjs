#!/usr/bin/env node
// onething 只读 import 图分析器。用法: node import-graph.mjs > report.txt
import fs from 'node:fs'
import path from 'node:path'

const ROOT = '/Users/yitiansong/data/code/start-electron'

const SCOPES = [
  ['core', 'packages/core'],
  ['runtime', 'packages/onething-runtime/src'],
  ['backend', 'packages/backend'],
  ['shared', 'packages/shared'],
  ['electron', 'apps/electron/src'],
  ['server', 'apps/server/src'],
]

const EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs'])
const files = []
const fileSet = new Set()

function isExcluded(p) {
  if (p.includes('/__tests__/') || p.includes('/__mocks__/') || p.includes('/__fixtures__/')) return true
  if (/\.(test|spec)\.[cm]?tsx?$/.test(p)) return true
  if (p.includes('/node_modules/') || p.includes('/dist/') || p.includes('/out/')) return true
  return false
}
function walk(dir) {
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (['node_modules', '__tests__', '__mocks__', '__fixtures__'].includes(e.name)) continue
      walk(full)
    } else if (EXT.has(path.extname(e.name)) && !isExcluded(full)) {
      files.push(full); fileSet.add(full)
    }
  }
}
for (const [, rel] of SCOPES) walk(path.join(ROOT, rel))

function scopeOf(abs) {
  for (const [name, rel] of SCOPES) if (abs.startsWith(path.join(ROOT, rel) + path.sep)) return name
  return null
}
const rel = (p) => path.relative(ROOT, p)

// ---------- package exports ----------
function loadPkg(d) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, d, 'package.json'), 'utf8')) } catch { return null } }
const PKGS = {
  '@onething/core': { dir: 'packages/core', pkg: loadPkg('packages/core') },
  '@onething/runtime': { dir: 'packages/onething-runtime', pkg: loadPkg('packages/onething-runtime') },
  '@onething/backend': { dir: 'packages/backend', pkg: loadPkg('packages/backend') },
  '@onething/gateway': { dir: 'packages/gateway', pkg: loadPkg('packages/gateway') },
}
function flat(v) {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object') for (const k of ['import', 'default', 'node', 'require', 'types']) { if (v[k]) { const r = flat(v[k]); if (r) return r } }
  return null
}
function resolveExports(pkgName, sub) {
  const e = PKGS[pkgName]; if (!e || !e.pkg || !e.pkg.exports) return null
  const exp = e.pkg.exports
  const key = sub === '' ? '.' : './' + sub
  if (typeof exp === 'string') return path.join(ROOT, e.dir, exp)
  if (exp[key] !== undefined) { const t = flat(exp[key]); if (t) return path.join(ROOT, e.dir, t) }
  let best = null
  for (const k of Object.keys(exp)) {
    if (!k.includes('*')) continue
    const [pre, post] = k.split('*')
    if (key.startsWith(pre) && key.endsWith(post) && key.length >= pre.length + post.length) {
      if (!best || pre.length > best.pre.length) best = { k, pre, post }
    }
  }
  if (best) {
    const star = key.slice(best.pre.length, key.length - best.post.length)
    const t = flat(exp[best.k]); if (t) return path.join(ROOT, e.dir, t.replace('*', star))
  }
  return null
}
function tryFile(p) {
  const c = []
  if (/\.[cm]?js$/.test(p)) c.push(p.replace(/\.([cm]?)js$/, '.$1ts'), p.replace(/\.([cm]?)js$/, '.$1tsx'))
  c.push(p)
  for (const e of ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs']) c.push(p + e)
  for (const e of ['/index.ts', '/index.tsx', '/index.js', '/index.mts']) c.push(p + e)
  for (const x of c) { if (fileSet.has(x)) return x; try { if (fs.statSync(x).isFile()) return x } catch {} }
  return null
}
function resolveSpec(spec, from) {
  if (spec.startsWith('.')) return tryFile(path.resolve(path.dirname(from), spec))
  if (spec === '@shared') return tryFile(path.join(ROOT, 'packages/shared/index'))
  if (spec.startsWith('@shared/')) return tryFile(path.join(ROOT, 'packages/shared', spec.slice(8)))
  if (spec.startsWith('@main/')) return tryFile(path.join(ROOT, 'apps/electron/src/main', spec.slice(6)))
  if (spec.startsWith('@preload/')) return tryFile(path.join(ROOT, 'apps/electron/src/preload', spec.slice(9)))
  if (spec === '@onething/electron-host/window') return tryFile(path.join(ROOT, 'apps/electron/src/window/index'))
  if (spec.startsWith('@onething/electron-host/')) return tryFile(path.join(ROOT, 'apps/electron/src', spec.slice(24)))
  if (spec.startsWith('@renderer/')) return tryFile(path.join(ROOT, 'packages/renderer', spec.slice(10)))
  if (spec.startsWith('@/')) return tryFile(path.join(ROOT, 'packages/renderer', spec.slice(2)))
  for (const name of Object.keys(PKGS)) {
    if (spec === name || spec.startsWith(name + '/')) {
      const sub = spec === name ? '' : spec.slice(name.length + 1)
      const t = resolveExports(name, sub)
      if (t) { const f = tryFile(t); if (f) return f }
      const base = name === '@onething/runtime' ? path.join(ROOT, PKGS[name].dir, 'src') : path.join(ROOT, PKGS[name].dir)
      const f2 = tryFile(path.join(base, sub || 'index'))
      if (f2) return f2
      return { unresolved: spec }
    }
  }
  return null
}

// ---------- 扫描 ----------
const RE_FROM = /\bfrom\s*['"]([^'"]+)['"]/g
const RE_BARE = /^[ \t]*import\s*['"]([^'"]+)['"]/gm
const RE_DYN = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const RE_DYN_ANY = /(?<![.\w$])import\s*\(/g

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
            .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

const edges = []
const unresolved = []
const dynamicSites = []
const dynAnyCount = new Map()
const exportCounts = new Map()
const lineCounts = new Map()

for (const f of files) {
  let raw; try { raw = fs.readFileSync(f, 'utf8') } catch { continue }
  const src = stripComments(raw)
  const rawLines = raw.split('\n')
  lineCounts.set(f, rawLines.filter((l) => l.trim()).length)
  const em = src.match(/^[ \t]*export\s+(?:default\s+|\*|\{|(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum|abstract)\b)/gm)
  exportCounts.set(f, em ? em.length : 0)

  const lineIdx = []
  { let n = 1; for (let i = 0; i < src.length; i++) { lineIdx[i] = n; if (src[i] === '\n') n++ } }
  const lineOf = (i) => lineIdx[i] || 1

  const seen = new Set()
  const collect = (re, dynamic) => {
    re.lastIndex = 0; let m
    while ((m = re.exec(src))) {
      const spec = m[1]; const line = lineOf(m.index)
      const key = spec + '@' + line + '@' + dynamic
      if (seen.has(key)) continue; seen.add(key)
      const r = resolveSpec(spec, f)
      if (dynamic) dynamicSites.push({ file: f, line, spec, resolved: typeof r === 'string' ? r : null, ctx: (rawLines[line - 2] || '').trim().slice(0, 110) })
      if (typeof r === 'string') edges.push({ from: f, to: r, spec, line, dynamic })
      else if (r && r.unresolved) unresolved.push({ from: f, spec, line })
    }
  }
  collect(RE_FROM, false); collect(RE_BARE, false); collect(RE_DYN, true)
  RE_DYN_ANY.lastIndex = 0; let c = 0, dm
  while ((dm = RE_DYN_ANY.exec(src))) c++
  if (c) dynAnyCount.set(f, c)
}

const out = []
const P = (...a) => out.push(a.join(' '))

P(`# 文件数: ${files.length}  边数(解析成功): ${edges.length}  未解析包内说明符: ${unresolved.length}`)
for (const [n, r] of SCOPES) P(`  ${n.padEnd(9)} ${files.filter(f => scopeOf(f) === n).length} files  (${r})`)

// ===== 1. 层间边计数 =====
P('\n## 1. 层间边计数 (源 scope -> 目标 scope, 去重按 file-pair? 否: 按 import 语句计)')
const pair = new Map()
const pairFilePairs = new Map()
for (const e of edges) {
  const a = scopeOf(e.from), b = scopeOf(e.to)
  if (!a || !b) continue
  const k = a + ' -> ' + b
  pair.set(k, (pair.get(k) || 0) + 1)
  if (!pairFilePairs.has(k)) pairFilePairs.set(k, new Set())
  pairFilePairs.get(k).add(e.from + '|' + e.to)
}
const names = SCOPES.map(s => s[0])
P('        ' + names.map(n => n.padStart(9)).join(''))
for (const a of names) {
  P(a.padEnd(8) + names.map(b => String(pair.get(a + ' -> ' + b) || 0).padStart(9)).join(''))
}
P('\n(同上，唯一 file-pair 计数)')
P('        ' + names.map(n => n.padStart(9)).join(''))
for (const a of names) {
  P(a.padEnd(8) + names.map(b => String((pairFilePairs.get(a + ' -> ' + b) || new Set()).size).padStart(9)).join(''))
}

const listEdges = (a, b) => edges.filter(e => scopeOf(e.from) === a && scopeOf(e.to) === b)
P('\n### 关键断言')
for (const [a, b] of [['runtime', 'backend'], ['core', 'runtime'], ['core', 'backend'], ['core', 'shared'], ['core', 'electron'], ['backend', 'electron'], ['runtime', 'electron'], ['shared', 'backend'], ['shared', 'runtime'], ['shared', 'core']]) {
  const l = listEdges(a, b)
  P(`  ${(a + ' -> ' + b).padEnd(22)} ${String(l.length).padStart(4)}` + (l.length && l.length <= 12 ? '   ' + l.map(e => `${rel(e.from)}:${e.line} [${e.spec}]`).join(' ; ') : ''))
}

P('\n### apps/electron 直接 import runtime/core (绕过 backend) — 按文件聚合')
const bypass = edges.filter(e => scopeOf(e.from) === 'electron' && (scopeOf(e.to) === 'runtime' || scopeOf(e.to) === 'core'))
const byFile = new Map()
for (const e of bypass) {
  if (!byFile.has(e.from)) byFile.set(e.from, [])
  byFile.get(e.from).push(e)
}
P(`  总边数 ${bypass.length} (-> runtime ${bypass.filter(e => scopeOf(e.to) === 'runtime').length}, -> core ${bypass.filter(e => scopeOf(e.to) === 'core').length}) ，涉及 ${byFile.size} 个 electron 文件`)
const top20 = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 20)
for (const [f, es] of top20) {
  P(`  ${String(es.length).padStart(3)}  ${rel(f)}`)
  P(`        e.g. :${es[0].line} ${es[0].spec}` + (es[1] ? ` ; :${es[1].line} ${es[1].spec}` : ''))
}

// ===== 2. backend 脊柱 vs wiring =====
P('\n## 2. backend 脊柱 vs wiring')
const BE = path.join(ROOT, 'packages/backend')
const isBackend = (f) => f.startsWith(BE + path.sep)
const isWiring = (f) => f.startsWith(path.join(BE, 'wiring') + path.sep)
const isSpine = (f) => isBackend(f) && !isWiring(f)
const wiringDomain = (f) => isWiring(f) ? path.relative(path.join(BE, 'wiring'), f).split(path.sep)[0] : null
const spineTop = (f) => { const r = path.relative(BE, f); const parts = r.split(path.sep); return parts.length === 1 ? '(root)/' + parts[0] : parts[0] }

const beEdges = edges.filter(e => isBackend(e.from) && isBackend(e.to))
const s2w = beEdges.filter(e => isSpine(e.from) && isWiring(e.to))
const w2s = beEdges.filter(e => isWiring(e.from) && isSpine(e.to))
const w2w = beEdges.filter(e => isWiring(e.from) && isWiring(e.to) && wiringDomain(e.from) !== wiringDomain(e.to))
const w2wSame = beEdges.filter(e => isWiring(e.from) && isWiring(e.to) && wiringDomain(e.from) === wiringDomain(e.to))
const s2s = beEdges.filter(e => isSpine(e.from) && isSpine(e.to))
P(`  backend 内部边 ${beEdges.length}:  脊柱->wiring ${s2w.length} | wiring->脊柱 ${w2s.length} | wiring 跨域 ${w2w.length} | wiring 同域 ${w2wSame.length} | 脊柱->脊柱 ${s2s.length}`)
P(`  脊柱文件 ${files.filter(isSpine).length} 个, wiring 文件 ${files.filter(isWiring).length} 个, wiring 域 ${new Set(files.filter(isWiring).map(wiringDomain)).size} 个`)

P('\n### 脊柱文件 import wiring 最多的前 15')
const spineByFile = new Map()
for (const e of s2w) { if (!spineByFile.has(e.from)) spineByFile.set(e.from, []); spineByFile.get(e.from).push(e) }
for (const [f, es] of [...spineByFile.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 15)) {
  P(`  ${String(es.length).padStart(3)}  ${rel(f)}`)
  const doms = [...new Set(es.map(e => wiringDomain(e.to)))].sort()
  P(`        -> wiring 域: ${doms.join(', ')}`)
}
P('\n### 脊柱 -> wiring 按脊柱顶层目录聚合')
{
  const m = new Map()
  for (const e of s2w) { const k = spineTop(e.from); m.set(k, (m.get(k) || 0) + 1) }
  for (const [k, v] of [...m.entries()].sort((a, b) => b[1] - a[1])) P(`  ${String(v).padStart(4)}  ${k}`)
}
P('\n### wiring -> 脊柱 按脊柱顶层目录聚合 (被依赖方)')
{
  const m = new Map()
  for (const e of w2s) { const k = spineTop(e.to); m.set(k, (m.get(k) || 0) + 1) }
  for (const [k, v] of [...m.entries()].sort((a, b) => b[1] - a[1])) P(`  ${String(v).padStart(4)}  ${k}`)
}
P('\n### wiring 跨域矩阵 (只列非零, 源域 -> 目标域: 边数)')
{
  const m = new Map()
  for (const e of w2w) { const k = wiringDomain(e.from) + ' -> ' + wiringDomain(e.to); m.set(k, (m.get(k) || 0) + 1) }
  for (const [k, v] of [...m.entries()].sort((a, b) => b[1] - a[1])) P(`  ${String(v).padStart(3)}  ${k}`)
}

// ===== 3. SCC =====
P('\n## 3. 循环依赖 (Tarjan SCC, 全图含静态+动态边)')
const idx = new Map(); files.forEach((f, i) => idx.set(f, i))
const adj = files.map(() => [])
const adjStatic = files.map(() => [])
for (const e of edges) {
  const a = idx.get(e.from), b = idx.get(e.to)
  if (a === undefined || b === undefined || a === b) continue
  adj[a].push(b)
  if (!e.dynamic) adjStatic[a].push(b)
}
function tarjan(g) {
  const n = g.length
  const index = new Int32Array(n).fill(-1), low = new Int32Array(n), onstack = new Uint8Array(n)
  const stack = []; let counter = 0; const comps = []
  for (let s = 0; s < n; s++) {
    if (index[s] !== -1) continue
    const work = [[s, 0]]
    while (work.length) {
      const top = work[work.length - 1]
      const v = top[0]
      if (top[1] === 0) { index[v] = low[v] = counter++; stack.push(v); onstack[v] = 1 }
      let recursed = false
      while (top[1] < g[v].length) {
        const w = g[v][top[1]++]
        if (index[w] === -1) { work.push([w, 0]); recursed = true; break }
        else if (onstack[w]) low[v] = Math.min(low[v], index[w])
      }
      if (recursed) continue
      if (low[v] === index[v]) {
        const comp = []
        while (true) { const w = stack.pop(); onstack[w] = 0; comp.push(w); if (w === v) break }
        comps.push(comp)
      }
      work.pop()
      if (work.length) { const p = work[work.length - 1][0]; low[p] = Math.min(low[p], low[v]) }
    }
  }
  return comps
}
for (const [label, g] of [['全部边(含动态 import)', adj], ['仅静态边', adjStatic]]) {
  const comps = tarjan(g).filter(c => c.length >= 2).sort((a, b) => b.length - a.length)
  const inCycle = comps.reduce((s, c) => s + c.length, 0)
  // 自环
  const selfLoops = edges.filter(e => e.from === e.to).length
  P(`\n### ${label}: SCC(size>=2) ${comps.length} 个, 落在环里的文件 ${inCycle} / ${files.length} (${(inCycle / files.length * 100).toFixed(1)}%), 自引用边 ${selfLoops}`)
  comps.slice(0, 10).forEach((c, i) => {
    const scopes = {}
    c.forEach(v => { const s = scopeOf(files[v]) || '?'; scopes[s] = (scopes[s] || 0) + 1 })
    P(`  SCC#${i + 1} size=${c.length}  scope分布: ${Object.entries(scopes).map(([k, v]) => k + ':' + v).join(' ')}`)
    const show = c.slice(0, c.length > 24 ? 24 : c.length)
    show.forEach(v => P(`      ${rel(files[v])}`))
    if (c.length > show.length) P(`      ... 还有 ${c.length - show.length} 个`)
  })
}

// ===== 4. 上帝文件 =====
P('\n## 4. 上帝文件 (非空行数 top25)')
P('   lines exports  file')
for (const f of [...files].sort((a, b) => lineCounts.get(b) - lineCounts.get(a)).slice(0, 25)) {
  P(`  ${String(lineCounts.get(f)).padStart(5)} ${String(exportCounts.get(f)).padStart(6)}   ${rel(f)}`)
}

// ===== 5. 扇入/扇出 =====
P('\n## 5. 扇入 / 扇出')
const fanIn = new Map(), fanOut = new Map()
for (const e of edges) {
  if (e.from === e.to) continue
  if (!fanIn.has(e.to)) fanIn.set(e.to, new Set()); fanIn.get(e.to).add(e.from)
  if (!fanOut.has(e.from)) fanOut.set(e.from, new Set()); fanOut.get(e.from).add(e.to)
}
const isBarrel = (f) => /\/index\.[cm]?tsx?$/.test(f)
P('\n### 扇入 top20 (被多少文件 import)')
for (const [f, s] of [...fanIn.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 20)) {
  P(`  ${String(s.size).padStart(4)} ${isBarrel(f) ? 'BARREL' : '      '}  ${rel(f)}  (${lineCounts.get(f) ?? '?'} 行)`)
}
P('\n### 扇出 top20 (import 了多少文件)')
for (const [f, s] of [...fanOut.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 20)) {
  P(`  ${String(s.size).padStart(4)} ${isBarrel(f) ? 'BARREL' : '      '}  ${rel(f)}  (${lineCounts.get(f) ?? '?'} 行)`)
}

// ===== 6. *.wiring.ts =====
P('\n## 6. runtime 里的 *.wiring.ts')
const wiringFiles = files.filter(f => /\.wiring\.[cm]?tsx?$/.test(f))
const rtWiring = wiringFiles.filter(f => scopeOf(f) === 'runtime')
P(`  runtime 内 ${rtWiring.length} 个 (全仓 ${wiringFiles.length} 个)`)
let violations = 0
for (const f of rtWiring.sort()) {
  const importers = [...new Set(edges.filter(e => e.to === f && e.from !== f).map(e => e.from))]
  const bad = importers.filter(i => {
    const s = scopeOf(i)
    if (s === 'backend' || s === 'electron' || s === 'server') return false
    if (/\.wiring\.[cm]?tsx?$/.test(i)) return false
    return true
  })
  violations += bad.length
  const tag = bad.length ? ' ***违例 ' + bad.length : ''
  P(`  ${rel(f)}  importers=${importers.length}${tag}`)
  const groups = {}
  for (const i of importers) { const s = (scopeOf(i) || '?') + (/\.wiring\./.test(i) ? '(wiring)' : ''); groups[s] = (groups[s] || 0) + 1 }
  if (importers.length) P(`      来源: ${Object.entries(groups).map(([k, v]) => k + ':' + v).join(', ')}`)
  for (const b of bad) P(`      !! ${rel(b)}`)
}
P(`  违例总数: ${violations}`)

// ===== 7. 动态 import =====
P('\n## 7. 动态 import')
for (const sc of ['backend', 'runtime']) {
  const sites = dynamicSites.filter(d => scopeOf(d.file) === sc)
  const anyTotal = [...dynAnyCount.entries()].filter(([f]) => scopeOf(f) === sc).reduce((s, [, v]) => s + v, 0)
  P(`\n### ${sc}: 字面量 import('...') ${sites.length} 处; import( 总出现数(含变量表达式) ${anyTotal}`)
  for (const d of sites.slice(0, 15)) {
    P(`  ${rel(d.file)}:${d.line}  import('${d.spec}')`)
    if (d.ctx && /\/\/|\*/.test(d.ctx)) P(`      上一行注释: ${d.ctx}`)
  }
}

// 未解析
P('\n## 附: 未能解析的包内说明符 (top20)')
{
  const m = new Map()
  for (const u of unresolved) m.set(u.spec, (m.get(u.spec) || 0) + 1)
  for (const [k, v] of [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) P(`  ${String(v).padStart(3)}  ${k}`)
}

console.log(out.join('\n'))
