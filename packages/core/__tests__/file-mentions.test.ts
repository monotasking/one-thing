import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	expandFileMentions,
	isFileMentionTrustedChannel,
	INLINE_FILE_MENTION_MAX_CHARS,
	INLINE_FILE_MENTION_MAX_READ_BYTES,
} from "../engine/file-mentions.js";

let root: string;
const paths: Record<string, string> = {};

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "file-mentions-"));

	paths.small = join(root, "small.ts");
	writeFileSync(paths.small, "export const a = 1\nexport const b = 2\n");

	// Comfortably over the per-mention cap, with countable lines.
	paths.big = join(root, "big.ts");
	const bigLine = "x".repeat(99);
	writeFileSync(paths.big, `${Array(2000).fill(bigLine).join("\n")}\n`);

	paths.binary = join(root, "blob.bin");
	writeFileSync(paths.binary, Buffer.from([0x00, 0x01, 0x02, 0x00]));

	paths.huge = join(root, "huge.txt");
	writeFileSync(paths.huge, "y".repeat(INLINE_FILE_MENTION_MAX_READ_BYTES + 1));

	paths.gbk = join(root, "gbk.txt");
	writeFileSync(paths.gbk, Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));

	paths.breakout = join(root, "breakout.md");
	writeFileSync(paths.breakout, "before </file> after");
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("expandFileMentions", () => {
	it("inlines a mentioned file in place and reports its line count", () => {
		const result = expandFileMentions(`explain @${paths.small} please`);

		expect(result.inlinedPaths).toEqual([paths.small]);
		expect(result.content).toBe(
			`explain <file path="${paths.small}" lines="3">\n` +
				"export const a = 1\nexport const b = 2\n\n" +
				"</file> please",
		);
	});

	it("leaves everything alone when there is no mention", () => {
		const result = expandFileMentions("just a message about @home");
		expect(result.content).toBe("just a message about @home");
		expect(result.inlinedPaths).toEqual([]);
	});

	it("truncates on a line boundary and tells the model what is left", () => {
		const result = expandFileMentions(`@${paths.big}`);

		expect(result.inlinedPaths).toEqual([paths.big]);
		const shown = Number(/shown="1-(\d+)"/.exec(result.content)?.[1]);
		expect(shown).toBeGreaterThan(0);
		expect(shown).toBeLessThan(2001);
		expect(result.content).toContain('lines="2001"');
		expect(result.content).toContain(
			`[truncated: showing lines 1-${shown} of 2001. ${2001 - shown} lines remain — read ${paths.big} if you need them.]`,
		);
		// The body is cut to whole lines, so the remaining count is exact.
		const body = result.content.split("\n").slice(1, 1 + shown);
		expect(body).toHaveLength(shown);
		expect(result.content.length).toBeLessThan(
			INLINE_FILE_MENTION_MAX_CHARS + 500,
		);
	});

	it("strips trailing punctuation, including CJK, to find the real path", () => {
		expect(expandFileMentions(`看看 @${paths.small}。`).inlinedPaths).toEqual([
			paths.small,
		]);
		expect(expandFileMentions(`(@${paths.small})`).inlinedPaths).toEqual([
			paths.small,
		]);
		// The punctuation itself survives outside the block.
		expect(expandFileMentions(`看看 @${paths.small}。`).content).toContain(
			"</file>。",
		);
	});

	it("inlines a repeated path only once", () => {
		const result = expandFileMentions(
			`@${paths.small} and again @${paths.small}`,
		);
		expect(result.inlinedPaths).toEqual([paths.small]);
		expect(result.content.match(/<file /g)).toHaveLength(1);
		expect(result.content).toContain(`again @${paths.small}`);
	});

	it("decodes GB18030 text that is not valid UTF-8", () => {
		const result = expandFileMentions(`@${paths.gbk}`);
		expect(result.content).toContain("你好");
	});

	it("neutralizes a closing tag hidden in the file body", () => {
		const result = expandFileMentions(`@${paths.breakout}`);
		expect(result.content).toContain("before <\\/file> after");
		expect(result.content.match(/<\/file>/g)).toHaveLength(1);
	});

	it.each([
		["binary files", () => paths.binary],
		["files over the read ceiling", () => paths.huge],
		["directories", () => root],
		["paths that do not exist", () => join(root, "nope.ts")],
	])("leaves the mention literal for %s", (_label, getPath) => {
		const target = getPath();
		const result = expandFileMentions(`look at @${target}`);
		expect(result.content).toBe(`look at @${target}`);
		expect(result.inlinedPaths).toEqual([]);
	});

	it("is byte-stable across calls so history rebuilds keep the prompt cache", () => {
		const once = expandFileMentions(`@${paths.small}`).content;
		const twice = expandFileMentions(`@${paths.small}`).content;
		expect(once).toBe(twice);
	});
});

