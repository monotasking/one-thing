/**
 * Evals Runner (Core)
 *
 * Extracted from evals/run.mjs into the runtime package so both the CLI
 * (`bun evals/run.mjs`) and the desktop app (IPC → main process) reuse
 * the same builder and evaluation logic.
 *
 * The runner does NOT embed an HTTP client. Callers inject `callModel` —
 * CLI uses an OpenAI-compatible fetch; the desktop app uses the configured
 * provider stack.
 */

import fs from "node:fs";
import path from "node:path";
import { parseCaseYaml, type CaseDefinition } from "./case-file.js";
import { evaluate, type EvalResult } from "./evaluator.js";
import { getPromptVersion } from "./fixture.js";
import type { EvalModelCaller } from "./model-call.js";
import type { EvalFixture } from "./fixture.js";
import { attachTurnBlocksToLastUserMessage } from "../prompts/turn-delivery.js";

// ── Types ──────────────────────────────────────────────

/** Per-attempt result carried in progress events and run detail. */
export interface EvalRunCaseAttempt {
	index: number;
	pass: boolean;
	reason: string;
	/**
	 * True when the attempt never produced a judgeable response (network
	 * error, missing fixture, provider 4xx/5xx). Error attempts are excluded
	 * from the pass-rate denominator — an infra outage must not read as a
	 * behavioral failure and permanently depress a case's score history.
	 */
	error?: boolean;
}

/** Per-case detail carried in progress events and run detail. */
export interface EvalRunCaseDetail {
	score: number;
	caseId: string;
	attempts: EvalRunCaseAttempt[];
}

/** Cheap per-attempt economics, aggregated into the run entry. */
interface AttemptMetrics {
	outputChars: number;
	toolCalls: number;
	totalTokens?: number;
}

/** Outcome of one judgeable attempt (result + optional economics). */
interface CaseAttemptOutcome {
	result: EvalResult;
	metrics?: AttemptMetrics;
}

export interface EvalRunOptions {
	/** Path to the evals repo (contains cases/, fixtures/, results.jsonl). */
	repoDir: string;
	/** Specific case IDs to run (default: all active cases). */
	caseIds?: string[];
	/** Number of runs per case (default 5). */
	runs?: number;
	/** Prompt sections to disable for ablation testing. */
	disabledSections?: string[];
	/** Include sentinel cases. */
	includeSentinel?: boolean;
	/** Injected model caller. */
	callModel: EvalModelCaller;
	/** Provider label recorded into results.jsonl (e.g. "claude", "cli"). */
	providerLabel?: string;
	/** Model label recorded into results.jsonl (e.g. "gpt-4o-mini"). */
	modelLabel?: string;
	/**
	 * Append the entry to results.jsonl (default true). Meta-runs (section
	 * sensitivity audits, fidelity probes) set false so instrumentation runs
	 * never become baselines for later comparisons.
	 */
	persistResults?: boolean;
	/** Progress callback for UI streaming. */
	onProgress?: (event: EvalRunProgressEvent) => void;
	/** Abort signal for cancellation. */
	signal?: AbortSignal;
}

export interface EvalRunProgressEvent {
	type: "case-start" | "attempt-done" | "case-done" | "run-done" | "error";
	caseId?: string;
	attempt?: number;
	pass?: boolean;
	reason?: string;
	score?: number;
	totalCases?: number;
	completedCases?: number;
	entry?: EvalRunResultEntry;
	error?: string;
	/** Per-case per-attempt detail (run-done event only). Adapter decides persistence. */
	detail?: { cases: Record<string, EvalRunCaseDetail> };
}

