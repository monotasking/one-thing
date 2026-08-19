import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { platformApi } from "@/platform";
import { getLogger } from "@/services/log";
import type { EvalRunDetail } from "@shared/ipc";

const log = getLogger("renderer.evals");

export interface EvalRecordView {
	sessionId: string;
	turnId: string;
	ts: string;
	provider: string;
	model: string;
	signals: {
		retried: boolean;
		editResent: boolean;
		permissionDenied: boolean;
		toolErrors: number;
		streamAborted: boolean;
	};
	explicit: "up" | "down" | null;
	judge: { score: number; category: string; reason: string } | null;
	fixtureRef: string | null;
	hasFixture: boolean;
	userMessagePreview: string;
}

export interface EvalFixtureMeta {
	path: string;
	capturedAt: string;
	provider: string;
	model: string;
	sessionId: string;
	turnId: string;
	userMessagePreview: string;
	hasNegative: boolean;
}

export interface EvalRunResult {
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
}

export interface EvalCaseMeta {
	id: string;
	file: string;
	dir: string;
	description: string;
	fixture: string;
	userMessage: string;
	isSentinel: boolean;
	expect: Record<string, unknown>;
}

export interface RunProgress {
	type: "case-start" | "attempt-done" | "case-done" | "run-done" | "error";
	caseId?: string;
	attempt?: number;
	pass?: boolean;
	reason?: string;
	score?: number;
	totalCases?: number;
	completedCases?: number;
	entry?: EvalRunResult;
	error?: string;
}