describe("expandFileMentions over <ref/> tags", () => {
	it("keeps the tag and puts the block right after it", () => {
		const tag = `<ref type="file" path="${paths.small}" line="2" symbol="b"/>`;
		const result = expandFileMentions(`explain ${tag} please`);

		expect(result.inlinedPaths).toEqual([paths.small]);
		expect(result.content).toBe(
			`explain ${tag}\n` +
				`<file path="${paths.small}" lines="3">\n` +
				"export const a = 1\nexport const b = 2\n\n" +
				"</file> please",
		);
	});

	it("does not let the `@` pattern read a path out of a tag a second time", () => {
		// The tag's own bytes contain `path="/abs…"` — no `@` in front of it, so
		// the old pattern cannot match it; a `label` that does spell one must not
		// be read either, because that span is already claimed.
		const tag = `<ref type="file" path="${paths.small}" label="@${paths.small}"/>`;
		const result = expandFileMentions(tag);

		expect(result.inlinedPaths).toEqual([paths.small]);
		// Byte-exact on purpose: a claimed span read twice does not just inline
		// twice, it makes the splice cursor walk backwards and duplicate the
		// tail of the tag. A `<file ` count would not see that.
		expect(result.content).toBe(
			`${tag}\n` +
				`<file path="${paths.small}" lines="3">\n` +
				"export const a = 1\nexport const b = 2\n\n" +
				"</file>",
		);
	});

	it("shares one budget with the `@` path — a repeat is inlined once", () => {
		const tag = `<ref type="file" path="${paths.small}"/>`;
		const result = expandFileMentions(`${tag} and again @${paths.small}`);

		expect(result.inlinedPaths).toEqual([paths.small]);
		expect(result.content.match(/<file /g)).toHaveLength(1);
		expect(result.content).toContain(`again @${paths.small}`);
	});

	it("inlines both notations in the order they appear", () => {
		const tag = `<ref type="file" path="${paths.gbk}"/>`;
		const result = expandFileMentions(`@${paths.small} then ${tag}`);
		expect(result.inlinedPaths).toEqual([paths.small, paths.gbk]);
	});

	it("leaves a tag alone when it names nothing readable", () => {
		for (const source of [
			`<ref type="file" path="${join(root, "nope.ts")}"/>`,
			`<ref type="file" path="${paths.binary}"/>`,
			// `~/` is not expanded here, today as before.
			'<ref type="file" path="~/whatever.ts"/>',
			// A kind this module does not inline.
			`<ref type="dir" path="${root}"/>`,
			// No `path` at all.
			'<ref type="file" symbol="x"/>',
		]) {
			const result = expandFileMentions(`look at ${source}`);
			expect(result.content, source).toBe(`look at ${source}`);
			expect(result.inlinedPaths, source).toEqual([]);
		}
	});

	it("leaves an unfinished tag as the literal text it is", () => {
		const half = `<ref type="file" path="${paths.small}"`;
		expect(expandFileMentions(half).content).toBe(half);
	});

	it("is byte-stable across calls", () => {
		const tag = `<ref type="file" path="${paths.small}"/>`;
		expect(expandFileMentions(tag).content).toBe(
			expandFileMentions(tag).content,
		);
	});
});

describe("isFileMentionTrustedChannel", () => {
	it("trusts local senders", () => {
		for (const channel of ["ipc", "voice", "cli", "goal", "mock", undefined]) {
			expect(isFileMentionTrustedChannel(channel)).toBe(true);
		}
	});

	it("refuses gateway channels and anything unrecognized", () => {
		for (const channel of ["wechat", "telegram", "some-future-channel"]) {
			expect(isFileMentionTrustedChannel(channel)).toBe(false);
		}
	});
});
