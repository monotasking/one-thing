/**
 * Post-response trigger that keeps the session's table of contents current.
 *
 * Deferred, never inline. `CoreTriggerManager.runPostResponse` awaits its
 * triggers in series, so doing a model call here synchronously would stretch
 * every turn's teardown — the user sees "finished replying but still spinning".
 * The work is handed to a timer instead, using an idle pattern:
 * the timer is re-armed on each response, and on firing it re-checks that the
 * assistant message it was armed for is still the newest one. The second check
 * is what makes it safe if a clearTimeout is ever missed.
 */
import { collectGoalFileChanges } from "../../goals/file-changes.js";
import { recordTocTurn } from "../../toc/index.js";
import { sessionReads } from "../../../session/reads.js";
import type { Trigger, TriggerContext } from "./index.js";
import { getLogger } from '../../logging/index.js'

const log = getLogger('engine.triggers')


/**
 * How long the session must stay quiet before segmenting. Short enough that a
 * user pausing to read gets an up-to-date outline; long enough that a rapid
 * back-and-forth collapses into one call instead of one per turn.
 */
const TOC_IDLE_DELAY_MS = 45 * 1000;

const pendingTimers = new Map<string, NodeJS.Timeout>();

interface PendingTurn {
	assistantMessageId: string;
	userMessage: string;
	assistantReply: string;
	reasoning?: string;
	toolIterations: number;
	workingDirectory?: string;
	/** When the previous turn's work finished, for the away-time signal. */
	previousTurnEndedAt?: number;
}

function lastAssistantMessage(
	sessionId: string,
): { id?: string; timestamp?: number; reasoning?: string } | undefined {
	return sessionReads.lastMessageOfRole(sessionId, "assistant");
}

/**
 * Files this turn changed, from the mutation audit trail rather than the
 * message log — the audit records carry sessionId and messageId, so this is
 * exact and needs no parsing of tool calls.
 */
async function filesForTurn(sessionId: string, sinceMs: number) {
	try {
		return await collectGoalFileChanges(sessionId, sinceMs);
	} catch {
		return [];
	}
}

function scheduleTocRun(ctx: TriggerContext, pending: PendingTurn): void {
	const key = ctx.sessionId;
	const existing = pendingTimers.get(key);
	if (existing) clearTimeout(existing);

	const timer = setTimeout(() => {
		pendingTimers.delete(key);
		void (async () => {
			// Stale check: another turn started after this timer was armed, and
			// that turn armed its own. Segmenting against the older turn would
			// describe work that has already moved on.
			const newest = lastAssistantMessage(ctx.sessionId);
			if (!newest || newest.id !== pending.assistantMessageId) return;

			const turnStartedAt = pending.previousTurnEndedAt ?? 0;
			const files = await filesForTurn(ctx.sessionId, turnStartedAt);
			// Explicit undefined checks: a timestamp of 0 is a legitimate value
			// and a truthiness test would silently drop the away signal for it.
			const awayMinutes =
				pending.previousTurnEndedAt !== undefined && newest.timestamp !== undefined
					? Math.max(0, (newest.timestamp - pending.previousTurnEndedAt) / 60_000)
					: undefined;

			try {
				await recordTocTurn({
					sessionId: ctx.sessionId,
					assistantMessageId: pending.assistantMessageId,
					userMessage: pending.userMessage,
					assistantReply: pending.assistantReply,
					reasoning: pending.reasoning,
					toolIterations: pending.toolIterations,
					files,
					workingDirectory: pending.workingDirectory,
					timestamp: newest.timestamp ?? Date.now(),
					awayMinutes,
				});
			} catch (error) {
				log.error("session toc segmentation failed", { sessionId: ctx.sessionId }, error);
			}
		})();
	}, TOC_IDLE_DELAY_MS);

	timer.unref?.();
	pendingTimers.set(key, timer);
}

export function createSessionTocTrigger(): Trigger {
	return {
		id: "session-toc",
		name: "Session TOC",
		// Last: this only schedules a timer, but it should never sit in front of
		// a trigger that actually drives the conversation forward.
		priority: 2000,
		shouldTrigger: async (ctx: TriggerContext) => Boolean(ctx.sessionId),
		execute: async (ctx: TriggerContext) => {
			const newest = lastAssistantMessage(ctx.sessionId);
			if (!newest?.id) return;

			// The previous assistant message marks when the last turn's work
			// ended — the basis for "how long was the user away", which must be
			// measured from the agent finishing, not from the previous user
			// message (an agent can work for hours on one instruction).
			const previousAssistant = sessionReads.findMessage(
				ctx.sessionId,
				(message) => message.role === "assistant" && message.id !== newest.id,
				{ from: "end" },
			);

			scheduleTocRun(ctx, {
				assistantMessageId: newest.id,
				userMessage: ctx.lastUserMessage,
				assistantReply: ctx.lastAssistantMessage,
				reasoning: newest.reasoning,
				toolIterations: ctx.toolIterations ?? 0,
				workingDirectory: ctx.session?.workingDirectory,
				previousTurnEndedAt: previousAssistant?.timestamp,
			});
		},
	};
}
