/**
 * 一次性迁移:`settings.ai` 的 provider 凭证与偏好 → **default 空间**的
 * `credentials.json` + `space.json`(C1)。
 *
 * ## 为什么要有这一步
 *
 * 批 B3 定的是「default 空间 = settings.ai 原地不动,非 default = 另立文件」。
 * 零迁移换来的是**两套数据形状**:每个消费者都得写一次 `isDefaultSpace ? A : B`,
 * 而每一片都会漏掉一个消费者(开关不独立 → 默认模型不独立 → 旋钮设不了 →
 * 切空间外观变,全是同一个决定的显形)。C1 把 default 也变成普通空间,于是
 * 「两套形状」这个病根消失,而代价就是这一个函数。
 *
 * ## 三条纪律
 *
 * 1. **幂等**:`settings.storage.providerConfigMigratedAt` 在就直接返回。
 * 2. **失败不留半场**:任何一步抛错都**不写标记、不清旧字段** —— 下次启动重跑。
 *    先搬(可重复的写),最后才清(不可逆的写),顺序不能倒。
 * 3. **先备份**:`<store>/backups/settings-pre-space-migration-<ISO>.json`
 *    与 `oauth-tokens-pre-space-migration-<ISO>.json`。回滚步骤见
 *    `docs/design/workspace-provider-config-review-2026-08-18.md`。
 *
 * 三宿主(Electron / server / CLI daemon)跑的是同一份代码 —— 它挂在
 * `createOnethingBackend` 的装配序列上,谁都绕不过去。server 没有空间概念,
 * 它读写的就是 default 空间那份文件。多租户树 `owners/<uid>/<wid>` 不在此列
 * (那一套 settings 走 by-owner map,本片不迁)。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { AppSettings, OAuthToken, ProviderConfig } from '@shared/ipc.js'
import {
  OnethingTokenStore,
  type OnethingOAuthToken,
} from '@onething/backend/auth'
import { oauthTokenIdentity, parseSpaceOAuthToken } from './credentials-token-store.js'
import {
  readSpaceCredentials,
  readSpaceCredentialsAtRest,
  spaceCredentialsFilePath,
  hasSpaceCredentialEntries,
  spaceCredentialsEncryptionAtRest,
  writeSpaceCredentials,
  createSpaceCredentialEntryId,
  DEFAULT_SPACE_CREDENTIAL_POLICY,
  SPACE_CREDENTIAL_SOURCE_USER,
  type SpaceCredentialEntry,
  type SpaceCredentialsFile,
} from './credentials-pool.js'
import {
  readSpaceOverlay,
  writeSpaceOverlay,
  type SpaceOverlay,
} from '@onething/backend/space/overlay'
import {
  createEmptySpaceProviderSettings,
  hasSpaceProviderSettings,
  writeSpaceProviderSettings,
  type SpaceProviderSettings,
} from '@onething/backend/space/provider-settings'
import { getSpacesStore } from '@onething/backend/space/store'
import { DEFAULT_SPACE_ID } from '@onething/backend/space/types'
import { getAuthHostPorts } from '@onething/backend/auth/host-ports'
import {
  getOnethingSettingsPath,
  getOnethingStorePath,
} from '@onething/backend/storage'
import { getPersistedSettings, savePersistedSettings } from '@onething/backend/settings'
import { getProviderInfo } from '@onething/backend/provider'
import { providerDialFieldsOf } from './credentials-provider-rules.js'
import { getLogger } from '@onething/backend/logging/configure-logging'

const log = getLogger('providers')


/**
 * settings 里那三家的档位字段 → entry 的 `{apiMode, region}`(批 B10)。
 *
 * 字段名读 `credentials/credentials-provider-rules.ts` 的那一张表(`providerDialFieldsOf`,
 * entry → config 方向用的同一张);这里只管「从 settings 记录里读出来」。
 */
export function pickProviderDials(
  providerId: string,
  record: Record<string, unknown>,
): { apiMode?: string; region?: string } {
  const read = (key: string): string | undefined => {
    const value = record[key]
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }
  // 格名只此一份:`credentials/credentials-provider-rules.ts` 的档位字段表(反方向用的同一张,批 M)。
  const fields = providerDialFieldsOf(providerId)
  const apiMode = fields.apiMode ? read(fields.apiMode) : undefined
  const region = fields.region ? read(fields.region) : undefined
  return { ...(apiMode ? { apiMode } : {}), ...(region ? { region } : {}) }
}

/**
 * 迁移会从 `settings.ai.providers[*]` 拿走的**凭证**格(C1)。
 *
 * C2 之后这张表只用来判「哪些格是钥匙」—— 剩下的整份 provider 配置一律搬去
 * `providers.json`,`settings.ai` 的 `providers` / `provider` / `customProviders`
 * 三个键整体删掉,不再逐格清理。
 */
export const MIGRATED_CREDENTIAL_FIELDS = ['apiKey', 'oauthToken', 'authType'] as const

