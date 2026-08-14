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
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = path.join(root, 'docs/audit/transport-baseline-2026-08-14.txt')

/** 四个壳文件：加一个域时历史上必须逐个改的那四处。 */
const SHELL_FILES = [
  'apps/server/src/http.ts',
  'apps/electron/src/preload/bridge.ts',
  'packages/renderer/platform/web.ts',
  'packages/shared/ipc/channels.ts',
]

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

function readShell(relativePath) {
  const absolute = path.join(root, relativePath)
  if (!existsSync(absolute)) {
    // 文件没了 ≠ 指标归零。真删掉了就该显式改基线，而不是让 gate 替你庆祝。
    throw new Error(`度量文件不存在：${relativePath} —— 若确已删除，请显式改基线`)
  }
  return readFileSync(absolute, 'utf8')
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
  return metrics
}

export function formatBaseline(metrics) {
  const lines = [
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

  if (failures.length > 0) {
    console.error('[transport-gate] self-test FAILED:')
    for (const label of failures) console.error('  ✗', label)
    process.exit(1)
  }
  console.log('[transport-gate] self-test ok — 7 checks passed')
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) return selfTest()

  const current = measure()

  if (args.includes('--write-baseline')) {
    writeFileSync(baselinePath, formatBaseline(current), 'utf8')
    console.log(`[transport-gate] baseline written → ${path.relative(root, baselinePath)}`)
    for (const key of Object.keys(current).sort()) console.log(`  ${key} = ${current[key]}`)
    return
  }

  if (!existsSync(baselinePath)) {
    console.error(`[transport-gate] 基线文件缺失：${path.relative(root, baselinePath)}`)
    console.error('  先跑一次 `bun run transport:gate --write-baseline` 生成它。')
    process.exit(1)
  }

  const baseline = parseBaseline(readFileSync(baselinePath, 'utf8'))
  if (Object.keys(baseline).length === 0) {
    console.error('[transport-gate] 基线解析为空 —— 格式坏了，不认这次结果')
    process.exit(1)
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
    console.error('  加功能请走 router 域（src/app/rpc/domains/），不要再加手写通道。')
    process.exit(1)
  }

  const total = Object.entries(current)
    .filter(([key]) => key.startsWith('lines:'))
    .reduce((sum, [, value]) => sum + value, 0)
  console.log(`[transport-gate] ok — IPC_CHANNELS ${current['channels:IPC_CHANNELS']} 个常量，四壳合计 ${total} 行,无上升`)
}

main()
