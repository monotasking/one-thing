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

import { getAuthHostPorts } from '@onething/runtime/auth/host-ports'
import {
  applySpaceProviderCredential,
  resolveSpaceProviderCredential,
  type SpaceProviderCredentialResolution,
} from '@onething/runtime/spaces/provider-credentials'
import {
  addSpaceProviderCredentialEntry,
  buildImportedSpaceCredentials,
  clearSpaceProviderCredentials,
  configureSpaceCredentialsCrypto,
  isPluginSpaceCredentialPolicy,
  markSpaceCredentialCooldown,
  previewSpaceCredentialApiKey,
  readSpaceCredentials,
  removeSpaceProviderCredentialEntry,
  setSpaceProviderCredentialPool,
  upsertSpaceProviderApiKey,
  writeSpaceCredentials,
  type ImportableProviderCredential,
} from '@onething/runtime/spaces/credentials'
import {
  isPluginCredentialStrategyAvailable,
  listPluginCredentialStrategies,
} from './credential-strategy.js'
import {
  classifyOAuthRefreshError,
  providerErrorCooldownUntil,
} from '@onething/runtime/agent-loop/provider-error-classification'
import {
  credentialTargetFromSpaceMarker,
  isSpaceCredentialTarget,
  parseSpaceOAuthToken,
  SETTINGS_CREDENTIAL_TARGET,
  type OnethingCredentialTarget,
} from '@onething/runtime/auth'
import type {
  SpaceCredentialImportSkip,
  SpaceCredentialsSummary,
  SpacesClearCredentialRequest,
  SpacesSetCredentialPoolRequest,
  SpacesSetCredentialRequest,
} from '@onething/runtime/spaces/ipc-operations'
import { isExternalAgentExecutorProvider } from '@onething/runtime/agents'
import { DEFAULT_SPACE_ID } from '@onething/runtime/spaces/types'
import {
  createEmptySpaceProviderSettings,
  hasSpaceProviderSettings,
  readSpaceProviderSettings,
  writeSpaceProviderSettings,
  type SpaceProviderSettings,
} from '@onething/runtime/spaces/provider-settings'
import { DEFAULT_PROVIDER_CONFIGS } from '@shared/defaults/settings.js'
import type {
  CoreProviderConfigLike,
  CoreSpaceCredentialMarker,
} from '@onething/runtime/providers'
import { getSpacesStore } from '@onething/runtime/spaces/store'
import { authService } from '../auth/auth-service.js'
import type { ProviderAuthContext } from '@onething/runtime/auth/types.wiring'
import { resolveSessionSpaceId } from '../../stores/sessions.js'
import { getProviderInfo, requiresOAuth } from './registry.js'
import { getProviderEnvStatus } from '@onething/runtime/providers/env.wiring'

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
  return resolveSpaceProviderCredentialForSpace(spaceId, providerId)
}

/**
 * 同一条规则的「按空间」入口。**default 不再是特例**(C1):它和别的空间走
 * 同一份 `credentials.json` + 同一条解析。设置页的「配没配好」与起流前置拦截
 * 因此不可能分家。
 */
export function resolveSpaceProviderCredentialForSpace(
  spaceId: string,
  providerId: string,
): SpaceProviderCredentialResolution {
  return resolveSpaceProviderCredential({
    spaceId,
    providerId,
    isOAuthProvider: requiresOAuth,
    isCredentialFreeProvider,
    hasEnvApiKey: hasProviderEnvApiKey,
    providerLabel: providerLabel(providerId),
    spaceLabel: spaceLabel(spaceId),
  })
}

/**
 * 机器环境里有没有这把钥匙(C1 拍板 1)。env 是**机器级**的,所有空间可见 ——
 * 它从未写进任何空间的文件,谈不上隔离被破坏;而挡掉它只会让一台配了
 * `OPENAI_API_KEY` 的机器在新空间里莫名起不了流。
 */
export function hasProviderEnvApiKey(providerId: string): { envVar?: string } | undefined {
  const status = getProviderEnvStatus(providerId)
  return status.detectedEnvVar ? { envVar: status.detectedEnvVar } : undefined
}

