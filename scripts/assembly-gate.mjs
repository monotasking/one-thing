#!/usr/bin/env node
// 装配层「模块级 let」棘轮(方案 docs/design/backend-composition-root-2026-09.md 的 A3)。
//
// 度量的是 `packages/backend` 里**非测试** `.ts` 文件的模块级 `let` 数量,逐文件计数,
// 规矩一条:**只许降**。任何文件高于基线、或出现基线里没有的文件 → 红。
//
// 为什么是这把尺子:A 期整期在做的事就是「装配产物从模块全局变量搬进实例字段」。
// 模块级 `let` 是那件事剩下的账 —— 每一个都是「这个进程里只有一份、而且没人说得清
// 谁负责把它放回去」。A2 已经把三个单例模块清零并把唯一合法的那一份收进 `current.ts`
// (本尺子对它豁免,理由见方案 §5 风险 3);A3 把四个装配期闩改成 disposer。往后
// 加一个新的模块级 `let`,这里就红,写代码的人得先回答「谁 own 它」。
//
// 口径与 A2 报告逐字相同(那份报告的清单就是这么数出来的):
//   - 只数**行首**的 `let `(顶格,没有缩进)—— 函数体里的局部 `let` 一律缩进,
//     所以这个朴素判据恰好等于「模块级」,不需要解析器;
//   - 跳过 `__tests__/` 与 `*.test.ts`;
//   - `current.ts` 豁免(方案里有意保留的唯一一个)。
//
// 与 transport-gate 同构的两条防假绿:度量文件读不到 = 硬错而不是 0;
// 扫描规模低于下限 = 红(遍历坏了同样长得像「全治愈了」)。
//
// 用法:
//   node scripts/assembly-gate.mjs                 棘轮比对(package.json: assembly:gate)
//   node scripts/assembly-gate.mjs --list          打全表(package.json: assembly:check)
//   node scripts/assembly-gate.mjs --write-baseline 重录基线(只在真降之后)
//   node scripts/assembly-gate.mjs --self-test     判据自检
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scanRoot = path.join(root, 'packages/backend')
const baselinePath = path.join(root, 'docs/audit/assembly-baseline-2026-09-02.txt')

/** 方案 §5 风险 3:进程当前实例槽是有意保留的唯一一个全局。 */
const EXEMPT = new Set(['packages/backend/current.ts'])

/** 扫描规模下限:遍历坏了 / 目录搬家了,同样长得像「全治愈了」。 */
const MIN_SCANNED_FILES = 300

/** 行首(顶格)的 `let ` —— 函数体里的局部 `let` 一律有缩进。 */
export function countModuleLets(source) {
  let count = 0
  for (const line of source.split('\n')) {
    if (line.startsWith('let ')) count += 1
  }
  return count
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist') continue
    const absolute = path.join(dir, entry)
    if (statSync(absolute).isDirectory()) {
      walk(absolute, out)
      continue
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts') || entry.endsWith('.d.ts')) continue
    out.push(absolute)
  }
  return out
}

/** @returns {{ counts: Record<string, number>, scanned: number, total: number }} */
export function measure() {
  if (!existsSync(scanRoot)) {
    // 目录不存在 ≠ 指标归零。真搬家了就该显式改这个脚本,而不是让 gate 替你庆祝。
    throw new Error(`扫描根不存在:${path.relative(root, scanRoot)} —— 指标已失效,不认这次结果`)
  }
  const counts = {}
  let scanned = 0
  let total = 0
  for (const absolute of walk(scanRoot, []).sort()) {
    const relative = path.relative(root, absolute)
    scanned += 1
    if (EXEMPT.has(relative)) continue
    const n = countModuleLets(readFileSync(absolute, 'utf8'))
    if (n === 0) continue
    counts[relative] = n
    total += n
  }
  return { counts, scanned, total }
}

export function formatBaseline(counts) {
  const lines = [
    '# assembly ratchet baseline (A3, docs/design/backend-composition-root-2026-09.md)',
    '# packages/backend 非测试 .ts 文件里的模块级 `let`(行首 `let `),逐文件计数。',
    '# 只许降:任一文件高于这里的数、或出现这里没有的文件,`bun run assembly:gate` 红。',
    '# `packages/backend/current.ts` 豁免(方案 §5 风险 3:有意保留的唯一一个全局)。',
    '# 降了之后跑 `node scripts/assembly-gate.mjs --write-baseline` 收紧。',
  ]
  for (const key of Object.keys(counts).sort()) lines.push(`${key} ${counts[key]}`)
  return `${lines.join('\n')}\n`
}

