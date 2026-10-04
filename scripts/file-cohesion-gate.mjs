#!/usr/bin/env node
// 文件内聚门:一只文件里不许住着两件互不相干的事(决策 D225、D229,判据正本 `docs/design/oversized-files-2026-10.md` §1)。
//
// 为什么:用户问大文件该不该拆时给了四个问题 —— 里面有几件事、读一处要不要先读另一处、改一处碰不碰别处、测试能不能单测。
// 行数回答不了它们:一个 reducer、一段顺序就是规格的装配函数、一张数据表,再长也是一件事;所以这里不设行数上限。
// 能量出来、又不需要人判断的只有一种形状(形状 A):把文件的顶层声明当点、谁引用谁当线(不分方向),
// 连不到一起的就是不同的事。第二件事也有一定规模时,读其中一件不需要读另一件,它们就该分家。
//
// 判据(形状 A;对新文件是零基线硬闸 —— 名单外任何一只文件命中就红,已知名单只许减,见下):
//   - 扫描 `packages/backend` 下的非测试 `.ts` 文件(测试 = `__tests__/`、`*.test.*`、`__fixtures__/`、`testing/`,与其他结构门同口径)。
//   - 点 = 每条顶层语句里的声明:函数、类、接口、类型别名、枚举、变量语句(一条 `const a = …, b = …` 算一个点)。
//     `import` 不是点;`export … from` 转交不是点(它没有自己的内容)。
//   - 线 = 点 i 的源文本里出现了点 j 的名字(按标识符的字面,不区分它在值位置还是类型位置)。
//   - **叶子常量不连线**:不超过 3 行、初值不是函数也不是对象字面量的 `const`(例如 `const log = getLogger(…)`、超时毫秒数)。
//     不排除的话几乎每只文件都是一个块,因为人人都引 `log`。
//   - 按线算连通块,块的行数 = 块里各点所占行数之和(从声明的第一个记号到最后一个记号,不含前面的注释)。
//     **至少 2 块、且第二大的块 ≥ 150 行 = 红。**
// 这条判据与 Fable 的分析脚本(s37 `analyze.mjs`)逐条一致。Fable 只量过 1000 行以上的文件,按它红 `agent-loop-executor`
// (第二块 264 行)与 `session-store-helpers`(156 行),两只都由拆分批 1 拆掉;立门时扫全包,另有 4 只 1000 行以下的文件
// 同样命中(D229)。这 4 只记在已知名单 `docs/audit/cohesion-baseline-2026-10.txt` 里,**只许减**:名单外的文件命中就红,
// 名单里的文件拆开了(不再命中)提示删行;名单不收新行。批 2 逐只读过(D239):两只是两件事、已拆开删行,另两只是
// 「一件事、线不在标识符上」(压缩流水线的线在驱动里、面板协议的线在 `type` 字面量里),判据不改、暂留,理由写在名单文件头。
//
// 它探不到的(诚实说明):大家经同一批私有 helper 连成一个块的文件(`theme-resolver` 与 `plugin-api-builder` 拆分前、
// `music-radio`、`CoreStreamEngine`)在形状 A 下只有一块。它们是形状 B「一只长函数里几组嵌套函数各管各的 `let`」
// 与形状 C「一只类里几组方法各管各的字段」,拆出来叫什么、各自要一个什么样的端口,要人来定,所以只出报表(`--report`),
// 不判红,靠评审。报表的分组口径:形状 B 按函数体一级的 `let`、形状 C 按类里声明的字段(`this.<字段>`,不按互相调用 ——
// 主体方法人人调协作方法,按调用合并只剩一组);被至少一半成员共用的键是公共底座,不参与分组。
//
// 用法:
//   node scripts/file-cohesion-gate.mjs             判(package.json: cohesion:gate)
//   node scripts/file-cohesion-gate.mjs --list      打每只至少两块的文件的块表(package.json: cohesion:check)
//   node scripts/file-cohesion-gate.mjs --report    另打形状 B / C 的报表(只报不判)
//   node scripts/file-cohesion-gate.mjs --self-test 判据自检
//   node scripts/file-cohesion-gate.mjs <文件…>     只看这几只文件的块表(拆分时自查用)
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { listBackendSourceFiles } from './file-name-gate.mjs'
import { isTestPath, repoRoot } from './lib/backend-structure.mjs'

