#!/usr/bin/env bun
/**
 * `sessions:blob-gc` —— blob 孤儿的引用扫描与归档(S3w-4,
 * `docs/design/session-event-sourcing-2026-08.md` §15.12)。
 *
 *   bun run sessions:blob-gc [<sessionId> | --all] [--store PATH]
 *                            [--apply] [--json] [--quiet] [--min-age-hours N]
 *
 * **默认 dry-run**:只报数,一个字节都不动。`--apply` 才把孤儿移进
 * `sessions/<id>/blobs/orphan/`(归档,不硬删 —— 判据漏认一处,硬删就是把一段
 * 正文从唯一账本里抹掉,而 blob 没有第二份副本)。
 *
 * 判据与跳过闸全在 `packages/backend/session/blob-gc.ts`,与 `sessions:verify`
 * 的引用完整性检查共用 core 里那一个 `collectSessionBlobRefHashes` —— 一边问
 * "有引用没文件",一边问"有文件没引用",判据分家迟早会分出一边删掉另一边认的。
 */
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  runSessionBlobGc,
  type SessionBlobGcReport,
} from '../packages/backend/session/blob-gc.ts'

function resolveStorePath(explicit?: string): string {
  return explicit || process.env.ONETHING_STORE_PATH || path.join(os.homedir(), '.onething')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`
}

function parseArgs(argv: string[]): {
  sessionId?: string
  store?: string
  apply: boolean
  json: boolean
  quiet: boolean
  minAgeHours?: number
} {
  const args = {
    sessionId: undefined as string | undefined,
    store: undefined as string | undefined,
    apply: false,
    json: false,
    quiet: false,
    minAgeHours: undefined as number | undefined,
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--apply') args.apply = true
    else if (arg === '--json') args.json = true
    else if (arg === '--quiet') args.quiet = true
    else if (arg === '--all') continue
    else if (arg === '--store') args.store = argv[++index]
    else if (arg.startsWith('--store=')) args.store = arg.slice('--store='.length)
    else if (arg === '--min-age-hours') args.minAgeHours = Number(argv[++index])
    else if (arg.startsWith('--min-age-hours=')) args.minAgeHours = Number(arg.slice('--min-age-hours='.length))
    else if (!arg.startsWith('-')) args.sessionId = arg
  }
  return args
}

function printReport(report: SessionBlobGcReport, quiet: boolean): void {
  console.log(`[blob-gc] store=${path.dirname(report.sessionsDir)} mode=${report.dryRun ? 'dry-run' : 'apply'}`)
  for (const entry of report.perSession) {
    if (entry.skipped) {
      if (!quiet) console.log(`[blob-gc] skip: ${entry.sessionId} (${entry.skipped})`)
      continue
    }
    if (entry.orphans.length === 0 && entry.errors.length === 0) {
      if (!quiet) {
        console.log(`[blob-gc] ok: ${entry.sessionId} (${entry.present} blobs, ${formatBytes(entry.blobBytes)})`)
      }
      continue
    }
    console.log(
      `[blob-gc] orphans: ${entry.sessionId} ${entry.orphans.length}/${entry.present}`
      + ` ${formatBytes(entry.orphanBytes)}${entry.archived ? ` archived=${entry.archived}` : ''}`,
    )
    for (const error of entry.errors) console.log(`    ${error}`)
  }
  console.log('\n[blob-gc] summary:')
  console.log(`  sessions        ${report.sessions}`)
  console.log(`  scanned         ${report.scanned}`)
  for (const [reason, count] of Object.entries(report.skipped).sort()) {
    console.log(`  skip:${reason.padEnd(10)} ${count}`)
  }
  console.log(`  orphan blobs    ${report.orphans} (${formatBytes(report.orphanBytes)})`)
  console.log(`  archived        ${report.archived}`)
  console.log(`  missing refs    ${report.missing}  (有引用没文件 —— 归 sessions:verify 管)`)
  if (report.errors.length > 0) {
    console.log(`  errors          ${report.errors.length}`)
    for (const error of report.errors) console.log(`    ${error}`)
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const store = resolveStorePath(args.store)
  const sessionsDir = path.join(store, 'sessions')
  const report = runSessionBlobGc({
    dryRun: !args.apply,
    sessionsDir,
    ...(args.sessionId ? { sessionIds: [args.sessionId] } : {}),
    ...(args.minAgeHours !== undefined && Number.isFinite(args.minAgeHours)
      ? { minAgeMs: args.minAgeHours * 60 * 60 * 1000 }
      : {}),
  })

  if (args.json) console.log(JSON.stringify(report, null, 2))
  else printReport(report, args.quiet)

  console.log(
    `\n[blob-gc] complete: ${report.scanned} session(s) scanned, `
    + `${report.orphans} orphan blob(s) (${formatBytes(report.orphanBytes)}), `
    + `${report.dryRun ? 'nothing moved (dry-run)' : `${report.archived} archived`}`,
  )
  process.exit(report.errors.length > 0 ? 1 : 0)
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) main()
