/**
 * Evals IPC Handlers
 *
 * Handles IPC communication for prompt evaluation operations.
 * Phase 1: 👎 (downvote) + Review (records, fixtures, runs)
 * Phase 2: Run (runner execution with provider injection)
 * Phase 3: Closed-loop actions (promote, retire, triage)
 */

import { app, ipcMain, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import type {
	EvalsRecordDownvoteRequest,
	EvalsRecordDownvoteResponse,
	EvalsListRecordsRequest,
	EvalsListRecordsResponse,
	TurnEvalRecordView,
	EvalsListFixturesResponse,
	EvalFixtureMeta,
	EvalsReadFixtureRequest,
	EvalsReadFixtureResponse,
	EvalsReadSnapshotRequest,
	EvalsReadSnapshotResponse,
	ContextSnapshotMessage,
	EvalsListResultsResponse,
	EvalRunResultEntry,
	EvalsListCasesResponse,
	EvalCaseMeta,
	EvalsGetCaseRequest,
	EvalsGetCaseResponse,
	EvalsRunStartRequest,
	EvalsRunStartResponse,
	EvalsRunCancelResponse,
	EvalsRunProgressEvent,
	EvalsPromoteFixtureRequest,
	EvalsPromoteFixtureResponse,
	EvalsRetireCaseRequest,
	EvalsRetireCaseResponse,
	EvalsGenerateTriageRequest,
	EvalsGenerateTriageResponse,
	EvalsReadRunDetailRequest,
	EvalsReadRunDetailResponse,
} from "@shared/ipc.js";
import { IPC_CHANNELS } from "@shared/ipc.js";
import * as store from "@onething/backend/store.js";
import { sessionReads } from "@onething/backend/session/reads.js";
import { getSkillsForSession } from "@onething/backend/wiring/skills/session-skills.js";
import { registerEvalsWorkbenchHandlers } from "./evals-workbench.js";
import {
	createEvalsModelCaller,
	resolveEvalsCredentials,
} from "./evals-provider-adapter.js";
import { getLogger } from "@onething/backend/logging/index.js";

const log = getLogger("ipc.evals");

// ── Helpers ────────────────────────────────────────────

interface EvalsSettings {
	repoDir?: string;
}

function getEvalsSettings(): EvalsSettings {
	const settings = store.getSettings();
	return (settings as any)?.evals ?? {};
}

function getRepoDir(): string | null {
	const settings = getEvalsSettings();
	if (settings.repoDir) return settings.repoDir;
	// In development the app runs from the repo checkout, so cwd is the repo
	// root. A packaged app has no meaningful cwd — require explicit config.
	if (!app.isPackaged) {
		return process.cwd();
	}
	return null;
}

/** Repo dir resolution shared with the workbench handlers. */
export function getRepoDirForEvals(): string | null {
	return getRepoDir();
}

function getEvalsFixturesAutoDir(): string {
	return path.join(homedir(), ".onething", "evals", "fixtures", "auto");
}

function getEvalsFixturesDir(repoDir: string): string {
	return path.join(repoDir, "evals", "fixtures");
}

function getEvalsCasesDir(repoDir: string): string {
	return path.join(repoDir, "evals", "cases");
}

function getResultsPath(repoDir: string): string {
	return path.join(repoDir, "evals", "results.jsonl");
}

function getTriagePath(repoDir: string): string {
	return path.join(repoDir, "evals", "triage.md");
}

// ── Running state ──────────────────────────────────────

let activeRunAbort: AbortController | null = null;

// ── Incident creation (shared by 👎 and retry amend) ───

/**
 * Build a complete incident bundle for a turn: prompt capture from the LRU,
 * turn trace (with REAL tool results) from the persisted session messages,
 * builder inputs for replay. Returns null when the turn can't be located.
 *
 * This is the single entry point for late negative signals — the downvote
 * handler and the retry/edit amend interceptor both call it.
 */
export async function createIncidentForTurn(options: {
	sessionId: string;
	turnId: string;
	origin: "downvote" | "auto";
	note?: string;
	userMessage?: string;
	explicitDown?: boolean;
	signals?: { retried?: boolean; editResent?: boolean };
}): Promise<{
	incidentId: string;
	userMessage: string;
	assistantText: string;
} | null> {
	const {
		createIncidentBundle,
		extractTurnTrace,
		synthesizeContextFromMessages,
		promptCaptureCache,
		loadCaptureFromDisk,
		getSkeletonVersion,
	} = await import("@onething/runtime");

	const session = store.getSession(options.sessionId);
	const messages = [...sessionReads.listMessages(options.sessionId).messages] as Array<{
		id: string;
		role: string;
		content?: unknown;
		toolCalls?: Array<{
			toolName?: string;
			arguments?: Record<string, unknown>;
			result?: unknown;
			status?: string;
			durationMs?: number;
		}>;
	}>;

	// Locate the turn's assistant message and its preceding user message.
	const anchorIdx = messages.findIndex(
		(m) => m.id === options.turnId && m.role === "assistant",
	);
	let userMessage = options.userMessage ?? "";
	let assistantText = "";
	if (anchorIdx >= 0) {
		assistantText =
			typeof messages[anchorIdx].content === "string"
				? (messages[anchorIdx].content as string)
				: "";
		for (let i = anchorIdx - 1; i >= 0; i--) {
			if (messages[i].role === "user") {
				userMessage =
					typeof messages[i].content === "string"
						? (messages[i].content as string)
						: userMessage;
				break;
			}
		}
	}

	const workingDirectory = session?.workingDirectory;
	const skills = getSkillsForSession(workingDirectory);
	// Capture resolution: memory LRU (fast) → disk ring (Route B, survives
	// restarts and covers ~200 turns).
	const capture =
		promptCaptureCache.get(options.turnId) ??
		loadCaptureFromDisk(options.turnId) ??
		undefined;
	const turnTrace = extractTurnTrace(messages, options.turnId);

	// Without either a capture or a locatable turn there is no scene to save.
	if (!capture && anchorIdx < 0) return null;

	// Context resolution when the capture has no request messages (never
	// captured, or slimmed by the disk ring's size cap):
	// Route A — rebuild the SEND VIEW from the persisted session jsonl
	// through the production pipeline (dehydration + compaction + image
	// handling, same code the live request went through).
	// Last resort — hand-rolled storage-view synthesis.
	let synthesizedContext: Array<Record<string, unknown>> | undefined;
	let synthesizedContextOrigin: "rebuilt" | "synthesized" = "rebuilt";
	if (!capture?.requestMessages?.length && anchorIdx >= 0) {
		try {
			const { buildHistoryMessages } = await import(
				"@onething/backend/engine/stream/message-helpers.js"
			);
			// History up to and including the turn's user message — mirrors
			// what the live request carried.
			let userIdx = anchorIdx - 1;
			while (userIdx >= 0 && messages[userIdx].role !== "user") userIdx--;
			const turnStartMessages = messages.slice(
				0,
				(userIdx >= 0 ? userIdx : anchorIdx) + 1,
			);
			const sendView = buildHistoryMessages(
				turnStartMessages as Parameters<typeof buildHistoryMessages>[0],
				{
					id: options.sessionId,
					summary: session?.summary,
					summaryUpToMessageId: session?.summaryUpToMessageId,
				},
			);
			synthesizedContext = JSON.parse(
				JSON.stringify(sendView),
			) as Array<Record<string, unknown>>;
		} catch (error) {
			log.warn("send-view rebuild failed, using storage view", undefined, error);
			synthesizedContext = synthesizeContextFromMessages(
				messages,
				options.turnId,
			);
			synthesizedContextOrigin = "synthesized";
		}
	}

	const bundle = createIncidentBundle({
		origin: options.origin,
		note: options.note,
		sessionId: options.sessionId,
		turnId: options.turnId,
		provider: session?.lastProvider ?? "unknown",
		model: session?.lastModel ?? "unknown",
		userMessage,
		assistantText,
		explicitDown: options.explicitDown,
		signals: options.signals,
		promptCapture: capture,
		turnTrace,
		synthesizedContext,
		synthesizedContextOrigin,
		fixtureContext: {
			workingDirectory,
			workingDirectoryRoots: session?.workingDirectoryRoots,
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
			toolNames: [],
			hasTools: true,
			platform: process.platform,
		},
		skeletonVersion: getSkeletonVersion(),
		storeOptions: {},
	});
	return { incidentId: bundle.incidentId, userMessage, assistantText };
}

// ── Handlers ───────────────────────────────────────────

export function registerEvalsHandlers(): void {
	// ── Phase 0/1: Downvote ──────────────────────────
	ipcMain.handle(
		IPC_CHANNELS.EVALS_RECORD_DOWNVOTE,
		async (
			_event: Electron.IpcMainInvokeEvent,
			request: EvalsRecordDownvoteRequest,
		): Promise<EvalsRecordDownvoteResponse> => {
			try {
				if (!request.sessionId || !request.turnId) {
					return { success: false, error: "Missing sessionId or turnId" };
				}

				const { recordExplicitDown } = await import("@onething/runtime");

				const session = store.getSession(request.sessionId);
				const workingDirectory = session?.workingDirectory;
				const skills = getSkillsForSession(workingDirectory);

				// The incident bundle is the human-facing artifact (scene +
				// trace + note); its creation is what makes the 👎 useful.
				const incident = await createIncidentForTurn({
					sessionId: request.sessionId,
					turnId: request.turnId,
					origin: "downvote",
					note: request.note,
					userMessage: request.userMessage,
					explicitDown: true,
				});
				const incidentRef = incident?.incidentId ?? null;
				// Server-side resolved user message (the renderer historically
				// sent the assistant content here).
				const resolvedUserMessage =
					incident?.userMessage || request.userMessage;

				// AI analysis runs asynchronously after the 👎 returns — the
				// human's only job was the one-liner; title/category/rubric are
				// the machine's job (design D5).
				if (incidentRef) {
					import("./evals-workbench.js")
						.then(({ analyzeIncidentInBackground }) =>
							analyzeIncidentInBackground(incidentRef),
						)
						.catch(() => {});
				}

				// Build assistantResponse from the DOWNVOTED message (turnId is
				// its message id) — the user may downvote an older turn, not the
				// session's latest assistant message.
				const downvotedMsg = request.turnId
					? sessionReads.getMessage(request.sessionId, request.turnId)
					: undefined;
				const lastAssistantMsg =
					downvotedMsg?.role === "assistant"
						? downvotedMsg
						: sessionReads.lastMessageOfRole(request.sessionId, "assistant");
				const assistantResponse =
					lastAssistantMsg?.content != null
						? {
								content: String(lastAssistantMsg.content),
								toolCalls: lastAssistantMsg.toolCalls?.map(
									(tc: {
										toolName?: string;
										arguments?: Record<string, unknown>;
									}) => ({
										name: tc.toolName ?? "unknown",
										args: tc.arguments,
									}),
								),
								finishReason: lastAssistantMsg.toolCalls?.length
									? "tool_calls"
									: "stop",
							}
						: undefined;

				const fixturePath = recordExplicitDown({
					turnId: request.turnId,
					sessionId: request.sessionId,
					incidentRef,
					assistantResponse,
					providerId: session?.lastProvider ?? "unknown",
					model: session?.lastModel ?? "unknown",
					userMessage: resolvedUserMessage,
					workingDirectory,
					workingDirectoryRoots: session?.workingDirectoryRoots,
					skills,
					hasTools: true,
					storeOptions: {},
				});

				return { success: true, fixturePath, incidentId: incidentRef ?? undefined };
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				log.error("downvote recording failed", undefined, error);
				return { success: false, error: message };
			}
		},
	);

	// ── Phase 1: List Records ────────────────────────
	ipcMain.handle(
		IPC_CHANNELS.EVALS_LIST_RECORDS,
		async (
			_event: Electron.IpcMainInvokeEvent,
			request: EvalsListRecordsRequest,
		): Promise<EvalsListRecordsResponse> => {
			try {
				const { loadMergedRecords, recordHasNegative } = await import(
					"@onething/runtime"
				);

				let records = loadMergedRecords();

				// Filter: negative only (default true for review)
				if (request.negativeOnly !== false) {
					records = records.filter(recordHasNegative);
				}

				// Filter: category
				if (request.category) {
					records = records.filter(
						(r) => r.judge?.category === request.category,
					);
				}

				// Filter: since timestamp
				if (request.sinceTs) {
					const since = new Date(request.sinceTs).getTime();
					records = records.filter((r) => new Date(r.ts).getTime() >= since);
				}

				const total = records.length;

				// Apply offset/limit
				const offset = request.offset ?? 0;
				const limit = request.limit ?? 50;
				const page = records
					.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
					.slice(offset, offset + limit);

				// Convert to view models; the user-message preview comes from the
				// exported fixture (only read for the current page, so cost stays
				// bounded by the page size).
				const views: TurnEvalRecordView[] = page.map((r) => ({
					...r,
					hasFixture: !!r.fixtureRef,
					userMessagePreview: readUserMessagePreview(r.fixtureRef),
				}));

				return { success: true, records: views, total };
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				log.error("list records failed", undefined, error);
				return { success: false, error: message };
			}
		},
	);

	// ── Phase 1: List Fixtures ───────────────────────
	ipcMain.handle(
		IPC_CHANNELS.EVALS_LIST_FIXTURES,
		async (): Promise<EvalsListFixturesResponse> => {
			try {
				const fixtures: EvalFixtureMeta[] = [];
				const autoDir = getEvalsFixturesAutoDir();
				const repoDir = getRepoDir();

				// Auto fixtures (user data dir)
				scanFixturesDir(autoDir, fixtures);

				// Manual fixtures (repo dir, if configured)
				if (repoDir) {
					const manualDir = getEvalsFixturesDir(repoDir);
					if (manualDir !== autoDir) {
						scanFixturesDir(manualDir, fixtures);
					}
				}

				fixtures.sort(
					(a, b) =>
						new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime(),
				);

				return { success: true, fixtures };
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				log.error("list fixtures failed", undefined, error);
				return { success: false, error: message };
			}
		},
	);

	// ── S3: Read Snapshot (.prompt.json / .context.jsonl) ──
	ipcMain.handle(
		IPC_CHANNELS.EVALS_READ_SNAPSHOT,
		async (
			_event: Electron.IpcMainInvokeEvent,
			request: EvalsReadSnapshotRequest,
		): Promise<EvalsReadSnapshotResponse> => {
			try {
				if (!request.path) {
					return { success: false, error: "Path required" };
				}
				if (!fs.existsSync(request.path)) {
					return { success: false, error: "Snapshot file not found" };
				}

				const isPrompt = request.path.endsWith(".prompt.json");
				const isContext = request.path.endsWith(".context.jsonl");
				if (!isPrompt && !isContext) {
					return { success: false, error: "Unknown snapshot type" };
				}

				if (isPrompt) {
					const content = fs.readFileSync(request.path, "utf-8");
					const promptSnapshot = JSON.parse(content);
					return {
						success: true,
						snapshotType: "prompt",
						promptSnapshot,
					};
				}

				// Context: read jsonl with pagination
				if (isContext) {
					const raw = fs.readFileSync(request.path, "utf-8");
					const allLines = raw.split("\n").filter(Boolean);
					// First line is header, rest are messages
					const messages: ContextSnapshotMessage[] = [];
					for (const line of allLines.slice(1)) {
						try {
							const parsed = JSON.parse(line);
							if (parsed.m) {
								messages.push(parsed.m as ContextSnapshotMessage);
							}
						} catch {
							// skip bad lines
						}
					}
					const offset = request.offset ?? 0;
					const limit = request.limit ?? 50;
					const page = messages.slice(offset, offset + limit);
					return {
						success: true,
						snapshotType: "context",
						contextMessages: page,
						total: messages.length,
						hasMore: offset + limit < messages.length,
					};
				}

				return { success: false, error: "Unreachable" };
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				return { success: false, error: message };
			}
		},
	);

	// ── Phase 1: Read Fixture ────────────────────────
	ipcMain.handle(
		IPC_CHANNELS.EVALS_READ_FIXTURE,
		async (
			_event: Electron.IpcMainInvokeEvent,
			request: EvalsReadFixtureRequest,
		): Promise<EvalsReadFixtureResponse> => {
			try {
				if (!fs.existsSync(request.fixturePath)) {
					return { success: false, error: "Fixture file not found" };
				}
				const content = fs.readFileSync(request.fixturePath, "utf-8");
				const fixture = JSON.parse(content);
				return { success: true, fixture };
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				log.error("read fixture failed", undefined, error);
				return { success: false, error: message };
			}
		},
	);

	// ── Phase 1: List Results ────────────────────────
	ipcMain.handle(
		IPC_CHANNELS.EVALS_LIST_RESULTS,
		async (): Promise<EvalsListResultsResponse> => {
			try {
				const repoDir = getRepoDir();
				if (!repoDir) {
					return { success: true, entries: [] };
				}

				const resultsPath = getResultsPath(repoDir);
				if (!fs.existsSync(resultsPath)) {
					return { success: true, entries: [] };
				}

				const content = fs.readFileSync(resultsPath, "utf-8").trim();
				if (!content) {
					return { success: true, entries: [] };
				}

				const entries: EvalRunResultEntry[] = content
					.split("\n")
					.filter(Boolean)
					.map((line) => {
						try {
							return JSON.parse(line) as EvalRunResultEntry;
						} catch {
							return null;
						}
					})
					.filter((e): e is EvalRunResultEntry => e !== null);

				return { success: true, entries };
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				log.error("list results failed", undefined, error);
				return { success: false, error: message };
			}
		},
	);

	// ── Phase 2: List Cases ──────────────────────────
	ipcMain.handle(
		IPC_CHANNELS.EVALS_LIST_CASES,
		async (): Promise<EvalsListCasesResponse> => {
			try {
				const repoDir = getRepoDir();
				if (!repoDir) {
					return { success: true, cases: [] };
				}

				const allCases = await loadAllCases(repoDir);

				return { success: true, cases: allCases };
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				log.error("list cases failed", undefined, error);
				return { success: false, error: message };
			}
		},
	);

	// ── Phase 2: Get Case ────────────────────────────
	ipcMain.handle(
		IPC_CHANNELS.EVALS_GET_CASE,
		async (
			_event: Electron.IpcMainInvokeEvent,
			request: EvalsGetCaseRequest,
		): Promise<EvalsGetCaseResponse> => {
			try {
				const repoDir = getRepoDir();
				if (!repoDir) {
					return { success: false, error: "Evals repo not configured" };
				}

				const cases = await loadAllCases(repoDir);
				const found = cases.find((c) => c.id === request.caseId);
				if (!found) {
					return { success: false, error: "Case not found" };
				}

				return { success: true, case_: found };
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				log.error("get case failed", undefined, error);
				return { success: false, error: message };
			}
		},
	);

	// ── Phase 2: Run Start ───────────────────────────
	ipcMain.handle(
		IPC_CHANNELS.EVALS_RUN_START,
		async (
			event: Electron.IpcMainInvokeEvent,
			request: EvalsRunStartRequest,
		): Promise<EvalsRunStartResponse> => {
			try {
				log.debug("run start received", {
					provider: request.providerId,
					model: request.model,
					runs: request.runs,
					caseIds: request.caseIds?.length ?? 0,
					disabledSections: request.disabledSections,
				});
				if (activeRunAbort) {
					log.warn("run start blocked", { reason: "run already in progress" });
					return { success: false, error: "A run is already in progress" };
				}

				const repoDir = getRepoDir();
				log.debug("repo dir resolved", { repoDir });
				if (!repoDir) {
					log.warn("run start blocked", { reason: "no repo dir" });
					return { success: false, error: "Evals repo not configured" };
				}

				// Fail fast if the provider can't serve eval calls, instead of
				// launching a run where every attempt throws and a zero-score
				// entry pollutes results.jsonl.
				const credentials = resolveEvalsCredentials(request.providerId);
				log.debug("credentials check", {
					ok: credentials.ok,
					reason: credentials.ok ? undefined : credentials.reason,
				});
				if (!credentials.ok) {
					return { success: false, error: credentials.reason };
				}

				const senderWindow = BrowserWindow.fromWebContents(event.sender);
				if (!senderWindow) {
					log.warn("run start blocked", { reason: "no sender window" });
					return { success: false, error: "No sender window" };
				}

				const abortController = new AbortController();
				activeRunAbort = abortController;

				log.info("background run launching", { provider: request.providerId, model: request.model });
				// Fire and forget — progress is sent via push events
				runEvalsInBackground(
					repoDir,
					request,
					abortController,
					senderWindow,
				).catch((err) => {
					log.error("background run failed", undefined, err);
				});

				log.debug("run start accepted");
				return { success: true };
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				log.error("run start failed", undefined, error);
				return { success: false, error: message };
			}
		},
	);

	// ── Phase 2: Run Cancel ──────────────────────────
	ipcMain.handle(
		IPC_CHANNELS.EVALS_RUN_CANCEL,
		async (): Promise<EvalsRunCancelResponse> => {
			if (activeRunAbort) {
				// Only signal — the background run's finally clears activeRunAbort
				// once it has actually exited. Clearing here would let a second run
				// start while the first is still writing progress/results.
				activeRunAbort.abort();
				return { success: true };
			}
			return { success: false, error: "No run in progress" };
		},
	);

	// ── Phase 3: Promote Fixture ─────────────────────
	ipcMain.handle(
		IPC_CHANNELS.EVALS_PROMOTE_FIXTURE,
		async (
			_event: Electron.IpcMainInvokeEvent,
			request: EvalsPromoteFixtureRequest,
		): Promise<EvalsPromoteFixtureResponse> => {
			try {
				const repoDir = getRepoDir();
				if (!repoDir) {
					return { success: false, error: "Evals repo not configured" };
				}

				// Read the fixture
				if (!fs.existsSync(request.fixturePath)) {
					return { success: false, error: "Fixture file not found" };
				}
				const fixtureContent = fs.readFileSync(request.fixturePath, "utf-8");
				const fixture = JSON.parse(fixtureContent);

				// Copy fixture to repo evals/fixtures/
				const repoFixturesDir = getEvalsFixturesDir(repoDir);
				fs.mkdirSync(repoFixturesDir, { recursive: true });
				const fixtureFilename = path.basename(request.fixturePath);
				const destFixturePath = path.join(repoFixturesDir, fixtureFilename);
				if (!fs.existsSync(destFixturePath)) {
					fs.copyFileSync(request.fixturePath, destFixturePath);
				}

				// Optionally copy .context.jsonl for multi-turn replay
				let contextRef: string | undefined;
				if (request.includeContext) {
					const baseName = fixtureFilename.replace(/\.json$/, "");
					const contextSrc = path.join(
						path.dirname(request.fixturePath),
						`${baseName}.context.jsonl`,
					);
					if (fs.existsSync(contextSrc)) {
						const contextDest = path.join(
							repoFixturesDir,
							path.basename(contextSrc),
						);
						if (!fs.existsSync(contextDest)) {
							fs.copyFileSync(contextSrc, contextDest);
						}
						contextRef = path.basename(contextSrc);
					}
				}

				// Generate case YAML via the shared runtime generator
				const { generateCaseYaml } = await import("@onething/runtime");
				const expect: Record<string, unknown> = {};
				const e = request.expect;
				// Tool Call
				if (e.firstToolCall) expect.firstToolCall = e.firstToolCall;
				if (e.lastToolCall) expect.lastToolCall = e.lastToolCall;
				if (e.hasToolCalls !== undefined) expect.hasToolCalls = e.hasToolCalls;
				if (e.toolCallContains) expect.toolCallContains = e.toolCallContains;
				if (e.noToolCalls) expect.noToolCalls = e.noToolCalls;
				if (e.toolCallCount) expect.toolCallCount = e.toolCallCount;
				// Skill
				if (e.skillUsed) expect.skillUsed = e.skillUsed;
				if (e.anySkillUsed !== undefined) expect.anySkillUsed = e.anySkillUsed;
				// MCP
				if (e.mcpToolUsed !== undefined) expect.mcpToolUsed = e.mcpToolUsed;
				if (e.mcpServerUsed) expect.mcpServerUsed = e.mcpServerUsed;
				if (e.mcpToolUsedName) expect.mcpToolUsedName = e.mcpToolUsedName;
				// Output
				if (e.contains) expect.contains = e.contains;
				if (e.notContains) expect.notContains = e.notContains;
				if (e.minOutputLength !== undefined)
					expect.minOutputLength = e.minOutputLength;
				if (e.maxOutputLength !== undefined)
					expect.maxOutputLength = e.maxOutputLength;
				if (e.outputStartsWith) expect.outputStartsWith = e.outputStartsWith;
				if (e.outputEndsWith) expect.outputEndsWith = e.outputEndsWith;
				if (e.regex) expect.regex = e.regex;
				if (e.notes) expect.notes = e.notes;

				const yaml = generateCaseYaml({
					id: request.caseId,
					description: request.description,
					fixture: fixtureFilename,
					context: contextRef,
					userMessage: fixture.userMessage || "",
					expect,
				});

				const casesDir = getEvalsCasesDir(repoDir);
				fs.mkdirSync(casesDir, { recursive: true });
				const casePath = path.join(casesDir, `${request.caseId}.yaml`);
				fs.writeFileSync(casePath, yaml, "utf-8");

				return { success: true, casePath };
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				log.error("promote fixture failed", undefined, error);
				return { success: false, error: message };
			}
		},
	);

	// ── Phase 3: Retire Case ─────────────────────────
	ipcMain.handle(
		IPC_CHANNELS.EVALS_RETIRE_CASE,
		async (
			_event: Electron.IpcMainInvokeEvent,
			request: EvalsRetireCaseRequest,
		): Promise<EvalsRetireCaseResponse> => {
			try {
				const repoDir = getRepoDir();
				if (!repoDir) {
					return { success: false, error: "Evals repo not configured" };
				}

				const casesDir = getEvalsCasesDir(repoDir);
				const casePath = path.join(casesDir, `${request.caseId}.yaml`);
				if (!fs.existsSync(casePath)) {
					return { success: false, error: "Case file not found" };
				}

				const sentinelDir = path.join(casesDir, "sentinel");
				fs.mkdirSync(sentinelDir, { recursive: true });
				const newPath = path.join(sentinelDir, `${request.caseId}.yaml`);
				fs.renameSync(casePath, newPath);

				return { success: true, newPath };
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				log.error("retire case failed", undefined, error);
				return { success: false, error: message };
			}
		},
	);

	// ── Phase 3: Generate Triage ─────────────────────
	ipcMain.handle(
		IPC_CHANNELS.EVALS_GENERATE_TRIAGE,
		async (
			_event: Electron.IpcMainInvokeEvent,
			request: EvalsGenerateTriageRequest,
		): Promise<EvalsGenerateTriageResponse> => {
			try {
				const repoDir = getRepoDir();
				if (!repoDir) {
					return { success: false, error: "Evals repo not configured" };
				}

				const {
					loadMergedRecords,
					filterRecordsByWeeks,
					generateTriageReport,
				} = await import("@onething/runtime");

				const records = loadMergedRecords();
				const filtered = filterRecordsByWeeks(records, request.weeks ?? 1);
				const report = generateTriageReport(filtered);

				const triagePath = getTriagePath(repoDir);
				if (fs.existsSync(triagePath)) {
					const existing = fs.readFileSync(triagePath, "utf-8");
					const updated = existing.replace(
						/## Current Week:.*/,
						`## Current Week: ${new Date().toISOString().slice(0, 10)}`,
					);
					fs.writeFileSync(triagePath, updated + "\n" + report, "utf-8");
				} else {
					fs.writeFileSync(
						triagePath,
						`# Evals Triage Ledger\n\n${report}`,
						"utf-8",
					);
				}

				return { success: true, report, triagePath };
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				log.error("generate triage failed", undefined, error);
				return { success: false, error: message };
			}
		},
	);

	// ── Read Run Detail ─────────────────────────────
	ipcMain.handle(
		IPC_CHANNELS.EVALS_READ_RUN_DETAIL,
		async (
			_event: Electron.IpcMainInvokeEvent,
			request: EvalsReadRunDetailRequest,
		): Promise<EvalsReadRunDetailResponse> => {
			try {
				const repoDir = getRepoDir();
				if (!repoDir) {
					return { success: false, error: "Evals repo not configured" };
				}
				const fullPath = path.join(repoDir, request.detailPath);
				if (!fs.existsSync(fullPath)) {
					return { success: false, error: "Run detail file not found" };
				}
				const detail = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
				return { success: true, detail };
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				log.error("read run detail failed", undefined, error);
				return { success: false, error: message };
			}
		},
	);

	registerEvalsWorkbenchHandlers();

	log.info("handlers registered");
}

// ── Helper functions ────────────────────────────────────

function readUserMessagePreview(fixtureRef: string | null): string {
	if (!fixtureRef) return "";
	try {
		const fixture = JSON.parse(fs.readFileSync(fixtureRef, "utf-8"));
		return String(fixture.userMessage ?? "").slice(0, 120);
	} catch {
		return "";
	}
}

function scanFixturesDir(dir: string, out: EvalFixtureMeta[]): void {
	if (!fs.existsSync(dir)) return;
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const filePath = path.join(dir, entry.name);
		try {
			const content = fs.readFileSync(filePath, "utf-8");
			const fixture = JSON.parse(content);
			out.push({
				path: filePath,
				capturedAt: fixture.capturedAt ?? "",
				provider: fixture.provider ?? "unknown",
				model: fixture.model ?? "unknown",
				sessionId: fixture.sessionRef?.sessionId ?? "",
				turnId: fixture.sessionRef?.turnId ?? "",
				userMessagePreview:
					(fixture.userMessage ?? "").slice(0, 120) || "(no user message)",
				hasNegative: true, // auto fixtures are only created for negative signals
			});
		} catch {
			// Skip unparseable files
		}
	}
}

