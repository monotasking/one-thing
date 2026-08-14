/**
 * per-space provider 凭证的**宿主接线**(批 B3)。
 *
 * 规则本身住在产品层(`@onething/runtime/spaces/provider-credentials`);这里只做
 * 三件宿主才知道的事:会话属于哪个空间、这个 provider 是不是 OAuth 型、
 * 它和这个空间叫什么名字(错误文案要说人话)。
 *
 * **注入口只有一个**:`getEffectiveOnethingProviderConfig` —— 两条 provider 解析链
 * (聊天流的 core 引擎 / `provider-helpers` 的 app 侧调用者)共用的那一处
 * (provider-runtime.ts 里 deepseek-goes-codex 的注释就钉在那儿)。多注一处就是
 * 多一份会分家的判据。
 */

import {
  applySpaceProviderCredential,
  resolveSpaceProviderCredential,
  type SpaceProviderCredentialResolution,
} from '@onething/runtime/spaces/provider-credentials'
import {
  buildImportedSpaceCredentials,
  clearSpaceProviderCredentials,
  previewSpaceCredentialApiKey,
  readSpaceCredentials,
  upsertSpaceProviderApiKey,
  writeSpaceCredentials,
  type ImportableProviderCredential,
} from '@onething/runtime/spaces/credentials'
import type {
  SpaceCredentialImportSkip,
  SpaceCredentialsSummary,
  SpacesClearCredentialRequest,
  SpacesSetCredentialRequest,
} from '@onething/runtime/spaces/ipc-operations'
import { DEFAULT_SPACE_ID } from '@onething/runtime/spaces/types'
import type { CoreProviderConfigLike } from '@onething/runtime/providers'
import { getSpacesStore } from '@onething/runtime/spaces/store'
import { resolveSessionSpaceId } from '../stores/sessions.js'
import { getSettings } from '../stores/settings.js'
import { getProviderInfo, requiresOAuth } from './registry.js'

function providerLabel(providerId: string): string {
  try {
    return getProviderInfo(providerId)?.name || providerId
  } catch {
    return providerId
  }
}

function spaceLabel(spaceId: string): string {
  try {
    return getSpacesStore().list().find(space => space.id === spaceId)?.name || spaceId
  } catch {
    return spaceId
  }
}

/** 「这条会话的这个 provider 该用哪把钥匙」——账本归因与工具面都从这里问。 */
export function resolveSessionProviderCredential(
  sessionId: string | undefined | null,
  providerId: string,
): SpaceProviderCredentialResolution {
  const spaceId = resolveSessionSpaceId(sessionId)
  if (spaceId === DEFAULT_SPACE_ID) return { kind: 'settings', spaceId }
  return resolveSpaceProviderCredential({
    spaceId,
    providerId,
    isOAuthProvider: requiresOAuth,
    providerLabel: providerLabel(providerId),
    spaceLabel: spaceLabel(spaceId),
  })
}

/**
 * provider 解析链的注入函数。默认空间恒等返回 —— `settings.ai` 就是它的凭证层,
 * 这条路一个字节都不改。
 */
export function applySessionSpaceCredentials<TProvider extends CoreProviderConfigLike>(
  sessionId: string,
  providerId: string,
  providerConfig: TProvider | undefined,
): TProvider | undefined {
  const resolution = resolveSessionProviderCredential(sessionId, providerId)
  return applySpaceProviderCredential(providerConfig, resolution, providerId)
}

/**
 * 账本归因用的 credentialId(批 B3)。
 *
 * **默认空间诚实缺席**:它的凭证来自 settings.ai,那里根本没有 entry id ——
 * 编一个 `'legacy'` 只会让后来的人以为有过这么个东西。
 */
export function resolveSessionCredentialId(
  sessionId: string | undefined,
  providerId: string,
): string | undefined {
  const resolution = resolveSessionProviderCredential(sessionId, providerId)
  return resolution.kind === 'entry' ? resolution.entry.id : undefined
}

/* ── 设置页 / 新建向导的读写面 ─────────────────────────────────────────────── */

/** 摘要投影:**密钥原文永不出后端**,渲染层只拿 hasApiKey + 预览。 */
export function getSpaceCredentialsSummary(spaceId: string): SpaceCredentialsSummary {
  const file = readSpaceCredentials(spaceId)
  const providers: SpaceCredentialsSummary['providers'] = {}
  for (const [providerId, credentials] of Object.entries(file.providers)) {
    providers[providerId] = {
      policy: credentials.policy,
      entries: credentials.entries.map(entry => ({
        id: entry.id,
        label: entry.label,
        authType: entry.authType,
        hasApiKey: Boolean(entry.apiKey?.trim()),
        ...(previewSpaceCredentialApiKey(entry.apiKey)
          ? { apiKeyPreview: previewSpaceCredentialApiKey(entry.apiKey) }
          : {}),
        ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
        source: entry.source,
        ...(entry.cooldownUntil ? { cooldownUntil: entry.cooldownUntil } : {}),
      })),
    }
  }
  return { providers }
}

export function setSpaceProviderCredential(
  request: SpacesSetCredentialRequest,
): SpaceCredentialsSummary {
  upsertSpaceProviderApiKey(request.id, request.providerId, {
    apiKey: request.apiKey,
    baseUrl: request.baseUrl,
    label: providerLabel(request.providerId),
  })
  return getSpaceCredentialsSummary(request.id)
}

export function clearSpaceProviderCredential(
  request: SpacesClearCredentialRequest,
): SpaceCredentialsSummary {
  clearSpaceProviderCredentials(request.id, request.providerId)
  return getSpaceCredentialsSummary(request.id)
}

/**
 * 新建向导的「从默认空间导入凭证」——**复制快照,不是引用**。
 *
 * 两条口径,都写在这儿免得以后被人当 bug 修掉:
 *  - 只看 `settings.ai.providers[*].apiKey` 的**原文**,不吃环境变量兜底。
 *    env 是机器级的,把它固化进某个空间的文件里,换台机器就成了一把幽灵钥匙。
 *  - OAuth/订阅型(codex / claude-code / kimi-code …)一律跳过并如实报出来:
 *    非默认空间本切片不支持 OAuth 登录,悄悄导入一个用不了的 token 更糟。
 */
export function importDefaultSpaceCredentials(spaceId: string): {
  imported: string[]
  skipped: SpaceCredentialImportSkip[]
  credentials: SpaceCredentialsSummary
} {
  const providers = getSettings().ai?.providers ?? {}
  const candidates: ImportableProviderCredential[] = Object.entries(providers).map(
    ([providerId, config]) => {
      const record = (config ?? {}) as unknown as Record<string, unknown>
      return {
        providerId,
        apiKey: typeof record.apiKey === 'string' ? record.apiKey : undefined,
        baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : undefined,
        oauth: requiresOAuth(providerId),
        label: providerLabel(providerId),
      }
    },
  )
  const result = buildImportedSpaceCredentials(candidates)
  writeSpaceCredentials(spaceId, result.file)
  return {
    imported: result.imported,
    // 「一把 key 都没有」的 provider 不值得报给用户看 —— 那是绝大多数条目,
    // 报出来只会把真正该看的 OAuth 跳过淹掉。
    skipped: result.skipped.filter(item => item.reason === 'oauth'),
    credentials: getSpaceCredentialsSummary(spaceId),
  }
}
