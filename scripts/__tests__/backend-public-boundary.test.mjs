import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import ts from 'typescript'
import { checkBackendPublicBoundaries, dependencyReferences, objectMethodBody } from '../lib/backend-public-boundary.mjs'

const roots = []
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-public-'))
  roots.push(root)
  const write = (name, text) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file }
  write('packages/backend/package.json', JSON.stringify({ exports: { '.': './backend.ts' } }))
  write('packages/backend/backend.ts', 'export const api = true')
  write('packages/backend/session/commands.ts', 'export const command = true')
  write('packages/onething-runtime/src/model.ts', 'export interface Model {}')
  const options = { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, baseUrl: root,
    paths: { '@hidden/*': ['packages/backend/session/*'], '@product/*': ['packages/onething-runtime/src/*'] } }
  return { root, write, check: files => checkBackendPublicBoundaries({ root, files, compilerOptions: options }) }
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

it('scopes branch response checks without ignoring new-session validation or missing handlers', () => {
  const text = `export const handlers = {
    create() { return { success: false, error: 'Invalid id' } },
    async createBranch() { return delegate() },
  }`
  expect(objectMethodBody('rpc.ts', text, 'handlers', 'createBranch')).not.toContain('Invalid id')
  expect(objectMethodBody('rpc.ts', text.replace('return delegate()', "return { success: false, error: 'Branch failed' }"), 'handlers', 'createBranch')).toContain('Branch failed')
  expect(() => objectMethodBody('rpc.ts', 'const handlers = {}', 'handlers', 'createBranch')).toThrow('missing')
})

it('distinguishes erased type references from executable imports and literal dynamic loading', () => {
  const refs = dependencyReferences('example.ts', `
    import type { A } from './a.js'; export { type B } from './b.js';
    type C = import('./c.js').C; import { type D, run } from './d.js';
    import('./e.js'); require('./f.js');
  `)
  expect(refs.map(({ specifier, kind }) => [specifier, kind])).toEqual([
    ['./a.js', 'type'], ['./b.js', 'type'], ['./c.js', 'type'],
    ['./d.js', 'runtime'], ['./e.js', 'runtime'], ['./f.js', 'runtime'],
  ])
})

it('blocks shared type and dynamic reverse edges even through relative paths and aliases', () => {
  const { write, check } = fixture()
  const source = write('packages/shared/contracts.ts', `
    export type { Model } from '@product/model.js';
    import('../onething-runtime/src/model.js');
  `)
  const result = check([source])
  expect(result.violations).toHaveLength(2)
  expect(result.counts).toEqual({ type: 1, runtime: 1 })
})

it('blocks private external aliases and relative paths while allowing same-package assembly', () => {
  const { write, check } = fixture()
  const host = write('apps/example/main.ts', `import '@hidden/commands.js'; import '../../packages/backend/session/commands.js'`)
  const assembly = write('packages/backend/assembly.ts', `import './session/commands.js'`)
  expect(check([host, assembly]).violations).toHaveLength(2)
})

it('rejects renamed exports of internal modules and unexported named imports, but tolerates the wildcard', () => {
  // 工单 4 D3:「wildcard export 一律违规」那条已删 —— `@onething/backend` 的
  // exports 兜底通配是 Alias Registry 的地基(加子路径 = 加一条 exports 键)。
  // 剩下的两条才是真要守的:改名开口一个内部会话模块 / 越过 exports 直取内部路径。
  const { write, check } = fixture()
  write('packages/backend/package.json', JSON.stringify({ exports: { './*': './*.ts', './new-name': './session/commands.ts' } }))
  const host = write('apps/example/main.ts', `import '@onething/backend/secret.js'`)
  expect(check([host]).violations).toHaveLength(2)
})