/**
 * 从不问凭证的 provider:ACP、外部 agent executor、以及名录里
 * `requiresApiKey === false && !requiresOAuth` 的本地 CLI agent。
 * 判据与渲染层 `useSpaceProviderView.isCredentialFreeProvider` 同一句。
 */
export function isCredentialFreeProvider(providerId: string): boolean {
  if (providerId === 'acp') return true
  if (isExternalAgentExecutorProvider(providerId)) return true
  const info = getProviderInfo(providerId)
  return Boolean(info && info.requiresApiKey === false && !info.requiresOAuth)
}

/**
 * provider 解析链的注入函数。**每个空间同一条路**(C1):default 不再恒等返回,
 * 它和别的空间一样过一遍池 —— 于是「配了模型没配 key」在默认空间也会被诚实
 * 拦住,而不是让请求带着一把空钥匙撞到 401。
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
 * C1 起 default 空间迁移出了自己的 entry,所以这一格**不再对默认空间恒缺席**。
 * 仍然缺席的只有三种:env 兜底(机器级,没有 entry id)、从不问凭证的 provider、
 * 未配置 —— 它们本来就没有「哪把钥匙」可归因,编一个 id 只会让后来的人以为有过
 * 这么个东西。迁移之前落下的旧账本行照旧缺席(不回填,那是伪造历史)。
 */
export function resolveSessionCredentialId(
  sessionId: string | undefined,
  providerId: string,
): string | undefined {
  const resolution = resolveSessionProviderCredential(sessionId, providerId)
  return resolution.kind === 'entry' || resolution.kind === 'oauth-entry'
    ? resolution.entry.id
    : undefined
}

/* ── per-space OAuth(批 B6)────────────────────────────────────────────────── */

/**
 * B3 的运行期标记 → auth 层的写回目标。
 *
 * 这是「解析点有 sessionId、鉴权点没有」那条老规矩的第二段:B3 用它把「未配置」
 * 顺着 config 送到鉴权点,B6 用同一条路把「token 在哪儿」送过去。
 * 鉴权点因此**不必反查一遍会话属于哪个空间** —— 反查会引入第二份判据。
 */
export function credentialTargetFromMarker(
  marker: CoreSpaceCredentialMarker | undefined,
): OnethingCredentialTarget {
  return credentialTargetFromSpaceMarker(marker)
}

/**
 * 鉴权点的 OAuth 分支(`resolveProviderAuthWithAdapters` → `resolveOAuthAuth`)。
 *
 * 两件事只在这里做:
 *  1. 按标记去**本空间那条 entry** 取 token(必要时 `refreshTokenIfNeeded` 先刷新,
 *     单飞锁在 authService 里);
 *  2. 刷新被拒(`invalid_grant` / 400/401/403)时给那条 entry 写 auth-invalid 冷却。
 *     下一次解析就会跳过它 —— 池里还有别的账号就自动接力,一个都不剩就报
 *     `exhausted`。**只有分类器判成 auth-invalid 才写**:网络抖动不该让一个
 *     好账号坐 24 小时冷板凳。
 */
export async function resolveSessionSpaceOAuthAuth(
  providerId: string,
  apiKey: string | undefined,
  marker: CoreSpaceCredentialMarker | undefined,
): Promise<ProviderAuthContext | null> {
  const target = credentialTargetFromMarker(marker)
  if (!isSpaceCredentialTarget(target)) {
    return authService.resolveProviderAuth(providerId, apiKey, SETTINGS_CREDENTIAL_TARGET)
  }
  try {
    return await authService.resolveProviderAuth(providerId, apiKey, target)
  } catch (error) {
    markSpaceOAuthRefreshFailure(providerId, target.spaceId, target.entryId, error)
    throw error
  }
}

/** 刷新失败 → 批 D 的冷却写侧。返回是否真的写了冷却(测试与日志都靠它)。 */
export function markSpaceOAuthRefreshFailure(
  providerId: string,
  spaceId: string,
  entryId: string | undefined,
  error: unknown,
  now = Date.now(),
): boolean {
  if (!entryId) return false
  const classification = classifyOAuthRefreshError(error)
  if (classification.kind !== 'auth-invalid') return false
  const until = providerErrorCooldownUntil(classification, now)
  if (until <= 0) return false
  markSpaceCredentialCooldown(spaceId, providerId, entryId, until)
  return true
}

