/**
 * per-space **整套 provider 设置** —— `workspaces/<id>/providers.json`(C2)。
 *
 * ## 为什么是一整份,而不是再往 overlay 上加几格
 *
 * 用户 08-18 原话:「不同的空间,provider 设置应该是完整的、独立的两套。对齐。」
 * B7/B9 走的是「散装 overlay 字段 + 缺席回落全局」:每加一件 provider 设置就往
 * `space.json` 里加一格,加不到的那些(端点、逐模型上下文、思考档位、自定义
 * provider 定义)继续共享全局。那条路每补一次就漏一件,而且「哪些独立、哪些共享」
 * 没有任何人能背下来。C2 把整份搬过来:**空间即空间,不回落**。
 *
 * ## 形状
 *
 * 文件 = `{ ai: SpaceProviderSettings }`。一级键留位(与 `space.json` 的
 * `{ overlay: … }` 同一手法),叫 `ai` 是为了让「它对应 `settings.ai` 的哪一段」
 * 只需一个词就说清。
 *
 * 里面 = 旧 `AISettings` 减去两样:
 *
 * - **凭证**(`apiKey` / `oauthToken` / `authType`):在同空间的
 *   `credentials.json` 凭证池里 —— 多把 key 轮换需要池,一格装不下。
 * - **models.dev 目录缓存**(`models` / `modelsLastFetched`):留全局。缓存不是
 *   设置,刷新一次该所有空间同时看见。
 *
 * 两样都在**写入时剥掉**(`stripSpaceProviderConfig`),不是靠调用方自觉:这条
 * 落盘入口只有一个,剥在这里就永远不会有第二个人忘记。
 *
 * ## 为什么这里的类型是结构式的
 *
 * 本文件在**产品层**,边界检查器禁止它引用宿主契约包里的 IPC 类型。所以这里只按
 * **结构**约束:顶层是对象、`providers` 是对象、`customProviders` 是数组;每个
 * provider 配置的**内容**原样透传 —— 那是设置页的业务,存储层没有资格枚举它。
 *
 * 设计见 `docs/design/workspace-provider-config-review-2026-08-18.md` §7 / C2。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { notifySpaceDataChanged } from './notifications.js'
import { ensureSpaceDir, spaceDir } from './persistence.js'
import { DEFAULT_SPACE_ID, isValidSpaceId } from './types.js'

import { getLogger } from '../logging/index.js'

const log = getLogger('spaces')

/** 一个 provider 在这个空间的配置。内容对存储层不透明,只有禁忌键是硬规矩。 */
export type SpaceProviderConfigRecord = Record<string, unknown>

/** 自定义 provider 的**定义**(不含凭证)。`id` 是唯一的硬要求。 */
export type SpaceCustomProviderRecord = Record<string, unknown> & { id: string }

export interface SpaceProviderSettings {
  /** 这个空间的默认 provider。空串 = 还没选过(空白空间的初值)。 */
  provider: string
  /** 这个空间的采样温度。缺席 = 用全局缺省。 */
  temperature?: number
  providers: Record<string, SpaceProviderConfigRecord>
  customProviders: SpaceCustomProviderRecord[]
}

/** 落盘形状。`ai` 是唯一的一级键 —— 给未来的非 provider 段留位。 */
export interface SpaceProviderSettingsFile {
  ai: SpaceProviderSettings
}

/**
 * **永不落进 providers.json 的键**。
 *
 * 前三个是凭证(住在 `credentials.json` 凭证池);后两个是 models.dev 目录缓存
 * (住在全局 `settings.ai.modelCatalog`)。`localAddress` 是 defaults 层一直在剥
 * 的一个历史脏键,顺手一起挡掉 —— 两处剥同一个键不算重复,漏掉才是。
 */
