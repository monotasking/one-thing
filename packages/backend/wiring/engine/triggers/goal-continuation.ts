/**
 * Cross-run goal continuation.
 *
 * In-run continuation (afterTurn in the agent-loop runtime) is bounded by
 * maxTurns, so a long-running goal usually ends its run with
 * finishReason 'max_turns' while still active. This post-response trigger
 * re-drives the engine with a fresh send-message command carrying the
 * continuation prompt.
 *
 * Safety properties:
 * - Post-response hooks only run on the success path, so an errored or
 *   aborted run never re-drives (those runs also trip the goal breakers).
 * - A run that ended normally with a continuable goal was already continued
 *   in-run by afterTurn; the only way to get here with an active continuable
 *   goal is the max_turns cut. Every re-drive still counts against
 *   continuationCount, so the cap bounds in-run and cross-run pushes
 *   together.
 * - The re-drive command (envelope, channel preservation, folding origin)
 *   is owned by emitGoalDrive in src/main/goals/kick.ts — shared with the
 *   idle kick so the two drive paths cannot drift.
 */
import { canAutoContinueGoal } from "@onething/runtime/goals";
import {
	getGoal,
	goalLimits,
	tryBeginContinuation,
} from "../../goals/index.js";
import { emitGoalDrive } from "../../goals/kick.js";
import type { Trigger, TriggerContext } from "./index.js";

export function createGoalContinuationTrigger(): Trigger {
	return {
		id: "goal-continuation",
		name: "Goal Continuation",
		priority: 100, // After skill review, before the eval recorder
		shouldTrigger: async (ctx: TriggerContext): Promise<boolean> => {
			const goal = getGoal(ctx.sessionId);
			return canAutoContinueGoal(goal, goalLimits());
		},
		execute: async (ctx: TriggerContext): Promise<void> => {
			const goal = tryBeginContinuation(ctx.sessionId);
			if (!goal) return;
			await emitGoalDrive(ctx.sessionId, goal);
		},
	};
}
