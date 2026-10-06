/**
 * 「凭证已锁定」状态(第④步批 0,决策 D10,`docs/design/two-process-2026-10.md` §2.1 第 4 条)。
 *
 * 把两件事折成界面要的一句话:主密钥此刻在不在(`credentials-master-key.ts`),以及还有没有
 * 没迁完的旧 `safeStorage` 密文(`credentials-safestorage-migration.ts`)。交出三样:
 *
 *  - `credentialsStatus()`:`spaces.credentialsStatus` 的答案 —— 档位(keychain / file / none)、
 *    状态(ready / loading / locked)、锁定原因码、此刻写出去的形态。**只答这些**,不带任何凭证原文;
 *  - `unlockCredentials()`:「重试」—— 重读主密钥,读到了就把待迁的旧密文迁完;
 *  - `installCredentialsLockBroadcaster(bus)`:状态一变就发全局事件 `credentials:locked`
 *    (出进程,`@shared/events` 的 `GLOBAL_EVENT_LEAVES_PROCESS` 那张表上登记为 true)。
 *
 * 另外两只给写入口与读入口用的 `await`:`prepareCredentialsWrite()`(用户亲手发起的写之前;
 * 新装时现造钥匙、钥匙丢了时换钥匙)与 `credentialsReady()`(异步读之前等钥匙读完)。
 */
import type { CredentialsLockedGlobalEvent } from '@shared/events/global-events.js'
import { getLogger } from '@onething/backend/logging'
import {
  awaitMasterKey,
  credentialsKeyringTier,
  ensureMasterKeyForWrite,
  masterKeyStateNow,
  onMasterKeyStateChange,
  reloadMasterKey,
  type CredentialsKeyringTier,
} from './credentials-master-key.js'
import {
  CredentialsLockedError,
  credentialsKeyContext,
  invalidateSpaceCredentialsCache,
  type CredentialsLockReason,
} from './credentials-pool.js'
import { acceptHandedOverLegacyPlaintexts, type LegacyCiphertextPlaintext } from './credentials-legacy-decryptor.js'
import { migrateOAuthSlotToDefaultSpace, migrateProviderConfigToDefaultSpace } from './credentials-default-space-migration.js'
import {
  migrateSafeStorageCredentials,
  pendingSafeStorageSpaces,
  type SafeStorageMigrationOptions,
} from './credentials-safestorage-migration.js'

const log = getLogger('credentials.lock')

/** `spaces.credentialsStatus` 的答案。 */
export interface CredentialsStatus {
  tier: CredentialsKeyringTier
  state: 'ready' | 'loading' | 'locked'
  reason?: CredentialsLockReason
  /** 此刻写出去的形态:`master-key` = 封好的;`none` = `none` 档的明文(如实说出来)。 */
  encryption: 'master-key' | 'none'
}

export function credentialsStatus(): CredentialsStatus {
  const tier = credentialsKeyringTier()
  const key = masterKeyStateNow(credentialsKeyContext)
  const encryption = tier === 'none' ? 'none' : 'master-key'
  if (key.status === 'loading') return { tier, state: 'loading', encryption }
  if (key.status === 'locked') return { tier, state: 'locked', reason: key.reason, encryption }
  if (pendingSafeStorageSpaces().spaces.length > 0) {
    return { tier, state: 'locked', reason: 'legacy-safestorage', encryption }
  }
  return { tier, state: 'ready', encryption }
}

/** 迁移要的那一句「另一个后端活着吗」:装配时递进来,「重试」时沿用。 */
const migrationWiring: { options: SafeStorageMigrationOptions } = { options: {} }

/**
 * 装配序列里的凭证那一步:等主密钥读完(最坏 3 秒),再把旧 `safeStorage` 密文迁进新信封。
 * 只记不抛 —— 锁着也让装配往下走,界面亮横幅。
 */
export async function prepareCredentialsAtAssembly(options: SafeStorageMigrationOptions = {}): Promise<CredentialsStatus> {
  migrationWiring.options = options
  await awaitMasterKey(credentialsKeyContext)
  try {
    await migrateSafeStorageCredentials(options)
  } catch (error) {
    log.error('credentials migration failed, will retry next boot', {}, error)
  }
  const status = credentialsStatus()
  if (status.state === 'locked') log.warn('credentials locked at startup', { tier: status.tier, reason: status.reason })
  else log.info('credentials ready', { tier: status.tier, encryption: status.encryption })
  return status
}

/** 「重试」。钥匙读到了就顺手把待迁的旧密文迁完,然后丢掉读缓存,让下一次读重新解。 */
export async function unlockCredentials(): Promise<CredentialsStatus> {
  await reloadMasterKey(credentialsKeyContext)
  if (masterKeyStateNow(credentialsKeyContext).status === 'ready' || pendingSafeStorageSpaces().spaces.length > 0) {
    try {
      await migrateSafeStorageCredentials(migrationWiring.options)
    } catch (error) {
      log.error('credentials migration retry failed', {}, error)
    }
  }
  invalidateSpaceCredentialsCache()
  notifyStatusListeners()
  return credentialsStatus()
}

