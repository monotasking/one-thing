#!/usr/bin/env node
// Transport ratchet gate (主线 T1, docs/design/dsh-architecture-adoption-2026-08.md §3).
//
// 度量传输面的「壳税」：手写 IPC 通道常量的个数，以及四个壳文件的行数。
// 规矩只有一条：**只许降不许升**。新功能想加一条手写通道，这里就红；域迁到
// 通用 RPC 通道后指标下降，脚本提示可以收紧基线（`--write-baseline` 更新）。
//
// 和 boundary-gate 的区别：那把尺子比的是「失败行集合」，这把尺子比的是**数值**，
// 所以不需要剥 ANSI，也不存在「解析不出任何行 = 假绿」那个坑 —— 但同类的坑换了
// 个样子：文件读不到时若当成 0，指标会「暴跌」，看起来像大胜利。所以读不到 =
// 硬错，而不是 0。
//
// ---- 2026-09-03 B0(docs/design/backend-transport-forks-2026-09.md §2.4)----
// 加两把尺子，量的是**另一种壳税**：不再是「手写了几条通道」，而是「有多少处
// 代码把 `transport` 当成了它答不了的问题」。
//
//  · `forks:<域文件>` —— `packages/backend/rpc/domains/*.ts` 里逐文件计数
//    `context.transport` 的读法(注释与字符串先剥掉)。B 期的整件事就是把
//    「http 就拒 / http 就假态」改成问端口(这台宿主有没有这个外设)与问信任
//    (`isHostLocallyTrusted`)，所以这些计数只许降。基线里没有的域文件出现
//    读法 = 红(否则新开一个域就能绕开)。
//  · `ipcMain:apps/desktop-react/electron` —— 新壳的手写 IPC 通道个数，今天
//    应当只有 `host:connection` 一条(渲染层其余全走 HTTP/SSE)。
//
// 这两把尺子的基线**另开一份文件**(`transport-forks-baseline-2026-09-03.txt`)：
// 老那份的注释里压着一年的收紧史，而 `--write-baseline` 是整文件重写 —— B1 起
// 每期都要收紧，不能每次把那段历史冲掉。顺手也把重写改成**保留原文件的注释行**，
// 老那份即便被写一次也不会失忆。
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = path.join(root, 'docs/audit/transport-baseline-2026-08-14.txt')
const forksBaselinePath = path.join(root, 'docs/audit/transport-forks-baseline-2026-09-03.txt')

/** 四个壳文件：加一个域时历史上必须逐个改的那四处。 */
const SHELL_FILES = [
  'packages/backend/server/http.ts',
  'apps/electron/src/preload/bridge.ts',
  'packages/renderer/platform/web.ts',
  'packages/shared/ipc/channels.ts',
]

/** RPC 域目录：`forks:` 那把尺子的扫描根。 */
const DOMAINS_DIR = 'packages/backend/rpc/domains'
/** 扫描规模下限：遍历坏了长得像「全治愈了」。 */
const MIN_DOMAIN_FILES = 30

/** React 壳的主进程目录：`ipcMain:` 那把尺子的扫描根。 */
const SHELL_ELECTRON_DIR = 'apps/desktop-react/electron'
const IPC_MAIN_METRIC = `ipcMain:${SHELL_ELECTRON_DIR}`

/** `forks:` 是逐文件计数：文件从基线里消失 = 降到 0，是好事，不是「采不到」。 */
export function absentMeansZero(key) {
  return key.startsWith('forks:')
}

/**
 * 数 `IPC_CHANNELS` 里的常量个数。
 *
 * 不用「数冒号」那种糙办法：通道值本身就是 `"chat:get-history"` 这类带冒号的
 * 字符串，注释里也有冒号，数出来的是噪声不是指标。这里先用花括号配对切出对象
 * 体，再剥注释与字符串，最后只认 `SCREAMING_SNAKE:` 这一种键形。
 */
