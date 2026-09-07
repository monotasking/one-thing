/**
 * per-space provider 凭证池 —— `workspaces/<id>/credentials.json`(批 B3)。
 *
 * 三条硬约束(设计见 `docs/design/workspace-spaces-2026-08.md` §3 与批 B):
 *
 *  1. **第一天就是池**。落盘形状是 `providers[<pid>].entries[]` + `policy`,哪怕
 *     本切片的 UI 只写一条、policy 恒 `'single'`。轮换(批 D)只加读法,不迁移数据。
 *  2. **独立成文件**,不并进 `space.json`。整空间导出(批 C)默认剔除凭证,
 *     两者混在一个文件里就没法剔。
 *  3. **default space 不用这个文件**。默认空间的凭证源是 `settings.ai` —— 那不是
 *     回落,那是身份定义(见 provider-credentials.ts 的顶注)。所以这里读到
 *     default 的 credentials.json 也不特殊对待:它就是一份没人问的文件。
 *
 * 与 overlay.ts 同构:整份判废式解析、按**绝对文件路径**为 key 的读缓存
 * (换 store 根天然换 key,不需要反向失效钩子)。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { notifySpaceDataChanged } from './notifications.js'
import { ensureSpaceDir, spaceDir } from './persistence.js'
import { DEFAULT_SPACE_ID, isValidSpaceId } from './types.js'
// 类型-only:`auth/` 反过来 import 本模块(space-token-store),值 import 会成环。
import type { OnethingTokenCryptoAdapter } from '../auth/token-store.js'

import { getLogger } from '../logging/index.js'

const log = getLogger('spaces')

/** 凭证类型。`oauth` 第一天进 schema,但非 default 空间本切片一律判未配置。 */
export type SpaceCredentialAuthType = 'apiKey' | 'oauth'

/**
 * 来源。本切片恒 `'user'`;`plugin:<id>` 是批 F(插件订阅接入)的位子 ——
 * 卸载插件要能按这个字段找到并归档它带来的凭证。
 */
export type SpaceCredentialSource = string

/**
 * 轮换策略(批 D 起三种全部生效)。
 *
 *  - `single`:池的头一条(跳过冷却中的)。**这是 B3 的原语义,一字未改** ——
 *    没有池的用户不该因为批 D 的到来看见任何行为变化。
 *  - `priority-failover`:按 entries 顺序取第一条**可用且不在冷却里**的。
 *    与 single 的区别是它还会跳过「用不了的」entry(OAuth 型 / 空 key)。
 *  - `round-robin`:在同一批候选里轮转,游标是进程内存的(见 `roundRobinCursors`)。
 *
 *  - `plugin:<id>:<name>`(批 E):委派给插件注册的策略。宿主注入
 *    `configureSpaceCredentialPluginStrategyHost` 之后,这个分支才认得它;
 *    策略缺席 / 超时 / 抛错 / 返回非法 id **一律回落 `priority-failover`** ——
 *    「换钥匙」从来就有一个可用的默认答案,没有理由让它变成起不了流。
 *
 * 形状对不上的取值(既不是三个内置名,也不是合法的 `plugin:<id>:<name>`)
 * 一律按 `single` 解析 —— 不认识的策略退回最保守的那一条,而不是猜。
 */
export type SpaceCredentialPolicy =
  | 'single'
  | 'priority-failover'
  | 'round-robin'
  | string

/** 内置策略的白名单。形状不认识的取值按 `single` 解析。 */
export const BUILTIN_SPACE_CREDENTIAL_POLICIES = [
  'single',
  'priority-failover',
  'round-robin',
] as const

export type BuiltinSpaceCredentialPolicy = (typeof BUILTIN_SPACE_CREDENTIAL_POLICIES)[number]

/**
 * 插件策略的取值形状:`plugin:<pluginId>:<name>`(批 E)。
 *
 * 判的是**形状**,不是「这个策略此刻注册着没有」—— 后者是运行期的事,而
 * `policy` 是要落盘的用户选择:插件被停用时把它规范化掉,等于替用户撤销他的
 * 选择,插件回来也不会恢复。所以形状合法就存下来,能不能用在读侧现问。
 *
 * 三个内置名都不含冒号,所以两个命名空间物理分开,插件抢不到内置名。
 */
export const PLUGIN_SPACE_CREDENTIAL_POLICY_PATTERN =
  /^plugin:[a-zA-Z0-9][a-zA-Z0-9._-]*:[a-z0-9-]+$/

export function isPluginSpaceCredentialPolicy(
  policy: SpaceCredentialPolicy | undefined,
): policy is string {
  return typeof policy === 'string' && PLUGIN_SPACE_CREDENTIAL_POLICY_PATTERN.test(policy)
}

/**
 * 规范化。**批 E 起 `plugin:<id>:<name>` 原样通过** —— 批 D 时它会被压成
 * `'single'`,那意味着整池写(`setSpaceProviderCredentialPool`)会把用户刚选的
 * 插件策略当场抹掉,插件策略根本存不进去。
 */
export function normalizeSpaceCredentialPolicy(
  policy: SpaceCredentialPolicy | undefined,
): SpaceCredentialPolicy {
  if ((BUILTIN_SPACE_CREDENTIAL_POLICIES as readonly string[]).includes(policy ?? '')) {
    return policy as BuiltinSpaceCredentialPolicy
  }
  return isPluginSpaceCredentialPolicy(policy) ? policy : 'single'
}

