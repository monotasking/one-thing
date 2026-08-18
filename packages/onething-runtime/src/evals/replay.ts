/**
 * Scene replay engine (workbench W2, design D3).
 *
 * Re-runs a captured failure scene as a full agent loop — same context,
 * same REAL tool definitions, same call params — with tools resolved by
 * the mock ladder (recorded → simulated → stub) instead of real execution.
 * The system prompt is rebuilt by the CURRENT builder (that's the point:
 * "does today's prompt rescue this old failure?"), optionally with
 * sections ablated.
 *
 * Independent of the production ToolRegistry: no permissions, no side
 * effects, hard round cap.
 */

import fs from "node:fs";
import path from "node:path";
import type { CoreRequestMessage, TurnBlock } from "@onething/core/engine";
import { attachTurnBlocksToLastUserMessage } from "../prompts/turn-delivery.js";
import {
	getIncidentDir,
	readIncident,
	readIncidentTurnTrace,
	type IncidentMeta,
	type TurnTraceEntry,
} from "./incident.js";
import {
	createMockToolResolver,
	stringifyToolValue,
	type ToolSimulator,
} from "./mock-tools.js";
import type {
	EvalChatMessage,
	EvalModelCaller,
	EvalToolDef,
} from "./model-call.js";
import {
	buildRubricJudgeMessages,
	parseRubricVerdict,
	type RubricVerdict,
} from "./judge.js";
import {
	transcriptToText,
	type Transcript,
	type TranscriptEvent,
	type TranscriptHeader,
} from "./transcript.js";
import type { OnethingStorePathOptions } from "../storage/paths.js";

const DEFAULT_MAX_ROUNDS = 8;

// ── Scene loading ──────────────────────────────────────

export interface ReplayScene {
	incident?: IncidentMeta;
	/** Builder inputs (scene/fixture.json → context field). */
	fixtureContext?: Record<string, unknown>;
	/** Real tool definitions in OpenAI wire shape (scene/tools.json). */
	tools: Array<{
		type: "function";
		function: { name: string; description: string; parameters: unknown };
	}>;
	/** Call params (scene/params.json). */
	params: {
		provider?: string;
		model?: string;
		temperature?: number;
		maxTokens?: number;
		thinking?: "enabled" | "disabled";
		reasoningEffort?: string;
	};
	/** Request-view history (scene/context.jsonl). */
	contextMessages: CoreRequestMessage[];
	/** The recorded tape (scene/turn-trace.jsonl). */
	trace: TurnTraceEntry[];
	userMessage: string;
	/**
	 * The system prompt AS CAPTURED at failure time (scene/prompt.json,
	 * sections joined). Used by useCapturedPrompt replays for byte-faithful
	 * reproduction; note truncated sections replay truncated.
	 */
	capturedSystemPrompt?: string;
}

export function loadSceneFromIncident(
	incidentId: string,
	storeOptions?: OnethingStorePathOptions,
): ReplayScene | null {
	const incident = readIncident(incidentId, storeOptions);
	if (!incident) return null;
	const sceneDir = path.join(getIncidentDir(incidentId, storeOptions), "scene");
	return loadSceneFromDir(sceneDir, incident);
}