export const SPACE_PROVIDER_STRIPPED_FIELDS = [
  'apiKey',
  'oauthToken',
  'authType',
  'models',
  'modelsLastFetched',
  'localAddress',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 空白空间的初值:没有 provider 开着、没有模型选中、没有默认。 */
export function createEmptySpaceProviderSettings(): SpaceProviderSettings {
  return { provider: '', providers: {}, customProviders: [] }
}

/** 剥掉凭证与目录缓存。**写入路径唯一的过滤器**,读侧不再判一次。 */
export function stripSpaceProviderConfig(
  config: SpaceProviderConfigRecord,
): SpaceProviderConfigRecord {
  const next: SpaceProviderConfigRecord = { ...config }
  for (const field of SPACE_PROVIDER_STRIPPED_FIELDS) delete next[field]
  return next
}

/**
 * 归一。**字段级脏值丢弃,结构级不认由 `parseSpaceProviderSettingsFile` 判废** ——
 * 与 overlay 同一条口径。
 */
export function normalizeSpaceProviderSettings(value: unknown): SpaceProviderSettings {
  if (!isRecord(value)) return createEmptySpaceProviderSettings()
  const out = createEmptySpaceProviderSettings()

  if (typeof value.provider === 'string') out.provider = value.provider.trim()
  if (typeof value.temperature === 'number' && Number.isFinite(value.temperature)) {
    out.temperature = value.temperature
  }

  if (isRecord(value.providers)) {
    for (const [providerId, config] of Object.entries(value.providers)) {
      const id = providerId.trim()
      if (!id || !isRecord(config)) continue
      out.providers[id] = stripSpaceProviderConfig(config)
    }
  }

  if (Array.isArray(value.customProviders)) {
    const seen = new Set<string>()
    for (const raw of value.customProviders) {
      if (!isRecord(raw)) continue
      const id = typeof raw.id === 'string' ? raw.id.trim() : ''
      // id 是自定义 provider 的**主键**(`providers[id]` 靠它对上号)。没有 id
      // 的那一条不是「半个定义」,是无处安放的一坨 —— 丢掉。
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.customProviders.push({ ...stripSpaceProviderConfig(raw), id } as SpaceCustomProviderRecord)
    }
  }

  return out
}

/**
 * 整份解析。**结构不认就整份判废**(返回 null),调用方退回空设置 —— 半份
 * provider 设置比空的更难排查(用户看见少了一个 provider,日志里什么都没有)。
 */
export function parseSpaceProviderSettingsFile(value: unknown): SpaceProviderSettingsFile | null {
  if (!isRecord(value)) return null
  if (value.ai === undefined) return { ai: createEmptySpaceProviderSettings() }
  if (!isRecord(value.ai)) return null
  if (value.ai.providers !== undefined && !isRecord(value.ai.providers)) return null
  if (value.ai.customProviders !== undefined && !Array.isArray(value.ai.customProviders)) return null
  return { ai: normalizeSpaceProviderSettings(value.ai) }
}

function resolveSpaceId(spaceId: string | undefined | null): string {
  return spaceId && isValidSpaceId(spaceId) ? spaceId : DEFAULT_SPACE_ID
}

export function spaceProviderSettingsPath(spaceId: string | undefined | null): string {
  return path.join(spaceDir(resolveSpaceId(spaceId)), 'providers.json')
}

/**
 * 读缓存。key 是**绝对文件路径**,不是 spaceId —— 换 store 根(headless 宿主、
 * 隔离测试)天然换 key,不需要额外的失效钩子。与 overlay 同一手法。
 */
const cache = new Map<string, SpaceProviderSettings | null>()

export function resetSpaceProviderSettingsCacheForTests(): void {
  cache.clear()
}

/**
 * 这个空间**有没有**自己的 provider 设置文件。
 *
 * `null` 与「空设置」必须分得开:前者是「这台机器还没迁移 / 这个空间是 C2 之前
 * 建的」,后者是「用户就是把它清空了」。上层据此决定要不要落回旧形状。
 */
export function readSpaceProviderSettings(
  spaceId: string | undefined | null,
): SpaceProviderSettings | null {
  const filePath = spaceProviderSettingsPath(spaceId)
  if (cache.has(filePath)) return cache.get(filePath) ?? null
  let settings: SpaceProviderSettings | null = null
  try {
    if (fs.existsSync(filePath)) {
      const parsed = parseSpaceProviderSettingsFile(JSON.parse(fs.readFileSync(filePath, 'utf-8')))
      if (parsed) settings = parsed.ai
      else {
        // 坏文件按**空设置**收下,不按缺席:文件在就说明这个空间已经在新形状里,
        // 退回旧形状会让一个坏字节把整台机器拖回迁移前的语义。
        log.warn('space provider settings schema validation failed, treating as empty', { filePath })
        settings = createEmptySpaceProviderSettings()
      }
    }
  } catch (err) {
    log.warn('space provider settings read failed', { filePath }, err)
    settings = createEmptySpaceProviderSettings()
  }
  cache.set(filePath, settings)
  return settings
}

/** 有没有这份文件(迁移与「要不要落回旧形状」的判据)。 */
export function hasSpaceProviderSettings(spaceId: string | undefined | null): boolean {
  return readSpaceProviderSettings(spaceId) !== null
}

/**
 * 整层写入(不是 patch):调用方给什么就是什么。与 overlay 同一条 —— 字段一多,
 * 「漏传 = 清空」就是陷阱,所以入口定成整写,由上层显式决定先读后并。
 */
export function writeSpaceProviderSettings(
  spaceId: string | undefined | null,
  settings: unknown,
): SpaceProviderSettings {
  const id = resolveSpaceId(spaceId)
  const next = normalizeSpaceProviderSettings(settings)
  ensureSpaceDir(id)
  const filePath = spaceProviderSettingsPath(id)
  const file: SpaceProviderSettingsFile = { ai: next }
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf-8')
  cache.set(filePath, next)
  // 写盘先、通知后 —— 反过来收到通知的人会读到旧文件(B9-0 同一条)。
  notifySpaceDataChanged({ spaceId: id, kind: 'providers' })
  return next
}

/** 删空间时把缓存也带走(目录已被 `removeSpaceDir` 整个删掉)。 */
export function forgetSpaceProviderSettings(spaceId: string | undefined | null): void {
  cache.delete(spaceProviderSettingsPath(spaceId))
}
