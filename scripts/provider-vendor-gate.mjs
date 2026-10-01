#!/usr/bin/env node
// 服务商点名棘轮(方案 docs/design/architecture-direction-2026-10.md §4 P0)。
//
// 度量的是:**一家内置服务商的名字,出现在了它自己的家以外的哪些文件里。**
// 家 = `packages/onething-runtime/src/providers/vendors/<id>/`。家以外每多一个文件
// 认识这家,"加一家服务商"就多改一处 —— CLAUDE.md「加功能不许改骨架」那条法的
// 陌生能力演练,在 provider 上就是这把尺子。
//
// 「认识」的判据(剥掉注释之后,任一即算):
//   1. id 作为字符串字面量出现:'zhipu' / "zhipu" / `zhipu`
//   2. id 作为对象键出现:zhipu: … / 'kimi-code': …
//   3. 标识符里含这个 id,大小写不敏感:ZHIPU_DIALS / readOnethingZhipuOptions
// 线协议的名字不算服务商:openai-chat / openai-responses / openai-effort /
// openai-compatible / OpenAIChat* / OpenAIResponses* / gemini-generateContent 这类
// 说的是「线怎么拼」,不是「哪一家」(见 PROTOCOL_TOKENS)。
//
// 计数单位是 (服务商, 文件) 对。规矩一条:**只许减**。基线里没有的对 = 红。
// P3 结束时基线应为空,本脚本即成零基线硬闸。
//
// 服务商名单不写死在这里(写死就违反它自己要守的法):
//   - `vendors/` 下的每个目录名;
//   - 过渡期还没迁走的,从 `builtin-manifests.ts` 的 `id: '…'` 读出来。
// `acp` 不是服务商:它是外部 agent 那条路的占位 id(EXTERNAL_AGENT),排除。
//
// 用法:
//   node scripts/provider-vendor-gate.mjs                  棘轮比对(provider:gate)
//   node scripts/provider-vendor-gate.mjs --list           打全表(provider:check)
//   node scripts/provider-vendor-gate.mjs --write-baseline 重录基线(只在真降之后)
//   node scripts/provider-vendor-gate.mjs --self-test      判据自检
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = path.join(root, 'docs/audit/provider-vendor-baseline-2026-10.txt')
const VENDORS_DIR = 'packages/onething-runtime/src/providers/vendors'
const LEGACY_MANIFESTS = 'packages/onething-runtime/src/providers/builtin-manifests.ts'

const SCAN_ROOTS = [
  'packages/core',
  'packages/onething-runtime/src',
  'packages/backend',
  'packages/shared',
  'apps/desktop-react/src',
  'apps/desktop-react/electron',
]
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'dist-electron', '__tests__', '__fixtures__', '.vite', 'coverage'])

/** 壳的渲染模块:骨架法允许它们按家写(图标、文案)。 */
const RENDER_FILES = [
  /^apps\/desktop-react\/src\/i18n\//,
  /^apps\/desktop-react\/src\/providers\/provider-icons\.ts$/,
]
/** 登记处:每家一行,本来就该点名。 */
const REGISTRY_FILES = [
  /^packages\/onething-runtime\/src\/providers\/vendors\/[^/]+\.ts$/,
]

const NON_VENDOR_IDS = new Set(['acp'])

/** 线协议的名字(不是服务商)。命中这些的 token 不计。 */
const PROTOCOL_TOKENS = [
  /openai[-_]?(chat|responses|compatible|effort|o[-_]?series)/i,
  /gemini[-_]?(generateContent|wire|messages|level|budget|errors|recipe)/i,
]

/** 扫描规模下限:遍历坏了同样长得像「全治愈了」。 */
const MIN_SCANNED_FILES = 1500

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue
    const absolute = path.join(dir, entry)
    if (statSync(absolute).isDirectory()) {
      walk(absolute, out)
      continue
    }
    if (!/\.tsx?$/.test(entry) || /\.(test|spec)\.tsx?$/.test(entry) || entry.endsWith('.d.ts')) continue
    out.push(absolute)
  }
  return out
}

export function stripComments(source) {
  // 字符串里的 `//`(URL)不能当注释剥:逐字符走一遍,只在字符串外认注释。
  let out = ''
  let i = 0
  let quote = null
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (quote) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 2; continue }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i += 1; continue }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** id 的标识符形态:kimi-code → kimicode / kimi_code(大小写不敏感)。 */
function identifierPattern(id) {
  const parts = id.split('-').map(escape)
  return new RegExp(`[A-Za-z0-9_$]*${parts.join('_?')}[A-Za-z0-9_$]*`, 'gi')
}

