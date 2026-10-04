/**
 * Evaluator (Phase 2/3 runner)
 *
 * Evaluates model responses against YAML case expectations.
 * Two tiers:
 *   Hard: tool call + output pattern assertions (AND logic)
 *   Soft: LLM judge (Phase 3, optional)
 *
 * All expect fields are ANDed — first failure returns immediately.
 */

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface EvalExpectation {
	// ── Tool Call ──
	hasToolCalls?: boolean;
	minToolCalls?: number;
	maxToolCalls?: number;
	firstToolCall?: string | { name: string; args?: Record<string, unknown> };
	lastToolCall?: string | { name: string; args?: Record<string, unknown> };
	toolCalls?: Array<{ name: string; args?: Record<string, unknown> }>;
	toolCallContains?: { name: string; args?: Record<string, unknown> };
	toolCallAt?: Array<{
		index: number;
		name?: string;
		args?: Record<string, unknown>;
		argContains?: Record<string, string>;
	}>;
	noToolCalls?: string | string[];
	toolCallCount?: {
		name: string;
		min?: number;
		max?: number;
		exactly?: number;
	};

	// ── Skill ──
	skillUsed?: string | string[];
	anySkillUsed?: boolean;
	allSkillsUsed?: boolean;

	// ── MCP ──
	mcpToolUsed?: boolean;
	mcpServerUsed?: string;
	mcpToolUsedName?: string;

	// ── Output ──
	contains?: string | string[];
	notContains?: string | string[];
	minOutputLength?: number;
	maxOutputLength?: number;
	outputStartsWith?: string;
	outputEndsWith?: string;
	regex?: string;

	// ── Meta ──
	notes?: string;
	judge?: { rubric: string };
	output?: { contains?: string; notContains?: string };

	[key: string]: unknown;
}

export interface EvalResponse {
	content: string;
	toolCalls?: Array<{
		id?: string;
		name: string;
		args?: Record<string, unknown>;
	}>;
}

export interface EvalResult {
	pass: boolean;
	score: number;
	reason: string;
}

// ═══════════════════════════════════════════════════════════════
// Known expect keys for validation
// ═══════════════════════════════════════════════════════════════

export const KNOWN_EXPECT_KEYS = new Set([
	"hasToolCalls",
	"minToolCalls",
	"maxToolCalls",
	"firstToolCall",
	"lastToolCall",
	"toolCalls",
	"toolCallContains",
	"toolCallAt",
	"noToolCalls",
	"toolCallCount",
	"skillUsed",
	"anySkillUsed",
	"allSkillsUsed",
	"mcpToolUsed",
	"mcpServerUsed",
	"mcpToolUsedName",
	"contains",
	"notContains",
	"minOutputLength",
	"maxOutputLength",
	"outputStartsWith",
	"outputEndsWith",
	"regex",
	"notes",
	"judge",
	"output",
]);

// ═══════════════════════════════════════════════════════════════
// Check functions (each returns null = skip, or EvalResult)
// ═══════════════════════════════════════════════════════════════

function fail(score: number, reason: string): EvalResult {
	return { pass: false, score, reason };
}

function argsMatch(
	expected: Record<string, unknown> | undefined,
	actual: Record<string, unknown> | undefined,
	argContains?: Record<string, string>,
): { match: boolean; reason?: string } {
	if (!expected && !argContains) return { match: true };
	if (!actual) {
		return { match: false, reason: "expected args but got none" };
	}

	if (expected) {
		for (const [key, value] of Object.entries(expected)) {
			if ((actual as Record<string, unknown>)[key] !== value) {
				return {
					match: false,
					reason: `arg "${key}" expected "${JSON.stringify(value)}", got "${JSON.stringify((actual as Record<string, unknown>)[key])}"`,
				};
			}
		}
	}

	if (argContains) {
		for (const [key, value] of Object.entries(argContains)) {
			const actualVal = String((actual as Record<string, unknown>)[key] ?? "");
			if (!actualVal.includes(value)) {
				return {
					match: false,
					reason: `arg "${key}" expected to contain "${value}", got "${actualVal}"`,
				};
			}
		}
	}

	return { match: true };
}

function checkHasToolCalls(
	expect: EvalExpectation,
	toolCalls:
		| Array<{ name: string; args?: Record<string, unknown> }>
		| undefined,
): EvalResult | null {
	if (expect.hasToolCalls === undefined) return null;
	const count = toolCalls?.length ?? 0;
	if (expect.hasToolCalls && count === 0) {
		return fail(0, "Expected tool calls but none were made");
	}
	if (!expect.hasToolCalls && count > 0) {
		return fail(0, `Expected no tool calls but ${count} were made`);
	}
	return null;
}

