/**
 * Evals Workbench IPC (incident-centric, design W1-W5).
 *
 * Incidents: list/get/update/read-file.
 * Replay: mock agent-loop replay of an incident scene with live progress.
 * Analysis: AI incident summarization + rubric extraction.
 * Promote: incident → self-contained regression case bundle in the repo.
 * Diagnosis: reproduce + context check + ablation matrix + report.
 */

import { ipcMain, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import type {
	EvalsRoundListRequest,
	EvalsRoundListResponse,
	EvalsRoundView,
	EvalsRoundReplayRequest,
	EvalsRoundReplayResponse,
	EvalsIncidentListResponse,
	EvalsIncidentGetRequest,
	EvalsIncidentGetResponse,
	EvalsIncidentUpdateRequest,
	EvalsIncidentUpdateResponse,
	EvalsIncidentReadFileRequest,
	EvalsIncidentReadFileResponse,
	EvalsReplayStartRequest,
	EvalsReplayStartResponse,
	EvalsReplayProgressEvent,
	EvalsIncidentAnalyzeRequest,
	EvalsIncidentAnalyzeResponse,
	EvalsIncidentPromoteRequest,
	EvalsIncidentPromoteResponse,
	EvalsDiagnoseStartRequest,
	EvalsDiagnoseStartResponse,
	EvalsDiagnoseProgressEvent,
	EvalsIncidentMetaDTO,
	EvalsIncidentRunSummary,
} from "@shared/ipc.js";
import { IPC_CHANNELS } from "@shared/ipc.js";
import * as store from "@onething/app/store.js";
import {
	createEvalsModelCaller,
	resolveEvalsCredentials,
} from "./evals-provider-adapter.js";
import { getLogger } from "@onething/app/logging/index.js";

const log = getLogger("ipc.evals-workbench");

const READ_FILE_MAX_BYTES = 4 * 1024 * 1024;

// Single-flight per incident for replay/diagnosis
const activeOps = new Map<string, AbortController>();

function getAnalysisModelConfig(): { providerId: string; model: string } {
	const settings = store.getSettings();
	const configured = (settings as { evals?: { analysisModel?: { providerId: string; model: string } } })
		?.evals?.analysisModel;
	return configured ?? { providerId: "deepseek", model: "deepseek-v4-pro" };
}

/**
 * Resolve the analysis model caller (judge/summary/simulation). Falls back
 * to the replay provider when the configured analysis provider has no
 * credentials.
 */
async function resolveAnalysis(fallbackProviderId?: string, fallbackModel?: string) {
	let { providerId, model } = getAnalysisModelConfig();
	if (!resolveEvalsCredentials(providerId).ok && fallbackProviderId) {
		providerId = fallbackProviderId;
		model = fallbackModel ?? model;
	}
	if (!resolveEvalsCredentials(providerId).ok) return null;
	return { callModel: createEvalsModelCaller(providerId, model), model };
}

function sendToAll(channel: string, payload: unknown): void {
	for (const win of BrowserWindow.getAllWindows()) {
		try {
			win.webContents.send(channel, payload);
		} catch {
			// Window may be closing
		}
	}
}

function listRunSummaries(incidentDir: string): EvalsIncidentRunSummary[] {
	const runsDir = path.join(incidentDir, "runs");
	if (!fs.existsSync(runsDir)) return [];
	const summaries: EvalsIncidentRunSummary[] = [];
	for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const runDir = path.join(runsDir, entry.name);
		let runJson: Record<string, unknown> = {};
		try {
			runJson = JSON.parse(
				fs.readFileSync(path.join(runDir, "run.json"), "utf-8"),
			);
		} catch {
			// run may be in progress or legacy
		}
		const attemptFiles = fs
			.readdirSync(runDir)
			.filter((f) => f.endsWith(".jsonl"))
			.sort();
		summaries.push({
			runId: entry.name,
			startedAt: String(runJson.startedAt ?? ""),
			kind: (runJson.kind as "replay" | "diagnosis") ?? "replay",
			attempts: Number(runJson.attempts ?? attemptFiles.length),
			passes: Number(runJson.passes ?? 0),
			disabledSections: runJson.disabledSections as string[] | undefined,
			attemptFiles,
		});
	}
	summaries.sort((a, b) => (a.runId < b.runId ? 1 : -1));
	return summaries;
}

