#!/usr/bin/env node
// 服务商点名棘轮(方案 docs/design/architecture-direction-2026-10.md §4 P0)。
//
// 度量的是:**一家内置服务商的名字,出现在了它自己的家以外的哪些文件里。**
// 家 = `packages/backend/runtime/providers/vendors/<id>/`。家以外每多一个文件
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
import ts from 'typescript'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = path.join(root, 'docs/audit/provider-vendor-baseline-2026-10.txt')
const VENDORS_DIR = 'packages/backend/runtime/providers/vendors'
const LEGACY_MANIFESTS = 'packages/backend/runtime/providers/builtin-manifests.ts'

// 合包(server / client 拆分第②步)以后 core 与 runtime 是 `packages/backend` 的子树,扫它一棵就覆盖了
// 原来的三棵(再单列会把同一个文件扫两遍、同一对报两次)。
const SCAN_ROOTS = [
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
/**
 * 模型家族的家:「claude-* 型号会不会思考」「gemini 2.5 用哪种思考编码」这类知识说的是**型号**,
 * 不是哪一家服务商 —— 同一家族的型号由好几家卖(Copilot、OpenRouter、千问转售)。它们住
 * `providers/model-families/<family>.ts`,点家族的名是本分。
 */
const MODEL_FAMILY_DIR = /^packages\/backend\/runtime\/providers\/model-families\//

/** 登记处:每家一行,本来就该点名。 */
const REGISTRY_FILES = [
  /^packages\/backend\/runtime\/providers\/vendors\/[^/]+\.ts$/,
]

const NON_VENDOR_IDS = new Set(['acp'])

/**
 * 线协议 / 数据格式的名字(不是服务商)。命中这些的 token 不计。
 *
 * `OpenRouterModel`(P2 第 4 批加):全仓的模型目录行都是 OpenRouter `/models` 的那个形状
 * (`OnethingOpenRouterModel`、`openRouterModelToOnethingCapabilityEntry`……),说的是一种格式,
 * 与 OpenRouter 这一家服务商无关 —— 壳与 codex / copilot / grok 的目录代码都用它。
 */
const PROTOCOL_TOKENS = [
  /openai[-_]?(chat|responses|compatible|effort|o[-_]?series|file)/i,
  /gemini[-_]?(generateContent|wire|messages|level|budget|errors|recipe)/i,
  /openrouter[-_]?model/i,
]

/**
 * HTTP 头名(连字符分隔、每段首字母大写:`OpenAI-Intent`、`Copilot-Integration-Id`)是线上的字段名,
 * 由那一家的后台定义、只能照抄 —— 不是在点哪一家服务商的名(P2 第 4 批加)。整串是头名形状的
 * 字符串字面量不计;它里面的服务商名照样会在别的 token 上被认出来。
 */
const HTTP_HEADER_NAME = /^(?:[A-Z][A-Za-z0-9]*-)+[A-Z][A-Za-z0-9]*$/

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

/**
 * 一个文件里「像代码的文本」:用 TypeScript 自己的解析器取出标识符、字符串字面量、
 * 模板片段与正则字面量。注释不是语法节点,天然不在里面 —— 手写的注释剥离器会被正则
 * 字面量里的引号带偏(实测过),所以不手写。
 */
export function codeTokens(source, fileName = 'x.ts') {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const identifiers = []
  const strings = []
  const visit = (node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) identifiers.push(node.text)
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) strings.push(node.text)
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) strings.push(node.text)
    // 正则字面量不收:代码里的正则几乎都在认**模型 id**(`/^deepseek-v[34]/`、`/^kimi/`)——
    // 那是模型家族的知识(千问转售 DeepSeek / Kimi 的型号),不是在点服务商的名。
    else if (ts.isJsxText(node)) strings.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return { identifiers, strings }
}

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** id 的标识符形态:kimi-code → kimicode / kimi_code(大小写不敏感)。 */
function identifierPattern(id) {
  const parts = id.split('-').map(escape)
  return new RegExp(`[A-Za-z0-9_$]*${parts.join('_?')}[A-Za-z0-9_$]*`, 'gi')
}

/** 一段文本里有没有「点这一家的名」的词(协议名、模型路径的厂牌前缀、域名 / 路径片段除外)。 */
function textMentions(text, id) {
  for (const match of text.matchAll(identifierPattern(id))) {
    // 连字符词(`openai-chat`)整个拿来判协议名:标识符正则会停在 `-` 上。
    const tail = /^[-A-Za-z0-9_$]*/.exec(text.slice(match.index + match[0].length))[0]
    const token = match[0] + tail
    if (PROTOCOL_TOKENS.some((pattern) => pattern.test(token))) continue
    // 域名、路径、连字符词的一段(open.bigmodel.cn/…、`@deepseek-ai/…` 的后半)。
    const before = text[match.index - 1]
    if (before === '.' || before === '/' || before === '-') continue
    // `'openai/gpt-4o'` 这类是模型路径里的厂牌前缀(models.dev 的写法),不是在点服务商的名。
    if (text[match.index + token.length] === '/') continue
    return true
  }
  return false
}

export function mentions(source, id, fileName = 'x.ts') {
  const { identifiers, strings } = codeTokens(source, fileName)
  if (strings.some((text) => text === id)) return true
  if (identifiers.some((name) => textMentions(name, id))) return true
  return strings.some((text) => !HTTP_HEADER_NAME.test(text) && textMentions(text, id))
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
  // 同家的订阅半边住在 `<id>-<tag>/`(kimi-code、grok-oauth、claude-code),它认识本家是家事。
  if (relative.startsWith(`${VENDORS_DIR}/${id}-`)) return true
  if (RENDER_FILES.some((pattern) => pattern.test(relative))) return true
  if (MODEL_FAMILY_DIR.test(relative)) return true
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
      if (mentions(source, id, relative)) pairs.push(`${id} ${relative}`)
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
  expect('正则里的引号不让后面的注释漏进来', !mentions("const r = /['\"]/\n/** zhipu */\nconst b = 2", 'zhipu'))
  expect('URL 里的域名不算', !mentions("const u = 'https://open.bigmodel.cn/x'", 'bigmodel'))
  expect('字符串里的 // 不吞后文', mentions("const u = 'https://x.y'; const zhipuX = 1", 'zhipu'))
  expect('协议名不算', !mentions('createOpenAIChatProvider(); const w = "openai-chat"', 'openai'))
  expect('gemini 线名不算', !mentions('const w = "gemini-generateContent"', 'gemini'))
  expect('gemini 本家标识符算', mentions('const GEMINI_DIALECT = 1', 'gemini'))
  expect('模型路径的厂牌前缀不算', !mentions("const m = 'openai/gpt-4o'", 'openai'))
  expect('认模型 id 的正则不算', !mentions('const r = /^deepseek-v[34]/', 'deepseek'))
  expect('目录行格式名不算', !mentions('const m: OnethingOpenRouterModel[] = []', 'openrouter'))
  expect('HTTP 头名不算', !mentions('const h = { "OpenAI-Intent": "conversation-panel" }', 'openai'))
  expect('普通字符串里的家名照算', mentions('const d = "Most capable OpenAI model"', 'openai'))
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
  console.log(`[provider-vendor-gate] self-test ok — 21 checks passed`)
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

// 作为脚本跑才执行;被 import(测试、排查)时只交出函数。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
