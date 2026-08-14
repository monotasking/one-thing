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
import { ensureSpaceDir, spaceDir } from './persistence.js'
import { DEFAULT_SPACE_ID, isValidSpaceId } from './types.js'

/** 凭证类型。`oauth` 第一天进 schema,但非 default 空间本切片一律判未配置。 */
export type SpaceCredentialAuthType = 'apiKey' | 'oauth'

/**
 * 来源。本切片恒 `'user'`;`plugin:<id>` 是批 F(插件订阅接入)的位子 ——
 * 卸载插件要能按这个字段找到并归档它带来的凭证。
 */
export type SpaceCredentialSource = string

/**
 * 轮换策略。本切片只实现 `'single'`(取第一条可用),其余取值合法但按 single 解析
 * —— 写进 schema 是为了批 D 不必再迁移一次文件。
 */
export type SpaceCredentialPolicy =
  | 'single'
  | 'priority-failover'
  | 'round-robin'
  | string

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

/** 只接受门口卡死过的 id —— id 是路径片段,非法 id 一律当 default。 */
function resolveCredentialsSpaceId(spaceId: string | undefined | null): string {
  return spaceId && isValidSpaceId(spaceId) ? spaceId : DEFAULT_SPACE_ID
}

export function spaceCredentialsFilePath(spaceId: string | undefined | null): string {
  return path.join(spaceDir(resolveCredentialsSpaceId(spaceId)), 'credentials.json')
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
      const parsed = parseSpaceCredentialsFile(JSON.parse(fs.readFileSync(filePath, 'utf-8')))
      if (parsed) file = parsed
      else console.warn(`[spaces] ${filePath} failed schema validation, treating as empty`)
    }
  } catch (err) {
    console.warn(`[spaces] failed to read ${filePath}:`, err)
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
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), 'utf-8')
  credentialsCache.set(filePath, normalized)
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
 * 按策略挑一条 entry。**本切片只实现 `'single'` 的语义**(第一条不在冷却里的),
 * 其余 policy 取值一律按同一句解析 —— 轮换是批 D 的事,提前写一个半吊子的
 * round-robin 只会让批 D 先删掉它。
 */
export function selectSpaceCredentialEntry(
  credentials: SpaceProviderCredentials | undefined,
  now = Date.now(),
): SpaceCredentialEntry | undefined {
  if (!credentials) return undefined
  return credentials.entries.find(entry => !isSpaceCredentialEntryCooling(entry, now))
}

export interface UpsertSpaceCredentialInput {
  apiKey: string
  baseUrl?: string
  apiMode?: string
  label?: string
  entryId?: string
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
  const entry: SpaceCredentialEntry = {
    id: previous?.id ?? createSpaceCredentialEntryId(now),
    label: input.label?.trim() || previous?.label || providerId,
    authType: 'apiKey',
    apiKey: input.apiKey.trim(),
    source: previous?.source ?? SPACE_CREDENTIAL_SOURCE_USER,
    ...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim() } : {}),
    ...(input.apiMode?.trim() ? { apiMode: input.apiMode.trim() } : {}),
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
    providers[providerId] = {
      entries: [{
        id: options.makeEntryId?.(index) ?? createSpaceCredentialEntryId(now + index),
        label: candidate.label?.trim() || providerId,
        authType: 'apiKey',
        apiKey,
        source: SPACE_CREDENTIAL_SOURCE_USER,
        ...(candidate.baseUrl?.trim() ? { baseUrl: candidate.baseUrl.trim() } : {}),
        ...(candidate.apiMode?.trim() ? { apiMode: candidate.apiMode.trim() } : {}),
      }],
      policy: DEFAULT_SPACE_CREDENTIAL_POLICY,
    }
    imported.push(providerId)
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
