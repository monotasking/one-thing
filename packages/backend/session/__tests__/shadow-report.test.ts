/**
 * S1b:`sessions:shadow-report` 的门(§10.4)。
 *
 * 这道门是 S2 切读的**唯一**放行条件,所以它自己必须被钉住:统计读得对、
 * top10 排得对、三条判据(runs / mismatches / appendFailures)缺一不可。
 * 用例喂的是一个真的 fixture 目录 —— 脚本读的就是这两个文件。
 *
 * 脚本住在 `scripts/`(vitest 的 include 只扫 packages/apps),所以这里按相对
 * 路径 import 它的纯函数;`main()` 由 `import.meta.url` 守着,不会在 import 时跑。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../scripts/session-shadow-report.mjs',
)
const { buildReport, readStats, readShadowLines, resolveStorePath } = await import(scriptPath)

let logDir = ''

beforeEach(() => {
  logDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onething-report-')), 'log')
  fs.mkdirSync(logDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(path.dirname(logDir), { recursive: true, force: true })
})

function writeStats(stats: Record<string, unknown>): void {
  fs.writeFileSync(path.join(logDir, 'session-shadow-stats.json'), JSON.stringify(stats), 'utf8')
}

function writeLines(lines: Array<Record<string, unknown>>): void {
  fs.writeFileSync(
    path.join(logDir, 'session-shadow.jsonl'),
    lines.map(line => JSON.stringify(line)).join('\n') + '\n',
    'utf8',
  )
}

describe('shadow report', () => {
  it('reads the counters and the diff lines', () => {
    writeStats({ runs: 42, mismatches: 3, appendFailures: 1, byKind: { messages: 2, history: 1 } })
    writeLines([
      { time: 1, sessionId: 's1', runId: 'r1', kind: 'messages', diff: [{ path: 'content', a: 'x', b: 'y' }] },
      { time: 2, sessionId: 's1', runId: 'r2', kind: 'history', diff: [] },
      { time: 3, sessionId: 's2', runId: 'r3', kind: 'messages', diff: [] },
    ])

    const report = buildReport(logDir)
    expect(report.stats).toMatchObject({ runs: 42, mismatches: 3, appendFailures: 1 })
    expect(report.lineCount).toBe(3)
    // top 排序按不等次数,并带上每条会话的 kind 分布。
    expect(report.top[0]).toMatchObject({ sessionId: 's1', mismatches: 2, kinds: { messages: 1, history: 1 } })
    expect(report.top[1]).toMatchObject({ sessionId: 's2', mismatches: 1 })
    expect(report.lastDiffs).toHaveLength(3)
  })

  /**
   * F0(§16.2):方向标记。转向后的行带 `truth:'events'`,老行没有 —— 报表把两种
   * 行分开数出来,免得有人拿今天的列名去读昨天的两列(它们的语义正好相反)。
   */
  it('counts the F0 direction marker apart from the pre-F0 lines', () => {
    writeStats({ runs: 1, mismatches: 2 })
    writeLines([
      { time: 1, sessionId: 's1', kind: 'messages', truth: 'events', diff: [] },
      { time: 2, sessionId: 's1', kind: 'history', diff: [] },
    ])

    expect(buildReport(logDir).directions).toEqual({ events: 1, legacy: 1 })
  })

  it('treats a missing stats file as zero, not as green', () => {
    const stats = readStats(logDir)
    expect(stats).toMatchObject({
      runs: 0,
      historyChecks: 0,
      mismatches: 0,
      duplicateMismatches: 0,
      appendFailures: 0,
      missing: true,
    })
  })

  /**
   * F9(§13.2/§13.4):run 粒度与请求粒度是两个数。老账单里没有这两格,读成 0
   * 而不是读崩 —— 门只看 `runs`,它们只负责让口径看得见。
   */
  it('carries the run-grained and request-grained counters apart', () => {
    writeStats({ runs: 42, historyChecks: 311, mismatches: 0, duplicateMismatches: 7, appendFailures: 0 })
    expect(readStats(logDir)).toMatchObject({ runs: 42, historyChecks: 311, duplicateMismatches: 7 })

    writeStats({ runs: 42, mismatches: 0, appendFailures: 0 })
    expect(readStats(logDir)).toMatchObject({ runs: 42, historyChecks: 0, duplicateMismatches: 0 })
  })

  it('tolerates a truncated last line in the jsonl', () => {
    fs.writeFileSync(
      path.join(logDir, 'session-shadow.jsonl'),
      `${JSON.stringify({ time: 1, sessionId: 's1', kind: 'messages', diff: [] })}\n{"time":2,"sess`,
      'utf8',
    )
    expect(readShadowLines(logDir)).toHaveLength(1)
  })

  it('resolves the store the same way the product does', () => {
    expect(resolveStorePath('/tmp/explicit')).toBe('/tmp/explicit')
    const previous = process.env.ONETHING_STORE_PATH
    process.env.ONETHING_STORE_PATH = '/tmp/from-env'
    try {
      expect(resolveStorePath()).toBe('/tmp/from-env')
    } finally {
      if (previous === undefined) delete process.env.ONETHING_STORE_PATH
      else process.env.ONETHING_STORE_PATH = previous
    }
  })
})
