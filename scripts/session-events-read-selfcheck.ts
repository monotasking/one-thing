#!/usr/bin/env bun
/**
 * 批 8 自证(S2b,§13.18)——**切读默认为 `events` 之后,证明 events 模式物化
 * 真机会话得到的历史完整**,尤其 edit/write 的 diff `changes` 俱在(批 6/A 的落点)。
 *
 *   bun run sessions:events-selfcheck [<sessionId> | --all] [--store PATH] [--json] [--quiet]
 *
 * 做法(**只读**,一个字节都不写,不加锁):
 *  1. 把读模式显式钉在 `events`(与切默认后的生产读路同一侧);
 *  2. 复用 `sessions:verify` 的 `verifySession` —— 它把 `events.jsonl` 折成投影、
 *     过磁盘同款脱水/补水,再与 `messages.jsonl` **逐条 canonical 对齐**;
 *     `canonicalChatMessage` 本身把 `toolCall.changes` 纳进比较,所以"diff changes
 *     俱在"是这道 canonical 判官的题中之义 —— 投影少一条 changes 立刻现形为
 *     `messages` 类 issue;
 *  3. 额外把 changes 这一维**显式**数出来贴脸:messages.jsonl 里带 diff changes 的
 *     toolCall 数 —— canonical 判官逐条比较里已含 changes,所以"canonical 干净"
 *     即"这些 changes 在 events 投影里俱在"(可见性 + 逻辑断言,不再抄错源)。
 *
 * 门(退出码):`seq` / `surface` / `projection` / `messages` 这几类是历史完整性
 * (events 物化 ≠ messages.jsonl 就落在这里),但**已在 verify 基线里的算已知漂移
 * 不判红,只有基线之外的新命中才红** —— 与 `sessions:verify:gate` 共用同一份
 * `docs/audit/session-verify-baseline-2026-08-20.txt`(§13.16 收录的两条 events-ahead
 * 真机漂移 + edit-resend 落盘丢写等,都是切读之前就有的老账,不补)。`blob` /
 * `unclosed-run` 属数据退化(旧文件缺 blob、崩溃残留),打印但不判红。
 *
 * 与 `sessions:verify:gate` 的分工:gate 是全量棘轮(盯"新代码弄坏旧文件");
 * 本脚本是切读默认的**一次性自证**,把 events 读路 + changes 维度显式钉给人看。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeJsonlLine } from '@onething/core/session'
import {
  listSessionIds,
  resolveStorePath,
  verifySession,
  type SessionVerifyReport,
} from './session-verify.ts'

/** 历史完整性那几类 —— events 物化 ≠ messages.jsonl 就落在这里。 */
const HARD_ISSUE_KINDS = new Set(['seq', 'surface', 'projection', 'messages'])

/** 与 `sessions:verify:gate` 共用的已知漂移基线 —— 切读之前就有的老账,不判红。 */
function loadVerifyBaseline(root: string): Set<string> {
  try {
    const text = fs.readFileSync(path.join(root, 'docs/audit/session-verify-baseline-2026-08-20.txt'), 'utf8')
    return new Set(
      text
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#')),
    )
  } catch {
    return new Set()
  }
}

interface Args {
  sessionId?: string
  all: boolean
  store?: string
  json: boolean
  quiet: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { all: false, json: false, quiet: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--all') args.all = true
    else if (arg === '--store') args.store = argv[++i]
    else if (arg === '--json') args.json = true
    else if (arg === '--quiet') args.quiet = true
    else if (!arg.startsWith('--')) args.sessionId = arg
  }
  return args
}

/** messages.jsonl(脱水抄本)里带 diff changes 的 assistant toolCall 数。 */
function transcriptChangesCount(sessionsDir: string, sessionId: string): number {
  const file = path.join(sessionsDir, sessionId, 'messages.jsonl')
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return 0
  }
  let count = 0
  for (const line of text.split('\n')) {
    if (!line) continue
    const decoded = decodeJsonlLine<{ message?: { role?: string; toolCalls?: Array<{ changes?: unknown }> } }>(line)
    if (!decoded || decoded.t !== 'm') continue
    const message = decoded.message
    if (message?.role !== 'assistant') continue
    for (const call of message.toolCalls ?? []) {
      if (call.changes) count += 1
    }
  }
  return count
}

/** verify:gate 同款行格式:`<sessionId> <kind>: <detail>`。 */
function hardIssueLines(report: SessionVerifyReport): string[] {
  return report.issues
    .filter(issue => HARD_ISSUE_KINDS.has(issue.kind))
    .map(issue => `${report.sessionId} ${issue.kind}: ${issue.detail}`)
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const store = resolveStorePath(args.store)
  const sessionsDir = path.join(store, 'sessions')

  const baseline = loadVerifyBaseline(path.resolve(fileURLToPath(import.meta.url), '..', '..'))
  const ids = args.all || !args.sessionId ? listSessionIds(sessionsDir) : [args.sessionId]
  if (ids.length === 0) {
    console.error(`[events-selfcheck] no sessions under ${sessionsDir}`)
    process.exit(1)
  }

  let newRed = 0
  let knownDrift = 0
  let checkedWithHistory = 0
  let transcriptChangesTotal = 0
  const freshLines: string[] = []
  const rows: Array<Record<string, unknown>> = []

  for (const id of ids) {
    const report = verifySession(sessionsDir, id)
    if (report.noEventHistory) continue
    checkedWithHistory += 1
    const hard = hardIssueLines(report)
    const fresh = hard.filter(line => !baseline.has(line))
    if (hard.length > 0) knownDrift += 1
    const tChanges = transcriptChangesCount(sessionsDir, id)
    transcriptChangesTotal += tChanges
    if (fresh.length > 0) {
      newRed += 1
      freshLines.push(...fresh)
    }
    rows.push({
      sessionId: id,
      messages: report.messages,
      transcriptChanges: tChanges,
      ...(report.coverage ? { coverage: report.coverage } : {}),
      ...(hard.length > 0 ? { knownDrift: hard.length } : {}),
      ...(fresh.length > 0 ? { newIssues: fresh } : {}),
    })
    if (!args.quiet && !args.json && (fresh.length > 0 || (hard.length > 0 && args.all === false))) {
      const flag = fresh.length > 0 ? 'NEW ' : 'known'
      console.log(
        `[events-selfcheck] ${flag} ${id}  messages=${report.messages}  transcriptChanges=${tChanges}` +
          (fresh.length > 0 ? `\n    ${fresh.join('\n    ')}` : ''),
      )
    }
  }

  const summary = {
    store,
    sessionsWithHistory: checkedWithHistory,
    newRed,
    knownDrift,
    transcriptChangesTotal,
  }

  if (args.json) {
    console.log(JSON.stringify({ summary, rows, freshLines }, null, 2))
  } else {
    console.log(
      `\n[events-selfcheck] ${checkedWithHistory} session(s) with event history checked; ` +
        `${knownDrift} with known drift (in verify baseline), ${newRed} with NEW integrity issue(s).`,
    )
    console.log(
      `[events-selfcheck] diff changes reproduced — ${transcriptChangesTotal} toolCall change-set(s) in ` +
        `messages.jsonl; canonical 判官逐条比较已含 changes,故 0 NEW = events 物化的历史与 changes 俱在。`,
    )
    if (newRed > 0) {
      console.error(`[events-selfcheck] FAILED: ${freshLines.length} NEW issue(s) vs verify baseline:`)
      for (const line of freshLines) console.error(`  ${line}`)
    }
  }

  process.exit(newRed > 0 ? 1 : 0)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main()
}
