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

export function estimateHistoryMessagesInputTokens(historyMessages: unknown[] | undefined): number | undefined {
  if (!historyMessages) return undefined
  if (historyMessages.length === 0) return 0
  return estimateTextTokens(safeJsonForUsage(normalizeHistoryValueForUsage(historyMessages)))
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

function normalizeHistoryValueForUsage(value: unknown, depth = 0): unknown {
  if (depth > 20) return '[Max depth reached]'
  if (typeof value === 'string') return normalizeStringForUsage(value)
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => normalizeHistoryValueForUsage(item, depth + 1))

  const normalized: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === 'originalContent' || key === 'originalContentHash') continue
    normalized[key] = normalizeHistoryValueForUsage(child, depth + 1)
  }
  return normalized
}

function normalizeStringForUsage(value: string): string {
  if (value.length <= 4000) return value
  if (/^data:[^;]+;base64,/.test(value) || /^[A-Za-z0-9+/=]{4000,}$/.test(value)) {
    return `[large inline data omitted: ${value.length} chars]`
  }
  return value
}