export function mentions(source, id) {
  const code = stripComments(source)
  const literal = new RegExp(`(['"\`])${escape(id)}\\1`)
  if (literal.test(code)) return true
  const key = /^[a-z][a-z0-9]*$/.test(id)
    ? new RegExp(`(^|[{,\\s])${escape(id)}\\s*:(?!:)`, 'm')
    : null
  if (key && key.test(code)) return true
  for (const match of code.matchAll(identifierPattern(id))) {
    // 连字符词(`openai-chat`)整个拿来判协议名:标识符正则会停在 `-` 上。
    const tail = /^[-A-Za-z0-9_$]*/.exec(code.slice(match.index + match[0].length))[0]
    const token = match[0] + tail
    if (PROTOCOL_TOKENS.some((pattern) => pattern.test(token))) continue
    // 字符串里的 URL 片段(open.bigmodel.cn/…)也会被这条正则扫到;只认真正的标识符:
    // 前一个字符不能是 `.`/`/`/`-`(域名、路径、连字符词的一段)。
    const before = code[match.index - 1]
    if (before === '.' || before === '/' || before === '-') continue
    return true
  }
  return false
}

export function vendorIds() {
  const ids = new Set()
  const vendorsDir = path.join(root, VENDORS_DIR)
  if (existsSync(vendorsDir)) {
    for (const entry of readdirSync(vendorsDir)) {
      if (statSync(path.join(vendorsDir, entry)).isDirectory()) ids.add(entry)
    }
  }
  const legacy = path.join(root, LEGACY_MANIFESTS)
  if (existsSync(legacy)) {
    for (const match of readFileSync(legacy, 'utf8').matchAll(/^\s{4}id: '([a-z0-9-]+)'/gm)) ids.add(match[1])
  }
  for (const id of NON_VENDOR_IDS) ids.delete(id)
  return [...ids].sort()
}

function isExempt(relative, id) {
  if (relative.startsWith(`${VENDORS_DIR}/${id}/`)) return true
  if (RENDER_FILES.some((pattern) => pattern.test(relative))) return true
  if (REGISTRY_FILES.some((pattern) => pattern.test(relative))) return true
  return false
}

/** @returns {{ pairs: string[], scanned: number, ids: string[] }} */
export function measure() {
  const files = []
  for (const scanRoot of SCAN_ROOTS) {
    const absolute = path.join(root, scanRoot)
    if (!existsSync(absolute)) throw new Error(`扫描根不存在:${scanRoot} —— 指标已失效,不认这次结果`)
    walk(absolute, files)
  }
  const ids = vendorIds()
  if (ids.length < 10) throw new Error(`只认出 ${ids.length} 家服务商 —— 名单来源坏了,不认这次结果`)
  const pairs = []
  for (const absolute of files.sort()) {
    const relative = path.relative(root, absolute).split(path.sep).join('/')
    const source = readFileSync(absolute, 'utf8')
    for (const id of ids) {
      if (isExempt(relative, id)) continue
      if (mentions(source, id)) pairs.push(`${id} ${relative}`)
    }
  }
  return { pairs, scanned: files.length, ids }
}

export function formatBaseline(pairs) {
  return [
    '# provider vendor ratchet baseline (docs/design/architecture-direction-2026-10.md §4 P0)',
    '# 每行 = 「<服务商 id> <文件>」:这家的名字出现在了它自己的 vendors/<id>/ 以外的这个文件里。',
    '# 只许减:出现这里没有的一对,`bun run provider:gate` 红。P3 结束时应为空。',
    '# 减了之后跑 `node scripts/provider-vendor-gate.mjs --write-baseline` 收紧。',
    ...[...pairs].sort(),
  ].join('\n') + '\n'
}

export function parseBaseline(text) {
  return text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
}

export function compare(baseline, current) {
  const base = new Set(baseline)
  const now = new Set(current)
  return {
    regressions: current.filter((pair) => !base.has(pair)),
    improvements: baseline.filter((pair) => !now.has(pair)),
  }
}