/** Load a scene from any bundle dir (incident or promoted case bundle). */
export function loadSceneFromDir(
	sceneDir: string,
	incident?: IncidentMeta,
): ReplayScene | null {
	const readJson = (name: string): Record<string, unknown> | null => {
		try {
			return JSON.parse(fs.readFileSync(path.join(sceneDir, name), "utf-8"));
		} catch {
			return null;
		}
	};

	const fixture = readJson("fixture.json");
	const toolsFile = readJson("tools.json");
	const params = readJson("params.json") ?? {};
	const promptSnapshot = readJson("prompt.json");
	const capturedSystemPrompt = Array.isArray(promptSnapshot?.sections)
		? (promptSnapshot!.sections as Array<{ content: string }>)
				.map((s) => s.content)
				.join("\n\n")
		: undefined;

	const contextMessages: CoreRequestMessage[] = [];
	const contextPath = path.join(sceneDir, "context.jsonl");
	if (fs.existsSync(contextPath)) {
		const lines = fs
			.readFileSync(contextPath, "utf-8")
			.split("\n")
			.filter(Boolean);
		for (const line of lines.slice(1)) {
			try {
				const parsed = JSON.parse(line);
				if (parsed.m?.role) contextMessages.push(parsed.m);
			} catch {
				// Skip bad lines (including {omitted} markers)
			}
		}
	}

	// The tape may live next to the scene (incident) or be absent (legacy)
	const trace: TurnTraceEntry[] = [];
	const tracePath = path.join(sceneDir, "turn-trace.jsonl");
	if (fs.existsSync(tracePath)) {
		const lines = fs
			.readFileSync(tracePath, "utf-8")
			.split("\n")
			.filter(Boolean);
		for (const line of lines.slice(1)) {
			try {
				const parsed = JSON.parse(line);
				if (typeof parsed.content === "string") trace.push(parsed);
			} catch {
				// Skip
			}
		}
	}

	const userMessage =
		incident?.userMessage ??
		(typeof fixture?.userMessage === "string"
			? (fixture.userMessage as string)
			: "");

	if (!fixture && !contextMessages.length && !userMessage) return null;

	return {
		incident,
		fixtureContext:
			(fixture?.context as Record<string, unknown> | undefined) ?? undefined,
		tools:
			(toolsFile?.tools as ReplayScene["tools"] | undefined) ?? [],
		params: {
			provider: params.provider as string | undefined,
			model: params.model as string | undefined,
			temperature: params.temperature as number | undefined,
			maxTokens: params.maxTokens as number | undefined,
			thinking: params.thinking as "enabled" | "disabled" | undefined,
			reasoningEffort: params.reasoningEffort as string | undefined,
		},
		contextMessages,
		trace,
		userMessage,
		capturedSystemPrompt,
	};
}

// ── Context mapping ────────────────────────────────────

/**
 * Map captured request-view messages to model-caller messages with the
 * FULL tool-calling protocol preserved (assistant tool_calls linked to
 * tool results) — no lossy flattening.
 */
export function contextToEvalMessages(
	contextMessages: CoreRequestMessage[],
): EvalChatMessage[] {
	const out: EvalChatMessage[] = [];
	let syntheticId = 0;

	for (const m of contextMessages) {
		// The captured request messages INCLUDE the original system message
		// (runtime.messages carries it). runReplay supplies its own system
		// message (captured or rebuilt) — forwarding this one would send the
		// model TWO system prompts, unlike the original request.
		if (m.role === "system" || m.role === "developer") continue;
		if (m.role === "user") {
			out.push({
				role: m.role,
				content: stringifyToolValue(m.content),
			});
			continue;
		}
		if (m.role === "assistant") {
			const toolCalls = (m.toolCalls ?? []).map((tc) => ({
				id: tc.toolCallId || `replay-tc-${++syntheticId}`,
				name: tc.toolName ?? "unknown",
				argsJson: stringifyToolValue(tc.args ?? {}) || "{}",
			}));
			out.push({
				role: "assistant",
				content: stringifyToolValue(m.content),
				...(toolCalls.length ? { toolCalls } : {}),
			});
			continue;
		}
		if (m.role === "tool") {
			// CoreRequestMessage tool content: array of tool-result parts
			const parts = Array.isArray(m.content) ? m.content : [];
			for (const part of parts as Array<{
				toolCallId?: string;
				result?: unknown;
			}>) {
				out.push({
					role: "tool",
					toolCallId: part.toolCallId || `replay-tc-${syntheticId}`,
					content: stringifyToolValue(part.result ?? part),
				});
			}
		}
	}

	// A dangling assistant tool_calls tail would make the model answer the
	// wrong thing; ensure the history ends with a user message.
	while (out.length && out[out.length - 1].role !== "user") out.pop();
	return out;
}

// ── Replay loop ────────────────────────────────────────