export interface SpaceCredentialEntry {
  /** 稳定 id,与内容无关 —— 换 key 不换 id,账本归因才连得上。 */
  id: string
  label: string
  authType: SpaceCredentialAuthType
  apiKey?: string
  oauthToken?: unknown
  source: SpaceCredentialSource
  /** 配额耗尽冷却的到期时间戳(ms)。批 D 消费;本切片只持久化与判「还在冷却」。 */
  cooldownUntil?: number
  /**
   * 端点覆盖。**§3 表外的扩展字段**(勘误记在设计文档批 B3):池里两条 key 完全
   * 可以指向不同端点,把 baseUrl 提到 provider 级就表达不了这件事。
   */
  baseUrl?: string
  /** provider 自己的档位(zhipu/qwen/kimi 的 apiMode)。同上,§3 表外扩展。 */
  apiMode?: string
  /**
   * provider 自己的**地区**(qwen/kimi 的 `cn` / `intl`)。批 B10 补上 ——
   * 与 apiMode 同一格语义,也同一条理由:国内版与海外版是**两个互不相通的账号**,
   * 一把 moonshot.cn 的 key 拿到 moonshot.ai 去就是 401。所以它属于**这一条
   * 凭证**,不属于 provider,更不属于全局 settings。
   */
  region?: string
}

export interface SpaceProviderCredentials {
  entries: SpaceCredentialEntry[]
  policy: SpaceCredentialPolicy
}

export interface SpaceCredentialsFile {
  providers: Record<string, SpaceProviderCredentials>
}

export const DEFAULT_SPACE_CREDENTIAL_POLICY: SpaceCredentialPolicy = 'single'
export const SPACE_CREDENTIAL_SOURCE_USER = 'user'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

/**
 * 单条 entry 解析。**结构不认就整份判废**(返回 null → 由上层把整个文件判废),
 * 与 index.json / space.json 同一口径:半份凭证表比空表更难排查 —— 用户会看见
 * 「明明配了却说没配」,而日志里什么都没有。
 */
export function parseSpaceCredentialEntry(value: unknown): SpaceCredentialEntry | null {
  if (!isRecord(value)) return null
  const id = trimmedString(value.id)
  if (!id) return null
  const authType = value.authType
  if (authType !== 'apiKey' && authType !== 'oauth') return null
  const source = trimmedString(value.source)
  if (!source) return null
  const entry: SpaceCredentialEntry = {
    id,
    label: trimmedString(value.label) ?? id,
    authType,
    source,
  }
  const apiKey = trimmedString(value.apiKey)
  if (apiKey) entry.apiKey = apiKey
  if (value.oauthToken !== undefined) entry.oauthToken = value.oauthToken
  if (typeof value.cooldownUntil === 'number' && Number.isFinite(value.cooldownUntil)) {
    entry.cooldownUntil = value.cooldownUntil
  }
  const baseUrl = trimmedString(value.baseUrl)
  if (baseUrl) entry.baseUrl = baseUrl
  const apiMode = trimmedString(value.apiMode)
  if (apiMode) entry.apiMode = apiMode
  const region = trimmedString(value.region)
  if (region) entry.region = region
  return entry
}

export function parseSpaceProviderCredentials(value: unknown): SpaceProviderCredentials | null {
  if (!isRecord(value)) return null
  if (!Array.isArray(value.entries)) return null
  const entries: SpaceCredentialEntry[] = []
  const seen = new Set<string>()
  for (const raw of value.entries) {
    const entry = parseSpaceCredentialEntry(raw)
    if (!entry) return null
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    entries.push(entry)
  }
  const policy = trimmedString(value.policy) ?? DEFAULT_SPACE_CREDENTIAL_POLICY
  return { entries, policy }
}

/** 整份解析。任意一条 provider 段坏掉 = 整份判废(返回 null)。 */
export function parseSpaceCredentialsFile(value: unknown): SpaceCredentialsFile | null {
  if (!isRecord(value)) return null
  if (value.providers === undefined) return { providers: {} }
  if (!isRecord(value.providers)) return null
  const providers: Record<string, SpaceProviderCredentials> = {}
  for (const [providerId, raw] of Object.entries(value.providers)) {
    const id = providerId.trim()
    if (!id) return null
    const parsed = parseSpaceProviderCredentials(raw)
    if (!parsed) return null
    providers[id] = parsed
  }
  return { providers }
}

/** Empty pool metadata needs no credential migration or encryption upgrade. */
export function hasSpaceCredentialEntries(file: SpaceCredentialsFile): boolean {
  return Object.values(file.providers).some(provider => provider.entries.length > 0)
}

/** 只接受门口卡死过的 id —— id 是路径片段,非法 id 一律当 default。 */
function resolveCredentialsSpaceId(spaceId: string | undefined | null): string {
  return spaceId && isValidSpaceId(spaceId) ? spaceId : DEFAULT_SPACE_ID
}

export function spaceCredentialsFilePath(spaceId: string | undefined | null): string {
  return path.join(spaceDir(resolveCredentialsSpaceId(spaceId)), 'credentials.json')
}

