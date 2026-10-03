// 三道结构门(name:gate / cycle:gate / layer:gate)判据的纯函数用例。真仓上的读数由门自己跑,这里只钉判据。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  BARREL, compareCounts, entryFeatureOf, formatCountBaseline, layerViolations, loadLayerTable, parseCountBaseline,
  shortestCycleThrough, stronglyConnected,
} from '../lib/backend-structure.mjs'
import { findEntryCycles } from '../feature-cycle-gate.mjs'
import { duplicateNames } from '../file-name-gate.mjs'

const RT = 'packages/backend/runtime'
const graphOf = (pairs) => {
  const edges = new Map()
  for (const [a, b] of pairs) {
    if (!edges.has(a)) edges.set(a, new Set())
    if (!edges.has(b)) edges.set(b, new Set())
    edges.get(a).add(b)
  }
  return { files: [...edges.keys()].sort(), edges }
}

let root
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-structure-gates-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

it('finds strongly connected components and the shortest cycle through a node', () => {
  const { edges } = graphOf([['a', 'b'], ['b', 'c'], ['c', 'a'], ['c', 'd'], ['d', 'e'], ['e', 'd'], ['x', 'a']])
  expect(stronglyConnected(edges)).toEqual([['a', 'b', 'c'], ['d', 'e']])
  expect(shortestCycleThrough(edges, 'a')).toEqual(['a', 'b', 'c', 'a'])
  expect(shortestCycleThrough(edges, 'x')).toBeNull()
})

it('reds a cycle only when it contains a feature entry or the barrel', () => {
  const entry = `${RT}/foo/index.ts`
  const { edges } = graphOf([
    [entry, `${RT}/foo/a.ts`], [`${RT}/foo/a.ts`, `${RT}/bar/index.ts`], [`${RT}/bar/index.ts`, entry], // 经入口的环
    [`${RT}/baz/x.ts`, `${RT}/baz/y.ts`], [`${RT}/baz/y.ts`, `${RT}/baz/x.ts`], // 功能内部的深层环
  ])
  const isEntry = (f) => entryFeatureOf(f) !== null || f === `${RT}/index.ts`
  const { offending, deep } = findEntryCycles(edges, isEntry)
  expect(offending).toHaveLength(1)
  expect(offending[0].entries.map((e) => e.entry)).toEqual([`${RT}/bar/index.ts`, entry])
  expect(offending[0].entries[1].cycle).toEqual([entry, `${RT}/foo/a.ts`, `${RT}/bar/index.ts`, entry])
  expect(deep).toEqual([[`${RT}/baz/x.ts`, `${RT}/baz/y.ts`]])
  expect(entryFeatureOf(`${RT}/foo/sub/index.ts`)).toBeNull()
})

it('counts duplicate file names and ratchets each name down only', () => {
  const dup = duplicateNames(['p/a/index.ts', 'p/b/index.ts', 'p/a/types.ts', 'p/only.ts'])
  expect([...dup.keys()]).toEqual(['index.ts'])
  expect(compareCounts({ 'index.ts': 2 }, { 'index.ts': 3 }).regressions[0]).toMatchObject({ key: 'index.ts', current: 3 })
  expect(compareCounts({ 'index.ts': 2 }, { 'index.ts': 2, 'types.ts': 2 }).regressions[0]).toMatchObject({ key: 'types.ts', isNew: true })
  expect(compareCounts({ 'index.ts': 3 }, { 'index.ts': 1 }).improvements).toHaveLength(1)
  const text = formatCountBaseline(['header'], { 'index.ts': 98, 'providers → settings': 12 })
  expect(parseCountBaseline(text)).toEqual({ 'index.ts': 98, 'providers → settings': 12 })
})

function writeTable(table) {
  fs.mkdirSync(path.join(root, 'docs/audit'), { recursive: true })
  fs.writeFileSync(path.join(root, 'docs/audit/feature-layers-2026-10.json'), JSON.stringify(table))
}
const baseTable = (features) => ({
  layers: [{ id: 'L0', name: '基础件', meaning: '' }, { id: 'L1', name: '事实', meaning: '' }, { id: 'L4', name: '对外', meaning: '' }],
  features,
  slots: [
    { slot: '(包根槽位)', layer: 'L0', match: ['packages/backend/current.ts'], why: '' },
    { slot: '(包根)', layer: 'L4', fallback: true, why: '' },
    { slot: BARREL, layer: 'L4', why: '' },
  ],
})

it('judges upward edges by the layer table and reds an unregistered feature', () => {
  writeTable(baseTable([{ feature: 'storage', layer: 'L0', why: '' }, { feature: 'providers', layer: 'L1', why: '' }]))
  const table = loadLayerTable(root)
  expect(table.groupOf('packages/backend/current.ts')).toBe('(包根槽位)')
  expect(table.groupOf('packages/backend/backend.ts')).toBe('(包根)')
  expect(table.groupOf(`${RT}/index.ts`)).toBe(BARREL)
  const graph = graphOf([
    [`${RT}/providers/a.ts`, `${RT}/storage/index.ts`], // 高引低:合法
    [`${RT}/storage/x.ts`, `${RT}/providers/index.ts`], // 低引高:违例
    [`${RT}/storage/x.ts`, 'packages/backend/backend.ts'], // 低引包根:违例
    ['packages/backend/current.ts', `${RT}/storage/index.ts`], // 同层:不判
  ])
  const result = layerViolations(graph, table)
  expect([...result.violations.keys()].sort()).toEqual(['storage → (包根)', 'storage → providers'])
  expect(result.unregistered).toEqual([])
  const withStranger = graphOf([[`${RT}/stranger/a.ts`, `${RT}/storage/index.ts`]])
  expect(layerViolations(withStranger, table).unregistered).toEqual(['stranger'])
})
