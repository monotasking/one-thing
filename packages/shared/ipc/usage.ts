import type {
  OnethingUsageBucket,
  OnethingUsagePricingQuality,
  OnethingUsageProjectTotals,
  OnethingUsageSummaryGranularity,
} from "@onething/runtime/usage";
import { defineRouter } from "./router.js";

export type { OnethingUsageBreakdownEntry, OnethingUsageBucket, OnethingUsagePricingQuality, OnethingUsageProjectTotals, OnethingUsageSummaryGranularity } from "@onething/runtime/usage";

export interface GetUsageSummaryRequest {
  granularity: OnethingUsageSummaryGranularity;
  count?: number;
}

export interface GetUsageSummaryResponse {
  granularity: OnethingUsageSummaryGranularity;
  buckets: OnethingUsageBucket[];
  totalApiCostUSD: number;
  totalSubscriptionCostUSD: number;
  /**
   * 厂商自己报的成本合计(USD)。与上面两个本地价目估算**并存**,不相加也不
   * 覆盖:一条记录可能同时有厂商报价和本地估算(设计稿 §10 决策 3)。老账本
   * 没有这个字段,恒为 0。
   */
  totalProviderCostUSD?: number;
  pricingQuality: OnethingUsagePricingQuality;
  byProject: OnethingUsageProjectTotals[];
}

export interface GetSessionUsageRequest {
  sessionId: string;
}

export interface GetSessionUsageResponse {
  apiCostUSD: number;
  subscriptionCostUSD: number;
  /** 本会话里厂商报价的合计(USD)。与本地估算并存,不覆盖。 */
  providerCostUSD?: number;
  turnCount: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  };
}

/**
 * Token usage / billing domain — the T0 pilot for the generic RPC channel.
 *
 * The router is the whole contract: `@onething/backend` registers handlers against
 * it, the renderer builds a client from it. `router.channels` is unused on this
 * path (everything rides `IPC_CHANNELS.RPC_INVOKE` / `POST /api/rpc`); it stays
 * only because `defineRouter` generates it.
 */
export type UsageRoutes = {
  getSummary: { input: GetUsageSummaryRequest; output: GetUsageSummaryResponse };
  getSession: { input: GetSessionUsageRequest; output: GetSessionUsageResponse };
};

export const usageRouter = defineRouter<UsageRoutes>("usage", [
  "getSummary",
  "getSession",
]);
