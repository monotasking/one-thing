#!/usr/bin/env bun
/**
 * `sessions:storage-report` —— 会话存储的体积报表(S3w-4,
 * `docs/design/session-event-sourcing-2026-08.md` §14.6 "存储脚本给出目标值"/§15.12)。
 *
 *   bun run sessions:storage-report [<sessionId>] [--store PATH] [--json]
 *                                   [--top N] [--quiet]
 *
 * 每会话四格 + 全库合计:`events.jsonl` / `blobs/`(含 `blobs/orphan/` 单列)/
 * `messages.jsonl` / `meta.json`,外加 **events÷messages 比值** —— S3w-3 的验收
 * 目标(§8:停写后总量 ≈ messages × 1.1–1.2)读的就是这一格。
 *
 * 比值只在**两份都在**的会话上算(纯事件会话没有分母,legacy 整文件会话没有
 * 分子),所以报表里的 `ratio` 覆盖面单列一行:拿一个覆盖 30% 的比值当全库结论
 * 是这类报表最容易犯的错。
 *
 * **全程只读**,一个字节都不写。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface SessionStorageRow {
  sessionId: string
  events: number
  blobs: number
  orphanBlobs: number
  messages: number
  meta: number
  /**
   * `messages.cleared-*` 的存档(§14.6 裁定 10 待拍的那一批)。
   *
   * 单列是因为它今天**没有任何治理器**管:第一次真机跑出来 436 条会话里它占了
   * 三分之一强,比 blob 孤儿大两个数量级 —— 报表要把最大的那块说出来,而不是
   * 让它躲在"其它"里。
   */
  cleared: number
  /**
   * 会话目录里的 `legacy-backup/` —— S1a 迁移时留下的原 `messages.jsonl` 副本。
   *
   * 单列的理由同 `cleared`:它也没有治理器,而第一次真机跑出来它是**最大的一块**
   * (比 events.jsonl 之外的所有东西加起来还大)。注意它与 `sessions/legacy-backup/`
   * (整文件会话的迁移备份,不在会话目录里)不是一回事。
   */
  legacyBackup: number
  /** 会话目录的总字节(上面几格 + 其它零碎)。 */
  total: number
  /** `(events + blobs) / messages` —— 两份都在时才有。 */
  ratio?: number
}

function resolveStorePath(explicit?: string): string {
  return explicit || process.env.ONETHING_STORE_PATH || path.join(os.homedir(), '.onething')
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/** 一个目录的字节合计(一层递归就够:`blobs/` 下只有文件与 `orphan/`)。 */
function dirBytes(dir: string, depth = 2): { bytes: number; subdirs: Record<string, number> } {
  let bytes = 0
  const subdirs: Record<string, number> = {}
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return { bytes, subdirs }
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isFile()) bytes += sizeOf(full)
    else if (entry.isDirectory() && depth > 0) {
      const nested = dirBytes(full, depth - 1)
      subdirs[entry.name] = nested.bytes
      bytes += nested.bytes
    }
  }
  return { bytes, subdirs }
}

export function measureSession(sessionsDir: string, sessionId: string): SessionStorageRow {
  const dir = path.join(sessionsDir, sessionId)
  const events = sizeOf(path.join(dir, 'events.jsonl'))
  const messages = sizeOf(path.join(dir, 'messages.jsonl'))
  const meta = sizeOf(path.join(dir, 'meta.json'))
  const blobs = dirBytes(path.join(dir, 'blobs'))
  const whole = dirBytes(dir, 3)
  const total = whole.bytes
  let cleared = 0
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith('messages.cleared-')) {
        cleared += sizeOf(path.join(dir, entry.name))
      }
    }
  } catch {
    // 目录读不到 = 这条会话不在盘上,四格全 0。
  }
  const row: SessionStorageRow = {
    sessionId,
    events,
    blobs: blobs.bytes,
    orphanBlobs: blobs.subdirs.orphan ?? 0,
    messages,
    meta,
    cleared,
    legacyBackup: whole.subdirs['legacy-backup'] ?? 0,
    total,
  }
  if (events > 0 && messages > 0) row.ratio = (events + blobs.bytes) / messages
  return row
}

