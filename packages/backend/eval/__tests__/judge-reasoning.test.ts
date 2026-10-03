/**
 * Judge output parsing under reasoning-first prompting: the verdict JSON
 * FOLLOWS free-form analysis text that may itself contain braces, fences,
 * or JSON-looking fragments. Parsers must pick the LAST valid object, and
 * legacy JSON-only outputs must keep parsing.
 */

import { describe, it, expect } from "vitest";
import {
	parseJudgeOutput,
	parseRubricVerdict,
	normalizeRubricClauses,
	buildRubricJudgeMessages,
	buildJudgePrompt,
} from "../judge.js";

describe("parseJudgeOutput (reasoning-first)", () => {
	it("parses a verdict on the last line after analysis text", () => {
		const output = [
			"The assistant was asked to switch directories but stayed in /tmp.",
			"This clearly violates the directory instructions.",
			'{"score": 0.2, "category": "missed-directory-switch", "reason": "stayed in /tmp"}',
		].join("\n");
		const result = parseJudgeOutput(output);
		expect(result).toEqual({
			score: 0.2,
			category: "missed-directory-switch",
			reason: "stayed in /tmp",
		});
	});

	it("picks the LAST object when the analysis quotes JSON", () => {
		const output = [
			'The user message contained {"path": "/repo"} which the assistant ignored.',
			'{"score": 0.4, "category": "general-poor-response", "reason": "ignored the path"}',
		].join("\n");
		expect(parseJudgeOutput(output)?.score).toBe(0.4);
	});

	it("still parses legacy JSON-only output", () => {
		const output =
			'{"score": 1, "category": "not-prompt-fault", "reason": "fine"}';
		expect(parseJudgeOutput(output)?.score).toBe(1);
	});

	it("parses a fenced verdict", () => {
		const output = [
			"Analysis: acceptable response.",
			"```json",
			'{"score": 0.9, "category": "not-prompt-fault", "reason": "ok"}',
			"```",
		].join("\n");
		expect(parseJudgeOutput(output)?.score).toBe(0.9);
	});

	it("returns null for output with no valid verdict", () => {
		expect(parseJudgeOutput("no json here at all")).toBeNull();
		expect(parseJudgeOutput('{"score": 5, "category": "bogus"}')).toBeNull();
	});
});

describe("parseRubricVerdict (reasoning-first)", () => {
	it("parses the verdict after multi-line analysis with braces", () => {
		const output = [
			"1. The assistant did call read() as expected — satisfied.",
			'2. The reply mentions {"config": true} — satisfied.',
			'{"pass": true, "reason": "all expectations satisfied"}',
		].join("\n");
		expect(parseRubricVerdict(output)).toEqual({
			pass: true,
			reason: "all expectations satisfied",
		});
	});

	it("still parses legacy JSON-only verdicts", () => {
		expect(parseRubricVerdict('{"pass": false, "reason": "nope"}')).toEqual({
			pass: false,
			reason: "nope",
		});
	});
});

describe("rubric clause checklist", () => {
	it("normalizes string and array rubrics", () => {
		expect(normalizeRubricClauses("do the thing")).toEqual(["do the thing"]);
		expect(normalizeRubricClauses(["a", " b ", ""])).toEqual(["a", "b"]);
	});

	it("renders array rubrics as a numbered checklist", () => {
		const { system, user } = buildRubricJudgeMessages({
			rubric: ["must call read first", "must not mention /tmp"],
			userMessage: "open the config",
			transcriptText: "[assistant] done",
		});
		expect(user).toContain("1. must call read first");
		expect(user).toContain("2. must not mention /tmp");
		expect(system).toContain("EVERY numbered expectation");
	});

	it("prompts reasoning-first with a last-line JSON verdict", () => {
		const { system } = buildRubricJudgeMessages({
			rubric: "x",
			userMessage: "u",
			transcriptText: "t",
		});
		expect(system).toContain("Analysis");
		expect(system).toContain("LAST line");
		expect(buildJudgePrompt()).toContain("LAST line");
	});
});
