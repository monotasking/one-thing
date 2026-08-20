#!/usr/bin/env node
/**
 * 影子账单归零(S1b)。
 *
 *   bun run sessions:shadow-reset [--store PATH]
 *
 * 计数清零,**日志不删**:`session-shadow.jsonl` 轮转成 `.1`(已有的 `.1` 被
 * 覆盖)。理由是那份 jsonl 是唯一还原"上一轮到底哪里不等"的东西 —— 一次 reset
 * 常常发生在"我以为修好了"之后,把证据一起扔掉的代价远大于多留一个文件。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function parseArgs(argv) {
  let store
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--store') store = argv[++index]
    else if (arg.startsWith('--store=')) store = arg.slice('--store='.length)
  }
  return { store }
}

const { store: explicit } = parseArgs(process.argv.slice(2))
const store = explicit || process.env.ONETHING_STORE_PATH || path.join(os.homedir(), '.onething')
const logDir = path.join(store, 'log')
const statsPath = path.join(logDir, 'session-shadow-stats.json')
const logPath = path.join(logDir, 'session-shadow.jsonl')

fs.mkdirSync(logDir, { recursive: true })

if (fs.existsSync(logPath)) {
  fs.renameSync(logPath, `${logPath}.1`)
  console.log(`[shadow] rotated ${logPath} → ${logPath}.1`)
}

fs.writeFileSync(
  statsPath,
  `${JSON.stringify(
    {
      appendFailures: 0,
      runs: 0,
      // F9(§13.4):请求粒度与被折叠的重复 —— 与 run 粒度分开记,归零也一起。
      historyChecks: 0,
      mismatches: 0,
      duplicateMismatches: 0,
      byKind: {},
      skipped: {},
      updatedAt: Date.now(),
    },
    null,
    2,
  )}\n`,
  'utf8',
)
console.log(`[shadow] stats zeroed: ${statsPath}`)
