export type CoreContextUsageTriggerReason = 'none' | 'threshold'
export type CoreContextUsageSource = 'empty' | 'provider-usage' | 'request-estimate'

export interface CoreContextUsageSessionLike {
  contextSize?: number
  lastInputTokens?: number
  summary?: string
  summaryUpToMessageId?: string
}

export interface CoreContextUsageSnapshot {
  providerId?: string
  model?: string
  modelContextLength: number
  thresholdPercent: number
  providerInputTokens: number
  requestEstimatedInputTokens?: number
  visibleInputTokens: number
  effectiveInputTokens: number
  contextPercent: number | null
  triggerReason: CoreContextUsageTriggerReason
  source: CoreContextUsageSource
  details: {
    historyMessageCount: number
    summaryUsed: boolean
  }
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0
  const cjkCount = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const nonCjkCount = Math.max(0, text.length - cjkCount)
  return Math.ceil(cjkCount / 1.8 + nonCjkCount / 4)
}

export function normalizeContextThresholdPercent(value: number | undefined): number {
  return Math.max(50, Math.min(100, value || 85))
}

export function normalizeContextLength(value: number | undefined): number {
  return value && value > 0 ? value : 128000
}

/**
 * 压缩的**唯一**触发判据:输入 token 是否越过用户设的百分比。
 *
 * 2026-08-23 裁定:曾经并列的第二条 hard-limit 线
 * (`inputTokens + reservedOutputTokens >= contextLength − margin`)整条删除 ——
 * models.dev 上 xai grok-4.5 / 4.6 的 context 与 max output 都是 500000,预留
 * 取一半就是 250000,hard 线因此塌到窗口的 ~50%,把用户设的
 * `contextCompactThreshold` 整个盖掉。预留量(`reservedOutputTokens`)从此只剩
 * 一个职责:provider 请求的 `max_tokens`,不再参与任何触发判定。
 */
export function getContextUsageTriggerReason(input: {
  inputTokens: number
  modelContextLength: number
  thresholdPercent: number
}): CoreContextUsageTriggerReason {
  const contextLength = normalizeContextLength(input.modelContextLength)
  const inputTokens = Math.max(0, Math.floor(input.inputTokens || 0))
  if (inputTokens <= 0) return 'none'

  const threshold = normalizeContextThresholdPercent(input.thresholdPercent)
  return inputTokens >= Math.floor(contextLength * (threshold / 100)) ? 'threshold' : 'none'
}

/**
 * 一个媒体部件(图 / 音 / 视频,按部件发给服务商的那种)按多少 token 估。
 *
 * Anthropic 的图按 `w×h/750` 计,≤1568px 的图封顶约 1600;别家同量级。它是个常数而不是按字节算,
 * 因为 base64 的长度与服务商的计费毫无关系。
 */
export const MEDIA_PART_TOKEN_ESTIMATE = 1600

/** 混在**文本**里的 base64(不是部件)服务商按文本切词:Claude 约 2.5 个字符一个 token。 */
const INLINE_BASE64_CHARS_PER_TOKEN = 2.5

interface UsageNormalizeTally {
  extraTokens: number
}

export function estimateHistoryMessagesInputTokens(historyMessages: unknown[] | undefined): number | undefined {
  if (!historyMessages) return undefined
  if (historyMessages.length === 0) return 0
  const tally: UsageNormalizeTally = { extraTokens: 0 }
  const normalized = normalizeHistoryValueForUsage(historyMessages, 0, tally)
  return estimateTextTokens(safeJsonForUsage(normalized)) + tally.extraTokens
}