function checkMinToolCalls(
	expect: EvalExpectation,
	toolCalls:
		| Array<{ name: string; args?: Record<string, unknown> }>
		| undefined,
): EvalResult | null {
	if (expect.minToolCalls === undefined) return null;
	const count = toolCalls?.length ?? 0;
	if (count < expect.minToolCalls) {
		return fail(
			0,
			`Expected at least ${expect.minToolCalls} tool calls, but got ${count}`,
		);
	}
	return null;
}

function checkMaxToolCalls(
	expect: EvalExpectation,
	toolCalls:
		| Array<{ name: string; args?: Record<string, unknown> }>
		| undefined,
): EvalResult | null {
	if (expect.maxToolCalls === undefined) return null;
	const count = toolCalls?.length ?? 0;
	if (count > expect.maxToolCalls) {
		return fail(
			0,
			`Expected at most ${expect.maxToolCalls} tool calls, but got ${count}`,
		);
	}
	return null;
}

function checkFirstToolCall(
	expect: EvalExpectation,
	toolCalls:
		| Array<{ name: string; args?: Record<string, unknown> }>
		| undefined,
): EvalResult | null {
	if (!expect.firstToolCall) return null;
	const expected =
		typeof expect.firstToolCall === "string"
			? { name: expect.firstToolCall }
			: expect.firstToolCall;
	const reqName = expected.name;

	if (!toolCalls || toolCalls.length === 0) {
		return fail(
			0,
			`Expected first tool call "${reqName}" but no tool calls made`,
		);
	}

	const firstCall = toolCalls[0];
	if (firstCall.name !== reqName) {
		return fail(
			0,
			`Expected first tool call "${reqName}", got "${firstCall.name}"`,
		);
	}

	const argResult = argsMatch(expected.args, firstCall.args);
	if (!argResult.match) {
		return fail(0.3, `Tool "${reqName}" called but ${argResult.reason}`);
	}

	return null;
}

function checkLastToolCall(
	expect: EvalExpectation,
	toolCalls:
		| Array<{ name: string; args?: Record<string, unknown> }>
		| undefined,
): EvalResult | null {
	if (!expect.lastToolCall) return null;
	const expected =
		typeof expect.lastToolCall === "string"
			? { name: expect.lastToolCall }
			: expect.lastToolCall;
	const reqName = expected.name;

	if (!toolCalls || toolCalls.length === 0) {
		return fail(
			0,
			`Expected last tool call "${reqName}" but no tool calls made`,
		);
	}

	const lastCall = toolCalls[toolCalls.length - 1];
	if (lastCall.name !== reqName) {
		return fail(
			0,
			`Expected last tool call "${reqName}", got "${lastCall.name}"`,
		);
	}

	const argResult = argsMatch(expected.args, lastCall.args);
	if (!argResult.match) {
		return fail(0.3, `Tool "${reqName}" called but ${argResult.reason}`);
	}

	return null;
}

function checkToolCallsExact(
	expect: EvalExpectation,
	toolCalls:
		| Array<{ name: string; args?: Record<string, unknown> }>
		| undefined,
): EvalResult | null {
	if (!expect.toolCalls || expect.toolCalls.length === 0) return null;
	if (!toolCalls) {
		return fail(
			0,
			`Expected ${expect.toolCalls.length} specific tool calls but none made`,
		);
	}

	const expected = expect.toolCalls;
	if (toolCalls.length < expected.length) {
		return fail(
			0,
			`Expected ${expected.length} tool calls but got ${toolCalls.length}`,
		);
	}

	for (let i = 0; i < expected.length; i++) {
		const exp = expected[i];
		const act = toolCalls[i];
		if (act.name !== exp.name) {
			return fail(
				0,
				`Tool call #${i + 1}: expected "${exp.name}", got "${act.name}"`,
			);
		}
		const argResult = argsMatch(exp.args, act.args);
		if (!argResult.match) {
			return fail(0.3, `Tool "${exp.name}" at #${i + 1}: ${argResult.reason}`);
		}
	}

	return null;
}