/** models.dev 目录缓存那两格 —— 它们留全局,但要从 provider 配置里抬出来。 */
export const MODEL_CATALOG_FIELDS = ['models', 'modelsLastFetched'] as const

export interface ProviderConfigMigrationReport {
  /** 这次真的迁了没有。`false` = 标记已在(幂等跳过)。 */
  migrated: boolean
  migratedAt?: number
  /** 备份文件绝对路径(settings / oauth-tokens),没有备份的那一份缺席。 */
  backups: { settings?: string; oauthTokens?: string }
  /** 迁进 default 池的 apiKey entry 的 provider 列表。 */
  credentials: string[]
  /** 迁进 default 池的 oauth entry 的 provider 列表。 */
  oauthTokens: string[]
  /** 写出了 `providers.json` 的空间 id(C2 的整体搬)。 */
  providerSettings: string[]
  /** 从 provider 配置里抬进全局 `ai.modelCatalog` 的 provider 数。 */
  modelCatalog: number
  /** 这次跑的是不是**只有**第二段(C1 版本已经迁过的机器)。 */
  secondStageOnly: boolean
  /**
   * 这次**故意没迁**的理由(2026-08-31)。`'no-credential-encryption'` = 本进程
   * 没有加密能力,迁了就是把钥匙明文写上盘 —— 留在未迁移态等有能力的宿主。
   */
  deferredReason?: 'no-credential-encryption'
}

function backupsDir(): string {
  return path.join(getOnethingStorePath(), 'backups')
}

/** ISO 时间戳做文件名:冒号在 Windows 上不能进路径,换成 `-`。 */
function backupStamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-')
}

function copyFileToBackup(
  sourcePath: string,
  name: string,
  now: number,
  tag = 'pre-space-migration',
): string | undefined {
  if (!fs.existsSync(sourcePath)) return undefined
  const dir = backupsDir()
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, `${name}-${tag}-${backupStamp(now)}.json`)
  fs.copyFileSync(sourcePath, target)
  return target
}