export function registerEvalsWorkbenchHandlers(): void {
	// ── Incidents ────────────────────────────────────
	ipcMain.handle(
		IPC_CHANNELS.EVALS_INCIDENT_LIST,
		async (): Promise<EvalsIncidentListResponse> => {
			try {
				const { listIncidents } = await import("@onething/runtime");
				return {
					success: true,
					incidents: listIncidents({ limit: 200 }) as unknown as EvalsIncidentMetaDTO[],
				};
			} catch (error) {
				return { success: false, error: errorMessage(error) };
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.EVALS_INCIDENT_GET,
		async (
			_event,
			request: EvalsIncidentGetRequest,
		): Promise<EvalsIncidentGetResponse> => {
			try {
				const { readIncident, getIncidentDir } = await import(
					"@onething/runtime"
				);
				const incident = readIncident(request.incidentId);
				if (!incident) return { success: false, error: "Incident not found" };
				const dir = getIncidentDir(request.incidentId);
				let markdown = "";
				try {
					markdown = fs.readFileSync(path.join(dir, "incident.md"), "utf-8");
				} catch {
					// cover may be missing
				}
				return {
					success: true,
					incident: incident as unknown as EvalsIncidentMetaDTO,
					markdown,
					runs: listRunSummaries(dir),
				};
			} catch (error) {
				return { success: false, error: errorMessage(error) };
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.EVALS_INCIDENT_UPDATE,
		async (
			_event,
			request: EvalsIncidentUpdateRequest,
		): Promise<EvalsIncidentUpdateResponse> => {
			try {
				const { updateIncident } = await import("@onething/runtime");
				const incident = updateIncident(
					request.incidentId,
					request.patch as never,
				);
				if (!incident) return { success: false, error: "Incident not found" };
				return {
					success: true,
					incident: incident as unknown as EvalsIncidentMetaDTO,
				};
			} catch (error) {
				return { success: false, error: errorMessage(error) };
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.EVALS_INCIDENT_READ_FILE,
		async (
			_event,
			request: EvalsIncidentReadFileRequest,
		): Promise<EvalsIncidentReadFileResponse> => {
			try {
				const { getIncidentDir } = await import("@onething/runtime");
				const dir = getIncidentDir(request.incidentId);
				const resolved = path.resolve(dir, request.relativePath);
				// Path containment guard
				if (!resolved.startsWith(path.resolve(dir) + path.sep)) {
					return { success: false, error: "Path escapes incident bundle" };
				}
				if (!fs.existsSync(resolved)) {
					return { success: false, error: "File not found" };
				}
				const stat = fs.statSync(resolved);
				if (stat.size > READ_FILE_MAX_BYTES) {
					return { success: false, error: "File too large to display" };
				}
				return { success: true, content: fs.readFileSync(resolved, "utf-8") };
			} catch (error) {
				return { success: false, error: errorMessage(error) };
			}
		},
	);

	// ── Replay ───────────────────────────────────────
	ipcMain.handle(
		IPC_CHANNELS.EVALS_REPLAY_START,
		async (
			_event,
			request: EvalsReplayStartRequest,
		): Promise<EvalsReplayStartResponse> => {
			try {
				if (activeOps.has(request.incidentId)) {
					return {
						success: false,
						error: "An operation is already running for this incident",
					};
				}
				const runtime = await import("@onething/runtime");
				const incident = runtime.readIncident(request.incidentId);
				if (!incident) return { success: false, error: "Incident not found" };
				const scene = runtime.loadSceneFromIncident(request.incidentId);
				if (!scene) {
					return { success: false, error: "Incident has no replayable scene" };
				}

				const providerId =
					request.providerId || scene.params.provider || "deepseek";
				const model = request.model || scene.params.model || "deepseek-v4-pro";
				const credentials = resolveEvalsCredentials(providerId);
				if (!credentials.ok) {
					return { success: false, error: credentials.reason };
				}
				const callModel = createEvalsModelCaller(providerId, model);
				const analysis = await resolveAnalysis(providerId, model);
				const rubric = incident.rubric || incident.note;
				const simulateTool = analysis
					? runtime.createAiToolSimulator(analysis)
					: undefined;

				const runId = `replay-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
				const abort = new AbortController();
				activeOps.set(request.incidentId, abort);

				void runReplayInBackground({
					runtime,
					incident,
					scene,
					request,
					runId,
					callModel,
					analysis,
					rubric,
					simulateTool,
					abort,
				}).finally(() => activeOps.delete(request.incidentId));

				return { success: true, runId };
			} catch (error) {
				activeOps.delete(request.incidentId);
				return { success: false, error: errorMessage(error) };
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.EVALS_REPLAY_CANCEL,
		async (_event, request: { incidentId: string }) => {
			const abort = activeOps.get(request.incidentId);
			if (!abort) return { success: false, error: "No operation in progress" };
			abort.abort();
			return { success: true };
		},
	);

	// ── AI analysis ──────────────────────────────────
	ipcMain.handle(
		IPC_CHANNELS.EVALS_INCIDENT_ANALYZE,
		async (
			_event,
			request: EvalsIncidentAnalyzeRequest,
		): Promise<EvalsIncidentAnalyzeResponse> => {
			try {
				const runtime = await import("@onething/runtime");
				const updated = await analyzeIncidentById(runtime, request.incidentId);
				if (!updated.ok) return { success: false, error: updated.error };
				return {
					success: true,
					incident: updated.incident as unknown as EvalsIncidentMetaDTO,
				};
			} catch (error) {
				return { success: false, error: errorMessage(error) };
			}
		},
	);

	// ── Promote to regression case ───────────────────
	ipcMain.handle(
		IPC_CHANNELS.EVALS_INCIDENT_PROMOTE,
		async (
			_event,
			request: EvalsIncidentPromoteRequest,
		): Promise<EvalsIncidentPromoteResponse> => {
			try {
				const runtime = await import("@onething/runtime");
				const { getRepoDirForEvals } = await import("./evals.js");
				const repoDir = getRepoDirForEvals();
				if (!repoDir) {
					return { success: false, error: "Evals repo not configured" };
				}
				const incident = runtime.readIncident(request.incidentId);
				if (!incident) return { success: false, error: "Incident not found" };

				const caseId = request.caseId.replace(/[^a-zA-Z0-9_-]/g, "-");
				const caseDir = path.join(repoDir, "evals", "cases", caseId);
				fs.mkdirSync(caseDir, { recursive: true });

				// Self-contained: copy the whole scene into the repo case bundle
				const sceneSrc = path.join(
					runtime.getIncidentDir(request.incidentId),
					"scene",
				);
				const sceneDst = path.join(caseDir, "scene");
				fs.cpSync(sceneSrc, sceneDst, { recursive: true });

				const rubric = incident.rubric || incident.note || "";
				const yaml = [
					`# Promoted from incident ${incident.id}`,
					`id: ${caseId}`,
					`description: >`,
					`  ${(request.description || incident.title).replace(/\n/g, "\n  ")}`,
					`incidentRef: ${incident.id}`,
					`scene: scene`,
					...(rubric ? [`rubric: >`, `  ${rubric.replace(/\n/g, "\n  ")}`] : []),
					`userMessage: >`,
					`  ${incident.userMessage.replace(/\n/g, "\n  ")}`,
					`expect:`,
					`  # judged by rubric via replay engine`,
					"",
				].join("\n");
				const casePath = path.join(caseDir, "case.yaml");
				fs.writeFileSync(casePath, yaml, "utf-8");

				runtime.updateIncident(request.incidentId, {
					status: "case-created",
					caseId,
				});

				return { success: true, casePath };
			} catch (error) {
				return { success: false, error: errorMessage(error) };
			}
		},
	);

	// ── Per-round tracing (L1) ───────────────────────
	ipcMain.handle(
		IPC_CHANNELS.EVALS_ROUND_LIST,
		async (
			_event,
			request: EvalsRoundListRequest,
		): Promise<EvalsRoundListResponse> => {
			try {
				const runtime = await import("@onething/runtime");
				const incident = runtime.readIncident(request.incidentId);
				if (!incident) return { success: false, error: "Incident not found" };

				// Bundle copy first (survives ring rollover), live trace second.
				const bundleRoundsDir = path.join(
					runtime.getIncidentDir(request.incidentId),
					"scene",
					"rounds",
				);
				const rounds = fs.existsSync(bundleRoundsDir)
					? runtime.readTraceRoundsFromDir(bundleRoundsDir)
					: runtime.readTraceRounds(incident.sessionId, incident.turnId);

				const views: EvalsRoundView[] = rounds.map((r) => ({
					round: r.round,
					ts: r.ts,
					purpose: r.purpose,
					requestMessages: r.request.messages,
					model: r.request.model,
					temperature: r.request.temperature,
					toolNames: (r.request.tools ?? []).map((t) => t.name),
					responseContent: extractResponseText(r.response.message),
					responseToolCalls: extractResponseToolCalls(r.response.message),
					finishReason: r.response.finishReason,
					incomplete: r.incomplete,
				}));
				return { success: true, rounds: views };
			} catch (error) {
				return { success: false, error: errorMessage(error) };
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.EVALS_ROUND_REPLAY,
		async (
			_event,
			request: EvalsRoundReplayRequest,
		): Promise<EvalsRoundReplayResponse> => {
			try {
				const runtime = await import("@onething/runtime");
				const incident = runtime.readIncident(request.incidentId);
				if (!incident) return { success: false, error: "Incident not found" };

				const bundleRoundsDir = path.join(
					runtime.getIncidentDir(request.incidentId),
					"scene",
					"rounds",
				);
				const rounds = fs.existsSync(bundleRoundsDir)
					? runtime.readTraceRoundsFromDir(bundleRoundsDir)
					: runtime.readTraceRounds(incident.sessionId, incident.turnId);
				const roundData = rounds.find((r) => r.round === request.round);
				if (!roundData) {
					return { success: false, error: `Round ${request.round} not traced` };
				}

				const providerId = request.providerId || incident.provider;
				const credentials = resolveEvalsCredentials(providerId);
				if (!credentials.ok) {
					return { success: false, error: credentials.reason };
				}
				const callModel = createEvalsModelCaller(
					providerId,
					request.model || roundData.request.model,
				);

				const result = await runtime.replayRound({
					roundData,
					callModel,
					runs: request.runs,
					editedMessages: request.editedMessages,
				});
				return {
					success: true,
					attempts: result.attempts,
					edited: result.edited,
				};
			} catch (error) {
				return { success: false, error: errorMessage(error) };
			}
		},
	);

	// ── Diagnosis ────────────────────────────────────
	ipcMain.handle(
		IPC_CHANNELS.EVALS_DIAGNOSE_START,
		async (
			_event,
			request: EvalsDiagnoseStartRequest,
		): Promise<EvalsDiagnoseStartResponse> => {
			try {
				if (activeOps.has(request.incidentId)) {
					return {
						success: false,
						error: "An operation is already running for this incident",
					};
				}
				const runtime = await import("@onething/runtime");
				const incident = runtime.readIncident(request.incidentId);
				if (!incident) return { success: false, error: "Incident not found" };
				const scene = runtime.loadSceneFromIncident(request.incidentId);
				if (!scene) {
					return { success: false, error: "Incident has no replayable scene" };
				}

				const providerId = scene.params.provider || "deepseek";
				const model = scene.params.model || "deepseek-v4-pro";
				const credentials = resolveEvalsCredentials(providerId);
				if (!credentials.ok) {
					return { success: false, error: credentials.reason };
				}
				const analysis = await resolveAnalysis(providerId, model);
				if (!analysis) {
					return {
						success: false,
						error: "No analysis model available for judging",
					};
				}

				const abort = new AbortController();
				activeOps.set(request.incidentId, abort);

				void (async () => {
					const push = (payload: EvalsDiagnoseProgressEvent) =>
						sendToAll(IPC_CHANNELS.EVALS_DIAGNOSE_PROGRESS, payload);
					try {
						// Rubric is required for judging — auto-run analysis first
						if (!incident.rubric && !incident.note) {
							push({ incidentId: request.incidentId, type: "step", step: "analyze" });
							await analyzeIncidentById(runtime, request.incidentId);
						}
						const result = await runtime.diagnoseIncident({
							incidentId: request.incidentId,
							callModel: createEvalsModelCaller(providerId, model),
							analysis,
							simulateTool: runtime.createAiToolSimulator(analysis),
							quick: request.quick,
							signal: abort.signal,
							onProgress: (p) =>
								push({
									incidentId: request.incidentId,
									type: p.type,
									step: p.step,
									section: p.section,
									failRate: p.failRate,
									conclusion: p.conclusion,
									error: p.error,
								}),
						});
						push({
							incidentId: request.incidentId,
							type: "done",
							conclusion: result.conclusion,
							report: fs.readFileSync(result.reportPath, "utf-8"),
						});
					} catch (error) {
						push({
							incidentId: request.incidentId,
							type: "error",
							error: errorMessage(error),
						});
					} finally {
						activeOps.delete(request.incidentId);
					}
				})();

				return { success: true };
			} catch (error) {
				activeOps.delete(request.incidentId);
				return { success: false, error: errorMessage(error) };
			}
		},
	);

	log.info("handlers registered");
}

// ── Background replay executor ─────────────────────────

async function runReplayInBackground(options: {
	runtime: typeof import("@onething/runtime");
	incident: { id: string; promptVersion?: string };
	scene: import("@onething/runtime").ReplayScene;
	request: EvalsReplayStartRequest;
	runId: string;
	callModel: ReturnType<typeof createEvalsModelCaller>;
	analysis: { callModel: ReturnType<typeof createEvalsModelCaller>; model: string } | null;
	rubric?: string;
	simulateTool?: import("@onething/runtime").ToolSimulator;
	abort: AbortController;
}): Promise<void> {
	const { runtime, incident, scene, request, runId } = options;
	const push = (payload: EvalsReplayProgressEvent) =>
		sendToAll(IPC_CHANNELS.EVALS_REPLAY_PROGRESS, payload);

	const runDir = path.join(
		runtime.getIncidentDir(incident.id),
		"runs",
		runId,
	);
	fs.mkdirSync(runDir, { recursive: true });

	const attempts = Math.min(request.runs ?? 1, 10);
	let passes = 0;

	try {
		for (let i = 1; i <= attempts; i++) {
			if (options.abort.signal.aborted) break;
			push({ incidentId: incident.id, runId, type: "attempt-start", attempt: i });

			const result = await runtime.runReplay({
				scene,
				callModel: options.callModel,
				useCapturedPrompt: request.useCapturedPrompt,
				disabledSections: request.disabledSections,
				simulateTool: options.simulateTool,
				rubric: request.judge !== false ? options.rubric : undefined,
				judgeModel:
					request.judge !== false && options.analysis
						? options.analysis
						: undefined,
				header: {
					runId,
					attempt: i,
					incidentId: incident.id,
					promptVersion: incident.promptVersion,
					disabledSections: request.disabledSections,
					model: request.model || scene.params.model || "unknown",
					provider: request.providerId || scene.params.provider,
				},
				onEvent: (event) =>
					push({
						incidentId: incident.id,
						runId,
						type: "transcript-event",
						attempt: i,
						event: event as unknown as Record<string, unknown>,
					}),
				signal: options.abort.signal,
			});

			runtime.writeTranscript(
				path.join(runDir, `attempt-${i}.jsonl`),
				result.transcript.header,
				result.transcript.events,
			);
			if (result.verdict?.pass) passes++;
			push({
				incidentId: incident.id,
				runId,
				type: "attempt-done",
				attempt: i,
				pass: result.verdict?.pass ?? null,
				reason: result.verdict?.reason,
			});
		}

		fs.writeFileSync(
			path.join(runDir, "run.json"),
			JSON.stringify(
				{
					runId,
					kind: "replay",
					startedAt: new Date().toISOString(),
					attempts,
					passes,
					disabledSections: request.disabledSections,
					judged: request.judge !== false && !!options.rubric,
					aborted: options.abort.signal.aborted || undefined,
				},
				null,
				2,
			),
			"utf-8",
		);
		push({
			incidentId: incident.id,
			runId,
			type: "run-done",
			passes,
			attempts,
		});
	} catch (error) {
		push({
			incidentId: incident.id,
			runId,
			type: "error",
			error: errorMessage(error),
		});
	}
}

// ── Shared analysis routine ────────────────────────────

/** Fire-and-forget analysis for the 👎 flow (never throws). */
export async function analyzeIncidentInBackground(
	incidentId: string,
): Promise<void> {
	try {
		const runtime = await import("@onething/runtime");
		await analyzeIncidentById(runtime, incidentId);
	} catch (error) {
		log.error("background analysis failed", { incidentId }, error);
	}
}

async function analyzeIncidentById(
	runtime: typeof import("@onething/runtime"),
	incidentId: string,
): Promise<
	| { ok: true; incident: import("@onething/runtime").IncidentMeta }
	| { ok: false; error: string }
> {
	const incident = runtime.readIncident(incidentId);
	if (!incident) return { ok: false, error: "Incident not found" };
	const analysis = await resolveAnalysis(incident.provider, incident.model);
	if (!analysis) {
		return { ok: false, error: "No analysis model available" };
	}
	const trace = runtime.readIncidentTurnTrace(incidentId);
	const sectionNames = Object.keys(incident.sectionHashes ?? {});
	const result = await runtime.analyzeIncident({
		incident,
		turnTrace: trace,
		sectionNames,
		analysis,
	});
	if (!result) return { ok: false, error: "Analysis produced no result" };

	const updated = runtime.updateIncident(incidentId, {
		title: result.title,
		category: result.category,
		rubric: result.rubric || incident.note,
		status: incident.status === "new" ? "analyzed" : incident.status,
	});
	if (!updated) return { ok: false, error: "Failed to persist analysis" };
	// Rewrite the human cover with the AI summary
	try {
		fs.writeFileSync(
			path.join(runtime.getIncidentDir(incidentId), "incident.md"),
			runtime.renderAnalyzedMarkdown(updated, result),
			"utf-8",
		);
	} catch {
		// non-fatal
	}
	return { ok: true, incident: updated };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Traced AgentMessage content can be a string or content parts
function extractResponseText(message: unknown): string {
	const m = message as { content?: unknown };
	if (typeof m?.content === "string") return m.content;
	if (Array.isArray(m?.content)) {
		return (m.content as Array<{ type?: string; text?: string }>)
			.filter((p) => p?.type === "text" && typeof p.text === "string")
			.map((p) => p.text)
			.join("\n");
	}
	return "";
}

function extractResponseToolCalls(
	message: unknown,
): Array<{ name: string; args: unknown }> {
	const m = message as {
		toolCalls?: Array<{ name?: string; arguments?: unknown }>;
	};
	return (m?.toolCalls ?? []).map((tc) => ({
		name: tc.name ?? "unknown",
		args: tc.arguments,
	}));
}