/** OAuth 的「退出登录」:删掉那一条 entry(不动同一 provider 的其他账号)。 */
export function removeSpaceProviderOAuthEntry(
  spaceId: string,
  providerId: string,
  entryId: string,
): SpaceCredentialsSummary {
  removeSpaceProviderCredentialEntry(spaceId, providerId, entryId)
  return getSpaceCredentialsSummary(spaceId)
}

/* ── 设置页 / 新建向导的读写面 ─────────────────────────────────────────────── */

/** 摘要投影:**密钥原文永不出后端**,渲染层只拿 hasApiKey + 预览。 */
export function getSpaceCredentialsSummary(spaceId: string): SpaceCredentialsSummary {
  const file = readSpaceCredentials(spaceId)
  const providers: SpaceCredentialsSummary['providers'] = {}
  for (const [providerId, credentials] of Object.entries(file.providers)) {
    // 批 E:插件策略此刻可用吗?**只投影,不改写** —— `policy` 原样送出去,
    // 面板据 `policyUnavailable` 画灰态(greyed not removed)。
    const policyUnavailable = isPluginSpaceCredentialPolicy(credentials.policy)
      && !isPluginCredentialStrategyAvailable(credentials.policy)
    providers[providerId] = {
      policy: credentials.policy,
      ...(policyUnavailable ? { policyUnavailable: true } : {}),
      entries: credentials.entries.map(entry => {
        const token = entry.authType === 'oauth' ? parseSpaceOAuthToken(entry.oauthToken) : null
        return {
          id: entry.id,
          label: entry.label,
          authType: entry.authType,
          hasApiKey: Boolean(entry.apiKey?.trim()),
          ...(previewSpaceCredentialApiKey(entry.apiKey)
            ? { apiKeyPreview: previewSpaceCredentialApiKey(entry.apiKey) }
            : {}),
          ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
          // 批 B10:档位/地区不是密钥,原样投影 —— 面板要画的就是这两格。
          ...(entry.apiMode ? { apiMode: entry.apiMode } : {}),
          ...(entry.region ? { region: entry.region } : {}),
          source: entry.source,
          ...(entry.cooldownUntil ? { cooldownUntil: entry.cooldownUntil } : {}),
          ...(entry.authType === 'oauth'
            ? {
                hasOAuthToken: Boolean(token),
                ...(token ? { oauthExpiresAt: token.expiresAt } : {}),
                ...(token?.email || token?.accountId
                  ? { oauthAccount: token.email || token.accountId }
                  : {}),
              }
            : {}),
        }
      }),
    }
  }
  // 实时注册表快照(批 E)。**不落盘** —— 它是"此刻装着哪些插件"的投影,
  // 与用户存下的 policy 字段是两回事。
  const strategies = listPluginCredentialStrategies().map(strategy => ({
    policy: strategy.policy,
    pluginId: strategy.pluginId,
    title: strategy.title,
    ...(strategy.description ? { description: strategy.description } : {}),
  }))
  return { providers, ...(strategies.length > 0 ? { strategies } : {}) }
}

/**
 * 写一条凭证。**`entryId` 在就是改那一条,不在就是追加一条**(批 D)。
 *
 * 改一条 key 会把它的 `cooldownUntil` 一并抹掉 —— 换了新钥匙还留着旧钥匙的
 * 冷却,等于让用户刚配好的 key 先坐五分钟冷板凳。`upsert`/`add` 都不写这个
 * 字段,整条 entry 是覆盖写,所以这件事是自动成立的,不是额外一行。
 */
