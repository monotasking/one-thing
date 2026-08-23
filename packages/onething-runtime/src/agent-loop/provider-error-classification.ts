/**
 * provider 错误的统一分类器(批 D)—— 「这把 key 是不是用完了」的唯一判据。
 *
 * ## 为什么保守是这个模块的第一原则
 *
 * 分类的下游是**冷却与轮换**:判一次 `quota-exhausted` 就等于把一把 key 从池子里
 * 拿走 5 分钟。把一个程序性错误(参数写错、模型名不存在、上下文超长)误判成
 * 配额耗尽,会让同一个 bug 沿着池子把每一把 key 依次烧穿 —— 用户看到的是
 * 「所有密钥都失效了」,而真相是一行参数写错了。
 *
 * 所以三条硬规矩:
 *
 *  1. **只有确定的配额耗尽 / 限流才触发冷却轮换。** 证据要么是明确的状态码
 *     (429 / 402),要么是 provider 写死的错误码字面量。
 *  2. **`unknown` 一律不轮换。** 认不出来就别动池子 —— 让它照原样报给用户,
 *     比"猜一个"有用得多。
 *  3. **`transient`(5xx / 网络断 / 529 过载)不冷却任何 key。** 那是服务端的事,
 *     与这把钥匙无关;冷却它等于替 provider 的抖动惩罚用户的钱包。
 *
 * `auth-invalid` 单独成一类并冷却更久:**key 失效不是用完**。它不会自己恢复,
 * 24h 只是「别在这一次会话里反复拿它撞墙」,真正的出路是用户去换一把。
 *
 * ## 各 provider 家族的真实错误形态(2026-08-15 实测自代码,勘误记在设计文档批 D)
 *
 * **P1-d1 起,provider 错误是一个对象:`ProviderHttpError`**
 * (`agent-loop/providers/base/errors.ts`)。它顶层就带 `status` / `providerId` /
 * `responseBody` / `retryAfterAt`,所以下面每个读取函数都**先认这个形状**,认出来
 * 就直接取字段,根本不去碰消息文本。三段兜底与前缀抠取原样留着,服务的是另外
 * 两类来源:OAuth 刷新失败(`auth-service.ts` 造的错误)与任何外来错误。
 *
 * | 家族 | 抛出处 | 形状 |
 * | --- | --- | --- |
 * | claude / claude-code / custom-anthropic | `agent-loop/providers/wires/anthropic-errors.ts` | `ProviderHttpError`,消息 `Claude agent loop API error: <status> <body>` |
 * | deepseek / openai / kimi / zhipu / qwen / grok / openrouter / copilot / custom… | `agent-loop/providers/wires/openai-chat-errors.ts` | `ProviderHttpError`,消息 `<DisplayName> agent loop API error: <status> <body>`;顶层 `responseBody` + `data { providerId, statusCode, responseBody }` 是保留的兼容字段 |
 * | gemini | `agent-loop/providers/wires/gemini-errors.ts` | `ProviderHttpError`,消息 `Gemini agent loop API error: <status> <body>` |
 * | codex | `agent-loop/providers/wires/openai-responses-errors.ts` | `CodexHttpError`(`ProviderHttpError` 子类),消息 `Codex request failed (<status>): <detail>`;顶层 `statusCode` / `isRetryable` 是保留的兼容字段 |
 *
 * **`status === 0` = 没有 HTTP 状态**(流中的错误事件、首字节/空闲超时)。读取
 * 函数把它当作「读不到状态码」原样往下走文本判据 —— 那正是换装前这些错误的
 * 待遇,一个结论都没变。
 *
 * 兜底那三段(顶层 → `data.statusCode` → 从消息前缀里抠)仍然写在下面:抠的时候
 * 必须**锚定前缀**(`API error: 429` / `request failed (429)`),不能像 `retry.ts`
 * 那样在整条消息里扫 `\b[45]\d\d\b` —— 响应体里一个 `"max_tokens": 500` 就够
 * 让它读错。
 */

