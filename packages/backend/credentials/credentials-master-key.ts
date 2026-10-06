/**
 * 凭证主密钥(第④步批 0「凭证归后端」,`docs/design/two-process-2026-10.md` §2.1 与决策 D2)。
 *
 * 后端自己持有一把 32 字节的主密钥,用 AES-256-GCM 封住每个空间的 `credentials.json`。从前这件事
 * 借的是 Electron 的 `safeStorage`,于是一出 Electron 进程(独立 server、CLI、以后的后端子进程)
 * 凭证就解不开 —— 那正是 08-31 那次事故。这把钥匙只靠 Node 内建的 `node:crypto`,零原生依赖。
 *
 * ## 钥匙放哪:三档
 *
 * | 档 | 放哪 | 谁用 |
 * | --- | --- | --- |
 * | `keychain` | macOS 钥匙串里一条通用密码(经 `security` 命令,见 `credentials-keychain.ts`) | macOS 的缺省档 |
 * | `file` | `<store>/credentials-master.key`(0600) | 别的平台的缺省档;门脚本显式选它 |
 * | `none` | 不加密,凭证文件如实写 `encryption: 'none'` | 只给 vitest(全局 setup 强制) |
 *
 * 档位只看 `ONETHING_CREDENTIALS_KEYRING`;不设时 macOS 是 `keychain`、别的平台是 `file`,**永远不会
 * 落到 `none`**(`credentials-master-key.test.ts` 钉着)。钥匙串条目的账户名带 store 路径的哈希,所以
 * 临时 store 不可能撞上 `~/.onething` 那一条。
 *
 * ## 什么时候读
 *
 * **首次用到时**。import 这只模块什么都不做;状态挂在一只 `const` 持有器上,按「档位 + store 路径」
 * 分格。`file` / `none` 两档同步就答得出;`keychain` 档要起子进程,所以是异步的 —— 装配在一开头
 * 起一次加载、在第一处要用钥匙的地方(凭证迁移那一步)`await` 它,子进程自己带 3 秒硬超时,
 * 所以最坏多等 3 秒就进「已锁定」,不会挂住。
 *
 * ## 钥匙不在时
 *
 * 存放处找不到钥匙,要分两种:盘上**没有**任何用主密钥封过的凭证 —— 那是新装,状态是 `absent`,
 * 第一次写凭证时现造一把;盘上**有** —— 钥匙丢了(钥匙串条目被删、store 被拷到别的电脑),状态是
 * 「已锁定 · 找不到密钥」,不悄悄换一把新钥匙(换了就再也解不开旧文件)。只有用户亲手发起的写
 * (导入导出的凭证、重新登录、重新填密钥)才允许换钥匙(`allowRekey`),旧文件改名留底,不删。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getOnethingStorePath } from '@onething/backend/storage'
import { getLogger } from '@onething/backend/logging'
import {
  KEYCHAIN_DEFAULT_TIMEOUT_MS,
  readKeychainSecret,
  writeKeychainSecret,
  type KeychainOutcome,
} from './credentials-keychain.js'

const log = getLogger('credentials.master-key')

export type CredentialsKeyringTier = 'keychain' | 'file' | 'none'

/**
 * 锁定的原因码。界面按码选一句话,后端不回答句子:
 *  - `keychain-timeout`:`security` 到点没回;
 *  - `keychain-denied`:钥匙串拒绝了(授权框上点了拒绝、不允许交互);
 *  - `key-missing`:存放处没有钥匙,而盘上有用它封过的凭证;
 *  - `keychain-failed`:起不来 / 退出码说不准 / 输出读不懂(不猜原因)。
 */
export type MasterKeyLockReason = 'keychain-timeout' | 'keychain-denied' | 'key-missing' | 'keychain-failed'

export interface MasterKey {
  key: Buffer
  /** 钥匙的指纹(sha256 的前 16 个十六进制字符)。写进信封,用来认「这份文件是不是这把钥匙封的」。 */
  keyId: string
}

