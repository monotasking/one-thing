/**
 * Incident Bundle (事故工作台 W1)
 *
 * An incident is the first-class human-facing object of the eval system:
 * one failure = one self-contained directory holding
 *   - incident.json  machine metadata (status/versions/signals/rubric)
 *   - incident.md    human-readable cover (template here; AI rewrites in W4)
 *   - scene/         the COMPLETE captured scene:
 *       prompt.json      sectioned system prompt (same format as snapshots)
 *       context.jsonl    request-view history (same format as snapshots)
 *       tools.json       REAL tool definitions sent to the model
 *       params.json      call params (model/temperature/maxTokens/toolChoice)
 *       turn-trace.jsonl what actually happened during the turn: model text,
 *                        每个工具调用的 args 与真实执行 result —— mock 重放的录制带
 *       fixture.json     builder inputs (workingDirectory/knownProjects/skills…)
 *   - runs/<runId>/  replay transcripts (W2)
 *
 * The only human input is the 👎 note; everything else is captured or
 * AI-generated (design: docs/design/evals-incident-workbench.md).
 */

import fs from "node:fs";
import path from "node:path";
import type { CorePromptCapture } from "@onething/backend/runtime/agent-loop";
import {
	getOnethingEvalsIncidentsDir,
	type OnethingStorePathOptions,
} from "../storage/paths.js";
import {
	buildPromptSnapshotObject,
	buildContextSnapshotContent,
} from "./snapshot.js";
import { getTurnTraceDir } from "./trace-store.js";
import { hashSections } from "./section-hash.js";
import type { EvalFixtureContext } from "./fixture.js";
import type { TurnSignals } from "@shared/contracts/eval-record.js";

// ── Types ──────────────────────────────────────────────

export type IncidentOrigin = "downvote" | "auto";

export type IncidentStatus =
	| "new"
	| "analyzed"
	| "reproduced"
	| "not-reproducible"
	| "diagnosed"
	| "case-created"
	| "fixed";

/** One tool interaction recorded from the real turn (the mock replay tape). */
export interface TurnTraceToolCall {
	name: string;
	args?: unknown;
	result?: unknown;
	status?: string;
	durationMs?: number;
}

/** One assistant round within the turn. */
export interface TurnTraceEntry {
	content: string;
	toolCalls: TurnTraceToolCall[];
}

export interface IncidentMeta {
	version: 1;
	id: string;
	createdAt: string;
	origin: IncidentOrigin;
	status: IncidentStatus;
	/** Human title. Template: note or user message excerpt; AI rewrites in W4. */
	title: string;
	/** The 👎 one-liner: what went wrong / what was expected. */
	note?: string;
	/** AI-assigned failure category (W4). */
	category?: string;
	/** AI-extracted judgeable expectation used by replay judging (W4). */
	rubric?: string;
	sessionId: string;
	turnId: string;
	provider: string;
	model: string;
	promptVersion?: string;
	skeletonVersion?: string;
	sectionHashes?: Record<string, string>;
	signals?: Partial<TurnSignals>;
	explicitDown?: boolean;
	userMessage: string;
	assistantPreview: string;
	/**
	 * Context fidelity level:
	 * - live: the EXACT request messages captured when the turn ran (byte-identical history)
	 * - rebuilt: send view rebuilt from the session jsonl through the production pipeline
	 * - synthesized: hand-rolled storage-view approximation (last resort)
	 */
	contextOrigin?: "live" | "rebuilt" | "synthesized";
	scene: {
		prompt: boolean;
		context: boolean;
		tools: boolean;
		params: boolean;
		turnTrace: boolean;
		fixture: boolean;
		/** Number of per-round (request, response) traces copied into scene/rounds/. */
		rounds?: number;
	};
	diagnosis?: {
		conclusion: string;
		reportRef?: string;
		at: string;
	};
	caseId?: string;
}

