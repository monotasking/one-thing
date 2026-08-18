/**
 * per-space provider 凭证的**解析规则**(批 B3)——「这条会话该用哪把钥匙」。
 *
 * ## 三条不能记错的话(C1 起)
 *
 * 1. **default 也是普通空间。** C1 之前这里有第三态 `{kind:'settings'}` ——
 *    「默认空间的凭证源是 `settings.ai`,原地不动」。零迁移换来的是**两套数据
 *    形状**,每个消费者都得写一次 `isDefaultSpace ? A : B`,每一片都会漏一个。
 *    C1 一次性迁移之后 default 空间也有自己的 `credentials.json` + `space.json`,
 *    于是本模块只剩两态:池里有可用 entry → 用它;没有 → `unavailable`。
 * 2. **空间之间严格隔离,不回落。** 该空间没有这个 provider 的 entry,就是
 *    「这个 provider 在这个空间**未配置**」——一等状态,起流前置拦截,绝不
 *    静默借用别的空间的 key。
 * 3. **环境变量 API key 是机器级的,所有空间可见**(C1 拍板 1)。它从来没有
 *    存进任何一个空间的文件里,谈不上「泄漏」;而把它挡在空间外只会让一台
 *    配了 `OPENAI_API_KEY` 的机器在新建空间里莫名其妙起不了流。所以池里没有
 *    entry 但机器环境里有这把钥匙时,解析结果是 `env` 而不是 `unavailable` ——
 *    不盖标记、不阻断,由 `resolveOnethingProviderApiKey` 的 env 兜底接手。
 *    **边界**:env 只补 `apiKey` 这一格;OAuth 型 provider 的「没登录」不受它
 *    影响(一串环境变量不会让你登录),池里有 entry 时也永远以 entry 为准。
 */

import type {
  CoreProviderConfigLike,
  CoreSpaceCredentialMarker,
} from '../providers/provider-config.js'
import {
  getSpaceProviderCredentials,
  selectSpaceCredentialEntryDetailed,
  spaceCredentialCursorKey,
  type SpaceCredentialEntry,
} from './credentials.js'
import { DEFAULT_SPACE_ID, isValidSpaceId } from './types.js'

/** provider 自己的档位字段名 —— entry.apiMode 往哪一格里落。 */
const PROVIDER_API_MODE_FIELD: Record<string, string> = {
  zhipu: 'zhipuApiMode',
  qwen: 'qwenApiMode',
  kimi: 'kimiApiMode',
  'kimi-code': 'kimiApiMode',
}

/** 同上,地区那一格(批 B10)。zhipu 没有地区,所以表里没有它。 */
const PROVIDER_REGION_FIELD: Record<string, string> = {
  qwen: 'qwenRegion',
  kimi: 'kimiRegion',
  'kimi-code': 'kimiRegion',
}

/**
 * 「这个 provider 的端点由本空间那条 entry 说了算」的名单(批 B10)。
 *
 * 有档位的三家(zhipu / qwen / kimi)——它们的 baseUrl **是从档位派生出来的**,
 * 所以只抹档位不抹 baseUrl 等于没抹:`resolveOnethingZhipuBaseUrl` 在
 * `zhipuApiMode` 缺席时会直接返回 settings 里那条 coding-plan 地址,全局档位
 * 顺着地址原路漏回来。两格必须一起清。
 *
 * 没有档位的 provider 不在名单里:它们的全局 baseUrl 是「我这台机器走哪个代理」,
 * 与空间隔离无关,抹掉只会让所有空间的自建代理集体失效。
 */
const PROVIDER_ENDPOINT_OWNED_BY_ENTRY = new Set(['zhipu', 'qwen', 'kimi', 'kimi-code'])

/**
 * `exhausted`(批 D)是**第三态**,不是 `no-entry` 的一个变体:池里有钥匙,只是
 * 眼下全在冷却里。给用户的出路是「等」而不是「去配一把」—— 两句话说反了,
 * 用户会去 settings 里再加一把同样耗尽的 key。
 */
export type SpaceCredentialUnavailableReason = 'no-entry' | 'oauth' | 'exhausted'

