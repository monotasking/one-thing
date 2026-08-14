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
  pricingQuality: OnethingUsagePricingQuality;
  byProject: OnethingUsageProjectTotals[];
}

export interface GetSessionUsageRequest {
  sessionId: string;
}

export interface GetSessionUsageResponse {
  apiCostUSD: number;
  subscriptionCostUSD: number;
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
 * The router is the whole contract: `@onething/app` registers handlers against
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