export type ProviderErrorKind =
  /** 配额/余额耗尽。确定是这把 key 用完了 —— 冷却最久,换下一把。 */
  | 'quota-exhausted'
  /** 被限流。这把 key 眼下太热,歇一会儿就好 —— 短冷却,换下一把。 */
  | 'rate-limited'
  /** key 本身无效/被拒。不是"用完",不会自己恢复 —— 长冷却并单独标注。 */
  | 'auth-invalid'
  /** 服务端抖动 / 网络断。**与这把 key 无关**,不冷却、不轮换,原地重试。 */
  | 'transient'
  /** 认不出来。**一律不轮换** —— 把程序性错误当配额会无谓烧穿整池。 */
  | 'unknown'

export interface ProviderErrorClassification {
  kind: ProviderErrorKind
  /** 解析出的 HTTP 状态码(能拿到才有)。 */
  status?: number
  /**
   * provider 要求的恢复时刻(ms 时间戳)。**批 B8-2 起真的会有值** —— 五个家族
   * 的错误构造处都把响应头(以及 Gemini 的响应体 `RetryInfo`)解析成绝对时间戳
   * 挂在错误对象上,这里只负责读回来(`providerErrorRetryAfterAt`)。
   * 有值时 `providerErrorCooldownUntil` 优先用它,并夹在
   * `PROVIDER_RETRY_AFTER_MAX_MS` 以内。
   */
  retryAfterAt?: number
  /** 这类错误该不该让「换一把 key 再试」发生。 */
  rotates: boolean
  /** 给日志/勘误用的一句话依据。 */
  reason: string
}

/**
 * 各类的默认冷却时长。**集中在这里可调** —— 依据记在设计文档批 D:
 *
 *  - `quota-exhausted` 5 分钟:配额窗口真实长度从分钟到一天不等(按分钟计费的
 *    并发额度 vs 按天计费的免费层),没有响应头就无从知道。取 5 分钟是因为
 *    **猜短的代价可逆**(轮回来再撞一次,再冷却一次),猜长的代价不可逆
 *    (一把其实已经恢复的 key 被白白闲置几小时)。
 *  - `rate-limited` 60 秒:绝大多数 provider 的 RPM 窗口就是 60 秒。
 *  - `auth-invalid` 24 小时:它不会自己恢复,冷却只是「这一天别再撞它」;
 *    真正的修复是用户换 key —— 换 key 走 upsert,那条路会把 cooldownUntil 抹掉。
 */
