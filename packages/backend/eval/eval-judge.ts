/**
 * LLM Judge for evaluating turn quality.
 * Phase 3 of the prompt evaluation system.
 *
 * Usage:
 * - Judge only turns with negative implicit signals + random 10% sample.
 * - Output: score (0-1), category (failure classification), reason (one sentence).
 * - Requires calibration: human-annotated set of >=20 turns, judge accuracy >=85%.
 *
 * Both judges use reasoning-first output: the model writes a short plain-text
 * analysis, then emits the verdict as a single JSON object on the last line.
 * The analysis is discarded after parsing — asking the model to think before
 * deciding measurably improves judgement quality on complex cases, at the
 * cost of a few hundred extra output tokens per call.
 */

/**
 * Failure categories aligned with builder sections for attribution.
 */
export const JUDGE_CATEGORIES = [
	"missed-directory-switch",
	"ignored-skill-instructions",
	"voice-mode-violation",
	"ignored-known-projects",
	"wrong-platform-behavior",
	"ignored-agent-instructions",
	"general-poor-response",
	"not-prompt-fault",
] as const;

export type JudgeCategory = (typeof JUDGE_CATEGORIES)[number];

export interface JudgeResult {
	score: number; // 0-1, where 1 = perfect
	category: JudgeCategory;
	reason: string; // one-sentence explanation
}

export interface JudgeInput {
	userMessage: string;
	assistantResponse: string;
	promptContext?: string; // optional: the system prompt used
	signals?: {
		retried?: boolean;
		editResent?: boolean;
		toolErrors?: number;
		streamAborted?: boolean;
	};
}

/**
 * Build the judge system prompt. Designed to be cheap to run
 * (works well with fast models like haiku/flash).
 */
export function buildJudgePrompt(): string {
	return [
		"You are an expert evaluator of AI chat assistant responses. Your job is to judge whether an AI assistant responded appropriately to a user request, given the system prompt instructions it was given.",
		"",
		"Work in two steps:",
		"1. Analysis — think through the evaluation in a few plain-text sentences: what the instructions required, what the assistant actually did, and where (if anywhere) they diverge. This analysis is discarded after parsing; it exists to make your verdict more accurate.",
		"2. Verdict — output a single JSON object as the LAST line of your response (no code fence):",
		'{"score": <number 0-1>, "category": "<category>", "reason": "<one sentence>"}',
		"",
		"Fields:",
		"- score: number between 0 and 1 (1 = perfect, 0 = completely wrong)",
		"- category: one of:",
		...JUDGE_CATEGORIES.map((c) => `  - ${c}`),
		"- reason: one-sentence explanation of the score",
		"",
		"Categories guide:",
		"- missed-directory-switch: assistant should have switched working directory but did not",
		"- ignored-skill-instructions: assistant should have used a skill instruction but did not",
		"- voice-mode-violation: assistant used code blocks or long output in voice mode",
		"- ignored-known-projects: assistant did not use known project context when relevant",
		"- wrong-platform-behavior: assistant used wrong OS syntax",
		"- ignored-agent-instructions: assistant ignored custom agent instructions",
		"- general-poor-response: response was poor but not attributable to a specific section",
		"- not-prompt-fault: the failure is not attributable to prompt design (model limitation, tool failure, etc.)",
		"",
		"Be objective and concise. Only flag issues when the assistant clearly violated instructions.",
	].join("\n");
}

/**
 * Build the user message for the judge, containing the prompt context and the exchange.
 */
export function buildJudgeUserMessage(input: JudgeInput): string {
	const parts: string[] = [];

	if (input.promptContext) {
		parts.push("# System Prompt Context");
		parts.push("The system prompt given to the assistant (abbreviated):");
		parts.push(input.promptContext.slice(0, 2000));
		parts.push("");
	}

	if (input.signals) {
		parts.push("# Signals");
		const sigs: string[] = [];
		if (input.signals.retried)
			sigs.push("- User retried the response (strong negative)");
		if (input.signals.editResent)
			sigs.push("- User edited and resent (strong negative)");
		if (input.signals.toolErrors && input.signals.toolErrors > 0)
			sigs.push(`- ${input.signals.toolErrors} tool error(s)`);
		if (input.signals.streamAborted) sigs.push("- Stream was aborted");
		parts.push(sigs.join("\n"));
		parts.push("");
	}

	parts.push("# User Message");
	parts.push(input.userMessage);
	parts.push("");
	parts.push("# Assistant Response");
	parts.push(input.assistantResponse.slice(0, 4000));
	parts.push("");
	parts.push(
		"Evaluate the assistant response: write your brief analysis, then the JSON verdict as the last line.",
	);

	return parts.join("\n");
}

// ── Verdict extraction (shared) ────────────────────────
//
// Reasoning-first output means the JSON verdict FOLLOWS free text that may
// itself contain braces. Candidates are tried in order: fenced blocks (last
// first), the last balanced {...} object, then legacy greedy fallbacks for
// old-style JSON-only outputs.

