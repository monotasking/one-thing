import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { getOnethingStorePath } from './paths.js'

export type StoreLockOwner = 'desktop' | 'daemon' | 'server' | 'maintenance'
export const STORE_LOCK_PROTOCOL_VERSION = 1
const META_FILENAME = 'owner.json'
const PROCESS_STARTED_AT = Date.now() - Math.floor(process.uptime() * 1_000)

export interface LockMeta {
  pid: number
  owner: StoreLockOwner
  acquiredAt: number
  version: string
  /** Absent on the legacy file-lock protocol. */
  protocolVersion?: number
  startedAt?: number
  nonce?: string
  storePath?: string
}

export interface StoreLockOptions {
  storePath?: string
  version?: string
  lockFileName?: string
}

/** Ownership belongs to a Backend instance, never to a connection borrowing it. */
export interface StoreLease {
  readonly storePath: string
  readonly lockPath: string
  readonly held: boolean
  acquire(owner: StoreLockOwner): Promise<void>
  assertHeld(): void
  /** Call only after writers and discovery cleanup have stopped. May throw. */
  release(): void
}

export interface StoreLockIdentity {
  device: number
  inode: number
  createdAt: number
  modifiedAt: number
  kind: 'directory' | 'file' | 'other'
  metadataHash: string | null
}

export type StoreLockStatus =
  | 'absent'
  | 'held'
  | 'initializing'
  | 'invalid-metadata'
  | 'legacy-lock'
  | 'unsupported-protocol'
  | 'unsupported-entry'
  | 'unreadable'

export interface StoreLockDiagnostic {
  storePath: string
  lockPath: string
  status: StoreLockStatus
  identity: StoreLockIdentity | null
  holder: LockMeta | null
  processState: 'running' | 'not-running' | 'unknown'
  errorCode?: string
}

const UNKNOWN_HOLDER: LockMeta = { pid: -1, owner: 'daemon', acquiredAt: 0, version: 'unknown' }

export class LockConflictError extends Error {
  constructor(
    public readonly holder: LockMeta,
    public readonly diagnostic?: StoreLockDiagnostic,
  ) {
    super(diagnostic?.holder || !diagnostic
      ? `Store is locked by ${holder.owner} (pid ${holder.pid})`
      : `Store lock is ${diagnostic.status} at ${diagnostic.lockPath}. Ownership is unknown; startup is refused.`)
    this.name = 'LockConflictError'
  }
}

export class StoreLockOwnershipError extends Error {
  constructor(public readonly lockPath: string) {
    super(`Store lease ownership could not be verified at ${lockPath}; the lock was not removed.`)
    this.name = 'StoreLockOwnershipError'
  }
}

export class StoreLockInitializationError extends Error {
  constructor(public readonly lockPath: string, cause: unknown) {
    super(`Could not initialize store lease at ${lockPath}; the incomplete lock is retained for offline diagnosis.`, { cause })
    this.name = 'StoreLockInitializationError'
  }
}

/** Resolve aliases even when the final store directory does not exist yet. */
export function canonicalizeStorePath(storePath: string): string {
  const missing: string[] = []
  let existing = path.resolve(storePath)
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(existing), ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(existing)
      if (parent === existing) throw error
      missing.push(path.basename(existing))
      existing = parent
    }
  }
}

function resolveLockPaths(options: StoreLockOptions): { storePath: string; lockPath: string } {
  const filename = options.lockFileName || 'backend.lock'
  if (filename === '.' || filename === '..' || path.basename(filename) !== filename || /[\\/]/.test(filename)) {
    throw new Error('Store lock file name must be a single path component')
  }
  const storePath = canonicalizeStorePath(options.storePath || getOnethingStorePath())
  return { storePath, lockPath: path.join(storePath, 'run', filename) }
}

