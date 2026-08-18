import type { SpaceOverlay } from './overlay.js'
import type { SpaceProviderSettings } from './provider-settings.js'
import type { Space } from './types.js'

export interface SpaceRecord {
  id: string
  name: string
  color?: string
  icon?: string
  createdAt: number
}

export interface SpacesCreateRequest {
  name: string
  id?: string
  color?: string
  icon?: string
}

export interface SpacesUpdateRequest {
  id: string
  name?: string
  color?: string
  icon?: string
}

export interface SpacesRemoveRequest {
  id: string
}

export interface OnethingSpacesIpcError {
  success: false
  error: string
  code: string
}

export type OnethingSpacesIpcResult<TPayload extends object = Record<string, never>> =
  | ({ success: true } & TPayload)
  | OnethingSpacesIpcError

export function spaceToRecord(space: Space): SpaceRecord {
  const record: SpaceRecord = { id: space.id, name: space.name, createdAt: space.createdAt }
  if (space.color) record.color = space.color
  if (space.icon) record.icon = space.icon
  return record
}

export function listOnethingSpacesForIpc(
  options: { listSpaces(): Space[] },
): OnethingSpacesIpcResult<{ spaces: SpaceRecord[] }> {
  try {
    return { success: true, spaces: options.listSpaces().map(spaceToRecord) }
  } catch (error) {
    return spacesIpcError(error)
  }
}

export function createOnethingSpaceForIpc(
  options: {
    request: SpacesCreateRequest
    createSpace(input: SpacesCreateRequest): Space
  },
): OnethingSpacesIpcResult<{ space: SpaceRecord }> {
  try {
    return { success: true, space: spaceToRecord(options.createSpace(options.request)) }
  } catch (error) {
    return spacesIpcError(error)
  }
}

export function updateOnethingSpaceForIpc(
  options: {
    request: SpacesUpdateRequest
    updateSpace(id: string, patch: { name?: string; color?: string; icon?: string }): Space | null
  },
): OnethingSpacesIpcResult<{ space: SpaceRecord }> {
  try {
    const { id, ...patch } = options.request
    const space = options.updateSpace(id, patch)
    if (!space) return spacesNotFound(id)
    return { success: true, space: spaceToRecord(space) }
  } catch (error) {
    return spacesIpcError(error)
  }
}

/**
 * 删除。占用统计由宿主注入(`countSessions`)—— spaces store 不认识会话,
 * 而「非空不删」是产品规则,得有人查。三种拒绝各自成码,UI 才能说人话。
 */
export function removeOnethingSpaceForIpc(
  options: {
    request: SpacesRemoveRequest
    countSessions(spaceId: string): number
    removeSpace(
      id: string,
      opts: { sessionCount: number },
    ): { removed: boolean; reason?: 'not-found' | 'default' | 'not-empty' }
  },
): OnethingSpacesIpcResult<{ removed: true }> {
  try {
    const sessionCount = options.countSessions(options.request.id)
    const result = options.removeSpace(options.request.id, { sessionCount })
    if (result.removed) return { success: true, removed: true }
    switch (result.reason) {
      case 'default':
        return { success: false, error: '默认空间不能删除', code: 'DEFAULT_SPACE' }
      case 'not-empty':
        return {
          success: false,
          error: `空间里还有 ${sessionCount} 条会话,先清空再删`,
          code: 'NOT_EMPTY',
        }
      default:
        return spacesNotFound(options.request.id)
    }
  } catch (error) {
    return spacesIpcError(error)
  }
}

/**
 * overlay 读写走**自己的两条通道**,不并进 update。
 *
 * update 的载荷是 space 的身份(name/color/icon),overlay 是它的配置层 —— 两者
 * 生命周期不同(改名很少、改目录很频)、失败语义不同(overlay 写盘失败不该让
 * 改名一起回滚),挤在一条通道里迟早要靠一个 `if (request.overlay)` 分岔。
 */