function checkToolCallContains(
	expect: EvalExpectation,
	toolCalls:
		| Array<{ name: string; args?: Record<string, unknown> }>
		| undefined,
): EvalResult | null {
	if (!expect.toolCallContains) return null;
	if (!toolCalls || toolCalls.length === 0) {
		return fail(
			0,
			`Expected tool call "${expect.toolCallContains.name}" anywhere but none made`,
		);
	}

	const ec = expect.toolCallContains;
	const found = toolCalls.some((tc) => {
		if (tc.name !== ec.name) return false;
		return argsMatch(ec.args, tc.args).match;
	});

	if (!found) {
		const argsDesc = ec.args ? ` with args ${JSON.stringify(ec.args)}` : "";
		return fail(
			0,
			`Expected "${ec.name}"${argsDesc} in tool calls but not found`,
		);
	}
	return null;
}

function checkToolCallAt(
	expect: EvalExpectation,
	toolCalls:
		| Array<{ name: string; args?: Record<string, unknown> }>
		| undefined,
): EvalResult | null {
	if (!expect.toolCallAt || expect.toolCallAt.length === 0) return null;
	if (!toolCalls) {
		return fail(0, `Expected tool calls at specific positions but none made`);
	}

	for (const at of expect.toolCallAt) {
		const tc = toolCalls[at.index];
		if (!tc) {
			return fail(
				0,
				`Expected tool call at index ${at.index} but only ${toolCalls.length} calls made`,
			);
		}
		if (at.name && tc.name !== at.name) {
			return fail(
				0,
				`Tool call at index ${at.index}: expected "${at.name}", got "${tc.name}"`,
			);
		}
		const argResult = argsMatch(at.args, tc.args, at.argContains);
		if (!argResult.match) {
			return fail(0.3, `Tool at index ${at.index}: ${argResult.reason}`);
		}
	}

	return null;
}

function checkNoToolCalls(
	expect: EvalExpectation,
	toolCalls:
		| Array<{ name: string; args?: Record<string, unknown> }>
		| undefined,
): EvalResult | null {
	if (!expect.noToolCalls) return null;
	if (!toolCalls || toolCalls.length === 0) return null;

	const forbidden = Array.isArray(expect.noToolCalls)
		? expect.noToolCalls
		: [expect.noToolCalls];

	for (const tc of toolCalls) {
		if (forbidden.includes(tc.name)) {
			return fail(0, `Tool "${tc.name}" is forbidden (noToolCalls)`);
		}
	}

	return null;
}

function checkToolCallCount(
	expect: EvalExpectation,
	toolCalls:
		| Array<{ name: string; args?: Record<string, unknown> }>
		| undefined,
): EvalResult | null {
	if (!expect.toolCallCount) return null;
	const { name, min, max, exactly } = expect.toolCallCount;
	const count = toolCalls?.filter((tc) => tc.name === name).length ?? 0;

	if (exactly !== undefined && count !== exactly) {
		return fail(
			0,
			`Expected "${name}" to be called exactly ${exactly} time(s), got ${count}`,
		);
	}
	if (min !== undefined && count < min) {
		return fail(
			0,
			`Expected "${name}" to be called at least ${min} time(s), got ${count}`,
		);
	}
	if (max !== undefined && count > max) {
		return fail(
			0,
			`Expected "${name}" to be called at most ${max} time(s), got ${count}`,
		);
	}

	return null;
}

// ── Skill helpers ──────────────────────────────────────────

function isSkillRead(tc: {
	name: string;
	args?: Record<string, unknown>;
}): boolean {
	if (tc.name === "read") {
		return (
			typeof tc.args?.path === "string" && tc.args.path.includes("SKILL.md")
		);
	}
	if (tc.name === "bash") {
		const cmd = String(tc.args?.command ?? "");
		return /(?:cat|less|head|tail|more)\s+.*SKILL\.md/.test(cmd);
	}
	return false;
}

function skillNameFromCall(tc: {
	name: string;
	args?: Record<string, unknown>;
}): string | null {
	const path = tc.args?.path ?? tc.args?.command ?? "";
	const m = String(path).match(/\/([^/]+)\/SKILL\.md/);
	return m ? m[1] : null;
}

function checkSkillUsed(
	expect: EvalExpectation,
	toolCalls:
		| Array<{ name: string; args?: Record<string, unknown> }>
		| undefined,
): EvalResult | null {
	if (!expect.skillUsed) return null;

	const targets = Array.isArray(expect.skillUsed)
		? expect.skillUsed
		: [expect.skillUsed];

	const skillCalls = toolCalls?.filter(isSkillRead) ?? [];
	const usedNames = new Set(
		skillCalls.map(skillNameFromCall).filter((n): n is string => n !== null),
	);

	// Single target: must match
	if (!Array.isArray(expect.skillUsed)) {
		const target = expect.skillUsed;
		if (!usedNames.has(target)) {
			return fail(
				0,
				`Expected skill "${target}" to be used (SKILL.md read), but it was not`,
			);
		}
		return null;
	}

	// Array: OR logic — at least one must match
	const anyMatch = targets.some((t) => usedNames.has(t));
	if (!anyMatch) {
		return fail(
			0,
			`Expected at least one skill from [${targets.join(", ")}] to be used, but none were`,
		);
	}
	return null;
}