export function parseBaseline(text) {
  const counts = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const at = line.lastIndexOf(' ')
    if (at < 0) continue
    const key = line.slice(0, at).trim()
    const value = Number.parseInt(line.slice(at + 1).trim(), 10)
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
    // 基线里没有的文件一律当红:不然新开一个文件就能绕开棘轮。
    if (n > base) regressions.push({ key, baseline: base, current: n, isNewFile: !(key in baseline) })
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

  // 1) 只数顶格的 `let`。
  const fixture = [
    'let a = 1',
    'export function f() {',
    '  let b = 2',
    '\tlet c = 3',
    '}',
    'let d: string | null = null',
    '// let e = 4  ← 注释里的不算(它不是行首 `let `)',
  ].join('\n')
  expect('countModuleLets 应为 2', countModuleLets(fixture) === 2)

  // 2) 升 → 红;3) 降 → 绿且提示可收紧;4) 平 → 两边都空。
  const up = compare({ 'a.ts': 1 }, { 'a.ts': 2 })
  expect('计数上升应产生 regression', up.regressions.length === 1 && up.improvements.length === 0)
  const down = compare({ 'a.ts': 3 }, { 'a.ts': 1 })
  expect('计数下降应产生 improvement', down.improvements.length === 1 && down.regressions.length === 0)
  const flat = compare({ 'a.ts': 3 }, { 'a.ts': 3 })
  expect('计数持平应两边都空', flat.regressions.length === 0 && flat.improvements.length === 0)

  // 5) 基线里没有的新文件算红。
  const added = compare({ 'a.ts': 1 }, { 'a.ts': 1, 'b.ts': 1 })
  expect('新文件应算 regression', added.regressions.length === 1 && added.regressions[0].isNewFile)

  // 6) 文件清零(不在 current 里)算 improvement,不算 missing 硬错。
  const healed = compare({ 'a.ts': 2 }, {})
  expect('清零应算 improvement', healed.improvements.length === 1 && healed.improvements[0].current === 0)

  // 7) 基线序列化 / 反序列化是一对。
  const round = parseBaseline(formatBaseline({ 'a/b.ts': 4, 'c.ts': 1 }))
  expect('基线往返应无损', round['a/b.ts'] === 4 && round['c.ts'] === 1)

  if (failures.length > 0) {
    console.error('[assembly-gate] self-test FAILED:')
    for (const label of failures) console.error('  ✗', label)
    process.exit(1)
  }
  console.log('[assembly-gate] self-test ok — 7 checks passed')
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) return selfTest()

  const { counts, scanned, total } = measure()

  if (scanned < MIN_SCANNED_FILES) {
    console.error(
      `[assembly-gate] 只扫到 ${scanned} 个文件(下限 ${MIN_SCANNED_FILES})—— 遍历坏了,不认这次结果。`,
    )
    process.exit(1)
  }

  if (args.includes('--list')) {
    const files = Object.keys(counts).sort()
    console.log(`[assembly] ${total} module-level let(s) across ${files.length} file(s) of ${scanned} scanned:`)
    for (const key of files) console.log(`  ${counts[key]}\t${key}`)
    console.log(`[assembly] complete: ${scanned} file(s) scanned`)
    return
  }

  if (args.includes('--write-baseline')) {
    writeFileSync(baselinePath, formatBaseline(counts), 'utf8')
    console.log(`[assembly-gate] baseline written → ${path.relative(root, baselinePath)} (${total} let(s))`)
    return
  }

  if (!existsSync(baselinePath)) {
    console.error(`[assembly-gate] 基线文件缺失:${path.relative(root, baselinePath)}`)
    console.error('  先跑一次 `node scripts/assembly-gate.mjs --write-baseline` 生成它。')
    process.exit(1)
  }

  const baseline = parseBaseline(readFileSync(baselinePath, 'utf8'))
  if (Object.keys(baseline).length === 0) {
    console.error('[assembly-gate] 基线解析为空 —— 格式坏了,不认这次结果')
    process.exit(1)
  }

  const { regressions, improvements } = compare(baseline, counts)

  if (improvements.length > 0) {
    const n = improvements.reduce((sum, item) => sum + (item.baseline - item.current), 0)
    console.log(`[assembly-gate] ${n} 个模块级 let 消失了 —— 可以收紧基线(--write-baseline):`)
    for (const item of improvements.slice(0, 40)) {
      console.log(`  - ${item.key}: ${item.baseline} → ${item.current}`)
    }
    if (improvements.length > 40) console.log(`  … and ${improvements.length - 40} more`)
  }

  if (regressions.length > 0) {
    console.error(`[assembly-gate] failed: ${regressions.length} 个文件的模块级 let 上升 —— 装配层在长回全局变量:`)
    for (const item of regressions) {
      const note = item.isNewFile ? '(基线里没有这个文件)' : ''
      console.error(`  + ${item.key}: ${item.baseline} → ${item.current} ${note}`)
    }
    console.error('  规则见 docs/design/backend-composition-root-2026-09.md §2.4/§2.5:')
    console.error('  起了一件有尾巴的东西,收尾登记进 `backend.own(disposer, label)`,别再开一个模块级 let。')
    process.exit(1)
  }

  console.log(
    `[assembly-gate] ok — ${total} known module-level let(s) in ${Object.keys(counts).length} file(s),`
    + ` ${scanned} file(s) scanned, none new`,
  )
}

main()