export type MasterKeyState =
  | { status: 'loading' }
  | { status: 'ready'; key: MasterKey }
  | { status: 'absent' }
  | { status: 'locked'; reason: MasterKeyLockReason }
  | { status: 'none' }

/**
 * 调用方递进来的一句话:「盘上有没有用主密钥封过的凭证」。主密钥不认识凭证文件的位置,
 * 判据在凭证池那一侧(`anySpaceCredentialsSealedOnDisk`)。
 */
export interface MasterKeyContext {
  sealedDataExists: () => boolean
}

const KEYRING_ENV = 'ONETHING_CREDENTIALS_KEYRING'
export const MASTER_KEY_FILE_NAME = 'credentials-master.key'
/** 钥匙串条目的服务名。账户名是 `store-<store 路径哈希>`。 */
export const KEYCHAIN_SERVICE = 'onething-credentials'
const KEY_BYTES = 32

/** 档位判据。纯函数:环境变量不设时 macOS 是钥匙串、别的平台是文件,永远不是 `none`。 */
export function resolveCredentialsKeyringTier(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CredentialsKeyringTier {
  const raw = env[KEYRING_ENV]?.trim().toLowerCase()
  if (raw === 'keychain' || raw === 'file' || raw === 'none') return raw
  if (raw) log.warn('unknown credentials keyring tier, using the platform default', { value: raw })
  return platform === 'darwin' ? 'keychain' : 'file'
}

/** 这个 store 的钥匙串账户名。只用路径的哈希,不把路径本身写进钥匙串。 */
export function keychainAccountForStore(storePath: string): string {
  return `store-${createHash('sha256').update(path.resolve(storePath)).digest('hex').slice(0, 16)}`
}

export function masterKeyFilePath(storePath: string = getOnethingStorePath()): string {
  return path.join(storePath, MASTER_KEY_FILE_NAME)
}

function masterKeyOf(key: Buffer): MasterKey {
  return { key, keyId: createHash('sha256').update(key).digest('hex').slice(0, 16) }
}

function parseStoredKey(text: string | undefined): MasterKey | null {
  const hex = text?.trim() ?? ''
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null
  return masterKeyOf(Buffer.from(hex, 'hex'))
}

interface MasterKeyHolder {
  tier: CredentialsKeyringTier
  storePath: string
  state: MasterKeyState
  loading: Promise<MasterKeyState> | null
}

/**
 * 持有器:按「档位 + store 路径」分格。一个进程先后装配两台不同 store 的后端(测试、
 * `server:start` 接管)各拿各的钥匙。
 */
const holders = new Map<string, MasterKeyHolder>()

/** 门与单测换掉 `security` 命令与超时用(`gate:credentials` ⑦ 用一只假的慢命令)。 */
const keychainOverrides: { command?: string; timeoutMs?: number } = {}

/** 状态变化的听众(锁定状态的广播器挂在这里)。 */
const stateListeners = new Set<() => void>()

export function onMasterKeyStateChange(listener: () => void): () => void {
  stateListeners.add(listener)
  return () => stateListeners.delete(listener)
}

function setState(holder: MasterKeyHolder, state: MasterKeyState): MasterKeyState {
  const before = holder.state.status
  holder.state = state
  if (state.status === 'locked') log.warn('credentials master key locked', { tier: holder.tier, reason: state.reason })
  else if (before !== state.status) log.info('credentials master key state', { tier: holder.tier, status: state.status })
  for (const listener of [...stateListeners]) {
    try {
      listener()
    } catch (error) {
      log.warn('master key state listener failed', undefined, error)
    }
  }
  return state
}

function currentHolder(): MasterKeyHolder {
  const tier = resolveCredentialsKeyringTier()
  const storePath = getOnethingStorePath()
  const id = `${tier}:${path.resolve(storePath)}`
  let holder = holders.get(id)
  if (!holder) {
    holder = { tier, storePath, state: { status: 'loading' }, loading: null }
    holders.set(id, holder)
  }
  return holder
}

/** 这个进程此刻用的档位。 */
export function credentialsKeyringTier(): CredentialsKeyringTier {
  return currentHolder().tier
}

function keychainOptions() {
  return {
    timeoutMs: keychainOverrides.timeoutMs ?? KEYCHAIN_DEFAULT_TIMEOUT_MS,
    ...(keychainOverrides.command ? { command: keychainOverrides.command } : {}),
  }
}

function lockReasonOf(outcome: KeychainOutcome): MasterKeyLockReason {
  if (outcome.kind === 'timeout') return 'keychain-timeout'
  if (outcome.kind === 'denied') return 'keychain-denied'
  return 'keychain-failed'
}

/** 文件档同步读。读到坏文件不覆盖它 —— 那可能是用户唯一的那把钥匙,判「已锁定」。 */
function loadFileKey(holder: MasterKeyHolder, context: MasterKeyContext): MasterKeyState {
  const filePath = masterKeyFilePath(holder.storePath)
  try {
    if (fs.existsSync(filePath)) {
      const key = parseStoredKey(fs.readFileSync(filePath, 'utf-8'))
      if (key) return setState(holder, { status: 'ready', key })
      log.warn('credentials master key file unreadable', { filePath })
      return setState(holder, { status: 'locked', reason: 'keychain-failed' })
    }
  } catch (error) {
    log.warn('credentials master key file read failed', { filePath }, error)
    return setState(holder, { status: 'locked', reason: 'keychain-failed' })
  }
  return setState(holder, context.sealedDataExists() ? { status: 'locked', reason: 'key-missing' } : { status: 'absent' })
}

async function loadKeychainKey(holder: MasterKeyHolder, context: MasterKeyContext): Promise<MasterKeyState> {
  const outcome = await readKeychainSecret(KEYCHAIN_SERVICE, keychainAccountForStore(holder.storePath), keychainOptions())
  if (outcome.kind === 'ok') {
    const key = parseStoredKey(outcome.value)
    if (key) return setState(holder, { status: 'ready', key })
    log.warn('keychain answered but the master key could not be parsed')
    return setState(holder, { status: 'locked', reason: 'keychain-failed' })
  }
  if (outcome.kind === 'not-found') {
    return setState(holder, context.sealedDataExists() ? { status: 'locked', reason: 'key-missing' } : { status: 'absent' })
  }
  if (outcome.kind === 'failed') log.warn('keychain read failed', { detail: outcome.detail })
  return setState(holder, { status: 'locked', reason: lockReasonOf(outcome) })
}

function startLoad(holder: MasterKeyHolder, context: MasterKeyContext): Promise<MasterKeyState> {
  if (holder.loading) return holder.loading
  if (holder.tier === 'none') return Promise.resolve(setState(holder, { status: 'none' }))
  if (holder.tier === 'file') return Promise.resolve(loadFileKey(holder, context))
  if (holder.state.status !== 'loading') setState(holder, { status: 'loading' })
  holder.loading = loadKeychainKey(holder, context).finally(() => {
    holder.loading = null
  })
  return holder.loading
}

/**
 * **此刻**的状态,同步。第一次问时顺手起加载:`file` / `none` 两档当场答完;`keychain` 档答
 * `loading`,子进程在后台跑。凭证池的同步读写走这一口。
 */
export function masterKeyStateNow(context: MasterKeyContext): MasterKeyState {
  const holder = currentHolder()
  if (holder.state.status === 'loading' && !holder.loading) void startLoad(holder, context)
  return holder.state
}

/** 等加载完。已经有结论就直接答结论(锁定也是结论,重试走 `reloadMasterKey`)。 */
export async function awaitMasterKey(context: MasterKeyContext): Promise<MasterKeyState> {
  const holder = currentHolder()
  if (holder.loading) return holder.loading
  if (holder.state.status !== 'loading') return holder.state
  return startLoad(holder, context)
}

/** 「重试」:丢掉锁定的结论再读一次。已经就绪的不重读。 */
export async function reloadMasterKey(context: MasterKeyContext): Promise<MasterKeyState> {
  const holder = currentHolder()
  if (holder.loading) return holder.loading
  if (holder.state.status === 'ready' || holder.state.status === 'none') return holder.state
  setState(holder, { status: 'loading' })
  return startLoad(holder, context)
}

async function storeNewKey(holder: MasterKeyHolder, key: MasterKey): Promise<boolean> {
  const hex = key.key.toString('hex')
  if (holder.tier === 'file') {
    const filePath = masterKeyFilePath(holder.storePath)
    const temp = `${filePath}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(temp, `${hex}\n`, { encoding: 'utf-8', mode: 0o600 })
      fs.renameSync(temp, filePath)
      fs.chmodSync(filePath, 0o600)
      return true
    } catch (error) {
      log.error('credentials master key file write failed', { filePath }, error)
      try { fs.rmSync(temp, { force: true }) } catch { /* 清洁失败不改结论 */ }
      return false
    }
  }
  const outcome = await writeKeychainSecret(KEYCHAIN_SERVICE, keychainAccountForStore(holder.storePath), hex, keychainOptions())
  if (outcome.kind === 'ok') return true
  log.error('keychain write failed', { outcome: outcome.kind, ...(outcome.kind === 'failed' ? { detail: outcome.detail } : {}) })
  return false
}

/**
 * 写之前要一把能用的钥匙。`absent` 时现造一把(新装,没有旧文件可丢);`key-missing` 只在
 * `allowRekey`(用户亲手发起的写)时换钥匙 —— 换了之后旧钥匙封的文件由凭证池在下一次写那个空间
 * 时改名留底。其余锁定原因(超时、拒绝)永远不换钥匙:钥匙在,只是此刻拿不到。
 */
export async function ensureMasterKeyForWrite(
  context: MasterKeyContext,
  options: { allowRekey?: boolean } = {},
): Promise<MasterKeyState> {
  const holder = currentHolder()
  const state = await awaitMasterKey(context)
  const mayCreate = state.status === 'absent'
    || (state.status === 'locked' && state.reason === 'key-missing' && options.allowRekey === true)
  if (!mayCreate) return state
  const key = masterKeyOf(randomBytes(KEY_BYTES))
  if (!(await storeNewKey(holder, key))) {
    return setState(holder, { status: 'locked', reason: holder.tier === 'file' ? 'keychain-failed' : 'keychain-denied' })
  }
  if (state.status === 'locked') log.warn('credentials master key replaced after it went missing', { tier: holder.tier, keyId: key.keyId })
  else log.info('credentials master key created', { tier: holder.tier, keyId: key.keyId })
  return setState(holder, { status: 'ready', key })
}

/* ── 封与拆 ──────────────────────────────────────────────────────────────── */

export interface MasterKeySealed {
  keyId: string
  /** base64:12 字节 IV ‖ 16 字节 GCM 标签 ‖ 密文。 */
  data: string
}

const AAD = Buffer.from('onething-credentials/v2', 'utf8')

export function sealWithMasterKey(key: MasterKey, plaintext: string): MasterKeySealed {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key.key, iv)
  cipher.setAAD(AAD)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return { keyId: key.keyId, data: Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64') }
}

/** 拆不开(钥匙不对、被改过)就抛 —— 调用方决定这算「坏文件」还是「锁定」。 */
export function openWithMasterKey(key: MasterKey, sealed: { data: string }): string {
  const raw = Buffer.from(sealed.data, 'base64')
  if (raw.length < 28) throw new Error('sealed credentials payload is too short')
  const decipher = createDecipheriv('aes-256-gcm', key.key, raw.subarray(0, 12))
  decipher.setAAD(AAD)
  decipher.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
}

/* ── 测试与门 ────────────────────────────────────────────────────────────── */

/** 清空所有持有器(换 store / 换档位的测试之间用)。 */
export function resetCredentialsMasterKeyForTests(): void {
  holders.clear()
}

/** 换掉 `security` 命令与超时。传空对象恢复缺省。 */
export function configureCredentialsKeychainForTests(overrides: { command?: string; timeoutMs?: number }): void {
  keychainOverrides.command = overrides.command
  keychainOverrides.timeoutMs = overrides.timeoutMs
}