function parseMeta(raw: string): LockMeta | null {
  try {
    const value = JSON.parse(raw) as Partial<LockMeta> | null
    // Unknown owner names remain diagnostic data, never a reason to reclaim.
    if (!value || !Number.isInteger(value.pid) || value.pid! <= 0
      || typeof value.owner !== 'string' || value.owner.length === 0) return null
    return {
      pid: value.pid!, owner: value.owner,
      acquiredAt: typeof value.acquiredAt === 'number' ? value.acquiredAt : 0,
      version: typeof value.version === 'string' ? value.version : 'unknown',
      ...(typeof value.protocolVersion === 'number' ? { protocolVersion: value.protocolVersion } : {}),
      ...(typeof value.startedAt === 'number' ? { startedAt: value.startedAt } : {}),
      ...(typeof value.nonce === 'string' ? { nonce: value.nonce } : {}),
      ...(typeof value.storePath === 'string' ? { storePath: value.storePath } : {}),
    }
  } catch {
    return null
  }
}

function processState(pid: number): StoreLockDiagnostic['processState'] {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown'
  try {
    process.kill(pid, 0)
    return 'running'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM') return 'running'
    return code === 'ESRCH' ? 'not-running' : 'unknown'
  }
}

function inspectPaths(storePath: string, lockPath: string): StoreLockDiagnostic {
  const result: StoreLockDiagnostic = {
    storePath, lockPath, status: 'absent', identity: null, holder: null, processState: 'unknown',
  }
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(lockPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      result.status = 'unreadable'
      result.errorCode = (error as NodeJS.ErrnoException).code
    }
    return result
  }
  const kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other'
  result.identity = {
    device: stat.dev, inode: stat.ino, createdAt: stat.birthtimeMs,
    modifiedAt: stat.mtimeMs, kind, metadataHash: null,
  }
  if (kind === 'other') {
    result.status = 'unsupported-entry'
    return result
  }
  let raw: string
  try {
    const metaPath = kind === 'directory' ? path.join(lockPath, META_FILENAME) : lockPath
    if (!fs.lstatSync(metaPath).isFile()) {
      result.status = 'invalid-metadata'
      return result
    }
    raw = fs.readFileSync(metaPath, 'utf8')
    result.identity.metadataHash = createHash('sha256').update(raw).digest('hex')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    result.status = kind === 'directory' && code === 'ENOENT' ? 'initializing' : 'unreadable'
    result.errorCode = code
    return result
  }
  result.holder = parseMeta(raw)
  result.processState = result.holder ? processState(result.holder.pid) : 'unknown'
  if (kind === 'file') result.status = 'legacy-lock'
  else if (!result.holder || !result.holder.nonce || !result.holder.startedAt
    || result.holder.storePath !== storePath) result.status = 'invalid-metadata'
  else if (result.holder.protocolVersion !== STORE_LOCK_PROTOCOL_VERSION) result.status = 'unsupported-protocol'
  else result.status = 'held'
  return result
}

/** Read-only by default. PID information is diagnostic, not an acquisition rule. */
export function inspectStoreLock(options: StoreLockOptions = {}): StoreLockDiagnostic {
  const { storePath, lockPath } = resolveLockPaths(options)
  return inspectPaths(storePath, lockPath)
}

/**
 * Move one exact lock entry aside instead of deleting it: the metadata is the
 * only evidence of what happened, and a directory rename is atomic. Shared by
 * the crash reclaim in `acquire` and by offline recovery, which passes the
 * identity recheck it needs performed between the mkdir and the rename.
 */
function quarantineLockEntry(lockPath: string, beforeRename?: () => void): string {
  const quarantineDir = path.join(path.dirname(lockPath), `lock-recovery-${randomUUID()}`)
  fs.mkdirSync(quarantineDir, { mode: 0o700 })
  beforeRename?.()
  const quarantinePath = path.join(quarantineDir, path.basename(lockPath))
  fs.renameSync(lockPath, quarantinePath)
  return quarantinePath
}

/**
 * Local-filesystem, fail-closed directory lease. There is intentionally no TTL
 * and no force option.
 *
 * The one automatic reclaim is a **crash**: a well-formed entry whose recorded
 * process is provably gone (`ESRCH`) is moved aside and the election is retried
 * once. Force-quitting the desktop app is routine, and a lease that survived it
 * would make every unclean exit require an operator. Everything uncertain —
 * an in-flight initialization, corrupt or foreign metadata, an unsupported
 * protocol, a live or unprobeable PID — is still refused and left untouched for
 * `quarantineStoreLockForRecovery`.
 */
export class StoreLock implements StoreLease {
  readonly storePath: string
  readonly lockPath: string
  private ownership: { nonce: string; device: number; inode: number; createdAt: number } | null = null