/**
 * ## 落盘加密(批 B8-1)—— 清掉批 B6 勘误 1 记档的那颗雷
 *
 * B6 记档的问题是「同一个文件一半明文一半密文」,当时选了**口径一致**:整份文件
 * 都明文。B8 把口径统一到另一头 —— **整份文件都密文**,理由是这份文件的定位本来
 * 就是秘密区(批 C:整空间导出默认剔除它),而 `oauth-tokens.json` 早就加密了,
 * 让同一台机器上的两份秘密文件一份加密一份不加密才是真正说不通的那一头。
 *
 * ### 用的是同一个加密端口,没有新造
 *
 * `OnethingTokenStore` 的加密器来自 `configureAuthHost({ tokenCryptoAdapter })`
 * (Electron 宿主注入 `safeStorage`,headless 宿主不注入)。这里复用**同一个
 * adapter 实例**:装配层(`app/backend.ts` 的 `configureAppRuntimeAdapters`)
 * 把 `getAuthHostPorts().tokenCryptoAdapter` 转接进来。产品层不认识 electron,
 * 也不认识装配层,所以中间必须有这么一格 late-bound 的转接 —— 与
 * `TokenStore` 传 `cryptoAdapter: () => getAuthHostPorts().tokenCryptoAdapter?.()`
 * 是同一句话,只是这里的宿主是一组模块函数而不是一个类。
 *
 * ### 惰性升级:零迁移动作
 *
 * 盘上有三种形态,读侧全认:
 *
 * ```jsonc
 * { "providers": {…} }                                   // B3~B7 的老明文,无信封
 * { "version": 2, "encryption": "none", "providers": {…} } // 加密器缺席时的诚实明文
 * { "version": 2, "encryption": "safeStorage", "data": "<base64>" } // 密文
 * ```
 *
 * 读到老明文照样读得出;**下一次写入自动升级成密文**(写侧永远按当前能力产出,
 * 不存在"迁移脚本"这一步)。加密器不可用时**如实写 `encryption: "none"`** ——
 * 假装加密比不加密更坏:它会让人以为这份文件可以随便复制。
 */
export const SPACE_CREDENTIALS_SCHEMA_VERSION = 2

export type SpaceCredentialsEncryption = 'safeStorage' | 'none'

let credentialsCryptoProvider: (() => OnethingTokenCryptoAdapter | undefined) | undefined

/**
 * 装配层调用(`configureAppRuntimeAdapters`)。**late-bound**:每次读写都问一遍,
 * 所以宿主在模块加载之后才 wire 也来得及 —— 与 `getAuthHostPorts()` 同一条纪律。
 */
export function configureSpaceCredentialsCrypto(
  provider: (() => OnethingTokenCryptoAdapter | undefined) | undefined,
): void {
  credentialsCryptoProvider = provider
}

function activeCredentialsCrypto(): OnethingTokenCryptoAdapter | undefined {
  try {
    const adapter = credentialsCryptoProvider?.()
    return adapter?.isEncryptionAvailable() ? adapter : undefined
  } catch (err) {
    // 加密器自己炸了(safeStorage 在 app.ready 之前会抛)= 这一次没有加密能力。
    log.warn('credentials crypto adapter unavailable', undefined, err)
    return undefined
  }
}

/**
 * **这个进程写出去的会是什么形态** —— UI/日志要能如实回答,不靠猜。
 *
 * 注意它问的是**能力**不是盘上现状:`'safeStorage'` = 此刻有可用的加密器。
 * 盘上那份现在长什么样,问 `readSpaceCredentialsAtRest(spaceId)`。
 */
export function spaceCredentialsEncryptionAtRest(): SpaceCredentialsEncryption {
  return activeCredentialsCrypto() ? 'safeStorage' : 'none'
}

/** 盘上**现在**这一份是什么形态。'absent' = 没有文件 / 读不动。 */
export type SpaceCredentialsAtRest = SpaceCredentialsEncryption | 'absent'

/**
 * 盘上那份此刻的形态 —— **不解密、不判废**,只看信封。
 *
 * 两个消费者:一次性迁移的「有没有明文池要救」判据,与真机取证门的读数。
 * 无信封的老明文(B3~B7)与 `encryption:'none'` 的诚实明文归同一格 `'none'`:
 * 对「盘上躺着明文钥匙」这件事,它们是同一件事。
 */
export function readSpaceCredentialsAtRest(
  spaceId: string | undefined | null,
): SpaceCredentialsAtRest {
  const filePath = spaceCredentialsFilePath(spaceId)
  try {
    if (!fs.existsSync(filePath)) return 'absent'
    const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    if (!isRecord(raw)) return 'absent'
    return raw.encryption === 'safeStorage' ? 'safeStorage' : 'none'
  } catch (err) {
    log.warn('credentials at-rest probe failed', { filePath }, err)
    return 'absent'
  }
}

function decodeCredentialsPayload(
  raw: Record<string, unknown>,
): { providers: unknown } | null {
  const data = raw.data
  if (typeof data !== 'string' || !data) return null
  const adapter = activeCredentialsCrypto()
  if (!adapter) {
    log.warn('credentials encrypted but no crypto adapter available')
    return null
  }
  try {
    const decrypted = adapter.decryptString(Buffer.from(data, 'base64'))
    const parsed: unknown = JSON.parse(decrypted)
    return isRecord(parsed) ? { providers: parsed.providers } : null
  } catch (err) {
    log.warn('credentials decrypt failed', undefined, err)
    return null
  }
}

/**
 * 信封解析:三种盘上形态归一成 `{ providers }` 再交给既有的整份判废式解析。
 * 返回 null = 这份文件读不出来(坏文件 / 解不开),与既有口径一致 → 空池。
 */
export function parseSpaceCredentialsDocument(value: unknown): SpaceCredentialsFile | null {
  if (!isRecord(value)) return null
  if (value.encryption === 'safeStorage') {
    const payload = decodeCredentialsPayload(value)
    return payload ? parseSpaceCredentialsFile(payload) : null
  }
  // 无信封的老明文,以及 `encryption: 'none'` 的诚实明文,走同一条路。
  return parseSpaceCredentialsFile(value)
}