export interface EvalRunResultEntry {
	ts: string;
	promptVersion: string;
	provider: string;
	model?: string;
	runs: number;
	evalSetSize: number;
	scores: Record<string, number>;
	mean: number;
	disabled?: string[];
	cost?: string;
	sentinelScores?: Record<string, number>;
	/**
	 * pass^k per sentinel case: true only when every attempt passed with no
	 * errors. Sentinels are "must never regress" behavior — partial credit
	 * (score 0.6) has no meaning for them; use this field as the gate.
	 */
	sentinelStrict?: Record<string, boolean>;
	/** Infra-error attempts / total attempts across the run. */
	errorRate?: number;
	/**
	 * True when errorRate exceeded the invalid threshold — the entry is
	 * persisted for history but must be skipped by baseline comparisons
	 * (its scores reflect the infrastructure, not the prompt).
	 */
	invalid?: boolean;
	/** Mean economics over judgeable attempts — a correctness-neutral prompt
	 * change that doubles output or tool chatter shows up here. */
	metrics?: {
		avgOutputChars: number;
		avgToolCalls: number;
		avgTotalTokens?: number;
	};
	/** True when the run was cancelled mid-way; aborted entries are not persisted. */
	aborted?: boolean;
}

/** Above this error-attempt fraction the run's scores are considered
 * infrastructure noise rather than prompt signal. */
const INVALID_ERROR_RATE = 0.25;

interface LoadedEvalCase extends CaseDefinition {
	file: string;
	dir: string;
	isSentinel: boolean;
}

// ── Main Entry ─────────────────────────────────────────