export const PROVIDER_ERROR_COOLDOWN_MS: Record<ProviderErrorKind, number> = {
  'quota-exhausted': 5 * 60_000,
  'rate-limited': 60_000,
  'auth-invalid': 24 * 60 * 60_000,
  transient: 0,
  unknown: 0,
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

/**
 * `ProviderHttpError` 的**鸭子形状**:顶层 `status` 是 number **且** `providerId`
 * 是 string。用形状而不是 `instanceof`,是因为这个模块在 runtime 的下游被多条
 * import 路径加载过(包导出 vs 相对源码),`instanceof` 会当场说谎;而这两个字段
 * 一起出现,在这个仓里只有 `ProviderHttpError` 一家。
 *
 * 也不 import `base/errors.ts` —— 那份文件反过来 import 本模块的
 * `withProviderRetryAfter`,认形状避开了一圈循环依赖。
 */
interface ProviderHttpErrorShape {
  providerId: string
  status: number
  responseBody?: unknown
  retryAfterAt?: unknown
}

function asProviderHttpError(error: unknown): ProviderHttpErrorShape | undefined {
  const top = record(error)
  if (!top) return undefined
  return typeof top.status === 'number' && typeof top.providerId === 'string'
    ? (top as unknown as ProviderHttpErrorShape)
    : undefined
}

/**
 * `Retry-After` 透传的上限(批 B8-2)。**畸形/敌意的头不该把一把 key 冷一整天** ——
 * `Retry-After: 86400` 或一个写错年份的 HTTP-date 都会。取 1 小时是因为:比所有
 * 家族的真实限流窗口(秒~分钟级)都宽裕,又短到即使被误用,一次重启/一轮轮换
 * 就能绕过去。夹取发生在**消费点**(`providerErrorCooldownUntil`),解析层原样
 * 保留 provider 说的时刻,便于日志里看见原话。
 */
export const PROVIDER_RETRY_AFTER_MAX_MS = 60 * 60_000

/** 只要 `get()` —— 真 `Headers`、`Map`、测试里的字面量对象都能喂进来。 */
export interface ProviderRetryAfterHeaders {
  get(name: string): string | null | undefined
}

/**
 * 逐家实测的头形态(批 B8-2,记进设计文档的表格):
 *
 * | 家族 | 头 | 形态 |
 * | --- | --- | --- |
 * | 通用(RFC 9110) | `retry-after` | delta-seconds(`30`)**或** HTTP-date |
 * | OpenAI 系 / openai-compatible | `x-ratelimit-reset-requests` / `-tokens` | Go duration(`6m0s` / `2m59.56s` / `340ms`) |
 * | Anthropic | `retry-after` + `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-reset` | 前者秒,后者 RFC 3339 时刻 |
 * | 其余(OpenRouter / Groq / 自建) | `x-ratelimit-reset` | 秒数 **或** epoch(秒/毫秒) |
 * | Gemini | **没有头**,`RetryInfo` 在响应体 `error.details[]` 里(`retryDelay: "27s"`) |
 *
 * 顺序即优先级:`retry-after` 是 provider 直接回答「什么时候再来」的那一句,
 * 其余是「某个桶什么时候重置」的旁证。
 */
const RETRY_AFTER_PRIMARY_HEADER = 'retry-after'

const RETRY_AFTER_SECONDARY_HEADERS = [
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-reset',
  'anthropic-ratelimit-input-tokens-reset',
  'anthropic-ratelimit-output-tokens-reset',
  'x-ratelimit-reset',
] as const

const DURATION_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
}

/** `6m0s` / `2m59.56s` / `340ms` / `1h30m`。整串必须被单位段吃干净,否则不算数。 */
function parseDurationMs(raw: string): number | undefined {
  const text = raw.trim().toLowerCase()
  if (!/^(\d+(?:\.\d+)?(?:ms|s|m|h))+$/.test(text)) return undefined
  let total = 0
  for (const [, amount, unit] of text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    total += Number(amount) * DURATION_UNIT_MS[unit]
  }
  return Number.isFinite(total) ? total : undefined
}

/**
 * 一个头值 → 绝对时刻(ms)。四种形态各有一条**确定的**判据,认不出就返回
 * undefined —— 猜一个出来会直接变成冷却时长,那是分类器最不该做的事。
 *
 * 纯数字的歧义(delta-seconds vs epoch 秒 vs epoch 毫秒)按量级分:
 * `> 1e12` 是毫秒时间戳,`> 1e9` 是秒时间戳,其余是相对秒数。三段边界之间
 * 差着几十年,不会误判。
 */
export function parseProviderRetryAfterValue(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text) return undefined

  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const n = Number(text)
    if (!Number.isFinite(n)) return undefined
    if (n > 1e12) return n
    if (n > 1e9) return n * 1000
    return now + n * 1000
  }

  const duration = parseDurationMs(text)
  if (duration !== undefined) return now + duration

  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Gemini 的 `RetryInfo` 藏在响应体 `error.details[]` 里,只有它没有头。 */
function retryAfterFromBody(body: string | undefined, now: number): number | undefined {
  if (!body) return undefined
  const matched = body.match(/"retryDelay"\s*:\s*"([^"]{1,32})"/)
  if (!matched) return undefined
  const duration = parseDurationMs(matched[1])
  return duration === undefined ? undefined : now + duration
}

/**
 * 从响应头 + 响应体里取「什么时候能再来」。
 *
 * **多个候选时取最早的那个**(`retry-after` 除外 —— 它在就直接用)。理由与
 * 批 D 勘误 6 的「猜短的代价可逆」是同一句:两个桶的重置时刻里挑晚的那个,
 * 万一限住的是早重置的那个桶,就白白闲置了一把好 key;挑早的最坏情况是
 * 轮回来再撞一次、再冷却一次。
 *
 * 落在过去的时刻一律丢弃(时钟偏移 / 头写错),否则会得出一个"立刻恢复"的
 * 冷却,等于没有冷却。
 */