/** 按此刻的加密能力产出盘上形态。**写侧永远是当前形态** —— 这就是惰性升级。 */
export function serializeSpaceCredentialsDocument(
  file: SpaceCredentialsFile,
): Record<string, unknown> {
  const adapter = activeCredentialsCrypto()
  if (!adapter) {
    return {
      version: SPACE_CREDENTIALS_SCHEMA_VERSION,
      encryption: 'none' satisfies SpaceCredentialsEncryption,
      providers: file.providers,
    }
  }
  const encrypted = adapter.encryptString(JSON.stringify({ providers: file.providers }))
  return {
    version: SPACE_CREDENTIALS_SCHEMA_VERSION,
    encryption: 'safeStorage' satisfies SpaceCredentialsEncryption,
    data: typeof encrypted === 'string' ? encrypted : Buffer.from(encrypted).toString('base64'),
  }
}

/**
 * 读缓存。key 是**绝对文件路径**(与 overlay 同一条理由:换 store 根天然换 key)。
 * 这条读路径挂在每次起流的 provider 解析上,同步读盘虽小也没必要每次都做。
 */
const credentialsCache = new Map<string, SpaceCredentialsFile>()

export function resetSpaceCredentialsCacheForTests(): void {
  credentialsCache.clear()
}

/** 缺文件 / 坏文件 / 读不动 = 空池。空池 = 这个空间什么都没配(严格隔离下即「未配置」)。 */
export function readSpaceCredentials(spaceId: string | undefined | null): SpaceCredentialsFile {
  const filePath = spaceCredentialsFilePath(spaceId)
  const cached = credentialsCache.get(filePath)
  if (cached) return cached
  let file: SpaceCredentialsFile = { providers: {} }
  try {
    if (fs.existsSync(filePath)) {
      const parsed = parseSpaceCredentialsDocument(JSON.parse(fs.readFileSync(filePath, 'utf-8')))
      if (parsed) file = parsed
      else log.warn('credentials schema validation failed, treating as empty', { filePath })
    }
  } catch (err) {
    log.warn('credentials read failed', { filePath }, err)
  }
  credentialsCache.set(filePath, file)
  return file
}

/** 整份写入(与 overlay 同一条纪律:入口就定成整写,由调用方显式先读后并)。 */
export function writeSpaceCredentials(
  spaceId: string | undefined | null,
  file: SpaceCredentialsFile,
): SpaceCredentialsFile {
  const id = resolveCredentialsSpaceId(spaceId)
  const normalized = parseSpaceCredentialsFile(file) ?? { providers: {} }
  ensureSpaceDir(id)
  const filePath = spaceCredentialsFilePath(id)
  fs.writeFileSync(
    filePath,
    JSON.stringify(serializeSpaceCredentialsDocument(normalized), null, 2),
    'utf-8',
  )
  credentialsCache.set(filePath, normalized)
  // 跨窗口缓存过期(批 B9-0):这是凭证池的唯一落盘入口(OAuth 登录写 token 也
  // 经 `upsertSpaceProviderOAuthToken` 走到这里),所以通知挂这一处就够。
  notifySpaceDataChanged({ spaceId: id, kind: 'credentials' })
  return normalized
}

export function getSpaceProviderCredentials(
  spaceId: string | undefined | null,
  providerId: string,
): SpaceProviderCredentials | undefined {
  return readSpaceCredentials(spaceId).providers[providerId]
}

/** entry 还在冷却里就不该被选中(批 D 的轮换会写这个字段;本切片只读)。 */
export function isSpaceCredentialEntryCooling(
  entry: SpaceCredentialEntry,
  now = Date.now(),
): boolean {
  return typeof entry.cooldownUntil === 'number' && entry.cooldownUntil > now
}

/**
 * 这条 entry 现在能不能真的拿去发请求(冷却与否另算)。
 *
 * **批 B6 起 OAuth 型也算数**:批 D 时非 default 空间还不能登录,一条 oauth entry
 * 必然是空壳,所以那时「usable」= 有 apiKey。现在它可以真的装着一个 token ——
 * 继续把它当不可用,等于让轮换策略永远跳过用户刚登录的那个账号。
 * 判据仍然是「有没有凭证材料」这一句,只是材料多了一种。
 */
export function isSpaceCredentialEntryUsable(entry: SpaceCredentialEntry): boolean {
  return entry.authType === 'oauth'
    ? Boolean(entry.oauthToken)
    : Boolean(entry.apiKey?.trim())
}

/**
 * round-robin 的轮转游标 —— **进程内存,不持久化**。
 *
 * 落盘会把一个纯调度细节变成需要迁移、需要并发保护的状态;重启后从头轮一遍
 * 顶多让第一条 key 多担一次请求,代价小到不值得为它开一个文件字段。
 */
const roundRobinCursors = new Map<string, number>()

export function resetSpaceCredentialRotationForTests(): void {
  roundRobinCursors.clear()
}

/** 轮转游标键:一个空间的一个 provider 一条游标。 */
export function spaceCredentialCursorKey(
  spaceId: string | undefined | null,
  providerId: string,
): string {
  return `${resolveCredentialsSpaceId(spaceId)}:${providerId}`
}

/* ── 插件策略的宿主端口(批 E)────────────────────────────────────────────── */

/**
 * 插件凭证策略的**裁决口**。产品层不认识插件,装配层把这个端口装上。
 *
 * 为什么是**同步**的:分叉点(`selectSpaceCredentialEntryDetailed`)整条上游链
 * ——`resolveSpaceProviderCredential` → `applySessionSpaceCredentials` →
 * `getEffectiveOnethingProviderConfig` → core 的 `StreamEngineProviderAdapter
 * .getEffectiveConfig` —— 全是同步的。把它改成异步等于改 core 引擎的适配器
 * 契约,而「接线点唯一」这条纪律说的正是不许这么干。所以异步的那一半
 * (真正 await 插件 handler、超时、熔断、用量聚合)全部住在装配层:那边在
 * **请求/重试边界**上异步算好一条裁决,这里同步取用。详见
 * `app/providers/credential-strategy.ts` 的顶注与设计文档批 E 勘误 1。
 *
 * 返回 undefined = 回落内置 `priority-failover`(不是错误,是默认答案)。
 */