export function countChannelConstants(source) {
  const anchor = source.indexOf('IPC_CHANNELS')
  if (anchor < 0) throw new Error('channels.ts 里找不到 IPC_CHANNELS —— 指标已失效，不认这次结果')
  const open = source.indexOf('{', anchor)
  if (open < 0) throw new Error('IPC_CHANNELS 后面没有对象字面量 —— 指标已失效')

  // 花括号配对时要跳过字符串和注释，否则值里的 `{` 会把配对带偏。
  let depth = 0
  let i = open
  let close = -1
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      i = source.indexOf('\n', i)
      if (i < 0) break
      continue
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end < 0 ? source.length : end + 2
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i += 1
      while (i < source.length && source[i] !== ch) {
        if (source[i] === '\\') i += 1
        i += 1
      }
      i += 1
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        close = i
        break
      }
    }
    i += 1
  }
  if (close < 0) throw new Error('IPC_CHANNELS 对象没有闭合 —— 指标已失效')

  const body = source
    .slice(open + 1, close)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")

  const keys = new Set()
  for (const match of body.matchAll(/(^|[,{])\s*([A-Z][A-Z0-9_]*)\s*:/g)) {
    keys.add(match[2])
  }
  return keys.size
}

/**
 * 剥掉注释与字符串字面量，只留代码字符。
 *
 * 为什么两样一起剥：单剥注释会被 `'https://…'` 这类字符串里的 `//` 带偏，单剥
 * 字符串会被 `// don't` 这种注释里的撇号带偏。所以只能一遍扫过去按状态机走。
 * 换行保留(行号不重要，但保留了才不会把两行粘成一行制造假匹配)。
 */
export function stripCommentsAndStrings(source) {
  let out = ''
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      const nl = source.indexOf('\n', i)
      if (nl < 0) break
      out += '\n'
      i = nl + 1
      continue
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end < 0 ? source.length : end + 2
      out += ' '
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      i += 1
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i += 1
        i += 1
      }
      i += 1
      out += '""'
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/**
 * 数一个域文件里读了几次**派发上下文的** `transport`。
 *
 * 认的是 `context.transport` / `context?.transport`(以及同义的 `ctx` /
 * `dispatchContext` / `rpcContext` 命名，免得改个形参名就能绕开)。
 *
 * **不认别的 `.transport`**：`mcp.ts` 里 `request.config?.transport === 'stdio'`
 * 问的是「这台 MCP server 用哪种传输起」，与派发上下文毫无关系；把它数进来，
 * 方案 §2.4 给 mcp 定的目标基线 3 就永远到不了。
 */
export function countContextTransportReads(source) {
  const code = stripCommentsAndStrings(source)
  const matches = code.match(/\b(?:context|ctx|dispatchContext|rpcContext)\s*\??\s*\.\s*transport\b/g)
  return matches ? matches.length : 0
}

