/**
 * Billing helpers for side-line model calls.
 *
 * The main chat turn bills itself from the agent-loop executor, but every
 * other model call the app makes on the user's behalf — title generation,
 * memory capture/review, skill review — historically never reached the ledger
 * at all. That made a whole category of spend invisible: these run on the
 * tool-call model, in the background, without any UI showing they happened.
 *
 * Each helper returns a callback so the call sites stay one line, and each one
 * swallows its own errors: billing must never break the work it is measuring.
 */
import { ONETHING_USAGE_SOURCES } from "@onething/runtime/usage";
import { recordUsage } from "./index.js";
import { getLogger } from '../logging/index.js'

const log = getLogger('usage')


export interface SideLineUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
}

function bill(
	label: string,
	source: string,
	providerId: string,
	modelId: string,
	sessionId?: string,
): (usage: SideLineUsage) => void {
	return (usage) => {
		try {
			recordUsage({ sessionId, providerId, modelId, source, usage });
		} catch (error) {
			log.error("record usage failed", { label, providerId, modelId, source, sessionId }, error);
		}
	};
}

/** Session title generation (runs once per session, on the tool-call model). */
export function billTitleUsage(
	providerId: string,
	modelId: string,
	sessionId?: string,
): (usage: SideLineUsage) => void {
	return bill("title", ONETHING_USAGE_SOURCES.title, providerId, modelId, sessionId);
}

/**
 * Context compaction summary — one call per chunk on the session model.
 *
 * Until 2026-08-15 this call reached no ledger at all: a compaction of a
 * 100k-token session was a five-figure input bill that never showed up in the
 * usage panel. Same helper shape as the rest so the call site stays one line.
 */
export function billCompactUsage(
	providerId: string,
	modelId: string,
	sessionId?: string,
): (usage: SideLineUsage) => void {
	return bill("context compact", ONETHING_USAGE_SOURCES.compact, providerId, modelId, sessionId);
}

/** Session TOC segmentation — one call per substantive turn. */
export function billTocUsage(
	providerId: string,
	modelId: string,
	sessionId?: string,
): (usage: SideLineUsage) => void {
	return bill("session toc", ONETHING_USAGE_SOURCES.toc, providerId, modelId, sessionId);
}

/** Room response-willingness judgement — one small call per member, per message. */
export function billCollabWillingnessUsage(
	providerId: string,
	modelId: string,
	sessionId?: string,
): (usage: SideLineUsage) => void {
	return bill(
		"collab willingness",
		ONETHING_USAGE_SOURCES.collabWillingness,
		providerId,
		modelId,
		sessionId,
	);
}

/**
 * 房间编排 —— 一条用户消息一次(collab-coordinator-plan.md)。
 *
 * 与 `collab-willingness` 此消彼长:一个是 O(1)/条,一个是 O(N)/条。两条线在
 * 用量面板里并排,换算法省了多少才有得看。
 */
export function billCollabPlanUsage(
	providerId: string,
	modelId: string,
	sessionId?: string,
): (usage: SideLineUsage) => void {
	return bill(
		"collab plan",
		ONETHING_USAGE_SOURCES.collabPlan,
		providerId,
		modelId,
		sessionId,
	);
}

/** Room daily digest — one call per room per folded day (collab-agent-view P2). */
export function billCollabDigestUsage(
	providerId: string,
	modelId: string,
	sessionId?: string,
): (usage: SideLineUsage) => void {
	return bill(
		"collab digest",
		ONETHING_USAGE_SOURCES.collabDigest,
		providerId,
		modelId,
		sessionId,
	);
}

/** The skill-review trigger's agent loop. */
export function billSkillUsage(
	providerId: string,
	modelId: string,
	sessionId?: string,
): (usage: SideLineUsage) => void {
	return bill("skill review", ONETHING_USAGE_SOURCES.skill, providerId, modelId, sessionId);
}

/** A pet line written by the tool-call model — one call per spoken moment (pet P4 §11.2). No session. */
export function billPetUsage(
	providerId: string,
	modelId: string,
): (usage: SideLineUsage) => void {
	return bill("pet line", ONETHING_USAGE_SOURCES.pet, providerId, modelId);
}
