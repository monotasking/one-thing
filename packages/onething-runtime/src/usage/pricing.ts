import type {
  OnethingUsageBillingMode,
  OnethingUsageLedgerRecord,
  OnethingUsageRecordInput,
  OnethingUsageTokens,
  OnethingUsageUnitPrice,
} from './types.js'

/**
 * Subscription-billed providers (Codex OAuth, Claude Code OAuth, Copilot):
 * no per-token invoice exists, so cost is a same-model official-API estimate
 * rather than a real charge. Callers must label these 'subscription' so the
 * UI never sums them into real spend.
 */
export function resolveOnethingUsageBillingMode(
  providerId: string,
  subscriptionProviderIds: readonly string[],
): OnethingUsageBillingMode {
  return subscriptionProviderIds.includes(providerId) ? 'subscription' : 'api'
}

/**
 * cacheRead is a discounted subset of input (not additional tokens);
 * cacheWrite is billed separately (e.g. Anthropic's 1.25x cache-creation
 * rate). reasoningTokens is informational only — every provider we've
 * checked already folds it into outputTokens/totalTokens, so it is never
 * added a second time here.
 */
export function computeOnethingUsageCostUSD(
  usage: OnethingUsageTokens,
  unitPrice: OnethingUsageUnitPrice | undefined,
): number | null {
  if (!unitPrice) return null
  const billableInput = Math.max(usage.input - usage.cacheRead, 0)
  const millionthsUSD =
    billableInput * unitPrice.input +
    usage.cacheRead * unitPrice.cacheRead +
    usage.cacheWrite * unitPrice.cacheWrite +
    usage.output * unitPrice.output
  return millionthsUSD / 1_000_000
}

function normalizeOnethingUsageTokens(
  usage: OnethingUsageRecordInput['usage'],
): OnethingUsageTokens {
  const input = Math.max(usage.input, 0)
  const output = Math.max(usage.output, 0)
  const cacheRead = Math.max(usage.cacheRead ?? 0, 0)
  const cacheWrite = Math.max(usage.cacheWrite ?? 0, 0)
  const reasoning = Math.max(usage.reasoning ?? 0, 0)
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    total: usage.total ?? input + output,
  }
}

export function buildOnethingUsageLedgerRecord(
  input: OnethingUsageRecordInput,
  now: () => number = Date.now,
): OnethingUsageLedgerRecord {
  const usage = normalizeOnethingUsageTokens(input.usage)
  return {
    ts: input.ts ?? now(),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.credentialId ? { credentialId: input.credentialId } : {}),
    providerId: input.providerId,
    modelId: input.modelId,
    platform: input.platform,
    source: input.source,
    billing: input.billing,
    usage,
    ...(input.unitPrice ? { unitPrice: input.unitPrice } : {}),
    costUSD: computeOnethingUsageCostUSD(usage, input.unitPrice),
    // 厂商报价与本地估算**并存**:`costUSD` 照旧按价目表算,厂商值另存一格。
    // 报了就落(含 0 —— 免费模型的 0 也是一句真话),没报就诚实缺席。
    ...(input.providerCostUSD !== undefined && Number.isFinite(input.providerCostUSD)
      ? { providerCostUSD: Math.max(input.providerCostUSD, 0) }
      : {}),
    ...(input.partial ? { partial: true } : {}),
  }
}