export function parseProviderRetryAfter(
  headers?: ProviderRetryAfterHeaders,
  body?: string,
  now = Date.now(),
): number | undefined {
  const fresh = (at: number | undefined): number | undefined =>
    at !== undefined && at > now ? at : undefined

  if (headers) {
    const primary = fresh(parseProviderRetryAfterValue(headers.get(RETRY_AFTER_PRIMARY_HEADER), now))
    if (primary !== undefined) return primary

    let earliest: number | undefined
    for (const name of RETRY_AFTER_SECONDARY_HEADERS) {
      const at = fresh(parseProviderRetryAfterValue(headers.get(name), now))
      if (at !== undefined && (earliest === undefined || at < earliest)) earliest = at
    }
    if (earliest !== undefined) return earliest
  }

  return fresh(retryAfterFromBody(body, now))
}

/**
 * 把恢复时刻挂到错误对象上(批 B8-2)。**加的是一个可选字段,错误类的公共契约
 * 一字未改** —— 五个家族今天抛什么形状,之后还抛什么形状,只是多带一个
 * `retryAfterAt`。取不到就原样返回,不留一个 `undefined` 键。
 */
export function withProviderRetryAfter<E extends object>(
  error: E,
  source: { headers?: ProviderRetryAfterHeaders; body?: string; now?: number } = {},
): E & { retryAfterAt?: number } {
  const at = parseProviderRetryAfter(source.headers, source.body, source.now)
  return at === undefined ? error : Object.assign(error, { retryAfterAt: at })
}

/**
 * 读回来:**先认 `ProviderHttpError`**,再顶层,再 `data` 里兜一层
 * (openai-compatible 家族的老习惯)。
 */
export function providerErrorRetryAfterAt(error: unknown): number | undefined {
  const http = asProviderHttpError(error)
  if (http) {
    return typeof http.retryAfterAt === 'number' && Number.isFinite(http.retryAfterAt)
      ? http.retryAfterAt
      : undefined
  }
  const top = record(error)
  if (!top) return undefined
  if (typeof top.retryAfterAt === 'number' && Number.isFinite(top.retryAfterAt)) {
    return top.retryAfterAt
  }
  const data = record(top.data)
  if (data && typeof data.retryAfterAt === 'number' && Number.isFinite(data.retryAfterAt)) {
    return data.retryAfterAt
  }
  return undefined
}


/**
 * 状态码:**先认 `ProviderHttpError`**(直接取 `status`,`0` 当作没有),认不出
 * 才走三段兜底 —— 顶层 → `data.statusCode` → **锚定前缀**的消息抠取。
 *
 * 认出对象之后**立刻返回**,不许往下掉:掉下去 `data.statusCode` 会把
 * `status: 0` 又原样捡回来,那正是「流中的错误突然有了 HTTP 状态」这类假事实。
 */
export function providerErrorStatus(error: unknown): number | undefined {
  const http = asProviderHttpError(error)
  if (http) return http.status > 0 ? http.status : undefined
  const top = record(error)
  if (top) {
    for (const key of ['statusCode', 'status']) {
      if (typeof top[key] === 'number') return top[key] as number
    }
    const data = record(top.data)
    if (data && typeof data.statusCode === 'number') return data.statusCode
  }
  const message = providerErrorText(error)
  // 只认这两种前缀 —— 响应体里的数字不参与。
  const matched = message.match(/API error:\s*(\d{3})\b/i)
    ?? message.match(/request failed\s*\((\d{3})\)/i)
  return matched ? Number(matched[1]) : undefined
}

/**
 * 消息 + 结构化响应体 + 一层 cause,拼成待匹配的文本。
 *
 * `ProviderHttpError` 走一条更短的路:它的 `responseBody` 只有一份(`data` 里那
 * 个是同一个字符串的别名),拼两遍除了让文本变长没有任何作用。
 */