function listSessionIds(sessionsDir: string): string[] {
  try {
    return fs.readdirSync(sessionsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== 'legacy-backup')
      .map(entry => entry.name)
      .sort()
  } catch {
    return []
  }
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
  json: boolean
  quiet: boolean
  top: number
} {
  const args = {
    sessionId: undefined as string | undefined,
    store: undefined as string | undefined,
    json: false,
    quiet: false,
    top: 15,
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--json') args.json = true
    else if (arg === '--quiet') args.quiet = true
    else if (arg === '--all') continue
    else if (arg === '--store') args.store = argv[++index]
    else if (arg.startsWith('--store=')) args.store = arg.slice('--store='.length)
    else if (arg === '--top') args.top = Number(argv[++index])
    else if (arg.startsWith('--top=')) args.top = Number(arg.slice('--top='.length))
    else if (!arg.startsWith('-')) args.sessionId = arg
  }
  return args
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const store = resolveStorePath(args.store)
  const sessionsDir = path.join(store, 'sessions')
  const ids = args.sessionId ? [args.sessionId] : listSessionIds(sessionsDir)
  const rows = ids.map(id => measureSession(sessionsDir, id))

  const sum = (pick: (row: SessionStorageRow) => number): number =>
    rows.reduce((total, row) => total + pick(row), 0)
  const totals = {
    sessions: rows.length,
    events: sum(row => row.events),
    blobs: sum(row => row.blobs),
    orphanBlobs: sum(row => row.orphanBlobs),
    messages: sum(row => row.messages),
    meta: sum(row => row.meta),
    cleared: sum(row => row.cleared),
    legacyBackup: sum(row => row.legacyBackup),
    total: sum(row => row.total),
  }
  const other = totals.total - totals.events - totals.blobs - totals.messages
    - totals.meta - totals.cleared - totals.legacyBackup
  const withBoth = rows.filter(row => row.ratio !== undefined)
  const ratioAll = totals.messages > 0 ? (totals.events + totals.blobs) / totals.messages : undefined
  const ratioCovered = (() => {
    const events = withBoth.reduce((total, row) => total + row.events + row.blobs, 0)
    const messages = withBoth.reduce((total, row) => total + row.messages, 0)
    return messages > 0 ? events / messages : undefined
  })()

  if (args.json) {
    console.log(JSON.stringify({ store, totals, other, ratioAll, ratioCovered, coveredSessions: withBoth.length, rows }, null, 2))
  } else {
    console.log(`[storage] store=${store} sessions=${rows.length}`)
    if (!args.quiet) {
      const top = [...rows].sort((a, b) => b.total - a.total).slice(0, Math.max(0, args.top))
      console.log(`\n[storage] top ${top.length} by total size:`)
      console.log(`  ${'session'.padEnd(38)} ${'events'.padStart(9)} ${'blobs'.padStart(9)} ${'messages'.padStart(9)} ${'ratio'.padStart(6)}`)
      for (const row of top) {
        console.log(
          `  ${row.sessionId.padEnd(38)} ${formatBytes(row.events).padStart(9)}`
          + ` ${formatBytes(row.blobs).padStart(9)} ${formatBytes(row.messages).padStart(9)}`
          + ` ${(row.ratio === undefined ? '-' : row.ratio.toFixed(2)).padStart(6)}`,
        )
      }
    }
    console.log('\n[storage] totals:')
    console.log(`  events.jsonl    ${formatBytes(totals.events)}`)
    console.log(`  blobs/          ${formatBytes(totals.blobs)}  (orphan/ ${formatBytes(totals.orphanBlobs)})`)
    console.log(`  messages.jsonl  ${formatBytes(totals.messages)}`)
    console.log(`  meta.json       ${formatBytes(totals.meta)}`)
    console.log(`  messages.cleared-*  ${formatBytes(totals.cleared)}  (§14.6 裁定 10 待拍;今天没有治理器管)`)
    console.log(`  legacy-backup/  ${formatBytes(totals.legacyBackup)}  (S1a 迁移留下的原抄本副本;同样无治理器)`)
    console.log(`  其它            ${formatBytes(other)}`)
    console.log(`  sessions/ 全部  ${formatBytes(totals.total)}`)
    console.log('\n[storage] events+blobs ÷ messages:')
    console.log(`  全库(分母只含有抄本的会话)  ${ratioAll === undefined ? '-' : ratioAll.toFixed(2)}`)
    console.log(`  仅两份都在的 ${withBoth.length} 条会话      ${ratioCovered === undefined ? '-' : ratioCovered.toFixed(2)}`)
    console.log(`  目标(§8,S3w-3 验收)          1.10 – 1.20`)
  }
  console.log(`\n[storage] complete: ${rows.length} session(s)`)
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) main()