export type SpaceProviderCredentialResolution =
  /** 本空间配了 key:用这条 entry 覆盖。 */
  | { kind: 'entry'; spaceId: string; entry: SpaceCredentialEntry }
  /**
   * 本空间登录过(批 B6)。与 `entry` 分开是因为下游要做的事不同:apiKey 是
   * **同步**盖进 config 就能用,OAuth 得拿着 `{spaceId, entryId}` 去 auth 层
   * 换一个可能需要先刷新的 access token。
   */
  | { kind: 'oauth-entry'; spaceId: string; entry: SpaceCredentialEntry }
  /**
   * 池里没有 entry,但**机器环境**里有这个 provider 的 API key(C1 拍板 1)。
   * 不盖标记、不阻断 —— 下游的 `resolveOnethingProviderApiKey` 会读到它。
   */
  | { kind: 'env'; spaceId: string; envVar?: string }
  /**
   * 这个 provider 从来不问凭证(ACP / 本地 CLI agent / 外部 agent executor)。
   * 它既没有 entry 也没有 env,但**不是**「未配置」—— 报成未配置会让 ACP 在
   * 每一个空间里都起不了流(C1 之前 default 空间靠 `kind:'settings'` 恰好绕开
   * 了这一格,非 default 空间则是真的起不来:那是被三态形状盖住的既有 bug)。
   */
  | { kind: 'credential-free'; spaceId: string }
  /** 本空间没配 / 没登录:未配置(一等状态)。 */
  | {
      kind: 'unavailable'
      spaceId: string
      reason: SpaceCredentialUnavailableReason
      message: string
    }

export interface ResolveSpaceProviderCredentialOptions {
  spaceId: string | undefined | null
  providerId: string
  /** provider 本身是不是 OAuth/订阅型(codex / claude-code / kimi-code 之类)。 */
  isOAuthProvider?: (providerId: string) => boolean
  /**
   * 机器环境里有没有这个 provider 的 API key(C1 拍板 1)。**宿主注入** ——
   * 产品层这一格不自己读 `process.env`:同一份规则也跑在渲染层的单测里,
   * 而「这台机器的环境」是宿主才有的知识。返回 `{envVar}` 时错误/摘要文案能
   * 报出是哪一个变量;返回 `true` 只表示有。
   */
  hasEnvApiKey?: (providerId: string) => { envVar?: string } | boolean | undefined
  /**
   * 这个 provider 从来不问凭证(ACP / 本地 CLI agent)。宿主注入 —— 判据在
   * provider 名录里(`requiresApiKey === false && !requiresOAuth`),产品层
   * 这一格拿不到名录。
   */
  isCredentialFreeProvider?: (providerId: string) => boolean
  /** 展示名。给错误文案用;缺省就用 providerId。 */
  providerLabel?: string
  /** 空间展示名。同上。 */
  spaceLabel?: string
  now?: number
}

/** 这个空间还没为这个 provider 配 key。 */
export function describeSpaceCredentialMissing(
  providerLabel: string,
  spaceLabel: string,
): string {
  return `空间「${spaceLabel}」未配置 ${providerLabel} 的凭证。请在「设置 → 模型服务」里为本空间添加密钥。`
}

/**
 * 非 default 空间的 OAuth/订阅型 provider **还没在本空间登录**(批 B6)。
 *
 * 批 B3/D 时这句话是「本空间暂不支持 OAuth,请在默认空间使用」—— 那是当时的
 * 临时闸。现在闸拆了,出路从「换个空间」变成「在这儿登一次」:token 不能复制
 * (refresh rotation 下两个空间共用一串 refresh token 会互相作废),所以每个
 * 空间必须自己登录一次。
 */
export function describeSpaceCredentialOAuthUnsupported(
  providerLabel: string,
  spaceLabel: string,
): string {
  return `${providerLabel} 使用登录授权(OAuth/订阅)方式,空间「${spaceLabel}」还没有登录过。请在「设置 → 模型服务 → 空间凭证」里为本空间登录 —— OAuth 账号不能跨空间复制,每个空间各登一次。`
}

