#!/usr/bin/env node
// 补充分析：巨环成因、wiring 域清单、shared 反向依赖、动态 import 全表
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = '/Users/yitiansong/data/code/start-electron'
const HERE = path.dirname(new URL(import.meta.url).pathname)

// 复用主脚本：把它改造成可导入太麻烦，这里直接重跑一遍轻量版逻辑
const src = fs.readFileSync(path.join(HERE, 'import-graph.mjs'), 'utf8')
// 截取到 "// ---------- 扫描" 之前的定义 + 扫描循环，替换掉报告部分
const cut = src.indexOf('const out = []')
const lib = src.slice(0, cut)
const modPath = path.join(HERE, '_lib.mjs')
fs.writeFileSync(modPath, lib + '\nexport { files, edges, dynamicSites, lineCounts, exportCounts, scopeOf, rel, ROOT, fileSet }\n')
const L = await import(pathToFileURL(modPath).href)
const { files, edges, scopeOf, rel } = L

const idx = new Map(); files.forEach((f, i) => idx.set(f, i))
const isBarrel = (f) => /\/index\.[cm]?tsx?$/.test(f)

// --- A. 巨环：去掉 barrel 节点后还剩多少环 ---
function tarjanOn(nodesFilter) {
  const keep = files.map((f, i) => nodesFilter(f))
  const g = files.map(() => [])
  for (const e of edges) {
    const a = idx.get(e.from), b = idx.get(e.to)
    if (a === undefined || b === undefined || a === b) continue
    if (!keep[a] || !keep[b]) continue
    g[a].push(b)
  }
  const n = g.length, index = new Int32Array(n).fill(-1), low = new Int32Array(n), on = new Uint8Array(n)
  const st = []; let c = 0; const comps = []
  for (let s = 0; s < n; s++) {
    if (!keep[s] || index[s] !== -1) continue
    const work = [[s, 0]]
    while (work.length) {
      const t = work[work.length - 1], v = t[0]
      if (t[1] === 0) { index[v] = low[v] = c++; st.push(v); on[v] = 1 }
      let rec = false
      while (t[1] < g[v].length) {
        const w = g[v][t[1]++]
        if (index[w] === -1) { work.push([w, 0]); rec = true; break }
        else if (on[w]) low[v] = Math.min(low[v], index[w])
      }
      if (rec) continue
      if (low[v] === index[v]) { const comp = []; while (1) { const w = st.pop(); on[w] = 0; comp.push(w); if (w === v) break } comps.push(comp) }
      work.pop()
      if (work.length) { const p = work[work.length - 1][0]; low[p] = Math.min(low[p], low[v]) }
    }
  }
  return comps.filter(x => x.length >= 2).sort((a, b) => b.length - a.length)
}
const all = tarjanOn(() => true)
const noBarrel = tarjanOn(f => !isBarrel(f))
console.log('## A. barrel 对环的贡献')
console.log(`  含 barrel: SCC>=2 ${all.length} 个, 最大 ${all[0].length}, 环内文件 ${all.reduce((s,c)=>s+c.length,0)}`)
console.log(`  移除所有 index.ts 节点后: SCC>=2 ${noBarrel.length} 个, 最大 ${noBarrel.length?noBarrel[0].length:0}, 环内文件 ${noBarrel.reduce((s,c)=>s+c.length,0)}`)
const big = all[0]
console.log(`  最大环 166 中 barrel 数: ${big.filter(v => isBarrel(files[v])).length}`)
// 最大环里各 scope+domain 分布
{
  const m = new Map()
  for (const v of big) {
    const f = files[v]; const r = rel(f)
    const d = r.replace('packages/onething-runtime/src/', 'runtime/').replace('packages/shared/', 'shared/').split('/').slice(0, 2).join('/')
    m.set(d, (m.get(d) || 0) + 1)
  }
  console.log('  最大环成员按目录:', [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '))
}
// 找一条最短具体环（BFS 回边）示例：从 shared/events/envelope.ts 出发
function shortestCycleFrom(startAbs) {
  const s = idx.get(startAbs); if (s === undefined) return null
  const adj = files.map(() => [])
  const emap = new Map()
  for (const e of edges) { const a = idx.get(e.from), b = idx.get(e.to); if (a === undefined || b === undefined || a === b) continue; adj[a].push(b); if (!emap.has(a + '>' + b)) emap.set(a + '>' + b, e) }
  const prev = new Map(); const q = [s]; prev.set(s, null)
  while (q.length) {
    const v = q.shift()
    for (const w of adj[v]) {
      if (w === s) { const p = [v]; let x = v; while (prev.get(x) !== null && prev.get(x) !== undefined) { x = prev.get(x); p.push(x) } p.reverse(); p.push(s); return p.map((n, i) => ({ n, e: i < p.length - 1 ? emap.get(p[i] + '>' + p[i + 1]) : null })) }
      if (!prev.has(w)) { prev.set(w, v); q.push(w) }
    }
  }
  return null
}
for (const startRel of ['packages/shared/events/envelope.ts', 'packages/onething-runtime/src/themes/resolver.ts', 'packages/backend/session/commands.ts', 'packages/core/permission/index.ts']) {
  const cyc = shortestCycleFrom(path.join(ROOT, startRel))
  console.log(`\n  最短环示例 起点 ${startRel}: ${cyc ? cyc.length - 1 + ' 跳' : '无'}`)
  if (cyc) for (const step of cyc) { if (step.e) console.log(`     ${rel(files[step.n])}:${step.e.line}  --'${step.e.spec}'-->  ${rel(step.e.to)}`) }
}

// --- B. wiring 域清单 ---
console.log('\n## B. packages/backend/wiring 域清单')
const wdir = path.join(ROOT, 'packages/backend/wiring')
const doms = fs.readdirSync(wdir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()
console.log(`  共 ${doms.length} 个: ${doms.join(' ')}`)
const CLAUDEMD = 'acp agent-loop agents auth collab deeplink external-agents goals headless interaction logging markdown music permission plugins project-dirs providers scheduler search skills tasks toc todo-plan toolkit tools usage variables voice'.split(' ')
console.log(`  CLAUDE.md 记 ${CLAUDEMD.length} 个; 文档未列出的新域: ${doms.filter(d => !CLAUDEMD.includes(d)).join(' ') || '(无)'}`)
console.log(`  文档列出但已不存在: ${CLAUDEMD.filter(d => !doms.includes(d)).join(' ') || '(无)'}`)

// --- C. shared -> core / runtime 的边 ---
console.log('\n## C. packages/shared 反向依赖 core/runtime 的边')
for (const target of ['core', 'runtime']) {
  const es = edges.filter(e => scopeOf(e.from) === 'shared' && scopeOf(e.to) === target)
  console.log(`  shared -> ${target}: ${es.length} 边, 涉及 ${new Set(es.map(e => e.from)).size} 个 shared 文件`)
  const byFrom = new Map()
  for (const e of es) { if (!byFrom.has(e.from)) byFrom.set(e.from, []); byFrom.get(e.from).push(e) }
  for (const [f, l] of [...byFrom.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`    ${rel(f)}  (${l.length}) e.g. :${l[0].line} ${l[0].spec}`)
  }
}

// --- D. backend 动态 import 全表 ---
console.log('\n## D. backend 动态 import 全表 (47 处)')
const byFile = new Map()
for (const d of L.dynamicSites.filter(d => scopeOf(d.file) === 'backend')) {
  const k = rel(d.file); if (!byFile.has(k)) byFile.set(k, []); byFile.get(k).push(d)
}
for (const [f, l] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${String(l.length).padStart(2)}  ${f}   -> ${[...new Set(l.map(x => x.spec))].join(', ')}`)
  console.log(`        行: ${l.map(x => x.line).join(',')}`)
}

// --- E. electron -> backend 的入口面 ---
console.log('\n## E. electron -> backend 目标 top15 (被 electron 直接吃的 backend 面)')
{
  const m = new Map()
  for (const e of edges.filter(e => scopeOf(e.from) === 'electron' && scopeOf(e.to) === 'backend')) {
    const k = rel(e.to); m.set(k, (m.get(k) || 0) + 1)
  }
  for (const [k, v] of [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(v).padStart(3)}  ${k}`)
}

// --- F. rpc/index.ts 与 backend.ts 的脊柱->wiring 具体证据 ---
console.log('\n## F. 脊柱->wiring 的具体 file:line (backend.ts 与 rpc/domains 前若干)')
for (const f of [path.join(ROOT, 'packages/backend/backend.ts'), path.join(ROOT, 'packages/backend/server/runtime.ts'), path.join(ROOT, 'packages/backend/session/commands.ts')]) {
  const es = edges.filter(e => e.from === f && rel(e.to).startsWith('packages/backend/wiring/'))
  console.log(`  ${rel(f)}: ${es.length} 条 -> wiring`)
  for (const e of es.slice(0, 8)) console.log(`      :${e.line}  ${e.spec}`)
}
// session 目录 -> wiring
{
  const es = edges.filter(e => rel(e.from).startsWith('packages/backend/session/') && rel(e.to).startsWith('packages/backend/wiring/'))
  const m = new Map(); for (const e of es) { const k = rel(e.from); if (!m.has(k)) m.set(k, []); m.get(k).push(e) }
  console.log(`\n  backend/session/* -> wiring: ${es.length} 条`)
  for (const [k, l] of [...m.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8)) console.log(`      ${String(l.length).padStart(2)} ${k}  e.g. :${l[0].line} ${l[0].spec}`)
}
fs.unlinkSync(modPath)