export interface SpaceCredentialPluginStrategyHost {
  decide(input: {
    /** `plugin:<id>:<name>`,已确认形状合法。 */
    policy: string
    spaceId: string
    providerId: string
    /** 已剔除冷却中/不可用/鉴权形态对不上的候选集,顺序 = 用户排的优先级。 */
    candidates: readonly SpaceCredentialEntry[]
    now: number
  }): string | undefined
}

let pluginStrategyHost: SpaceCredentialPluginStrategyHost | null = null

/** 装配层注入(late-bound,幂等)。传 null 卸下 —— 测试与 headless 宿主用得上。 */
export function configureSpaceCredentialPluginStrategyHost(
  host: SpaceCredentialPluginStrategyHost | null,
): void {
  pluginStrategyHost = host
}

export function getSpaceCredentialPluginStrategyHost(): SpaceCredentialPluginStrategyHost | null {
  return pluginStrategyHost
}

/**
 * 选择结果。**「全池耗尽」必须与「没配」分开** —— 前者是「配了但都在冷却」
 * (等一会儿就好),后者是「这个空间根本没这把钥匙」(要去设置页配)。
 * 两者给用户的出路完全不同,压成同一个 `undefined` 就说不清了。
 */
export interface SpaceCredentialSelection {
  entry?: SpaceCredentialEntry
  /** 候选非空但全在冷却里。`earliestRecoveryAt` = 最早的那条恢复时间戳(ms)。 */
  exhausted?: { earliestRecoveryAt: number }
  /**
   * 这次选择走了插件策略(批 E)时的记录。`applied:false` = 策略缺席/超时/
   * 返回非法 id,本次已回落内置 failover —— 面板据同一判据画灰态。
   */
  pluginPolicy?: { policy: string; applied: boolean }
}

export interface SelectSpaceCredentialEntryOptions {
  now?: number
  /**
   * round-robin 的游标键(`spaceCredentialCursorKey`)。缺省 = 无处记游标,
   * round-robin 退化成 priority-failover —— 编一个全局共享的游标只会让两个
   * provider 互相拨对方的表。
   */
  cursorKey?: string
  /**
   * 只在这一类凭证里挑(批 B6)。**给的是 provider 的鉴权形态,不是偏好** ——
   * OAuth 型 provider 的池里只有 oauth entry 有意义,拿一条 apiKey entry 去登录
   * 授权型端点必然 401。缺省 = 不过滤(= 批 D 的行为,一字未改)。
   */
  authType?: SpaceCredentialAuthType
  /**
   * 插件策略(批 E)的上下文两格。缺省 = 空串 —— 插件策略拿不到空间/provider
   * 也就无从决策,但它**不会**让选择失败(裁决口返回 undefined = 回落)。
   * 内置三策略一个字都不看这两格,所以批 D 之前的调用点行为一字未改。
   */
  spaceId?: string
  providerId?: string
}

/**
 * 按策略挑一条 entry —— **轮换的唯一分叉点**(设计文档批 B3 结尾钉的那句)。
 * 上游(`resolveSpaceProviderCredential`)一行都不必认识 policy。
 */
export function selectSpaceCredentialEntryDetailed(
  credentials: SpaceProviderCredentials | undefined,
  options: SelectSpaceCredentialEntryOptions = {},
): SpaceCredentialSelection {
  if (!credentials || credentials.entries.length === 0) return {}
  const now = options.now ?? Date.now()
  const policy = normalizeSpaceCredentialPolicy(credentials.policy)

  // 鉴权形态过滤先做(批 B6):它不是策略,是「这个 provider 只认这种凭证」。
  // 缺省不过滤 —— 批 D 之前的调用点行为一字未改。
  const typed = options.authType
    ? credentials.entries.filter(entry => entry.authType === options.authType)
    : credentials.entries
  if (typed.length === 0) return {}

  // `single` 的候选集是**全部 entry**(B3 原语义:头一条不在冷却里的);轮换策略
  // 的候选集额外剔掉用不了的 —— 跳过一条没填密钥的 entry 去用后面那把真 key,
  // 正是「failover」这个词的意思。
  const candidates = policy === 'single'
    ? typed
    : typed.filter(isSpaceCredentialEntryUsable)
  if (candidates.length === 0) return {}

  const available = candidates.filter(entry => !isSpaceCredentialEntryCooling(entry, now))
  if (available.length === 0) {
    const earliestRecoveryAt = Math.min(
      ...candidates.map(entry => entry.cooldownUntil ?? Number.POSITIVE_INFINITY),
    )
    return { exhausted: { earliestRecoveryAt } }
  }

  // 插件策略(批 E)。**排在 round-robin 之前**:它是一个独立的分支,不是
  // round-robin 的变体。裁决口同步取用装配层在请求/重试边界上算好的那一条;
  // 拿不到(策略没注册 / 已降级 / 上一次超时)就落到下面的 `available[0]`,
  // 也就是 priority-failover —— 红线 2「失效绝不阻塞起流」的落点就是这一行。
  if (isPluginSpaceCredentialPolicy(policy)) {
    const chosenId = pluginStrategyHost?.decide({
      policy,
      spaceId: options.spaceId ?? '',
      providerId: options.providerId ?? '',
      candidates: available,
      now,
    })
    // 只在**可用集**里认 id:一条正在冷却的 entry 压根不在 available 里,
    // 所以「策略返回冷却中的 id」与「返回一个不存在的 id」在这里自动同归一路。
    const chosen = chosenId ? available.find(entry => entry.id === chosenId) : undefined
    return chosen
      ? { entry: chosen, pluginPolicy: { policy, applied: true } }
      : { entry: available[0], pluginPolicy: { policy, applied: false } }
  }

  if (policy === 'round-robin' && options.cursorKey) {
    const cursor = roundRobinCursors.get(options.cursorKey) ?? 0
    // 游标走在**可用集**上而不是全集:冷却掉的 entry 不该占着一个轮次让整池空转。
    const entry = available[cursor % available.length]
    roundRobinCursors.set(options.cursorKey, (cursor + 1) % available.length)
    return { entry }
  }

  return { entry: available[0] }
}

