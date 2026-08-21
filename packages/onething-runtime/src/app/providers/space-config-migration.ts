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
import { OnethingTokenStore } from '@onething/runtime/auth'
import {
  readSpaceCredentials,
  writeSpaceCredentials,
  createSpaceCredentialEntryId,
  DEFAULT_SPACE_CREDENTIAL_POLICY,
  SPACE_CREDENTIAL_SOURCE_USER,
  type SpaceCredentialEntry,
  type SpaceCredentialsFile,
} from '@onething/runtime/spaces/credentials'
import {
  readSpaceOverlay,
  writeSpaceOverlay,
  type SpaceOverlay,
} from '@onething/runtime/spaces/overlay'
import {
  createEmptySpaceProviderSettings,
  hasSpaceProviderSettings,
  writeSpaceProviderSettings,
  type SpaceProviderSettings,
} from '@onething/runtime/spaces/provider-settings'
import { getSpacesStore } from '@onething/runtime/spaces/store'
import { DEFAULT_SPACE_ID } from '@onething/runtime/spaces/types'
import { getAuthHostPorts } from '@onething/runtime/auth/host-ports'
import { getSettingsPath, getStorePath } from '../stores/paths.js'
import { getPersistedSettings, savePersistedSettings } from '../stores/settings.js'
import { getProviderInfo } from './registry.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('providers')


/**
 * settings 里那三家的档位字段 → entry 的 `{apiMode, region}`(批 B10)。
 *
 * 名字对照表只此一份:`spaces/provider-credentials.ts` 是**反方向**的同一张表
 * (entry → config 字段)。两张表都很短,合并成一张要么让产品层认识 settings 的
 * 字段名,要么让装配层认识 entry 的形状 —— 各留一张比拧在一起清楚。
 */
export function pickProviderDials(
  providerId: string,
  record: Record<string, unknown>,
): { apiMode?: string; region?: string } {
  const read = (key: string): string | undefined => {
    const value = record[key]
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }
  if (providerId === 'zhipu') {
    const apiMode = read('zhipuApiMode')
    return apiMode ? { apiMode } : {}
  }
  if (providerId === 'qwen') {
    const apiMode = read('qwenApiMode')
    const region = read('qwenRegion')
    return { ...(apiMode ? { apiMode } : {}), ...(region ? { region } : {}) }
  }
  if (providerId === 'kimi' || providerId === 'kimi-code') {
    const apiMode = read('kimiApiMode')
    const region = read('kimiRegion')
    return { ...(apiMode ? { apiMode } : {}), ...(region ? { region } : {}) }
  }
  return {}
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
}

function backupsDir(): string {
  return path.join(getStorePath(), 'backups')
}

/** ISO 时间戳做文件名:冒号在 Windows 上不能进路径,换成 `-`。 */
function backupStamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-')
}

function copyFileToBackup(sourcePath: string, name: string, now: number): string | undefined {
  if (!fs.existsSync(sourcePath)) return undefined
  const dir = backupsDir()
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, `${name}-pre-space-migration-${backupStamp(now)}.json`)
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
 * **空 key 且无 baseUrl 的不建 entry** —— `DEFAULT_PROVIDER_CONFIGS` 给每个内置
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
  const tokenFilePath = path.join(getStorePath(), 'oauth-tokens.json')
  if (!fs.existsSync(tokenFilePath)) return { file, providers: [] }

  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(tokenFilePath, 'utf-8'))
  } catch {
    // 读不动的 token 文件不该把整次迁移拖住(它本来就已经不能用了)。
    return { file, providers: [] }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { file, providers: [] }
  const providerIds = Object.keys(raw as Record<string, unknown>)
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
  const settingsBackup = copyFileToBackup(getSettingsPath(), 'settings', now)

  let credentials: string[] = []
  let oauthTokens: string[] = []
  let oauthBackup: string | undefined

  if (!secondStageOnly) {
    // ① 凭证:内置 provider + 自定义 provider,一起进 default 池。
    const providers = {
      ...((settings.ai?.providers ?? {}) as Record<string, ProviderConfig | undefined>),
      ...customProviderConfigs(settings.ai),
    }
    const built = buildMigratedCredentialEntries(providers, readSpaceCredentials(DEFAULT_SPACE_ID), {
      now,
    })
    // ② OAuth token。
    const withTokens = await migrateOAuthTokens(built.file, now)
    writeSpaceCredentials(DEFAULT_SPACE_ID, withTokens.file)
    credentials = built.migrated
    oauthTokens = withTokens.providers
    oauthBackup = withTokens.backup
  }

  // ③ 整套 provider 设置 → 每个空间的 providers.json。
  //
  // **每个**空间,不只 default:C2 之前非 default 空间除了 overlay 那三格以外
  // 全部回落全局,搬完之后「用户在每个空间看见的」必须和搬之前一样。这是最后
  // 一次跨空间取值 —— 之后 §7 的「无回落」生效。
  const spaceIds = new Set<string>([DEFAULT_SPACE_ID])
  try {
    for (const space of getSpacesStore().list()) spaceIds.add(space.id)
  } catch (err) {
    // 空间名录读不动不该把迁移拖住:default 那一份是必须的,别的下次再说。
    log.warn('provider-settings migration could not list spaces', {}, err)
  }
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
