/**
 * AI analysis for the eval workbench (design D5).
 *
 * The app IS an AI system — incident summarization, rubric extraction,
 * tool-result simulation and diagnosis reports are done by the app's own
 * (cheap) model, injected as an EvalModelCaller. Humans only provide the
 * 👎 one-liner.
 */

import type { EvalModelCaller } from "./model-call.js";
import type { IncidentMeta, TurnTraceEntry } from "./incident.js";
import type { ToolSimulator } from "./mock-tools.js";
import { stringifyToolValue } from "./mock-tools.js";

export interface AnalysisModel {
	callModel: EvalModelCaller;
	model: string;
}

// ── Incident analysis (title/summary/category/rubric) ──

export interface IncidentAnalysis {
	title: string;
	category: string;
	rubric: string;
	summaryMarkdown: string;
	suspectedSections: string[];
}

const ANALYSIS_CATEGORIES = [
	"missed-directory-switch",
	"ignored-skill-instructions",
	"voice-mode-violation",
	"ignored-known-projects",
	"wrong-platform-behavior",
	"ignored-agent-instructions",
	"wrong-tool-usage",
	"lost-context",
	"general-poor-response",
	"not-prompt-fault",
];

export async function analyzeIncident(options: {
	incident: IncidentMeta;
	turnTrace: TurnTraceEntry[];
	sectionNames: string[];
	analysis: AnalysisModel;
	signal?: AbortSignal;
}): Promise<IncidentAnalysis | null> {
	const { incident, turnTrace } = options;

	const traceText = turnTrace
		.map(
			(e) =>
				`${e.content}\n${e.toolCalls
					.map(
						(tc) =>
							`[tool] ${tc.name}(${short(stringifyToolValue(tc.args), 200)}) -> ${short(stringifyToolValue(tc.result), 200)}`,
					)
					.join("\n")}`,
		)
		.join("\n---\n");

	const system = [
		"You analyze a failed AI-assistant turn and produce a structured incident report.",
		"Respond ONLY with a JSON object:",
		`{"title": "<=40 chars, concrete", "category": one of ${JSON.stringify(ANALYSIS_CATEGORIES)},`,
		`"rubric": "a single judgeable expectation sentence (what correct behavior looks like)",`,
		`"suspectedSections": ["names from the provided section list that plausibly caused this"],`,
		`"summary": "2-4 sentence markdown summary of what happened and why it is wrong"}`,
		"Write title/rubric/summary in the same language as the user message.",
	].join("\n");

	const user = [
		"# User message",
		incident.userMessage || "(empty)",
		"",
		"# Assistant behavior (actual turn, tool results are real)",
		traceText || incident.assistantPreview || "(no output)",
		"",
		"# User's complaint (👎 note)",
		incident.note || "(none — infer the failure from the behavior)",
		"",
		"# Prompt section names",
		options.sectionNames.join(", ") || "(unknown)",
		"",
		"Return the JSON only.",
	].join("\n");

	try {
		const response = await options.analysis.callModel({
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			model: options.analysis.model,
			signal: options.signal,
		});
		const parsed = extractJson(response.content);
		if (!parsed) return null;
		return {
			title: String(parsed.title ?? incident.title).slice(0, 80),
			category: ANALYSIS_CATEGORIES.includes(String(parsed.category))
				? String(parsed.category)
				: "general-poor-response",
			rubric: String(parsed.rubric ?? incident.note ?? ""),
			summaryMarkdown: String(parsed.summary ?? ""),
			suspectedSections: Array.isArray(parsed.suspectedSections)
				? parsed.suspectedSections.map(String).filter(Boolean)
				: [],
		};
	} catch {
		return null;
	}
}