export function providerErrorText(error: unknown): string {
  const http = asProviderHttpError(error)
  if (http && error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause
    return [
      error.message,
      cause instanceof Error ? cause.message : undefined,
      typeof http.responseBody === 'string' ? http.responseBody : undefined,
    ]
      .filter(Boolean)
      .join(' ')
  }
  const parts: string[] = []
  if (error instanceof Error) {
    parts.push(error.message)
    const cause = (error as Error & { cause?: unknown }).cause
    if (cause instanceof Error) parts.push(cause.message)
  } else if (typeof error === 'string') {
    parts.push(error)
  } else if (error !== undefined && error !== null) {
    parts.push(String(error))
  }
  const top = record(error)
  if (top) {
    if (typeof top.responseBody === 'string') parts.push(top.responseBody)
    const data = record(top.data)
    if (data && typeof data.responseBody === 'string') parts.push(data.responseBody)
  }
  return parts.join(' ')
}

/**
 * 配额耗尽的**字面证据**。全部来自各家 provider 文档/实测响应体,不是通用词猜测:
 *
 *  - OpenAI / openai-compatible:`insufficient_quota`、`exceeded_current_quota_error`(kimi)
 *  - DeepSeek:402 `Insufficient Balance`
 *  - Anthropic:400 `credit balance is too low`
 *  - Gemini:`RESOURCE_EXHAUSTED` 且明说 quota metric
 *  - Qwen / DashScope:`Allocated quota exceeded`、`Arrearage`(欠费)
 *  - Zhipu:错误码 `1113`(账户额度不足)
 *  - OpenRouter:402 `insufficient credits`
 */
const QUOTA_PATTERNS: RegExp[] = [
  /insufficient[_\s-]?quota/i,
  /exceeded[_\s-]?current[_\s-]?quota/i,
  /insufficient[_\s-]?balance/i,
  /insufficient[_\s-]?credits?/i,
  /credit balance is too low/i,
  /quota[_\s-]?exceeded/i,
  /exceeded your current quota/i,
  /allocated quota exceeded/i,
  /\barrearage\b/i,
  /billing[_\s-]?(?:hard[_\s-]?)?limit[_\s-]?reached/i,
  /"code"\s*:\s*"?1113"?/,
  /余额不足/,
  /额度不足/,
  /账户已欠费/,
]

/** 限流的字面证据。**不含通用的 "quota"** —— 那一串归上面那张表。 */
const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate[_\s-]?limit(?:ed|_exceeded|s)?/i,
  /too many requests/i,
  /requests per (?:minute|second|day)/i,
  /resource[_\s-]?exhausted/i,
  /concurrency limit/i,
  /请求过于频繁/,
]

/**
 * key 本身不对,**字面证据强到与状态码无关**。
 *
 * 必须有这一档,因为状态码在这件事上完全不可靠:Gemini 用 **400** 报
 * `API key not valid`,Anthropic 用 401,OpenAI 用 401 —— 只按 401/403 判会漏掉
 * 一整个家族(这条是写测试时抓出来的,不是推演出来的)。
 */
const AUTH_STRONG_PATTERNS: RegExp[] = [
  /invalid[_\s-]?api[_\s-]?key/i,
  /incorrect api key/i,
  /api key not valid/i,
  /authentication[_\s-]?error/i,
  /api key (?:is )?(?:expired|revoked|disabled)/i,
  /令牌.{0,4}(?:无效|失效)/,
]

/**
 * 弱一档:这些词在别的语境里也出现(某个模型没权限、某个地区被封),
 * 所以**只在 401/403 上作数**。`overloaded` 不在这里 —— 那是服务端过载,归 transient。
 */
const AUTH_STATUS_SCOPED_PATTERNS: RegExp[] = [
  /invalid[_\s-]?authentication/i,
  /permission[_\s-]?denied/i,
  /\bunauthorized\b/i,
]