export interface ReplayOptions {
	scene: ReplayScene;
	callModel: EvalModelCaller;
	/**
	 * Replay with the CAPTURED system prompt (byte-faithful reproduction of
	 * the failure moment) instead of rebuilding with the current builder
	 * (the default, which answers "does today's prompt rescue this?").
	 * Incompatible with disabledSections (ablation needs the builder).
	 */
	useCapturedPrompt?: boolean;
	/** Ablate prompt sections (design D6 diagnosis). */
	disabledSections?: string[];
	/**
	 * Route the call to the scene's ORIGIN provider (default true —
	 * reproduction contexts want the original endpoint). The eval-set
	 * runner sets false so batch runs stay on the user-chosen binding
	 * (predictable cost, single-model mean).
	 */
	preferOriginProvider?: boolean;
	/** AI simulator for unmatched tool calls (W4). Absent → stub. */
	simulateTool?: ToolSimulator;
	/** Judge the outcome against this rubric (👎 note / AI rubric).
	 * An array is a clause checklist: violating any clause fails. */
	rubric?: string | string[];
	/** Separate caller for judging (cheap analysis model). */
	judgeModel?: { callModel: EvalModelCaller; model: string };
	maxRounds?: number;
	header: Omit<TranscriptHeader, "v" | "kind" | "startedAt">;
	onEvent?: (event: TranscriptEvent) => void;
	signal?: AbortSignal;
}

export interface ReplayResult {
	transcript: Transcript;
	finalContent: string;
	rounds: number;
	verdict?: RubricVerdict;
	mockStats: { recorded: number; simulated: number; stub: number };
}

