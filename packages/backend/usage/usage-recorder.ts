/**
 * Token billing: per-turn usage ledger. Single choke point (recordUsage) so
 * every LLM call lands in the same append-only JSONL ledger, tagged with the
 * activity that made it (`source`). See docs/design/token-billing.md.
 *
 * Wired producers: the main chat turn (agent-loop-executor), session title
 * generation, the skill-review trigger, and evals.
 * Goal continuation and the radio DJ re-drive a full chat turn, so they bill
 * as 'chat'. Side-line calls run on the tool-call model in the background —
 * `source` is the only thing that makes that spend visible in the usage panel.
 */
import { isSubscriptionProvider, routedProviderIdOf, type CoreSpaceCredentialMarker } from '@onething/backend/provider';
import { OnethingUsageLedger } from "./usage-ledger.js";
import {
  getOnethingSessionUsageTotal,
  getOnethingUsageSummary,
  type OnethingUsageSummaryRequest,
} from "./usage-summary.js";
import type { OnethingUsageBillingMode, OnethingUsageLedgerRecord } from "./usage-types.js";
import { type OnethingUsageSummaryResult } from "@shared/contracts/usage";
import { DEFAULT_SPACE_ID } from "@onething/backend/space";
import type { MessageOrigin } from "@shared/ipc/channel-identity.js";
import { getModelCapabilityEntry } from "@onething/backend/settings";
import { resolveSessionCredentialId } from "@onething/backend/credentials";
import * as store from "@onething/backend/session";
import { sessionReads } from "@onething/backend/session";

export interface RecordUsageInput {
	sessionId?: string;
	providerId: string;
	modelId: string;
	/** Originating channel/platform. Falls back to the session's assistant-message origin, then 'electron'. */
	platform?: string;
	/** Call category: 'chat' | 'title' | 'memory' | 'goal' | 'evals' | ... */
	source: string;
	usage: {
		inputTokens: number;
		outputTokens: number;
		totalTokens?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		reasoningTokens?: number;
		/**
		 * 厂商在响应里报的本次成本(USD)。这是 `AgentUsage` 的字段,整包透传
		 * 进来 —— 账本把它另存一格,**不**用它覆盖本地价目估算。
		 */
		providerCostUSD?: number;
	};
	/** The assistant message this usage was recorded for, used to resolve platform from its origin. */
	assistantMessageId?: string;
	partial?: boolean;
	/**
	 * 这一发**真正用的**那条凭证(批 6)。键在(哪怕值是 `undefined`)= 调用方已经知道,
	 * 账本照收、不再去 `resolveSessionCredentialId` 重解 —— 重解会拨 round-robin 游标,
	 * 而且答的是「用户选的那一家下一发用谁」,不是「这一发用了谁」。键缺席 = 旧行为。
	 */
	credentialId?: string;
}

/**
 * 一发请求的账该记在谁名下(批 6 轮转 v2):被接力给同家另一半时(订阅额度用完 → 同家 API),
 * 账记在**真正发请求的那一家**与那一条凭证上 —— 花的是 API 的钱,就按 `billing: 'api'` 进真实开销。
 */
export function usageAttributionOf(
	providerId: string,
	providerConfig: { spaceCredential?: CoreSpaceCredentialMarker } | undefined | null,
): { providerId: string; credentialId: string | undefined } {
	return {
		providerId: routedProviderIdOf(providerId, providerConfig),
		credentialId: providerConfig?.spaceCredential?.entryId,
	};
}

function platformForOrigin(origin: MessageOrigin | undefined): string {
	if (!origin) return "electron";
	if (origin.transport === "im") {
		return origin.conversation?.connector || origin.replyTarget?.connector || "im";
	}
	if (origin.transport === "desktop") return "electron";
	return origin.transport;
}

function resolvePlatform(input: RecordUsageInput): string {
	if (input.platform) return input.platform;
	if (input.sessionId && input.assistantMessageId) {
		const message = sessionReads.getMessage(
			input.sessionId,
			input.assistantMessageId,
		);
		return platformForOrigin(message?.origin as MessageOrigin | undefined);
	}
	return "electron";
}

/**
 * 归属 space(批 B2)。**写入时定死**:归因字段不写就永远补不回来
 * (`docs/design/workspace-spaces-2026-08.md` 批 B「一期必须进的归因字段」)。
 * 会话缺席 / 缺 `workspaceId` 一律记 `'default'`,与所有读取端同一句缺省;
 * 聚合侧本切片一行不动(旧行没有这个字段,读侧照旧)。
 */
function resolveWorkspaceId(sessionId: string | undefined): string {
	if (!sessionId) return DEFAULT_SPACE_ID;
	return store.getSession(sessionId)?.workspaceId || DEFAULT_SPACE_ID;
}