/** 数一个壳文件里手写了几条 `ipcMain` 通道(`handle` + `on`)。 */
export function countIpcMainChannels(source) {
  const code = stripCommentsAndStrings(source)
  const matches = code.match(/\bipcMain\s*\.\s*(?:handle|on)\s*\(/g)
  return matches ? matches.length : 0
}

function readShell(relativePath) {
  const absolute = path.join(root, relativePath)
  if (!existsSync(absolute)) {
    // 文件没了 ≠ 指标归零。真删掉了就该显式改基线，而不是让 gate 替你庆祝。
    throw new Error(`度量文件不存在：${relativePath} —— 若确已删除，请显式改基线`)
  }
  return readFileSync(absolute, 'utf8')
}

/** 列出一个目录里的 `.ts` 文件(不递归、不含测试)。目录不存在 = 硬错。 */
function listTsFiles(relativeDir) {
  const absolute = path.join(root, relativeDir)
  if (!existsSync(absolute)) {
    throw new Error(`度量目录不存在：${relativeDir} —— 若确已搬家，请显式改脚本`)
  }
  return readdirSync(absolute)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
    .sort()
}

/** 采一次当前指标。键名即基线文件里的行首。 */
export function measure(readFile = readShell) {
  const metrics = {}
  for (const relativePath of SHELL_FILES) {
    const source = readFile(relativePath)
    metrics[`lines:${relativePath}`] = source.split('\n').length
    if (relativePath.endsWith('shared/ipc/channels.ts')) {
      metrics['channels:IPC_CHANNELS'] = countChannelConstants(source)
    }
  }

  const domainFiles = listTsFiles(DOMAINS_DIR)
  if (domainFiles.length < MIN_DOMAIN_FILES) {
    throw new Error(
      `只扫到 ${domainFiles.length} 个 RPC 域文件(下限 ${MIN_DOMAIN_FILES})—— 遍历坏了，不认这次结果`,
    )
  }
  for (const name of domainFiles) {
    const relativePath = `${DOMAINS_DIR}/${name}`
    const n = countContextTransportReads(readFile(relativePath))
    // 0 不入表：域文件治愈后就该从基线里消失，而不是留一行 `… 0`。
    if (n > 0) metrics[`forks:${relativePath}`] = n
  }

  let ipcMain = 0
  for (const name of listTsFiles(SHELL_ELECTRON_DIR)) {
    ipcMain += countIpcMainChannels(readFile(`${SHELL_ELECTRON_DIR}/${name}`))
  }
  // 这一格恒有(不像 forks 逐文件)：新壳一条通道都不剩也要看得见是 0。
  metrics[IPC_MAIN_METRIC] = ipcMain

  return metrics
}

/** 一份基线里放哪些指标：`forks:` / `ipcMain:` 归 B0 的新文件，其余归老文件。 */
export function isForksMetric(key) {
  return key.startsWith('forks:') || key.startsWith('ipcMain:')
}

export function formatBaseline(metrics, existingText) {
  // 老基线文件的注释里压着一年的收紧史，整文件重写不该把它冲掉。
  const preserved = existingText
    ? existingText.split('\n').filter((line) => line.trim().startsWith('#'))
    : []
  const lines = preserved.length > 0
    ? preserved
    : [
        '# transport ratchet baseline (主线 T1)',
        '# 只许降不许升。降了之后跑 `bun run transport:gate --write-baseline` 收紧。',
        '# 生成于 2026-08-14；每一行是 `<指标名> <数值>`。',
      ]
  for (const key of Object.keys(metrics).sort()) {
    lines.push(`${key} ${metrics[key]}`)
  }
  return `${lines.join('\n')}\n`
}

export function parseBaseline(text) {
  const metrics = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const at = line.lastIndexOf(' ')
    if (at < 0) continue
    const key = line.slice(0, at).trim()
    const value = Number.parseInt(line.slice(at + 1).trim(), 10)
    if (!key || Number.isNaN(value)) continue
    metrics[key] = value
  }
  return metrics
}

/**
 * 纯比较：只回报，不打印、不退出。棘轮的全部判据在这一个函数里，
 * `--self-test` 也只需要喂它两个对象。
 */
export function compare(baseline, current) {
  const regressions = []
  const improvements = []
  const missing = []
  for (const key of Object.keys(baseline)) {
    if (!(key in current)) {
      // `forks:` 是逐文件计数：文件从当前表里消失 = 那个域治愈了(降到 0)。
      // 其余指标(四个壳文件的行数、通道常量数)采不到 = 口径坏了，硬错。
      if (absentMeansZero(key)) {
        if (baseline[key] > 0) improvements.push({ key, baseline: baseline[key], current: 0 })
        continue
      }
      missing.push(key)
      continue
    }
    if (current[key] > baseline[key]) {
      regressions.push({ key, baseline: baseline[key], current: current[key] })
    } else if (current[key] < baseline[key]) {
      improvements.push({ key, baseline: baseline[key], current: current[key] })
    }
  }
  // 基线里没有的新指标一律当红：不然新加一个壳文件就能绕开棘轮。
  for (const key of Object.keys(current)) {
    if (!(key in baseline)) {
      regressions.push({ key, baseline: 0, current: current[key] })
    }
  }
  return { regressions, improvements, missing }
}

