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

export interface SessionTocTaskPorts {
	runTask<T>(label: string, run: () => T | Promise<T>): Promise<T>;
	assertAccepting(sessionId: string): void;
}

/** This instance owns both idle timers and every accepted asynchronous write. */
export function createSessionTocTrigger(ports: SessionTocTaskPorts) {
	const pendingTimers = new Map<string, NodeJS.Timeout>();
	const active = new Map<Promise<void>, { sessionId: string; abort: AbortController }>();
	const failures = new Map<string, unknown[]>();
	let stopped = false;

	function cancelSession(sessionId: string): void {
		const timer = pendingTimers.get(sessionId);
		if (timer) clearTimeout(timer);
		pendingTimers.delete(sessionId);
		for (const task of active.values()) if (task.sessionId === sessionId) task.abort.abort();
	}
	/**
	 * 取走（而不是读取）匹配的失败记录。
	 *
	 * 工单 4 A2：这张表从前**只增不清** —— 一次写盘失败之后，这个会话的每一次
	 * 删除、以及此后每一次关机，都会把同一条陈年错误再抛一遍。失败是「这一次
	 * 排空没干净」的证据，报过一次就该销账；它不是会话的永久属性。
	 */
	function takeFailures(sessionId?: string): unknown[] {
		const matched = [...failures].filter(([id]) => sessionId === undefined || sessionId === id);
		for (const [id] of matched) failures.delete(id);
		return matched.flatMap(([, errors]) => errors);
	}
	async function drain(sessionId?: string): Promise<void> {
		while ([...active.values()].some(task => sessionId === undefined || task.sessionId === sessionId)) {
			await Promise.allSettled([...active].filter(([, task]) => sessionId === undefined || task.sessionId === sessionId).map(([work]) => work));
		}
		const errors = takeFailures(sessionId);
		if (!errors.length) return;
		if (sessionId !== undefined) {
			// 删一个会话是用户动作，不该被这个会话上一轮的写盘失败挡住 —— 目录马上
			// 就要没了，那条大纲写不写得进去已经不重要。失败进日志，删除照做。
			log.error('session toc task failed before this session was dropped', { sessionId, count: errors.length }, errors[0] as Error);
			return;
		}
		// 关机这一路仍然如实上抛：排空没干净，拥有者有权知道。因为上面已经销账，
		// 同一批失败只报一次。
		throw new AggregateError(errors, 'Session TOC task failed');
	}

	function scheduleTocRun(ctx: TriggerContext, pending: PendingTurn): void {
		if (stopped) return;
		ports.assertAccepting(ctx.sessionId);
		const key = ctx.sessionId;
		const existing = pendingTimers.get(key);
		if (existing) clearTimeout(existing);

		const timer = setTimeout(() => {
			pendingTimers.delete(key);
			if (stopped) return;
			const abort = new AbortController();
			// 交回「这一趟到底写没写盘」：一次成功写盘就把这个会话的旧失败销账
			// （工单 4 A2）。陈旧检查那条早退**不算**写盘 —— 它什么都没落地，销不了账。
			let wrote: Promise<boolean>;
			try { wrote = ports.runTask(`session-toc:${key}`, async () => {
				abort.signal.throwIfAborted();
				ports.assertAccepting(key);
				// Stale check: another turn started after this timer was armed, and
				// that turn armed its own. Segmenting against the older turn would
				// describe work that has already moved on.
				const newest = lastAssistantMessage(ctx.sessionId);
				if (!newest || newest.id !== pending.assistantMessageId) return false;

				const turnStartedAt = pending.previousTurnEndedAt ?? 0;
				const files = await filesForTurn(ctx.sessionId, turnStartedAt);
				abort.signal.throwIfAborted();
				ports.assertAccepting(key);
				// Explicit undefined checks: a timestamp of 0 is a legitimate value
				// and a truthiness test would silently drop the away signal for it.
				const awayMinutes =
					pending.previousTurnEndedAt !== undefined && newest.timestamp !== undefined
						? Math.max(0, (newest.timestamp - pending.previousTurnEndedAt) / 60_000)
						: undefined;

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
					}, { signal: abort.signal });
					return true;
			}); } catch (error) { wrote = Promise.reject(error); }
			// 失败由下面那个 handler 负责；这一份只是排空用的句柄，两处都不许漏接。
			const work = wrote.then(() => undefined, () => undefined);
			active.set(work, { sessionId: key, abort });
			void wrote.then(didWrite => { active.delete(work); if (didWrite) failures.delete(key); }, error => {
				active.delete(work);
				// Cancellation is expected. Disk or other failures remain part of the
				// lifetime record so deletion/shutdown cannot report a clean drain.
				if (abort.signal.aborted && error instanceof Error && error.name === 'AbortError') return;
				failures.set(key, [...(failures.get(key) ?? []), error]);
				log.error('session toc segmentation failed', { sessionId: key }, error);
			});
		}, TOC_IDLE_DELAY_MS);

		timer.unref?.();
		pendingTimers.set(key, timer);
	}

	const trigger: Trigger = {
		id: "session-toc",
		name: "Session TOC",
		// Last: this only schedules a timer, but it should never sit in front of
		// a trigger that actually drives the conversation forward.
		priority: 2000,
		shouldTrigger: async (ctx: TriggerContext) => Boolean(ctx.sessionId),
		execute: async (ctx: TriggerContext) => {
			if (stopped) return;
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
	function stop(): void {
		stopped = true;
		for (const timer of pendingTimers.values()) clearTimeout(timer);
		pendingTimers.clear();
		for (const task of active.values()) task.abort.abort();
	}
	return Object.assign(trigger, {
		stop,
		/** `Quiescible` 的那一半:关机链读的是这个名字,`stop()` 留给既有调用方。 */
		quiesce: stop,
		drain: () => drain(),
		async abortAndDrain(sessionId: string): Promise<void> {
			cancelSession(sessionId);
			await drain(sessionId);
		},
	});
}