let ledgerInstance: OnethingUsageLedger | null = null;

export function getUsageLedger(): OnethingUsageLedger {
	if (!ledgerInstance) throw new Error('Usage ledger is not bound to a backend');
	return ledgerInstance;
}

/** Bind one fixed store instance; an old release cannot detach its successor. */
export function configureUsageLedger(ledger: OnethingUsageLedger): () => void {
  if (ledgerInstance) throw new Error('Usage ledger is already bound to a backend')
  ledgerInstance = ledger
  return () => { if (ledgerInstance === ledger) ledgerInstance = null }
}

/** Capture before asynchronous work, so a late callback never resolves a newer binding. */
export function captureUsageRecorder(): (input: RecordUsageInput) => OnethingUsageLedgerRecord {
  const ledger = getUsageLedger()
  return input => recordUsageIn(ledger, input)
}

/**
 * Providers billed as a fixed-price subscription (no per-token invoice) have
 * their usage recorded at the same-model official API rate as a cost
 * *estimate*, tagged billing: 'subscription' so it is never summed into real
 * spend. Which providers those are is each provider's own manifest
 * (`billing: 'subscription'`, 批 M) — not a list kept here.
 */
export function resolveUsageBillingMode(providerId: string): OnethingUsageBillingMode {
	return isSubscriptionProvider(providerId) ? "subscription" : "api";
}

/**
 * Day/week/month summary with per-project totals. The project for a record is
 * its session's workingDirectory; quick chats and deleted sessions fall into
 * the unbound '' group.
 */
export async function getUsageSummaryWithProjects(
	ledger: Pick<OnethingUsageLedger, 'readRecordsInRange'>,
	request: OnethingUsageSummaryRequest,
): Promise<OnethingUsageSummaryResult> {
	return getOnethingUsageSummary(ledger, {
		...request,
		resolveProjectPath: (sessionId) => store.getSession(sessionId)?.workingDirectory,
	});
}

export interface SessionUsageTotal {
	apiCostUSD: number;
	subscriptionCostUSD: number;
	/** 本会话里厂商报价的合计(USD);没有任何一条带报价时为 0。 */
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

/** Total cost/usage for one session, for a live in-session readout (not the day/week/month settings panel). */
export async function getSessionUsageTotal(sessionId: string): Promise<SessionUsageTotal> {
	const total = await getOnethingSessionUsageTotal(getUsageLedger(), sessionId);
	return {
		apiCostUSD: total.apiCostUSD,
		subscriptionCostUSD: total.subscriptionCostUSD,
		providerCostUSD: total.providerCostUSD ?? 0,
		turnCount: total.turnCount,
		usage: {
			inputTokens: total.usage.input,
			outputTokens: total.usage.output,
			cacheReadTokens: total.usage.cacheRead,
			cacheWriteTokens: total.usage.cacheWrite,
			reasoningTokens: total.usage.reasoning,
			totalTokens: total.usage.total,
		},
	};
}

/** Single entry point for billing: builds the ledger record and queues it for append. */
export function recordUsage(input: RecordUsageInput): OnethingUsageLedgerRecord {
  return recordUsageIn(getUsageLedger(), input)
}

function recordUsageIn(ledger: OnethingUsageLedger, input: RecordUsageInput): OnethingUsageLedgerRecord {
  ledger.assertWritable()
	const capability = getModelCapabilityEntry(input.modelId, input.providerId);
	const billing = resolveUsageBillingMode(input.providerId);
	return ledger.record({
		sessionId: input.sessionId,
		workspaceId: resolveWorkspaceId(input.sessionId),
		// 默认空间不写 credentialId(诚实缺席):它的凭证源是 settings.ai,
		// 那里没有 entry id —— 造一个假值只会污染将来的按 key 出账。
		credentialId: 'credentialId' in input ? input.credentialId : resolveSessionCredentialId(input.sessionId, input.providerId),
		providerId: input.providerId,
		modelId: input.modelId,
		platform: resolvePlatform(input),
		source: input.source,
		billing,
		usage: {
			input: input.usage.inputTokens,
			output: input.usage.outputTokens,
			total: input.usage.totalTokens,
			cacheRead: input.usage.cacheReadTokens,
			cacheWrite: input.usage.cacheWriteTokens,
			reasoning: input.usage.reasoningTokens,
		},
		unitPrice: capability?.pricing,
		// 厂商报价与本地价目并存(设计稿 §10 决策 3):`unitPrice` 照旧算
		// `costUSD`,厂商值另存一格,永不互相覆盖。没报的家一个字节都不变。
		providerCostUSD: input.usage.providerCostUSD,
		partial: input.partial,
	});
}