function selfTest() {
  const failures = []
  const expect = (label, condition) => { if (!condition) failures.push(label) }
  expect('字面量', mentions("const x = 'zhipu'", 'zhipu'))
  expect('对象键', mentions('const t = {\n  zhipu: [1],\n}', 'zhipu'))
  expect('带连字符的键', mentions("const t = { 'kimi-code': 1 }", 'kimi-code'))
  expect('标识符', mentions('export const ZHIPU_DIALS = {}', 'zhipu'))
  expect('驼峰标识符', mentions('readOnethingZhipuOptions(x)', 'zhipu'))
  expect('连字符 id 的标识符', mentions('const KIMI_CODE_X = 1', 'kimi-code'))
  expect('注释不算', !mentions('// zhipu\n/* ZHIPU */ const a = 1', 'zhipu'))
  expect('URL 里的域名不算', !mentions("const u = 'https://open.bigmodel.cn/x'", 'bigmodel'))
  expect('字符串里的 // 不吞后文', mentions("const u = 'https://x.y'; const zhipuX = 1", 'zhipu'))
  expect('协议名不算', !mentions('createOpenAIChatProvider(); const w = "openai-chat"', 'openai'))
  expect('gemini 线名不算', !mentions('const w = "gemini-generateContent"', 'gemini'))
  expect('gemini 本家标识符算', mentions('const GEMINI_DIALECT = 1', 'gemini'))
  const up = compare(['a x.ts'], ['a x.ts', 'a y.ts'])
  expect('新的一对算红', up.regressions.length === 1 && up.improvements.length === 0)
  const down = compare(['a x.ts', 'a y.ts'], ['a x.ts'])
  expect('少了一对算降', down.improvements.length === 1 && down.regressions.length === 0)
  expect('基线往返', parseBaseline(formatBaseline(['b y.ts', 'a x.ts'])).join('|') === 'a x.ts|b y.ts')
  if (failures.length > 0) {
    console.error('[provider-vendor-gate] self-test FAILED:')
    for (const label of failures) console.error('  ✗', label)
    process.exit(1)
  }
  console.log(`[provider-vendor-gate] self-test ok — 15 checks passed`)
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) return selfTest()

  const { pairs, scanned, ids } = measure()
  if (scanned < MIN_SCANNED_FILES) {
    console.error(`[provider-vendor-gate] 只扫到 ${scanned} 个文件(下限 ${MIN_SCANNED_FILES})—— 遍历坏了,不认这次结果。`)
    process.exit(1)
  }

  if (args.includes('--list')) {
    const byId = new Map(ids.map((id) => [id, []]))
    for (const pair of pairs) {
      const at = pair.indexOf(' ')
      byId.get(pair.slice(0, at)).push(pair.slice(at + 1))
    }
    console.log(`[provider-vendor] ${pairs.length} (vendor, file) pair(s) outside vendors/<id>/, ${ids.length} vendor(s), ${scanned} file(s) scanned:`)
    for (const [id, files] of byId) {
      console.log(`  ${String(files.length).padStart(3)}  ${id}`)
      if (args.includes('--verbose')) for (const file of files) console.log(`         ${file}`)
    }
    return
  }

  if (args.includes('--write-baseline')) {
    writeFileSync(baselinePath, formatBaseline(pairs), 'utf8')
    console.log(`[provider-vendor-gate] baseline written → ${path.relative(root, baselinePath)} (${pairs.length} pair(s))`)
    return
  }

  if (!existsSync(baselinePath)) {
    console.error(`[provider-vendor-gate] 基线不存在:${path.relative(root, baselinePath)}`)
    process.exit(1)
  }
  const { regressions, improvements } = compare(parseBaseline(readFileSync(baselinePath, 'utf8')), pairs)
  if (regressions.length > 0) {
    console.error(`[provider-vendor-gate] failed: ${regressions.length} new (vendor, file) pair(s) — 这家的名字不该出现在它的 vendors/<id>/ 以外:`)
    for (const pair of regressions) console.error(`  + ${pair}`)
    process.exit(1)
  }
  if (improvements.length > 0) {
    console.log(`[provider-vendor-gate] ok — ${improvements.length} pair(s) below baseline; run --write-baseline to tighten:`)
    for (const pair of improvements) console.log(`  - ${pair}`)
    return
  }
  console.log(`[provider-vendor-gate] ok — ${pairs.length} pair(s), at baseline`)
}

main()
