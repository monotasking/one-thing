/**
 * Evaluator (Phase 2/3 runner) — CLI mirror
 *
 * Mirrors packages/backend/eval/eval-evaluator.ts.
 * The CLI runner delegates to the runtime package, so this file is
 * kept in sync for standalone use / testing.
 */

function fail(score, reason) {
	return { pass: false, score, reason };
}

function argsMatch(expected, actual, argContains) {
	if (!expected && !argContains) return { match: true };
	if (!actual) return { match: false, reason: "expected args but got none" };
	if (expected) {
		for (const [key, value] of Object.entries(expected)) {
			if (actual[key] !== value) {
				return {
					match: false,
					reason: `arg "${key}" expected "${JSON.stringify(value)}", got "${JSON.stringify(actual[key])}"`,
				};
			}
		}
	}
	if (argContains) {
		for (const [key, value] of Object.entries(argContains)) {
			if (!String(actual[key] ?? "").includes(value)) {
				return {
					match: false,
					reason: `arg "${key}" expected to contain "${value}"`,
				};
			}
		}
	}
	return { match: true };
}

function isSkillRead(tc) {
	if (tc.name === "read")
		return (
			typeof tc.args?.path === "string" && tc.args.path.includes("SKILL.md")
		);
	if (tc.name === "bash")
		return /(?:cat|less|head|tail|more)\s+.*SKILL\.md/.test(
			String(tc.args?.command ?? ""),
		);
	return false;
}

function skillNameFromCall(tc) {
	const path = tc.args?.path ?? tc.args?.command ?? "";
	const m = String(path).match(/\/([^/]+)\/SKILL\.md/);
	return m ? m[1] : null;
}

