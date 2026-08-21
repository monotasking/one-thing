import type { TriggerContext, Trigger } from "./index.js";
import { getSkillsForSession } from "../../wiring/skills/session-skills.js";
import * as store from "../../store.js";
import { getLogger } from '../../wiring/logging/index.js'

const log = getLogger('engine.triggers')


/**
 * Distribution-sampling rate for NORMAL turns (settings.evals.sampleRate).
 * Off unless explicitly configured — negative-signal capture alone only
 * sees failures the user noticed.
 */
function getEvalsSampleRate(): number {
	try {
		const rate = (store.getSettings() as { evals?: { sampleRate?: unknown } })
			?.evals?.sampleRate;
		return typeof rate === "number" && rate > 0 && rate <= 1 ? rate : 0;
	} catch {
		return 0;
	}
}

interface TurnEvalContext {
	turnId: string;
	lastUserMessage: string;
	sessionId: string;
	providerId: string;
	model: string;
	toolErrors: number;
	workingDirectory?: string;
	workingDirectoryRoots?: string[];
	enabledToolNames?: string[];
	streamAborted: boolean;
	lastAssistantMsg?: {
		id?: string;
		content?: unknown;
		toolCalls?: Array<{
			toolName?: string;
			arguments?: Record<string, unknown>;
		}>;
	};
}

function collectContext(ctx: TriggerContext): TurnEvalContext {
	// Check if the stream ended abnormally by inspecting messages
	// An aborted stream typically has an assistant message without content
	const lastAssistantMsg = ctx.messages
		.filter(
			(m: {
				role: string;
				content?: unknown;
				toolCalls?: Array<{ status: string }>;
				id?: string;
			}) => m.role === "assistant",
		)
		.slice(-1)[0];
	const streamAborted = !!(lastAssistantMsg && !lastAssistantMsg.content);

	// Count actual tool failures in this turn (status === 'failed'), not tool
	// iteration count — a long chain of successful tool calls is not a failure.
	const toolErrors = (lastAssistantMsg?.toolCalls ?? []).filter(
		(call: { status: string }) => call.status === "failed",
	).length;

	// Prefer the real per-message id so records/fixtures are addressable per
	// turn, not collapsed onto the whole session; fall back to a synthetic id
	// only if no assistant message was persisted for this turn.
	const turnId = lastAssistantMsg?.id ?? `${ctx.sessionId}-${Date.now()}`;

	return {
		turnId,
		lastUserMessage: ctx.lastUserMessage,
		sessionId: ctx.sessionId,
		providerId: ctx.providerId,
		model: ctx.providerConfig?.model ?? "unknown",
		toolErrors,
		workingDirectory: ctx.session.workingDirectory,
		workingDirectoryRoots: ctx.session.workingDirectoryRoots,
		enabledToolNames: ctx.enabledToolNames,
		streamAborted,
		lastAssistantMsg,
	};
}

/**
 * Post-chat trigger that records turn evaluation data.
 *
 * Phase 1 of the prompt evaluation system:
 * - Aggregates implicit signals from the turn (tool errors, stream aborts)
 * - Writes records to ~/.onething/evals/online/records.jsonl
 * - Auto-exports fixtures for turns with negative signals
 *
 * Note on retried/editResent signals:
 * These occur AFTER turn end. Integration points:
 * 1. In command:retry-message handler → call amendTurnRetry()
 * 2. In command:edit-and-resend handler → call amendTurnEditResend()
 * 3. In permission:request denied handler → call amendTurnPermissionDenied()
 * These amends write JSONL amend records that get merged when reading
 * the online records file.
 */
