/**
 * Evals Workbench store (incident-centric, design W3).
 *
 * Holds the workbench overlay state, the incident list/detail, and the
 * live progress of replay/diagnosis pushed from the main process.
 */

import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { platformApi } from "@/platform";
import { evalsWorkbenchApi } from "@/platform/evals-workbench-client";

export interface IncidentListItem {
	id: string;
	createdAt: string;
	origin: "downvote" | "auto";
	status: string;
	title: string;
	note?: string;
	category?: string;
	rubric?: string;
	provider: string;
	model: string;
	promptVersion?: string;
	sectionHashes?: Record<string, string>;
	userMessage: string;
	assistantPreview: string;
	sessionId: string;
	turnId: string;
	contextOrigin?: "live" | "rebuilt" | "synthesized";
	scene: Record<string, boolean>;
	diagnosis?: { conclusion: string; reportRef?: string; at: string };
	caseId?: string;
}

export interface IncidentRunSummary {
	runId: string;
	startedAt: string;
	kind: "replay" | "diagnosis";
	attempts: number;
	passes: number;
	disabledSections?: string[];
	attemptFiles: string[];
}

export interface TranscriptEventView {
	t: string;
	[key: string]: unknown;
}

/** One agent-loop round from the L1 trace (view shape from main). */
export interface RoundView {
	round: number;
	ts: string;
	purpose: string;
	requestMessages: unknown[];
	model: string;
	temperature?: number;
	toolNames: string[];
	responseContent: string;
	responseToolCalls: Array<{ name: string; args: unknown }>;
	finishReason: string;
	incomplete?: boolean;
}

export interface RoundReplayAttempt {
	content: string;
	toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
	finishReason: string;
}