export async function runEvals(
	options: EvalRunOptions,
): Promise<EvalRunResultEntry> {
	const repoDir = options.repoDir;
	const casesDir = path.join(repoDir, "evals", "cases");
	const fixturesDir = path.join(repoDir, "evals", "fixtures");
	const resultsPath = path.join(repoDir, "evals", "results.jsonl");
	const sentinelDir = path.join(casesDir, "sentinel");
	const numRuns = Math.min(options.runs ?? 5, 10);

	// Load cases
	const allCases = loadAllCases(casesDir, sentinelDir);
	const cases = options.caseIds?.length
		? allCases.filter((c) => options.caseIds!.includes(c.id))
		: allCases.filter((c) => (options.includeSentinel ? true : !c.isSentinel));

	if (cases.length === 0) {
		throw new Error("No cases to run");
	}

	const scores: Record<string, number> = {};
	const sentinelScores: Record<string, number> = {};
	const sentinelStrict: Record<string, boolean> = {};
	// Collect per-case per-attempt results for detail reporting
	// (passed via onProgress, NOT persisted by runner — adapter decides storage)
	const detailCases: Record<string, EvalRunCaseDetail> = {};
	let totalAttempts = 0;
	let totalErrors = 0;
	const attemptMetrics: AttemptMetrics[] = [];

	for (let ci = 0; ci < cases.length; ci++) {
		if (options.signal?.aborted) break;

		const case_ = cases[ci];
		options.onProgress?.({
			type: "case-start",
			caseId: case_.id,
			totalCases: cases.length,
			completedCases: ci,
		});

		let passes = 0;
		let fails = 0;
		let errors = 0;
		const caseAttempts: EvalRunCaseAttempt[] = [];

		const pushAttempt = (attempt: EvalRunCaseAttempt) => {
			caseAttempts.push(attempt);
			options.onProgress?.({
				type: "attempt-done",
				caseId: case_.id,
				attempt: attempt.index,
				pass: attempt.pass,
				reason: attempt.reason,
			});
		};

		for (let i = 0; i < numRuns; i++) {
			if (options.signal?.aborted) break;
			totalAttempts++;

			try {
				const outcome = await runSingleCase({
					caseDef: case_,
					fixturesDir,
					disabledSections: options.disabledSections,
					callModel: options.callModel,
					signal: options.signal,
				});

				if (!outcome) {
					errors++;
					totalErrors++;
					pushAttempt({
						index: i + 1,
						pass: false,
						reason: "Fixture not found",
						error: true,
					});
					continue;
				}

				const { result, metrics } = outcome;
				if (result.pass) passes++;
				else fails++;
				if (metrics) attemptMetrics.push(metrics);
				pushAttempt({ index: i + 1, pass: result.pass, reason: result.reason });
			} catch (err) {
				errors++;
				totalErrors++;
				pushAttempt({
					index: i + 1,
					pass: false,
					reason: err instanceof Error ? err.message : "Unknown error",
					error: true,
				});
			}
		}

		// Pass rate over JUDGEABLE attempts only — error attempts carry no
		// behavioral signal either way.
		const judgeable = passes + fails;
		const score = judgeable > 0 ? passes / judgeable : 0;
		// Save per-case detail
		detailCases[case_.id] = { score, caseId: case_.id, attempts: caseAttempts };
		if (case_.isSentinel) {
			sentinelScores[case_.id] = score;
			// pass^k: any fail OR any error (missing evidence) breaks the gate.
			sentinelStrict[case_.id] = passes > 0 && fails === 0 && errors === 0;
		} else {
			scores[case_.id] = score;
		}

		options.onProgress?.({
			type: "case-done",
			caseId: case_.id,
			score,
			completedCases: ci + 1,
			totalCases: cases.length,
		});
	}

	// Compute mean of active cases
	const mean =
		Object.keys(scores).length > 0
			? Object.values(scores).reduce((a, b) => a + b, 0) /
				Object.values(scores).length
			: 0;

	const aborted = options.signal?.aborted === true;
	const errorRate = totalAttempts > 0 ? totalErrors / totalAttempts : 0;

	const metrics =
		attemptMetrics.length > 0
			? {
					avgOutputChars: Math.round(
						attemptMetrics.reduce((a, m) => a + m.outputChars, 0) /
							attemptMetrics.length,
					),
					avgToolCalls:
						Math.round(
							(attemptMetrics.reduce((a, m) => a + m.toolCalls, 0) /
								attemptMetrics.length) *
								100,
						) / 100,
					...(() => {
						const withTokens = attemptMetrics.filter(
							(m) => m.totalTokens != null,
						);
						return withTokens.length > 0
							? {
									avgTotalTokens: Math.round(
										withTokens.reduce((a, m) => a + m.totalTokens!, 0) /
											withTokens.length,
									),
								}
							: {};
					})(),
				}
			: undefined;

	const entry: EvalRunResultEntry = {
		ts: new Date().toISOString(),
		promptVersion: getPromptVersion(),
		provider: options.providerLabel ?? "injected",
		model: options.modelLabel,
		runs: numRuns,
		evalSetSize: cases.filter((c) => !c.isSentinel).length,
		scores,
		mean,
		disabled: options.disabledSections,
		sentinelScores:
			Object.keys(sentinelScores).length > 0 ? sentinelScores : undefined,
		sentinelStrict:
			Object.keys(sentinelStrict).length > 0 ? sentinelStrict : undefined,
		errorRate: totalErrors > 0 ? Math.round(errorRate * 1000) / 1000 : undefined,
		invalid: errorRate > INVALID_ERROR_RATE || undefined,
		metrics,
		aborted: aborted || undefined,
	};

	// Append to results.jsonl — but never persist a cancelled run: a partial
	// entry would silently become the baseline for later comparisons.
	// (Invalid entries ARE persisted — the history of infra failures is
	// useful — but carry the invalid flag so comparisons skip them.)
	if (!aborted && options.persistResults !== false) {
		fs.appendFileSync(resultsPath, JSON.stringify(entry) + "\n", "utf-8");
	}

	options.onProgress?.({
		type: "run-done",
		entry,
		detail: { cases: detailCases },
	});

	return entry;
}

// ── Internal Helpers ───────────────────────────────────