/** 服务端抖动 / 网络断。**与这把 key 无关**。 */
const TRANSIENT_PATTERNS: RegExp[] = [
  /overloaded/i,
  /\bfetch failed\b/i,
  /econnreset|econnrefused|etimedout|enotfound|epipe|eai_again|econnaborted/i,
  /timed?[_\s-]?out/i,
  /\bterminated\b/i,
  /premature/i,
  /unexpected end of/i,
  /stream (?:was )?(?:interrupted|closed|failed)/i,
  /service[_\s-]?unavailable/i,
  /bad gateway/i,
  /gateway[_\s-]?timeout/i,
  /\bsocket\b/i,
]

function classified(
  kind: ProviderErrorKind,
  reason: string,
  status?: number,
): ProviderErrorClassification {
  return {
    kind,
    reason,
    rotates: kind === 'quota-exhausted' || kind === 'rate-limited' || kind === 'auth-invalid',
    ...(status === undefined ? {} : { status }),
  }
}

/**
 * 分类。**顺序即优先级**,每一步都要有确定的证据才往下判:
 *
 *  1. 中断 —— 用户按了停止,不是任何一种失败。
 *  2. 字面配额证据 —— 最强的信号,先于状态码(402 也可能只是"该充值了"的限流)。
 *  3. 402 —— 付款要求,除了配额耗尽没有第二种解释。
 *  4. 429 —— **有配额字样才算耗尽,否则一律按限流**。429 在 Gemini 那边同时用于
 *     两种情况;歧义时取冷却更短的那个,这是唯一不会白白闲置一把好 key 的选择。
 *  5. 字面鉴权证据 —— key 无效,**与状态码无关**(Gemini 用 400 报 invalid key);
 *     弱一档的词(unauthorized / permission_denied)只在 401/403 上作数;裸 401
 *     本身就算。**403 无证据时不判**:它也可能是地区封禁或模型无权限,
 *     那两种换 key 无济于事。
 *  6. 5xx / 网络字样 —— transient,不动池子。
 *  7. 其余一律 `unknown`。
 */
export function classifyProviderError(error: unknown): ProviderErrorClassification {
  return withRetryAfter(classifyProviderErrorKind(error), error)
}

/**
 * provider 说的恢复时刻是**分类之外的一格事实** —— 它不改变「这是哪一类错误」,
 * 只改变「冷却到什么时候」。所以在两个分类器外面统一贴一层,而不是让每一条
 * `classified(...)` 记得带上它(那种写法漏一条就是永远拿不到)。
 */
function withRetryAfter(
  classification: ProviderErrorClassification,
  error: unknown,
): ProviderErrorClassification {
  const retryAfterAt = providerErrorRetryAfterAt(error)
  return retryAfterAt === undefined ? classification : { ...classification, retryAfterAt }
}

function classifyProviderErrorKind(error: unknown): ProviderErrorClassification {
  if (error instanceof Error && error.name === 'AbortError') {
    return classified('unknown', 'aborted by user')
  }

  const status = providerErrorStatus(error)
  const text = providerErrorText(error)

  if (QUOTA_PATTERNS.some(pattern => pattern.test(text))) {
    return classified('quota-exhausted', 'response carries an explicit quota/balance marker', status)
  }
  if (status === 402) {
    return classified('quota-exhausted', 'HTTP 402 payment required', status)
  }
  if (status === 429) {
    return classified('rate-limited', 'HTTP 429 without an explicit quota marker', status)
  }
  if (AUTH_STRONG_PATTERNS.some(pattern => pattern.test(text))) {
    return classified('auth-invalid', 'response names the API key as invalid', status)
  }
  if (
    (status === 401 || status === 403)
    && AUTH_STATUS_SCOPED_PATTERNS.some(pattern => pattern.test(text))
  ) {
    return classified('auth-invalid', 'credential rejected by the provider', status)
  }
  if (status === 401) {
    return classified('auth-invalid', 'HTTP 401 unauthorized', status)
  }
  if (RATE_LIMIT_PATTERNS.some(pattern => pattern.test(text))) {
    return classified('rate-limited', 'response carries a rate-limit marker', status)
  }
  if (status !== undefined && status >= 500) {
    return classified('transient', `HTTP ${status} from the provider`, status)
  }
  if (TRANSIENT_PATTERNS.some(pattern => pattern.test(text))) {
    return classified('transient', 'network/stream level failure', status)
  }

  // 4xx 里剩下的(400 参数错、404 模型不存在、413 过长…)全是程序性问题。
  // 把它们当配额会让同一个 bug 沿着池子把每一把 key 依次烧穿。
  return classified('unknown', 'no confident classification — never rotate on this', status)
}

