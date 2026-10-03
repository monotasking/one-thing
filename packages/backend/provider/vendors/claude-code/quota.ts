/**
 * Claude(Pro / Max 订阅)的配额源(§8.2)。
 *
 * `GET <origin>/api/oauth/usage`,OAuth Bearer + 两个头:
 *  - `anthropic-beta: oauth-2025-04-20` —— 没有它这条路由不认 OAuth 令牌;
 *  - `User-Agent: claude-code/<v>` —— **少了它会被归进严限桶,持续 429**(09-26 外网核实)。
 *
 * 这是**非公开接口**(拍点 5):429 时静默,不在卡片上出「获取失败」,后端 10 分钟内不再问
 * (那条规矩住在 `QuotaService`,这里只把 429 如实归因成 `rate-limited`)。
 *
 * 响应:`{ five_hour, seven_day, seven_day_sonnet, seven_day_opus, …: { utilization, resets_at } | null }`。
 * `five_hour` / `seven_day` 是主窗口(id `5h` / `7d`);其余 `seven_day_<族>` 是按型号族计的
 * 附加周窗,id 就用键名、`label` 是族名。值为 `null` 的键(这个套餐没有那一窗)丢掉。
 */
import type { ProviderQuota, ProviderQuotaWindow } from '@shared/contracts/quota.js'
import { classifyQuotaWindowSeconds, quotaEpochMsOf, sortQuotaWindows } from '@shared/quota-windows.js'
import {
  getQuotaJson,
  quotaNow,
  quotaNumberOf,
  quotaOriginOf,
  quotaRecordOf,
  QuotaFetchError,
  type QuotaSource,
} from '../../quota/source.js'

export const CLAUDE_CODE_QUOTA_SOURCE_ID = 'claude-code'
export const CLAUDE_OAUTH_USAGE_PATH = '/api/oauth/usage'
export const CLAUDE_OAUTH_USAGE_BETA = 'oauth-2025-04-20'
export const CLAUDE_OAUTH_USAGE_USER_AGENT = 'claude-code/1.0'
const CLAUDE_DEFAULT_BASE_URL = 'https://api.anthropic.com'

/** 键名前缀 → 窗口长度(秒)。认不出前缀的键不是窗口(可能是 `extra_usage` 之类),丢掉。 */
const CLAUDE_WINDOW_PREFIXES: ReadonlyArray<readonly [prefix: string, seconds: number]> = [
  ['five_hour', 5 * 3600],
  ['seven_day', 7 * 86_400],
]

export function claudeUsageUrlOf(baseUrl: string | undefined): string {
  return `${quotaOriginOf(baseUrl, CLAUDE_DEFAULT_BASE_URL)}${CLAUDE_OAUTH_USAGE_PATH}`
}

function titleCase(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/** `/api/oauth/usage` 的响应 → `ProviderQuota`。纯函数,夹具测试直接喂它。 */
export function normalizeClaudeUsagePayload(payload: unknown, now: number): ProviderQuota {
  const record = quotaRecordOf(payload)
  const windows: ProviderQuotaWindow[] = []
  for (const [key, value] of Object.entries(record)) {
    if (!value || typeof value !== 'object') continue
    const match = CLAUDE_WINDOW_PREFIXES.find(([prefix]) => key === prefix || key.startsWith(`${prefix}_`))
    if (!match) continue
    const [prefix, seconds] = match
    const facts = quotaRecordOf(value)
    const usedPercent = quotaNumberOf(facts.utilization)
    const cls = classifyQuotaWindowSeconds(seconds)
    if (usedPercent === undefined || !cls) continue
    const resetsAt = quotaEpochMsOf(facts.resets_at ?? facts.resetsAt)
    const family = key === prefix ? '' : key.slice(prefix.length + 1)
    windows.push({
      id: family ? key : cls,
      seconds,
      usedPercent,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(family ? { label: titleCase(family) } : {}),
    })
  }
  return { kind: 'windows', windows: sortQuotaWindows(windows), fetchedAt: now }
}

export const claudeCodeQuotaSource: QuotaSource = {
  id: CLAUDE_CODE_QUOTA_SOURCE_ID,
  async fetch(ctx) {
    if (!ctx.oauthToken?.accessToken) {
      throw new QuotaFetchError('auth', 'Claude usage requires a signed-in Claude account')
    }
    const payload = await getQuotaJson(
      ctx,
      claudeUsageUrlOf(ctx.baseUrl),
      {
        Authorization: `Bearer ${ctx.oauthToken.accessToken}`,
        'anthropic-beta': CLAUDE_OAUTH_USAGE_BETA,
        'User-Agent': CLAUDE_OAUTH_USAGE_USER_AGENT,
      },
      'Claude usage request failed:',
    )
    return normalizeClaudeUsagePayload(payload, quotaNow(ctx))
  },
}