function loadAllCases(casesDir: string, sentinelDir: string): LoadedEvalCase[] {
	const cases: LoadedEvalCase[] = [];

	if (fs.existsSync(casesDir)) {
		const entries = fs.readdirSync(casesDir, { withFileTypes: true });
		for (const entry of entries) {
			// Flat legacy cases: cases/<id>.yaml
			if (entry.isFile() && entry.name.endsWith(".yaml")) {
				const filePath = path.join(casesDir, entry.name);
				try {
					const parsed = parseCaseYaml(fs.readFileSync(filePath, "utf-8"));
					cases.push({
						...parsed,
						file: entry.name,
						dir: casesDir,
						isSentinel: false,
					});
				} catch {
					// Skip unparseable files
				}
				continue;
			}
			// Promoted bundle cases: cases/<id>/case.yaml (+ scene/)
			if (entry.isDirectory() && entry.name !== "sentinel") {
				const filePath = path.join(casesDir, entry.name, "case.yaml");
				if (!fs.existsSync(filePath)) continue;
				try {
					const parsed = parseCaseYaml(fs.readFileSync(filePath, "utf-8"));
					cases.push({
						...parsed,
						file: `${entry.name}/case.yaml`,
						dir: path.join(casesDir, entry.name),
						isSentinel: false,
					});
				} catch {
					// Skip unparseable files
				}
			}
		}
	}

	if (fs.existsSync(sentinelDir)) {
		const entries = fs.readdirSync(sentinelDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
			const filePath = path.join(sentinelDir, entry.name);
			try {
				const parsed = parseCaseYaml(fs.readFileSync(filePath, "utf-8"));
				cases.push({
					...parsed,
					file: entry.name,
					dir: sentinelDir,
					isSentinel: true,
				});
			} catch {
				// Skip unparseable files
			}
		}
	}

	return cases;
}

