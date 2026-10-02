import { describe, expect, it } from "vitest";
import {
	applyExactEditsToNormalizedContent,
	detectLineEnding,
	normalizeToLF,
	previewExactEdits,
	restoreLineEndings,
	stripBom,
	findClosestRegionSnippet,
} from "../edit-engine.js";

describe("runtime edit-engine", () => {
	it("applies multiple disjoint edits against the original content", () => {
		const result = applyExactEditsToNormalizedContent(
			"one A\ntwo B\nthree C\n",
			[
				{ oldText: "one A", newText: "one X" },
				{ oldText: "three C", newText: "three Z" },
			],
			"file.txt",
		);

		expect(result.newContent).toBe("one X\ntwo B\nthree Z\n");
	});

	it("requires exact non-empty oldText and rejects no-op replacements", () => {
		expect(() =>
			applyExactEditsToNormalizedContent(
				"same\nsame\n",
				[{ oldText: "same", newText: "other" }],
				"file.txt",
			),
		).toThrow(/Found 2 occurrences/);

		expect(() =>
			applyExactEditsToNormalizedContent(
				"hello\n",
				[{ oldText: "missing", newText: "other" }],
				"file.txt",
			),
		).toThrow(/target text not found/);

		expect(() =>
			applyExactEditsToNormalizedContent(
				"hello\n",
				[{ oldText: "", newText: "other" }],
				"file.txt",
			),
		).toThrow(/oldText must not be empty/);

		expect(() =>
			applyExactEditsToNormalizedContent(
				"hello\n",
				[{ oldText: "hello", newText: "hello" }],
				"file.txt",
			),
		).toThrow(/identical file content/);
	});

	it("applies a unique whole-line match when only indentation differs", () => {
		const result = applyExactEditsToNormalizedContent(
			[
				"function outer() {",
				"  if (ready) {",
				"    return compute(value)",
				"  }",
				"}",
				"",
			].join("\n"),
			[
				{
					oldText: ["if (ready) {", "  return compute(value)", "}"].join("\n"),
					newText: ["if (ready) {", "  return computeNext(value)", "}"].join(
						"\n",
					),
				},
			],
			"file.ts",
		);

		expect(result.newContent).toBe(
			[
				"function outer() {",
				"  if (ready) {",
				"    return computeNext(value)",
				"  }",
				"}",
				"",
			].join("\n"),
		);
	});

	it("rejects ambiguous indentation-insensitive matches", () => {
		expect(() =>
			applyExactEditsToNormalizedContent(
				["  return value", "    return value", ""].join("\n"),
				[{ oldText: "return value", newText: "return nextValue" }],
				"file.ts",
			),
		).toThrow(/Found 2 occurrences/);
	});

	it("rejects overlapping edits", () => {
		expect(() =>
			applyExactEditsToNormalizedContent(
				"abcdef\n",
				[
					{ oldText: "abc", newText: "ABC" },
					{ oldText: "bcd", newText: "BCD" },
				],
				"file.txt",
			),
		).toThrow(/overlap/);
	});

	it("replaces every occurrence when replaceAll is set", () => {
		const result = applyExactEditsToNormalizedContent(
			"BEGIN\n  RAISE NOTICE 1;\nEND\nALTER\nBEGIN\n  RAISE NOTICE 1;\nEND\n",
			[
				{
					oldText: "  RAISE NOTICE 1;",
					newText: "  RAISE NOTICE 2;",
					replaceAll: true,
				},
			],
			"file.sql",
		);

		expect(result.newContent).toBe(
			"BEGIN\n  RAISE NOTICE 2;\nEND\nALTER\nBEGIN\n  RAISE NOTICE 2;\nEND\n",
		);
	});

	it("still requires uniqueness when replaceAll is absent or false", () => {
		for (const edit of [
			{ oldText: "same", newText: "other" },
			{ oldText: "same", newText: "other", replaceAll: false },
		]) {
			expect(() =>
				applyExactEditsToNormalizedContent("same\nsame\n", [edit], "file.txt"),
			).toThrow(/Found 2 occurrences/);
		}
	});

	it("points at replaceAll in the duplicate-match error", () => {
		expect(() =>
			applyExactEditsToNormalizedContent(
				"same\nsame\n",
				[{ oldText: "same", newText: "other" }],
				"file.txt",
			),
		).toThrow(/replaceAll: true/);
	});

	it("mixes a replaceAll edit with a targeted edit in one call", () => {
		const result = applyExactEditsToNormalizedContent(
			"let a = 1\nlet b = 1\nconst tail = 0\n",
			[
				{ oldText: "= 1", newText: "= 9", replaceAll: true },
				{ oldText: "const tail = 0", newText: "const tail = 7" },
			],
			"file.ts",
		);

		expect(result.newContent).toBe("let a = 9\nlet b = 9\nconst tail = 7\n");
	});

	it("rejects a replaceAll edit that collides with another edit", () => {
		expect(() =>
			applyExactEditsToNormalizedContent(
				"xy\nx\n",
				[
					{ oldText: "x", newText: "X", replaceAll: true },
					{ oldText: "xy", newText: "ZZ" },
				],
				"file.txt",
			),
		).toThrow(/overlap/);
	});

	it("normalizes line endings and emits a diff preview", () => {
		expect(detectLineEnding("a\r\nb\r\n")).toBe("\r\n");
		expect(normalizeToLF("a\r\nb\rc")).toBe("a\nb\nc");
		expect(restoreLineEndings("a\nb\n", "\r\n")).toBe("a\r\nb\r\n");

		const raw = "\uFEFFconst x = 1\r\n";
		expect(stripBom(raw)).toEqual({ bom: "\uFEFF", text: "const x = 1\r\n" });

		const preview = previewExactEdits(
			raw,
			[{ oldText: "const x = 1", newText: "const x = 2" }],
			"file.ts",
		);

		expect(preview.finalContent).toBe("\uFEFFconst x = 2\r\n");
		expect(preview.diff).toContain("const x = 2");
	});
});