function selfTest() {
  const failures = []
  const expect = (label, condition) => {
    if (!condition) failures.push(label)
  }

  // 1) 常量计数认得出键，也不会被值里的冒号/注释里的冒号骗到。
  const fixture = `
export const IPC_CHANNELS = {
  /** doc: with a colon */
  RPC_INVOKE: "rpc:invoke",
  // line comment: also a colon
  GET_CHAT_HISTORY: "chat:get-history",
  NESTED_FREE: "a{b}c",
} as const
export const OTHER = { NOT_COUNTED: 'x:y' }
`
  expect('countChannelConstants 应为 3', countChannelConstants(fixture) === 3)

  // 2) 升 → 红。
  const up = compare({ 'channels:IPC_CHANNELS': 10 }, { 'channels:IPC_CHANNELS': 11 })
  expect('指标上升应产生 regression', up.regressions.length === 1 && up.improvements.length === 0)

  // 3) 降 → 绿，且提示可收紧。
  const down = compare({ 'channels:IPC_CHANNELS': 10 }, { 'channels:IPC_CHANNELS': 7 })
  expect('指标下降应产生 improvement 且无 regression',
    down.improvements.length === 1 && down.regressions.length === 0)

  // 4) 平 → 什么也不报。
  const flat = compare({ 'lines:a.ts': 5 }, { 'lines:a.ts': 5 })
  expect('指标持平应两边都空', flat.regressions.length === 0 && flat.improvements.length === 0)

  // 5) 基线里没有的新指标算红（防止「新开一个壳文件」绕过棘轮）。
  const added = compare({ 'lines:a.ts': 5 }, { 'lines:a.ts': 5, 'lines:b.ts': 3 })
  expect('新增指标应算 regression', added.regressions.length === 1)

  // 6) 度量文件读不到 = 硬错，不是 0。
  let threw = false
  try {
    measure(() => { throw new Error('missing') })
  } catch { threw = true }
  expect('读不到度量文件应抛错', threw)

  // 7) 基线序列化 / 反序列化是一对。
  const round = parseBaseline(formatBaseline({ 'channels:IPC_CHANNELS': 42, 'lines:x.ts': 7 }))
  expect('基线往返应无损', round['channels:IPC_CHANNELS'] === 42 && round['lines:x.ts'] === 7)

  // ---- B0 的两把新尺子 ----

  // 8) 域文件计数：注释里的读法不算；`request.config?.transport` 不是派发上下文。
  const domainFixture = [
    "// if (context.transport === 'http') 注释里的不算",
    '/* 块注释里的 context.transport 也不算 */',
    "const url = 'https://x/?transport=http' // 字符串里的 transport 不算",
    "  if (context.transport === 'http') return failure()",
    "  if (context?.transport !== 'http') return null",
    "  const stdio = request.config?.transport === 'stdio'",
    '  log.info("x", { transport: context.transport })',
  ].join('\n')
  expect('countContextTransportReads 应为 3', countContextTransportReads(domainFixture) === 3)

  // 9) 多一处读法 → 红(棘轮的主判据)。
  const oneMore = compare(
    { 'forks:packages/backend/rpc/domains/voice.ts': 1 },
    { 'forks:packages/backend/rpc/domains/voice.ts': 2 },
  )
  expect('域文件多一处读法应产生 regression', oneMore.regressions.length === 1)

  // 10) 基线外的域文件出现读法 → 红。
  const newDomain = compare(
    { 'forks:packages/backend/rpc/domains/voice.ts': 1 },
    {
      'forks:packages/backend/rpc/domains/voice.ts': 1,
      'forks:packages/backend/rpc/domains/agents.ts': 1,
    },
  )
  expect('基线外域文件应算 regression',
    newDomain.regressions.length === 1
    && newDomain.regressions[0].key.endsWith('agents.ts'))

  // 11) 域文件治愈(从当前表里消失)= improvement，不是「采不到」硬错。
  const healed = compare({ 'forks:packages/backend/rpc/domains/voice.ts': 1 }, {})
  expect('域文件清零应算 improvement 且不算 missing',
    healed.improvements.length === 1 && healed.missing.length === 0 && healed.regressions.length === 0)

  // 12) 四个壳文件那类指标采不到仍是硬错(口径坏了 ≠ 治愈)。
  const gone = compare({ 'lines:a.ts': 5 }, {})
  expect('壳文件指标采不到应算 missing', gone.missing.length === 1)

  // 13) desktop-react 多一条手写 IPC 通道 → 红。
  const shellFixture = [
    "ipcMain.handle('host:connection', async () => ({}))",
    "// ipcMain.handle('注释里的不算', …)",
    "ipcMain.on('terminal:write', () => {})",
  ].join('\n')
  expect('countIpcMainChannels 应为 2', countIpcMainChannels(shellFixture) === 2)
  const moreIpc = compare({ [IPC_MAIN_METRIC]: 1 }, { [IPC_MAIN_METRIC]: 2 })
  expect('新壳多一条 ipcMain 应产生 regression', moreIpc.regressions.length === 1)

  // 14) 重写基线时保留原文件的注释行(老那份压着一年的收紧史)。
  const rewritten = formatBaseline(
    { 'lines:a.ts': 1 },
    '# 历史一\n# 历史二\nlines:a.ts 9\n',
  )
  expect('重写基线应保留原注释',
    rewritten.includes('# 历史一') && rewritten.includes('# 历史二')
    && rewritten.includes('lines:a.ts 1'))

  // 15) 指标分家：`forks:` / `ipcMain:` 归新基线文件，其余归老的。
  expect('指标分家判据正确',
    isForksMetric('forks:x.ts') && isForksMetric(IPC_MAIN_METRIC)
    && !isForksMetric('lines:x.ts') && !isForksMetric('channels:IPC_CHANNELS'))

  if (failures.length > 0) {
    console.error('[transport-gate] self-test FAILED:')
    for (const label of failures) console.error('  ✗', label)
    process.exit(1)
  }
  console.log('[transport-gate] self-test ok — 15 checks passed')
}

