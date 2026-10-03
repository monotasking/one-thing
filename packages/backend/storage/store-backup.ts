import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { StoreLock, canonicalizeStorePath } from './store-lock.js'
import { syncDirectoryChain, writeDurableJson } from './durable-json.js'

/**
 * Retained across interrupted restores, including after offline lock recovery.
 * Owned by the backup/restore flow itself — 2026-09-07 撤回了 `store-format.json`
 * 单向能力门之后,备份的元数据只住在备份目录里,不再读写用户库的能力声明。
 */
export const STORE_RESTORE_PENDING = 'store-restore.pending.json'

type BackupEntry =
  | { path: string; kind: 'directory' }
  | { path: string; kind: 'symlink'; target: string }
  | { path: string; kind: 'file'; size: number; sha256: string; mode: number }

export interface StoreBackupManifest {
  version: 1
  createdAt: string
  activationStorePath: string
  excluded: ['run', typeof STORE_RESTORE_PENDING]
  entries: BackupEntry[]
}

export class StoreBackupError extends Error {
  constructor(readonly code: 'STORE_BACKUP_INVALID' | 'STORE_BACKUP_INCOMPLETE' | 'STORE_RESTORE_INCOMPLETE', message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'StoreBackupError'
  }
}

const invalid = (message: string): never => { throw new StoreBackupError('STORE_BACKUP_INVALID', message) }
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
function disjoint(first: string, second: string): void {
  if (inside(first, second) || inside(second, first)) invalid('Store and backup/restore paths must be separate directory trees.')
}
function directory(root: string): void {
  if (!fs.lstatSync(root).isDirectory()) invalid(`Expected a real directory: ${root}`)
}
/**
 * 备份自己的判据(不读用户库的能力声明):源库里如果还留着一份**未完成**的
 * restore 标记,这份数据就是半拉子,不许被当成一份新备份的源。
 */
function assertRestoreComplete(root: string): void {
  let content: string
  try { content = fs.readFileSync(path.join(root, STORE_RESTORE_PENDING), 'utf8') }
  catch (error) { if (missing(error)) return; throw error }
  let restore: unknown
  try { restore = JSON.parse(content) as unknown }
  catch { invalid('Store restore is incomplete. Preserve this directory and restore the verified backup to a new destination.') }
  const value = restore as Record<string, unknown> | null
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || value.state !== 'complete'
    || typeof value.activationStorePath !== 'string' || !path.isAbsolute(value.activationStorePath)) {
    invalid('Store restore is incomplete. Preserve this directory and restore the verified backup to a new destination.')
  }
}
function relativeName(name: string): void {
  if (!name || /[\\\0]/.test(name) || path.posix.isAbsolute(name)
    || name.split('/').some(part => !part || part === '.' || part === '..') || name.split('/')[0] === 'run'
    || name === STORE_RESTORE_PENDING) invalid('Backup contains an unsafe or reserved entry path.')
}
function linkTarget(root: string, name: string, target: string): void {
  if (!target || /[\\\0]/.test(target) || path.isAbsolute(target)) invalid(`Unsupported link in backup: ${name}`)
  const resolved = path.resolve(root, path.dirname(name), target)
  if (!inside(root, resolved) || inside(path.join(root, 'run'), resolved)) invalid(`Link leaves the backed-up data tree: ${name}`)
}

/** Stream bounded chunks and verify the opened inode before reading any bytes. */
function fileEntry(source: string, name: string, destination?: string): Extract<BackupEntry, { kind: 'file' }> {
  const before = fs.lstatSync(source)
  if (!before.isFile()) invalid(`Expected a regular file: ${name}`)
  const input = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  let output: number | undefined
  try {
    const opened = fs.fstatSync(input)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) invalid(`File changed while backing up: ${name}`)
    if (destination) output = fs.openSync(destination, 'wx', 0o600)
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let size = 0
    for (;;) {
      const length = fs.readSync(input, buffer, 0, buffer.length, null)
      if (!length) break
      hash.update(buffer.subarray(0, length))
      if (output !== undefined) {
        let offset = 0
        while (offset < length) {
          const written = fs.writeSync(output, buffer, offset, length - offset)
          if (!written) throw new Error(`Short backup write: ${name}`)
          offset += written
        }
      }
      size += length
    }
    const after = fs.fstatSync(input)
    if (after.size !== size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      invalid(`File changed while backing up: ${name}`)
    }
    // Backups may contain credentials. Preserve owner executable permission,
    // but never grant group/other access in the new private directory.
    const mode = opened.mode & 0o700
    if (output !== undefined) {
      fs.fchmodSync(output, mode)
      fs.fsyncSync(output)
    }
    return { path: name, kind: 'file', size, sha256: hash.digest('hex'), mode }
  } finally {
    try { if (output !== undefined) fs.closeSync(output) } finally { fs.closeSync(input) }
  }
}

