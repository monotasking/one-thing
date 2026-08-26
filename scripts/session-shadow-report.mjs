#!/usr/bin/env node
/**
 * 恒等门(S1b 立为影子期的门 §10.4;F0 转向后是写模型 vs 读模型的常驻合同,§16.2)。
 *
 *   bun run sessions:shadow-report [--min-runs N] [--store PATH] [--json]
 *
 * ## 方向(F0,2026-08-27)
 *
 * 摘要的两列:**A = 事件侧(真相)**,**B = 内存 store / reducer(影子验证器)**;
 * `kind:'refold'` 那一类的 A 是 `events.jsonl` 的文件重折、B 是内存活投影。
 * 一次不等默认读成"**写模型没跟上账本**",不是"投影错了"。
 * 每行带 `truth:'events'` 的方向标记 —— **缺这个字段的行是 F0 之前记的**,
 * 它的两列语义正好相反(报表把两种行分开数出来给人看)。
 *
 * 读两份文件:
 *   `<store>/log/session-shadow-stats.json`  —— 计数(runs / mismatches / appendFailures / byKind)
 *   `<store>/log/session-shadow.jsonl`       —— 每一次不等的字段级摘要
 *
 * **门 = runs ≥ 200 ∧ mismatches = 0 ∧ appendFailures = 0 ∧ refoldMismatches = 0**
 * (§10.4 立的前三条,§14.3-B 加的第四条:refold 自洽环是停写之后耐久层的替身)。
 * `--min-runs` 只放宽第一条 —— 分批验证时用得着(S1b 自证跑的是 20)。另外两条
 * 不给开关:一次不等就是一次"S2 切读之后会看到另一段历史",没有"少量可接受"。
 *
 * `skipped` 只打印、**不进门**:跳过的是"没有可比的东西"(如老会话事件只覆盖
 * 历史尾巴 = `legacyPartial`),不是"比出来不等"。
 *
 * `historyChecks` / `duplicates` 同样只打印(F9,§13.2/§13.4):
 *   - `runs` 是 **run 粒度**(每个 run 收尾比一次消息),门数的是它;
 *   - `historyChecks` 是**请求粒度**(每轮请求比一次历史),一个 run 能有十几次
 *     —— 两个数分开摆着,免得"200 个干净 run"被当成"比过 200 次历史";
 *   - `duplicates` 是同一个 run 里**同一处**不等在后续每轮请求上的重复,已折叠。
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
      // F9(§13.2):历史断言是**每次请求**跑的,次数与 run 数不是一回事。
      // 分开打印,免得"200 个干净 run"被读成"比过 200 次历史"。
      historyChecks: Number(parsed.historyChecks) || 0,
      mismatches: Number(parsed.mismatches) || 0,
      duplicateMismatches: Number(parsed.duplicateMismatches) || 0,
      // F6/F13(§13.6):退化与丢账各一个数。老账单缺这两格读成 0,不读崩。
      projectionIssues: Number(parsed.projectionIssues) || 0,
      droppedParts: Number(parsed.droppedParts) || 0,
      appendFailures: Number(parsed.appendFailures) || 0,
      // S3w-1(§15.4):`events` 读模式下退回抄本的次数。不进门 —— 它量的是
      // 存量数据的覆盖面;S3w-3 删兜底之前必须先量到 0。
      // S3w-2(§14.3-B):refold 自洽环。`refoldChecks` 只打印(采样数是配置
      // 问题),`refoldMismatches` **进门** —— 它是停写之后耐久层的唯一判据。
      refoldChecks: Number(parsed.refoldChecks) || 0,
      refoldMismatches: Number(parsed.refoldMismatches) || 0,
      byKind: parsed.byKind && typeof parsed.byKind === 'object' ? parsed.byKind : {},
      skipped: parsed.skipped && typeof parsed.skipped === 'object' ? parsed.skipped : {},
      lastMismatchAt: Number(parsed.lastMismatchAt) || undefined,
      updatedAt: Number(parsed.updatedAt) || undefined,
    }
  } catch {
    return {
      runs: 0,
      historyChecks: 0,
      mismatches: 0,
      duplicateMismatches: 0,
      projectionIssues: 0,
      droppedParts: 0,
      appendFailures: 0,
      refoldChecks: 0,
      refoldMismatches: 0,
      byKind: {},
      skipped: {},
      missing: true,
    }
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
  // F0:方向标记的分布。`legacy` = F0 转向之前记的行(没有 `truth` 字段),
  // 它的 A/B 两列语义与今天相反 —— 只打印,不进门。
  const directions = { events: 0, legacy: 0 }
  for (const line of lines) {
    if (line.truth === 'events') directions.events += 1
    else directions.legacy += 1
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
    directions,
    lastDiffs: lines.slice(-(options.lastDiffs ?? 5)),
    lineCount: lines.length,
  }
}

/**
 * 两列的名字随方向标记走。F0 之前的行(无 `truth`)照它当时的语义打印 ——
 * 拿今天的名字去贴老行,等于把归因贴反。
 */