async function runSingleCase(options: {
	caseDef: LoadedEvalCase;
	fixturesDir: string;
	disabledSections?: string[];
	callModel: EvalModelCaller;
	signal?: AbortSignal;
}): Promise<CaseAttemptOutcome | null> {
	const { caseDef, fixturesDir, disabledSections, callModel, signal } = options;

	// Scene bundle cases (promoted from incidents) run through the mock
	// replay engine: full agent loop, real tool schemas, recorded playback,
	// rubric judging.
	if (caseDef.scene) {
		return runSceneCase({ caseDef, disabledSections, callModel, signal });
	}

	// Load fixture
	const fixturePath = path.join(fixturesDir, caseDef.fixture);
	if (!fs.existsSync(fixturePath)) return null;

	let fixture: EvalFixture;
	try {
		fixture = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
	} catch {
		return null;
	}

	const userMessage = caseDef.userMessage || fixture.userMessage;
	const ctx = fixture.context || {};

	// Build history messages: single-turn by default, multi-turn if context is present.
	// Per design §D6: system prompt is rebuilt by current builder (testing if new
	// prompt can rescue old failures); context messages are injected as history.
	let historyMessages: Array<{ role: string; content: string }> = [
		{ role: "user", content: userMessage },
	];

	if (caseDef.context) {
		const contextPath = path.join(fixturesDir, caseDef.context);
		if (fs.existsSync(contextPath)) {
			try {
				const raw = fs.readFileSync(contextPath, "utf-8");
				const lines = raw.split("\n").filter(Boolean);
				const rawMessages: RawContextMessage[] = [];
				for (const line of lines.slice(1)) {
					// Skip header line; parse message lines
					try {
						const parsed = JSON.parse(line);
						if (parsed.m && parsed.m.role) {
							rawMessages.push(parsed.m as RawContextMessage);
						}
					} catch {
						// Skip bad lines
					}
				}

				// Flatten tool interactions into plain text transcript: replayed
				// history goes to the API as bare role/content messages, and
				// role:"tool" without tool_call_id (or assistant tool_calls
				// linkage) is rejected with 400 by OpenAI-compatible endpoints.
				const contextMessages = flattenContextMessages(rawMessages);

				// Normalize ending: ensure last message is a user message.
				// If the context ends with assistant/tool messages, trim the
				// trailing non-user tail to avoid dangling tool calls.
				const normalized = normalizeContextEnding(contextMessages);

				// Build history: context messages + current user message.
				// If the case's userMessage overrides the last user message,
				// replace the last user message in the context.
				if (caseDef.userMessage && normalized.length > 0) {
					const lastUserIdx = findLastUserIndex(normalized);
					if (lastUserIdx >= 0) {
						normalized[lastUserIdx] = {
							role: "user",
							content: caseDef.userMessage,
						};
						historyMessages = normalized;
					} else {
						historyMessages = [
							...normalized,
							{ role: "user", content: userMessage },
						];
					}
				} else {
					historyMessages =
						normalized.length > 0 ? normalized : historyMessages;
				}
			} catch {
				// Context file exists but can't be parsed; fall back to single-turn
			}
		}
	}

	// Build messages via the runtime's prompt builder
	// (imported dynamically so CLI/UI both resolve the same builder)
	const { buildOnethingPrompt } = await import("../prompts/builder.js");
	const result = await buildOnethingPrompt({
		providerId: fixture.provider || "eval",
		model: fixture.model || "unknown",
		hasTools: ctx.hasTools ?? false,
		skills: ctx.skills ?? [],
		toolNames: ctx.toolNames ?? [],
		workingDirectory: ctx.workingDirectory,
		workingDirectoryRoots: ctx.workingDirectoryRoots,
		knownProjects: ctx.knownProjects,
		voiceConversation: ctx.voiceConversation,
		agentId: ctx.agentId,
		agentName: ctx.agentName,
		platform: ctx.platform,
		disabledSections,
		historyMessages: historyMessages as any,
	});

	// Build messages for the model call. The turn blocks ride the last user
	// message, the same place a live session puts them.
	const messages = attachTurnBlocksToLastUserMessage(
		result.messages.map((m: any) => ({
			role: m.role === "developer" ? "system" : (m.role as any),
			content: typeof m.content === "string" ? m.content : String(m.content),
		})),
		result.turn,
	);

	// Build tools from fixture context
	const tools = ctx.toolNames?.length
		? ctx.toolNames.map((name: string) => ({
				type: "function" as const,
				name,
				description: `Tool: ${name}`,
				parameters: { type: "object" as const, properties: {} },
			}))
		: undefined;

	// Call the model via injected caller
	const response = await callModel({
		messages,
		model: fixture.model || "gpt-4o-mini",
		tools,
		signal,
	});

	// Evaluate
	const evalResult = evaluate(
		{ expect: caseDef.expect as any },
		{ content: response.content, toolCalls: response.toolCalls },
	);
	return {
		result: evalResult,
		metrics: {
			outputChars: response.content.length,
			toolCalls: response.toolCalls.length,
			totalTokens: response.usage?.totalTokens,
		},
	};
}

/**
 * Run a promoted scene-bundle case via the replay engine. The verdict comes
 * from rubric judging (same model as the run); hard `expect` assertions, if
 * present, are applied to the final answer as an additional gate.
 */
async function runSceneCase(options: {
	caseDef: LoadedEvalCase;
	disabledSections?: string[];
	callModel: EvalModelCaller;
	signal?: AbortSignal;
}): Promise<CaseAttemptOutcome | null> {
	const { caseDef, disabledSections, callModel, signal } = options;
	const sceneDir = path.resolve(caseDef.dir, caseDef.scene!);
	const { loadSceneFromDir, runReplay } = await import("./replay.js");
	const scene = loadSceneFromDir(sceneDir);
	if (!scene) return null;
	if (caseDef.userMessage) scene.userMessage = caseDef.userMessage;

	const rubric = caseDef.rubric;
	const result = await runReplay({
		scene,
		callModel,
		disabledSections,
		// Batch eval runs stay on the user-chosen eval binding — routing scene
		// cases to their origin provider would mix models inside one mean and
		// spend on endpoints the user didn't pick for this run.
		preferOriginProvider: false,
		rubric,
		judgeModel: rubric
			? { callModel, model: scene.params.model ?? "unknown" }
			: undefined,
		header: {
			runId: `case-${caseDef.id}`,
			attempt: 0,
			caseId: caseDef.id,
			disabledSections,
			model: scene.params.model ?? "unknown",
			provider: scene.params.provider,
		},
		signal,
	});

	const metrics: AttemptMetrics = {
		outputChars: result.finalContent.length,
		toolCalls: result.transcript.events.reduce(
			(sum, e) => sum + (e.t === "assistant" ? (e.toolCalls?.length ?? 0) : 0),
			0,
		),
	};

	// Hard assertions still apply on top of the rubric verdict
	const hard = evaluate(
		{ expect: caseDef.expect as never },
		{ content: result.finalContent, toolCalls: [] },
	);
	if (!hard.pass) return { result: hard, metrics };

	if (rubric && result.verdict) {
		return {
			result: {
				pass: result.verdict.pass,
				score: result.verdict.pass ? 1 : 0,
				reason: result.verdict.reason,
			},
			metrics,
		};
	}
	return { result: hard, metrics };
}

