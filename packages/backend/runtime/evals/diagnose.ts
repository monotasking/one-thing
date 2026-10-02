/**
 * Automated incident diagnosis (workbench W5, design D6).
 *
 * From one incident, answer "what caused it" with a five-way conclusion:
 *   ① reproduce  — replay the original scene k times → failure rate
 *   ② context    — local integrity check (compaction/truncation loss)
 *   ③ ablation   — disable prompt sections one by one → flip table
 *   ④ conclusion — not-reproducible / context-missing / section-implicated
 *                  / not-prompt-related (version regression is analytical,
 *                  from sectionHashes history — surfaced in the report)
 *   ⑤ report     — factual data + AI-written conclusion paragraph
 *
 * Everything runs on the mock replay engine: zero real tool execution.
 */

import fs from "node:fs";
import path from "node:path";
import {
	getIncidentDir,
	readIncident,
	updateIncident,
	type IncidentMeta,
} from "./incident.js";
import {
	loadSceneFromIncident,
	runReplay,
	type ReplayScene,
} from "./replay.js";
import { writeTranscript } from "./transcript.js";
import type { EvalModelCaller } from "./model-call.js";
import type { ToolSimulator } from "./mock-tools.js";
import {
	checkContextIntegrity,
	concludeDiagnosis,
	writeDiagnosisReport,
	type AnalysisModel,
	type DiagnosisConclusion,
} from "./analysis.js";
import type { OnethingStorePathOptions } from "../storage/paths.js";

export interface DiagnoseProgress {
	type: "step" | "ablation" | "done" | "error";
	step?: string;
	section?: string;
	failRate?: number;
	conclusion?: string;
	error?: string;
}

export interface DiagnoseOptions {
	incidentId: string;
	/** Caller used for replay attempts (scene provider). */
	callModel: EvalModelCaller;
	/** Analysis model: rubric judging + report conclusion. */
	analysis: AnalysisModel;
	/** Judgeable expectation; falls back to incident rubric/note. */
	rubric?: string;
	simulateTool?: ToolSimulator;
	quick?: boolean;
	onProgress?: (progress: DiagnoseProgress) => void;
	signal?: AbortSignal;
	storeOptions?: OnethingStorePathOptions;
}

export interface DiagnoseResult {
	conclusion: DiagnosisConclusion;
	implicatedSections: string[];
	reproduce: { attempts: number; failures: number };
	ablation: Array<{ section: string; attempts: number; failures: number }>;
	contextFindings: string[];
	reportPath: string;
	runId: string;
}