export function setSpaceProviderCredential(
  request: SpacesSetCredentialRequest,
): SpaceCredentialsSummary {
  // 三个非密钥字段**原样透传**(含 `undefined`)—— 归一/合并的口径只有
  // `patchedEntryDials` 一处。在这里补一个 `?? ''` 就会把「这次不表达」翻译成
  // 「清空」,那正是换一次 key 顺手抹掉端点的老毛病。
  const input = {
    apiKey: request.apiKey,
    baseUrl: request.baseUrl,
    apiMode: request.apiMode,
    region: request.region,
    label: request.label?.trim() || providerLabel(request.providerId),
  }
  if (request.entryId) {
    upsertSpaceProviderApiKey(request.id, request.providerId, {
      ...input,
      entryId: request.entryId,
    })
  } else {
    addSpaceProviderCredentialEntry(request.id, request.providerId, input)
  }
  seedSpaceSelectedModels(request.id, request.providerId)
  return getSpaceCredentialsSummary(request.id)
}

/**
 * 空白空间加**第一把** key 时,给这个 provider 预填首装默认模型表(方案 §2)。
 *
 * 为什么需要:C2 之后「选了哪些模型」只住在这个空间的 `providers.json` 里,而
 * qwen / acp / claude-code-agent 这几家的可用模型 models.dev 目录里根本没有
 * (或滞后),首装默认表是它们唯一的来源。不预填的话,用户在新空间配好 key,
 * 模型选择器里空空如也 —— 而他并没有「清空过」。
 *
 * **只在这个 provider 一格都没表达过时预填**:表达成空数组是用户自己清的,
 * 那一格不能被一次加 key 悄悄填回来。顺带把默认 provider 也钉上 —— 一个空白
 * 空间配好第一把 key 之后应该能直接发消息,而不是再去设置页点一次「设为默认」。
 */
export function seedSpaceSelectedModels(spaceId: string, providerId: string): void {
  const current = readSpaceProviderSettings(spaceId) ?? createEmptySpaceProviderSettings()
  const config = current.providers[providerId]
  const seedConfig = DEFAULT_PROVIDER_CONFIGS[providerId]
  const seeds = seedConfig?.selectedModels ?? []
  const seedModel = seedConfig?.model ?? ''
  const alreadyExpressed = config !== undefined && config.selectedModels !== undefined
  const needsDefault = !current.provider

  const next: SpaceProviderSettings = {
    ...current,
    providers: { ...current.providers },
    customProviders: [...current.customProviders],
  }
  const record: Record<string, unknown> = { ...(config ?? {}) }
  // 表达成空数组是用户自己清的,那一格不能被一次加 key 悄悄填回来。
  if (!alreadyExpressed && seeds.length > 0) record.selectedModels = [...seeds]
  // 配了钥匙却在选择器里看不见是解释不清的一天 —— 没表达过就当开着。
  if (record.enabled === undefined) record.enabled = true
  if (!record.model && seedModel) record.model = seedModel
  next.providers[providerId] = record

  // 空白空间配好第一把 key 之后应该能直接发消息,而不是再去设置页点一次
  // 「设为默认」。已经有默认的空间不动。
  if (needsDefault) {
    next.provider = providerId
    if (!record.model) {
      const model = seeds[0] ?? ''
      if (model) record.model = model
    }
  }

  if (JSON.stringify(next) === JSON.stringify(current)) return
  writeSpaceProviderSettings(spaceId, next)
}

/** 整池写(批 D):排序 + 删除 + 策略一次落盘。密钥原文不经过这条路。 */
export function setSpaceProviderCredentialPoolForRequest(
  request: SpacesSetCredentialPoolRequest,
): SpaceCredentialsSummary {
  setSpaceProviderCredentialPool(request.id, request.providerId, {
    entryIds: request.entryIds,
    policy: request.policy,
  })
  return getSpaceCredentialsSummary(request.id)
}

/**
 * 把凭证池的落盘加密接到**已有的**宿主端口上(批 B8-1)。
 *
 * `configureAuthHost({ tokenCryptoAdapter })` 是全仓唯一的加密器注入口
 * (Electron 给 `safeStorage`,headless 宿主不给)。这里没有新开端口,只是把
 * 同一个 adapter 转接给产品层的 `spaces/credentials` —— 它不认识装配层,更不
 * 认识 electron。取法与 `TokenStore` 逐字同构:传的是一个**每次现问**的函数,
 * 所以宿主在模块加载之后才 wire 也来得及。
 *
 * 由 `configureAppRuntimeAdapters()` 调用,幂等。
 */
