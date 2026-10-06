/**
 * 存量 `safeStorage` 密文 → 主密钥信封的**自动迁移**(第④步批 0,决策 D3(a),
 * `docs/design/two-process-2026-10.md` §2.1 与施工单修正 1–3)。
 *
 * 今天 Electron 主进程还在自己装配后端,所以迁移是**进程内**的:装配时(主密钥可用之后)逐个空间
 * 读出 `encryption: 'safeStorage'` 的旧信封,用宿主递进来的旧解密器(`credentials-legacy-decryptor.ts`)
 * 解开,用主密钥重新封好写成新信封。路上没有回环、不走任何 RPC。
 *
 * ## 一个空间的步骤
 *
 * 1. 解开旧文件,得到一份凭证池(解不开 = 这一个空间失败,旧文件一个字节都不动);
 * 2. 新信封先写到旁边的 `credentials.json.migrating`;
 * 3. **逐条校验**:把 `.migrating` 重新读出、用主密钥拆开,与第 1 步那份逐条相等才往下走;
 * 4. 旧文件改名 `credentials.json.safestorage-backup`(仍是 `safeStorage` 密文,没有新暴露;删不删
 *    以后由用户定),`.migrating` 改名成 `credentials.json`。日志记一行。
 *
 * 第 4 步两次改名之间进程没了:下次启动看到「没有 `credentials.json`、有 `.migrating` 与备份」,
 * 把 `.migrating` 校验一遍再补那一次改名(`recoverInterruptedMigration`)。
 *
 * ## 不迁的三种情形
 *
 *  - 宿主没递旧解密器(独立 server、CLI):解不开,留给桌面;
 *  - `<store>/run/http.json` 指向另一个活着的、不是本进程的后端:别人正在写这些文件,拒绝迁移
 *    (施工单修正 3「停旧后端」写成代码);判活由装配层递进来(发现文件归 http-server);
 *  - 主密钥此刻拿不到(锁定、`none` 档):没有钥匙封新信封。
 *
 * 三种都记日志、旧文件原样不动、新信封不写,这几个空间记作「待迁」—— 状态面答「已锁定 ·
 * 旧密文待迁移」,下次启动或「重试」再来。
 */
import * as fs from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { getLogger } from '@onething/backend/logging'
import { notifySpaceDataChanged } from '@onething/backend/space'
import {
  credentialsKeyContext,
  invalidateSpaceCredentialsCache,
  listSpaceDirIdsOnDisk,
  listSpaceIdsWithCredentialsOnDisk,
  parseSpaceCredentialsFile,
  readSpaceCredentialsAtRest,
  serializeSpaceCredentialsDocument,
  spaceCredentialsFilePath,
  type SpaceCredentialsFile,
} from './credentials-pool.js'
import { ensureMasterKeyForWrite, masterKeyStateNow, openWithMasterKey } from './credentials-master-key.js'
import { legacySafeStorageDecryptor } from './credentials-legacy-decryptor.js'

const log = getLogger('credentials.migration')

export const SAFESTORAGE_BACKUP_SUFFIX = '.safestorage-backup'
const MIGRATING_SUFFIX = '.migrating'

/** 为什么这一次没迁(或没迁完)。 */
export type SafeStorageMigrationBlock =
  | 'no-legacy-decryptor'
  | 'other-backend-running'
  | 'no-master-key'
  | 'verify-failed'

export interface SafeStorageMigrationReport {
  /** 这一次迁好的空间。 */
  migrated: string[]
  /** 迁好的条目总数(日志与报告用)。 */
  entries: number
  /** 还躺着旧密文、没迁的空间。 */
  pending: string[]
  /** 有待迁空间时,第一条挡住它们的理由。 */
  blockedBy?: SafeStorageMigrationBlock
}

export interface SafeStorageMigrationOptions {
  /**
   * 「另一个活着的后端正在服务这个 store 吗」。由装配层递进来(读 `<store>/run/http.json` 并判活,
   * 排除本进程)。缺席 = 不查(单测)。
   */
  otherLiveBackend?: () => Promise<boolean>
}

/** 「待迁」名单:状态面据它答「已锁定 · 旧密文待迁移」。 */
const pendingLegacy = { spaces: [] as string[], blockedBy: undefined as SafeStorageMigrationBlock | undefined }

export function pendingSafeStorageSpaces(): { spaces: readonly string[]; blockedBy?: SafeStorageMigrationBlock } {
  return { spaces: pendingLegacy.spaces, ...(pendingLegacy.blockedBy ? { blockedBy: pendingLegacy.blockedBy } : {}) }
}

function backupPathFor(filePath: string): string {
  const base = `${filePath}${SAFESTORAGE_BACKUP_SUFFIX}`
  if (!fs.existsSync(base)) return base
  return `${base}-${new Date().toISOString().replace(/[:.]/g, '-')}`
}

function readEnvelope(filePath: string): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
  } catch {
    return null
  }
}

function countEntries(file: SpaceCredentialsFile): number {
  return Object.values(file.providers).reduce((sum, provider) => sum + provider.entries.length, 0)
}

/** 用主密钥把一份写好的新信封拆开,答它里面的凭证池;拆不开答 null。 */
function openSealedFile(filePath: string): SpaceCredentialsFile | null {
  const state = masterKeyStateNow(credentialsKeyContext)
  const envelope = readEnvelope(filePath)
  if (state.status !== 'ready' || !envelope || envelope.encryption !== 'master-key') return null
  if (typeof envelope.data !== 'string' || envelope.keyId !== state.key.keyId) return null
  try {
    const parsed: unknown = JSON.parse(openWithMasterKey(state.key, { data: envelope.data }))
    return parsed && typeof parsed === 'object'
      ? parseSpaceCredentialsFile({ providers: (parsed as { providers?: unknown }).providers })
      : null
  } catch {
    return null
  }
}