export async function diagnoseIncident(
	options: DiagnoseOptions,
): Promise<DiagnoseResult> {
	const incident = readIncident(options.incidentId, options.storeOptions);
	if (!incident) throw new Error(`Incident not found: ${options.incidentId}`);
	const scene = loadSceneFromIncident(options.incidentId, options.storeOptions);
	if (!scene) throw new Error(`Incident has no replayable scene`);

	const rubric = options.rubric || incident.rubric || incident.note;
	if (!rubric) {
		throw new Error(
			"Diagnosis needs an expectation to judge against (rubric/note missing — run analysis first)",
		);
	}

	const emit = (progress: DiagnoseProgress) => options.onProgress?.(progress);
	const runId = `diag-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
	const runDir = path.join(
		getIncidentDir(options.incidentId, options.storeOptions),
		"runs",
		runId,
	);
	fs.mkdirSync(runDir, { recursive: true });

	const reproAttempts = options.quick ? 3 : 5;
	const ablateAttempts = options.quick ? 2 : 3;

	const attempt = async (
		label: string,
		index: number,
		disabledSections?: string[],
	): Promise<boolean /* failed */> => {
		const result = await runReplay({
			scene,
			callModel: options.callModel,
			disabledSections,
			simulateTool: options.simulateTool,
			rubric,
			judgeModel: options.analysis,
			header: {
				runId,
				attempt: index,
				incidentId: options.incidentId,
				promptVersion: incident.promptVersion,
				disabledSections,
				model: scene.params.model ?? "unknown",
				provider: scene.params.provider,
			},
			signal: options.signal,
		});
		writeTranscript(
			path.join(runDir, `${label}-${index}.jsonl`),
			result.transcript.header,
			result.transcript.events,
		);
		// No verdict (judge failure) counts as failed — be conservative.
		return !(result.verdict?.pass ?? false);
	};

	// ① Reproduce
	emit({ type: "step", step: "reproduce" });
	let reproFailures = 0;
	for (let i = 1; i <= reproAttempts; i++) {
		if (options.signal?.aborted) break;
		if (await attempt("repro", i)) reproFailures++;
	}
	const reproduce = { attempts: reproAttempts, failures: reproFailures };
	const baselineFailRate = reproFailures / reproAttempts;

	// ② Context integrity (local, free)
	emit({ type: "step", step: "context-check" });
	const sceneDir = path.join(
		getIncidentDir(options.incidentId, options.storeOptions),
		"scene",
	);
	const readText = (name: string) => {
		try {
			return fs.readFileSync(path.join(sceneDir, name), "utf-8");
		} catch {
			return "";
		}
	};
	const contextFindings =
		reproFailures > 0
			? checkContextIntegrity({
					userMessage: incident.userMessage,
					note: incident.note,
					contextText: readText("context.jsonl"),
					promptText: readText("prompt.json"),
				})
			: [];

	// ③ Ablation matrix (only meaningful when the failure reproduces)
	const ablation: Array<{
		section: string;
		attempts: number;
		failures: number;
	}> = [];
	if (reproFailures > 0 && contextFindings.length === 0) {
		const allSections = sectionNamesFromScene(sceneDir).filter(
			(name) => name !== "system",
		);
		const suspected = incident.category
			? allSections
			: allSections; /* full matrix; quick mode narrows count below */
		const sections = options.quick ? suspected.slice(0, 5) : suspected;

		for (const section of sections) {
			if (options.signal?.aborted) break;
			let failures = 0;
			for (let i = 1; i <= ablateAttempts; i++) {
				if (options.signal?.aborted) break;
				if (await attempt(`ablate-${section}`, i, [section])) failures++;
			}
			ablation.push({ section, attempts: ablateAttempts, failures });
			emit({
				type: "ablation",
				section,
				failRate: failures / ablateAttempts,
			});
		}
	}

	// ④ Conclusion
	const { conclusion, implicatedSections } = concludeDiagnosis({
		incident,
		reproduce,
		contextFindings,
		ablation,
		baselineFailRate,
	});

	// ⑤ Report
	const report = await writeDiagnosisReport({
		input: {
			incident,
			reproduce,
			contextFindings,
			ablation,
			baselineFailRate,
		},
		conclusion,
		implicatedSections,
		analysis: options.analysis,
		signal: options.signal,
	});
	const reportPath = path.join(runDir, "report.md");
	fs.writeFileSync(reportPath, report, "utf-8");
	fs.writeFileSync(
		path.join(runDir, "run.json"),
		JSON.stringify(
			{
				runId,
				kind: "diagnosis",
				startedAt: new Date().toISOString(),
				attempts: reproAttempts,
				passes: reproAttempts - reproFailures,
				conclusion,
				implicatedSections,
				ablation,
				contextFindings,
			},
			null,
			2,
		),
		"utf-8",
	);

	updateIncident(
		options.incidentId,
		{
			status:
				conclusion === "not-reproducible" ? "not-reproducible" : "diagnosed",
			diagnosis: {
				conclusion,
				reportRef: `runs/${runId}/report.md`,
				at: new Date().toISOString(),
			},
		},
		options.storeOptions,
	);

	emit({ type: "done", conclusion });

	return {
		conclusion,
		implicatedSections,
		reproduce,
		ablation,
		contextFindings,
		reportPath,
		runId,
	};
}

function sectionNamesFromScene(sceneDir: string): string[] {
	try {
		const prompt = JSON.parse(
			fs.readFileSync(path.join(sceneDir, "prompt.json"), "utf-8"),
		);
		return (prompt.sections as Array<{ name: string }>).map((s) => s.name);
	} catch {
		return [];
	}
}

export type { IncidentMeta, ReplayScene };