export interface SpacesGetOverlayRequest {
  id: string
}

export interface SpacesSetOverlayRequest {
  id: string
  overlay: SpaceOverlay
}

export function getOnethingSpaceOverlayForIpc(
  options: {
    request: SpacesGetOverlayRequest
    hasSpace(id: string): boolean
    readOverlay(id: string): SpaceOverlay
  },
): OnethingSpacesIpcResult<{ overlay: SpaceOverlay }> {
  try {
    if (!options.hasSpace(options.request.id)) return spacesNotFound(options.request.id)
    return { success: true, overlay: options.readOverlay(options.request.id) }
  } catch (error) {
    return spacesIpcError(error)
  }
}

export function setOnethingSpaceOverlayForIpc(
  options: {
    request: SpacesSetOverlayRequest
    hasSpace(id: string): boolean
    writeOverlay(id: string, overlay: SpaceOverlay): SpaceOverlay
  },
): OnethingSpacesIpcResult<{ overlay: SpaceOverlay }> {
  try {
    if (!options.hasSpace(options.request.id)) return spacesNotFound(options.request.id)
    const overlay = options.request.overlay ?? {}
    return { success: true, overlay: options.writeOverlay(options.request.id, overlay) }
  } catch (error) {
    return spacesIpcError(error)
  }
}

/* ── 整套 provider 设置(C2)────────────────────────────────────────────────── */

/**
 * `workspaces/<id>/providers.json` 的读写通道。
 *
 * 与 overlay 同样是**自己的两条**:overlay 现在只剩接入目录,provider 设置是
 * 另一份文件、另一条缓存、另一种失败语义(写 provider 设置失败不该把接入目录
 * 一起回滚)。
 */
export interface SpacesGetProviderSettingsRequest {
  id: string
}

export interface SpacesSetProviderSettingsRequest {
  id: string
  ai: SpaceProviderSettings
}

export function getOnethingSpaceProviderSettingsForIpc(
  options: {
    request: SpacesGetProviderSettingsRequest
    hasSpace(id: string): boolean
    readProviderSettings(id: string): SpaceProviderSettings
  },
): OnethingSpacesIpcResult<{ ai: SpaceProviderSettings }> {
  try {
    if (!options.hasSpace(options.request.id)) return spacesNotFound(options.request.id)
    return { success: true, ai: options.readProviderSettings(options.request.id) }
  } catch (error) {
    return spacesIpcError(error)
  }
}

export function setOnethingSpaceProviderSettingsForIpc(
  options: {
    request: SpacesSetProviderSettingsRequest
    hasSpace(id: string): boolean
    writeProviderSettings(id: string, ai: SpaceProviderSettings): SpaceProviderSettings
  },
): OnethingSpacesIpcResult<{ ai: SpaceProviderSettings }> {
  try {
    if (!options.hasSpace(options.request.id)) return spacesNotFound(options.request.id)
    return {
      success: true,
      ai: options.writeProviderSettings(options.request.id, options.request.ai),
    }
  } catch (error) {
    return spacesIpcError(error)
  }
}

/* ── provider 凭证池(批 B3)────────────────────────────────────────────────── */

/**
 * 渲染层看得见的凭证摘要。**永远不含密钥原文** —— 只给 `hasApiKey` + 预览。
 * 设置页要的只是「配没配 / 配的是哪一把」,把原文送出去纯属多担一份风险
 * (批 B2 的接入目录同理:能少传就少传)。
 */
export interface SpaceCredentialEntrySummary {
  id: string
  label: string
  authType: 'apiKey' | 'oauth'
  hasApiKey: boolean
  apiKeyPreview?: string
  baseUrl?: string
  /**
   * provider 专属旋钮(批 B10)。**不是密钥**,所以原样出后端 —— 面板要画的就是
   * 「这条 key 用的是哪个档位/哪个地区」,给个 hasApiMode 布尔没有任何用处。
   */
  apiMode?: string
  region?: string
  source: string
  cooldownUntil?: number
  /**
   * OAuth 型条目的登录态(批 B6)。**同样不含 token 原文** —— 只有「登没登、
   * 什么时候过期、哪个账号」这三样,与 apiKey 那边给预览不给原文是同一条纪律。
   */
  hasOAuthToken?: boolean
  oauthExpiresAt?: number
  oauthAccount?: string
}