/** 第二大块的行数下限(形状 A)。 */
export const SECOND_COMPONENT_MIN_LINES = 150
/** 叶子常量的行数上限。 */
export const LEAF_CONST_MAX_LINES = 3
/** 形状 B:函数至少多长才看它里面;形状 B / C:第二组至少多长才报。 */
export const SHAPE_B_MIN_FUNCTION_LINES = 400
export const SHAPE_C_MIN_CLASS_LINES = 300
export const SHAPE_BC_SECOND_GROUP_MIN_LINES = 100
/** 已知名单(只许减):立门时就命中、尚待裁定的文件。 */
const BASELINE = 'docs/audit/cohesion-baseline-2026-10.txt'
/** 扫描规模下限:遍历坏了同样长得像「全都内聚」。 */
const MIN_SCANNED_FILES = 1000

const lineOf = (file, pos) => file.getLineAndCharacterOfPosition(pos).line + 1

function declarationName(statement) {
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.map((d) => d.name.getText()).join(',')
  if (statement.name) return statement.name.getText()
  if (ts.isExportAssignment(statement)) return 'default'
  return '?'
}

function declarationKind(statement) {
  if (ts.isFunctionDeclaration(statement)) return 'fn'
  if (ts.isClassDeclaration(statement)) return 'class'
  if (ts.isInterfaceDeclaration(statement)) return 'iface'
  if (ts.isTypeAliasDeclaration(statement)) return 'type'
  if (ts.isEnumDeclaration(statement)) return 'enum'
  if (ts.isVariableStatement(statement)) {
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) return 'let'
    const init = statement.declarationList.declarations[0]?.initializer
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return 'constfn'
    if (init && ts.isObjectLiteralExpression(init)) return 'constobj'
    if (init && (ts.isNewExpression(init) || ts.isCallExpression(init))) return 'const(call/new)'
    return 'const'
  }
  return ts.SyntaxKind[statement.kind]
}

/** 一只文件的顶层点(不含 import 与 `export … from`)。 */
export function topLevelDeclarations(file) {
  const out = []
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement) || ts.isExportDeclaration(statement)) continue
    out.push({
      node: statement,
      kind: declarationKind(statement),
      name: declarationName(statement),
      start: lineOf(file, statement.getStart(file)),
      end: lineOf(file, statement.end),
    })
  }
  return out
}

const lines = (decl) => decl.end - decl.start + 1
export const isLeafConst = (decl) => (decl.kind === 'const' || decl.kind === 'const(call/new)') && lines(decl) <= LEAF_CONST_MAX_LINES

/**
 * 形状 A:按引用线算连通块,返回 `[{ lines, names }]`,大块在前。
 * @param {string} fileName
 * @param {string} source
 */
export function componentsOf(fileName, source) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const decls = topLevelDeclarations(file)
  const index = new Map()
  decls.forEach((decl, i) => {
    if (decl.name && decl.name !== '?') for (const name of decl.name.split(',')) index.set(name, i)
  })
  const parent = decls.map((_, i) => i)
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])))
  decls.forEach((decl, i) => {
    if (isLeafConst(decl)) return
    const visit = (node) => {
      if (ts.isIdentifier(node)) {
        const j = index.get(node.text)
        if (j !== undefined && j !== i && !isLeafConst(decls[j])) parent[find(i)] = find(j)
      }
      ts.forEachChild(node, visit)
    }
    visit(decl.node)
  })
  const groups = new Map()
  decls.forEach((decl, i) => {
    const r = find(i)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r).push(decl)
  })
  return [...groups.values()]
    .map((members) => ({ lines: members.reduce((sum, decl) => sum + lines(decl), 0), names: members.map((decl) => decl.name) }))
    .sort((a, b) => b.lines - a.lines)
}

/** 读已知名单:每行 `<第二块行数> <路径>`,`#` 开头是注释。 */
export function parseKnownList(text) {
  const known = new Map()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const at = line.indexOf(' ')
    if (at < 0) continue
    known.set(line.slice(at + 1).trim(), Number.parseInt(line.slice(0, at), 10))
  }
  return known
}