/** 上一次在两次改名之间断掉的那一格:校验 `.migrating`,对了就补上那一次改名。 */
function recoverInterruptedMigration(spaceId: string): boolean {
  const filePath = spaceCredentialsFilePath(spaceId)
  const migrating = `${filePath}${MIGRATING_SUFFIX}`
  if (fs.existsSync(filePath) || !fs.existsSync(migrating) || !fs.existsSync(`${filePath}${SAFESTORAGE_BACKUP_SUFFIX}`)) return false
  if (!openSealedFile(migrating)) {
    log.warn('interrupted credentials migration left an unreadable file; keeping it aside', { migrating })
    return false
  }
  fs.renameSync(migrating, filePath)
  log.info('interrupted credentials migration completed', { spaceId })
  return true
}

/** 一个空间:解旧 → 写 `.migrating` → 逐条校验 → 改名。失败时旧文件原样不动。 */
function migrateOneSpace(spaceId: string): { ok: true; entries: number } | { ok: false } {
  const filePath = spaceCredentialsFilePath(spaceId)
  const migrating = `${filePath}${MIGRATING_SUFFIX}`
  const legacy = legacySafeStorageDecryptor()
  const envelope = readEnvelope(filePath)
  if (!legacy || !envelope || typeof envelope.data !== 'string') return { ok: false }
  let source: SpaceCredentialsFile | null
  try {
    const parsed: unknown = JSON.parse(legacy.decryptString(Buffer.from(envelope.data, 'base64')))
    source = parsed && typeof parsed === 'object'
      ? parseSpaceCredentialsFile({ providers: (parsed as { providers?: unknown }).providers })
      : null
  } catch (error) {
    log.error('legacy credentials could not be decrypted; left untouched', { spaceId }, error)
    return { ok: false }
  }
  if (!source) {
    log.error('legacy credentials decrypted to an unreadable pool; left untouched', { spaceId })
    return { ok: false }
  }
  try {
    fs.writeFileSync(migrating, JSON.stringify(serializeSpaceCredentialsDocument(source), null, 2), 'utf-8')
    const reread = openSealedFile(migrating)
    if (!reread || !isDeepStrictEqual(reread, source)) {
      fs.rmSync(migrating, { force: true })
      log.error('migrated credentials did not verify; legacy file left untouched', { spaceId })
      return { ok: false }
    }
    const backup = backupPathFor(filePath)
    fs.renameSync(filePath, backup)
    fs.renameSync(migrating, filePath)
    log.info('credentials moved from safeStorage to the master key', { spaceId, entries: countEntries(source), backup })
    return { ok: true, entries: countEntries(source) }
  } catch (error) {
    try { fs.rmSync(migrating, { force: true }) } catch { /* 清洁失败不改结论 */ }
    log.error('credentials migration failed; legacy file left untouched', { spaceId }, error)
    return { ok: false }
  }
}

/**
 * 装配序列里的那一步(以及「重试」)。幂等:没有旧密文就什么都不做,也不碰钥匙。
 */
export async function migrateSafeStorageCredentials(
  options: SafeStorageMigrationOptions = {},
): Promise<SafeStorageMigrationReport> {
  // 先收上一次断在两次改名之间的那几格(没有正本、只剩 `.migrating` 与备份)。
  const recovered = listSpaceDirIdsOnDisk().filter(recoverInterruptedMigration)
  const legacySpaces = listSpaceIdsWithCredentialsOnDisk().filter(id => readSpaceCredentialsAtRest(id) === 'safeStorage')
  const finish = (report: SafeStorageMigrationReport): SafeStorageMigrationReport => {
    pendingLegacy.spaces = report.pending
    pendingLegacy.blockedBy = report.pending.length > 0 ? report.blockedBy : undefined
    if (report.migrated.length > 0 || recovered.length > 0) {
      invalidateSpaceCredentialsCache()
      for (const spaceId of [...report.migrated, ...recovered]) notifySpaceDataChanged({ spaceId, kind: 'credentials' })
    }
    return report
  }
  if (legacySpaces.length === 0) return finish({ migrated: [], entries: 0, pending: [] })

  const blocked = (blockedBy: SafeStorageMigrationBlock, why: string): SafeStorageMigrationReport => {
    log.warn(`safeStorage credentials not migrated: ${why}`, { reason: blockedBy, spaces: legacySpaces })
    return finish({ migrated: [], entries: 0, pending: legacySpaces, blockedBy })
  }
  if (!legacySafeStorageDecryptor()) {
    return blocked('no-legacy-decryptor', 'this host cannot decrypt safeStorage; start the desktop app once on this store')
  }
  if (options.otherLiveBackend && await options.otherLiveBackend()) {
    return blocked('other-backend-running', 'another live backend is serving this store; stop it and retry')
  }
  const key = await ensureMasterKeyForWrite(credentialsKeyContext)
  if (key.status !== 'ready') return blocked('no-master-key', 'the credentials master key is not available')

  const migrated: string[] = []
  const pending: string[] = []
  let entries = 0
  for (const spaceId of legacySpaces) {
    const result = migrateOneSpace(spaceId)
    if (result.ok) {
      migrated.push(spaceId)
      entries += result.entries
    } else {
      pending.push(spaceId)
    }
  }
  if (migrated.length > 0) log.info('safeStorage credentials migrated', { spaces: migrated.length, entries })
  return finish({ migrated, entries, pending, ...(pending.length > 0 ? { blockedBy: 'verify-failed' as const } : {}) })
}

/** 测试之间清掉「待迁」名单。 */
export function resetSafeStorageMigrationStateForTests(): void {
  pendingLegacy.spaces = []
  pendingLegacy.blockedBy = undefined
}
