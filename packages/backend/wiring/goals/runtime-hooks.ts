/**
 * Engine-facing goal hooks: per-round accounting + continuation prompts for
 * the agent-loop runtime, and stream-lifecycle breakers (error → blocked,
 * abort → paused, complete → flush) wired through the EventBus so the stream
 * executor needs no goal knowledge.
 */
import {
	renderGoalBudgetLimitPrompt,
	renderGoalContinuationNudge,
} from "@onething/runtime/goals";
import type { OnethingAgentLoopGoalHooks } from "@onething/runtime/agent-loop";
import { getEventBus } from "../../events/index.js";
import {
	goalLimits,
	handleGoalAbort,
	handleGoalRunError,
	handleGoalRunSuccess,
	recordGoalUsage,
	tryBeginContinuation,
} from "./index.js";
import { kickGoalRunIfIdle } from "./kick.js";
import { GoalRetryScheduler } from './retry-scheduler.js'

import { SESSION_EVENT_TYPES } from "@shared/events/index.js";
import { getLogger } from '../logging/index.js'

const log = getLogger('goals')


// Wall-clock accounting: seconds between consecutive rounds of the same
// session approximate active time. Entries are dropped when a run ends.
const lastUsageTick = new Map<string, number>();
const MAX_TICK_GAP_SECONDS = 3600;

export const goalRuntimeHooks: OnethingAgentLoopGoalHooks = {
	recordUsage(sessionId, usage) {
		const now = Date.now();
		const last = lastUsageTick.get(sessionId);
		lastUsageTick.set(sessionId, now);
		const seconds =
			last !== undefined
				? Math.min((now - last) / 1000, MAX_TICK_GAP_SECONDS)
				: 0;
		const result = recordGoalUsage(sessionId, {
			tokens: usage.totalTokens ?? 0,
			seconds,
		});
		if (!result?.becameBudgetLimited) return undefined;
		return renderGoalBudgetLimitPrompt(result.goal, goalLimits());
	},

	beginContinuation(sessionId) {
		const goal = tryBeginContinuation(sessionId);
		if (!goal) {
			lastUsageTick.delete(sessionId);
			return undefined;
		}
		// In-run pushes use the short nudge: the full prompt (objective +
		// rules) was already seen this run, and repeating it verbatim made
		// models read the transcript as the user repeating themselves.
		return renderGoalContinuationNudge(goal, goalLimits());
	},
};

let bootstrapped = false;

/**
 * Subscribe the goal breakers to stream lifecycle events. Idempotent; called
 * once from main bootstrap alongside the other engine wiring.
 *
 * A3(方案 §2.5,(b) 类闩):返回 disposer,由 `assembleSteps` 的 `own()` 接住。
 * 五条订阅挂在**这一份装配的**总线上,而闩住在模块里 —— 从前 dispose 之后闩
 * 还是 true,第二份装配一条都不订阅,于是"目标续推"在第二份 backend 上静默
 * 消失(总线换了一条,而没有人往新的那条挂过)。disposer 摘订阅 + 放闩。
 */
export function bootstrapGoalStreamBreakers(): (() => void) & { quiesce(): void; drain(): Promise<void> } {
	if (bootstrapped) return Object.assign(() => {}, { quiesce() {}, async drain() {} });
	bootstrapped = true;
	const bus = getEventBus();
	const unsubscribes: Array<() => void> = [];
	const retries = new GoalRetryScheduler(kickGoalRunIfIdle, (sessionId, error) => log.error('goal retry kick failed', { sessionId }, error));
	const cancelGoalRetry = (sessionId: string) => retries.cancel(sessionId);
	const handleGoalStreamFailure = (sessionId: string, error: string) => {
		if (retries.has(sessionId)) return;
		const outcome = handleGoalRunError(sessionId, error);
		if (outcome?.willRetry) retries.schedule(sessionId, outcome.attempt);
	};

	// A new run supersedes any pending retry: whatever started it (user
	// message, retry kick, continuation) is now the goal's driver.
	unsubscribes.push(bus.onAnySession(
		SESSION_EVENT_TYPES.STREAM_START,
		({ sessionId }) => {
			cancelGoalRetry(sessionId);
		},
		"goal-breaker",
	));

	unsubscribes.push(bus.onAnySession(
		SESSION_EVENT_TYPES.STREAM_COMPLETE,
		({ sessionId, event }) => {
			lastUsageTick.delete(sessionId);
			try {
				if (event.data?.aborted) {
					cancelGoalRetry(sessionId);
					handleGoalAbort(sessionId);
				} else if (event.data?.error) {
					handleGoalStreamFailure(sessionId, event.data.error);
				} else {
					handleGoalRunSuccess(sessionId);
				}
			} catch (error) {
				log.error("goal stream:complete breaker failed", { sessionId }, error);
			}
		},
		"goal-breaker",
	));

	unsubscribes.push(bus.onAnySession(
		SESSION_EVENT_TYPES.STREAM_ERROR,
		({ sessionId, event }) => {
			lastUsageTick.delete(sessionId);
			try {
				handleGoalStreamFailure(sessionId, event.data?.error ?? "stream error");
			} catch (error) {
				log.error("goal stream:error breaker failed", { sessionId }, error);
			}
		},
		"goal-breaker",
	));

	unsubscribes.push(bus.onAnySession(
		SESSION_EVENT_TYPES.STREAM_ABORTED,
		({ sessionId }) => {
			lastUsageTick.delete(sessionId);
			try {
				cancelGoalRetry(sessionId);
				handleGoalAbort(sessionId);
			} catch (error) {
				log.error("goal stream:aborted breaker failed", { sessionId }, error);
			}
		},
		"goal-breaker",
	));

	// A permission prompt hands the clock to the user; drop the tick so the
	// approval wait is not billed as goal working time.
	unsubscribes.push(bus.onAnySession(
		SESSION_EVENT_TYPES.PERMISSION_REQUEST,
		({ sessionId }) => {
			lastUsageTick.delete(sessionId);
		},
		"goal-breaker",
	));

	let disposed = false;
	return Object.assign(() => {
		if (disposed) return;
		disposed = true;
		retries.quiesce();
		for (const unsubscribe of unsubscribes) unsubscribe();
		unsubscribes.length = 0;
		lastUsageTick.clear();
		bootstrapped = false;
	}, { quiesce: () => retries.quiesce(), drain: () => retries.drain() });
}