  constructor(private readonly options: StoreLockOptions = {}) {
    const resolved = resolveLockPaths(options)
    this.storePath = resolved.storePath
    this.lockPath = resolved.lockPath
  }

  get held(): boolean { return this.ownership !== null }

  async acquire(owner: StoreLockOwner): Promise<void> {
    if (this.ownership) throw new Error(`This store lease is already acquired: ${this.lockPath}`)
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true })
    // Directory creation is the only election point, before any metadata exists.
    try {
      fs.mkdirSync(this.lockPath, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const diagnostic = inspectPaths(this.storePath, this.lockPath)
      const abandoned = (diagnostic.status === 'held' || diagnostic.status === 'legacy-lock')
        && diagnostic.processState === 'not-running'
      if (!abandoned) throw new LockConflictError(diagnostic.holder || UNKNOWN_HOLDER, diagnostic)
      try {
        quarantineLockEntry(this.lockPath)
      } catch (raced) {
        // A concurrent writer moved the same entry aside first; the election
        // below decides between us. Anything else is a real filesystem fault.
        if ((raced as NodeJS.ErrnoException).code !== 'ENOENT') throw raced
      }
      try {
        fs.mkdirSync(this.lockPath, { mode: 0o700 })
      } catch (retried) {
        if ((retried as NodeJS.ErrnoException).code !== 'EEXIST') throw retried
        const winner = inspectPaths(this.storePath, this.lockPath)
        throw new LockConflictError(winner.holder || UNKNOWN_HOLDER, winner)
      }
    }
    try {
      const nonce = randomUUID()
      const stat = fs.lstatSync(this.lockPath)
      const meta: LockMeta = {
        pid: process.pid, owner, acquiredAt: Date.now(), startedAt: PROCESS_STARTED_AT,
        version: this.options.version || process.env.npm_package_version || 'unknown',
        protocolVersion: STORE_LOCK_PROTOCOL_VERSION, nonce, storePath: this.storePath,
      }
      fs.writeFileSync(path.join(this.lockPath, META_FILENAME), JSON.stringify(meta, null, 2), { flag: 'wx', mode: 0o600 })
      this.ownership = { nonce, device: stat.dev, inode: stat.ino, createdAt: stat.birthtimeMs }
    } catch (error) {
      // Retain even our incomplete directory: partial initialization must never
      // cause a second writer to classify an in-flight lock as reclaimable.
      throw new StoreLockInitializationError(this.lockPath, error)
    }
  }

  assertHeld(): void {
    const current = inspectPaths(this.storePath, this.lockPath)
    if (!this.ownership || current.status !== 'held'
      || current.holder?.nonce !== this.ownership.nonce || current.holder.pid !== process.pid
      || current.identity?.device !== this.ownership.device || current.identity.inode !== this.ownership.inode
      || current.identity.createdAt !== this.ownership.createdAt) {
      throw new StoreLockOwnershipError(this.lockPath)
    }
  }

  release(): void {
    if (!this.ownership) return
    this.assertHeld()
    // Never recursively remove a lock: unexpected contents are evidence to keep.
    const entries = fs.readdirSync(this.lockPath)
    if (entries.length !== 1 || entries[0] !== META_FILENAME) throw new StoreLockOwnershipError(this.lockPath)
    fs.unlinkSync(path.join(this.lockPath, META_FILENAME))
    fs.rmdirSync(this.lockPath)
    this.ownership = null
  }
}

/** Reads either legacy file metadata or directory metadata for existing callers. */
export function readLockMeta(lockPath: string): LockMeta | null {
  const diagnostic = inspectPaths(path.dirname(path.dirname(lockPath)), lockPath)
  return diagnostic.holder
}

export function isProcessAlive(pid: number): boolean {
  return processState(pid) === 'running'
}

export interface StoreLockRecoveryOptions extends StoreLockOptions {
  /** Operator preconditions, not facts that PID probing can establish. */
  allHostsStopped: true
  automaticRestartsDisabled: true
  /** Exact read-only inspection reviewed while all hosts remain stopped. */
  expectedIdentity: StoreLockIdentity
}

export class StoreLockRecoveryError extends Error {
  constructor(message: string, public readonly diagnostic: StoreLockDiagnostic) {
    super(message)
    this.name = 'StoreLockRecoveryError'
  }
}