/**
 * **旧 `safeStorage` 密文「Electron 先读后交」**(第④步批 2b,`docs/design/two-process-2026-10.md` §2.3 第 12 条)。
 *
 * Electron 在拉起后端之前读出仍为 `encryption: 'safeStorage'` 的凭证文件与旧单槽 `oauth-tokens.json` 的密文条目、
 * 用 `safeStorage` 解开,后端就绪后经 `spaces.handOverLegacyCredentials` 交进来。这里先把「密文 → 明文」收进
 * 旧解密器(`credentials-legacy-decryptor.ts`),再按批 0 **同一套判据**把三步迁移重跑一遍 —— 它们都幂等、
 * 都靠标记与文件形态判「还要不要做」:
 *
 *  1. 凭证池的旧信封 → 主密钥信封(`migrateSafeStorageCredentials`:解开 → `.migrating` → 逐条校验 → 改名备份);
 *  2. `settings.ai` 里的存量 provider 配置迁进默认空间(装配时可能因为旧单槽的令牌解不开而推迟);
 *  3. 旧单槽 `oauth-tokens.json` 归位进默认空间的凭证池(同上)。
 *
 * 之后丢掉读缓存、按新状态发一次 `credentials:locked`(解开了就是 `locked: false`,横幅撤下)。
 * 一步失败只记日志,不挡后面的;答此刻的状态。
 */
export async function acceptLegacyCredentialsHandOver(entries: readonly LegacyCiphertextPlaintext[]): Promise<{
  accepted: number
  migratedSpaces: number
  status: CredentialsStatus
}> {
  const accepted = acceptHandedOverLegacyPlaintexts(entries)
  let migratedSpaces = 0
  if (accepted > 0) {
    await awaitMasterKey(credentialsKeyContext)
    try {
      migratedSpaces = (await migrateSafeStorageCredentials(migrationWiring.options)).migrated.length
    } catch (error) {
      log.error('handed-over credentials migration failed', {}, error)
    }
    try {
      await migrateProviderConfigToDefaultSpace()
    } catch (error) {
      log.error('provider config migration after hand-over failed, will retry next boot', {}, error)
    }
    try {
      await migrateOAuthSlotToDefaultSpace()
    } catch (error) {
      log.error('oauth slot migration after hand-over failed, will retry next boot', {}, error)
    }
    log.info('legacy safeStorage credentials handed over by the desktop app', { entries: accepted, migratedSpaces })
  }
  invalidateSpaceCredentialsCache()
  notifyStatusListeners()
  return { accepted, migratedSpaces, status: credentialsStatus() }
}

/** 异步读之前等钥匙读完(钥匙串那一档的子进程还在跑时)。不抛。 */
export async function credentialsReady(): Promise<void> {
  await awaitMasterKey(credentialsKeyContext)
}

/**
 * 用户亲手发起的写之前(设置页填密钥、OAuth 登录写回、导入导出的凭证):新装时现造一把钥匙,
 * 钥匙丢了时换一把(旧文件由凭证池改名留底)。此刻写不了就抛 `CredentialsLockedError`。
 */
export async function prepareCredentialsWrite(): Promise<void> {
  const state = await ensureMasterKeyForWrite(credentialsKeyContext, { allowRekey: true })
  if (state.status === 'ready' || state.status === 'none') {
    invalidateSpaceCredentialsCache()
    return
  }
  throw new CredentialsLockedError(state.status === 'locked' ? state.reason : 'loading')
}

/* ── 广播 ─────────────────────────────────────────────────────────────────── */

const statusListeners = new Set<() => void>()

function notifyStatusListeners(): void {
  for (const listener of [...statusListeners]) listener()
}

function lockEventOf(status: CredentialsStatus): CredentialsLockedGlobalEvent {
  return {
    type: 'credentials:locked',
    locked: status.state === 'locked',
    tier: status.tier,
    state: status.state,
    ...(status.reason ? { reason: status.reason } : {}),
  }
}

/**
 * 状态变了就发 `credentials:locked`(带 `locked: false` 的那一条说「解开了」)。同一个状态不重复发。
 * 装配层在事件系统之后调它一次,返回的退订函数 `backend.own()` 掉。
 */
export function installCredentialsLockBroadcaster(bus: { emitGlobal(event: CredentialsLockedGlobalEvent): unknown }): () => void {
  let last = ''
  const emit = (): void => {
    const event = lockEventOf(credentialsStatus())
    const signature = JSON.stringify(event)
    if (signature === last) return
    last = signature
    try {
      bus.emitGlobal(event)
    } catch (error) {
      log.warn('credentials lock event not delivered', undefined, error)
    }
  }
  const offKey = onMasterKeyStateChange(emit)
  statusListeners.add(emit)
  emit()
  return () => {
    offKey()
    statusListeners.delete(emit)
  }
}