/**
 * 纯判决:名单外的形状 A 就红;名单里的文件不再是形状 A → 提示删行。只回报,不打印、不退出。
 * @param {Array<{relative: string}>} red 命中形状 A 的文件
 * @param {Map<string, number>} known 已知名单
 */
export function judgeAgainstKnown(red, known) {
  const hit = new Set(red.map((r) => r.relative))
  return {
    failures: red.filter((r) => !known.has(r.relative)),
    healed: [...known.keys()].filter((file) => !hit.has(file)),
  }
}

/** 纯判定:这组块是不是形状 A。 */
export function isShapeA(components) {
  return components.length >= 2 && components[1].lines >= SECOND_COMPONENT_MIN_LINES
}

/**
 * 形状 B 的报表:顶层(或 `const x = () => …` 形式)的长函数里,一级嵌套函数按共用的 `let`(函数体一级的 `let`)分组。
 * 不用到任何 `let` 的嵌套函数不进组。返回 `[{ fn, lines, groups: [{ lines, members, lets }] }]`,只留够格的。
 */
export function shapeBReport(fileName, source) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const out = []
  for (const decl of topLevelDeclarations(file)) {
    let body = null
    if (ts.isFunctionDeclaration(decl.node)) body = decl.node.body
    else if (decl.kind === 'constfn') body = decl.node.declarationList.declarations[0].initializer.body
    if (!body || !ts.isBlock(body) || lines(decl) < SHAPE_B_MIN_FUNCTION_LINES) continue
    const lets = new Set()
    for (const statement of body.statements) {
      if (ts.isVariableStatement(statement) && !(statement.declarationList.flags & ts.NodeFlags.Const)) {
        for (const d of statement.declarationList.declarations) lets.add(d.name.getText())
      }
    }
    const nested = []
    for (const statement of body.statements) {
      const isFn = ts.isFunctionDeclaration(statement)
        || (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((d) => d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))))
      if (!isFn) continue
      const used = new Set()
      const visit = (node) => {
        if (ts.isIdentifier(node) && lets.has(node.text)) used.add(node.text)
        ts.forEachChild(node, visit)
      }
      visit(statement)
      if (used.size === 0) continue
      nested.push({ name: declarationName(statement), lines: lineOf(file, statement.end) - lineOf(file, statement.getStart(file)) + 1, used: [...used] })
    }
    const common = commonKeys(nested)
    const groups = groupByShared(nested.filter((item) => item.used.some((key) => !common.has(key))), (item) => item.used.filter((key) => !common.has(key)))
    if (groups.length >= 2 && groups[1].lines >= SHAPE_BC_SECOND_GROUP_MIN_LINES) out.push({ fn: decl.name, lines: lines(decl), groups, common: [...common] })
  }
  return out
}

/**
 * 形状 C 的报表:长类的方法按共用的字段(`this.<字段>`,字段 = 类里声明的属性)与互相调用(`this.<方法>`)分组。
 * 返回 `[{ cls, lines, groups }]`,只留够格的。
 */