export interface SpaceProviderCredentialSummary {
  entries: SpaceCredentialEntrySummary[]
  policy: string
}

export interface SpaceCredentialsSummary {
  providers: Record<string, SpaceProviderCredentialSummary>
}

export interface SpacesGetCredentialsRequest {
  id: string
}

/**
 * 单条 apiKey 凭证的写入。**`entryId` 在就是改那一条,不在就是往池里追加一条**
 * (批 D)。
 *
 * 批 B10 起 `apiKey` 可选,语义分成两支:
 *  - **没有 `entryId`**(追加):`apiKey` 必填且非空 —— 追加一条没有密钥的条目
 *    只会在池里留一行永远用不了的东西。
 *  - **有 `entryId`**(改那一条):`apiKey` 缺席/空 = **不动密钥**,只改非密钥
 *    字段(档位/地区/端点/名称)。密钥原文渲染层根本拿不到(B3 决策 8),不给这条
 *    路等于「改一次地区要重新粘一次 key」。
 *
 * 三个非密钥字段一律是 **patch**:缺席 = 不表达 → 沿用旧值;空串 = 清空。
 */
export interface SpacesSetCredentialRequest {
  id: string
  providerId: string
  apiKey?: string
  baseUrl?: string
  /** zhipu/qwen/kimi 的档位(`standard` / `coding-plan` / `token-plan`)。 */
  apiMode?: string
  /** qwen/kimi 的地区(`cn` / `intl`)。 */
  region?: string
  entryId?: string
  label?: string
}

/**
 * 整池写(批 D):排序 + 删除 + 策略一次落盘。
 *
 * 载荷是 `entryIds` 而不是整份 entries —— 渲染层拿不到密钥原文,它能诚实回传的
 * 只有「这些 id、按这个顺序」。不在列表里的 entry 被删;顺序即 failover 优先级。
 */
export interface SpacesSetCredentialPoolRequest {
  id: string
  providerId: string
  entryIds: string[]
  policy?: string
}

export interface SpacesClearCredentialRequest {
  id: string
  providerId: string
}

/** 新建向导的「从默认空间导入凭证」。**copy 不引用**,导入后改全局互不影响。 */
export interface SpacesImportCredentialsRequest {
  id: string
}

export interface SpaceCredentialImportSkip {
  providerId: string
  reason: 'oauth' | 'no-api-key'
}

export function getOnethingSpaceCredentialsForIpc(
  options: {
    request: SpacesGetCredentialsRequest
    hasSpace(id: string): boolean
    readCredentials(id: string): SpaceCredentialsSummary
  },
): OnethingSpacesIpcResult<{ credentials: SpaceCredentialsSummary }> {
  try {
    if (!options.hasSpace(options.request.id)) return spacesNotFound(options.request.id)
    return { success: true, credentials: options.readCredentials(options.request.id) }
  } catch (error) {
    return spacesIpcError(error)
  }
}