/**
 * Case YAML parsing/generation lives in @onething/runtime (case-file.ts) —
 * a single implementation shared with the CLI runner, per design §7 (the
 * mini-YAML parser and generator must not drift between consumers).
 */
type ParseCaseYamlFn = (content: string) => {
	id: string;
	description: string;
	fixture: string;
	userMessage: string;
	expect: Record<string, unknown>;
};

function scanCasesDir(
	dir: string,
	isSentinel: boolean,
	out: EvalCaseMeta[],
	parseCaseYaml: ParseCaseYamlFn,
): void {
	if (!fs.existsSync(dir)) return;
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		// Flat legacy cases (<id>.yaml) and promoted bundle cases (<id>/case.yaml)
		let filePath: string | null = null;
		let fileLabel = "";
		if (entry.isFile() && entry.name.endsWith(".yaml")) {
			filePath = path.join(dir, entry.name);
			fileLabel = entry.name;
		} else if (entry.isDirectory() && entry.name !== "sentinel") {
			const bundleCase = path.join(dir, entry.name, "case.yaml");
			if (fs.existsSync(bundleCase)) {
				filePath = bundleCase;
				fileLabel = `${entry.name}/case.yaml`;
			}
		}
		if (!filePath) continue;
		try {
			const parsed = parseCaseYaml(fs.readFileSync(filePath, "utf-8"));
			out.push({
				id: parsed.id || fileLabel.replace(/\/?case\.yaml$|\.yaml$/, ""),
				file: fileLabel,
				dir,
				description: parsed.description || "",
				fixture: parsed.fixture || "",
				userMessage: parsed.userMessage || "",
				isSentinel,
				expect: parsed.expect || {},
			});
		} catch {
			// Skip unparseable files
		}
	}
}