function extractLastBalancedObject(text: string): string | null {
	const end = text.lastIndexOf("}");
	if (end < 0) return null;
	let depth = 0;
	for (let i = end; i >= 0; i--) {
		const ch = text[i];
		if (ch === "}") depth++;
		else if (ch === "{") {
			depth--;
			if (depth === 0) return text.slice(i, end + 1);
		}
	}
	return null;
}

function extractJsonCandidates(output: string): string[] {
	const candidates: string[] = [];
	const fences = [...output.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
	for (let i = fences.length - 1; i >= 0; i--) {
		candidates.push(fences[i][1].trim());
	}
	const balanced = extractLastBalancedObject(output);
	if (balanced) candidates.push(balanced);
	const greedy = output.match(/\{[\s\S]*\}/);
	if (greedy) candidates.push(greedy[0]);
	candidates.push(output.trim());
	return candidates;
}

/**
 * Parse judge output (robust against markdown code fences and the
 * reasoning text preceding the verdict).
 */
export function parseJudgeOutput(output: string): JudgeResult | null {
	for (const candidate of extractJsonCandidates(output)) {
		try {
			return validateJudgeResult(JSON.parse(candidate));
		} catch {
			// try next candidate
		}
	}
	return null;
}

// ── Rubric judging (workbench W2/W4, design D5) ────────
//
// Per-incident rubric judging asks a NARROW question — "does this replay
// satisfy the user's stated expectation?" — which needs no global judge
// calibration (the rubric is human-provided at 👎 time or AI-extracted
// from the note).

export interface RubricVerdict {
	pass: boolean;
	reason: string;
}

/**
 * Normalize a rubric into judgeable clauses. A string is one clause; an
 * array is a checklist where EVERY clause must hold for pass=true.
 */
export function normalizeRubricClauses(rubric: string | string[]): string[] {
	const raw = Array.isArray(rubric) ? rubric : [rubric];
	return raw.map((r) => r.trim()).filter(Boolean);
}

export function buildRubricJudgeMessages(options: {
	/** The expectation(s) to judge against (👎 note or AI-extracted rubric).
	 * An array is a clause checklist: violating any clause fails the verdict. */
	rubric: string | string[];
	userMessage: string;
	/** Compact text view of the replay transcript (transcriptToText). */
	transcriptText: string;
	/** Optional: what the assistant originally did (to detect "same mistake"). */
	originalBehavior?: string;
	/** Fraction of tool results that were simulated/stubbed, for honesty. */
	mockCaveat?: string;
}): { system: string; user: string } {
	const clauses = normalizeRubricClauses(options.rubric);
	const system = [
		"You judge whether an AI assistant's behavior satisfies specific expectations.",
		"Work in two steps:",
		"1. Analysis — reason briefly (plain text) through each numbered expectation against the replayed behavior. This analysis is discarded after parsing.",
		'2. Verdict — output a single JSON object as the LAST line (no code fence): {"pass": boolean, "reason": "one sentence"}.',
		"pass=true only when the behavior clearly satisfies EVERY numbered expectation; if any single expectation is clearly violated, pass=false. Be strict.",
		"Tool results marked simulated/stub are replay mocks — judge the assistant's INTENT and actions, not mock content quality.",
	].join("\n");

	const parts = [
		"# Expectations (the behavior must satisfy ALL of these)",
		...clauses.map((c, i) => `${i + 1}. ${c}`),
		"",
		"# User request",
		options.userMessage,
		"",
	];
	if (options.originalBehavior) {
		parts.push(
			"# Original (bad) behavior for reference",
			options.originalBehavior,
			"",
		);
	}
	if (options.mockCaveat) {
		parts.push(`# Replay note`, options.mockCaveat, "");
	}
	parts.push("# Replayed behavior (judge this)", options.transcriptText, "");
	parts.push(
		"Write your brief analysis, then the JSON verdict as the last line.",
	);

	return { system, user: parts.join("\n") };
}

export function parseRubricVerdict(output: string): RubricVerdict | null {
	for (const candidate of extractJsonCandidates(output)) {
		try {
			const parsed = JSON.parse(candidate);
			if (typeof parsed?.pass === "boolean") {
				return { pass: parsed.pass, reason: String(parsed.reason ?? "") };
			}
		} catch {
			// try next candidate
		}
	}
	return null;
}

function validateJudgeResult(raw: unknown): JudgeResult {
	if (typeof raw !== "object" || raw === null) {
		throw new Error("Judge output is not an object");
	}

	const obj = raw as Record<string, unknown>;

	if (typeof obj.score !== "number" || obj.score < 0 || obj.score > 1) {
		throw new Error(`Invalid score: ${obj.score}`);
	}

	const category = String(obj.category ?? "");
	if (!(JUDGE_CATEGORIES as readonly string[]).includes(category)) {
		throw new Error(`Invalid category: ${category}`);
	}

	return {
		score: obj.score,
		category: category as JudgeCategory,
		reason: String(obj.reason ?? ""),
	};
}