/** Rewrite incident.md with the AI analysis (keeps the factual scene part). */
export function renderAnalyzedMarkdown(
	meta: IncidentMeta,
	analysis: IncidentAnalysis,
): string {
	return [
		`# ${analysis.title}`,
		"",
		`> ${meta.origin === "downvote" ? "👎 手动标记" : "负信号自动捕获"} · ${meta.createdAt.slice(0, 16).replace("T", " ")} · ${meta.provider}/${meta.model} · 类别: ${analysis.category}`,
		"",
		"## 发生了什么",
		"",
		analysis.summaryMarkdown,
		"",
		`**用户**: ${meta.userMessage || "(空)"}`,
		"",
		`**助手**: ${meta.assistantPreview || "(无输出)"}`,
		"",
		"## 期望(判定 rubric)",
		"",
		analysis.rubric || meta.note || "_(无)_",
		"",
		"## 疑点段落",
		"",
		analysis.suspectedSections.length
			? analysis.suspectedSections.map((s) => `- \`${s}\``).join("\n")
			: "_(AI 未指认)_",
		"",
		"## 现场",
		"",
		`- promptVersion: \`${meta.promptVersion ?? "?"}\` · session: \`${meta.sessionId.slice(0, 8)}\` · turn: \`${meta.turnId.slice(0, 8)}\``,
		meta.note ? `- 👎 原话: ${meta.note}` : "",
		"",
	]
		.filter((line) => line !== null)
		.join("\n");
}

// ── AI tool simulation (mock ladder step ②) ────────────

export function createAiToolSimulator(analysis: AnalysisModel): ToolSimulator {
	return async ({ name, args, recordedCalls }) => {
		const nearby = recordedCalls
			.slice(0, 6)
			.map(
				(rc) =>
					`${rc.name}(${short(stringifyToolValue(rc.args), 150)}) -> ${short(stringifyToolValue(rc.result), 300)}`,
			)
			.join("\n");

		const response = await analysis.callModel({
			messages: [
				{
					role: "system",
					content: [
						"You simulate a tool's output for an offline replay. Produce ONLY the raw tool result text (no commentary, no markdown fences).",
						"Stay consistent with the recorded calls from the original environment when relevant.",
						"If you cannot produce a plausible result, respond with exactly: UNAVAILABLE",
					].join("\n"),
				},
				{
					role: "user",
					content: [
						`Tool: ${name}`,
						`Arguments: ${short(stringifyToolValue(args), 500)}`,
						"",
						"Recorded calls from the original turn (real environment):",
						nearby || "(none)",
					].join("\n"),
				},
			],
			model: analysis.model,
		});
		const text = response.content.trim();
		if (!text || text === "UNAVAILABLE") return null;
		return short(text, 4000);
	};
}

// ── Diagnosis report (W5) ──────────────────────────────

export interface DiagnosisInput {
	incident: IncidentMeta;
	reproduce: { attempts: number; failures: number };
	contextFindings: string[];
	ablation: Array<{
		section: string;
		attempts: number;
		failures: number;
	}>;
	baselineFailRate: number;
}

export type DiagnosisConclusion =
	| "not-reproducible"
	| "context-missing"
	| "section-implicated"
	| "not-prompt-related"
	| "version-regression";

export function concludeDiagnosis(input: DiagnosisInput): {
	conclusion: DiagnosisConclusion;
	implicatedSections: string[];
} {
	if (input.reproduce.attempts > 0 && input.reproduce.failures === 0) {
		return { conclusion: "not-reproducible", implicatedSections: [] };
	}
	if (input.contextFindings.length > 0) {
		return { conclusion: "context-missing", implicatedSections: [] };
	}
	// A section is implicated when disabling it clearly reduces the failure
	// rate versus baseline (>= 0.5 absolute drop).
	const implicated = input.ablation
		.filter(
			(a) =>
				a.attempts > 0 &&
				input.baselineFailRate - a.failures / a.attempts >= 0.5,
		)
		.map((a) => a.section);
	if (implicated.length > 0) {
		return { conclusion: "section-implicated", implicatedSections: implicated };
	}
	return { conclusion: "not-prompt-related", implicatedSections: [] };
}