/**
 * 薄封装:只要那条 entry。B3 起的调用点与测试都用这个签名,批 D 未改它 ——
 * 「全池耗尽」要区分开的调用点改用 `selectSpaceCredentialEntryDetailed`。
 */
export function selectSpaceCredentialEntry(
  credentials: SpaceProviderCredentials | undefined,
  now = Date.now(),
  cursorKey?: string,
): SpaceCredentialEntry | undefined {
  return selectSpaceCredentialEntryDetailed(credentials, { now, cursorKey }).entry
}

/**
 * 一条 apiKey entry 的写入载荷。
 *
 * **字段级 patch 语义(批 B10)**:`undefined` = 这次不表达 → 沿用原条目那一格;
 * 空串 = 明确清空。理由是 UI 上「换密钥」与「改档位」是两个独立动作 ——
 * 换密钥的表单里没有 baseUrl/档位这两格,旧写法(缺席即清空)会让换一次 key
 * 顺手把端点和地区抹掉,而用户在界面上看不出发生了什么。
 *
 * `apiKey` 同理成了可选:带 `entryId` 而不带 key = **只改非密钥字段**
 * (档位/地区/名称/端点)。密钥原文渲染层根本没有,不给它这条路就等于
 * 「改一次地区要重新粘一次 key」。
 */
export interface UpsertSpaceCredentialInput {
  apiKey?: string
  baseUrl?: string
  apiMode?: string
  region?: string
  label?: string
  entryId?: string
}

/**
 * 三个非密钥字段的 patch 合并。**只此一处**,`upsert` 与 `add` 共用 ——
 * 两边各写一遍 `input.x?.trim() ? {...} : {}` 是这三格上一次走散的原因。
 *
 * 语义逐格相同:`undefined` = 沿用旧值;空串 = 清空;有值 = 写它。
 */
function patchedEntryDials(
  input: Pick<UpsertSpaceCredentialInput, 'baseUrl' | 'apiMode' | 'region'>,
  previous: SpaceCredentialEntry | undefined,
): Pick<SpaceCredentialEntry, 'baseUrl' | 'apiMode' | 'region'> {
  const merge = (next: string | undefined, old: string | undefined): string | undefined => {
    if (next === undefined) return old
    const trimmed = next.trim()
    return trimmed || undefined
  }
  const baseUrl = merge(input.baseUrl, previous?.baseUrl)
  const apiMode = merge(input.apiMode, previous?.apiMode)
  const region = merge(input.region, previous?.region)
  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiMode ? { apiMode } : {}),
    ...(region ? { region } : {}),
  }
}

/** entry id 生成:与内容无关的随机 id(换 key 不换 id)。 */
export function createSpaceCredentialEntryId(now = Date.now()): string {
  return `cred-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 单条 apiKey 凭证的 upsert(本切片 UI 的唯一写法)。
 *
 * 「单条」是 **UI 的限制,不是存储的限制**:这里替换的是 `entries[0]`,其余 entry
 * 原样保留 —— 批 D 的多条目 UI 接手时不必迁移任何东西。
 */
export function upsertSpaceProviderApiKey(
  spaceId: string | undefined | null,
  providerId: string,
  input: UpsertSpaceCredentialInput,
  now = Date.now(),
): SpaceCredentialsFile {
  const current = readSpaceCredentials(spaceId)
  const existing = current.providers[providerId]
  const entries = [...(existing?.entries ?? [])]
  const targetIndex = input.entryId
    ? entries.findIndex(entry => entry.id === input.entryId)
    : entries.findIndex(entry => entry.authType === 'apiKey')
  const previous = targetIndex >= 0 ? entries[targetIndex] : undefined
  const apiKey = input.apiKey?.trim() || previous?.apiKey
  const entry: SpaceCredentialEntry = {
    id: previous?.id ?? createSpaceCredentialEntryId(now),
    label: input.label?.trim() || previous?.label || providerId,
    authType: 'apiKey',
    ...(apiKey ? { apiKey } : {}),
    source: previous?.source ?? SPACE_CREDENTIAL_SOURCE_USER,
    ...patchedEntryDials(input, previous),
  }
  if (targetIndex >= 0) entries[targetIndex] = entry
  else entries.unshift(entry)
  return writeSpaceCredentials(spaceId, {
    providers: {
      ...current.providers,
      [providerId]: { entries, policy: existing?.policy ?? DEFAULT_SPACE_CREDENTIAL_POLICY },
    },
  })
}

/* ── 多条目管理(批 D)──────────────────────────────────────────────────────── */

/**
 * 整段替换的私有底座。**读—改—写整份**,与 overlay 同一条纪律。
 * `mutate` 返回 `null` = 什么都不做(调用点自己判「没这条」)。
 */
function updateProviderSection(
  spaceId: string | undefined | null,
  providerId: string,
  mutate: (
    current: SpaceProviderCredentials,
  ) => SpaceProviderCredentials | null,
): SpaceCredentialsFile {
  const file = readSpaceCredentials(spaceId)
  const current = file.providers[providerId]
    ?? { entries: [], policy: DEFAULT_SPACE_CREDENTIAL_POLICY }
  const next = mutate(current)
  if (!next) return file
  const providers = { ...file.providers }
  // 最后一条被删掉 = 该 provider 在本空间未配置。留一个 `entries: []` 的空壳
  // 只会让「配过但清空了」和「没配过」在读侧长得一样却各占一行。
  if (next.entries.length === 0) delete providers[providerId]
  else providers[providerId] = next
  return writeSpaceCredentials(spaceId, { providers })
}

/** 追加一条 apiKey entry(顺序即 failover 优先级,新条目排在最后)。 */
export function addSpaceProviderCredentialEntry(
  spaceId: string | undefined | null,
  providerId: string,
  input: UpsertSpaceCredentialInput,
  now = Date.now(),
): SpaceCredentialsFile {
  return updateProviderSection(spaceId, providerId, current => ({
    ...current,
    entries: [...current.entries, {
      id: createSpaceCredentialEntryId(now),
      label: input.label?.trim() || `${providerId} #${current.entries.length + 1}`,
      authType: 'apiKey',
      apiKey: input.apiKey?.trim() ?? '',
      source: SPACE_CREDENTIAL_SOURCE_USER,
      ...patchedEntryDials(input, undefined),
    }],
  }))
}

