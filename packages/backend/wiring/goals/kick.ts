/**
 * Driving a goal run. `emitGoalDrive` is the single place that builds the
 * goal-drive command — the idle kick (goal create/resume, transient-error
 * retry) and the cross-run continuation trigger both go through it, so the
 * envelope invariants live in exactly one spot:
 *
 * - source 'goal' marks the message system-internal: the stream engine
 *   routes it without channel-identity resolution (it must land back in the
 *   goal's own session), counterpart-identity scans skip its origin, and
 *   the renderer folds it into a compact continuation line.
 * - `channel` must be the session's real transport channel. Permission
 *   requests remember the channel active when they were asked and reject
 *   responses from any other channel — stamping a synthetic value here
 *   would make every permission prompt raised during the run reject the
 *   user's real approval as "wrong channel". The engine's in-memory channel
 *   entry is deleted whenever a run ends (and kicks fire exactly when no
 *   run is active), so the live lookup alone would always fall back to
 *   'ipc'; gateway sessions persist their connector on the session
 *   (lastConnector, written by the identity router), which takes over when
 *   the live value carries no information.
 *
 * Drives are not recorded as automatic continuations — they are user- or
 * system-initiated turns the continuation allowance counts from.
 */
import { renderGoalContinuationPrompt } from "@onething/runtime/goals";
import type { SessionGoal } from "@onething/runtime/goals";
import { getStreamEngineSafe } from "../engine/index.js";
import { getEventBus } from "../../events/index.js";
import * as store from "../../store.js";
import { getGoal, goalLimits } from "./index.js";

import { SESSION_COMMAND_TYPES } from "@shared/events/index.js";
import { getLogger } from '../logging/index.js'

const log = getLogger('goals')


function goalRunChannel(sessionId: string): string | undefined {
	const live = getStreamEngineSafe()?.getChannel(sessionId);
	// 'ipc' is also getChannel's no-entry fallback, so it carries no signal;
	// prefer the session's persisted connector in that case.
	if (live && live !== "ipc") return live;
	return store.getSession(sessionId)?.lastConnector || live;
}

/** Collab sessions are coordinator-owned: a goal drive would bypass the room
 *  coordinator (activation reasons, chain gate) or re-drive a harvested work
 *  session — docs/design/multi-agent-collab.md P0 门控. */
function isCollabSession(sessionId: string): boolean {
	const kind = store.getSession(sessionId)?.kind;
	// 'agent' (W18): an agent's execution session is driven by the coordinator
	// too — a goal drive there would speak into a room behind its back.
	return kind === "room" || kind === "work" || kind === "agent";
}

export async function emitGoalDrive(
	sessionId: string,
	goal: SessionGoal,
): Promise<void> {
	if (isCollabSession(sessionId)) return;
	try {
		await getEventBus().emit(sessionId, {
			type: SESSION_COMMAND_TYPES.SEND_MESSAGE,
			channel: goalRunChannel(sessionId),
			content: renderGoalContinuationPrompt(goal, goalLimits()),
			source: "goal",
			origin: { transport: "api", source: "goal", receivedAt: Date.now() },
		});
	} catch (error) {
		log.error("start goal run failed", { sessionId }, error);
	}
}

export function kickGoalRunIfIdle(sessionId: string, goal?: SessionGoal): Promise<void> | undefined {
	if (isCollabSession(sessionId)) return;
	const target = goal ?? getGoal(sessionId);
	if (!target || target.status !== "active") return;
	if (getStreamEngineSafe()?.getController(sessionId)) return;
	return emitGoalDrive(sessionId, target);
}