describe("edit failure first line", () => {
	const path = "/repo/packages/renderer/stores/helpers/tool-activity-view.ts";

	function firstLineOf(run: () => unknown): string {
		try {
			run();
		} catch (error) {
			return (error as Error).message.split("\n")[0];
		}
		throw new Error("expected the edit to fail");
	}

	// The collapsed tool row shows the first line only, so every failure branch
	// has to state its category and the file in one short sentence, with the
	// engine detail pushed to the lines below it.
	it("names the failure category and the file basename", () => {
		expect(
			firstLineOf(() =>
				applyExactEditsToNormalizedContent(
					"hello\n",
					[{ oldText: "missing", newText: "other" }],
					path,
				),
			),
		).toBe("Edit failed: target text not found in tool-activity-view.ts.");

		expect(
			firstLineOf(() =>
				applyExactEditsToNormalizedContent(
					"hello\nmissing\n",
					[
						{ oldText: "hello", newText: "hi" },
						{ oldText: "nope", newText: "other" },
					],
					path,
				),
			),
		).toBe(
			"Edit failed: edits[1] target text not found in tool-activity-view.ts.",
		);

		expect(
			firstLineOf(() =>
				applyExactEditsToNormalizedContent(
					"same\nsame\nsame\n",
					[{ oldText: "same", newText: "other" }],
					path,
				),
			),
		).toBe("Edit failed: text matches 3 places in tool-activity-view.ts.");

		expect(
			firstLineOf(() =>
				applyExactEditsToNormalizedContent(
					"hello\n",
					[{ oldText: "", newText: "other" }],
					path,
				),
			),
		).toBe("Edit failed: empty oldText in tool-activity-view.ts.");

		expect(
			firstLineOf(() =>
				applyExactEditsToNormalizedContent(
					"hello\n",
					[{ oldText: "hello", newText: "hello" }],
					path,
				),
			),
		).toBe(
			"Edit failed: replacement produced no change in tool-activity-view.ts.",
		);

		expect(
			firstLineOf(() =>
				applyExactEditsToNormalizedContent(
					"alpha beta gamma\n",
					[
						{ oldText: "alpha beta", newText: "x" },
						{ oldText: "beta gamma", newText: "y" },
					],
					path,
				),
			),
		).toBe(
			"Edit failed: edits[0] and edits[1] overlap in tool-activity-view.ts.",
		);
	});

	it("keeps the engine detail from the second line on", () => {
		let message = "";
		try {
			applyExactEditsToNormalizedContent(
				"same\nsame\n",
				[{ oldText: "same", newText: "other" }],
				path,
			);
		} catch (error) {
			message = (error as Error).message;
		}

		const [firstLine, ...detail] = message.split("\n");
		expect(firstLine).toBe(
			"Edit failed: text matches 2 places in tool-activity-view.ts.",
		);
		// Full path and the replaceAll hint stay available to the model.
		expect(detail.join("\n")).toContain(path);
		expect(detail.join("\n")).toContain("replaceAll: true");
	});

	it("never lets the first line outgrow one row", () => {
		const longPath = `/repo/${"nested/".repeat(20)}${"a".repeat(120)}.ts`;
		const firstLine = firstLineOf(() =>
			applyExactEditsToNormalizedContent(
				"hello\n",
				[{ oldText: "missing", newText: "other" }],
				longPath,
			),
		);

		expect(firstLine.length).toBeLessThanOrEqual(80);
		expect(firstLine.startsWith("Edit failed: target text not found in")).toBe(
			true,
		);
	});
});

describe("findClosestRegionSnippet", () => {
	const content = [
		"local intentMap = {",
		'  ["6103849"] = "ServiceRequest",',
		'  ["25867044"] = "ServiceRequest",',
		'  ["8071253636"] = "ServiceRequest", -- AR',
		"}",
		"local mappedIntent = intentMap[called] or defaultIntent",
		"return mappedIntent",
	].join("\n");

	it("returns a line-numbered snippet around the most similar region", () => {
		const snippet = findClosestRegionSnippet(
			content,
			'  ["8071253636"] = "ServiceRequest",',
		);
		expect(snippet).toContain("Closest match in the current file");
		expect(snippet).toContain('4→  ["8071253636"] = "ServiceRequest", -- AR');
	});

	it("returns null when nothing in the file resembles the target", () => {
		expect(
			findClosestRegionSnippet(content, "völlig unrelated zeug xyzzy plugh"),
		).toBeNull();
	});

	it("is embedded in the not-found error so the model sees current file text", () => {
		expect(() =>
			applyExactEditsToNormalizedContent(
				content,
				[{ oldText: '  ["8071253636"] = "ServiceRequest",\n', newText: "x" }],
				"nlp_test.lua",
			),
		).toThrow(/Closest match in the current file/);
	});
});