let spaceCredentialsCryptoConfigured = false

export function configureAppSpaceCredentialsCrypto(): void {
  if (spaceCredentialsCryptoConfigured) return
  spaceCredentialsCryptoConfigured = true
  configureSpaceCredentialsCrypto(() => getAuthHostPorts().tokenCryptoAdapter?.())
}

export function clearSpaceProviderCredential(
  request: SpacesClearCredentialRequest,
): SpaceCredentialsSummary {
  clearSpaceProviderCredentials(request.id, request.providerId)
  return getSpaceCredentialsSummary(request.id)
}

/**
 * 新建向导的「从某个空间复制」——**复制快照,不是引用**。
 *
 * C2 起它复制**两样**:该空间的整套 provider 设置(`providers.json`)与凭证池。
 * 只复制钥匙不复制设置的话,新空间开出来是「有 key、没有一个模型被选中、没有
 * 默认」——用户以为复制了,结果还得把设置页从头点一遍。设置的复制**只在目标
 * 空间还没有 providers.json 时**发生(与凭证同一条纪律:只补不覆盖)。
 *
 * C1 起源头是**另一个空间的凭证池**(缺省 default),不再是 `settings.ai`:
 * 迁移之后 settings 里已经没有 apiKey 这一格了,继续读它只会导出一片空。
 *
 * 两条口径,都写在这儿免得以后被人当 bug 修掉:
 *  - 只复制 entry 里的**原文**,不吃环境变量兜底。env 是机器级的、本来就全空间
 *    可见(C1 拍板 1),把它固化进某个空间的文件里,换台机器就成了一把幽灵钥匙。
 *  - **OAuth/订阅型一律跳过 —— 批 B6 起这是刻意的,不是「还没做」**。
 *    复制一份 oauth token 等于两个空间共用同一串 refresh token;在 refresh
 *    rotation(刷新时旧 refresh token 立即作废)下,谁先刷新谁就把另一个空间
 *    踢下线,而且症状是随机的。所以 OAuth 账号必须在目标空间**单独登录一次**,
 *    导入结果如实报出这一条。
 */
export function importDefaultSpaceCredentials(
  spaceId: string,
  sourceSpaceId: string = DEFAULT_SPACE_ID,
): {
  imported: string[]
  skipped: SpaceCredentialImportSkip[]
  credentials: SpaceCredentialsSummary
} {
  // ① 整套 provider 设置(C2)。空间的「初值」就是这一份 —— 不复制它,
  // 「从空间 X 复制」出来的空间在模型选择器里是空的。
  if (!hasSpaceProviderSettings(spaceId)) {
    const sourceSettings = readSpaceProviderSettings(sourceSpaceId)
    if (sourceSettings) writeSpaceProviderSettings(spaceId, sourceSettings)
  }

  // ② 凭证池。
  const source = readSpaceCredentials(sourceSpaceId)
  const candidates: ImportableProviderCredential[] = Object.entries(source.providers).flatMap(
    ([providerId, credentials]) => {
      const oauth = requiresOAuth(providerId)
      // 一个 provider 在源空间可能有好几条 entry(批 D 的池)。导入按 entry 逐条
      // 复制 —— 只带第一条会让「三把轮换的 key」在新空间悄悄变成一把。
      const entries = credentials.entries.length > 0 ? credentials.entries : []
      if (entries.length === 0) {
        return [{ providerId, oauth, label: providerLabel(providerId) }]
      }
      return entries.map(entry => ({
        providerId,
        ...(entry.apiKey ? { apiKey: entry.apiKey } : {}),
        ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
        // 批 B10:档位/地区跟着密钥一起复制。少带这两格,导入出来的 Kimi 会从
        // 「编程套餐」悄悄退回「开放平台按量」—— 而那是**在订阅之外再扣一次钱**。
        ...(entry.apiMode ? { apiMode: entry.apiMode } : {}),
        ...(entry.region ? { region: entry.region } : {}),
        oauth: oauth || entry.authType === 'oauth',
        label: entry.label || providerLabel(providerId),
      }))
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