export function shapeCReport(fileName, source) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const out = []
  for (const decl of topLevelDeclarations(file)) {
    if (decl.kind !== 'class' || lines(decl) < SHAPE_C_MIN_CLASS_LINES) continue
    const fields = new Set(decl.node.members.filter((m) => ts.isPropertyDeclaration(m) && m.name).map((m) => m.name.getText().replace(/^#/, '')))
    const methods = decl.node.members.filter((m) => !ts.isPropertyDeclaration(m))
    const methodNames = new Set(methods.map((m) => (m.name ? m.name.getText() : 'constructor')))
    const items = methods.map((m) => {
      const used = new Set()
      const visit = (node) => {
        if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) {
          const name = node.name.getText().replace(/^#/, '')
          if (fields.has(name)) used.add(`field:${name}`)
          else if (methodNames.has(name)) used.add(`method:${name}`)
        }
        ts.forEachChild(node, visit)
      }
      visit(m)
      const name = m.name ? m.name.getText() : 'constructor'
      return { name, lines: lineOf(file, m.end) - lineOf(file, m.getStart(file)) + 1, used: [...used].filter((key) => key.startsWith('field:')) }
    })
    const common = commonKeys(items)
    const groups = groupByShared(items.filter((item) => item.used.some((key) => !common.has(key))), (item) => item.used.filter((key) => !common.has(key)))
    if (groups.length >= 2 && groups[1].lines >= SHAPE_BC_SECOND_GROUP_MIN_LINES) out.push({ cls: decl.name, lines: lines(decl), groups, common: [...common].map((key) => key.replace(/^field:/, '')) })
  }
  return out
}

/**
 * 「人人用」的键:被至少一半(且至少 3 个)用到键的成员共用的那几个。它们是这台机器的公共底座(电台闭包里的 `radioStore` /
 * `conductor`、引擎里的 `activeStreams`),按它们合并会把所有成员连成一组,看不出里面住着几台机器,所以分组时不算它们。
 */
function commonKeys(items) {
  const users = items.filter((item) => item.used.length > 0)
  const count = new Map()
  for (const item of users) for (const key of new Set(item.used)) count.set(key, (count.get(key) ?? 0) + 1)
  const threshold = Math.max(3, Math.ceil(users.length / 2))
  return new Set([...count].filter(([, n]) => n >= threshold).map(([key]) => key))
}

/** 按「共用任一个键」合并成组,返回 `[{ lines, members, keys }]`,大组在前。 */
function groupByShared(items, keysOf) {
  const parent = items.map((_, i) => i)
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])))
  const owner = new Map()
  items.forEach((item, i) => {
    for (const key of keysOf(item)) {
      if (owner.has(key)) parent[find(i)] = find(owner.get(key))
      else owner.set(key, i)
    }
  })
  const groups = new Map()
  items.forEach((item, i) => {
    const r = find(i)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r).push(item)
  })
  return [...groups.values()]
    .map((members) => ({
      lines: members.reduce((sum, item) => sum + item.lines, 0),
      members: members.map((item) => item.name),
      keys: [...new Set(members.flatMap(keysOf))].filter((key) => !key.startsWith('method:')),
    }))
    .sort((a, b) => b.lines - a.lines)
}

function formatComponents(relative, components) {
  const rows = [`  ${relative}:${components.length} 块`]
  for (const c of components.slice(0, 8)) {
    rows.push(`      ${String(c.lines).padStart(5)} 行  ${c.names.slice(0, 6).join(', ')}${c.names.length > 6 ? ` …(共 ${c.names.length} 个)` : ''}`)
  }
  return rows.join('\n')
}

