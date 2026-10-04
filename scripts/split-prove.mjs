#!/usr/bin/env node
// 拆分零变化的证明(决策 D225 / D226,`docs/design/oversized-files-2026-10.md` §1.4)。
//
// 为什么:大文件拆分的第一批是纯搬家 —— 每个函数、类型、常量一字不改,只换住处。全量测试能说明「没测到的地方没坏」,
// 但说明不了「没改」;这只脚本直接比源文本:拆分前那只文件(从 git 里取)与拆出来的几只文件(从工作树取),
// 各自抽出每条顶层声明的源文本,断言两边是同一个多重集。满足它 = 每个声明一字未改、只是搬了家。
//
// 口径:
//   - 顶层语句里除了 `import` 都算一条声明:函数、类、接口、类型别名、枚举、变量语句,以及 `export … from` / `export { … }`。
//   - 每条的文本 = 从它的第一个记号到最后一个记号(不含前面的注释 —— 新文件的文件头与分节注释不参与比较;
//     声明内部的注释照比);去掉开头的 `export` / `export default` 修饰(搬家时私有的 helper 加了 `export` 给兄弟用,这不算改);
//     连续空白压成一个空格。
//   - 两边逐条计数比较:旧的有、新的没有 = 丢了或改了;新的有、旧的没有 = 新写的或改了。都为空才算过。
// 批 2 / 3 不能满足它(闭包变量变成了上下文对象、类方法变成了协作件),它们靠测试与真机门。
//
// 用法:
//   node scripts/split-prove.mjs <拆前路径>[@<git 版本,缺省 HEAD>] <拆后文件…>
//     例:node scripts/split-prove.mjs packages/backend/theme/theme-resolver.ts packages/backend/theme/theme-*.ts
//   拆前路径可以与某只拆后文件同名(保留原名的那一只):拆前一律从 git 取,拆后一律从工作树取。
//   node scripts/split-prove.mjs --self-test   判据自检
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 一只文件的顶层声明:`[{ name, text }]`,text 已按口径归一。 */
export function declarationTexts(fileName, source) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const out = []
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) continue
    let start = statement.getStart(file)
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : []
    for (const modifier of modifiers) {
      if (modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword) {
        // 只剥最前面连着的 export / default;装饰器之类出现在它们前面时不动(本仓没有)。
        if (modifier.getStart(file) === start) start = skipTrivia(source, modifier.end)
      }
    }
    const text = source.slice(start, statement.end).replace(/\s+/g, ' ').trim()
    out.push({ name: nameOf(statement), text })
  }
  return out
}

function skipTrivia(source, pos) {
  return ts.skipTrivia(source, pos)
}

function nameOf(statement) {
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.map((d) => d.name.getText()).join(',')
  if (ts.isExportDeclaration(statement)) return `export…${statement.moduleSpecifier ? ` from ${statement.moduleSpecifier.getText()}` : ''}`
  return statement.name?.getText() ?? ts.SyntaxKind[statement.kind]
}

/** 纯比较:两组声明的多重集差。 */
export function compareDeclarations(before, after) {
  const count = (list) => {
    const map = new Map()
    for (const item of list) {
      const entry = map.get(item.text) ?? { n: 0, name: item.name }
      entry.n += 1
      map.set(item.text, entry)
    }
    return map
  }
  const a = count(before)
  const b = count(after)
  const missing = []
  const extra = []
  for (const [text, { n, name }] of a) {
    const m = b.get(text)?.n ?? 0
    for (let i = m; i < n; i++) missing.push({ name, text })
  }
  for (const [text, { n, name }] of b) {
    const m = a.get(text)?.n ?? 0
    for (let i = m; i < n; i++) extra.push({ name, text })
  }
  return { missing, extra }
}