/**
 * 整池写:**排序 + 删除 + 策略,一次落盘**。
 *
 * 为什么参数是 `entryIds` 而不是整份 entries:渲染层拿不到密钥原文(B3 决策 8),
 * 它能诚实回传的只有「这些 id、按这个顺序」。删除 = 不在列表里;排序 = 列表顺序
 * (顺序即 failover 优先级);策略同一次写。密钥本身永远走 upsert/add 那条路。
 *
 * 列表里认不出的 id 直接忽略 —— 渲染层的视图可能比磁盘旧一拍,让一个陈旧的 id
 * 把整次写盘打回去,只会让用户对着一个不动的面板重复点。
 */
export function setSpaceProviderCredentialPool(
  spaceId: string | undefined | null,
  providerId: string,
  input: { entryIds: readonly string[]; policy?: SpaceCredentialPolicy },
): SpaceCredentialsFile {
  return updateProviderSection(spaceId, providerId, current => {
    const byId = new Map(current.entries.map(entry => [entry.id, entry]))
    const entries: SpaceCredentialEntry[] = []
    for (const id of input.entryIds) {
      const entry = byId.get(id)
      if (entry && !entries.includes(entry)) entries.push(entry)
    }
    return {
      entries,
      policy: normalizeSpaceCredentialPolicy(input.policy ?? current.policy),
    }
  })
}

/**
 * 写冷却 —— 批 B3 留下的那个「只差写它的人」(盲点 6)。
 *
 * **只延长,不缩短**:两条并发请求可能带回长短不一的两个恢复时间,取长的那个是
 * 唯一不会把一把已知耗尽的 key 提前放回池子的选择。
 *
 * 写盘 = 重启不忘。配额窗口按小时/天算,进程内存记它等于每次重启都重新烧一遍池。
 */
export function markSpaceCredentialCooldown(
  spaceId: string | undefined | null,
  providerId: string,
  entryId: string,
  cooldownUntil: number,
): SpaceCredentialsFile {
  if (!Number.isFinite(cooldownUntil)) return readSpaceCredentials(spaceId)
  return updateProviderSection(spaceId, providerId, current => {
    const index = current.entries.findIndex(entry => entry.id === entryId)
    if (index < 0) return null
    const previous = current.entries[index]
    const until = Math.max(cooldownUntil, previous.cooldownUntil ?? 0)
    if (until === previous.cooldownUntil) return null
    const entries = [...current.entries]
    entries[index] = { ...previous, cooldownUntil: until }
    return { ...current, entries }
  })
}

/* ── OAuth entry(批 B6)────────────────────────────────────────────────────── */

export function getSpaceCredentialEntry(
  spaceId: string | undefined | null,
  providerId: string,
  entryId: string | undefined,
): SpaceCredentialEntry | undefined {
  if (!entryId) return undefined
  return getSpaceProviderCredentials(spaceId, providerId)
    ?.entries.find(entry => entry.id === entryId)
}

export interface UpsertSpaceOAuthTokenInput {
  /** 在就是改那一条,不在就是**追加一条**(登录一个新账号)。 */
  entryId?: string
  label?: string
  /** 不透明的 token 原文。这一层不解释它 —— 解释权在 auth 层。 */
  token: unknown
}

export interface UpsertSpaceOAuthTokenResult {
  entryId: string
  file: SpaceCredentialsFile
}

/**
 * 把一个 OAuth token 落进本空间的池(批 B6)。
 *
 * 两条口径:
 *  - **`entryId` 缺席 = 追加**,不是「盖掉第一条 oauth entry」。同一个 provider
 *    允许多个账号是这一刀的原始需求;缺省语义定成覆盖,多账号就永远登不进第二个。
 *  - **写 token 顺手抹掉 `cooldownUntil`**。刚登录/刚刷新成功的凭证还坐在冷板凳上
 *    是说不通的;这与「换 key 会抹掉冷却」(批 D 勘误 6)是同一句话。
 */