function sameIdentity(a: StoreLockIdentity | null, b: StoreLockIdentity): boolean {
  return !!a && a.device === b.device && a.inode === b.inode && a.createdAt === b.createdAt
    && a.modifiedAt === b.modifiedAt && a.kind === b.kind && a.metadataHash === b.metadataHash
}

/**
 * OFFLINE ONLY. Stop every host and supervisor first and prevent concurrent
 * startup for the entire operation. PID probing cannot enforce that premise.
 * Unknown/corrupt owners and live or possibly reused PIDs cannot be recovered.
 * Quarantines the exact inspected entry; never deletes it or starts a Backend.
 */
export function quarantineStoreLockForRecovery(options: StoreLockRecoveryOptions): string {
  const current = inspectStoreLock(options)
  const refuse = (message: string): never => { throw new StoreLockRecoveryError(message, current) }
  if (options.allHostsStopped !== true || options.automaticRestartsDisabled !== true) {
    refuse('Offline recovery requires all hosts stopped and automatic restarts disabled.')
  }
  if (!options.expectedIdentity || !sameIdentity(current.identity, options.expectedIdentity)) {
    refuse('Store lock identity changed or is unknown. Inspect again; no lock was removed.')
  }
  if ((current.status !== 'held' && current.status !== 'legacy-lock') || !current.holder) {
    refuse('Store lock ownership or protocol is unknown; automatic quarantine is refused.')
  }
  if (current.processState !== 'not-running') {
    refuse('The recorded process is running, reused, or cannot be verified as exited; quarantine is refused.')
  }
  return quarantineLockEntry(current.lockPath, () => {
    const checked = inspectStoreLock(options)
    if (!sameIdentity(checked.identity, options.expectedIdentity) || checked.processState !== 'not-running') {
      refuse('Store lock changed during offline recovery; no lock was removed.')
    }
  })
}

/**
 * The empty-object lease. A host that takes no lock still holds a store path and
 * still calls `assertHeld()` from every writer, so it answers the same three
 * questions rather than making each call site ask whether a lock exists at all.
 *
 * Not locking is the 2026-08-24 ruling: only the CLI daemon competes for a
 * mutex; the desktop shell and `server:start` defer to whoever already published
 * `<store>/run/http.json` and refuse to become a second writer.
 */
export class UnlockedStoreLease implements StoreLease {
  readonly storePath: string
  readonly lockPath = ''
  readonly held = true

  constructor(options: StoreLockOptions = {}) {
    this.storePath = canonicalizeStorePath(options.storePath || getOnethingStorePath())
  }

  acquire(): Promise<void> { return Promise.resolve() }
  assertHeld(): void { /* Nothing was taken, so nothing can be lost. */ }
  release(): void { /* Nothing to hand back. */ }
}

/** An owner asks for the mutex; its absence is a host that deliberately has none. */
export function createStoreLease(options: StoreLockOptions & { owner?: StoreLockOwner } = {}): StoreLease {
  return options.owner ? new StoreLock(options) : new UnlockedStoreLease(options)
}

export function formatCliLockConflict(holder: LockMeta, storePath = getOnethingStorePath()): string {
  if (holder.pid < 0) return `Cannot start daemon: lock ownership is unknown at ${storePath}. Stop all hosts and inspect the lock; do not force startup.`
  if (holder.owner === 'desktop') {
    return `Cannot start daemon: the onething desktop app is currently using ${storePath}. Close the app first, then retry.`
  }
  return `Cannot start daemon: ${holder.owner} holds the store lock (pid ${holder.pid}). If it exited abnormally, running this again reclaims the lock.`
}

export function formatDesktopLockConflict(holder: LockMeta): string {
  if (holder.pid < 0) return 'Cannot open onething: store lock ownership is unknown. Stop all hosts and inspect the lock; do not force startup.'
  if (holder.owner === 'daemon') {
    return `Cannot open onething: a background daemon holds the store lock (pid ${holder.pid}). Run "onething daemon stop", then reopen the app; if it exited abnormally, reopening reclaims the lock.`
  }
  return `Cannot open onething: ${holder.owner} holds the store lock (pid ${holder.pid}). If it exited abnormally, reopening reclaims the lock.`
}