export function setOnethingSpaceCredentialForIpc(
  options: {
    request: SpacesSetCredentialRequest
    hasSpace(id: string): boolean
    writeCredential(request: SpacesSetCredentialRequest): SpaceCredentialsSummary
  },
): OnethingSpacesIpcResult<{ credentials: SpaceCredentialsSummary }> {
  try {
    const { id, providerId, apiKey, entryId } = options.request
    if (!options.hasSpace(id)) return spacesNotFound(id)
    // C1 之前这里挡着默认空间(「它的凭证层就是 settings.ai,往池里写会造出
    // 第二份真相」)。迁移之后 default 也有自己的池,第二份真相不存在了 ——
    // 挡着反而是唯一的那一份没法编辑。
    if (!providerId.trim()) {
      return { success: false, error: 'providerId 不能为空', code: 'INVALID' }
    }
    // 追加一条(没有 entryId)才要求密钥;带 entryId 的是「改这一条」,
    // 允许只改档位/地区/端点 —— 渲染层拿不到密钥原文,逼它重填就是逼它重打一遍。
    if (!entryId?.trim() && !apiKey?.trim()) {
      return { success: false, error: 'API Key 不能为空(要清除请用「清除」)', code: 'INVALID' }
    }
    return { success: true, credentials: options.writeCredential(options.request) }
  } catch (error) {
    return spacesIpcError(error)
  }
}

/**
 * 整池写(批 D)。校验只有一条:**空列表 = 把整段凭证删光**,那是 clear 的意思,
 * 不该由一个"排序"操作顺手完成 —— UI 上删最后一条与「清除」是两个不同的动作,
 * 后端也要能分辨,否则一次误操作的排序请求就能清空一个 provider。
 */
export function setOnethingSpaceCredentialPoolForIpc(
  options: {
    request: SpacesSetCredentialPoolRequest
    hasSpace(id: string): boolean
    writePool(request: SpacesSetCredentialPoolRequest): SpaceCredentialsSummary
  },
): OnethingSpacesIpcResult<{ credentials: SpaceCredentialsSummary }> {
  try {
    const { id, providerId, entryIds } = options.request
    if (!options.hasSpace(id)) return spacesNotFound(id)
    if (!providerId.trim()) {
      return { success: false, error: 'providerId 不能为空', code: 'INVALID' }
    }
    if (!Array.isArray(entryIds) || entryIds.length === 0) {
      return {
        success: false,
        error: '凭证列表不能为空(要清空整段请用「清除」)',
        code: 'INVALID',
      }
    }
    return { success: true, credentials: options.writePool(options.request) }
  } catch (error) {
    return spacesIpcError(error)
  }
}

export function clearOnethingSpaceCredentialForIpc(
  options: {
    request: SpacesClearCredentialRequest
    hasSpace(id: string): boolean
    clearCredential(request: SpacesClearCredentialRequest): SpaceCredentialsSummary
  },
): OnethingSpacesIpcResult<{ credentials: SpaceCredentialsSummary }> {
  try {
    const { id } = options.request
    if (!options.hasSpace(id)) return spacesNotFound(id)
    return { success: true, credentials: options.clearCredential(options.request) }
  } catch (error) {
    return spacesIpcError(error)
  }
}

export function importOnethingSpaceCredentialsForIpc(
  options: {
    request: SpacesImportCredentialsRequest
    hasSpace(id: string): boolean
    isDefaultSpace(id: string): boolean
    importCredentials(id: string): {
      imported: string[]
      skipped: SpaceCredentialImportSkip[]
      credentials: SpaceCredentialsSummary
    }
  },
): OnethingSpacesIpcResult<{
  imported: string[]
  skipped: SpaceCredentialImportSkip[]
  credentials: SpaceCredentialsSummary
}> {
  try {
    const { id } = options.request
    if (!options.hasSpace(id)) return spacesNotFound(id)
    if (options.isDefaultSpace(id)) {
      return {
        success: false,
        error: '默认空间就是导入的来源,不能导入给自己',
        code: 'DEFAULT_SPACE',
      }
    }
    return { success: true, ...options.importCredentials(id) }
  } catch (error) {
    return spacesIpcError(error)
  }
}

function spacesNotFound(id: string): OnethingSpacesIpcError {
  return { success: false, error: `No space "${id}"`, code: 'NOT_FOUND' }
}

function spacesIpcError(error: unknown): OnethingSpacesIpcError {
  return {
    success: false,
    error: error instanceof Error ? error.message : 'Unknown spaces error',
    code: 'INTERNAL',
  }
}