function providerLabel(providerId: string): string {
  try {
    return getProviderInfo(providerId)?.name || providerId
  } catch {
    return providerId
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * `settings.ai.providers` → default 池的 apiKey entries。
 *
 * **空 key 且无 baseUrl 的不建 entry** —— 出厂 provider 种子表(各家 manifest 的 `seed`)给每个内置
 * provider 都发了一格 `apiKey: ''`,照单全收会在池里堆出十几条空壳,然后
 * 「配没配好」的判据只能靠数 entry 的内容而不是数 entry —— 那正是要拆掉的东西。
 *
 * 已经有 entry 的 provider **不动**:迁移只补,不覆盖(重跑安全)。
 */
export function buildMigratedCredentialEntries(
  providers: Record<string, ProviderConfig | undefined>,
  existing: SpaceCredentialsFile,
  options: { now?: number; makeEntryId?: (index: number) => string } = {},
): { file: SpaceCredentialsFile; migrated: string[] } {
  const now = options.now ?? Date.now()
  const nextProviders = { ...existing.providers }
  const migrated: string[] = []
  let index = 0
  for (const [providerId, config] of Object.entries(providers)) {
    if (!config) continue
    if (nextProviders[providerId]?.entries.length) continue
    const record = config as unknown as Record<string, unknown>
    const apiKey = isNonEmptyString(record.apiKey) ? record.apiKey.trim() : undefined
    const baseUrl = isNonEmptyString(record.baseUrl) ? record.baseUrl.trim() : undefined
    if (!apiKey && !baseUrl) continue
    const dials = pickProviderDials(providerId, record)
    const entry: SpaceCredentialEntry = {
      id: options.makeEntryId?.(index) ?? createSpaceCredentialEntryId(now + index),
      label: providerLabel(providerId),
      authType: 'apiKey',
      ...(apiKey ? { apiKey } : {}),
      source: SPACE_CREDENTIAL_SOURCE_USER,
      ...(baseUrl ? { baseUrl } : {}),
      ...dials,
    }
    nextProviders[providerId] = { entries: [entry], policy: DEFAULT_SPACE_CREDENTIAL_POLICY }
    migrated.push(providerId)
    index += 1
  }
  return { file: { providers: nextProviders }, migrated }
}

/**
 * `settings.ai` + 该空间的 overlay 三格 → 这个空间的 `providers.json`(C2)。
 *
 * **整体搬**,不是挑几格:用户 08-18 的原话是「provider 设置应该是完整的、
 * 独立的两套」。所以每个 provider 的 model / enabled / selectedModels / 端点 /
 * 档位 / 逐模型覆盖 / 思考档位,以及默认 provider 与自定义 provider 定义,全部
 * 落进这一份文件。剥掉的只有钥匙(进凭证池)与目录缓存(留全局)。
 *
 * overlay 那三格(B7/B9 的 `providerEnabled` / `selectedModels` /
 * `defaultSelection`)**盖在** settings 之上 —— 它们是这个空间自己表达过的,
 * 比全局那份更具体。C1 版本已经跑过一次的机器,default 空间的偏好就存在那里。
 *
 * 非 default 空间也走同一条:C2 之前它们**除了这三格以外全部回落全局**,所以
 * 用 `settings.ai` 作底、overlay 作盖,搬完之后用户在每个空间看见的东西和搬之前
 * 一模一样。这是本次迁移唯一一次「跨空间取值」,之后再不回落。
 */
export function buildSpaceProviderSettings(
  ai: AppSettings['ai'] | undefined,
  overlay: SpaceOverlay,
): SpaceProviderSettings {
  const out = createEmptySpaceProviderSettings()
  const legacy = ai as unknown as {
    provider?: unknown
    temperature?: unknown
    providers?: Record<string, Record<string, unknown> | undefined>
    customProviders?: Array<Record<string, unknown>>
  } | undefined

  if (typeof legacy?.temperature === 'number') out.temperature = legacy.temperature

  const providers = legacy?.providers ?? {}
  for (const [providerId, config] of Object.entries(providers)) {
    if (!config) continue
    const record: Record<string, unknown> = { ...config }
    for (const field of MIGRATED_CREDENTIAL_FIELDS) delete record[field]
    for (const field of MODEL_CATALOG_FIELDS) delete record[field]
    out.providers[providerId] = record
  }

  // overlay 三格盖上去(键缺席 = 这个空间没表达过那一格,用 settings 那份)。
  for (const [providerId, enabled] of Object.entries(overlay.providerEnabled ?? {})) {
    if (typeof enabled !== 'boolean') continue
    out.providers[providerId] = { ...(out.providers[providerId] ?? {}), enabled }
  }
  for (const [providerId, ids] of Object.entries(overlay.selectedModels ?? {})) {
    if (!Array.isArray(ids)) continue
    out.providers[providerId] = {
      ...(out.providers[providerId] ?? {}),
      selectedModels: ids.filter(isNonEmptyString).map(id => id.trim()),
    }
  }

  const overlayDefault = overlay.defaultSelection
  const globalProvider = isNonEmptyString(legacy?.provider) ? String(legacy?.provider).trim() : ''
  const provider = overlayDefault?.provider?.trim() || globalProvider
  if (provider) {
    out.provider = provider
    const model = overlayDefault?.model?.trim()
    if (model) out.providers[provider] = { ...(out.providers[provider] ?? {}), model }
  }

  for (const custom of legacy?.customProviders ?? []) {
    if (!custom || typeof custom !== 'object') continue
    const id = custom.id
    if (!isNonEmptyString(id)) continue
    const record: Record<string, unknown> = { ...custom, id: id.trim() }
    for (const field of MIGRATED_CREDENTIAL_FIELDS) delete record[field]
    for (const field of MODEL_CATALOG_FIELDS) delete record[field]
    out.customProviders.push(record as SpaceProviderSettings['customProviders'][number])
  }

  return out
}

/** overlay 里 B7/B9 那三格 —— C2 之后它们住在 providers.json,overlay 不再留。 */
export function stripMigratedOverlayFields(overlay: SpaceOverlay): SpaceOverlay {
  const next: SpaceOverlay = { ...overlay }
  delete next.providerEnabled
  delete next.selectedModels
  delete next.defaultSelection
  return next
}

/**
 * 把 `ai.providers[*].models` / `.modelsLastFetched` 抬进 `ai.modelCatalog`,
 * 再删掉 `ai` 上已经搬走的三个键。
 *
 * **整键删除**,不逐格清理:C1 的做法是从每个 provider 配置里挑着删,那意味着
 * 每加一件 provider 设置就要记得往那张表里补一行 —— 正是要拆掉的东西。
 */
export function stripMigratedProviderFields(settings: AppSettings): {
  settings: AppSettings
  modelCatalog: number
} {
  const ai = settings.ai as unknown as Record<string, unknown> | undefined
  if (!ai) return { settings, modelCatalog: 0 }
  const catalog: Record<string, Record<string, unknown>> = {
    ...((ai.modelCatalog as Record<string, Record<string, unknown>> | undefined) ?? {}),
  }
  let moved = 0
  const providers = (ai.providers ?? {}) as Record<string, Record<string, unknown> | undefined>
  for (const [providerId, config] of Object.entries(providers)) {
    if (!config) continue
    const entry: Record<string, unknown> = { ...(catalog[providerId] ?? {}) }
    let touched = false
    for (const field of MODEL_CATALOG_FIELDS) {
      if (config[field] !== undefined && entry[field] === undefined) {
        entry[field] = config[field]
        touched = true
      }
    }
    if (touched) {
      catalog[providerId] = entry
      moved += 1
    }
  }
  ai.modelCatalog = catalog
  delete ai.provider
  delete ai.providers
  delete ai.customProviders
  return { settings, modelCatalog: moved }
}

/** 自定义 provider 的凭证也要进池 —— 它们和内置 provider 走同一条解析链。 */
function customProviderConfigs(ai: AppSettings['ai'] | undefined): Record<string, ProviderConfig> {
  const list = (ai as { customProviders?: Array<Record<string, unknown>> } | undefined)?.customProviders
  if (!Array.isArray(list)) return {}
  const out: Record<string, ProviderConfig> = {}
  for (const custom of list) {
    if (!custom || typeof custom !== 'object') continue
    const id = custom.id
    if (!isNonEmptyString(id)) continue
    out[id.trim()] = custom as unknown as ProviderConfig
  }
  return out
}

/**
 * `oauth-tokens.json` → default 池的 oauth entries(B6 的 `upsertSpaceProviderOAuthToken`
 * 是同一条写路,这里为了「一次写完整份」直接落在 file 上)。
 *
 * 迁完之后原文件被**清空**(写 `{}`),不是删除:删掉会让下一次
 * `existsSync` 判空走另一条路,而清空是这份文件本来就有的合法状态。
 */
async function migrateOAuthTokens(
  file: SpaceCredentialsFile,
  now: number,
): Promise<{ file: SpaceCredentialsFile; providers: string[]; backup?: string }> {
  // **走宿主的 store 端口,不走 `getDefaultOnethingTokenFilePath()`**。两者在
  // 生产里指向同一个文件,但后者是模块级的 `getOnethingStorePath()`,隔离测试
  // 把 store 根挪走时它照旧指着 `~/.onething` —— 而这个函数会**写**那个文件。
  // 2026-08-18 的实测教训:一次单测把真实 `oauth-tokens.json` 清成了 `{}`。
  const tokenFilePath = path.join(getOnethingStorePath(), 'oauth-tokens.json')
  const providerIds = legacyOAuthProviderIds(tokenFilePath)
  if (providerIds.length === 0) return { file, providers: [] }

  const backup = copyFileToBackup(tokenFilePath, 'oauth-tokens', now)
  const store = new OnethingTokenStore<OAuthToken>({
    tokenFilePath,
    cryptoAdapter: () => getAuthHostPorts().tokenCryptoAdapter?.(),
  })

  const providers = { ...file.providers }
  const migrated: string[] = []
  let index = 0
  for (const providerId of providerIds) {
    const token = await store.getToken(providerId)
    if (!token) continue
    const section = providers[providerId] ?? {
      entries: [],
      policy: DEFAULT_SPACE_CREDENTIAL_POLICY,
    }
    // 已经有 oauth entry = 这个空间已经登过(或已迁过)。不重复塞第二条:
    // 同一串 refresh token 出现两次,轮换起来会互相作废。
    if (section.entries.some(entry => entry.authType === 'oauth')) continue
    providers[providerId] = {
      ...section,
      entries: [
        ...section.entries,
        {
          id: createSpaceCredentialEntryId(now + index),
          label: providerLabel(providerId),
          authType: 'oauth',
          oauthToken: token,
          source: SPACE_CREDENTIAL_SOURCE_USER,
        },
      ],
    }
    migrated.push(providerId)
    index += 1
  }

  fs.writeFileSync(tokenFilePath, JSON.stringify({}, null, 2), 'utf-8')
  return { file: { providers }, providers: migrated, ...(backup ? { backup } : {}) }
}

/** Inspect the legacy envelope without decrypting tokens or contacting Keychain. */
function legacyOAuthProviderIds(tokenFilePath: string): string[] {
  if (!fs.existsSync(tokenFilePath)) return []
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(tokenFilePath, 'utf-8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.keys(raw) : []
  } catch {
    // Preserve the migration's existing behavior for unreadable legacy files.
    return []
  }
}

/** 空间名录 + default —— 迁移与升级都按同一份清单走。 */
function allSpaceIdsForCredentials(): Set<string> {
  const spaceIds = new Set<string>([DEFAULT_SPACE_ID])
  try {
    for (const space of getSpacesStore().list()) spaceIds.add(space.id)
  } catch (err) {
    // 空间名录读不动不该把整件事拖住:default 那一份是必须的,别的下次再说。
    log.warn('could not list spaces for credential pools', {}, err)
  }
  return spaceIds
}

/**
 * **把盘上遗留的明文凭证池升级成密文**(2026-08-31)。
 *
 * 上面那道拒绝闸只挡住"以后不再写出明文";它救不了**已经**被写成
 * `encryption: 'none'` 的池子 —— 那正是这颗雷已经炸过的那些机器(以及 B3~B7
 * 时期的无信封老明文)。惰性升级("下一次写入自动升级")在这里不够用:一个
 * 只读凭证的用户可以一年不触发那次写入,钥匙就明文躺一年。
 *
 * 判据只有一条:**这个进程有加密能力,而盘上那份不是密文**。读侧本来就认三种
 * 形态,所以"读出来再原样写回去"就是一次完整的升级 —— 写侧永远按当前能力产出。
 *
 * 一次性:升完就是 `safeStorage`,下次启动这个函数一格都不动。没有能力的宿主
 * 直接返回,绝不"顺手"把密文降级回明文。
 */
export function upgradeSpaceCredentialsEncryptionAtRest(): string[] {
  const upgraded: string[] = []
  for (const spaceId of allSpaceIdsForCredentials()) {
    if (readSpaceCredentialsAtRest(spaceId) !== 'none') continue
    try {
      const credentials = readSpaceCredentials(spaceId)
      if (!hasSpaceCredentialEntries(credentials)) continue
      // A fresh store (or an empty legacy pool) must not ask the operating
      // system for a secret merely to discover there is nothing to encrypt.
      if (spaceCredentialsEncryptionAtRest() !== 'safeStorage') return upgraded
      // 读得出来(明文那条路读侧一直认),原样写回去 —— 写侧此刻是 safeStorage。
      writeSpaceCredentials(spaceId, credentials)
      upgraded.push(spaceId)
      log.info('credentials pool re-encrypted at rest', { spaceId })
    } catch (err) {
      // 一个空间升不了不该拖住别的(也不该拖垮装配):下次启动重试。
      log.warn('credentials pool re-encryption failed', { spaceId }, err)
    }
  }
  return upgraded
}

/**
 * 装配序列里的那一步。**在 `initializeSettings()` 之后、任何读 provider 配置的
 * 子系统之前**跑 —— 引擎、工具、插件都会问「这个 provider 配了没有」,而迁移之前
 * 那个答案还在旧形状里。
 *
 * ## 两段
 *
 * | 段 | 标记 | 做什么 |
 * | --- | --- | --- |
 * | 一(C1) | `storage.providerConfigMigratedAt` | 凭证 + oauth token → default 凭证池 |
 * | 二(C2) | `storage.spaceProviderSettingsMigratedAt` | `settings.ai` 整体 → 每个空间的 `providers.json`;目录缓存抬进 `ai.modelCatalog`;`ai` 上三个键整删;overlay 三格清掉 |
 *
 * C1 版本已经跑过的机器上第一格在、第二格不在 —— 那就**只跑第二段**(凭证池里
 * 已经有东西了,再搬一次只会堆重复 entry)。全新安装两段一起跑。
 */
export async function migrateProviderConfigToDefaultSpace(
  options: { now?: number } = {},
): Promise<ProviderConfigMigrationReport> {
  const now = options.now ?? Date.now()
  const settings = getPersistedSettings()
  const storage = (settings as {
    storage?: { providerConfigMigratedAt?: number; spaceProviderSettingsMigratedAt?: number }
  }).storage
  const empty: ProviderConfigMigrationReport = {
    migrated: false,
    backups: {},
    credentials: [],
    oauthTokens: [],
    providerSettings: [],
    modelCatalog: 0,
    secondStageOnly: false,
  }
  if (typeof storage?.spaceProviderSettingsMigratedAt === 'number') return empty

  const secondStageOnly = typeof storage?.providerConfigMigratedAt === 'number'
  const providers = {
    ...((settings.ai?.providers ?? {}) as Record<string, ProviderConfig | undefined>),
    ...customProviderConfigs(settings.ai),
  }
  const hasLegacyCredentials = !secondStageOnly && (
    hasSpaceCredentialEntries(buildMigratedCredentialEntries(providers, { providers: {} }, { now }).file)
    || legacyOAuthProviderIds(path.join(getOnethingStorePath(), 'oauth-tokens.json')).length > 0
  )

  /**
   * **存在需搬运的凭据且没有加密能力就不迁**。普通配置与空凭据池不访问 Keychain。
   *
   * 这次迁移把 API key 与 OAuth 令牌搬进 `workspaces/<space>/credentials.json`,
   * 而写侧是「按此刻的能力产出」(`serializeSpaceCredentialsDocument` 的惰性升级)。
   * safeStorage 绑 **app 身份**:一个纯 node 进程(抢先首启的独立 server)注入不了
   * `tokenCryptoAdapter`,于是同一份源料被写成 `encryption: 'none'` —— 钥匙明文
   * 躺在盘上。更坏的是**此后有能力的宿主也不会重迁**:标记已经写下了。
   *
   * 「谁先启动谁跑迁移」这条本身没错,错的是**没有能力的人也去跑**。所以判据
   * 不是宿主种类(装配层不该认识 Electron),是**这个进程此刻有没有加密器**。
   *
   * 拒绝 = 留在未迁移态,一个字节都不写(备份也不做):运行期回落读旧位置的
   * 行为原样保留,功能不破,只是这台机器要等一个有能力的宿主来完成迁移。
   *
   * 拒绝的是**整次**迁移而不只是第一段:第二段会把 `settings.ai.providers`
   * 整个删掉,而钥匙就在那里面 —— 只跑第二段等于把钥匙扔了。
   *
   * ## 代价与正确配法(2026-08-31 用户拍板「甲」)
   *
   * 拒绝迁移 = 这台机器上**这个 store 的钥匙进不了池子**,而不是「运行期回落读
   * 旧位置」——C1 之后 `resolveSpaceProviderCredential` 只认凭证池,唯一的兜底
   * 是**环境变量**那一格,没有任何一条路回落读 `settings.ai.providers[*].apiKey`
   * (`provider-credentials.ts` §7「无回落」)。
   *
   * 所以对一台**从没有过加密能力宿主**的机器,拍板结果是**认下这个代价**:
   *
   *   · headless 部署(独立 `server:start` / CLI daemon)**用环境变量配凭证**
   *     —— `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / … (`providers/env.ts` 的名录,
   *     另有通用的 `<PROVIDER_ID>_API_KEY`)。这条路**不需要迁移也不写盘**,
   *     是 headless 唯一正道;
   *   · 想用 `settings.ai` 里那份存量凭证,就先让桌面跑一次(它有 safeStorage),
   *     迁移在那一刻完成并**加密**落盘,此后 headless 读得到密文与否是另一件事。
   *
   * 明确不做(同一次拍板):**不补运行期回落**(会把 C1 删掉的两套形状请回来),
   * **不开明文开关**。真机 A/B 佐证见 `sessions:shadow-battery` —— 电池与
   * `gate:monotone` 因此改成用环境变量种假 key(它们从前靠 `settings.ai` 种,
   * 正是这条闸挡下的那种写法)。
   */
  if (hasLegacyCredentials && spaceCredentialsEncryptionAtRest() !== 'safeStorage') {
    // 日志是**给部署者看的**:它必须说清「这是有意为之」和「那我该怎么配」,
    // 否则读到它的人只会以为迁移坏了,然后去把这条闸拆掉。
    log.warn(
      'provider config migration deferred on purpose: this host cannot encrypt credentials at rest',
      {
        reason: 'no-credential-encryption',
        why: 'migrating here would write API keys and OAuth tokens to disk in plaintext',
        howToConfigure:
          'headless hosts should supply credentials via environment variables '
          + '(DEEPSEEK_API_KEY / OPENAI_API_KEY / … , or <PROVIDER_ID>_API_KEY) — that path '
          + 'needs no migration and writes nothing to disk',
        howToMigrate:
          'to move the existing settings.ai credentials into the space pool, start the '
          + 'desktop app once on this store: it has safeStorage and completes the migration encrypted',
      },
    )
    return { ...empty, deferredReason: 'no-credential-encryption' }
  }

  const settingsBackup = copyFileToBackup(getOnethingSettingsPath(), 'settings', now)

  let credentials: string[] = []
  let oauthTokens: string[] = []
  let oauthBackup: string | undefined

  if (hasLegacyCredentials) {
    // ① 凭证:内置 provider + 自定义 provider,一起进 default 池。
    const built = buildMigratedCredentialEntries(providers, readSpaceCredentials(DEFAULT_SPACE_ID), {
      now,
    })
    // ② OAuth token。
    const withTokens = await migrateOAuthTokens(built.file, now)
    if (hasSpaceCredentialEntries(withTokens.file)) writeSpaceCredentials(DEFAULT_SPACE_ID, withTokens.file)
    credentials = built.migrated
    oauthTokens = withTokens.providers
    oauthBackup = withTokens.backup
  }

  // ③ 整套 provider 设置 → 每个空间的 providers.json。
  //
  // **每个**空间,不只 default:C2 之前非 default 空间除了 overlay 那三格以外
  // 全部回落全局,搬完之后「用户在每个空间看见的」必须和搬之前一样。这是最后
  // 一次跨空间取值 —— 之后 §7 的「无回落」生效。
  const spaceIds = allSpaceIdsForCredentials()
  const providerSettings: string[] = []
  for (const spaceId of spaceIds) {
    // 已经有 providers.json = 已经在新形状里。搬运只补不覆盖(重跑安全)。
    if (hasSpaceProviderSettings(spaceId)) continue
    const overlay = readSpaceOverlay(spaceId)
    writeSpaceProviderSettings(spaceId, buildSpaceProviderSettings(settings.ai, overlay))
    const stripped = stripMigratedOverlayFields(overlay)
    if (JSON.stringify(stripped) !== JSON.stringify(overlay)) writeSpaceOverlay(spaceId, stripped)
    providerSettings.push(spaceId)
  }

  // ④ 标记 + ⑤ 目录缓存抬升 + 旧键整删:**最后一步一起落盘**。前面任何一步抛错
  // 都走不到这里,于是重跑时旧字段还在(搬运本身是幂等的)。
  const { modelCatalog } = stripMigratedProviderFields(settings)
  const next = settings as AppSettings & { storage?: Record<string, unknown> }
  next.storage = {
    ...(next.storage ?? {}),
    providerConfigMigratedAt: storage?.providerConfigMigratedAt ?? now,
    spaceProviderSettingsMigratedAt: now,
  }
  savePersistedSettings(next)

  return {
    migrated: true,
    migratedAt: now,
    backups: {
      ...(settingsBackup ? { settings: settingsBackup } : {}),
      ...(oauthBackup ? { oauthTokens: oauthBackup } : {}),
    },
    credentials,
    oauthTokens,
    providerSettings,
    modelCatalog,
    secondStageOnly,
  }
}

/* ── 批 8:单槽归位(`docs/design/subscription-accounts-2026-09.md` §8.4)──────────── */

export interface OAuthSlotMigrationReport {
  /** 这次真的归位了没有。`false` = 标记已在 / 前置没满足 / 推迟。 */
  migrated: boolean
  migratedAt?: number
  /** 默认空间池里**原地换了令牌**的 provider(同身份,单槽那一把更新)。 */
  updated: string[]
  /** 默认空间池里**新加了一条**的 provider(池里没有同一身份)。 */
  added: string[]
  /** 同身份但池里那一把更新(`expiresAt` 更大),单槽那一把被丢下的 provider。 */
  kept: string[]
  /** 默认空间池文件的备份(`backups/credentials-default-pre-oauth-slot-migration-<ISO>.json`)。 */
  backup?: string
  /** 单槽文件改名后的路径(`oauth-tokens.migrated-<ISO>.json`,就在 store 根下)。 */
  renamedTo?: string
  /**
   * 没做的理由。`'provider-config-not-migrated'` = C1/C2 还没跑完(它们自己会先处理单槽);
   * `'token-not-readable'` = 单槽里有一把密文,而这个进程没有加密器解不开 —— 留到有能力的宿主。
   */
  deferredReason?: 'provider-config-not-migrated' | 'token-not-readable'
}

/** 两把令牌是不是同一个账号:身份相同,或同一条令牌血统(access / refresh 原文相同)。 */
function sameOAuthAccount(a: OnethingOAuthToken, b: OnethingOAuthToken): boolean {
  const identity = oauthTokenIdentity(a)
  if (identity && identity === oauthTokenIdentity(b)) return true
  if (a.accessToken && a.accessToken === b.accessToken) return true
  return Boolean(a.refreshToken && a.refreshToken === b.refreshToken)
}

/**
 * 单槽里一家那一把令牌 → 默认空间池(纯函数,测试直接喂)。
 *
 *  - 池里有**同一个账号**(身份相同,或同一条令牌血统)的 oauth entry:`expiresAt` 大者赢 ——
 *    单槽那把更新就原地换(冷却一并抹掉,与登录写回同一句话),否则留池里那把;
 *  - 没有:**加在这一家池子的最前面**。单槽那一把是今天默认空间真在用的账号(读路一直读它),
 *    排第一是「行为不变」;池里原有的那条多半是 C1(08-18)搬进来的旧快照,它的 refresh token
 *    早被单槽那边的轮换作废了 —— 排在前面只会让第一发先撞一次 401。**不删它**(只追加不删),
 *    刷新被拒时它自己会坐上 auth-invalid 冷却,用户也可以在订阅卡上退出它。
 */
export function mergeSlotTokenIntoPool(
  file: SpaceCredentialsFile,
  providerId: string,
  token: OnethingOAuthToken,
  options: { entryId: string; label: string },
): { file: SpaceCredentialsFile; outcome: 'updated' | 'added' | 'kept' } {
  const providers = { ...file.providers }
  const section = providers[providerId] ?? { entries: [], policy: DEFAULT_SPACE_CREDENTIAL_POLICY }
  const index = section.entries.findIndex(entry => {
    if (entry.authType !== 'oauth') return false
    const existing = parseSpaceOAuthToken(entry.oauthToken)
    return existing ? sameOAuthAccount(existing, token) : false
  })
  if (index >= 0) {
    const previous = section.entries[index]
    const existing = parseSpaceOAuthToken(previous.oauthToken)
    if (existing && existing.expiresAt >= token.expiresAt) return { file, outcome: 'kept' }
    const { cooldownUntil: _cooldownUntil, cooldownReason: _cooldownReason, ...rest } = previous
    const entries = [...section.entries]
    entries[index] = { ...rest, oauthToken: token }
    providers[providerId] = { ...section, entries }
    return { file: { providers }, outcome: 'updated' }
  }
  const entry: SpaceCredentialEntry = {
    id: options.entryId,
    label: options.label,
    authType: 'oauth',
    oauthToken: token,
    source: SPACE_CREDENTIAL_SOURCE_USER,
  }
  providers[providerId] = { ...section, entries: [entry, ...section.entries] }
  return { file: { providers }, outcome: 'added' }
}

/**
 * **单槽 `<store>/oauth-tokens.json` 归位进默认空间的凭证池**(批 8 §8.4,装配序列里紧跟
 * C1/C2 那一格)。
 *
 * 为什么要有这一步:批 8 之前默认空间的订阅令牌住在单槽里(一家一把),读路也读它;池里那条
 * oauth entry 只是 C1 搬进来的「登没登」的标记。批 8 起默认空间与别的空间一样只读池 ——
 * 不把单槽那一把搬进来,默认空间今天登着的账号就会在升级那一刻「掉线」。
 *
 * 纪律与 C1 同一套:
 *  1. **幂等**:`settings.storage.oauthSlotMigratedAt` 在就直接返回。
 *  2. **先备份,只追加不删**:池文件先 `copyFileToBackup`;单槽文件**改名**
 *     `oauth-tokens.migrated-<ISO>.json` 留底,不删。池里原有的条目一条不删。
 *  3. **失败不留半场**:任何一步抛错都不写标记;池写在改名之前,改名在标记之前 ——
 *     改名之后、写标记之前挂掉,下次启动见不到单槽文件,直接补一个标记。
 *  4. **读不出来就推迟**:单槽里有一把密文而这个进程没有加密器(独立 server / CLI 抢先启动),
 *     不写、不改名、不标记,留给有能力的宿主。明文那几把照搬 —— 它们本来就明文躺在盘上,
 *     搬进池不是降级;有能力的宿主下次启动会把池升级成密文(`upgradeSpaceCredentialsEncryptionAtRest`)。
 *
 * **非默认空间不动**(用户拍板 §7.4):单槽里的令牌没有空间归属,默认空间是唯一确定的家;
 * 别的空间在批 8 之前根本用不上单槽(发送前置拦截报「还没有登录过」),用户在那里重登一次。
 */
export async function migrateOAuthSlotToDefaultSpace(
  options: { now?: number } = {},
): Promise<OAuthSlotMigrationReport> {
  const now = options.now ?? Date.now()
  const empty: OAuthSlotMigrationReport = { migrated: false, updated: [], added: [], kept: [] }
  const settings = getPersistedSettings()
  const storage = (settings as { storage?: { oauthSlotMigratedAt?: number; spaceProviderSettingsMigratedAt?: number } }).storage
  if (typeof storage?.oauthSlotMigratedAt === 'number') return empty
  // C1/C2 没跑完:单槽归它先处理(它会把令牌搬进默认池并清空单槽)。它推迟,这一步也推迟。
  if (typeof storage?.spaceProviderSettingsMigratedAt !== 'number') {
    return { ...empty, deferredReason: 'provider-config-not-migrated' }
  }

  // **走宿主的 store 根,不走 `getDefaultOnethingTokenFilePath()`**(C1 那条 08-18 判例)。
  const tokenFilePath = path.join(getOnethingStorePath(), 'oauth-tokens.json')
  const markDone = (): void => {
    const next = settings as AppSettings & { storage?: Record<string, unknown> }
    next.storage = { ...(next.storage ?? {}), oauthSlotMigratedAt: now }
    savePersistedSettings(next)
  }
  if (!fs.existsSync(tokenFilePath)) {
    markDone()
    return { ...empty, migrated: true, migratedAt: now }
  }

  const store = new OnethingTokenStore<OAuthToken>({
    tokenFilePath,
    cryptoAdapter: () => getAuthHostPorts().tokenCryptoAdapter?.(),
    logger: { warn: (message: string, ...rest: unknown[]) => log.warn('legacy oauth slot read failed', { message }, rest[0]) },
  })
  const providerIds = await store.listProviderIds()
  for (const providerId of providerIds) {
    if (!(await store.isReadable(providerId))) {
      log.warn('oauth slot migration deferred: a token in the legacy slot is encrypted and this host cannot decrypt it', {
        providerId,
        howToMigrate: 'start the desktop app once on this store: it has safeStorage and completes the move',
      })
      return { ...empty, deferredReason: 'token-not-readable' }
    }
  }

  let file = readSpaceCredentials(DEFAULT_SPACE_ID)
  const updated: string[] = []
  const added: string[] = []
  const kept: string[] = []
  let index = 0
  for (const providerId of providerIds) {
    const token = await store.getToken(providerId)
    if (!token) {
      // 读得出信封却解析不出令牌(半个 token):它本来就用不了,照 C1 口径跳过并记一行。
      log.warn('legacy oauth slot token unusable; skipped', { providerId })
      continue
    }
    const merged = mergeSlotTokenIntoPool(file, providerId, token as OnethingOAuthToken, {
      entryId: createSpaceCredentialEntryId(now + index),
      label: providerLabel(providerId),
    })
    index += 1
    file = merged.file
    ;(merged.outcome === 'updated' ? updated : merged.outcome === 'added' ? added : kept).push(providerId)
  }

  let backup: string | undefined
  if (updated.length > 0 || added.length > 0) {
    backup = copyFileToBackup(spaceCredentialsFilePath(DEFAULT_SPACE_ID), 'credentials-default', now, 'pre-oauth-slot-migration')
    writeSpaceCredentials(DEFAULT_SPACE_ID, file)
  }
  const renamedTo = path.join(path.dirname(tokenFilePath), `oauth-tokens.migrated-${backupStamp(now)}.json`)
  fs.renameSync(tokenFilePath, renamedTo)
  markDone()
  log.info('legacy oauth slot moved into the default space pool', { updated, added, kept, renamedTo })
  return {
    migrated: true,
    migratedAt: now,
    updated,
    added,
    kept,
    ...(backup ? { backup } : {}),
    renamedTo,
  }
}
