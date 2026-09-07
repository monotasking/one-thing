import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const privateSessionFiles = new Set([
  'commands.ts', 'event-log.ts', 'event-layer.ts', 'event-writer.ts', 'event-surface.ts',
  'prepare.ts', 'projection-cache.ts', 'events-reads.ts', 'reads.ts', 'writable.ts', 'deletion.ts',
])
const within = (file, directory) => file.startsWith(directory + path.sep)
const isTest = file => /(?:^|[/\\])(?:__tests__|fixtures)(?:[/\\]|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)

function sourceFiles(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) return ['node_modules', 'dist', 'dist-strict', 'out'].includes(entry.name) ? [] : sourceFiles(file)
    return /\.[cm]?tsx?$/.test(entry.name) && !isTest(file) ? [file] : []
  })
}

export function dependencyReferences(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const references = []
  const add = (node, typeOnly) => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      references.push({ specifier: node.text, kind: typeOnly ? 'type' : 'runtime', line: source.getLineAndCharacterOfPosition(node.pos).line + 1 })
    }
  }
  const visit = node => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      const names = clause?.namedBindings
      add(node.moduleSpecifier, clause?.isTypeOnly || (!clause?.name && names && ts.isNamedImports(names)
        && names.elements.length > 0 && names.elements.every(element => element.isTypeOnly)))
    } else if (ts.isExportDeclaration(node)) {
      const names = node.exportClause
      add(node.moduleSpecifier, node.isTypeOnly || (names && ts.isNamedExports(names)
        && names.elements.length > 0 && names.elements.every(element => element.isTypeOnly)))
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal, true)
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      add(node.arguments[0], false)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return references
}

/** Keep broad response-shape checks scoped to the handler they describe. */
export function objectMethodBody(file, text, objectName, methodName) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  let body
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === objectName
      && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      for (const member of node.initializer.properties) {
        if (!member.name || member.name.getText(source) !== methodName) continue
        if (ts.isMethodDeclaration(member)) body = member.body
        else if (ts.isPropertyAssignment(member) && (ts.isArrowFunction(member.initializer)
          || ts.isFunctionExpression(member.initializer))) body = member.initializer.body
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!body) throw new Error(`${file}: missing ${objectName}.${methodName} handler`)
  return '\n'.repeat(source.getLineAndCharacterOfPosition(body.pos).line) + body.getText(source)
}

/** Resolve real aliases and package exports; type edges are checked as well as executable edges. */
export function checkBackendPublicBoundaries({ root, files, compilerOptions }) {
  root = fs.realpathSync(path.resolve(root))
  const backend = path.join(root, 'packages/backend')
  const shared = path.join(root, 'packages/shared')
  const runtime = path.join(root, 'packages/onething-runtime')
  const manifest = JSON.parse(fs.readFileSync(path.join(backend, 'package.json'), 'utf8'))
  const exports = manifest.exports ?? {}
  if (!compilerOptions) {
    const file = path.join(root, 'tsconfig.node.json')
    const config = ts.readConfigFile(file, ts.sys.readFile)
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
    compilerOptions = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options
  }
  const violations = []
  const counts = { type: 0, runtime: 0 }
  const privateFile = file => path.dirname(file) === path.join(backend, 'session') && privateSessionFiles.has(path.basename(file))
  // 「wildcard export 一律违规」那条规则**已删**(工单 4 D3)。它与 CLAUDE.md 的
  // Alias Registry 正面顶撞:`@onething/backend` 的 exports 里那两条兜底
  // (`"./*.js"` / `"./*"`)与 runtime 的家族通配 (`"./x/*"`) 是这套解析方式的
  // 地基 —— 加一个子路径就是加一条 exports 键,而不是加一条 alias。禁掉通配等于
  // 要求每一个子路径手写一条,那是另一套结构,不是这套结构里的一条规则。
  // 「内部会话模块不许开口」由下面那条按文件判的规则守着,它是真正要守的东西。
  for (const [key, value] of Object.entries(exports)) {
    if (typeof value === 'string' && privateFile(path.resolve(backend, value))) {
      violations.push(`packages/backend/package.json: ${key} exposes a migrated internal session module`)
    }
  }
  const cache = ts.createModuleResolutionCache(root, file => file, compilerOptions)
  for (const sourceFile of files ?? ['packages', 'apps', 'scripts'].flatMap(dir => sourceFiles(path.join(root, dir)))) {
    const file = fs.realpathSync(sourceFile)
    if (isTest(file)) continue
    for (const reference of dependencyReferences(file, fs.readFileSync(file, 'utf8'))) {
      counts[reference.kind]++
      const { specifier } = reference
      const label = `${path.relative(root, file)}:${reference.line}: ${reference.kind} ${specifier}`
      if (specifier.startsWith('@onething/backend/')) {
        const key = './' + specifier.slice('@onething/backend/'.length)
        if (!(key in exports)) violations.push(`${label}: backend subpath is not public`)
      }
      const resolved = ts.resolveModuleName(specifier, file, compilerOptions, ts.sys, cache).resolvedModule?.resolvedFileName
      const target = resolved && fs.realpathSync(resolved)
      if (within(file, shared) && (specifier.startsWith('@onething/runtime') || specifier.startsWith('@onething/backend')
        || (target && (within(target, runtime) || within(target, backend))))) {
        violations.push(`${label}: shared contracts depend on a product/backend implementation`)
      }
      if (!within(file, backend) && target && privateFile(target)) {
        violations.push(`${label}: relative or aliased import bypasses the public Backend boundary`)
      }
    }
  }
  return { violations, counts }
}