export const useEvalsStore = defineStore("evals", () => {
	// ── State ──────────────────────────────────────────
	const records = ref<EvalRecordView[]>([]);
	const recordsTotal = ref(0);
	const recordsLoading = ref(false);
	const recordsError = ref<string | null>(null);
	const recordsFilter = ref({
		negativeOnly: true,
		category: "",
		provider: "",
		sinceTs: undefined as string | undefined,
		limit: 50,
		offset: 0,
	});

	const fixtures = ref<EvalFixtureMeta[]>([]);
	const fixturesLoading = ref(false);
	const fixturesError = ref<string | null>(null);
	const selectedFixture = ref<Record<string, unknown> | null>(null);
	const fixtureLoading = ref(false);

	const results = ref<EvalRunResult[]>([]);
	const resultsLoading = ref(false);
	const resultsError = ref<string | null>(null);

	// Compare: two selected run indices
	const compareIdxA = ref<number | null>(null);
	const compareIdxB = ref<number | null>(null);

	const cases = ref<EvalCaseMeta[]>([]);
	const casesLoading = ref(false);
	const casesError = ref<string | null>(null);

	// Run panel state
	const runInProgress = ref(false);
	const runProgress = ref<RunProgress | null>(null);
	const runCaseProgress = ref<
		Map<string, { passes: number; attempts: number; score: number }>
	>(new Map());
	const runProgressUnsub = ref<(() => void) | null>(null);

	// Active sub-view
	const activeView = ref<"records" | "fixtures" | "runs" | "cases">("records");

	// Run detail panel
	const selectedRunIdx = ref<number | null>(null);
	const runDetail = ref<EvalRunDetail | null>(null);
	const runDetailLoading = ref(false);

	// ── Computed ───────────────────────────────────────
	const negativeRecords = computed(() =>
		records.value.filter((r) => {
			if (r.explicit === "down") return true;
			if (r.judge && r.judge.score < 0.5) return true;
			const s = r.signals;
			return (
				s.retried ||
				s.editResent ||
				s.streamAborted ||
				s.toolErrors > 0 ||
				s.permissionDenied
			);
		}),
	);

	const runComparison = computed(() => {
		if (compareIdxA.value === null || compareIdxB.value === null) return null;
		const a = results.value[compareIdxA.value];
		const b = results.value[compareIdxB.value];
		if (!a || !b) return null;

		const allCaseIds = new Set([
			...Object.keys(a.scores),
			...Object.keys(b.scores),
		]);
		const comparisons: Array<{
			id: string;
			scoreA: number;
			scoreB: number;
			delta: number;
		}> = [];

		for (const id of allCaseIds) {
			const scoreA = a.scores[id] ?? 0;
			const scoreB = b.scores[id] ?? 0;
			comparisons.push({
				id,
				scoreA,
				scoreB,
				delta: scoreB - scoreA,
			});
		}

		comparisons.sort((x, y) => y.delta - x.delta);

		return { a, b, comparisons };
	});

	// ── Actions ─────────────────────────────────────────

	async function loadRecords() {
		recordsLoading.value = true;
		recordsError.value = null;
		try {
			const res = await platformApi.evalsListRecords({
				...recordsFilter.value,
			});
			if (res.success && res.records) {
				records.value = res.records as unknown as EvalRecordView[];
				recordsTotal.value = res.total ?? res.records.length;
			} else {
				recordsError.value = res.error || "Failed to load records";
			}
		} catch (e) {
			recordsError.value = e instanceof Error ? e.message : "Unknown error";
		} finally {
			recordsLoading.value = false;
		}
	}

	async function loadFixtures() {
		fixturesLoading.value = true;
		fixturesError.value = null;
		try {
			const res = await platformApi.evalsListFixtures();
			if (res.success && res.fixtures) {
				fixtures.value = res.fixtures as EvalFixtureMeta[];
			} else {
				fixturesError.value = res.error || "Failed to load fixtures";
			}
		} catch (e) {
			fixturesError.value = e instanceof Error ? e.message : "Unknown error";
		} finally {
			fixturesLoading.value = false;
		}
	}

	async function loadFixture(path: string) {
		fixtureLoading.value = true;
		try {
			const res = await platformApi.evalsReadFixture({ fixturePath: path });
			if (res.success && res.fixture) {
				selectedFixture.value = res.fixture;
			}
		} catch {
			selectedFixture.value = null;
		} finally {
			fixtureLoading.value = false;
		}
	}

	async function loadResults() {
		resultsLoading.value = true;
		resultsError.value = null;
		try {
			const res = await platformApi.evalsListResults();
			if (res.success && res.entries) {
				results.value = res.entries as EvalRunResult[];
			} else {
				resultsError.value = res.error || "Failed to load results";
			}
		} catch (e) {
			resultsError.value = e instanceof Error ? e.message : "Unknown error";
		} finally {
			resultsLoading.value = false;
		}
	}

	async function loadCases() {
		casesLoading.value = true;
		casesError.value = null;
		try {
			const res = await platformApi.evalsListCases();
			if (res.success && res.cases) {
				cases.value = res.cases as EvalCaseMeta[];
			} else {
				casesError.value = res.error || "Failed to load cases";
			}
		} catch (e) {
			casesError.value = e instanceof Error ? e.message : "Unknown error";
		} finally {
			casesLoading.value = false;
		}
	}

	async function startRun(opts: {
		caseIds?: string[];
		runs: number;
		disabledSections?: string[];
		providerId: string;
		model: string;
	}) {
		log.info("evals run start requested", {
			provider: opts.providerId,
			model: opts.model,
			runs: opts.runs,
			caseIds: opts.caseIds?.length ?? 0,
			disabledSections: opts.disabledSections,
		});
		if (runInProgress.value) {
			log.warn("evals run start blocked, run already in progress");
			return;
		}
		runInProgress.value = true;
		runProgress.value = null;
		runCaseProgress.value = new Map();

		log.debug("evals progress subscription opened");
		// Subscribe to progress events
		runProgressUnsub.value = platformApi.onEvalsRunProgress(
			async (event: Record<string, unknown>) => {
				const evt = event as unknown as RunProgress;
				log.debug("evals progress event", {
					type: evt.type,
					caseId: evt.caseId,
				});
				runProgress.value = evt;

				if (evt.type === "case-start" && evt.caseId) {
					runCaseProgress.value.set(evt.caseId, {
						passes: 0,
						attempts: 0,
						score: 0,
					});
				}
				if (evt.type === "attempt-done" && evt.caseId) {
					const cp = runCaseProgress.value.get(evt.caseId);
					if (cp) {
						cp.attempts++;
						if (evt.pass) cp.passes++;
					}
				}
				if (evt.type === "case-done" && evt.caseId && evt.score !== undefined) {
					const cp = runCaseProgress.value.get(evt.caseId);
					if (cp) cp.score = evt.score;
				}
				if (evt.type === "run-done" || evt.type === "error") {
					log.info("evals run finished", { type: evt.type, error: evt.error });
					runInProgress.value = false;
					if (evt.type === "run-done") {
						await loadResults();
						// Auto-select comparison: last vs second-to-last
						if (results.value.length >= 2) {
							compareIdxA.value = results.value.length - 2;
							compareIdxB.value = results.value.length - 1;
						}
					}
				}
			},
		);

		try {
			log.debug("evals run start dispatching");
			const res = await platformApi.evalsRunStart(opts);
			log.debug("evals run start responded", { success: res.success, error: res.error });
			if (!res.success) {
				log.error("evals run start failed", { error: res.error });
				runInProgress.value = false;
				runProgress.value = {
					type: "error",
					error: res.error || "Failed to start run",
				};
			}
		} catch (e) {
			log.error("evals run start failed", {}, e);
			runInProgress.value = false;
			runProgress.value = {
				type: "error",
				error: e instanceof Error ? e.message : "Unknown error",
			};
		}
	}

	async function loadRunDetail(ts: string) {
		runDetailLoading.value = true;
		runDetail.value = null;
		try {
			const filename = `${ts.replace(/[:.]/g, "-")}.json`;
			const res = await platformApi.evalsReadRunDetail({
				detailPath: `evals/runs/${filename}`,
			});
			if (res.success && res.detail) {
				runDetail.value = res.detail as unknown as EvalRunDetail;
			} else {
				log.error("evals run detail load failed", { ts, error: res.error });
			}
		} catch (e) {
			log.error("evals run detail load failed", { ts }, e);
		} finally {
			runDetailLoading.value = false;
		}
	}

	async function cancelRun() {
		try {
			await platformApi.evalsRunCancel();
		} catch {
			/* ignore */
		}
		runInProgress.value = false;
		if (runProgressUnsub.value) {
			runProgressUnsub.value();
			runProgressUnsub.value = null;
		}
	}

	async function promoteFixture(opts: {
		fixturePath: string;
		caseId: string;
		description: string;
		expect: Record<string, unknown>;
	}): Promise<{ success: boolean; casePath?: string; error?: string }> {
		try {
			const res = await platformApi.evalsPromoteFixture(opts);
			return res;
		} catch (e) {
			return {
				success: false,
				error: e instanceof Error ? e.message : "Unknown error",
			};
		}
	}

	async function retireCase(
		caseId: string,
	): Promise<{ success: boolean; error?: string }> {
		try {
			const res = await platformApi.evalsRetireCase({ caseId });
			if (res.success) {
				await loadCases();
			}
			return res;
		} catch (e) {
			return {
				success: false,
				error: e instanceof Error ? e.message : "Unknown error",
			};
		}
	}

	async function generateTriage(
		weeks?: number,
	): Promise<{ success: boolean; report?: string; error?: string }> {
		try {
			const res = await platformApi.evalsGenerateTriage(
				weeks ? { weeks } : undefined,
			);
			return res;
		} catch (e) {
			return {
				success: false,
				error: e instanceof Error ? e.message : "Unknown error",
			};
		}
	}

	return {
		// State
		records,
		recordsTotal,
		recordsLoading,
		recordsError,
		recordsFilter,
		fixtures,
		fixturesLoading,
		fixturesError,
		selectedFixture,
		fixtureLoading,
		results,
		resultsLoading,
		resultsError,
		compareIdxA,
		compareIdxB,
		cases,
		casesLoading,
		casesError,
		runInProgress,
		runProgress,
		runCaseProgress,
		activeView,
		// Run detail
		selectedRunIdx,
		runDetail,
		runDetailLoading,
		// Computed
		negativeRecords,
		runComparison,
		// Actions
		loadRecords,
		loadFixtures,
		loadFixture,
		loadResults,
		loadCases,
		startRun,
		cancelRun,
		loadRunDetail,
		promoteFixture,
		retireCase,
		generateTriage,
	};
});