/** Raw message shape as serialized into .context.jsonl snapshot lines. */
export interface RawContextMessage {
	role: string;
	content: unknown;
	toolCalls?: Array<{
		toolCallId?: string;
		toolName?: string;
		args?: unknown;
	}>;
}

const TOOL_RESULT_MAX_CHARS = 1500;

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (content == null) return "";
	try {
		return JSON.stringify(content);
	} catch {
		return String(content);
	}
}

/**
 * Flatten captured request-view messages into a plain user/assistant
 * transcript that any OpenAI-compatible endpoint accepts:
 *
 * - assistant tool calls are rendered as `[tool call] name(args)` lines
 *   appended to the assistant text
 * - role:"tool" results are folded into the preceding assistant message
 *   as `[tool result] ...` lines (truncated), or into a user-role line
 *   when no assistant precedes them
 *
 * Raw tool messages cannot be replayed as-is: they would need the full
 * tool_call_id linkage that the transcript intentionally drops.
 */
export function flattenContextMessages(
	messages: RawContextMessage[],
): Array<{ role: string; content: string }> {
	const out: Array<{ role: string; content: string }> = [];

	for (const m of messages) {
		if (m.role === "user") {
			out.push({ role: "user", content: contentToText(m.content) });
			continue;
		}

		if (m.role === "assistant") {
			let text = contentToText(m.content);
			for (const tc of m.toolCalls ?? []) {
				const args = contentToText(tc.args ?? {});
				text += `${text ? "\n" : ""}[tool call] ${tc.toolName ?? "unknown"}(${args})`;
			}
			out.push({ role: "assistant", content: text });
			continue;
		}

		if (m.role === "tool") {
			let result = contentToText(m.content);
			if (result.length > TOOL_RESULT_MAX_CHARS) {
				result = `${result.slice(0, TOOL_RESULT_MAX_CHARS)}… [truncated]`;
			}
			const line = `[tool result] ${result}`;
			const last = out[out.length - 1];
			if (last?.role === "assistant") {
				last.content += `\n${line}`;
			} else {
				out.push({ role: "user", content: line });
			}
			continue;
		}

		// system/developer messages inside history are unexpected (the system
		// prompt is rebuilt separately); keep them as user-role transcript so
		// nothing is silently lost.
		out.push({
			role: "user",
			content: `[${m.role}] ${contentToText(m.content)}`,
		});
	}

	return out;
}

/**
 * Normalize context messages to end with a user message.
 * Trailing assistant/tool messages are trimmed to prevent the model
 * from trying to complete dangling tool calls from the historical context.
 */
function normalizeContextEnding(
	messages: Array<{ role: string; content: string }>,
): Array<{ role: string; content: string }> {
	const lastUserIdx = findLastUserIndex(messages);
	if (lastUserIdx < 0) return messages;
	return messages.slice(0, lastUserIdx + 1);
}

function findLastUserIndex(
	messages: Array<{ role: string; content: string }>,
): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") return i;
	}
	return -1;
}