export function evaluateHard(caseExpect, response) {
	const expect = caseExpect;
	const toolCalls = response.toolCalls ?? [];
	const content = response.content ?? "";

	// ── Tool Call ──
	if (expect.hasToolCalls !== undefined) {
		if (expect.hasToolCalls && toolCalls.length === 0)
			return fail(0, "Expected tool calls but none were made");
		if (!expect.hasToolCalls && toolCalls.length > 0)
			return fail(
				0,
				`Expected no tool calls but ${toolCalls.length} were made`,
			);
	}
	if (
		expect.minToolCalls !== undefined &&
		toolCalls.length < expect.minToolCalls
	) {
		return fail(
			0,
			`Expected at least ${expect.minToolCalls} tool calls, got ${toolCalls.length}`,
		);
	}
	if (
		expect.maxToolCalls !== undefined &&
		toolCalls.length > expect.maxToolCalls
	) {
		return fail(
			0,
			`Expected at most ${expect.maxToolCalls} tool calls, got ${toolCalls.length}`,
		);
	}

	// firstToolCall
	if (expect.firstToolCall) {
		const expected =
			typeof expect.firstToolCall === "string"
				? { name: expect.firstToolCall }
				: expect.firstToolCall;
		if (toolCalls.length === 0)
			return fail(
				0,
				`Expected first tool call "${expected.name}" but none made`,
			);
		if (toolCalls[0].name !== expected.name)
			return fail(
				0,
				`Expected first tool call "${expected.name}", got "${toolCalls[0].name}"`,
			);
		const ar = argsMatch(expected.args, toolCalls[0].args);
		if (!ar.match) return fail(0.3, `Tool "${expected.name}": ${ar.reason}`);
	}

	// lastToolCall
	if (expect.lastToolCall) {
		const expected =
			typeof expect.lastToolCall === "string"
				? { name: expect.lastToolCall }
				: expect.lastToolCall;
		if (toolCalls.length === 0)
			return fail(
				0,
				`Expected last tool call "${expected.name}" but none made`,
			);
		const last = toolCalls[toolCalls.length - 1];
		if (last.name !== expected.name)
			return fail(
				0,
				`Expected last tool call "${expected.name}", got "${last.name}"`,
			);
		const ar = argsMatch(expected.args, last.args);
		if (!ar.match) return fail(0.3, `Tool "${expected.name}": ${ar.reason}`);
	}

	// toolCalls exact sequence
	if (expect.toolCalls?.length) {
		if (toolCalls.length < expect.toolCalls.length)
			return fail(
				0,
				`Expected ${expect.toolCalls.length} tool calls, got ${toolCalls.length}`,
			);
		for (let i = 0; i < expect.toolCalls.length; i++) {
			const exp = expect.toolCalls[i];
			const act = toolCalls[i];
			if (act.name !== exp.name)
				return fail(
					0,
					`Tool call #${i + 1}: expected "${exp.name}", got "${act.name}"`,
				);
			const ar = argsMatch(exp.args, act.args);
			if (!ar.match)
				return fail(0.3, `Tool "${exp.name}" at #${i + 1}: ${ar.reason}`);
		}
	}

	// toolCallContains
	if (expect.toolCallContains) {
		const ec = expect.toolCallContains;
		const found = toolCalls.some(
			(tc) => tc.name === ec.name && argsMatch(ec.args, tc.args).match,
		);
		if (!found)
			return fail(0, `Expected "${ec.name}" in tool calls but not found`);
	}

	// toolCallAt
	if (expect.toolCallAt?.length) {
		for (const at of expect.toolCallAt) {
			const tc = toolCalls[at.index];
			if (!tc)
				return fail(
					0,
					`Expected tool call at index ${at.index} but only ${toolCalls.length} calls made`,
				);
			if (at.name && tc.name !== at.name)
				return fail(
					0,
					`Tool at index ${at.index}: expected "${at.name}", got "${tc.name}"`,
				);
			const ar = argsMatch(at.args, tc.args, at.argContains);
			if (!ar.match)
				return fail(0.3, `Tool at index ${at.index}: ${ar.reason}`);
		}
	}

	// noToolCalls
	if (expect.noToolCalls) {
		const forbidden = Array.isArray(expect.noToolCalls)
			? expect.noToolCalls
			: [expect.noToolCalls];
		for (const tc of toolCalls) {
			if (forbidden.includes(tc.name))
				return fail(0, `Tool "${tc.name}" is forbidden (noToolCalls)`);
		}
	}

	// toolCallCount
	if (expect.toolCallCount) {
		const { name, min, max, exactly } = expect.toolCallCount;
		const count = toolCalls.filter((tc) => tc.name === name).length;
		if (exactly !== undefined && count !== exactly)
			return fail(
				0,
				`Expected "${name}" exactly ${exactly} time(s), got ${count}`,
			);
		if (min !== undefined && count < min)
			return fail(
				0,
				`Expected "${name}" at least ${min} time(s), got ${count}`,
			);
		if (max !== undefined && count > max)
			return fail(0, `Expected "${name}" at most ${max} time(s), got ${count}`);
	}

	// ── Skill ──
	if (expect.skillUsed) {
		const targets = Array.isArray(expect.skillUsed)
			? expect.skillUsed
			: [expect.skillUsed];
		const skillCalls = toolCalls.filter(isSkillRead);
		const usedNames = new Set(
			skillCalls.map(skillNameFromCall).filter(Boolean),
		);
		if (!Array.isArray(expect.skillUsed)) {
			if (!usedNames.has(expect.skillUsed))
				return fail(
					0,
					`Expected skill "${expect.skillUsed}" to be used but it was not`,
				);
		} else {
			if (!targets.some((t) => usedNames.has(t)))
				return fail(
					0,
					`Expected at least one skill from [${targets}] to be used`,
				);
		}
	}

	if (expect.anySkillUsed !== undefined) {
		const has = toolCalls.some(isSkillRead);
		if (expect.anySkillUsed && !has)
			return fail(0, "Expected any skill to be used but none were");
		if (!expect.anySkillUsed && has)
			return fail(0, "Expected no skill usage but detected");
	}

	// ── MCP ──
	if (expect.mcpToolUsed !== undefined) {
		const has = toolCalls.some((tc) => tc.name.startsWith("mcp__"));
		if (expect.mcpToolUsed && !has)
			return fail(0, "Expected MCP tool usage but none detected");
		if (!expect.mcpToolUsed && has)
			return fail(0, "Expected no MCP tool but detected");
	}

	if (expect.mcpServerUsed) {
		const prefix = `mcp__${expect.mcpServerUsed}__`;
		if (!toolCalls.some((tc) => tc.name.startsWith(prefix)))
			return fail(
				0,
				`Expected MCP server "${expect.mcpServerUsed}" but not used`,
			);
	}

	if (expect.mcpToolUsedName) {
		if (!toolCalls.some((tc) => tc.name === expect.mcpToolUsedName))
			return fail(
				0,
				`Expected MCP tool "${expect.mcpToolUsedName}" but not called`,
			);
	}

	// ── Output ──
	const cs = [];
	if (typeof expect.contains === "string") cs.push(expect.contains);
	else if (Array.isArray(expect.contains)) cs.push(...expect.contains);
	if (expect.output?.contains) cs.push(expect.output.contains);
	for (const c of cs) {
		if (!content.includes(c)) return fail(0, `Output does not contain "${c}"`);
	}

	const ns = [];
	if (typeof expect.notContains === "string") ns.push(expect.notContains);
	else if (Array.isArray(expect.notContains)) ns.push(...expect.notContains);
	if (expect.output?.notContains) ns.push(expect.output.notContains);
	for (const n of ns) {
		if (content.includes(n)) return fail(0, `Output contains forbidden "${n}"`);
	}

	if (
		expect.minOutputLength !== undefined &&
		content.length < expect.minOutputLength
	)
		return fail(
			0,
			`Output length ${content.length} < ${expect.minOutputLength}`,
		);
	if (
		expect.maxOutputLength !== undefined &&
		content.length > expect.maxOutputLength
	)
		return fail(
			0,
			`Output length ${content.length} > ${expect.maxOutputLength}`,
		);
	if (expect.outputStartsWith && !content.startsWith(expect.outputStartsWith))
		return fail(0, `Output does not start with "${expect.outputStartsWith}"`);
	if (expect.outputEndsWith && !content.endsWith(expect.outputEndsWith))
		return fail(0, `Output does not end with "${expect.outputEndsWith}"`);
	if (expect.regex) {
		try {
			if (!new RegExp(expect.regex).test(content))
				return fail(0, `Output does not match /${expect.regex}/`);
		} catch {
			return fail(0, `Invalid regex "${expect.regex}"`);
		}
	}

	return { pass: true, score: 1, reason: "All expectations met" };
}

export function evaluate(caseDef, response) {
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