export async function runReplay(options: ReplayOptions): Promise<ReplayResult> {
	const { scene } = options;
	const events: TranscriptEvent[] = [];
	const emit = (event: TranscriptEvent) => {
		events.push(event);
		options.onEvent?.(event);
	};

	const header: TranscriptHeader = {
		v: 1,
		kind: "evals-transcript",
		startedAt: new Date().toISOString(),
		...options.header,
	};

	// System prompt: captured original (faithful reproduction) or rebuilt by
	// the CURRENT builder from scene inputs (the default — tests whether
	// today's prompt rescues the old failure, and enables ablation).
	let systemPrompt: string;
	/**
	 * Blocks for the turn channel. They are part of what the model reads (they
	 * ride the user message tail), so a replay that dropped them would be
	 * reproducing a prompt nobody ever sent — and an ablation over a turn
	 * section would compare two identical requests.
	 */
	let turnBlocks: TurnBlock[] = [];
	if (
		options.useCapturedPrompt &&
		scene.capturedSystemPrompt &&
		!options.disabledSections?.length
	) {
		systemPrompt = scene.capturedSystemPrompt;
	} else {
		const { buildOnethingPrompt } = await import("../prompts/builder.js");
		const ctx = (scene.fixtureContext ?? {}) as Record<string, unknown>;
		const built = await buildOnethingPrompt({
			providerId: scene.params.provider || "eval",
			model: scene.params.model || "unknown",
			hasTools: (ctx.hasTools as boolean) ?? scene.tools.length > 0,
			skills: (ctx.skills as never[]) ?? [],
			toolNames:
				(ctx.toolNames as string[]) ??
				scene.tools.map((t) => t.function.name),
			workingDirectory: ctx.workingDirectory as string | undefined,
			workingDirectoryRoots: ctx.workingDirectoryRoots as string[] | undefined,
			knownProjects: ctx.knownProjects as never,
			voiceConversation: ctx.voiceConversation as boolean | undefined,
			platform: ctx.platform as string | undefined,
			disabledSections: options.disabledSections,
			historyMessages: [],
		});
		systemPrompt = built.systemPrompt;
		turnBlocks = [...(built.turn ?? [])];
	}

	let messages: EvalChatMessage[] = [
		{ role: "system", content: systemPrompt },
		...contextToEvalMessages(scene.contextMessages),
	];
	if (!messages.some((m) => m.role === "user")) {
		messages.push({ role: "user", content: scene.userMessage });
	}
	messages = attachTurnBlocksToLastUserMessage(messages, turnBlocks);

	const tools: EvalToolDef[] = scene.tools.map((t) => ({
		type: "function",
		name: t.function.name,
		description: t.function.description ?? "",
		parameters: (t.function.parameters as Record<string, unknown>) ?? {
			type: "object",
			properties: {},
		},
	}));

	const resolver = createMockToolResolver({
		trace: scene.trace,
		simulate: options.simulateTool,
	});

	const mockStats = { recorded: 0, simulated: 0, stub: 0 };
	const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
	let finalContent = "";
	let rounds = 0;

	try {
		for (let round = 1; round <= maxRounds; round++) {
			if (options.signal?.aborted) break;
			rounds = round;
			emit({ t: "round", n: round });

			const response = await options.callModel({
				messages,
				model: scene.params.model || options.header.model,
				// The scene's ORIGIN provider — callers that can route per-provider
				// (desktop adapter) reproduce against the original endpoint instead
				// of silently testing a different model under the original's name.
				provider:
					options.preferOriginProvider === false
						? undefined
						: scene.params.provider,
				tools: tools.length ? tools : undefined,
				temperature: scene.params.temperature,
				maxTokens: scene.params.maxTokens,
				thinking: scene.params.thinking,
				reasoningEffort: scene.params.reasoningEffort,
				signal: options.signal,
			});

			finalContent = response.content || finalContent;
			emit({
				t: "assistant",
				content: response.content,
				...(response.toolCalls.length
					? {
							toolCalls: response.toolCalls.map((tc) => ({
								id: tc.id,
								name: tc.name,
								args: tc.args,
							})),
						}
					: {}),
			});

			if (!response.toolCalls.length) break;

			// Append the assistant turn + mock results, continue the loop
			messages.push({
				role: "assistant",
				content: response.content,
				toolCalls: response.toolCalls.map((tc) => ({
					id: tc.id,
					name: tc.name,
					argsJson: stringifyToolValue(tc.args ?? {}) || "{}",
				})),
			});
			for (const tc of response.toolCalls) {
				const resolution = await resolver.resolve(tc.name, tc.args ?? {});
				mockStats[resolution.source]++;
				emit({
					t: "tool-result",
					toolCallId: tc.id,
					name: tc.name,
					source: resolution.source,
					result: resolution.result,
				});
				messages.push({
					role: "tool",
					toolCallId: tc.id,
					content: resolution.result,
				});
			}
		}
	} catch (error) {
		emit({
			t: "error",
			message: error instanceof Error ? error.message : String(error),
		});
	}

	emit({ t: "done", finalContent, rounds });

	const transcript: Transcript = { header, events };

	// Rubric judging
	let verdict: RubricVerdict | undefined;
	if (options.rubric && options.judgeModel) {
		try {
			const mockTotal =
				mockStats.recorded + mockStats.simulated + mockStats.stub;
			const judgeMessages = buildRubricJudgeMessages({
				rubric: options.rubric,
				userMessage: scene.userMessage,
				transcriptText: transcriptToText(transcript),
				originalBehavior: scene.trace.length
					? scene.trace
							.map(
								(e) =>
									`${e.content}\n${e.toolCalls.map((tc) => `[tool call] ${tc.name}(${stringifyToolValue(tc.args)})`).join("\n")}`,
							)
							.join("\n")
					: undefined,
				mockCaveat:
					mockTotal > 0
						? `${mockStats.simulated + mockStats.stub}/${mockTotal} tool results were simulated or stubbed.`
						: undefined,
			});
			const judgeResponse = await options.judgeModel.callModel({
				messages: [
					{ role: "system", content: judgeMessages.system },
					{ role: "user", content: judgeMessages.user },
				],
				model: options.judgeModel.model,
				signal: options.signal,
			});
			verdict = parseRubricVerdict(judgeResponse.content) ?? undefined;
			if (verdict) {
				emit({
					t: "judge",
					pass: verdict.pass,
					reason: verdict.reason,
					rubric: Array.isArray(options.rubric)
						? options.rubric.join("\n")
						: options.rubric,
				});
			}
		} catch (error) {
			emit({
				t: "error",
				message: `judge failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	return { transcript, finalContent, rounds, verdict, mockStats };
}
