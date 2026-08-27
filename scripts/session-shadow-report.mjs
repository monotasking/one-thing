#!/usr/bin/env node
/**
 * 耐久门(refold)的报表 —— **F4-c c4 起是"仅 refold"口径**(§16.24)。
 *
 *   bun run sessions:shadow-report [--min-runs N] [--store PATH] [--json]
 *
 * ## c4 之前 / 之后
 *
 * 这份报表从 S1b 起同时服务两道门:语义层的**恒等门**(`kind: 'messages'` /
 * `'history'`,事件投影 vs 内存 store 两条独立推导)与耐久层的 **refold**
 * (`kind: 'refold'`,`events.jsonl` 的文件字节重折 vs 内存活投影)。
 *
 * c4 把恒等门退役了(读侧早已只有投影一条路,验证器侧没有了消费者 ——
 * 见 `packages/backend/session/shadow.ts` 的文件头)。于是:
 *
 *  - `mismatches` / `historyChecks` / `duplicates` / `skipped` / `byKind`
 *    **不再产生**。字段与判据全部留着 —— 老 `session-shadow-stats.json` 里的
 *    非零仍然必须是红,读老账不能读崩;
 *  - **今天唯一在跑的比对是 refold**,所以门多一条:`refoldChecks > 0`。
 *    少这一条,"那道门根本没跑"与"那道门全绿"在报表上长得一模一样。
 *
 * 读两份文件:
 *   `<store>/log/session-shadow-stats.json`  —— 计数(runs / refoldChecks / appendFailures / …)
 *   `<store>/log/session-shadow.jsonl`       —— 每一次不等的字段级摘要
 *
 * **门 = runs ≥ 200 ∧ refoldChecks > 0 ∧ refoldMismatches = 0 ∧ mismatches = 0
 * ∧ portMismatches = 0 ∧ accountMismatches = 0 ∧ appendFailures = 0**。`--min-runs` 只放宽第一条 ——
 * 分批验证时用得着。
 * 其余不给开关:一次不等就是一次"账本与内存分岔",没有"少量可接受"。
 *
 * `runs` 的产地在 c4 换过一次:从前是恒等门的 run 断言顺手记的一笔,现在由
 * `endSessionRun` 自己记(它回答的本来就是"这一轮跑了多少个 run")。判据一字未变。
 *
 * 摘要的两列:**A = `events.jsonl` 文件重折**,**B = 内存活投影**。老行
 * (`kind: 'messages'` / `'history'`,或缺 `truth` 标记的 F0 之前那批)照它当时的
 * 语义打印 —— 拿今天的名字贴老行等于把归因贴反。
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
      // c4:端口事实断言(`port-fact-assert.ts`)对不上的次数。**进门,必须是 0。**
      portMismatches: Number(parsed.portMismatches) || 0,
      // c4:断言真的比过几次(`portMismatches = 0` 的分母)。只打印,不进门。
      portChecks: Number(parsed.portChecks) || 0,
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
      // §17.7.1 批 2(#8b-i):会话账对拍。**批 3 起不再产生**(影子随切换退役,
      // 耐久判据并进 refold 那一栏);字段留着读老账,`accountMismatches` 仍进门。
      accountChecks: Number(parsed.accountChecks) || 0,
      accountMismatches: Number(parsed.accountMismatches) || 0,
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
      portMismatches: 0,
      portChecks: 0,
      duplicateMismatches: 0,
      projectionIssues: 0,
      droppedParts: 0,
      appendFailures: 0,
      refoldChecks: 0,
      refoldMismatches: 0,
      accountChecks: 0,
      accountMismatches: 0,
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
    // c4(§16.24):今天在跑的只有 refold —— A = events.jsonl 文件重折 / B = 内存活投影。
    console.log('[shadow] direction     : A = events 文件重折 / B = 内存活投影   [c4: 仅 refold]')
    if (stats.missing) console.log('[shadow] stats file absent — nothing has been recorded yet')
    console.log(`[shadow] runs           : ${stats.runs}   (run 粒度 —— 门只看它)`)
    console.log(`[shadow] historyChecks  : ${stats.historyChecks}   (恒等门遗留,c4 起恒为 0)`)
    console.log(`[shadow] mismatches     : ${stats.mismatches}   (恒等门遗留,c4 起恒为 0;老账非零仍红)`)
    // c4:A 类端口的逐格断言(默认只在开发/测试期与 ONETHING_SESSION_PORT_ASSERT=1 下跑)。
    console.log(`[shadow] portMismatches : ${stats.portMismatches}   (端口事实 vs 折叠值,比过 ${stats.portChecks} 次)`)
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
    console.log(`[shadow] refoldChecks   : ${stats.refoldChecks}   (采样次数 —— c4 起进门:必须 > 0)`)
    console.log(`[shadow] refoldMismatch : ${stats.refoldMismatches}`)
    console.log(`[shadow] accountMismatch: ${stats.accountMismatches}   (批 3 起并入 refold 栏;老账读数,比过 ${stats.accountChecks} 次)`)
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
  if (stats.portMismatches !== 0) failures.push(`portMismatches ${stats.portMismatches} ≠ 0`)
  if (stats.appendFailures !== 0) failures.push(`appendFailures ${stats.appendFailures} ≠ 0`)
  // S3w-2:refold 与 mismatches 同级 —— 一个是"写模型 vs 读模型",另一个是
  // "文件 vs 内存",停写之后两道都不许有"少量可接受"。
  if (stats.refoldMismatches !== 0) failures.push(`refoldMismatches ${stats.refoldMismatches} ≠ 0`)
  if (stats.accountMismatches !== 0) failures.push(`accountMismatches ${stats.accountMismatches} ≠ 0`)
  // c4:恒等门退役之后 refold 是唯一在跑的比对 —— "一次都没跑"与"全绿"在报表上
  // 长得一模一样,所以采样数本身进门。
  if (stats.runs >= args.minRuns && stats.refoldChecks === 0) {
    failures.push('refoldChecks 0 — 唯一在跑的那道门一次都没采样')
  }

  if (failures.length > 0) {
    console.error(`\n[shadow] GATE RED: ${failures.join('; ')}`)
    process.exit(1)
  }
  console.log(
    `\n[shadow] GATE GREEN (runs ≥ ${args.minRuns}, refoldChecks ${stats.refoldChecks} > 0, refoldMismatches = 0, `
    + `mismatches = 0, portMismatches = 0, accountMismatches = 0 (比过 ${stats.accountChecks} 次), `
    + 'appendFailures = 0)',
  )
}

if (import.meta.url === `file://${process.argv[1]}`) main()