function checkAnySkillUsed(
	expect: EvalExpectation,
	toolCalls:
		| Array<{ name: string; args?: Record<string, unknown> }>
		| undefined,
): EvalResult | null {
	if (expect.anySkillUsed === undefined) return null;
	const hasSkill = toolCalls?.some(isSkillRead) ?? false;

	if (expect.anySkillUsed && !hasSkill) {
		return fail(
			0,
			"Expected any skill to be used (SKILL.md read) but none were",
		);
	}
	if (!expect.anySkillUsed && hasSkill) {
		return fail(0, "Expected no skill usage but SKILL.md reads were detected");
	}
	return null;
}

function checkAllSkillsUsed(
	expect: EvalExpectation,
	toolCalls:
		| Array<{ name: string; args?: Record<string, unknown> }>
		| undefined,
	_allSkills?: Array<{ name: string }>,
): EvalResult | null {
	if (!expect.allSkillsUsed) return null;
	// allSkillsUsed requires fixture context (passed via runner).
	// In hard evaluator alone, we can't check this without context.
	// The runner passes the full skill list via a separate mechanism.
	return null;
}

// ── MCP helpers ────────────────────────────────────────────

function checkMCPToolUsed(
	expect: EvalExpectation,
	toolCalls:
		| Array<{ name: string; args?: Record<string, unknown> }>
		| undefined,
): EvalResult | null {
	if (expect.mcpToolUsed === undefined) return null;
	const hasMCP = toolCalls?.some((tc) => tc.name.startsWith("mcp__")) ?? false;

	if (expect.mcpToolUsed && !hasMCP) {
		return fail(0, "Expected MCP tool usage (mcp__ prefix) but none detected");
	}
	if (!expect.mcpToolUsed && hasMCP) {
		return fail(0, "Expected no MCP tool usage but mcp__ calls detected");
	}
	return null;
}

function checkMCPServerUsed(
	expect: EvalExpectation,
	toolCalls:
		| Array<{ name: string; args?: Record<string, unknown> }>
		| undefined,
): EvalResult | null {
	if (!expect.mcpServerUsed) return null;
	const prefix = `mcp__${expect.mcpServerUsed}__`;
	const found = toolCalls?.some((tc) => tc.name.startsWith(prefix)) ?? false;

	if (!found) {
		return fail(
			0,
			`Expected MCP server "${expect.mcpServerUsed}" to be used but no "${prefix}*" calls detected`,
		);
	}
	return null;
}

function checkMCPToolUsedName(
	expect: EvalExpectation,
	toolCalls:
		| Array<{ name: string; args?: Record<string, unknown> }>
		| undefined,
): EvalResult | null {
	if (!expect.mcpToolUsedName) return null;
	const found =
		toolCalls?.some((tc) => tc.name === expect.mcpToolUsedName) ?? false;

	if (!found) {
		return fail(
			0,
			`Expected MCP tool "${expect.mcpToolUsedName}" to be called but it was not`,
		);
	}
	return null;
}

// ── Output text helpers ────────────────────────────────────

function checkContains(
	expect: EvalExpectation,
	content: string,
): EvalResult | null {
	const targets: string[] = [];

	if (typeof expect.contains === "string") targets.push(expect.contains);
	else if (Array.isArray(expect.contains)) targets.push(...expect.contains);
	if (expect.output?.contains) targets.push(expect.output.contains);

	if (targets.length === 0) return null;

	for (const t of targets) {
		if (!content.includes(t)) {
			return fail(0, `Output does not contain "${t}"`);
		}
	}
	return null;
}

function checkNotContains(
	expect: EvalExpectation,
	content: string,
): EvalResult | null {
	const forbidden: string[] = [];

	if (typeof expect.notContains === "string")
		forbidden.push(expect.notContains);
	else if (Array.isArray(expect.notContains))
		forbidden.push(...expect.notContains);
	if (expect.output?.notContains) forbidden.push(expect.output.notContains);

	if (forbidden.length === 0) return null;

	for (const f of forbidden) {
		if (content.includes(f)) {
			return fail(0, `Output contains forbidden pattern "${f}"`);
		}
	}
	return null;
}