export function upsertSpaceProviderOAuthToken(
  spaceId: string | undefined | null,
  providerId: string,
  input: UpsertSpaceOAuthTokenInput,
  now = Date.now(),
): UpsertSpaceOAuthTokenResult {
  let resolvedId = input.entryId ?? ''
  const file = updateProviderSection(spaceId, providerId, current => {
    const entries = [...current.entries]
    const index = input.entryId
      ? entries.findIndex(entry => entry.id === input.entryId)
      : -1
    const previous = index >= 0 ? entries[index] : undefined
    resolvedId = previous?.id ?? createSpaceCredentialEntryId(now)
    const entry: SpaceCredentialEntry = {
      id: resolvedId,
      label: input.label?.trim() || previous?.label || `${providerId} #${entries.length + 1}`,
      authType: 'oauth',
      oauthToken: input.token,
      source: previous?.source ?? SPACE_CREDENTIAL_SOURCE_USER,
      ...(previous?.baseUrl ? { baseUrl: previous.baseUrl } : {}),
      ...(previous?.apiMode ? { apiMode: previous.apiMode } : {}),
      ...(previous?.region ? { region: previous.region } : {}),
    }
    if (index >= 0) entries[index] = entry
    else entries.push(entry)
    return { ...current, entries }
  })
  return { entryId: resolvedId, file }
}

/**
 * 删掉一条 entry(OAuth 的「退出登录」就是这个)。
 *
 * 与 `clearSpaceProviderCredentials` 的区别:那个清整段,这个只拿掉一条。
 * 删到一条不剩时整段消失(`updateProviderSection` 的既有语义)—— 「登出最后一个
 * 账号」与「这个 provider 在本空间未配置」本来就该是同一个状态。
 */
export function removeSpaceProviderCredentialEntry(
  spaceId: string | undefined | null,
  providerId: string,
  entryId: string,
): SpaceCredentialsFile {
  return updateProviderSection(spaceId, providerId, current => {
    if (!current.entries.some(entry => entry.id === entryId)) return null
    return { ...current, entries: current.entries.filter(entry => entry.id !== entryId) }
  })
}

/** 清空某 provider 在本空间的整段凭证(严格隔离下 = 该 provider 在本空间未配置)。 */
export function clearSpaceProviderCredentials(
  spaceId: string | undefined | null,
  providerId: string,
): SpaceCredentialsFile {
  const current = readSpaceCredentials(spaceId)
  if (!current.providers[providerId]) return current
  const providers = { ...current.providers }
  delete providers[providerId]
  return writeSpaceCredentials(spaceId, { providers })
}

/* ── 导入快照(新建向导的「从默认空间导入凭证」)──────────────────────────── */

export interface ImportableProviderCredential {
  providerId: string
  /** 已解析出的 apiKey(空 = 没配)。调用方负责决定要不要把 env 兜底算进来。 */
  apiKey?: string
  baseUrl?: string
  apiMode?: string
  region?: string
  /** provider 本身是不是 OAuth/订阅型。是就跳过 —— 本切片非 default 空间不支持 OAuth。 */
  oauth?: boolean
  label?: string
}

export type SpaceCredentialImportSkipReason = 'oauth' | 'no-api-key'

export interface SpaceCredentialImportResult {
  file: SpaceCredentialsFile
  imported: string[]
  skipped: Array<{ providerId: string; reason: SpaceCredentialImportSkipReason }>
}

/**
 * 从一批「可导入凭证」构建整份 credentials.json。**copy 不引用** —— 导入之后
 * 改全局的 key 不会影响这个空间(设计决策表:「导入(复制快照)或空白开始」)。
 *
 * OAuth 型一律跳过并如实报出来:非 default 空间本切片不支持 OAuth 登录,
 * 悄悄导入一个用不了的 token 比直说「跳过了」更糟。
 */
export function buildImportedSpaceCredentials(
  candidates: readonly ImportableProviderCredential[],
  options: { now?: number; makeEntryId?: (index: number) => string } = {},
): SpaceCredentialImportResult {
  const now = options.now ?? Date.now()
  const providers: Record<string, SpaceProviderCredentials> = {}
  const imported: string[] = []
  const skipped: SpaceCredentialImportResult['skipped'] = []

  candidates.forEach((candidate, index) => {
    const providerId = candidate.providerId.trim()
    if (!providerId) return
    if (candidate.oauth) {
      skipped.push({ providerId, reason: 'oauth' })
      return
    }
    const apiKey = candidate.apiKey?.trim()
    if (!apiKey) {
      skipped.push({ providerId, reason: 'no-api-key' })
      return
    }
    // 同一个 provider 可以来好几条(源空间的池里本来就是多条)。**追加**而不是
    // 覆盖 —— 覆盖会让「三把轮换的 key」在新空间悄悄变成一把,而症状要到某天
    // 配额耗尽才显形。
    const section = providers[providerId] ?? {
      entries: [],
      policy: DEFAULT_SPACE_CREDENTIAL_POLICY,
    }
    section.entries.push({
      id: options.makeEntryId?.(index) ?? createSpaceCredentialEntryId(now + index),
      label: candidate.label?.trim() || providerId,
      authType: 'apiKey',
      apiKey,
      source: SPACE_CREDENTIAL_SOURCE_USER,
      ...(candidate.baseUrl?.trim() ? { baseUrl: candidate.baseUrl.trim() } : {}),
      ...(candidate.apiMode?.trim() ? { apiMode: candidate.apiMode.trim() } : {}),
      ...(candidate.region?.trim() ? { region: candidate.region.trim() } : {}),
    })
    providers[providerId] = section
    if (!imported.includes(providerId)) imported.push(providerId)
  })

  return { file: { providers }, imported, skipped }
}

/** 密钥预览 —— 渲染层永远只拿得到这个,拿不到原文。 */
export function previewSpaceCredentialApiKey(apiKey: string | undefined): string | undefined {
  const key = apiKey?.trim()
  if (!key) return undefined
  const head = key.slice(0, Math.min(6, key.length))
  const tail = key.length > 10 ? key.slice(-4) : ''
  return tail ? `${head}••••${tail}` : `${head}••••`
}