function inventory(root: string, destination?: string): BackupEntry[] {
  directory(root)
  const entries: BackupEntry[] = []
  function walk(relative: string): void {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      if (!relative && (name === 'run' || name === STORE_RESTORE_PENDING)) continue
      const key = relative ? `${relative}/${name}` : name
      relativeName(key)
      const source = path.join(root, key)
      const target = destination ? path.join(destination, key) : undefined
      const stat = fs.lstatSync(source)
      if (stat.isDirectory()) {
        if (target) fs.mkdirSync(target, { mode: 0o700 })
        entries.push({ path: key, kind: 'directory' })
        walk(key)
        if (target) syncDirectoryChain(target)
      } else if (stat.isFile()) entries.push(fileEntry(source, key, target))
      else if (stat.isSymbolicLink()) {
        const link = fs.readlinkSync(source)
        linkTarget(root, key, link)
        if (target) fs.symlinkSync(link, target)
        entries.push({ path: key, kind: 'symlink', target: link })
      } else invalid(`Cannot produce a complete backup of this entry: ${key}`)
    }
  }
  walk('')
  if (destination) syncDirectoryChain(destination)
  return entries
}

function readManifest(backupPath: string): StoreBackupManifest {
  directory(backupPath)
  const names = fs.readdirSync(backupPath).sort()
  if (names.join(',') !== 'data,manifest.json') invalid('Backup is incomplete or contains unexpected top-level entries.')
  const manifestPath = path.join(backupPath, 'manifest.json')
  if (!fs.lstatSync(manifestPath).isFile()) invalid('Backup manifest must be a regular file.')
  let value: StoreBackupManifest
  try { value = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as StoreBackupManifest }
  catch (cause) { throw new StoreBackupError('STORE_BACKUP_INVALID', 'Cannot read backup manifest.', { cause }) }
  if (!value || value.version !== 1 || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.activationStorePath !== 'string' || !path.isAbsolute(value.activationStorePath)
    || !Array.isArray(value.excluded) || value.excluded.join(',') !== `run,${STORE_RESTORE_PENDING}` || !Array.isArray(value.entries)) invalid('Invalid backup manifest.')
  const paths = new Set<string>()
  for (const entry of value.entries) {
    if (!entry || typeof entry.path !== 'string') invalid('Invalid backup entry.')
    relativeName(entry.path)
    if (paths.has(entry.path)) invalid('Duplicate backup entry.')
    paths.add(entry.path)
    if (entry.kind === 'file') {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)
        || !Number.isInteger(entry.mode) || entry.mode < 0 || (entry.mode & ~0o700) !== 0) invalid('Invalid backup file description.')
    } else if (entry.kind === 'symlink') {
      if (typeof entry.target !== 'string') invalid('Invalid backup link.')
      linkTarget(path.join(backupPath, 'data'), entry.path, entry.target)
    } else if (entry.kind !== 'directory') invalid('Unknown backup entry kind.')
  }
  return value
}

/** Read-only verification of an immutable backup, never live-store admission. */
export function verifyStoreBackup(options: { backupPath: string }): StoreBackupManifest {
  const root = canonicalizeStorePath(options.backupPath)
  const manifest = readManifest(root)
  const data = path.join(root, 'data')
  if (fs.readdirSync(data).some(name => name === 'run' || name === STORE_RESTORE_PENDING)) invalid('Backup data contains excluded runtime or restore state.')
  const entries = inventory(data)
  if (digest(entries) !== digest(manifest.entries)) invalid('Backup contents do not match its manifest; no restore is safe.')
  return manifest
}