function checkMinOutputLength(
	expect: EvalExpectation,
	content: string,
): EvalResult | null {
	if (expect.minOutputLength === undefined) return null;
	if (content.length < expect.minOutputLength) {
		return fail(
			0,
			`Output length ${content.length} < minimum ${expect.minOutputLength}`,
		);
	}
	return null;
}

function checkMaxOutputLength(
	expect: EvalExpectation,
	content: string,
): EvalResult | null {
	if (expect.maxOutputLength === undefined) return null;
	if (content.length > expect.maxOutputLength) {
		return fail(
			0,
			`Output length ${content.length} > maximum ${expect.maxOutputLength}`,
		);
	}
	return null;
}

function checkStartsWith(
	expect: EvalExpectation,
	content: string,
): EvalResult | null {
	if (!expect.outputStartsWith) return null;
	if (!content.startsWith(expect.outputStartsWith)) {
		return fail(0, `Output does not start with "${expect.outputStartsWith}"`);
	}
	return null;
}

function checkEndsWith(
	expect: EvalExpectation,
	content: string,
): EvalResult | null {
	if (!expect.outputEndsWith) return null;
	if (!content.endsWith(expect.outputEndsWith)) {
		return fail(0, `Output does not end with "${expect.outputEndsWith}"`);
	}
	return null;
}

function checkRegex(
	expect: EvalExpectation,
	content: string,
): EvalResult | null {
	if (!expect.regex) return null;
	try {
		const re = new RegExp(expect.regex);
		if (!re.test(content)) {
			return fail(0, `Output does not match regex /${expect.regex}/`);
		}
	} catch {
		return fail(0, `Invalid regex: "${expect.regex}"`);
	}
	return null;
}

// ═══════════════════════════════════════════════════════════════
// Main evaluator
// ═══════════════════════════════════════════════════════════════

type CheckFn = () => EvalResult | null;

/**
 * Hard evaluator: checks all assertions with AND logic.
 * First failing check returns immediately.
 */
export function evaluateHard(
	caseExpect: EvalExpectation,
	response: EvalResponse,
): EvalResult {
	const toolCalls = response.toolCalls ?? [];
	const content = response.content;

	const checks: CheckFn[] = [
		// Tool Call
		() => checkHasToolCalls(caseExpect, toolCalls),
		() => checkMinToolCalls(caseExpect, toolCalls),
		() => checkMaxToolCalls(caseExpect, toolCalls),
		() => checkFirstToolCall(caseExpect, toolCalls),
		() => checkLastToolCall(caseExpect, toolCalls),
		() => checkToolCallsExact(caseExpect, toolCalls),
		() => checkToolCallContains(caseExpect, toolCalls),
		() => checkToolCallAt(caseExpect, toolCalls),
		() => checkNoToolCalls(caseExpect, toolCalls),
		() => checkToolCallCount(caseExpect, toolCalls),
		// Skill
		() => checkSkillUsed(caseExpect, toolCalls),
		() => checkAnySkillUsed(caseExpect, toolCalls),
		() => checkAllSkillsUsed(caseExpect, toolCalls),
		// MCP
		() => checkMCPToolUsed(caseExpect, toolCalls),
		() => checkMCPServerUsed(caseExpect, toolCalls),
		() => checkMCPToolUsedName(caseExpect, toolCalls),
		// Output
		() => checkContains(caseExpect, content),
		() => checkNotContains(caseExpect, content),
		() => checkMinOutputLength(caseExpect, content),
		() => checkMaxOutputLength(caseExpect, content),
		() => checkStartsWith(caseExpect, content),
		() => checkEndsWith(caseExpect, content),
		() => checkRegex(caseExpect, content),
	];

	for (const check of checks) {
		const result = check();
		if (result !== null && !result.pass) return result;
	}

	return { pass: true, score: 1, reason: "All expectations met" };
}

/**
 * Evaluate with optional LLM judge.
 */
export function evaluate(
	caseDef: { expect: EvalExpectation },
	response: EvalResponse,
): EvalResult {
	const hardResult = evaluateHard(caseDef.expect, response);

	if (!hardResult.pass) return hardResult;

	if (caseDef.expect?.judge) {
		return {
			...hardResult,
			score: hardResult.score,
			reason: `${hardResult.reason} (soft judge rubric: ${caseDef.expect.judge.rubric})`,
		};
	}

	return hardResult;
}