function diffColumnLabels(line) {
  if (line.truth !== 'events') return { a: 'A(store, 旧方向)', b: 'B(events, 旧方向)' }
  if (line.kind === 'refold') return { a: 'A(events 文件重折)', b: 'B(内存活投影)' }
  return { a: 'A(events 真相)', b: 'B(store 验证器)' }
}

function formatDiff(line) {
  const head = `  ${new Date(line.time).toISOString()}  ${line.kind}  session=${line.sessionId}${line.runId ? ` run=${line.runId}` : ''}`
  const labels = diffColumnLabels(line)
  const body = (line.diff ?? [])
    .map(entry => `      ${entry.path}\n        ${labels.a}: ${entry.a ?? '(absent)'}\n        ${labels.b}: ${entry.b ?? '(absent)'}`)
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
    // F0(§16.2):这道门今天问的是"写模型跟上账本了吗",不是"投影对不对"。
    console.log('[shadow] direction     : A = events(真相) / B = store(影子验证器)   [F0]')
    if (stats.missing) console.log('[shadow] stats file absent — nothing has been recorded yet')
    console.log(`[shadow] runs           : ${stats.runs}   (run 粒度 —— 门只看它)`)
    console.log(`[shadow] historyChecks  : ${stats.historyChecks}   (请求粒度,一个 run 可有多次)`)
    console.log(`[shadow] mismatches     : ${stats.mismatches}`)
    // 同 run 同一处不等在后续每轮请求上重复出现 —— 折叠掉的次数(F9)。不进门。
    console.log(`[shadow] duplicates     : ${stats.duplicateMismatches}   (同 run 同一处,已折叠)`)
    // F6:投影退化(blob 换不回来 / 回合重放掉回 collapsed)。**不进门** ——
    // 它常常两侧同时退化因而仍然相等,而那正是它危险的地方。
    console.log(`[shadow] projectionIssues: ${stats.projectionIssues}   (投影退化,不进门)`)
    // F13:记录器丢掉的 part/批次。同样只打印。
    console.log(`[shadow] droppedParts    : ${stats.droppedParts}   (采集点丢账,不进门)`)
    console.log(`[shadow] appendFailures : ${stats.appendFailures}`)
    // S3w-1:兜底命中(events 模式下退回 messages.jsonl 的读)。不进门,S3w-3 前要量到 0。
    // S3w-2:refold 自洽环(文件字节重折 vs 内存活投影)。采样数只打印;
    // 不等**进门** —— 停写之后它就是耐久层仅剩的那道门(§14.3-B)。
    console.log(`[shadow] refoldChecks   : ${stats.refoldChecks}   (采样次数,不进门)`)
    console.log(`[shadow] refoldMismatch : ${stats.refoldMismatches}`)
    console.log(`[shadow] byKind         : ${JSON.stringify(stats.byKind)}`)
    // 跳过 ≠ 不等:门只看 mismatches。列出来是为了让"这条会话为什么没被比"看得见
    // —— `legacyPartial` = 老会话的 events.jsonl 只覆盖了历史尾巴(§10.9)。
    console.log(`[shadow] skipped        : ${JSON.stringify(stats.skipped)}`)
    if (stats.lastMismatchAt) {
      console.log(`[shadow] lastMismatchAt : ${new Date(stats.lastMismatchAt).toISOString()}`)
    }
    console.log(`[shadow] shadow.jsonl   : ${report.lineCount} line(s)`)
    // F0:老行(无 `truth` 标记)的 A/B 两列语义是反的 —— 数出来,别让人读反。
    console.log(
      `[shadow] lineDirections  : ${report.directions.events} events`
      + `${report.directions.legacy ? ` / ${report.directions.legacy} pre-F0(A/B 相反)` : ''}`,
    )

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
  // S3w-2:refold 与 mismatches 同级 —— 一个是"写模型 vs 读模型",另一个是
  // "文件 vs 内存",停写之后两道都不许有"少量可接受"。
  if (stats.refoldMismatches !== 0) failures.push(`refoldMismatches ${stats.refoldMismatches} ≠ 0`)

  if (failures.length > 0) {
    console.error(`\n[shadow] GATE RED: ${failures.join('; ')}`)
    process.exit(1)
  }
  console.log(
    `\n[shadow] GATE GREEN (runs ≥ ${args.minRuns}, mismatches = 0, appendFailures = 0, refoldMismatches = 0)`,
  )
}

if (import.meta.url === `file://${process.argv[1]}`) main()
