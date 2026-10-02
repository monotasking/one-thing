/**
 * Round-trip tests for case-file.ts YAML parser/generator.
 *
 * Verifies that:
 * 1. Parsing then generating produces semantically equivalent YAML
 * 2. Generated YAML can be re-parsed to the same case definition
 * 3. The mini-YAML subset is strictly aligned between parser and generator
 */

import { describe, it, expect } from "vitest";
import {
	parseCaseYaml,
	generateCaseYaml,
	type CaseDefinition,
} from "../case-file.js";

describe("case-file round-trip", () => {
	it("round-trips a simple case with scalar values", () => {
		const input: CaseDefinition = {
			id: "test-case",
			description: "A test case for round-trip verification",
			fixture: "test.json",
			userMessage: "What is 2+2?",
			expect: {
				contains: "4",
			},
		};

		const yaml = generateCaseYaml(input);
		const parsed = parseCaseYaml(yaml);

		expect(parsed.id).toBe(input.id);
		expect(parsed.fixture).toBe(input.fixture);
		expect(parsed.userMessage).toBe(input.userMessage);
		expect((parsed.expect as Record<string, unknown>).contains).toBe("4");
	});

	it("round-trips firstToolCall expectation", () => {
		const input: CaseDefinition = {
			id: "tool-test",
			description: "Test first tool call",
			fixture: "tool.json",
			userMessage: "List files",
			expect: {
				firstToolCall: "list_files",
			},
		};

		const yaml = generateCaseYaml(input);
		const parsed = parseCaseYaml(yaml);

		expect(parsed.id).toBe("tool-test");
		expect((parsed.expect as Record<string, unknown>).firstToolCall).toBe(
			"list_files",
		);
	});

	it("round-trips notContains expectation", () => {
		const input: CaseDefinition = {
			id: "forbidden-test",
			description: "Ensure output avoids certain patterns",
			fixture: "test.json",
			userMessage: "Help",
			expect: {
				notContains: "I cannot help with that",
			},
		};

		const yaml = generateCaseYaml(input);
		const parsed = parseCaseYaml(yaml);

		expect((parsed.expect as Record<string, unknown>).notContains).toBe(
			"I cannot help with that",
		);
	});

	it("round-trips multi-line description via folded block scalar", () => {
		const input: CaseDefinition = {
			id: "multi-desc",
			description: "Line one\nLine two\nLine three",
			fixture: "test.json",
			userMessage: "Test",
			expect: {},
		};

		const yaml = generateCaseYaml(input);
		const parsed = parseCaseYaml(yaml);

		// Multi-line descriptions fold into a single joined string
		expect(parsed.description).toContain("Line one");
		expect(parsed.description).toContain("Line two");
	});

	it("handles existing case files faithfully", () => {
		// The parser must handle all existing case formats
		const existing = [
			{
				yaml: `id: agent-follows-instructions
description: >
  When a custom agent is configured, assistant should
  follow its specific system prompt.
fixture: placeholder.json
userMessage: What is 2+2?
expect:
  notes: >
    Custom agent system prompts should be respected.
    Soft judge expected (no hard assertion).
`,
				id: "agent-follows-instructions",
			},
			{
				yaml: `id: workdir-current-directory
description: >
  Agent should recognize working directory context
fixture: placeholder.json
userMessage: What's my current directory?
expect:
  contains: /
`,
				id: "workdir-current-directory",
			},
		];

		for (const ex of existing) {
			const parsed = parseCaseYaml(ex.yaml);
			expect(parsed.id).toBe(ex.id);
		}
	});

	it("round-trips a multi-line userMessage without corrupting the file", () => {
		const input: CaseDefinition = {
			id: "multiline-msg",
			description: "User messages often span multiple lines",
			fixture: "test.json",
			userMessage: "帮我改超时配置\n把 transreader 的翻译超时改成 30 秒\n谢谢",
			expect: {
				firstToolCall: "variable",
			},
		};

		const yaml = generateCaseYaml(input);
		const parsed = parseCaseYaml(yaml);

		// The full message must survive, and keys after userMessage must
		// still parse (a broken quoted scalar would swallow them).
		expect(parsed.userMessage).toBe(input.userMessage);
		expect((parsed.expect as Record<string, unknown>).firstToolCall).toBe(
			"variable",
		);
	});

	it("generator output is re-parseable", () => {
		// Generate YAML for a variety of case defs and verify they all re-parse
		const defs: CaseDefinition[] = [
			{
				id: "a",
				description: "Simple",
				fixture: "f.json",
				userMessage: "hi",
				expect: { firstToolCall: "bash" },
			},
			{
				id: "b",
				description: "Multi\nLine\nDesc",
				fixture: "b.json",
				userMessage: "hello world",
				expect: { contains: "hello" },
			},
			{
				id: "c",
				description: "With quotes",
				fixture: "c.json",
				userMessage: 'Say "hello"',
				expect: { notContains: "error" },
			},
			{
				id: "d",
				description: "Empty expect",
				fixture: "d.json",
				userMessage: "test",
				expect: {},
			},
		];

		for (const def of defs) {
			const yaml = generateCaseYaml(def);
			const parsed = parseCaseYaml(yaml);
			expect(parsed.id).toBe(def.id);
			expect(parsed.fixture).toBe(def.fixture);
		}
	});
});