/** 恢复时间的人话化。超过一天就说天,免得报一个「1440 分钟后」。 */
export function describeCooldownRemaining(remainingMs: number): string {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return '稍后'
  const minutes = Math.ceil(remainingMs / 60_000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.ceil(minutes / 60)
  return hours < 24 ? `${hours} 小时` : `${Math.ceil(hours / 24)} 天`
}

/** 全池耗尽(批 D)。**说清是「等」不是「配」** —— 出路和 no-entry 完全不同。 */
export function describeSpaceCredentialPoolExhausted(
  providerLabel: string,
  spaceLabel: string,
  earliestRecoveryAt: number,
  now = Date.now(),
): string {
  return `空间「${spaceLabel}」的 ${providerLabel} 凭证全部冷却中(配额耗尽或被限流),最早 ${describeCooldownRemaining(earliestRecoveryAt - now)}后恢复。可在「设置 → 模型服务」里为本空间添加更多密钥。`
}

/**
 * 单一解析规则。所有「这条会话用哪把钥匙」的问题都必须走这里 ——
 * 两条 provider 解析链历史上就是因为各算各的才出过 "选 deepseek 走 codex"。
 */
export function resolveSpaceProviderCredential(
  options: ResolveSpaceProviderCredentialOptions,
): SpaceProviderCredentialResolution {
  const spaceId = options.spaceId && isValidSpaceId(options.spaceId)
    ? options.spaceId
    : DEFAULT_SPACE_ID

  // 从来不问凭证的 provider 先出场:它没有 entry 也没有 env,落到下面任何一条
  // 都会被报成「未配置」。C1 之前 default 空间靠 `kind:'settings'` 绕开了这一
  // 格,非 default 空间是真的起不来 —— 两套形状盖住的既有 bug,合流时必须补。
  if (options.isCredentialFreeProvider?.(options.providerId) === true) {
    return { kind: 'credential-free', spaceId }
  }

  const providerLabel = options.providerLabel?.trim() || options.providerId
  const spaceLabel = options.spaceLabel?.trim() || spaceId
  const now = options.now ?? Date.now()

  // OAuth/订阅型 provider(批 B6):池里只有 oauth entry 有意义 —— 拿一条 apiKey
  // entry 去撞登录授权型端点必然 401。选择仍然走同一个策略分叉点,只是候选集
  // 先按鉴权形态过滤过。
  const oauth = options.isOAuthProvider?.(options.providerId) === true
  const selection = selectSpaceCredentialEntryDetailed(
    getSpaceProviderCredentials(spaceId, options.providerId),
    {
      now,
      cursorKey: spaceCredentialCursorKey(spaceId, options.providerId),
      // 批 E:插件策略的裁决口要知道「哪个空间的哪个 provider」。内置三策略
      // 不看这两格,所以这是纯加法。
      spaceId,
      providerId: options.providerId,
      ...(oauth ? { authType: 'oauth' as const } : {}),
    },
  )

  // 全池冷却是第三态,先判 —— 落进下面那句会被报成「未配置」,把「等 5 分钟」
  // 说成「去配一把钥匙」。
  if (selection.exhausted) {
    return {
      kind: 'unavailable',
      spaceId,
      reason: 'exhausted',
      message: describeSpaceCredentialPoolExhausted(
        providerLabel,
        spaceLabel,
        selection.exhausted.earliestRecoveryAt,
        now,
      ),
    }
  }

  const entry = selection.entry

  // OAuth 型 provider:有 token 才叫登录过。空壳 entry 当未登录 —— 一个用不了的
  // 凭证被当成「配过了」,只会把失败推到 provider 那一侧变成一句看不懂的 401。
  if (oauth) {
    if (!entry || entry.authType !== 'oauth' || !entry.oauthToken) {
      return {
        kind: 'unavailable',
        spaceId,
        reason: 'oauth',
        message: describeSpaceCredentialOAuthUnsupported(providerLabel, spaceLabel),
      }
    }
    return { kind: 'oauth-entry', spaceId, entry }
  }

  if (!entry || entry.authType !== 'apiKey' || !entry.apiKey?.trim()) {
    // 环境变量兜底(C1 拍板 1)。**只在池里拿不出可用 apiKey entry 时**才看它:
    // env 是机器级的补位,不是覆盖 —— 空间里明明配了钥匙却被环境变量顶掉,是
    // 谁也解释不清的一天。同理这一格在 oauth 分支之后,一串环境变量不算登录。
    const env = options.hasEnvApiKey?.(options.providerId)
    if (env) {
      return {
        kind: 'env',
        spaceId,
        ...(typeof env === 'object' && env.envVar ? { envVar: env.envVar } : {}),
      }
    }
    return {
      kind: 'unavailable',
      spaceId,
      reason: entry && entry.authType === 'oauth' ? 'oauth' : 'no-entry',
      message: entry && entry.authType === 'oauth'
        ? describeSpaceCredentialOAuthUnsupported(providerLabel, spaceLabel)
        : describeSpaceCredentialMissing(providerLabel, spaceLabel),
    }
  }

  return { kind: 'entry', spaceId, entry }
}

/** 解析结果压成盖在 config 上的运行期标记。 */
export function toSpaceCredentialMarker(
  resolution: SpaceProviderCredentialResolution,
): CoreSpaceCredentialMarker | undefined {
  // env / credential-free 两态**不盖标记**:标记的唯一作用是把「用哪条 entry」
  // 与「别用」送到鉴权点,而这两态既没有 entry 也不需要阻断。
  if (resolution.kind === 'env' || resolution.kind === 'credential-free') return undefined
  if (resolution.kind === 'entry') {
    return { spaceId: resolution.spaceId, entryId: resolution.entry.id, authType: 'apiKey' }
  }
  if (resolution.kind === 'oauth-entry') {
    return { spaceId: resolution.spaceId, entryId: resolution.entry.id, authType: 'oauth' }
  }
  return {
    spaceId: resolution.spaceId,
    unavailable: { reason: resolution.reason, message: resolution.message },
  }
}

/**
 * 把解析结果**覆盖进** provider config。
 *
 *  - `credential-free`:原样返回(这个 provider 根本不问凭证)。
 *  - `env`(C1 拍板 1):**抹掉** apiKey / oauthToken 再原样返回,不盖标记 ——
 *    抹是因为迁移之前 settings 里可能还留着一把旧钥匙,不抹就成了「空间隔离
 *    对没迁移完的机器不生效」;不盖标记是因为鉴权点要能走到 env 兜底那一句。
 *  - `entry`:覆盖 apiKey / baseUrl? / apiMode?,并盖上 entryId 标记。
 *  - `oauth-entry`(批 B6):盖上本空间那条 entry 的 token,并**抹掉 settings 的
 *    apiKey** —— 严格隔离下,默认空间的钥匙不能顺着 config 漏进来当兜底。
 *    真正的取 token(必要时先刷新)发生在鉴权点,靠的是标记里的
 *    `{spaceId, entryId}`;这里盖的 token 是给「provider 构造时就把凭证烤进闭包」
 *    那条路(agent-loop factory)用的初值。
 *  - `unavailable`:**抹掉** apiKey 与 oauthToken 再盖标记 —— 只盖标记不抹钥匙,
 *    等于把「别用这把钥匙」写在便签上再把钥匙递过去。
 */
export function applySpaceProviderCredential<TProvider extends CoreProviderConfigLike>(
  providerConfig: TProvider | undefined,
  resolution: SpaceProviderCredentialResolution,
  providerId: string,
): TProvider | undefined {
  if (resolution.kind === 'credential-free') return providerConfig
  if (!providerConfig) return providerConfig

  if (resolution.kind === 'env') {
    const next = { ...providerConfig } as Record<string, unknown>
    delete next.apiKey
    delete next.oauthToken
    delete next.spaceCredential
    return next as TProvider
  }

  const marker = toSpaceCredentialMarker(resolution)

  if (resolution.kind === 'unavailable') {
    const next = { ...providerConfig } as Record<string, unknown>
    delete next.apiKey
    delete next.oauthToken
    next.spaceCredential = marker
    return next as TProvider
  }

  if (resolution.kind === 'oauth-entry') {
    const next = { ...providerConfig } as Record<string, unknown>
    delete next.apiKey
    next.oauthToken = resolution.entry.oauthToken
    if (resolution.entry.baseUrl) next.baseUrl = resolution.entry.baseUrl
    next.spaceCredential = marker
    return next as TProvider
  }

  const entry = resolution.entry
  const apiModeField = PROVIDER_API_MODE_FIELD[providerId]
  const regionField = PROVIDER_REGION_FIELD[providerId]
  const next = { ...providerConfig } as Record<string, unknown>

  // **严格隔离也管档位**(批 B10)。B3 把 apiMode / baseUrl 归进「凭证」那一类
  // (§3 归属拆分表),但当年只做了「entry 有就盖」,entry 没有时全局那一格原样
  // 留在 config 里 —— 于是空间 2 的 Kimi 悄悄跟着全局走了海外版。缺席不该是
  // 「跟全局」,缺席该是「这家 provider 自己的缺省」(normalizer 会给)。
  if (PROVIDER_ENDPOINT_OWNED_BY_ENTRY.has(providerId)) {
    delete next.baseUrl
    if (apiModeField) delete next[apiModeField]
    if (regionField) delete next[regionField]
  }

  next.apiKey = entry.apiKey
  if (entry.baseUrl) next.baseUrl = entry.baseUrl
  if (entry.apiMode && apiModeField) next[apiModeField] = entry.apiMode
  if (entry.region && regionField) next[regionField] = entry.region
  next.spaceCredential = marker
  return next as TProvider
}
