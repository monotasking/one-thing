#!/usr/bin/env node
/**
 * Soul-memory archival script (plugin retired 2026-08-06).
 *
 * The soul-memory plugin was pulled out of the tree entirely; nothing reads
 * or writes SOUL.md / MEMORY.md / daily notes anymore. This moves what is
 * still on disk into one archive folder so the store stops looking like a
 * live memory workspace, without deleting a single byte.
 *
 *   Before: ~/.onething/memory/{SOUL.md,MEMORY.md,daily/,...}
 *           ~/.onething/agents/<agentId>/{SOUL.md,MEMORY.md,memory/}
 *           ~/.onething/agents/<agentId>/plugin-data/soul-memory.*
 *           ~/.onething/memory-logs/
 *   After:  ~/.onething/memory/legacy-backup/default/…
 *           ~/.onething/memory/legacy-backup/agents/<agentId>/…
 *           ~/.onething/memory/legacy-backup/memory-logs/…
 *
 * Mirrors the sessions/legacy-backup precedent: move, never delete.
 *
 * Usage:
 *   node scripts/archive-soul-memory.mjs            # dry run, prints the plan
 *   node scripts/archive-soul-memory.mjs --apply    # actually move
 *
 * Stop the desktop app and any running server BEFORE --apply; both hold the
 * store and a concurrent write would land in a half-moved tree.
 *
 * Idempotent — anything already under legacy-backup/ is left alone.
 * The runtime app NEVER calls this. Run it manually.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { join, relative } from 'path'

// ── Paths (mirror packages/backend/storage/paths.ts) ──

const STORE_ROOT = process.env.ONETHING_STORE_PATH || join(homedir(), '.onething')
const SETTINGS_PATH = join(STORE_ROOT, 'settings.json')
const MEMORY_DIR = join(STORE_ROOT, 'memory')
const MEMORY_LOGS_DIR = join(STORE_ROOT, 'memory-logs')
const AGENTS_DIR = join(STORE_ROOT, 'agents')
const ARCHIVE_ROOT = join(MEMORY_DIR, 'legacy-backup')

const APPLY = process.argv.includes('--apply')

/** Per-agent entries the plugin owned. Everything else under an agent stays. */
const AGENT_MEMORY_ENTRIES = ['SOUL.md', 'MEMORY.md', 'memory']
/** plugin-data files are prefix-matched so both .sqlite and .json are caught. */
const AGENT_PLUGIN_DATA_PREFIX = 'soul-memory'

const moves = []

function planMove(from, to) {
  if (!existsSync(from)) return
  moves.push({ from, to })
}

// ── 1. Top-level ~/.onething/memory/* (the default agent's workspace) ──
// Skip legacy-backup itself so re-runs do not nest archives.

if (existsSync(MEMORY_DIR)) {
  for (const entry of readdirSync(MEMORY_DIR)) {
    if (entry === 'legacy-backup') continue
    planMove(join(MEMORY_DIR, entry), join(ARCHIVE_ROOT, 'default', entry))
  }
}

// ── 2. Per-agent workspaces ──

if (existsSync(AGENTS_DIR)) {
  for (const agentId of readdirSync(AGENTS_DIR)) {
    const agentDir = join(AGENTS_DIR, agentId)
    if (!existsSync(agentDir) || !statSync(agentDir).isDirectory()) continue

    for (const entry of AGENT_MEMORY_ENTRIES) {
      planMove(join(agentDir, entry), join(ARCHIVE_ROOT, 'agents', agentId, entry))
    }

    const pluginDataDir = join(agentDir, 'plugin-data')
    if (existsSync(pluginDataDir)) {
      for (const file of readdirSync(pluginDataDir)) {
        if (!file.startsWith(AGENT_PLUGIN_DATA_PREFIX)) continue
        planMove(
          join(pluginDataDir, file),
          join(ARCHIVE_ROOT, 'agents', agentId, 'plugin-data', file),
        )
      }
    }
  }
}

// ── 3. Diagnostics logs ──

planMove(MEMORY_LOGS_DIR, join(ARCHIVE_ROOT, 'memory-logs'))

// ── 4. Dead config key ──
// `general.soulMemory` survives mergeWithDefaults untouched (unknown keys are
// kept, not dropped), so it would sit in settings.json forever. Nothing reads
// it anymore. settings.json is backed up before it is rewritten.

function readStaleSettingsKey() {
  if (!existsSync(SETTINGS_PATH)) return null
  try {
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
    return settings?.general && 'soulMemory' in settings.general ? settings : null
  } catch (error) {
    console.warn(`[archive-soul-memory] could not parse settings.json: ${error.message}`)
    return null
  }
}

const settingsWithStaleKey = readStaleSettingsKey()

// ── Report / execute ──

if (moves.length === 0 && !settingsWithStaleKey) {
  console.log('[archive-soul-memory] nothing to archive — store is already clean.')
  process.exit(0)
}

console.log(`[archive-soul-memory] store: ${STORE_ROOT}`)
console.log(`[archive-soul-memory] ${moves.length} entr${moves.length === 1 ? 'y' : 'ies'} to archive:\n`)
for (const { from, to } of moves) {
  console.log(`  ${relative(STORE_ROOT, from)}`)
  console.log(`    -> ${relative(STORE_ROOT, to)}`)
}

if (settingsWithStaleKey) {
  console.log('\n  settings.json: drop dead key general.soulMemory')
  console.log('    (settings.json.bak-<date> written first)')
}

if (!APPLY) {
  console.log('\n[archive-soul-memory] dry run — nothing moved, nothing rewritten.')
  console.log('[archive-soul-memory] stop the app and any server, then re-run with --apply.')
  process.exit(0)
}

let moved = 0
for (const { from, to } of moves) {
  if (existsSync(to)) {
    console.warn(`[archive-soul-memory] skip (target exists): ${relative(STORE_ROOT, to)}`)
    continue
  }
  mkdirSync(join(to, '..'), { recursive: true })
  renameSync(from, to)
  moved += 1
}

if (settingsWithStaleKey) {
  // Timestamp comes from the filesystem, not a hardcoded string, so repeat
  // runs on the same day do not clobber an earlier backup.
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const backupPath = `${SETTINGS_PATH}.bak-${stamp}`
  copyFileSync(SETTINGS_PATH, backupPath)
  delete settingsWithStaleKey.general.soulMemory
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(settingsWithStaleKey, null, 2)}\n`, 'utf-8')
  console.log(`[archive-soul-memory] dropped general.soulMemory (backup: ${relative(STORE_ROOT, backupPath)})`)
}

console.log(`\n[archive-soul-memory] archived ${moved} entr${moved === 1 ? 'y' : 'ies'} into ${relative(STORE_ROOT, ARCHIVE_ROOT)}/`)
console.log('[archive-soul-memory] nothing was deleted — the files are all still there.')
