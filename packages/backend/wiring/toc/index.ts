/**
 * Session TOC — maintains the intent segments behind each session.
 *
 * Runs one small model call per substantive turn on the tool-call model, and
 * revises the current segment in place rather than accumulating notes, so the
 * entry always reads as the work's current state (docs/design/session-toc.md).
 *
 * Everything here is best-effort: a failure loses one segment revision, never
 * the turn that produced it.
 */
import { randomUUID } from "node:crypto";
import { runAgentLoop } from "@onething/core/agent-loop";
import {
	applyTurnDecision,
	buildTocPrompt,
	createSessionSegmentStore,
	isTrivialTurn,
	openSegmentOf,
	parseTocDecision,
	renderTocTurnSystemPrompt,
	type SessionSegment,
	type SessionSegmentFile,
} from "@onething/runtime/toc";
import {
  getOnethingSessionsDir,
} from '@onething/runtime/storage'
import { createUtilityProvider } from "../../providers/utility-provider.js";
import { billTocUsage } from "../usage/bill-side-line.js";
import { getSettings } from "../../stores/settings.js";
import { consolePort, getLogger } from '../logging/index.js'

const tocLog = getLogger('sessions.toc')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog = consolePort(tocLog)


const segmentStore = createSessionSegmentStore({ getSessionsDir: getOnethingSessionsDir, logger: consoleLog });

/** Ceiling on one segmentation call. */
const TOC_CALL_TIMEOUT_MS = 60_000;

/**
 * Every early return says why. This runs unattended and its only visible
 * output is a file appearing (or not) — without a reason in the log, a silent
 * failure is indistinguishable from the feature being switched off.
 */
function log(message: string): void {
	tocLog.debug("session toc", { detail: message });
}

export function readSessionSegments(sessionId: string): Promise<SessionSegment[]> {
	return segmentStore.read(sessionId);
}

export function clearSessionSegments(sessionId: string): Promise<void> {
	return segmentStore.clear(sessionId);
}

export interface TocTurnContext {
	sessionId: string;
	assistantMessageId: string;
	userMessage: string;
	assistantReply: string;
	reasoning?: string;
	toolIterations: number;
	files: SessionSegmentFile[];
	workingDirectory?: string;
	timestamp: number;
	awayMinutes?: number;
}

/**
 * Runs the per-turn segmentation. Returns the segments it wrote, or undefined
 * when the turn was skipped for free (trivial turn, or no tool-call model
 * configured — the feature is off in that case rather than silently borrowing
 * the chat model).
 */
export async function recordTocTurn(
	context: TocTurnContext,
): Promise<SessionSegment[] | undefined> {
	if (
		isTrivialTurn({
			userMessage: context.userMessage,
			toolIterations: context.toolIterations,
			fileCount: context.files.length,
		})
	) {
		log("skipped: turn too slight (no tools, no files, short message)");
		return undefined;
	}

	const settings = getSettings();
	const utility = await createUtilityProvider(settings, {
		workingDirectory: context.workingDirectory,
		sessionId: context.sessionId,
	});
	if (!utility) {
		log("skipped: no tool-call model configured (settings.tools.toolCallModel)");
		return undefined;
	}

	const existing = await segmentStore.read(context.sessionId);
	const open = openSegmentOf(existing);

	const prompt = buildTocPrompt({
		userMessage: context.userMessage,
		assistantReply: context.assistantReply,
		reasoning: context.reasoning,
		files: context.files.map((file) => file.path),
		currentSegment: open
			? {
					title: open.title,
					detail: open.detail,
					kind: open.kind,
					files: open.files.map((file) => file.path),
				}
			: undefined,
		awayMinutes: context.awayMinutes,
	});

	// A hung request would otherwise leave the segment silently missing with
	// nothing in the log to say why.
	const abort = new AbortController();
	const timeout = setTimeout(() => abort.abort(), TOC_CALL_TIMEOUT_MS);

	let result: Awaited<ReturnType<typeof runAgentLoop>>;
	try {
		result = await runAgentLoop({
			provider: utility.provider,
			model: utility.model,
			messages: [
				{ role: "system", content: renderTocTurnSystemPrompt() },
				{ role: "user", content: prompt.text },
			],
			tools: [],
			selectedToolNames: [],
			maxTurns: 1,
			temperature: 0.1,
			// A title plus one sentence needs ~100. The headroom is for a
			// provider that ignores the thinking flag below and still spends
			// some of the budget in the reasoning channel.
			maxTokens: 500,
			// Unconditionally off, regardless of the tool-call model's own toggle:
			// a hybrid reasoner left to its server default burns the entire
			// 200-token budget in the reasoning channel and returns empty text —
			// field-hit 2026-07-20: deepseek-v4-flash billed exactly 200 output
			// tokens on every TOC call while text came back "".
			thinking: "disabled",
			sessionId: context.sessionId,
			messageId: `toc:${context.assistantMessageId}`,
			workingDirectory: context.workingDirectory,
			abortSignal: abort.signal,
		});
	} catch (error) {
		log(
			abort.signal.aborted
				? `model call timed out after ${TOC_CALL_TIMEOUT_MS}ms`
				: `model call failed: ${String(error)}`,
		);
		return undefined;
	} finally {
		clearTimeout(timeout);
	}

	if (result.usage) {
		billTocUsage(utility.providerId, utility.model, context.sessionId)(result.usage);
	}

	const decision = parseTocDecision(result.text ?? "", {
		hasCurrentSegment: Boolean(open),
	});
	if (!decision) {
		// The raw reply matters here: a small model ignoring the JSON-only
		// instruction is the likeliest cause, and without seeing what it said
		// there is no way to tell that from an empty response.
		log(
			`unparseable reply, segment skipped: ${JSON.stringify((result.text ?? "").slice(0, 300))}` +
				` (output tokens: ${result.usage?.outputTokens ?? "?"} — at the 200 cap this means the model spent the budget reasoning/narrating, not answering)`,
		);
		return undefined;
	}

	const next = applyTurnDecision(existing, {
		decision,
		messageId: context.assistantMessageId,
		timestamp: context.timestamp,
		files: context.files,
		newSegmentId: randomUUID(),
	});

	// Only the segments that actually changed need to be appended; the log is
	// folded on read, so writing untouched ones would be dead weight.
	const before = new Map(existing.map((segment) => [segment.id, segment]));
	const changed = next.filter((segment) => before.get(segment.id) !== segment);
	await segmentStore.append(context.sessionId, changed);

	log(
		`${decision.action}: ${JSON.stringify(decision.title)} ` +
			`(${changed.length} segment(s) written, ${next.length} total)`,
	);
	return changed;
}
