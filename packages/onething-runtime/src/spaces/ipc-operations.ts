import type { SpaceOverlay } from './overlay.js'
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
  source: string
  cooldownUntil?: number
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

/** 单条 apiKey 凭证的写入。`apiKey` 为空串 = 拒绝(要清空请走 clear)。 */
export interface SpacesSetCredentialRequest {
  id: string
  providerId: string
  apiKey: string
  baseUrl?: string
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
    isDefaultSpace(id: string): boolean
    writeCredential(request: SpacesSetCredentialRequest): SpaceCredentialsSummary
  },
): OnethingSpacesIpcResult<{ credentials: SpaceCredentialsSummary }> {
  try {
    const { id, providerId, apiKey } = options.request
    if (!options.hasSpace(id)) return spacesNotFound(id)
    // 默认空间的凭证层就是 settings.ai。往它的 credentials.json 里写会造出
    // 第二份真相 —— 拒绝比"两边都写"要诚实得多。
    if (options.isDefaultSpace(id)) {
      return {
        success: false,
        error: '默认空间的凭证在「设置 → 模型服务」里直接编辑,不走空间凭证池',
        code: 'DEFAULT_SPACE',
      }
    }
    if (!providerId.trim()) {
      return { success: false, error: 'providerId 不能为空', code: 'INVALID' }
    }
    if (!apiKey.trim()) {
      return { success: false, error: 'API Key 不能为空(要清除请用「清除」)', code: 'INVALID' }
    }
    return { success: true, credentials: options.writeCredential(options.request) }
  } catch (error) {
    return spacesIpcError(error)
  }
}

export function clearOnethingSpaceCredentialForIpc(
  options: {
    request: SpacesClearCredentialRequest
    hasSpace(id: string): boolean
    isDefaultSpace(id: string): boolean
    clearCredential(request: SpacesClearCredentialRequest): SpaceCredentialsSummary
  },
): OnethingSpacesIpcResult<{ credentials: SpaceCredentialsSummary }> {
  try {
    const { id } = options.request
    if (!options.hasSpace(id)) return spacesNotFound(id)
    if (options.isDefaultSpace(id)) {
      return {
        success: false,
        error: '默认空间的凭证在「设置 → 模型服务」里直接编辑,不走空间凭证池',
        code: 'DEFAULT_SPACE',
      }
    }
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
