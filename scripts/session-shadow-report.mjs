#!/usr/bin/env node
/**
 * 影子期的门(S1b,`docs/design/session-event-sourcing-2026-08.md` §10.4)。
 *
 *   bun run sessions:shadow-report [--min-runs N] [--store PATH] [--json]
 *
 * 读两份文件:
 *   `<store>/log/session-shadow-stats.json`  —— 计数(runs / mismatches / appendFailures / byKind)
 *   `<store>/log/session-shadow.jsonl`       —— 每一次不等的字段级摘要
 *
 * **门 = runs ≥ 200 ∧ mismatches = 0 ∧ appendFailures = 0**(§10.4,按量不按天)。
 * `--min-runs` 只放宽第一条 —— 分批验证时用得着(S1b 自证跑的是 20)。另外两条
 * 不给开关:一次不等就是一次"S2 切读之后会看到另一段历史",没有"少量可接受"。
 *
 * `skipped` 只打印、**不进门**:跳过的是"没有可比的东西"(如老会话事件只覆盖
 * 历史尾巴 = `legacyPartial`),不是"比出来不等"。
 *
 * store 的解析与产品代码同口径:`--store` → `ONETHING_STORE_PATH` → `~/.onething`。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_MIN_RUNS = 200

function parseArgs(argv) {
  const args = { minRuns: DEFAULT_MIN_RUNS, store: undefined, json: false, top: 10, lastDiffs: 5 }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--min-runs') args.minRuns = Number(argv[++index])
    else if (arg.startsWith('--min-runs=')) args.minRuns = Number(arg.slice('--min-runs='.length))
    else if (arg === '--store') args.store = argv[++index]
    else if (arg.startsWith('--store=')) args.store = arg.slice('--store='.length)
    else if (arg === '--json') args.json = true
  }
  if (!Number.isFinite(args.minRuns) || args.minRuns < 0) args.minRuns = DEFAULT_MIN_RUNS
  return args
}

export function resolveStorePath(explicit) {
  return explicit || process.env.ONETHING_STORE_PATH || path.join(os.homedir(), '.onething')
}

export function readStats(logDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(logDir, 'session-shadow-stats.json'), 'utf8'))
    return {
      runs: Number(parsed.runs) || 0,
      mismatches: Number(parsed.mismatches) || 0,
      appendFailures: Number(parsed.appendFailures) || 0,
      byKind: parsed.byKind && typeof parsed.byKind === 'object' ? parsed.byKind : {},
      skipped: parsed.skipped && typeof parsed.skipped === 'object' ? parsed.skipped : {},
      lastMismatchAt: Number(parsed.lastMismatchAt) || undefined,
      updatedAt: Number(parsed.updatedAt) || undefined,
    }
  } catch {
    return { runs: 0, mismatches: 0, appendFailures: 0, byKind: {}, skipped: {}, missing: true }
  }
}

export function readShadowLines(logDir) {
  try {
    return fs
      .readFileSync(path.join(logDir, 'session-shadow.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

export function buildReport(logDir, options = {}) {
  const stats = readStats(logDir)
  const lines = readShadowLines(logDir)

  const bySession = new Map()
  for (const line of lines) {
    const entry = bySession.get(line.sessionId) ?? { sessionId: line.sessionId, mismatches: 0, kinds: {} }
    entry.mismatches += 1
    entry.kinds[line.kind] = (entry.kinds[line.kind] ?? 0) + 1
    bySession.set(line.sessionId, entry)
  }
  const top = [...bySession.values()]
    .sort((a, b) => b.mismatches - a.mismatches)
    .slice(0, options.top ?? 10)

  return {
    stats,
    top,
    lastDiffs: lines.slice(-(options.lastDiffs ?? 5)),
    lineCount: lines.length,
  }
}

function formatDiff(line) {
  const head = `  ${new Date(line.time).toISOString()}  ${line.kind}  session=${line.sessionId}${line.runId ? ` run=${line.runId}` : ''}`
  const body = (line.diff ?? [])
    .map(entry => `      ${entry.path}\n        A: ${entry.a ?? '(absent)'}\n        B: ${entry.b ?? '(absent)'}`)
    .join('\n')
  const more = line.truncated ? `\n      …(+${line.truncated} more)` : ''
  return `${head}\n${body}${more}`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const store = resolveStorePath(args.store)
  const logDir = path.join(store, 'log')
  const report = buildReport(logDir, { top: args.top, lastDiffs: args.lastDiffs })
  const { stats } = report

  if (args.json) {
    console.log(JSON.stringify({ store, ...report }, null, 2))
  } else {
    console.log(`[shadow] store: ${store}`)
    if (stats.missing) console.log('[shadow] stats file absent — nothing has been recorded yet')
    console.log(`[shadow] runs           : ${stats.runs}`)
    console.log(`[shadow] mismatches     : ${stats.mismatches}`)
    console.log(`[shadow] appendFailures : ${stats.appendFailures}`)
    console.log(`[shadow] byKind         : ${JSON.stringify(stats.byKind)}`)
    // 跳过 ≠ 不等:门只看 mismatches。列出来是为了让"这条会话为什么没被比"看得见
    // —— `legacyPartial` = 老会话的 events.jsonl 只覆盖了历史尾巴(§10.9)。
    console.log(`[shadow] skipped        : ${JSON.stringify(stats.skipped)}`)
    if (stats.lastMismatchAt) {
      console.log(`[shadow] lastMismatchAt : ${new Date(stats.lastMismatchAt).toISOString()}`)
    }
    console.log(`[shadow] shadow.jsonl   : ${report.lineCount} line(s)`)

    if (report.top.length > 0) {
      console.log('\n[shadow] top sessions by mismatches:')
      for (const entry of report.top) {
        console.log(`  ${entry.sessionId}  ${entry.mismatches}  ${JSON.stringify(entry.kinds)}`)
      }
    }
    if (report.lastDiffs.length > 0) {
      console.log('\n[shadow] last diffs:')
      for (const line of report.lastDiffs) console.log(formatDiff(line))
    }
  }

  const failures = []
  if (stats.runs < args.minRuns) failures.push(`runs ${stats.runs} < ${args.minRuns}`)
  if (stats.mismatches !== 0) failures.push(`mismatches ${stats.mismatches} ≠ 0`)
  if (stats.appendFailures !== 0) failures.push(`appendFailures ${stats.appendFailures} ≠ 0`)

  if (failures.length > 0) {
    console.error(`\n[shadow] GATE RED: ${failures.join('; ')}`)
    process.exit(1)
  }
  console.log(`\n[shadow] GATE GREEN (runs ≥ ${args.minRuns}, mismatches = 0, appendFailures = 0)`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