function readBefore(spec) {
  const at = spec.lastIndexOf('@')
  const [file, rev] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, 'HEAD']
  const relative = path.relative(root, path.resolve(file)).split(path.sep).join('/')
  const source = execFileSync('git', ['show', `${rev}:${relative}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 })
  return { label: `${relative}@${rev}`, source, relative }
}

function selfTest() {
  const failures = []
  const expect = (label, condition) => {
    if (!condition) failures.push(label)
  }
  const before = declarationTexts('a.ts', [
    "import { x } from './x.js'",
    '// 文件头',
    'export function a() { return x }',
    'function helper() {',
    '  return 1',
    '}',
    'export interface Shape { a: number }',
    "export { y } from './y.js'",
  ].join('\n'))
  const moved = [
    ...declarationTexts('b.ts', "// 新文件头\nimport { helper } from './c.js'\nimport { x } from './x.js'\n\nexport function a() { return x }\n"),
    ...declarationTexts('c.ts', "/** 说明 */\nexport function helper() {\n    return 1\n}\nexport interface Shape { a: number }\nexport { y } from './y.js'\n"),
  ]
  const ok = compareDeclarations(before, moved)
  expect('纯搬家(加 export、换注释、换缩进)应通过', ok.missing.length === 0 && ok.extra.length === 0)
  const changed = compareDeclarations(before, [...moved.slice(0, -1), ...declarationTexts('d.ts', "export { y, z } from './y.js'\n")])
  expect('改了一条应报 missing + extra', changed.missing.length === 1 && changed.extra.length === 1)
  const dup = compareDeclarations(before, [...moved, moved[0]])
  expect('多出一份重复应报 extra', dup.missing.length === 0 && dup.extra.length === 1)
  const lost = compareDeclarations(before, moved.slice(1))
  expect('少一条应报 missing', lost.missing.length === 1 && lost.extra.length === 0)
  const inner = compareDeclarations(
    declarationTexts('e.ts', 'export function f() {\n  // 内部注释\n  return 1\n}\n'),
    declarationTexts('f.ts', 'export function f() {\n  return 1\n}\n'),
  )
  expect('声明内部的注释照比', inner.missing.length === 1)
  expect('export default 也剥掉', declarationTexts('g.ts', 'export default function g() {}')[0].text === 'function g() {}')
  if (failures.length > 0) {
    console.error('[split-prove] self-test FAILED:')
    for (const label of failures) console.error('  ✗', label)
    process.exit(1)
  }
  console.log('[split-prove] self-test ok — 6 checks passed')
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) return selfTest()
  if (args.length < 2) {
    console.error('用法:node scripts/split-prove.mjs <拆前路径>[@<版本>] <拆后文件…>')
    process.exit(2)
  }
  const before = readBefore(args[0])
  const afterFiles = [...new Set(args.slice(1).map((file) => path.relative(root, path.resolve(file)).split(path.sep).join('/')))]
  const beforeDecls = declarationTexts(before.relative, before.source)
  const afterDecls = afterFiles.flatMap((file) => declarationTexts(file, readFileSync(path.join(root, file), 'utf8')).map((d) => ({ ...d, file })))
  const { missing, extra } = compareDeclarations(beforeDecls, afterDecls)
  const lines = (list) => list.map((d) => `    ${d.name}${d.file ? `(${d.file})` : ''}:${d.text.slice(0, 160)}${d.text.length > 160 ? '…' : ''}`)
  if (missing.length > 0 || extra.length > 0) {
    console.error(`[split-prove] failed: ${before.label} → ${afterFiles.length} 只文件不是纯搬家:`)
    if (missing.length > 0) console.error(`  拆前有、拆后没有(丢了或改了)${missing.length} 条:\n${lines(missing).join('\n')}`)
    if (extra.length > 0) console.error(`  拆后有、拆前没有(新写的或改了)${extra.length} 条:\n${lines(extra).join('\n')}`)
    process.exit(1)
  }
  console.log(`[split-prove] ok — ${before.label} → ${afterFiles.join(', ')}:${beforeDecls.length} 条顶层声明逐字相同(只换住处)`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