export async function writeDiagnosisReport(options: {
	input: DiagnosisInput;
	conclusion: DiagnosisConclusion;
	implicatedSections: string[];
	analysis?: AnalysisModel;
	signal?: AbortSignal;
}): Promise<string> {
	const { input } = options;
	const table = input.ablation
		.map(
			(a) =>
				`| ${a.section} | ${a.failures}/${a.attempts} | ${a.attempts ? Math.round((a.failures / a.attempts) * 100) : 0}% |`,
		)
		.join("\n");

	const factual = [
		`# 诊断报告 · ${input.incident.title}`,
		"",
		`结论: **${conclusionLabel(options.conclusion)}**${options.implicatedSections.length ? ` — ${options.implicatedSections.map((s) => `\`${s}\``).join(", ")}` : ""}`,
		"",
		`## 复现`,
		`- 原现场重放: ${input.reproduce.failures}/${input.reproduce.attempts} 次仍失败 (基线失败率 ${Math.round(input.baselineFailRate * 100)}%)`,
		"",
		...(input.contextFindings.length
			? ["## 上下文疑点", ...input.contextFindings.map((f) => `- ${f}`), ""]
			: []),
		...(input.ablation.length
			? ["## 消融矩阵", "", "| 禁用段落 | 仍失败 | 失败率 |", "|---|---|---|", table, ""]
			: []),
	].join("\n");

	if (!options.analysis) return factual;

	try {
		const response = await options.analysis.callModel({
			messages: [
				{
					role: "system",
					content:
						"Given the factual diagnosis data, write a 3-5 sentence conclusion paragraph in the incident's language: what caused the failure, confidence, and the concrete next action. Respond with the paragraph only.",
				},
				{ role: "user", content: factual },
			],
			model: options.analysis.model,
			signal: options.signal,
		});
		return `${factual}\n## AI 结论\n\n${response.content.trim()}\n`;
	} catch {
		return factual;
	}
}

function conclusionLabel(c: DiagnosisConclusion): string {
	switch (c) {
		case "not-reproducible":
			return "不可复现";
		case "context-missing":
			return "上下文缺失";
		case "section-implicated":
			return "提示词段落实锤";
		case "not-prompt-related":
			return "与提示词无关";
		case "version-regression":
			return "版本回归";
	}
}

// ── Context integrity check (diagnosis step ②, local) ──

/**
 * Cheap local check: do the key terms of the user message / note actually
 * appear in what the model saw? Flags likely compaction/dehydration loss.
 */
export function checkContextIntegrity(options: {
	userMessage: string;
	note?: string;
	contextText: string;
	promptText: string;
}): string[] {
	const findings: string[] = [];
	const haystack = `${options.contextText}\n${options.promptText}`;
	const terms = extractKeyTerms(`${options.userMessage} ${options.note ?? ""}`);
	const missing = terms.filter((t) => !haystack.includes(t));
	if (terms.length > 0 && missing.length / terms.length > 0.5) {
		findings.push(
			`用户消息中的关键词大量缺失于模型可见上下文: ${missing.slice(0, 5).join(", ")}`,
		);
	}
	if (options.contextText.includes('"omitted"')) {
		findings.push("上下文快照曾被截断(存在 omitted 标记)");
	}
	return findings;
}

function extractKeyTerms(text: string): string[] {
	const terms = new Set<string>();
	// Latin words >= 4 chars and CJK runs >= 2 chars
	for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_-]{3,}/g)) {
		terms.add(match[0]);
	}
	for (const match of text.matchAll(/[一-鿿]{2,}/g)) {
		terms.add(match[0]);
	}
	return [...terms].slice(0, 20);
}

function extractJson(output: string): Record<string, unknown> | null {
	const candidates = [output];
	const fence = output.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence) candidates.push(fence[1].trim());
	const obj = output.match(/\{[\s\S]*\}/);
	if (obj) candidates.push(obj[0]);
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate);
			if (parsed && typeof parsed === "object") return parsed;
		} catch {
			// next
		}
	}
	return null;
}

function short(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}