function selfTest() {
  const failures = []
  const expect = (label, condition) => {
    if (!condition) failures.push(label)
  }
  const body = (name, n, uses = '') => `export function ${name}() {\n${Array.from({ length: n - 2 }, () => `  ${uses || 'void 0'}`).join('\n')}\n}`

  // 1) 两件不相干的事,第二件够大 → 形状 A。
  const two = `${body('a', 200)}\n${body('b', 160)}\n`
  const twoC = componentsOf('two.ts', two)
  expect('两只互不引用的函数是两块', twoC.length === 2)
  expect('块的行数按声明所占行算', twoC[0].lines === 200 && twoC[1].lines === 160)
  expect('第二块 ≥ 150 行 → 红', isShapeA(twoC))
  // 2) 第二块不够大 → 不红。
  expect('第二块 149 行 → 不红', !isShapeA(componentsOf('small.ts', `${body('a', 200)}\n${body('b', 149)}\n`)))
  // 3) 互相引用 → 一块。
  const linked = `${body('a', 200, 'b()')}\n${body('b', 160)}\n`
  expect('引用连成一块', componentsOf('linked.ts', linked).length === 1)
  // 4) 类型引用也连线。
  const typed = `export interface Shape { x: number }\n${body('a', 200, 'const s: Shape = { x: 1 }')}\n${body('b', 160, 'const t: Shape = { x: 2 }')}\n`
  expect('经共同的类型连成一块', componentsOf('typed.ts', typed).length === 1)
  // 5) 叶子常量不连线:人人都引 log,也还是两块。
  const leaf = `const log = getLogger('x')\n${body('a', 200, 'log.info()')}\n${body('b', 160, 'log.info()')}\n`
  const leafC = componentsOf('leaf.ts', leaf)
  expect('叶子常量不连线(两块 + 常量自成一块)', leafC.length === 3 && isShapeA(leafC))
  // 6) 对象字面量与超过 3 行的常量不是叶子,照样连线。
  const objectConst = `const TABLE = { a: 1 }\n${body('a', 200, 'TABLE.a')}\n${body('b', 160, 'TABLE.a')}\n`
  expect('对象字面量常量连线', componentsOf('obj.ts', objectConst).length === 1)
  const longConst = `const LONG = [\n  1,\n  2,\n  3,\n]\n${body('a', 200, 'LONG')}\n${body('b', 160, 'LONG')}\n`
  expect('超过 3 行的常量连线', componentsOf('long.ts', longConst).length === 1)
  // 7) import 与 export … from 不是点。
  const reexport = `import { x } from './x.js'\nexport { y } from './y.js'\n${body('a', 200, 'x()')}\n`
  expect('import / export from 不是点', componentsOf('re.ts', reexport).length === 1)
  // 8) 测试文件不扫(与其他结构门同口径)。
  expect('__tests__ 算测试', isTestPath('packages/backend/x/__tests__/x.test.ts'))
  // 9) 形状 B:长函数里两组嵌套函数各管各的 let → 报;只有一组 → 不报。
  const nestedFn = (name, n, letName) => `  function ${name}() {\n${Array.from({ length: n - 2 }, () => `    ${letName} = 1`).join('\n')}\n  }`
  const shapeB = `export function big() {\n  let lyrics = 0\n  let seen = 0\n${nestedFn('lyricsPart', 220, 'lyrics')}\n${nestedFn('identifyPart', 200, 'seen')}\n}\n`
  expect('形状 B:两组各管各的 let → 报', shapeBReport('b.ts', shapeB).length === 1)
  const shapeBOne = `export function big() {\n  let lyrics = 0\n${nestedFn('p1', 220, 'lyrics')}\n${nestedFn('p2', 200, 'lyrics')}\n}\n`
  expect('形状 B:共用一个 let → 不报', shapeBReport('b1.ts', shapeBOne).length === 0)
  // 10) 形状 C:类里两组方法各管各的字段 → 报。
  const method = (name, n, field) => `  ${name}() {\n${Array.from({ length: n - 2 }, () => `    this.${field} = 1`).join('\n')}\n  }`
  const shapeC = `export class Engine {\n  private titles = 0\n  private gates = 0\n${method('title', 160, 'titles')}\n${method('gate', 150, 'gates')}\n}\n`
  expect('形状 C:两组各管各的字段 → 报', shapeCReport('c.ts', shapeC).length === 1)
  const shapeCOne = `export class Engine {\n  private titles = 0\n${method('t1', 160, 'titles')}\n${method('t2', 150, 'titles')}\n}\n`
  expect('形状 C:共用一个字段 → 不报', shapeCReport('c1.ts', shapeCOne).length === 0)

  // 11) 已知名单:名单外命中 → 红;名单里拆开了 → 提示删行;往返无损。
  const known = parseKnownList('# 注释\n185 packages/backend/a.ts\n211 packages/backend/b.ts\n')
  expect('名单解析', known.size === 2 && known.get('packages/backend/a.ts') === 185)
  const verdict = judgeAgainstKnown([{ relative: 'packages/backend/a.ts' }, { relative: 'packages/backend/c.ts' }], known)
  expect('名单外命中就红', verdict.failures.length === 1 && verdict.failures[0].relative === 'packages/backend/c.ts')
  expect('名单里不再命中的提示删行', verdict.healed.length === 1 && verdict.healed[0] === 'packages/backend/b.ts')

  if (failures.length > 0) {
    console.error('[cohesion-gate] self-test FAILED:')
    for (const label of failures) console.error('  ✗', label)
    process.exit(1)
  }
  console.log('[cohesion-gate] self-test ok — 19 checks passed')
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) return selfTest()
  const explicit = args.filter((arg) => !arg.startsWith('--'))
  const files = explicit.length > 0 ? explicit.map((file) => path.relative(repoRoot, path.resolve(file))) : listBackendSourceFiles()
  if (explicit.length === 0 && files.length < MIN_SCANNED_FILES) {
    console.error(`[cohesion-gate] 只扫到 ${files.length} 个文件(下限 ${MIN_SCANNED_FILES})—— 遍历坏了,不认这次结果。`)
    process.exit(1)
  }
  const red = []
  const multi = []
  for (const relative of files) {
    const source = readFileSync(path.join(repoRoot, relative), 'utf8')
    const components = componentsOf(relative, source)
    if (components.length >= 2) multi.push({ relative, components })
    if (isShapeA(components)) red.push({ relative, components })
  }

  if (explicit.length > 0) {
    for (const relative of files) {
      const hit = multi.find((m) => m.relative === relative)
      const components = hit ? hit.components : componentsOf(relative, readFileSync(path.join(repoRoot, relative), 'utf8'))
      console.log(`${formatComponents(relative, components)}${isShapeA(components) ? '   ← 形状 A' : ''}`)
    }
  }

  if (args.includes('--list')) {
    console.log(`[cohesion] ${multi.length} 只文件至少两块(块 = 顶层声明经引用连通;叶子常量不连线),其中形状 A ${red.length} 只;扫描 ${files.length} 只:`)
    for (const { relative, components } of multi.sort((a, b) => b.components[1].lines - a.components[1].lines)) {
      if (components[1].lines < 20) continue
      console.log(formatComponents(relative, components))
    }
  }

  if (args.includes('--report')) {
    console.log('[cohesion] 形状 B(长函数里几组嵌套函数各管各的 let;只报不判):')
    for (const relative of files) {
      for (const item of shapeBReport(relative, readFileSync(path.join(repoRoot, relative), 'utf8'))) {
        console.log(`  ${relative} ${item.fn}(${item.lines} 行):${item.groups.length} 组(人人用、不参与分组:${item.common.join(', ') || '无'})`)
        for (const g of item.groups.slice(0, 6)) console.log(`      ${String(g.lines).padStart(5)} 行  let ${g.keys.join(', ')}  ← ${g.members.slice(0, 6).join(', ')}${g.members.length > 6 ? ' …' : ''}`)
      }
    }
    console.log('[cohesion] 形状 C(一只类里几组方法各管各的字段;只报不判):')
    for (const relative of files) {
      for (const item of shapeCReport(relative, readFileSync(path.join(repoRoot, relative), 'utf8'))) {
        console.log(`  ${relative} ${item.cls}(${item.lines} 行):${item.groups.length} 组(人人用、不参与分组:${item.common.join(', ') || '无'})`)
        for (const g of item.groups.slice(0, 6)) console.log(`      ${String(g.lines).padStart(5)} 行  ${g.keys.map((k) => k.replace(/^field:/, '')).join(', ') || '(不碰字段)'}  ← ${g.members.slice(0, 6).join(', ')}${g.members.length > 6 ? ' …' : ''}`)
      }
    }
  }

  if (explicit.length > 0) return
  const baselinePath = path.join(repoRoot, BASELINE)
  if (!existsSync(baselinePath)) {
    console.error(`[cohesion-gate] 已知名单缺失:${BASELINE}`)
    process.exit(1)
  }
  const known = parseKnownList(readFileSync(baselinePath, 'utf8'))
  const { failures, healed } = judgeAgainstKnown(red, known)
  if (healed.length > 0) {
    console.log(`[cohesion-gate] 已知名单里 ${healed.length} 只文件不再命中形状 A —— 从 ${BASELINE} 删掉这几行:`)
    for (const file of healed) console.log(`  - ${file}`)
  }
  if (failures.length > 0) {
    console.error(`[cohesion-gate] failed: ${failures.length} 只文件里住着两件互不相干的事(形状 A:第二块 ≥ ${SECOND_COMPONENT_MIN_LINES} 行),不在已知名单里:`)
    for (const { relative, components } of failures) console.error(formatComponents(relative, components))
    console.error('  按块拆成几只文件,文件名按 N2 说清各自做什么;判据与拆法见 docs/design/oversized-files-2026-10.md。已知名单只许减,不收新行。')
    process.exit(1)
  }
  console.log(`[cohesion-gate] ok — 0 new file(s) of shape A (second component ≥ ${SECOND_COMPONENT_MIN_LINES} lines), ${red.length} known (${BASELINE}, decrease-only); ${multi.length} file(s) with ≥ 2 components; ${files.length} file(s) scanned`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