/** Stop hosts first. This independently acquires the same lease as every writer. */
export async function createStoreBackup(options: { storePath: string; backupPath: string }): Promise<StoreBackupManifest> {
  const source = canonicalizeStorePath(options.storePath)
  const backup = canonicalizeStorePath(options.backupPath)
  disjoint(source, backup)
  directory(source)
  const lease = new StoreLock({ storePath: source })
  await lease.acquire('maintenance')
  try {
    lease.assertHeld()
    assertRestoreComplete(source)
    fs.mkdirSync(backup, { mode: 0o700 }) // Exclusive: never replace an earlier backup.
    try {
      const data = path.join(backup, 'data')
      fs.mkdirSync(data, { mode: 0o700 })
      const entries = inventory(source, data)
      lease.assertHeld()
      if (digest(inventory(source)) !== digest(entries)) invalid('Source changed during backup; no complete manifest was published.')
      const manifest: StoreBackupManifest = { version: 1, createdAt: new Date().toISOString(), activationStorePath: source,
        excluded: ['run', STORE_RESTORE_PENDING], entries }
      writeDurableJson(path.join(backup, 'manifest.json'), manifest)
      verifyStoreBackup({ backupPath: backup })
      return manifest
    } catch (cause) {
      // A failed copy remains inspectable and is not presented as a backup.
      throw new StoreBackupError('STORE_BACKUP_INCOMPLETE', `Backup failed; preserve or remove the incomplete destination: ${backup}`, { cause })
    }
  } finally { lease.release() }
}

/**
 * Restore into a new staging directory. Original store and backup remain intact.
 * Once verified, activate offline at activationStorePath; this is not a path
 * migration and does not rewrite authoritative journals or stored file paths.
 */
export async function restoreStoreBackup(options: {
  backupPath: string
  storePath: string
}): Promise<StoreBackupManifest> {
  const backup = canonicalizeStorePath(options.backupPath)
  const target = canonicalizeStorePath(options.storePath)
  disjoint(backup, target)
  const manifest = verifyStoreBackup(options)
  fs.mkdirSync(target, { mode: 0o700 })
  const lease = new StoreLock({ storePath: target })
  await lease.acquire('maintenance')
  const pending = path.join(target, STORE_RESTORE_PENDING)
  try {
    writeDurableJson(pending, { version: 1, backupPath: backup, manifestDigest: digest(manifest) })
    const entries = inventory(path.join(backup, 'data'), target)
    lease.assertHeld()
    if (digest(entries) !== digest(manifest.entries) || digest(inventory(target)) !== digest(manifest.entries)) {
      invalid('Backup changed during restore or restored bytes failed verification.')
    }
    // Revalidate the immutable source too; a manifest swapped during the copy
    // must not silently authorize a different set of bytes.
    if (digest(verifyStoreBackup(options)) !== digest(manifest)) invalid('Backup manifest changed during restore.')
    syncDirectoryChain(target)
    // A complete marker is published only after every byte and directory is
    // durable. Admission still refuses this staging path until offline activation
    // at the original location, including after an operator recovers its lock.
    writeDurableJson(pending, { version: 1, state: 'complete', activationStorePath: manifest.activationStorePath,
      backupPath: backup, manifestDigest: digest(manifest) })
    lease.release()
    return manifest
  } catch (cause) {
    // Keep the lease on any uncertain completion. The pending marker survives
    // offline lock recovery; restarting cannot load a partially copied store.
    try { fs.lstatSync(pending) }
    catch (error) {
      if (missing(error)) {
        try { writeDurableJson(pending, { version: 1, backupPath: backup, manifestDigest: digest(manifest) }) } catch { /* Lease still refuses startup. */ }
      }
    }
    throw new StoreBackupError('STORE_RESTORE_INCOMPLETE', `Restore failed; lease retained at ${target}. Preserve it and restore the verified backup to a different new directory.`, { cause })
  }
}