export const useEvalsWorkbenchStore = defineStore("evalsWorkbench", () => {
	const open = ref(false);
	const incidents = ref<IncidentListItem[]>([]);
	const loading = ref(false);
	const error = ref<string | null>(null);

	const selectedId = ref<string | null>(null);
	const detail = ref<{
		incident: IncidentListItem;
		markdown: string;
		runs: IncidentRunSummary[];
	} | null>(null);
	const detailLoading = ref(false);

	// Live replay state
	const replayRunning = ref(false);
	const replayRunId = ref<string | null>(null);
	const replayAttempt = ref(0);
	const replayEvents = ref<TranscriptEventView[]>([]);
	const replayVerdicts = ref<Array<{ pass: boolean | null; reason?: string }>>(
		[],
	);

	// Live diagnosis state
	const diagnoseRunning = ref(false);
	const diagnoseSteps = ref<string[]>([]);
	const diagnoseReport = ref<string | null>(null);
	const diagnoseConclusion = ref<string | null>(null);

	const analyzing = ref(false);

	// Per-round trace state (L1)
	const rounds = ref<RoundView[] | null>(null);
	const roundsLoading = ref(false);
	const roundsError = ref<string | null>(null);
	const roundReplaying = ref<number | null>(null);
	const roundReplayResults = ref<
		Record<number, { attempts: RoundReplayAttempt[]; edited?: boolean }>
	>({});
	const roundReplayErrors = ref<Record<number, string>>({});

	const selected = computed(() =>
		incidents.value.find((i) => i.id === selectedId.value),
	);

	let subscribed = false;
	function subscribe() {
		if (subscribed) return;
		subscribed = true;
		// A stale preload (dev app not restarted after upgrade) may lack the
		// listener methods — the workbench must still open and show its error
		// state instead of dying on the first call.
		if (
			typeof platformApi.onEvalsReplayProgress !== "function" ||
			typeof platformApi.onEvalsDiagnoseProgress !== "function"
		) {
			error.value = "预加载脚本过旧,请重启应用(bun run dev)";
			return;
		}
		platformApi.onEvalsReplayProgress((event) => {
			if (event.incidentId !== selectedId.value) return;
			const type = event.type as string;
			if (type === "attempt-start") {
				replayAttempt.value = Number(event.attempt ?? 0);
				replayEvents.value = [];
			} else if (type === "transcript-event" && event.event) {
				replayEvents.value = [
					...replayEvents.value,
					event.event as TranscriptEventView,
				];
			} else if (type === "attempt-done") {
				replayVerdicts.value = [
					...replayVerdicts.value,
					{
						pass: (event.pass as boolean | null) ?? null,
						reason: event.reason as string | undefined,
					},
				];
			} else if (type === "run-done" || type === "error") {
				replayRunning.value = false;
				void refreshDetail();
			}
		});
		platformApi.onEvalsDiagnoseProgress((event) => {
			if (event.incidentId !== selectedId.value) return;
			const type = event.type as string;
			if (type === "step") {
				diagnoseSteps.value = [
					...diagnoseSteps.value,
					String(event.step ?? ""),
				];
			} else if (type === "ablation") {
				diagnoseSteps.value = [
					...diagnoseSteps.value,
					`消融 ${event.section}: 失败率 ${Math.round(Number(event.failRate ?? 0) * 100)}%`,
				];
			} else if (type === "done") {
				diagnoseRunning.value = false;
				diagnoseConclusion.value = String(event.conclusion ?? "");
				diagnoseReport.value = (event.report as string) ?? null;
				void refreshDetail();
				void loadIncidents();
			} else if (type === "error") {
				diagnoseRunning.value = false;
				diagnoseSteps.value = [
					...diagnoseSteps.value,
					`错误: ${event.error}`,
				];
			}
		});
	}

	async function loadIncidents() {
		loading.value = true;
		error.value = null;
		try {
			const res = await evalsWorkbenchApi.incidentList();
			if (res.success && res.incidents) {
				incidents.value = res.incidents as unknown as IncidentListItem[];
			} else {
				error.value = res.error ?? "加载失败";
			}
		} catch (e) {
			error.value = String(e);
		} finally {
			loading.value = false;
		}
	}

	async function select(incidentId: string) {
		selectedId.value = incidentId;
		replayEvents.value = [];
		replayVerdicts.value = [];
		diagnoseSteps.value = [];
		diagnoseReport.value = null;
		diagnoseConclusion.value = null;
		rounds.value = null;
		roundsError.value = null;
		roundReplaying.value = null;
		roundReplayResults.value = {};
		roundReplayErrors.value = {};
		await refreshDetail();
	}

	async function refreshDetail() {
		if (!selectedId.value) return;
		detailLoading.value = true;
		try {
			const res = await evalsWorkbenchApi.incidentGet({
				incidentId: selectedId.value,
			});
			if (res.success && res.incident) {
				detail.value = {
					incident: res.incident as unknown as IncidentListItem,
					markdown: res.markdown ?? "",
					runs: (res.runs ?? []) as unknown as IncidentRunSummary[],
				};
			}
		} finally {
			detailLoading.value = false;
		}
	}

	// Incident created by a 👎 while the workbench stayed closed — preselect
	// it on the next open instead of popping the overlay over the chat.
	let pendingIncidentId: string | null = null;

	function notePendingIncident(incidentId: string) {
		pendingIncidentId = incidentId;
	}

	async function openWorkbench(incidentId?: string) {
		// Open first: even if loading fails (stale preload, IPC error), the
		// overlay appears with its error state rather than nothing happening.
		open.value = true;
		try {
			subscribe();
			await loadIncidents();
			const target = incidentId ?? pendingIncidentId;
			pendingIncidentId = null;
			if (target) {
				await select(target);
			} else if (!selectedId.value && incidents.value.length > 0) {
				await select(incidents.value[0].id);
			}
		} catch (e) {
			error.value = String(e);
		}
	}

	function close() {
		open.value = false;
	}

	async function startReplay(options: {
		runs?: number;
		disabledSections?: string[];
		judge?: boolean;
		useCapturedPrompt?: boolean;
	}) {
		if (!selectedId.value || replayRunning.value) return;
		replayRunning.value = true;
		replayEvents.value = [];
		replayVerdicts.value = [];
		replayAttempt.value = 0;
		const res = await evalsWorkbenchApi.replayStart({
			incidentId: selectedId.value,
			...options,
		});
		if (!res.success) {
			replayRunning.value = false;
			error.value = res.error ?? "重放启动失败";
		} else {
			replayRunId.value = res.runId ?? null;
		}
	}

	async function cancelReplay() {
		if (!selectedId.value) return;
		await evalsWorkbenchApi.replayCancel({ incidentId: selectedId.value });
	}

	async function analyze() {
		if (!selectedId.value || analyzing.value) return;
		analyzing.value = true;
		try {
			const res = await evalsWorkbenchApi.incidentAnalyze({
				incidentId: selectedId.value,
			});
			if (!res.success) error.value = res.error ?? "分析失败";
			await refreshDetail();
			await loadIncidents();
		} finally {
			analyzing.value = false;
		}
	}

	async function startDiagnose(quick: boolean) {
		if (!selectedId.value || diagnoseRunning.value) return;
		diagnoseRunning.value = true;
		diagnoseSteps.value = [];
		diagnoseReport.value = null;
		diagnoseConclusion.value = null;
		const res = await evalsWorkbenchApi.diagnoseStart({
			incidentId: selectedId.value,
			quick,
		});
		if (!res.success) {
			diagnoseRunning.value = false;
			error.value = res.error ?? "诊断启动失败";
		}
	}

	async function promote(caseId: string, description?: string) {
		if (!selectedId.value) return null;
		const res = await evalsWorkbenchApi.incidentPromote({
			incidentId: selectedId.value,
			caseId,
			description,
		});
		if (!res.success) {
			error.value = res.error ?? "转用例失败";
			return null;
		}
		await refreshDetail();
		await loadIncidents();
		return res.casePath ?? null;
	}

	async function loadRounds() {
		if (!selectedId.value || roundsLoading.value) return;
		roundsLoading.value = true;
		roundsError.value = null;
		try {
			// 迁到通用 RPC 之后这道「预加载过旧」的护栏改看传输面本身:
			// 旧壳没有 rpcInvoke,整个 router 客户端都发不出请求(P4c 第十批)。
			if (typeof platformApi.rpcInvoke !== "function") {
				roundsError.value = "预加载脚本过旧,请重启应用(bun run dev)";
				return;
			}
			const res = await evalsWorkbenchApi.roundList({
				incidentId: selectedId.value,
			});
			if (res.success) {
				rounds.value = (res.rounds ?? []) as unknown as RoundView[];
			} else {
				roundsError.value = res.error ?? "加载逐轮记录失败";
			}
		} catch (e) {
			roundsError.value = String(e);
		} finally {
			roundsLoading.value = false;
		}
	}

	async function replayRoundRequest(options: {
		round: number;
		runs?: number;
		editedMessages?: unknown[];
	}) {
		if (!selectedId.value || roundReplaying.value !== null) return;
		roundReplaying.value = options.round;
		delete roundReplayErrors.value[options.round];
		try {
			const res = await evalsWorkbenchApi.roundReplay({
				incidentId: selectedId.value,
				round: options.round,
				runs: options.runs,
				editedMessages: options.editedMessages,
			});
			if (res.success && res.attempts) {
				roundReplayResults.value = {
					...roundReplayResults.value,
					[options.round]: { attempts: res.attempts, edited: res.edited },
				};
			} else {
				roundReplayErrors.value = {
					...roundReplayErrors.value,
					[options.round]: res.error ?? "单轮重发失败",
				};
			}
		} catch (e) {
			roundReplayErrors.value = {
				...roundReplayErrors.value,
				[options.round]: String(e),
			};
		} finally {
			roundReplaying.value = null;
		}
	}

	async function readBundleFile(relativePath: string): Promise<string | null> {
		if (!selectedId.value) return null;
		const res = await evalsWorkbenchApi.incidentReadFile({
			incidentId: selectedId.value,
			relativePath,
		});
		return res.success ? (res.content ?? null) : null;
	}

	return {
		open,
		incidents,
		loading,
		error,
		selectedId,
		selected,
		detail,
		detailLoading,
		replayRunning,
		replayRunId,
		replayAttempt,
		replayEvents,
		replayVerdicts,
		diagnoseRunning,
		diagnoseSteps,
		diagnoseReport,
		diagnoseConclusion,
		analyzing,
		rounds,
		roundsLoading,
		roundsError,
		roundReplaying,
		roundReplayResults,
		roundReplayErrors,
		loadRounds,
		replayRoundRequest,
		notePendingIncident,
		openWorkbench,
		close,
		loadIncidents,
		select,
		refreshDetail,
		startReplay,
		cancelReplay,
		analyze,
		startDiagnose,
		promote,
		readBundleFile,
	};
});