async function loadAllCases(repoDir: string): Promise<EvalCaseMeta[]> {
	const { parseCaseYaml } = await import("@onething/runtime");
	const casesDir = getEvalsCasesDir(repoDir);
	const sentinelDir = path.join(casesDir, "sentinel");
	const allCases: EvalCaseMeta[] = [];
	scanCasesDir(casesDir, false, allCases, parseCaseYaml);
	scanCasesDir(sentinelDir, true, allCases, parseCaseYaml);
	return allCases;
}

// ── Background Run (delegates to runner.ts) ─────────────

async function runEvalsInBackground(
	repoDir: string,
	request: EvalsRunStartRequest,
	abortController: AbortController,
	window: BrowserWindow,
): Promise<void> {
	const emitProgress = (event: EvalsRunProgressEvent) => {
		// Persist run detail on run-done (adapter responsibility, not runner)
		if (event.type === "run-done" && event.detail?.cases) {
			try {
				const runsDir = path.join(repoDir, "evals", "runs");
				fs.mkdirSync(runsDir, { recursive: true });
				const ts = event.entry?.ts ?? new Date().toISOString();
				const filename = `${ts.replace(/[:.]/g, "-")}.json`;
				const detailPath = path.join(runsDir, filename);
				fs.writeFileSync(
					detailPath,
					JSON.stringify(
						{
							version: 1,
							ts,
							provider: event.entry?.provider,
							model: event.entry?.model,
							runs: event.entry?.runs,
							cases: event.detail.cases,
						},
						null,
						2,
					),
					"utf-8",
				);
			} catch (err) {
				log.error("persist run detail failed", undefined, err);
			}
		}

		// Strip detail before sending to renderer (too large for IPC)
		const { detail: _, ...cleanEvent } = event;
		window.webContents.send(IPC_CHANNELS.EVALS_RUN_PROGRESS, cleanEvent);
	};

	try {
		const { runEvals } = await import("@onething/runtime");

		const callModel = createEvalsModelCaller(request.providerId, request.model);

		await runEvals({
			repoDir,
			caseIds: request.caseIds,
			runs: request.runs,
			disabledSections: request.disabledSections,
			includeSentinel: false,
			callModel,
			providerLabel: request.providerId,
			modelLabel: request.model,
			signal: abortController.signal,
			onProgress: emitProgress,
		});
	} catch (error) {
		emitProgress({
			type: "error",
			error: error instanceof Error ? error.message : "Unknown error",
		});
	} finally {
		activeRunAbort = null;
	}
}