/** 把一次采样按基线文件分成两半。 */
function splitMetrics(metrics) {
  const shell = {}
  const forks = {}
  for (const [key, value] of Object.entries(metrics)) {
    if (isForksMetric(key)) forks[key] = value
    else shell[key] = value
  }
  return { shell, forks }
}

function writeOneBaseline(targetPath, metrics, label) {
  const existing = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : undefined
  writeFileSync(targetPath, formatBaseline(metrics, existing), 'utf8')
  console.log(`[transport-gate] ${label} baseline written → ${path.relative(root, targetPath)}`)
  for (const key of Object.keys(metrics).sort()) console.log(`  ${key} = ${metrics[key]}`)
}

function readOneBaseline(targetPath, label) {
  if (!existsSync(targetPath)) {
    console.error(`[transport-gate] 基线文件缺失：${path.relative(root, targetPath)}(${label})`)
    console.error('  先跑一次 `bun run transport:gate --write-baseline` 生成它。')
    process.exit(1)
  }
  const parsed = parseBaseline(readFileSync(targetPath, 'utf8'))
  if (Object.keys(parsed).length === 0) {
    console.error(`[transport-gate] 基线解析为空(${label})—— 格式坏了，不认这次结果`)
    process.exit(1)
  }
  return parsed
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) return selfTest()

  const current = measure()
  const split = splitMetrics(current)

  if (args.includes('--write-baseline')) {
    writeOneBaseline(baselinePath, split.shell, '壳税')
    writeOneBaseline(forksBaselinePath, split.forks, 'transport 分叉')
    return
  }

  const baseline = {
    ...readOneBaseline(baselinePath, '壳税'),
    ...readOneBaseline(forksBaselinePath, 'transport 分叉'),
  }

  const { regressions, improvements, missing } = compare(baseline, current)

  if (missing.length > 0) {
    console.error(`[transport-gate] ${missing.length} 个基线指标这次采不到（度量口径变了？）：`)
    for (const key of missing) console.error('  ?', key)
    process.exit(1)
  }

  if (improvements.length > 0) {
    console.log(`[transport-gate] ${improvements.length} 个指标下降 —— 可以收紧基线（--write-baseline）：`)
    for (const item of improvements) {
      console.log(`  - ${item.key}: ${item.baseline} → ${item.current} (-${item.baseline - item.current})`)
    }
  }

  if (regressions.length > 0) {
    console.error(`[transport-gate] ${regressions.length} 个指标上升 —— 传输面在长胖：`)
    for (const item of regressions) {
      console.error(`  + ${item.key}: ${item.baseline} → ${item.current} (+${item.current - item.baseline})`)
    }
    console.error('  加功能请走 router 域（packages/backend/rpc/domains/），不要再加手写通道。')
    console.error('  域里想按 transport 分叉：外设问 host-ports 的布尔访问器，信任问 isHostLocallyTrusted()')
    console.error('  —— 见 docs/design/backend-transport-forks-2026-09.md §2.1。')
    process.exit(1)
  }

  const total = Object.entries(current)
    .filter(([key]) => key.startsWith('lines:'))
    .reduce((sum, [, value]) => sum + value, 0)
  const forkFiles = Object.keys(split.forks).filter((key) => key.startsWith('forks:'))
  const forkTotal = forkFiles.reduce((sum, key) => sum + current[key], 0)
  console.log(
    `[transport-gate] ok — IPC_CHANNELS ${current['channels:IPC_CHANNELS']} 个常量，四壳合计 ${total} 行,`
    + ` RPC 域 transport 读法 ${forkTotal} 处 / ${forkFiles.length} 文件,`
    + ` 新壳 ipcMain ${current[IPC_MAIN_METRIC]} 条,无上升`,
  )
}

main()
