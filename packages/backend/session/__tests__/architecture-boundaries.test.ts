import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '../../../..')
const selected = [
  'session/index.ts', 'session/commands.ts', 'session/event-layer.ts',
  'session/event-writer.ts', 'session/event-surface.ts', 'session/prepare.ts',
  'session/projection-cache.ts', 'session/events-reads.ts', 'session/reads.ts',
  'stores/sessions.ts',
].map(file => path.join(root, 'packages/backend', file))

function runtimeGraph(): Map<string, string[]> {
  const config = ts.readConfigFile(path.join(root, 'tsconfig.node.json'), ts.sys.readFile)
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options
  const graph = new Map<string, string[]>()
  function visit(file: string): void {
    file = fs.realpathSync(file)
    if (graph.has(file) || !file.startsWith(path.join(root, 'packages') + path.sep)
      || file.includes('/__tests__/') || file.endsWith('.d.ts')) return
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const dependencies: string[] = []
    graph.set(file, dependencies)
    const add = (specifier: string): void => {
      const resolved = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule?.resolvedFileName
      if (!resolved) return
      const dependency = fs.realpathSync(resolved)
      dependencies.push(dependency)
      visit(dependency)
    }
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause
        if (clause?.isTypeOnly) continue
        if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
          && clause.namedBindings.elements.length > 0
          && clause.namedBindings.elements.every(element => element.isTypeOnly)) continue
        if (ts.isStringLiteral(statement.moduleSpecifier)) add(statement.moduleSpecifier.text)
      } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && !statement.isTypeOnly) {
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)
          && statement.exportClause.elements.length > 0
          && statement.exportClause.elements.every(element => element.isTypeOnly)) continue
        if (ts.isStringLiteral(statement.moduleSpecifier)) add(statement.moduleSpecifier.text)
      }
    }
    const dynamicImports = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) add(node.arguments[0].text)
      ts.forEachChild(node, dynamicImports)
    }
    dynamicImports(source)
  }
  selected.forEach(visit)
  return graph
}

describe('session assembly dependencies', () => {
  it('has no direct or transitive runtime cycle through a migrated module', () => {
    const graph = runtimeGraph()
    for (const origin of selected) {
      expect(graph.has(origin)).toBe(true)
      const visited = new Set<string>()
      const queue = (graph.get(origin) ?? []).map(next => [origin, next])
      while (queue.length) {
        const chain = queue.shift()!
        const next = chain[chain.length - 1]
        expect(next, chain.map(file => path.relative(root, file)).join(' → ')).not.toBe(origin)
        if (visited.has(next)) continue
        visited.add(next)
        for (const dependency of graph.get(next) ?? []) queue.push([...chain, dependency])
      }
    }
  })
})