export function buildContextUsageSnapshot(options: {
  session?: CoreContextUsageSessionLike | null
  historyMessages?: unknown[]
  modelContextLength: number
  thresholdPercent: number
  providerId?: string
  model?: string
}): CoreContextUsageSnapshot {
  const modelContextLength = normalizeContextLength(options.modelContextLength)
  const thresholdPercent = normalizeContextThresholdPercent(options.thresholdPercent)
  const providerInputTokens = Math.max(
    0,
    Math.floor(options.session?.contextSize ?? 0),
    Math.floor(options.session?.lastInputTokens ?? 0),
  )
  const requestEstimatedInputTokens = estimateHistoryMessagesInputTokens(options.historyMessages)
  const hasRequestEstimate = requestEstimatedInputTokens !== undefined
  const visibleInputTokens = hasRequestEstimate
    ? Math.max(0, requestEstimatedInputTokens)
    : providerInputTokens
  const effectiveInputTokens = visibleInputTokens
  const triggerReason = getContextUsageTriggerReason({
    inputTokens: effectiveInputTokens,
    modelContextLength,
    thresholdPercent,
  })

  return {
    providerId: options.providerId,
    model: options.model,
    modelContextLength,
    thresholdPercent,
    providerInputTokens,
    requestEstimatedInputTokens,
    visibleInputTokens,
    effectiveInputTokens,
    contextPercent: modelContextLength > 0
      ? effectiveInputTokens / modelContextLength
      : null,
    triggerReason,
    source: hasRequestEstimate
      ? 'request-estimate'
      : providerInputTokens > 0
        ? 'provider-usage'
        : 'empty',
    details: {
      historyMessageCount: options.historyMessages?.length ?? 0,
      summaryUsed: Boolean(options.session?.summary && options.session?.summaryUpToMessageId),
    },
  }
}

function safeJsonForUsage(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const MEDIA_PART_TYPES = new Set(['image', 'audio', 'video', 'file'])
const MEDIA_PART_DATA_KEYS = new Set(['image', 'data', 'audio', 'video'])

/**
 * 把历史归一成「服务商会怎么收费」的样子,再交给字符估算器;算不进字符的那部分记在 `tally` 里。
 *
 * 2026-10-09 之前这里把 ≥4000 字符的 base64 一律换成一句「省略」—— 于是 Codex 电脑操控那 200KB 的
 * 截图以文本进请求时,估算器数到的是 40 个字符,一次都没触发压缩,直到 Claude 答 400。
 * 两条规矩分开:**部件里的** base64(`{type:'image', image|data: …}`)是一张图,按
 * `MEDIA_PART_TOKEN_ESTIMATE` 一张的常数算;**混在文本里的** base64 服务商按文本切词,按字符数折。
 */
function normalizeHistoryValueForUsage(value: unknown, depth: number, tally: UsageNormalizeTally): unknown {
  if (depth > 20) return '[Max depth reached]'
  if (typeof value === 'string') return normalizeStringForUsage(value, tally)
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => normalizeHistoryValueForUsage(item, depth + 1, tally))

  const record = value as Record<string, unknown>
  const mediaPart = typeof record.type === 'string' && MEDIA_PART_TYPES.has(record.type)
  const normalized: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(record)) {
    if (key === 'originalContent' || key === 'originalContentHash') continue
    if (mediaPart && MEDIA_PART_DATA_KEYS.has(key) && typeof child === 'string' && child.length > 4000) {
      tally.extraTokens += MEDIA_PART_TOKEN_ESTIMATE
      normalized[key] = `[media part: ${child.length} chars]`
      continue
    }
    normalized[key] = normalizeHistoryValueForUsage(child, depth + 1, tally)
  }
  return normalized
}

function normalizeStringForUsage(value: string, tally: UsageNormalizeTally): string {
  if (value.length <= 4000) return value
  if (/^data:[^;]+;base64,/.test(value)) {
    // 一整个 data URL 当一个字符串出现 = 一张以部件形态发出去的图。
    tally.extraTokens += MEDIA_PART_TOKEN_ESTIMATE
    return `[large inline data omitted: ${value.length} chars]`
  }
  if (/^[A-Za-z0-9+/=]{4000,}$/.test(value)) {
    // 光秃秃的 base64 不是部件,服务商按文本切词。
    tally.extraTokens += Math.ceil(value.length / INLINE_BASE64_CHARS_PER_TOKEN)
    return `[large inline data omitted: ${value.length} chars]`
  }
  return value
}