export function createTurnEvaluationTrigger(): Trigger {
	return {
		id: "turn-evaluation",
		name: "Turn Evaluation Recorder",
		priority: 1000, // Run last, after other triggers
		shouldTrigger: async (_ctx: TriggerContext): Promise<boolean> => true,
		execute: async (ctx: TriggerContext): Promise<void> => {
			try {
				const evalCtx = collectContext(ctx);
				// Dynamic import to avoid circular dependency at module load time
				const {
					recordTurn,
					getPromptVersion,
					getSkeletonVersion,
					versionFromSections,
					promptCaptureCache,
				} = await import("@onething/runtime");

				// Load actual skills for fixture context
				const skills = getSkillsForSession(evalCtx.workingDirectory);

				// Compute session-level promptVersion and sectionHashes from promptCapture
				const promptCapture = ctx.promptCapture;
				const sections = promptCapture?.sections ?? [];
				const sectionHashes =
					sections.length > 0
						? (promptCapture?.sectionHashes ?? {})
						: undefined;
				const promptVersion =
					sections.length > 0
						? versionFromSections(sections)
						: getPromptVersion();
				const skeletonVersion = getSkeletonVersion();

				// Store prompt capture in the LRU (fast path) AND the disk ring
				// (Route B: survives restarts, ~200 turns) so late-arriving
				// negative signals (👎, retry) can still materialize the verbatim
				// prompt/tools/params — the parts the session jsonl can't rebuild.
				if (promptCapture) {
					promptCaptureCache.set(evalCtx.turnId, promptCapture);
					import("@onething/runtime")
						.then(({ saveCaptureToDisk }) =>
							saveCaptureToDisk(evalCtx.turnId, promptCapture),
						)
						.catch(() => {});
				}

				// Full scenes are persisted ONLY for turns that are negative at
				// turn end (design D2) — as an incident bundle (workbench W1),
				// which replaces the old four-piece snapshot files. Normal turns
				// keep the capture in the LRU; a late retry/👎 creates the
				// incident then.
				const negativeAtTurnEnd =
					evalCtx.toolErrors > 0 || evalCtx.streamAborted;
				const snapshotMaxBytes = (
					ctx.settings as { evals?: { snapshotMaxBytes?: number } } | undefined
				)?.evals?.snapshotMaxBytes;

				let incidentRef: string | null = null;
				if (promptCapture && negativeAtTurnEnd) {
					const { createIncidentBundle, extractTurnTrace } = await import(
						"@onething/runtime"
					);
					const turnTrace = extractTurnTrace(
						ctx.messages as Parameters<typeof extractTurnTrace>[0],
						evalCtx.turnId,
					);
					const bundle = createIncidentBundle({
						origin: "auto",
						sessionId: evalCtx.sessionId,
						turnId: evalCtx.turnId,
						provider: evalCtx.providerId,
						model: evalCtx.model,
						userMessage: evalCtx.lastUserMessage,
						assistantText:
							typeof evalCtx.lastAssistantMsg?.content === "string"
								? evalCtx.lastAssistantMsg.content
								: "",
						signals: {
							toolErrors: evalCtx.toolErrors,
							streamAborted: evalCtx.streamAborted,
						},
						promptCapture,
						turnTrace,
						fixtureContext: {
							workingDirectory: evalCtx.workingDirectory,
							workingDirectoryRoots: evalCtx.workingDirectoryRoots,
							skills: skills
								.filter((s) => s.enabled !== false)
								.map((s) => ({
									name: s.name,
									description: s.description,
									source: s.source,
									category: s.category,
									enabled: s.enabled,
									path: s.path,
								})),
							toolNames: evalCtx.enabledToolNames ?? [],
							hasTools: (evalCtx.enabledToolNames?.length ?? 0) > 0,
							platform: process.platform,
						},
						skeletonVersion,
						contextMaxBytes: snapshotMaxBytes,
						storeOptions: {},
					});
					incidentRef = bundle.incidentId;
				}

				// Build assistantResponse from last assistant message
				const lastMsg = evalCtx.lastAssistantMsg;
				const assistantResponse =
					lastMsg?.content != null
						? {
								content: String(lastMsg.content),
								toolCalls: lastMsg.toolCalls?.map((tc) => ({
									name: tc.toolName ?? "unknown",
									args: tc.arguments,
								})),
								finishReason: lastMsg.toolCalls?.length ? "tool_calls" : "stop",
							}
						: undefined;

				recordTurn({
					turnId: evalCtx.turnId,
					sessionId: evalCtx.sessionId,
					promptVersion,
					skeletonVersion,
					sectionHashes,
					providerId: evalCtx.providerId,
					model: evalCtx.model,
					signals: {
						toolErrors: evalCtx.toolErrors,
						streamAborted: evalCtx.streamAborted,
					},
					workingDirectory: evalCtx.workingDirectory,
					workingDirectoryRoots: evalCtx.workingDirectoryRoots,
					skills,
					toolNames: evalCtx.enabledToolNames,
					hasTools: (evalCtx.enabledToolNames?.length ?? 0) > 0,
					userMessage: evalCtx.lastUserMessage,
					assistantResponse,
					incidentRef,
					randomSampleRate: getEvalsSampleRate(),
					storeOptions: {},
				});
			} catch (error) {
				// Silently ignore evaluation errors - they should never break the chat flow
				log.error("record turn evaluation failed", {}, error);
			}
		},
	} as Trigger;
}