export interface CreateIncidentOptions {
	origin: IncidentOrigin;
	note?: string;
	sessionId: string;
	turnId: string;
	provider: string;
	model: string;
	userMessage: string;
	assistantText?: string;
	signals?: Partial<TurnSignals>;
	explicitDown?: boolean;
	promptCapture?: CorePromptCapture;
	turnTrace?: TurnTraceEntry[];
	/**
	 * Fallback context when the live capture is gone: either the send view
	 * rebuilt through the production pipeline (Route A) or a hand-rolled
	 * storage-view approximation.
	 */
	synthesizedContext?: Array<Record<string, unknown>>;
	/** Which fallback produced synthesizedContext. */
	synthesizedContextOrigin?: "rebuilt" | "synthesized";
	/** Builder inputs, same shape as fixture context (scene/fixture.json). */
	fixtureContext?: Partial<EvalFixtureContext>;
	skeletonVersion?: string;
	contextMaxBytes?: number;
	storeOptions?: OnethingStorePathOptions;
}

export interface CreateIncidentResult {
	incidentId: string;
	incidentDir: string;
	meta: IncidentMeta;
}

// ── Creation ───────────────────────────────────────────

function sanitizeId(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function createIncidentBundle(
	options: CreateIncidentOptions,
): CreateIncidentResult {
	const incidentsDir = getOnethingEvalsIncidentsDir(options.storeOptions);
	const date = new Date().toISOString().slice(0, 10);
	const shortId = sanitizeId(options.turnId).slice(0, 8) || "unknown";
	const incidentId = `${date}-${shortId}`;
	// Collision-safe (same turn downvoted twice reuses the same bundle)
	const incidentDir = path.join(incidentsDir, incidentId);
	const sceneDir = path.join(incidentDir, "scene");
	fs.mkdirSync(sceneDir, { recursive: true });

	const capture = options.promptCapture;
	const promptVersion = capture?.sections.length
		? hashSections(capture.sections).promptVersion
		: undefined;

	// scene/prompt.json
	let hasPrompt = false;
	if (capture?.sections.length) {
		const promptSnapshot = buildPromptSnapshotObject(capture, promptVersion);
		fs.writeFileSync(
			path.join(sceneDir, "prompt.json"),
			JSON.stringify(promptSnapshot, null, 2),
			"utf-8",
		);
		hasPrompt = true;
	}

	// scene/context.jsonl — live capture preferred; synthesized fallback
	// keeps old-turn 👎 incidents replayable.
	let hasContext = false;
	let contextOrigin: IncidentMeta["contextOrigin"];
	if (capture?.requestMessages?.length) {
		const content = buildContextSnapshotContent({
			sessionId: options.sessionId,
			turnId: options.turnId,
			requestMessages: capture.requestMessages,
			maxBytes: options.contextMaxBytes,
		});
		fs.writeFileSync(path.join(sceneDir, "context.jsonl"), content, "utf-8");
		hasContext = true;
		contextOrigin = "live";
	} else if (options.synthesizedContext?.length) {
		const content = buildContextSnapshotContent({
			sessionId: options.sessionId,
			turnId: options.turnId,
			requestMessages:
				options.synthesizedContext as unknown as NonNullable<
					CorePromptCapture["requestMessages"]
				>,
			maxBytes: options.contextMaxBytes,
			synthesized: true,
		});
		fs.writeFileSync(path.join(sceneDir, "context.jsonl"), content, "utf-8");
		hasContext = true;
		contextOrigin = options.synthesizedContextOrigin ?? "synthesized";
	}

	// scene/tools.json — REAL tool definitions from the captured request
	let hasTools = false;
	if (capture?.rawRequest?.tools?.length) {
		fs.writeFileSync(
			path.join(sceneDir, "tools.json"),
			JSON.stringify(
				{ version: 1, tools: capture.rawRequest.tools },
				null,
				2,
			),
			"utf-8",
		);
		hasTools = true;
	}

	// scene/params.json
	let hasParams = false;
	if (capture?.rawRequest) {
		const params = {
			version: 1,
			provider: options.provider,
			model: capture.rawRequest.model || options.model,
			temperature: capture.rawRequest.temperature,
			maxTokens: capture.rawRequest.maxTokens,
			toolChoice: capture.rawRequest.toolChoice,
			thinking: capture.rawRequest.thinking,
			reasoningEffort: capture.rawRequest.reasoningEffort,
		};
		fs.writeFileSync(
			path.join(sceneDir, "params.json"),
			JSON.stringify(params, null, 2),
			"utf-8",
		);
		hasParams = true;
	}

	// scene/turn-trace.jsonl — the recorded tape for mock replay
	let hasTrace = false;
	if (options.turnTrace?.length) {
		const lines = [
			JSON.stringify({
				v: 1,
				kind: "evals-turn-trace",
				sessionId: options.sessionId,
				turnId: options.turnId,
			}) + "\n",
		];
		for (const entry of options.turnTrace) {
			try {
				lines.push(JSON.stringify(JSON.parse(JSON.stringify(entry))) + "\n");
			} catch {
				lines.push(
					JSON.stringify({ content: entry.content, toolCalls: [] }) + "\n",
				);
			}
		}
		fs.writeFileSync(
			path.join(sceneDir, "turn-trace.jsonl"),
			lines.join(""),
			"utf-8",
		);
		hasTrace = true;
	}

	// scene/rounds/ — per-round (request, response) traces (L1). The trace
	// ring has its own lifecycle; the incident copies its turn's rounds so
	// the bundle stays self-contained after the ring rolls over.
	let roundsCount = 0;
	try {
		const traceDir = getTurnTraceDir(
			options.sessionId,
			options.turnId,
			options.storeOptions,
		);
		if (fs.existsSync(traceDir)) {
			const roundFiles = fs
				.readdirSync(traceDir)
				.filter((name) => /^round-\d+\.json$/.test(name));
			if (roundFiles.length > 0) {
				const roundsDir = path.join(sceneDir, "rounds");
				fs.mkdirSync(roundsDir, { recursive: true });
				for (const file of roundFiles) {
					fs.copyFileSync(
						path.join(traceDir, file),
						path.join(roundsDir, file),
					);
				}
				roundsCount = roundFiles.length;
			}
		}
	} catch {
		// Trace copy is best-effort; the bundle stays useful without it
	}

	// scene/fixture.json — builder inputs for prompt reconstruction in replay
	let hasFixture = false;
	if (options.fixtureContext) {
		fs.writeFileSync(
			path.join(sceneDir, "fixture.json"),
			JSON.stringify(
				{
					version: 1,
					provider: options.provider,
					model: options.model,
					userMessage: options.userMessage,
					context: options.fixtureContext,
				},
				null,
				2,
			),
			"utf-8",
		);
		hasFixture = true;
	}

	const assistantPreview = (options.assistantText ?? "").slice(0, 240);

	const meta: IncidentMeta = {
		version: 1,
		id: incidentId,
		createdAt: new Date().toISOString(),
		origin: options.origin,
		status: "new",
		title: (options.note || options.userMessage || incidentId).slice(0, 80),
		note: options.note,
		sessionId: options.sessionId,
		turnId: options.turnId,
		provider: options.provider,
		model: options.model,
		promptVersion,
		skeletonVersion: options.skeletonVersion,
		sectionHashes: capture?.sectionHashes,
		signals: options.signals,
		explicitDown: options.explicitDown,
		userMessage: options.userMessage,
		assistantPreview,
		contextOrigin,
		scene: {
			prompt: hasPrompt,
			context: hasContext,
			tools: hasTools,
			params: hasParams,
			turnTrace: hasTrace,
			fixture: hasFixture,
			...(roundsCount > 0 ? { rounds: roundsCount } : {}),
		},
	};

	fs.writeFileSync(
		path.join(incidentDir, "incident.json"),
		JSON.stringify(meta, null, 2),
		"utf-8",
	);
	fs.writeFileSync(
		path.join(incidentDir, "incident.md"),
		renderIncidentMarkdown(meta, options.turnTrace ?? []),
		"utf-8",
	);

	return { incidentId, incidentDir, meta };
}

/**
 * Template cover. W4's AI analysis rewrites this with a proper title,
 * summary and suspected sections; the template already answers "what
 * happened / what was expected" from captured data alone.
 */
export function renderIncidentMarkdown(
	meta: IncidentMeta,
	turnTrace: TurnTraceEntry[],
): string {
	const toolLines = turnTrace
		.flatMap((entry) => entry.toolCalls)
		.map((tc) => {
			const args = safeShort(tc.args, 120);
			const status = tc.status && tc.status !== "completed" ? ` [${tc.status}]` : "";
			return `- \`${tc.name}(${args})\`${status}`;
		});

	return [
		`# ${meta.title}`,
		"",
		`> ${meta.origin === "downvote" ? "👎 手动标记" : "负信号自动捕获"} · ${meta.createdAt.slice(0, 16).replace("T", " ")} · ${meta.provider}/${meta.model}`,
		"",
		"## 发生了什么",
		"",
		`**用户**: ${meta.userMessage || "(空)"}`,
		"",
		`**助手**: ${meta.assistantPreview || "(无输出)"}${meta.assistantPreview.length >= 240 ? "…" : ""}`,
		"",
		...(toolLines.length ? ["**工具调用**:", "", ...toolLines, ""] : []),
		"## 期望",
		"",
		meta.note || "_(👎 时未填写说明)_",
		"",
		"## 现场",
		"",
		`- promptVersion: \`${meta.promptVersion ?? "?"}\` · session: \`${meta.sessionId.slice(0, 8)}\` · turn: \`${meta.turnId.slice(0, 8)}\``,
		`- scene: ${Object.entries(meta.scene)
			.filter(([, v]) => v)
			.map(([k]) => k)
			.join(" · ") || "(空)"}`,
		"",
	].join("\n");
}

function safeShort(value: unknown, max: number): string {
	if (value == null) return "";
	let text: string;
	try {
		text = typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		text = String(value);
	}
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ── Context synthesis fallback ─────────────────────────

/**
 * Synthesize request-view-shaped context from PERSISTED session messages,
 * for turns whose live prompt capture is gone (LRU evicted / app
 * restarted). This is the STORAGE view, not the send view — compaction
 * and dehydration differences apply — but a degraded scene that can still
 * replay beats an empty one. The context header is marked `synthesized`.
 *
 * Returns messages BEFORE the turn (the turn itself lives in turn-trace).
 */
export function synthesizeContextFromMessages(
	messages: TurnTraceMessageLike[],
	turnId: string,
): Array<Record<string, unknown>> {
	const anchor = messages.findIndex(
		(m) => m.id === turnId && m.role === "assistant",
	);
	// Walk back past the turn's user message so the replay engine can
	// re-append it cleanly.
	let end = anchor >= 0 ? anchor - 1 : messages.length - 1;
	while (end >= 0 && messages[end].role !== "user") end--;

	const out: Array<Record<string, unknown>> = [];
	for (let i = 0; i <= end; i++) {
		const m = messages[i];
		if (m.role === "user") {
			out.push({
				role: "user",
				content: typeof m.content === "string" ? m.content : "",
			});
		} else if (m.role === "assistant") {
			const toolCalls = (m.toolCalls ?? []).map((tc, idx) => ({
				toolCallId: `synth-${i}-${idx}`,
				toolName: tc.toolName ?? "unknown",
				args: tc.arguments ?? {},
			}));
			out.push({
				role: "assistant",
				content: typeof m.content === "string" ? m.content : "",
				...(toolCalls.length ? { toolCalls } : {}),
			});
			// Persisted tool results live on the assistant's toolCalls —
			// re-emit them as the request-view tool message.
			const results = (m.toolCalls ?? [])
				.map((tc, idx) => ({
					type: "tool-result",
					toolCallId: `synth-${i}-${idx}`,
					toolName: tc.toolName ?? "unknown",
					result: tc.result,
				}))
				.filter((r) => r.result !== undefined);
			if (results.length) out.push({ role: "tool", content: results });
		}
	}
	return out;
}

// ── Turn trace extraction ──────────────────────────────

/** Structural shape of a chat message as needed for trace extraction. */
export interface TurnTraceMessageLike {
	id?: string;
	role: string;
	content?: unknown;
	toolCalls?: Array<{
		toolName?: string;
		arguments?: unknown;
		result?: unknown;
		status?: string;
		durationMs?: number;
	}>;
}

/**
 * Extract the turn's assistant rounds (text + tool calls with REAL results)
 * from a session message list. The turn is the contiguous assistant block
 * containing `turnId` (or the trailing block when turnId is absent),
 * delimited by user messages.
 */
export function extractTurnTrace(
	messages: TurnTraceMessageLike[],
	turnId?: string,
): TurnTraceEntry[] {
	if (!messages.length) return [];

	let anchor = turnId
		? messages.findIndex((m) => m.id === turnId && m.role === "assistant")
		: -1;
	if (anchor < 0) {
		// Trailing assistant block
		anchor = messages.length - 1;
		while (anchor >= 0 && messages[anchor].role !== "assistant") anchor--;
		if (anchor < 0) return [];
	}

	let start = anchor;
	while (start > 0 && messages[start - 1].role !== "user") start--;
	let end = anchor;
	while (end + 1 < messages.length && messages[end + 1].role !== "user") end++;

	const entries: TurnTraceEntry[] = [];
	for (let i = start; i <= end; i++) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		entries.push({
			content: typeof m.content === "string" ? m.content : "",
			toolCalls: (m.toolCalls ?? []).map((tc) => ({
				name: tc.toolName ?? "unknown",
				args: tc.arguments,
				result: tc.result,
				status: tc.status,
				durationMs: tc.durationMs,
			})),
		});
	}
	return entries;
}

// ── Reading / updating ─────────────────────────────────

export function listIncidents(options?: {
	limit?: number;
	storeOptions?: OnethingStorePathOptions;
}): IncidentMeta[] {
	const dir = getOnethingEvalsIncidentsDir(options?.storeOptions);
	if (!fs.existsSync(dir)) return [];

	const metas: IncidentMeta[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const metaPath = path.join(dir, entry.name, "incident.json");
		try {
			const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
			metas.push(meta);
		} catch {
			// Skip unreadable bundles
		}
	}
	metas.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
	return options?.limit ? metas.slice(0, options.limit) : metas;
}

export function getIncidentDir(
	incidentId: string,
	storeOptions?: OnethingStorePathOptions,
): string {
	return path.join(
		getOnethingEvalsIncidentsDir(storeOptions),
		sanitizeId(incidentId),
	);
}

export function readIncident(
	incidentId: string,
	storeOptions?: OnethingStorePathOptions,
): IncidentMeta | null {
	try {
		return JSON.parse(
			fs.readFileSync(
				path.join(getIncidentDir(incidentId, storeOptions), "incident.json"),
				"utf-8",
			),
		);
	} catch {
		return null;
	}
}

export function updateIncident(
	incidentId: string,
	patch: Partial<IncidentMeta>,
	storeOptions?: OnethingStorePathOptions,
): IncidentMeta | null {
	const current = readIncident(incidentId, storeOptions);
	if (!current) return null;
	const next = { ...current, ...patch, id: current.id, version: 1 as const };
	fs.writeFileSync(
		path.join(getIncidentDir(incidentId, storeOptions), "incident.json"),
		JSON.stringify(next, null, 2),
		"utf-8",
	);
	return next;
}

export function readIncidentTurnTrace(
	incidentId: string,
	storeOptions?: OnethingStorePathOptions,
): TurnTraceEntry[] {
	const tracePath = path.join(
		getIncidentDir(incidentId, storeOptions),
		"scene",
		"turn-trace.jsonl",
	);
	if (!fs.existsSync(tracePath)) return [];
	const lines = fs.readFileSync(tracePath, "utf-8").split("\n").filter(Boolean);
	const entries: TurnTraceEntry[] = [];
	for (const line of lines.slice(1)) {
		try {
			const parsed = JSON.parse(line);
			if (typeof parsed.content === "string") entries.push(parsed);
		} catch {
			// Skip bad lines
		}
	}
	return entries;
}