/**
 * **OAuth token 端点**的失败分类(批 B6)—— 与上面那个分类器分开,不是重复。
 *
 * 理由是同一个状态码在两处含义相反:
 *
 *  - 聊天端点的 **400** 是程序性错误(参数写错、模型名不存在),所以
 *    `classifyProviderError` 有意把它判成 `unknown`、绝不轮换。
 *  - token 端点的 **400** 是 RFC 6749 §5.2 规定的 `invalid_grant` 出口 ——
 *    refresh token 过期/被撤销/已被消费。那是一条**死掉的凭证**,继续拿它撞墙
 *    只会一直失败。
 *
 * 把这条规则塞进通用分类器,就等于让聊天端点的 400 也开始烧池子。所以它单独成
 * 一个函数,只在「刷新 OAuth token 失败」这一个调用点用。
 *
 * 保守的部分一样不放:5xx / 网络字样一律 `transient`(不冷却),认不出的
 * 一律 `unknown`。
 */
export function classifyOAuthRefreshError(error: unknown): ProviderErrorClassification {
  return withRetryAfter(classifyOAuthRefreshErrorKind(error), error)
}

function classifyOAuthRefreshErrorKind(error: unknown): ProviderErrorClassification {
  if (error instanceof Error && error.name === 'AbortError') {
    return classified('unknown', 'aborted by user')
  }

  const status = providerErrorStatus(error)
  const text = providerErrorText(error)

  if (status !== undefined && status >= 500) {
    return classified('transient', `token endpoint returned HTTP ${status}`, status)
  }
  if (/invalid[_\s-]?grant/i.test(text)) {
    return classified('auth-invalid', 'token endpoint reported invalid_grant', status)
  }
  // 「压根没有 refresh token」= 这条 entry 过期后就再也活不过来,与被拒同一出路:
  // 用户必须重新登录。
  if (/no refresh token available|token expired and no refresh token/i.test(text)) {
    return classified('auth-invalid', 'stored credential cannot be refreshed', status)
  }
  if (status === 400 || status === 401 || status === 403) {
    return classified('auth-invalid', `token endpoint rejected the refresh (HTTP ${status})`, status)
  }
  if (status === 429) {
    return classified('rate-limited', 'token endpoint rate-limited the refresh', status)
  }
  if (TRANSIENT_PATTERNS.some(pattern => pattern.test(text))) {
    return classified('transient', 'network level failure while refreshing', status)
  }
  return classified('unknown', 'no confident classification for this refresh failure', status)
}

/**
 * 冷却到什么时候。**优先用 provider 自己说的恢复时刻**(批 B8-2 起真的有值),
 * 否则用本类的保守默认值。返回 0 = 不冷却。
 *
 * 上限夹在 `PROVIDER_RETRY_AFTER_MAX_MS`(1h):响应头是 provider 单方面写的
 * 一串字符,一个 `Retry-After: 86400` 就够把用户的 key 冷一整天。夹在这里而不是
 * 解析层,是为了让日志/勘误仍然看得见 provider 的原话。
 */
export function providerErrorCooldownUntil(
  classification: ProviderErrorClassification,
  now = Date.now(),
): number {
  if (!classification.rotates) return 0
  if (classification.retryAfterAt && classification.retryAfterAt > now) {
    return Math.min(classification.retryAfterAt, now + PROVIDER_RETRY_AFTER_MAX_MS)
  }
  return now + PROVIDER_ERROR_COOLDOWN_MS[classification.kind]
}
